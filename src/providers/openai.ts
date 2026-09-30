/**
 * OpenAI: Responses API for completions (shared translator in `openai-responses.ts`), plus
 * embeddings, audio transcriptions and Realtime transcription client secrets.
 *
 * `options` are declared in `OPENAI_OPTIONS` and applied by `mergeOptions`; any key not declared
 * there replaces the body field of that name (for transcriptions: an extra form field).
 */
import { ProviderError } from "../core/errors.js";
import type { AssistantMessage } from "../core/odoo-types.js";
import { BaseAdapter } from "./base.js";
import { joinUrl, requestJson, requestText } from "./http.js";
import { buildResponsesBody, clampEffort, parseResponsesResponse, promptCacheKeyOption, type ResponsesProfile } from "./openai-responses.js";
import { mergeOptions, objectOption, passthroughOptions, values, type OptionDeclarations } from "./options.js";
import { canonicalAudioMimetype, extensionFor } from "./parts.js";
import type {
  CompletionRequest,
  Effort,
  EmbeddingRequest,
  Feature,
  RealtimeSession,
  RealtimeSessionRequest,
  TranscriptionRequest,
} from "./types.js";
import { isVtt, singleCueVtt } from "./vtt.js";

const ALL: readonly Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `reasoning.effort` levels per model family (developer docs, model pages). */
const EFFORT_FAMILIES: Array<[RegExp, readonly Effort[]]> = [
  [/^gpt-6-astra/, ["low", "medium", "high", "xhigh", "max"]],
  [/^gpt-6/, ["none", "low", "medium", "high", "xhigh", "max"]],
  // Observed from the API ("Supported values are: ..."): no `minimal` from GPT-5.1 on.
  [/^gpt-5\.6/, ["none", "low", "medium", "high", "xhigh", "max"]],
  [/^gpt-5\.5/, ["none", "low", "medium", "high", "xhigh"]],
  [/^gpt-5\.4/, ["none", "low", "medium", "high", "xhigh"]],
  [/^gpt-5\.[123](?!\d)/, ["none", "low", "medium", "high"]],
  // Original GPT-5 family: gpt-5-pro only runs at `high`, gpt-5-codex has no `minimal`.
  [/^gpt-5-pro/, ["high"]],
  [/^gpt-5-codex/, ["low", "medium", "high"]],
  [/^gpt-5(?![.\d])/, ["minimal", "low", "medium", "high"]],
  [/^o\d/, ["low", "medium", "high"]],
];

/** Models without reasoning: `reasoning` and the encrypted reasoning `include` are rejected. */
const NON_REASONING = /^(gpt-4|gpt-3\.5|chatgpt-)|^gpt-5[.\d]*-chat/;

function baseModel(model: string): string {
  return model.toLowerCase().replace(/^ft:/, "").replace(/^openai\//, "");
}

export function isOpenAIReasoningModel(model: string): boolean {
  return !NON_REASONING.test(baseModel(model));
}

/** Canonical effort -> the level this model accepts; undefined for non-reasoning models. */
export function openAIEffort(model: string, effort: Effort): Effort | undefined {
  const id = baseModel(model);
  if (NON_REASONING.test(id)) return undefined;
  const family = EFFORT_FAMILIES.find(([pattern]) => pattern.test(id));
  // Unknown reasoning ids (newer families): pass the effort through unchanged.
  return family ? clampEffort(effort, family[1]) : effort;
}

const UNSUPPORTED_EFFORT = /Unsupported value: '([a-z]+)' is not supported with the '[^']+' model\. Supported values are: ([^.]+)/;

/** Accepted efforts from "Unsupported value: 'minimal' ... Supported values are: 'none', 'low', ...". */
export function supportedEffortsFromError(error: unknown): Effort[] | undefined {
  if (!(error instanceof ProviderError) || error.status !== 400) return undefined;
  const match = UNSUPPORTED_EFFORT.exec(`${error.message} ${error.body ?? ""}`);
  if (!match || !(ALL as readonly string[]).includes(match[1]!)) return undefined;
  const values = [...match[2]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).filter((v): v is Effort => (ALL as readonly string[]).includes(v));
  return values.length ? values : undefined;
}

/** `image_generation.size` from Odoo's `closest_aspect_ratio` ("16:9", "2:3", ...). */
export function openAIImageSize(aspectRatio: string | undefined): string {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(aspectRatio ?? "");
  if (!match) return "1024x1024";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > height) return "1536x1024";
  if (width < height) return "1024x1536";
  return "1024x1024";
}

