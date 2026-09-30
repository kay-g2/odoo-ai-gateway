/**
 * OpenRouter (`https://openrouter.ai/api/v1`): OpenAI Chat Completions at `POST /chat/completions`,
 * forwarded to whatever vendor sits behind the `vendor/model` id.
 *
 * What a model can do depends on the vendor behind it, so `supports()` answers for what the
 * OpenRouter API can express; a routing entry can force a feature off for a given model.
 *
 * Quirks handled here:
 * - Reasoning models need `reasoning_details` echoed back unmodified on the assistant message for
 *   multi-turn tool calling; they round-trip through `provider_metadata.openrouter` and are only
 *   replayed to a model of the same vendor.
 * - `reasoning.effort` is normalized per model by OpenRouter, except that Claude rejects `none`
 *   (sent as `enabled: false`) and is the one family given `max` (others get `xhigh`).
 * - Endpoints without structured-output support silently ignore `response_format` unless
 *   `provider.require_parameters` is set.
 * - Web citations are nested: `annotations[] = {type: "url_citation", url_citation: {...}}`.
 *
 * `options` are declared in `OPENROUTER_OPTIONS` and applied by `mergeOptions`: any key not
 * declared there replaces the body field of that name (`null` removes it, e.g. `dimensions` for
 * fixed-size embedding models).
 */
import { randomUUID } from "node:crypto";

import { ProviderError } from "../core/errors.js";
import { attachmentKind } from "../core/odoo-history.js";
import type { AssistantMessage, AssistantPart, InlineDataPart, ToolCallPart, UserMessage, WebSource } from "../core/odoo-types.js";
import { BaseAdapter } from "./base.js";
import { applyCitations, sourceName, webSourceId, type Citation } from "./citations.js";
import { joinUrl, requestJson, upstreamErrorMessage } from "./http.js";
import {
  callId,
  dataUrl,
  decodeBase64Text,
  extensionFor,
  parseToolArguments,
  replayData,
  textOf,
  toolResultImages,
  toolResultText,
} from "./parts.js";
import { mergeOptions, objectOption, values, type OptionDeclarations } from "./options.js";
import { planPromptCache, PROMPT_CACHE_OPTION, type CacheControl, type PromptCachePlan } from "./prompt-cache.js";
import { isStrictCompatible, normalizeSchema, toolParameters } from "./schema.js";
import type { CompletionRequest, Effort, EmbeddingRequest, Feature, TranscriptionRequest } from "./types.js";
import { buildVtt, singleCueVtt } from "./vtt.js";

type ContentPart = (
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
) & { cache_control?: CacheControl };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system"; content: string | ContentPart[] }
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: string | ContentPart[] | null; tool_calls?: ChatToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface UrlCitation {
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

/** Chat Completions nests the citation under `url_citation`; the flat OpenAI shape is accepted too. */
interface Annotation extends UrlCitation {
  type?: string;
  url_citation?: UrlCitation;
}

interface ResponseMessage {
  content?: string | Array<{ type?: string; text?: string }> | null;
  refusal?: string | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> | null;
  images?: Array<{ image_url?: { url?: string } }> | null;
  annotations?: Annotation[] | null;
  reasoning_details?: unknown[] | null;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: ResponseMessage;
    error?: { message?: string; code?: unknown };
  }>;
  usage?: Record<string, unknown>;
  error?: unknown;
}

