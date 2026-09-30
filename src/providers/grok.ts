/**
 * xAI Grok: the Responses API (OpenAI compatible, shared translator in `openai-responses.ts`) for
 * completions, `POST /images/generations` for image models and `POST /stt` for transcription.
 *
 * Differences from OpenAI handled here:
 * - Web search citations are inline `[[1]](url)` markdown links; the `url_citation` title is only
 *   the number label, so the source name comes from the URL.
 * - Image generation is not a Responses tool: image models go through the Images API.
 * - No PDF/file input, embeddings or realtime sessions.
 *
 * `options` are declared in `GROK_OPTIONS` and applied by `mergeOptions`; any key not declared
 * there replaces the Responses body field of that name, or becomes an extra `/stt` form field for
 * transcriptions (`diarize`, `keyterm`...).
 */
import { ProviderError } from "../core/errors.js";
import { sniffImageMimetype, stripOdooContext } from "../core/odoo-history.js";
import type { AssistantMessage, AssistantPart } from "../core/odoo-types.js";
import { BaseAdapter } from "./base.js";
import { joinUrl, requestJson } from "./http.js";
import { buildResponsesBody, clampEffort, parseResponsesResponse, promptCacheKeyOption, type ResponsesProfile } from "./openai-responses.js";
import { objectOption, passthroughOptions, values, type OptionDeclarations } from "./options.js";
import { canonicalAudioMimetype, extensionFor, textOf } from "./parts.js";
import type { CompletionRequest, Effort, Feature, TranscriptionRequest } from "./types.js";
import { buildVtt, cuesFromWords, singleCueVtt } from "./vtt.js";

/** `reasoning.effort` per model family; families not listed get no `reasoning` field. */
const EFFORT_FAMILIES: Array<[RegExp, readonly Effort[]]> = [
  [/^grok-4\.[67](?!\d)/, ["low", "medium", "high", "xhigh"]],
  [/^grok-4\.5(?!\d)/, ["low", "medium", "high"]],
  [/^grok-4\.3(?!\d)/, ["none", "low", "medium", "high"]],
  [/^grok-3-mini/, ["low", "high"]],
];

/** Aspect ratios accepted by `/images/generations`; anything else becomes "auto". */
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2",
]);

function baseModel(model: string): string {
  return model.toLowerCase().replace(/^x-ai\//, "").replace(/^xai\//, "");
}

export function isGrokImageModel(model: string): boolean {
  return /imagine|image/.test(baseModel(model));
}

/**
 * Reasoning models return encrypted reasoning with `include: ["reasoning.encrypted_content"]`.
 * Non-reasoning variants, image models and the code model are left alone.
 */
export function isGrokReasoningModel(model: string): boolean {
  const id = baseModel(model);
  if (/non-reasoning/.test(id) || isGrokImageModel(id) || /^grok-build/.test(id)) return false;
  return /^grok-(4|3-mini)/.test(id) || /reasoning/.test(id);
}

/** Canonical effort -> the level this model accepts; undefined when the family takes none. */
export function grokEffort(model: string, effort: Effort): Effort | undefined {
  const id = baseModel(model);
  const family = EFFORT_FAMILIES.find(([pattern]) => pattern.test(id));
  return family ? clampEffort(effort, family[1]) : undefined;
}

/** `/stt` form field from an option value: arrays (e.g. `keyterm`) become repeated fields. */
function appendFormField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormField(form, key, item);
    return;
  }
  form.append(key, typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
}

export const GROK_OPTIONS: OptionDeclarations = {
  web_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `web_search` tool (`allowed_domains`...).",
  },
  x_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.anyOf(values.boolean, values.object),
    doc: "`true` or an object (merged into it) adds an `x_search` tool to web-grounded requests.",
  },
  image_generation_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `/images/generations` body (`resolution`, `quality`...).",
  },
  // xAI caches per server and routes by this key: without it a new round often lands on a cold one.
  prompt_cache_key: promptCacheKeyOption("the conversation id"),
};

const PROFILE: ResponsesProfile = {
  provider: "grok",
  isReasoningModel: isGrokReasoningModel,
  reasoningEffort: (model, effort) => grokEffort(model, effort),
  hostedTools(request) {
    if (!request.webGrounding) return [];
    const tools: Array<Record<string, unknown>> = [{ type: "web_search", ...objectOption(request.options, "web_search_tool") }];
    const xSearch = request.options?.x_search_tool;
    if (xSearch) tools.push({ type: "x_search", ...objectOption(request.options, "x_search_tool") });
    return tools;
  },
  // Inline citation links would corrupt a JSON answer.
  extraInclude: (request) => (request.webGrounding && request.schema ? ["no_inline_citations"] : []),
  options: GROK_OPTIONS,
  conversationCacheKey: true,
  citationMode: "replace",
  citationTitles: false,
  toolOutputParts: false,
  fileInput: false,
  // xAI image understanding reads jpg/jpeg and png only (max 20 MiB per image).
  imageMimetypes: ["image/jpeg", "image/png"],
};