export const OPENAI_OPTIONS: OptionDeclarations = {
  web_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `web_search` tool (`search_context_size`...).",
  },
  image_generation_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `image_generation` tool (`quality`...).",
  },
  // GPT-5.6+ routes the cache on its own, and a per-conversation key would stop conversations of
  // the same agent from sharing the instructions + tools prefix: opt in per route instead.
  prompt_cache_key: promptCacheKeyOption("none"),
  expires_after_seconds: {
    operations: ["realtime"],
    merge: "adapter",
    gatewayKey: true,
    value: values.positiveInteger,
    doc: "Lifetime of the client secret. Default: 600.",
  },
  turn_detection: {
    operations: ["realtime"],
    merge: "adapter",
    value: values.objectOrNull,
    doc: "Replaces the default server VAD; `null` turns it off.",
  },
  noise_reduction: {
    operations: ["realtime"],
    merge: "adapter",
    value: values.objectOrNull,
    doc: "Replaces the default `near_field`; `null` turns it off.",
  },
  transcription: {
    operations: ["realtime"],
    merge: "adapter",
    value: values.object,
    doc: "Merged into the session's transcription config (`prompt`...).",
  },
};

const PROFILE: ResponsesProfile = {
  provider: "openai",
  isReasoningModel: isOpenAIReasoningModel,
  reasoningEffort(model, effort, request) {
    const level = openAIEffort(model, effort);
    // The original GPT-5 family rejects web search with `minimal` effort.
    return level === "minimal" && request.webGrounding ? "low" : level;
  },
  hostedTools(request) {
    const tools: Array<Record<string, unknown>> = [];
    if (request.webGrounding) tools.push({ type: "web_search", ...objectOption(request.options, "web_search_tool") });
    if (request.imageGeneration) {
      tools.push({
        type: "image_generation",
        output_format: "png",
        size: openAIImageSize(request.aspectRatio),
        ...objectOption(request.options, "image_generation_tool"),
      });
    }
    return tools;
  },
  options: OPENAI_OPTIONS,
  conversationCacheKey: false,
  citationMode: "replace",
  citationTitles: true,
  toolOutputParts: true,
  fileInput: true,
  // Vision input formats (non-animated GIF).
  imageMimetypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

const SUPPORTED: ReadonlySet<Feature> = new Set<Feature>([
  "completion",
  "tools",
  "schema",
  "tools+schema",
  "image_input",
  "pdf_input",
  "web_grounding",
  "web_grounding+schema",
  "image_generation",
  "embeddings",
  "transcription",
  "realtime",
]);

/** Realtime transcription models (and their dated snapshots) that require `turn_detection: null`. */
const NO_VAD_MODELS = /^(gpt-realtime-whisper|gpt-live-transcribe)(?![a-z])/;

const EMBEDDING_BATCH = 512;

/** Multipart field from an option value: arrays become repeated fields, objects JSON. */
function appendFormField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormField(form, key, item);
    return;
  }
  form.append(key, typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
}

export class OpenAIAdapter extends BaseAdapter {
  readonly name = "openai" as const;
  protected readonly defaultBaseUrl = "https://api.openai.com/v1";

  private get headers(): Record<string, string> {
    return { ...(this.settings.headers ?? {}), Authorization: `Bearer ${this.settings.apiKey}` };
  }

  supports(feature: Feature, _model: string): boolean {
    return SUPPORTED.has(feature);
  }