/** Stored under `provider_metadata.openrouter` and replayed on the next turn. */
export interface OpenRouterReplay {
  reasoning_details?: unknown[];
  model?: string;
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const OPENROUTER_OPTIONS: OptionDeclarations = {
  web_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "`parameters` of the `openrouter:web_search` tool (`engine`, `max_results`...).",
  },
  provider: {
    operations: ["completion"],
    merge: "deep",
    value: values.object,
    doc: "provider routing preferences (`order`, `only`, `sort`...); a schema adds `require_parameters: true` first.",
  },
  image_config: {
    operations: ["completion"],
    merge: "adapter",
    value: values.object,
    doc: "Extra image options (`image_size`...) for image generation; the request's aspect ratio wins.",
  },
  reasoning: {
    operations: ["completion"],
    merge: "adapter",
    value: values.object,
    doc: "Merged over the translated effort (`exclude`...); a `max_tokens` budget replaces the effort.",
  },
  prompt_cache: PROMPT_CACHE_OPTION,
  session_id: {
    operations: ["completion"],
    merge: "adapter",
    value: values.anyOf(values.text, values.oneOf(false)),
    doc: "Sticky-routing key (see Conversation id). Default: the conversation id; `false` sends none.",
  },
};

/** `anthropic/claude-...` or `~anthropic/claude-...-latest` -> `anthropic`. */
function vendorOf(model: string): string {
  return (model.trim().replace(/^~/, "").split("/")[0] ?? "").toLowerCase();
}

/**
 * Claude through OpenRouter only caches at `cache_control` breakpoints (OpenAI, Gemini, DeepSeek...
 * cache automatically). Put one on the last block of the stable history (see prompt-cache.ts): the
 * nearest user message with content parts or assistant message with text, at or before the last
 * message rendered from that history. Tool messages are skipped. Nothing is mutated in place.
 */
function markStableHistory(messages: ChatMessage[], stableCount: number, control: CacheControl): ChatMessage[] {
  for (let index = stableCount - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "assistant") {
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      const out = [...messages];
      out[index] = { ...message, content: [{ type: "text", text: message.content, cache_control: control }] };
      return out;
    }
    const parts = message.content;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]!;
      if (part.type === "text" && !part.text.trim()) continue;
      const content = [...parts];
      content[p] = { ...part, cache_control: control };
      const out = [...messages];
      out[index] = { ...message, content };
      return out;
    }
  }
  return messages;
}

/**
 * Canonical effort -> the `reasoning` object. OpenRouter maps `none | minimal | low | medium |
 * high | xhigh` to what each vendor accepts (budget ratios, levels, nearest supported level).
 * Claude is the exception on both ends: it accepts `max` natively but rejects `effort: "none"`,
 * so reasoning is switched off with `enabled: false` there. Elsewhere `max` is sent as `xhigh`.
 */
export function openRouterEffort(effort: Effort, model: string): Record<string, unknown> {
  const claude = vendorOf(model) === "anthropic";
  if (effort === "none" && claude) return { enabled: false };
  if (effort === "max" && !claude) return { effort: "xhigh" };
  return { effort };
}

/** Odoo attachment (normalized history) -> Chat Completions content part. */
function inlinePart(part: InlineDataPart): ContentPart {
  switch (attachmentKind(part.mimetype)) {
    case "image":
      return { type: "image_url", image_url: { url: dataUrl(part) } };
    case "text":
      return { type: "text", text: decodeBase64Text(part.data) };
    case "audio":
      // `input_audio` takes raw base64 (no data: prefix) and a format name.
      return { type: "input_audio", input_audio: { data: part.data, format: extensionFor(part.mimetype) } };
    case "pdf":
      return { type: "file", file: { filename: "document.pdf", file_data: dataUrl(part) } };
    default:
      return { type: "file", file: { filename: `file.${extensionFor(part.mimetype)}`, file_data: dataUrl(part) } };
  }
}

/**
 * One Odoo user message -> `tool` messages first (they must directly follow the assistant tool
 * calls), then the files returned by tools as a user message, then the user's own content.
 */
function userMessages(message: UserMessage): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolFiles: ContentPart[] = [];
  const content: ContentPart[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: callId(part.tool_call_id), content: toolResultText(part) });
      const files = toolResultImages(part);
      if (files.length) {
        const label = files.every((file) => attachmentKind(file.mimetype) === "image") ? "Images" : "Files";
        toolFiles.push({ type: "text", text: `${label} returned by tool ${part.tool_name}:` }, ...files.map(inlinePart));
      }
    } else if (part.type === "text") {
      const text = typeof part.text === "string" ? part.text : JSON.stringify(part.text);
      if (text) content.push({ type: "text", text });
    } else if (part.type === "inline_data") {
      content.push(inlinePart(part));
    }
  }
  if (toolFiles.length) out.push({ role: "user", content: toolFiles });
  if (content.length) out.push({ role: "user", content });
  return out;
}