const SUPPORTED: ReadonlySet<Feature> = new Set<Feature>([
  "completion",
  "tools",
  "schema",
  "tools+schema",
  "image_input",
  "web_grounding",
  "web_grounding+schema",
  "transcription",
]);

/** The last user message's text, without the `<odoo_current_context>` block Odoo appends to it. */
function imagePrompt(request: CompletionRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  const text = last ? textOf(last.content) : "";
  return stripOdooContext(text) || text.trim();
}

export class GrokAdapter extends BaseAdapter {
  readonly name = "grok" as const;
  protected readonly defaultBaseUrl = "https://api.x.ai/v1";

  private get headers(): Record<string, string> {
    return { ...(this.settings.headers ?? {}), Authorization: `Bearer ${this.settings.apiKey}` };
  }

  supports(feature: Feature, model: string): boolean {
    if (feature === "image_generation") return isGrokImageModel(model);
    return SUPPORTED.has(feature);
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    if (request.imageGeneration) return this.generateImage(request);
    const response = await requestJson({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, "responses"),
      headers: this.headers,
      body: buildResponsesBody(request, PROFILE),
      signal: request.signal,
    });
    return parseResponsesResponse(response, request, PROFILE);
  }

  /** `POST /images/generations` with the last user message as the prompt. */
  private async generateImage(request: CompletionRequest): Promise<AssistantMessage> {
    const prompt = imagePrompt(request);
    if (!prompt) throw new ProviderError(this.name, "image generation needs a text prompt");
    const aspectRatio = request.aspectRatio && IMAGE_ASPECT_RATIOS.has(request.aspectRatio) ? request.aspectRatio : "auto";
    const response = await requestJson<{ data?: Array<{ b64_json?: unknown; mime_type?: unknown }>; usage?: unknown }>({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, "images/generations"),
      headers: this.headers,
      body: {
        model: request.model,
        prompt,
        n: 1,
        aspect_ratio: aspectRatio,
        response_format: "b64_json",
        ...objectOption(request.options, "image_generation_tool"),
      },
      signal: request.signal,
    });
    const content: AssistantPart[] = (response.data ?? [])
      .filter((image) => typeof image.b64_json === "string" && image.b64_json)
      .map((image) => {
        const data = image.b64_json as string;
        const declared = typeof image.mime_type === "string" && image.mime_type ? image.mime_type : "image/jpeg";
        return { type: "inline_data", mimetype: sniffImageMimetype(data) ?? declared, data };
      });
    if (!content.length) throw new ProviderError(this.name, "image generation returned no image");
    const metadata: Record<string, unknown> = { provider: this.name, model: request.model };
    if (response.usage !== undefined) metadata.usage = response.usage;
    return { role: "assistant", content, provider_metadata: metadata };
  }

  /**
   * `POST /stt` (multipart, `file` must be the last field). There is no VTT output: cues are built
   * from the word timings.
   */
  override async transcribe(request: TranscriptionRequest): Promise<string> {
    const mimetype = canonicalAudioMimetype(request.mimetype);
    const form = new FormData();
    if (request.language) form.append("language", request.language);
    form.append("format", "true");
    for (const [key, value] of Object.entries(passthroughOptions(request.options, GROK_OPTIONS))) appendFormField(form, key, value);
    form.append("file", new Blob([Buffer.from(request.audio, "base64")], { type: mimetype }), `audio.${extensionFor(mimetype)}`);
    const response = await requestJson<{ text?: unknown; words?: Array<{ text?: unknown; start?: unknown; end?: unknown }> }>({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, "stt"),
      headers: this.headers,
      body: form,
      signal: request.signal,
    });
    if (typeof response.text !== "string") throw new ProviderError(this.name, "transcription response has no text");
    const text = response.text;
    if (request.responseFormat !== "vtt") return text;
    const words = (response.words ?? [])
      .filter((word) => typeof word.text === "string" && typeof word.start === "number" && typeof word.end === "number")
      .map((word) => ({ text: word.text as string, start: word.start as number, end: word.end as number }));
    return words.length ? buildVtt(cuesFromWords(words)) : singleCueVtt(text);
  }
}