  /** Effort levels the API told us a model accepts (see `complete`). */
  private readonly learnedEfforts = new Map<string, Effort[]>();

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    const learned = request.effort ? this.learnedEfforts.get(request.model) : undefined;
    const effective = learned && request.effort ? { ...request, effort: clampEffort(request.effort, learned) } : request;
    const send = (req: CompletionRequest) =>
      requestJson({
        fetch: this.settings.fetch,
        provider: this.name,
        url: joinUrl(this.baseUrl, "responses"),
        headers: this.headers,
        body: buildResponsesBody(req, PROFILE),
        signal: req.signal,
      });
    let response;
    try {
      response = await send(effective);
    } catch (error) {
      // Model lineups move faster than any table: when OpenAI rejects the effort and lists the
      // accepted values, remember them for this model and retry once (same provider and model).
      const supported = effective.effort ? supportedEffortsFromError(error) : undefined;
      if (!supported || !effective.effort) throw error;
      this.learnedEfforts.set(request.model, supported);
      response = await send({ ...effective, effort: clampEffort(effective.effort, supported) });
    }
    return parseResponsesResponse(response, effective, PROFILE);
  }

  override async embed(request: EmbeddingRequest): Promise<number[][]> {
    const texts = request.inputs.map(({ title, content }) => {
      const body = content.trim() ? content : "";
      if (title) return body ? `${title}\n\n${body}` : title;
      return body || " ";
    });
    // `dimensions` is only accepted by text-embedding-3 and later (ada-002 is fixed at 1536).
    const dimensions = /ada-002/.test(request.model) ? {} : { dimensions: request.dimensions };
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH);
      const response = await requestJson<{ data?: Array<{ index?: number; embedding?: unknown }> }>({
        fetch: this.settings.fetch,
        provider: this.name,
        url: joinUrl(this.baseUrl, "embeddings"),
        headers: this.headers,
        body: mergeOptions({ model: request.model, input: batch, ...dimensions, encoding_format: "float" }, request.options, OPENAI_OPTIONS, "embeddings"),
        signal: request.signal,
      });
      const data = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) {
        throw new ProviderError(this.name, `embeddings: expected ${batch.length} vectors, got ${data.length}`);
      }
      for (const item of data) {
        const embedding = item.embedding;
        if (!Array.isArray(embedding) || embedding.length !== request.dimensions) {
          throw new ProviderError(this.name, `embeddings: expected vectors of ${request.dimensions} floats`);
        }
        vectors.push(embedding as number[]);
      }
    }
    return vectors;
  }

  /**
   * `POST /audio/transcriptions` (multipart). Only whisper-1 can answer in VTT; for the other
   * models the plain text is wrapped in a single-cue WebVTT document.
   */
  override async transcribe(request: TranscriptionRequest): Promise<string> {
    const mimetype = canonicalAudioMimetype(request.mimetype);
    const nativeVtt = request.responseFormat === "vtt" && /^whisper/.test(request.model);
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(request.audio, "base64")], { type: mimetype }), `audio.${extensionFor(mimetype)}`);
    form.append("model", request.model);
    if (request.language) form.append("language", request.language);
    form.append("response_format", nativeVtt ? "vtt" : "json");
    for (const [key, value] of Object.entries(passthroughOptions(request.options, OPENAI_OPTIONS))) appendFormField(form, key, value);
    const http = {
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, "audio/transcriptions"),
      headers: this.headers,
      body: form,
      signal: request.signal,
    };
    if (nativeVtt) {
      const vtt = await requestText(http);
      return isVtt(vtt) ? vtt : singleCueVtt(vtt);
    }
    const response = await requestJson<{ text?: unknown }>(http);
    if (typeof response.text !== "string") throw new ProviderError(this.name, "transcription response has no text");
    return request.responseFormat === "vtt" ? singleCueVtt(response.text) : response.text;
  }

  /**
   * GA client secret bound to a transcription session. Odoo's browser client opens
   * `wss://api.openai.com/v1/realtime` with the `openai-insecure-api-key.<token>` subprotocol and
   * streams 24 kHz PCM16 without sending `session.update`, so the whole config lives here.
   */
  override async createRealtimeSession(request: RealtimeSessionRequest): Promise<RealtimeSession> {
    const { expires_after_seconds: seconds, turn_detection: turnDetection, noise_reduction: noiseReduction } = request.options ?? {};
    const transcription: Record<string, unknown> = {
      model: request.model,
      ...(request.language ? { language: request.language } : {}),
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...objectOption(request.options, "transcription"),
    };
    const vad = NO_VAD_MODELS.test(request.model)
      ? null
      : { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 };
    const body = mergeOptions(
      {
        expires_after: { anchor: "created_at", seconds: typeof seconds === "number" ? seconds : 600 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription,
              turn_detection: turnDetection === undefined ? vad : turnDetection,
              noise_reduction: noiseReduction === undefined ? { type: "near_field" } : noiseReduction,
            },
          },
        },
      },
      request.options,
      OPENAI_OPTIONS,
      "realtime",
    );
    const response = await requestJson<{
      value?: unknown;
      expires_at?: unknown;
      client_secret?: { value?: unknown; expires_at?: unknown };
    }>({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, "realtime/client_secrets"),
      headers: this.headers,
      body,
      signal: request.signal,
    });
    const token = response.value ?? response.client_secret?.value;
    const expiresAt = response.expires_at ?? response.client_secret?.expires_at;
    if (typeof token !== "string" || !token) throw new ProviderError(this.name, "realtime client secret response has no value");
    return typeof expiresAt === "number" ? { token, expiresAt } : { token };
  }
}