/** `data:<mime>;base64,<data>` -> inline_data fields. */
function parseDataUrl(url: string): { mimetype: string; data: string } | undefined {
  const match = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s.exec(url.trim());
  if (!match) return undefined;
  const [, mimetype, params, payload] = match;
  if (/;base64/i.test(params ?? "")) return { mimetype: mimetype!, data: payload!.replace(/\s+/g, "") };
  try {
    return { mimetype: mimetype!, data: Buffer.from(decodeURIComponent(payload!), "utf8").toString("base64") };
  } catch {
    return undefined; // malformed percent-encoding
  }
}

function responseText(content: ResponseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === undefined || part.type === "text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

interface Span {
  start: number;
  end: number;
}

/** Code point offset -> JavaScript (UTF-16) string index. */
function codePointToIndex(text: string, offset: number): number {
  let index = 0;
  let count = 0;
  for (const char of text) {
    if (count >= offset) break;
    index += char.length;
    count += 1;
  }
  return index;
}

/** Markdown links `[label](url)` to `url`: OpenRouter's search prompt asks models to cite that way. */
function markdownLinkSpans(text: string, url: string): Span[] {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[(?:[^\\[\\]\\n]|\\[[^\\[\\]\\n]*\\])*\\]\\(${escaped}\\)`, "g");
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/**
 * Where a citation goes in the text. Indices are JavaScript string indices; when they point at
 * or into the model's markdown link to the URL, the whole link is used (indices counted in code
 * points drift after emoji, so that reading is tried too). Without usable indices, or when they
 * cover a sentence elsewhere, the links to the URL are used; with no link at all, a valid span is
 * kept (plain supported sentence: the marker is appended after it). Empty: cite at the end.
 */
function citationSpans(text: string, start: unknown, end: unknown, url: string): Span[] {
  const links = markdownLinkSpans(text, url);
  const candidates: Span[] = [];
  let direct: Span | undefined;
  if (Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) > (start as number)) {
    const s = start as number;
    const e = end as number;
    if (e <= text.length) candidates.push((direct = { start: s, end: e }));
    const converted = { start: codePointToIndex(text, s), end: codePointToIndex(text, e) };
    if (converted.end > converted.start && (converted.start !== s || converted.end !== e)) candidates.push(converted);
  }
  for (const candidate of candidates) {
    const link = links.find((span) => span.start < candidate.end && candidate.start < span.end);
    if (link) return [link];
  }
  if (links.length) return links;
  return direct ? [direct] : [];
}

/**
 * `url_citation` annotations -> `[WEB_SOURCE:<id>]` markers through `applyCitations` ("replace":
 * the span usually is the model's markdown link; plain sentence spans fall back to appending).
 * Citations are snapped to the model's `[domain](url)` links (see `citationSpans`) so a link is
 * never left next to its own marker; citations that cannot be placed are appended at the end.
 */
function citeAnnotations(text: string, annotations: Annotation[]): { text: string; sources: Record<string, WebSource> } {
  const raw = annotations
    .filter((annotation) => annotation?.type === "url_citation")
    .map((annotation) => annotation.url_citation ?? annotation)
    .filter((citation): citation is UrlCitation & { url: string } => typeof citation.url === "string" && citation.url !== "");

  const placed: Citation[] = [];
  const unplaced: Array<{ url: string; title?: string | undefined }> = [];
  for (const citation of raw) {
    const spans = citationSpans(text, citation.start_index, citation.end_index, citation.url);
    if (!spans.length) unplaced.push({ url: citation.url, title: citation.title });
    for (const span of spans) placed.push({ ...span, url: citation.url, title: citation.title });
  }

  const cited = applyCitations(text, placed, "replace");
  const sources = { ...cited.sources };
  const trailing: string[] = [];
  for (const citation of unplaced) {
    const id = webSourceId(citation.url);
    if (sources[id]) continue;
    sources[id] = { url: citation.url, source_name: sourceName(citation.url, citation.title) };
    trailing.push(`[WEB_SOURCE:${id}]`);
  }
  const out = trailing.length ? `${cited.text.trimEnd()}${cited.text.trim() ? " " : ""}${trailing.join("")}` : cited.text;
  return { text: out, sources };
}

function checkErrorBody(provider: string, body: { error?: unknown }): void {
  if (body.error !== undefined && body.error !== null) {
    const status = isRecord(body.error) && typeof body.error.code === "number" ? body.error.code : undefined;
    throw new ProviderError(provider, upstreamErrorMessage(body, "upstream error"), status, JSON.stringify(body).slice(0, 2000));
  }
}

export class OpenRouterAdapter extends BaseAdapter {
  readonly name = "openrouter" as const;
  protected readonly defaultBaseUrl = "https://openrouter.ai/api/v1";

  /** Model-dependent upstream; config can force a feature off per route. No realtime API. */
  supports(feature: Feature, _model: string): boolean {
    return feature !== "realtime";
  }

  /**
   * `settings.headers` carries the optional attribution headers (`HTTP-Referer`, `X-Title`). An
   * `authorization` key in any casing is dropped: `Headers` would join it with ours into one
   * invalid value.
   */
  private headers(): Record<string, string> {
    const extra = Object.entries(this.settings.headers ?? {}).filter(([key]) => key.toLowerCase() !== "authorization");
    return { ...Object.fromEntries(extra), Authorization: `Bearer ${this.settings.apiKey}` };
  }

  private post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    return requestJson<T>({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, path),
      headers: this.headers(),
      body,
      signal,
    });
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    const response = await this.post<ChatResponse>("/chat/completions", this.buildBody(request), request.signal);
    return this.parseResponse(response, request);
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    const options = request.options ?? {};
    const cache = vendorOf(request.model) === "anthropic" ? planPromptCache(request.messages, options.prompt_cache) : undefined;
    const body: Record<string, unknown> = { model: request.model, messages: this.buildMessages(request, cache) };
    // One-shot loops only append: automatic caching follows the growing tail.
    if (cache?.tail) body.cache_control = cache.control;
    // Without it OpenRouter keys stickiness on a hash of the first messages, which in an Odoo
    // chat's first turn changes every round (`<odoo_current_context>` carries a timestamp).
    const session = options.session_id === undefined ? request.conversationId : options.session_id;
    if (typeof session === "string" && session) body.session_id = session;

    const tools: Array<Record<string, unknown>> = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.instructions, parameters: toolParameters(tool.schema) },
    }));
    if (request.webGrounding) {
      // Server tool: OpenRouter runs the search when the model decides to.
      const parameters = objectOption(options, "web_search_tool");
      tools.push({ type: "openrouter:web_search", ...(Object.keys(parameters).length ? { parameters } : {}) });
    }
    if (tools.length) body.tools = tools;

    if (request.schema) {
      const schema = normalizeSchema(request.schema);
      body.response_format = { type: "json_schema", json_schema: { name: "response", strict: isStrictCompatible(schema), schema } };
    }

    const reasoningOptions = objectOption(options, "reasoning");
    const reasoning: Record<string, unknown> = {
      ...(request.effort ? openRouterEffort(request.effort, request.model) : {}),
      ...reasoningOptions,
    };
    // `effort` and `max_tokens` are mutually exclusive: an explicit budget from the config wins.
    if (reasoningOptions.max_tokens !== undefined && reasoningOptions.effort === undefined) delete reasoning.effort;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;

    if (request.imageGeneration) {
      body.modalities = ["image", "text"];
      const config = { ...objectOption(options, "image_config"), ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}) };
      if (Object.keys(config).length) body.image_config = config;
    }

    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;

    // Without `require_parameters`, endpoints lacking structured outputs silently drop the schema.
    if (request.schema) body.provider = { require_parameters: true };

    return mergeOptions(body, options, OPENROUTER_OPTIONS, "completion");
  }

  private buildMessages(request: CompletionRequest, cache?: PromptCachePlan): ChatMessage[] {
    let messages: ChatMessage[] = [];
    if (request.instructions.trim()) {
      // A breakpoint on the system block caches tools + system together.
      messages.push(
        cache
          ? { role: "system", content: [{ type: "text", text: request.instructions, cache_control: cache.control }] }
          : { role: "system", content: request.instructions },
      );
    }
    let stableCount = cache && cache.historyEnd >= 0 ? -1 : 0;
    request.messages.forEach((message, index) => {
      if (message.role === "user") messages.push(...userMessages(message));
      else {
        const assistant = this.assistantMessage(message, request.model);
        if (assistant) messages.push(assistant);
      }
      if (cache && index === cache.historyEnd) stableCount = messages.length;
    });
    if (cache && stableCount > 0) messages = markStableHistory(messages, stableCount, cache.control);
    return messages;
  }

  /**
   * Previous assistant turn. `reasoning_details` must come back verbatim (same order) for
   * reasoning models to continue a tool-calling turn; they are only reused when this adapter
   * produced the message with a model of the same vendor (signed thinking / encrypted reasoning
   * is vendor-specific, and tiers or `boost_reasoning` can switch the model between turns).
   * Generated images are not replayed.
   */
  private assistantMessage(message: AssistantMessage, model: string): ChatMessage | undefined {
    const parts = message.content ?? [];
    const text = textOf(parts);
    const toolCalls: ChatToolCall[] = parts
      .filter((part): part is ToolCallPart => part.type === "tool_call")
      .map((part) => ({
        id: callId(part.call_id),
        type: "function",
        function: { name: part.name, arguments: typeof part.args === "string" ? part.args : JSON.stringify(part.args ?? {}) },
      }));
    if (!text && !toolCalls.length) return undefined;
    const replay = replayData<OpenRouterReplay>(message, this.name);
    const storedModel = message.provider_metadata?.model;
    const producedBy = typeof storedModel === "string" && storedModel ? storedModel : replay?.model;
    const details = !producedBy || vendorOf(producedBy) === vendorOf(model) ? replay?.reasoning_details : undefined;
    return {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(Array.isArray(details) && details.length ? { reasoning_details: details } : {}),
    };
  }

  private parseResponse(response: ChatResponse, request: CompletionRequest): AssistantMessage {
    checkErrorBody(this.name, response);
    const choice = response.choices?.[0];
    if (!choice) throw new ProviderError(this.name, "response has no choices");
    // Errors after the upstream call started arrive with HTTP 200 on the choice itself.
    if (choice.finish_reason === "error" || choice.error) {
      throw new ProviderError(this.name, `generation failed: ${choice.error?.message ?? "finish_reason error"}`);
    }
    const message = choice.message ?? {};
    const content: AssistantPart[] = [];

    let text = responseText(message.content);
    const refusal = typeof message.refusal === "string" ? message.refusal.trim() : "";
    if (!text.trim() && refusal) {
      // OpenAI-style refusal: shown to the user, except where Odoo expects schema JSON.
      if (request.schema) throw new ProviderError(this.name, `the model refused to answer: ${refusal}`);
      text = refusal;
    }
    if (text.trim()) {
      let sources: Record<string, WebSource> = {};
      if (request.webGrounding && !request.schema && Array.isArray(message.annotations)) {
        ({ text, sources } = citeAnnotations(text, message.annotations));
      }
      content.push({ type: "text", text, ...(Object.keys(sources).length ? { sources } : {}) });
    }

    for (const image of message.images ?? []) {
      // Only data URLs are documented for generated images.
      const parsed = typeof image?.image_url?.url === "string" ? parseDataUrl(image.image_url.url) : undefined;
      if (parsed) content.push({ type: "inline_data", mimetype: parsed.mimetype, data: parsed.data });
    }

    for (const call of message.tool_calls ?? []) {
      const name = call?.function?.name;
      if (!name) continue;
      content.push({ type: "tool_call", name, args: parseToolArguments(call.function?.arguments), call_id: call.id ? callId(call.id) : `call_${randomUUID()}` });
    }

    if (!content.length) {
      throw new ProviderError(this.name, `empty response (finish_reason: ${choice.finish_reason ?? "unknown"})`);
    }

    const replay: OpenRouterReplay = {
      ...(Array.isArray(message.reasoning_details) && message.reasoning_details.length ? { reasoning_details: message.reasoning_details } : {}),
      ...(response.model ? { model: response.model } : {}),
      ...(response.id ? { id: response.id } : {}),
    };
    return {
      role: "assistant",
      content,
      provider_metadata: {
        provider: this.name,
        model: request.model,
        ...(response.usage ? { usage: response.usage } : {}),
        [this.name]: replay,
      },
    };
  }

  /**
   * OpenAI-compatible `/embeddings`; `mode` has no equivalent and is ignored. `dimensions` is
   * omitted for `text-embedding-ada-002` (always 1536, and it rejects the parameter); a route can
   * drop it for other fixed-size models with `options.dimensions: null`.
   */
  override async embed(request: EmbeddingRequest): Promise<number[][]> {
    const input = request.inputs.map((item) => [item.title, item.content].filter((value) => typeof value === "string" && value.trim()).join("\n\n") || " ");
    const body = mergeOptions(
      { model: request.model, input, ...(/text-embedding-ada-002/i.test(request.model) ? {} : { dimensions: request.dimensions }) },
      request.options,
      OPENROUTER_OPTIONS,
      "embeddings",
    );
    const response = await this.post<{ data?: Array<{ index?: number; embedding?: unknown }>; error?: unknown }>("/embeddings", body, request.signal);
    checkErrorBody(this.name, response);
    const data = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== input.length) {
      throw new ProviderError(this.name, `expected ${input.length} embeddings, got ${data.length}`);
    }
    return data.map((item) => {
      const vector = item.embedding;
      if (!Array.isArray(vector) || vector.length !== request.dimensions || !vector.every((n) => typeof n === "number")) {
        throw new ProviderError(this.name, `embedding is not a vector of ${request.dimensions} numbers (model ${request.model})`);
      }
      return vector as number[];
    });
  }

  /**
   * `/audio/transcriptions` takes JSON (base64 `input_audio`), not multipart. VTT is built from
   * `verbose_json` segments, or a single cue when the model returns no timings.
   */
  override async transcribe(request: TranscriptionRequest): Promise<string> {
    const vtt = request.responseFormat === "vtt";
    const body = mergeOptions(
      {
        model: request.model,
        input_audio: { data: request.audio, format: extensionFor(request.mimetype) },
        ...(request.language ? { language: request.language } : {}),
        response_format: vtt ? "verbose_json" : "json",
      },
      request.options,
      OPENROUTER_OPTIONS,
      "transcription",
    );
    const response = await this.post<{ text?: unknown; duration?: unknown; segments?: unknown; error?: unknown }>("/audio/transcriptions", body, request.signal);
    checkErrorBody(this.name, response);
    const text = typeof response.text === "string" ? response.text.trim() : "";
    if (!vtt) return text;
    const segments = (Array.isArray(response.segments) ? response.segments : [])
      .filter(isRecord)
      .map((segment) => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text ?? "") }))
      .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text.trim());
    if (segments.length) return buildVtt(segments);
    return singleCueVtt(text, typeof response.duration === "number" ? response.duration : undefined);
  }
}
