/**
 * Google Gemini adapter (Generative Language API, `POST /v1beta/models/{model}:generateContent`).
 *
 * Replay: Gemini state is kept on the Odoo parts themselves, in `part.provider_data.gemini`
 * (`thought_signature`, the functionCall `id`, and any server-side tool parts that surrounded the
 * part), instead of a copy of the conversation in `provider_metadata`. Odoo stores the assistant
 * message verbatim and sends it back, so the next request rebuilds the exact `model` turn.
 * History without that data (another provider, Odoo's own fixtures) gets Gemini's documented
 * dummy signature so Gemini 3 does not reject the function calls with a 400.
 *
 * `options` are declared in `GEMINI_OPTIONS` and applied by `mergeOptions`: `generationConfig`,
 * `toolConfig` and `embedContentConfig` are merged recursively into the ones the adapter builds
 * (so `{generationConfig: {temperature: 0.2}}` keeps the thinking and schema settings). For
 * embeddings the options go into each `requests[]` item.
 */
import { randomUUID } from "node:crypto";

import { ProviderError } from "../core/errors.js";
import { attachmentKind } from "../core/odoo-history.js";
import type { AssistantMessage, AssistantPart, InlineDataPart, OdooMessage, TextPart, UserMessage } from "../core/odoo-types.js";
import { BaseAdapter } from "./base.js";
import { applyCitations, utf8OffsetToIndex, type Citation } from "./citations.js";
import { joinUrl, requestJson } from "./http.js";
import { callId, canonicalAudioMimetype, decodeBase64Text, parseToolArguments, stripCodeFence, toolResultImages, toolResultText } from "./parts.js";
import { mergeOptions, objectOption, values, type OptionDeclarations } from "./options.js";
import { normalizeSchema, toolParameters } from "./schema.js";
import type { CompletionRequest, Effort, EmbeddingInput, EmbeddingRequest, Feature, TranscriptionRequest } from "./types.js";
import { isVtt, singleCueVtt, vttTimestamp } from "./vtt.js";

type JsonRecord = Record<string, unknown>;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: JsonRecord };
  functionResponse?: { id?: string; name: string; response: JsonRecord };
  /** Server-side tool parts (`toolCall`, `toolResponse`, `executableCode`, ...). */
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface Segment {
  partIndex?: number;
  startIndex?: number;
  endIndex?: number;
  text?: string;
}

interface GroundingMetadata {
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: Array<{ segment?: Segment; groundingChunkIndices?: number[] }>;
}

interface Candidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
  finishMessage?: string;
  groundingMetadata?: GroundingMetadata;
}

interface GenerateResponse {
  candidates?: Candidate[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: JsonRecord;
  modelVersion?: string;
}

/** What this adapter stores in `part.provider_data.gemini`. */
interface GeminiPartData {
  thought_signature?: string;
  /** Gemini's functionCall id (Gemini 3 matches the functionResponse on it). */
  id?: string;
  /** Server-side tool parts Gemini returned right before / after this part (replayed unchanged). */
  parts_before?: GeminiPart[];
  parts_after?: GeminiPart[];
}

/** Documented placeholder for history whose real signatures are unknown (other providers, fixtures). */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

/** batchEmbedContents accepts at most 100 requests per call. */
const EMBED_BATCH_SIZE = 100;

const BLOCKED_REASONS = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

/** Gemini 3+ `thinkingLevel` (Pro models do not accept "minimal": they get "low"). */
const THINKING_LEVELS: Record<Effort, "minimal" | "low" | "medium" | "high"> = {
  none: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Gemini 2.5 `thinkingBudget` in tokens ("none" and "max" depend on Pro vs Flash, see below). */
const THINKING_BUDGETS: Record<Effort, number> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 24576,
};

function modelId(model: string): string {
  return model.replace(/^models\//, "");
}

/**
 * "legacy" (1.x, 2.0: no thinking, no tools+schema), "2.5" (thinkingBudget) or "3+" (thinkingLevel).
 * Ids that do not look like `gemini-<version>` (aliases such as `gemini-flash-latest`, future
 * families) are treated as current models.
 */
function family(id: string): "legacy" | "2.5" | "3+" {
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  if (!match) return "3+";
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major >= 3) return "3+";
  return major === 2 && minor >= 5 ? "2.5" : "legacy";
}

function isPro(id: string): boolean {
  return /(^|-)pro(-|$)/.test(id);
}

/** Gemini image models ("gemini-3.1-flash-image", "gemini-3-pro-image"); not Imagen (`:predict`, not generateContent). */
function isImageModel(id: string): boolean {
  return /(^|-)image(-|$)/.test(id);
}

function isEmbeddingModel(id: string): boolean {
  return id.includes("embedding");
}

/** `generationConfig.thinkingConfig` for an effort, or undefined to keep the model default. */
function thinkingConfig(model: string, effort: Effort | undefined): JsonRecord | undefined {
  const id = modelId(model);
  // thinkingConfig is a Gemini feature: other families served by the API (Gemma...) reject it.
  if (effort === undefined || isImageModel(id) || !id.startsWith("gemini")) return undefined;
  switch (family(id)) {
    case "legacy":
      return undefined;
    case "2.5": {
      // Pro cannot turn thinking off (minimum 128) and goes up to 32768; Flash tops out at 24576.
      if (effort === "none") return { thinkingBudget: isPro(id) ? 128 : 0 };
      if (effort === "max") return { thinkingBudget: isPro(id) ? 32768 : 24576 };
      return { thinkingBudget: THINKING_BUDGETS[effort] };
    }
    default: {
      const level = THINKING_LEVELS[effort];
      return { thinkingLevel: level === "minimal" && isPro(id) ? "low" : level };
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const GEMINI_OPTIONS: OptionDeclarations = {
  generationConfig: {
    operations: ["completion", "transcription"],
    merge: "deep",
    value: values.object,
    doc: "`temperature`, `topP`...; the thinking and schema settings are kept.",
  },
  toolConfig: {
    operations: ["completion"],
    merge: "deep",
    value: values.object,
    doc: "function calling settings (`functionCallingConfig`...).",
  },
  web_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `googleSearch` tool.",
  },
  embedContentConfig: {
    operations: ["embeddings"],
    merge: "deep",
    value: values.object,
    doc: "each embedding request's config (`taskType`...).",
  },
  embedding_prompt: {
    operations: ["embeddings"],
    merge: "adapter",
    gatewayKey: true,
    value: values.boolean,
    doc: "Forces the task-prefix text format on or off (default: on for gemini-embedding-2, see Embeddings).",
  },
};

/** A cue timing line, WebVTT ("00:01.500") or SRT ("00:00:01,500") style, with optional cue settings. */
const CUE_TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)(\s.*)?$/;

function timestampSeconds(value: string): number {
  return value
    .replace(",", ".")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * The model's answer as a WebVTT document Odoo's transcript parser can read: `WEBVTT` header and
 * blank line, canonical `HH:MM:SS.mmm` timings. Odoo drops blocks without a `-->` line, so an
 * answer with no cue timing at all (a bare "WEBVTT" + text, plain text) becomes one cue.
 */
function toVtt(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (isVtt(text)) lines.shift();
  let cues = 0;
  const body = lines.map((line) => {
    const match = CUE_TIMING.exec(line);
    if (!match) return line;
    cues += 1;
    const settings = (match[3] ?? "").trimEnd();
    return `${vttTimestamp(timestampSeconds(match[1]!))} --> ${vttTimestamp(timestampSeconds(match[2]!))}${settings}`;
  });
  const joined = body.join("\n").trim();
  return cues ? `WEBVTT\n\n${joined}\n` : singleCueVtt(joined);
}

/** Linear-time fence removal (see `stripCodeFence`). */
function stripFence(text: string): string {
  return stripCodeFence(text);
}

function textValue(text: unknown): string {
  return typeof text === "string" ? text : JSON.stringify(text ?? "");
}

/**
 * Odoo attachment (normalized history) -> Gemini part. Text files become text parts (Gemini reads
 * only some text mimetypes as inlineData, and SVG not at all); everything else is inlineData.
 */
function inlinePart(part: InlineDataPart): GeminiPart {
  if (attachmentKind(part.mimetype) === "text") return { text: decodeBase64Text(part.data) };
  return { inlineData: { mimeType: part.mimetype, data: part.data } };
}

function partData(part: { provider_data?: JsonRecord | undefined }): GeminiPartData {
  const data = part.provider_data?.gemini;
  return isRecord(data) ? (data as GeminiPartData) : {};
}

function rawParts(value: unknown): GeminiPart[] {
  return Array.isArray(value) ? (value.filter(isRecord) as GeminiPart[]) : [];
}

/**
 * A user turn: function responses first (Gemini expects them right after the calls), then the
 * images the tools returned, then the user's own text and attachments in order.
 */
function userParts(message: UserMessage, geminiIds: Map<string, string>): GeminiPart[] {
  const responses: GeminiPart[] = [];
  const toolImages: GeminiPart[] = [];
  const other: GeminiPart[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      const text = textValue(part.text);
      if (text) other.push({ text });
    } else if (part.type === "inline_data") {
      other.push(inlinePart(part));
    } else if (part.type === "tool_result") {
      const text = toolResultText(part);
      const id = geminiIds.get(callId(part.tool_call_id));
      responses.push({
        functionResponse: {
          ...(id ? { id } : {}),
          name: part.tool_name,
          response: part.success === false ? { error: text } : { result: text },
        },
      });
      toolImages.push(...toolResultImages(part).map(inlinePart));
    }
  }
  return [...responses, ...toolImages, ...other];
}

/** A model turn rebuilt from an assistant message, with the Gemini data stored on its parts. */
function modelParts(message: AssistantMessage, geminiIds: Map<string, string>): GeminiPart[] {
  // Parts are namespaced, but a message stamped by another provider never carries Gemini state.
  const provider = message.provider_metadata?.provider;
  const foreign = typeof provider === "string" && provider !== "gemini";
  const parts: GeminiPart[] = [];
  for (const part of message.content ?? []) {
    const data = foreign ? {} : partData(part);
    const signature = data.thought_signature ? { thoughtSignature: data.thought_signature } : {};
    parts.push(...rawParts(data.parts_before));
    if (part.type === "text") {
      const text = textValue(part.text);
      if (text) parts.push({ text, ...signature });
    } else if (part.type === "inline_data") {
      // Image editing turns validate signatures on image parts; unknown ones get the placeholder.
      parts.push({ ...inlinePart(part), thoughtSignature: data.thought_signature ?? SKIP_SIGNATURE });
    } else if (part.type === "tool_call") {
      const key = callId(part.call_id);
      if (data.id) geminiIds.set(key, data.id);
      else geminiIds.delete(key);
      parts.push({ functionCall: { ...(data.id ? { id: data.id } : {}), name: part.name, args: parseToolArguments(part.args) }, ...signature });
    }
    parts.push(...rawParts(data.parts_after));
  }
  return parts;
}

/** Odoo history -> Gemini `contents` (consecutive messages of the same role become one turn). */
function buildContents(messages: OdooMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  // Odoo call_id -> Gemini functionCall.id, so each functionResponse can carry the matching id.
  const geminiIds = new Map<string, string>();
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = message.role === "assistant" ? modelParts(message, geminiIds) : userParts(message, geminiIds);
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  // Gemini 3 requires the signature on the first functionCall of each turn (400 otherwise).
  for (const content of contents) {
    const calls = content.parts.filter((part) => part.functionCall);
    if (content.role === "model" && calls.length && !calls.some((part) => part.thoughtSignature)) {
      calls[0]!.thoughtSignature = SKIP_SIGNATURE;
    }
  }
  return contents;
}

function firstCandidate(response: GenerateResponse): Candidate {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    const detail = response.promptFeedback?.blockReasonMessage;
    throw new ProviderError("gemini", `prompt blocked by Gemini (${blocked})${detail ? `: ${detail}` : ""}`);
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw new ProviderError("gemini", "response has no candidates");
  return candidate;
}

function emptyResponseError(candidate: Candidate): ProviderError {
  const reason = candidate.finishReason ?? "unknown";
  const detail = candidate.finishMessage ? `: ${candidate.finishMessage}` : "";
  if (BLOCKED_REASONS.has(reason)) return new ProviderError("gemini", `response blocked by Gemini (${reason})${detail}`);
  if (reason === "MALFORMED_FUNCTION_CALL") return new ProviderError("gemini", `the model produced a malformed function call (${reason})${detail}`);
  if (reason === "MAX_TOKENS") return new ProviderError("gemini", `no content before the output token limit (${reason})${detail}`);
  return new ProviderError("gemini", `empty response (finishReason ${reason})${detail}`);
}

/**
 * Find the text part and JS string span a grounding segment refers to. Offsets are UTF-8 bytes
 * into the part's text; when the converted span does not match `segment.text`, search for it.
 */
function locateSegment(texts: Map<number, TextPart>, segment: Segment): { part: TextPart; start: number; end: number } | undefined {
  const target = texts.get(segment.partIndex ?? 0) ?? texts.values().next().value;
  let converted: { part: TextPart; start: number; end: number } | undefined;
  if (target && segment.endIndex !== undefined) {
    const start = utf8OffsetToIndex(target.text, segment.startIndex ?? 0);
    const end = utf8OffsetToIndex(target.text, segment.endIndex);
    converted = { part: target, start, end };
    if (!segment.text || target.text.slice(start, end) === segment.text) return converted;
  }
  if (segment.text) {
    const candidates = target ? [target, ...[...texts.values()].filter((part) => part !== target)] : [...texts.values()];
    for (const part of candidates) {
      const at = part.text.indexOf(segment.text);
      if (at >= 0) return { part, start: at, end: at + segment.text.length };
    }
  }
  return converted;
}

/** Insert `[WEB_SOURCE:<id>]` markers after each supported segment and attach the sources. */
function applyGrounding(texts: Map<number, TextPart>, metadata: GroundingMetadata): void {
  const chunks = metadata.groundingChunks ?? [];
  const citations = new Map<TextPart, Citation[]>();
  for (const support of metadata.groundingSupports ?? []) {
    const located = support.segment && locateSegment(texts, support.segment);
    if (!located) continue;
    for (const index of support.groundingChunkIndices ?? []) {
      const web = chunks[index]?.web;
      if (!web?.uri) continue;
      const list = citations.get(located.part) ?? [];
      // `uri` is a vertexaisearch redirect: `sourceName` labels it with the title (the domain).
      list.push({ start: located.start, end: located.end, url: web.uri, title: web.title });
      citations.set(located.part, list);
    }
  }
  for (const [part, list] of citations) {
    const cited = applyCitations(part.text, list, "append");
    part.text = cited.text;
    if (Object.keys(cited.sources).length) part.sources = { ...(part.sources ?? {}), ...cited.sources };
  }
}

/** An Odoo part being built from the response, with the Gemini data it will carry. */
interface Entry {
  part: AssistantPart;
  data: GeminiPartData;
}

interface TextEntry extends Entry {
  part: TextPart;
}

function isTextEntry(entry: Entry): entry is TextEntry {
  return entry.part.type === "text";
}

/** Append a text entry to another: text, sources and the Gemini data it carried. */
function mergeTextEntry(target: TextEntry, source: TextEntry): void {
  target.part.text += source.part.text;
  if (source.part.sources) target.part.sources = { ...(target.part.sources ?? {}), ...source.part.sources };
  // Gemini puts the signature on the last part of a run: keep the latest one.
  if (source.data.thought_signature) target.data.thought_signature = source.data.thought_signature;
  for (const key of ["parts_before", "parts_after"] as const) {
    const parts = [...(target.data[key] ?? []), ...(source.data[key] ?? [])];
    if (parts.length) target.data[key] = parts;
  }
}

/**
 * Gemini can split one answer over several text parts. Odoo joins text parts with "\n" and its
 * web search tool reads only the first part (`_get_direct_response(...)[0]`), so consecutive
 * text parts become one. Server-side tool parts between them keep them apart (replay order).
 */
function mergeAdjacentText(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const entry of entries) {
    const previous = out.at(-1);
    if (previous && isTextEntry(previous) && isTextEntry(entry) && !previous.data.parts_after && !entry.data.parts_before) {
      mergeTextEntry(previous, entry);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * gemini-embedding-2 ignores `taskType` and `title`: like EmbeddingGemma, it takes the task as a
 * text prefix. Documents are `title: <title | none> | text: <content>` and queries
 * `task: search result | query: <content>`. The document format is the one Odoo's own service
 * used: re-embedding a stored chunk this way gives cosine similarity 1.0 against the vector Odoo
 * saved (0.906 without the prefix), so existing and new vectors stay in the same space.
 */
export function usesTaskPrefix(modelId: string, option: unknown): boolean {
  if (option === true || option === false) return option;
  return /^gemini-embedding-2/.test(modelId);
}

function embeddingText(id: string, input: EmbeddingInput, request: EmbeddingRequest): string {
  const content = input.content || " ";
  if (!usesTaskPrefix(id, request.options?.embedding_prompt)) return content;
  if (request.mode === "query") return `task: search result | query: ${content}`;
  return `title: ${input.title?.trim() || "none"} | text: ${content}`;
}

export class GeminiAdapter extends BaseAdapter {
  override readonly name = "gemini" as const;
  protected override readonly defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

  override supports(feature: Feature, model: string): boolean {
    const id = modelId(model);
    // batchEmbedContents only works on embedding models (gemini-embedding-001, gemini-embedding-2...).
    if (feature === "embeddings") return isEmbeddingModel(id);
    if (feature === "realtime" || isEmbeddingModel(id)) return false;
    switch (feature) {
      case "image_generation":
        return isImageModel(id);
      case "web_grounding+schema":
      case "tools+schema":
        // Gemini 2.x cannot combine a response schema with tools or search grounding.
        return family(id) === "3+";
      default:
        return true;
    }
  }

  private headers(): Record<string, string> {
    return { "x-goog-api-key": this.settings.apiKey, ...(this.settings.headers ?? {}) };
  }

  private generate(model: string, body: JsonRecord, signal: AbortSignal): Promise<GenerateResponse> {
    return requestJson<GenerateResponse>({
      fetch: this.settings.fetch,
      provider: this.name,
      url: joinUrl(this.baseUrl, `models/${encodeURIComponent(modelId(model))}:generateContent`),
      headers: this.headers(),
      body,
      signal,
    });
  }

  private buildBody(request: CompletionRequest): JsonRecord {
    const id = modelId(request.model);
    const body: JsonRecord = {};
    if (request.instructions) body.systemInstruction = { parts: [{ text: request.instructions }] };
    body.contents = buildContents(request.messages);

    const tools: JsonRecord[] = [];
    if (request.tools.length) {
      tools.push({
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.instructions,
          parametersJsonSchema: toolParameters(tool.schema),
        })),
      });
    }
    if (request.webGrounding) tools.push({ googleSearch: { ...objectOption(request.options, "web_search_tool") } });
    if (tools.length) body.tools = tools;
    // Mixing built-in tools (Google Search) with function calling must be enabled explicitly.
    if (request.tools.length && request.webGrounding) body.toolConfig = { includeServerSideToolInvocations: true };

    const generationConfig: JsonRecord = {};
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    const thinking = thinkingConfig(id, request.effort);
    if (thinking) generationConfig.thinkingConfig = thinking;
    if (request.schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = normalizeSchema(request.schema);
    }
    if (request.imageGeneration) {
      generationConfig.responseModalities = ["TEXT", "IMAGE"];
      if (request.aspectRatio) generationConfig.imageConfig = { aspectRatio: request.aspectRatio };
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    return mergeOptions(body, request.options, GEMINI_OPTIONS, "completion");
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    const response = await this.generate(request.model, this.buildBody(request), request.signal);
    return this.parseResponse(response, request);
  }

  private parseResponse(response: GenerateResponse, request: Pick<CompletionRequest, "webGrounding" | "schema">): AssistantMessage {
    const candidate = firstCandidate(response);
    const entries: Entry[] = [];
    const texts = new Map<number, TextPart>();
    let pending: GeminiPart[] = [];

    const push = (part: AssistantPart, data: GeminiPartData) => {
      if (pending.length) data.parts_before = pending;
      pending = [];
      entries.push({ part, data });
    };

    (candidate.content?.parts ?? []).forEach((raw, index) => {
      if (raw.thought) return;
      const data: GeminiPartData = raw.thoughtSignature ? { thought_signature: raw.thoughtSignature } : {};
      if (typeof raw.text === "string") {
        if (!raw.text) return;
        const part: TextPart = { type: "text", text: raw.text };
        texts.set(index, part);
        push(part, data);
      } else if (raw.inlineData) {
        push({ type: "inline_data", mimetype: raw.inlineData.mimeType, data: raw.inlineData.data }, data);
      } else if (raw.functionCall) {
        const { id, name, args } = raw.functionCall;
        if (id) data.id = id;
        // Gemini 2.5 sends no ids: Odoo still needs a unique call_id to match the result.
        const call = id ?? `call_${index}_${name}_${randomUUID().slice(0, 8)}`;
        push({ type: "tool_call", name, args: parseToolArguments(args ?? {}), call_id: call }, data);
      } else {
        // toolCall / toolResponse (search invoked alongside function calling), executableCode...:
        // Gemini wants them back unchanged, so they ride along on the neighbouring Odoo part.
        pending.push(raw);
      }
    });
    const last = entries.at(-1);
    if (pending.length && last) last.data.parts_after = pending;
    if (!entries.length) throw emptyResponseError(candidate);

    let merged: Entry[];
    if (request.schema) {
      // The answer must be exactly the JSON document: one text part, no markers, no fences.
      const [first, ...rest] = entries.filter(isTextEntry);
      if (first) {
        for (const entry of rest) mergeTextEntry(first, entry);
        first.part.text = stripFence(first.part.text).trim();
      }
      const absorbed = new Set<Entry>(rest);
      merged = entries.filter((entry) => !absorbed.has(entry));
    } else {
      // Grounding offsets are per Gemini part: apply them before merging the parts.
      if (request.webGrounding && candidate.groundingMetadata) applyGrounding(texts, candidate.groundingMetadata);
      merged = mergeAdjacentText(entries);
    }

    for (const { part, data } of merged) {
      if (Object.keys(data).length) part.provider_data = { gemini: data };
    }
    const content = merged.map((entry) => entry.part);

    const providerMetadata: JsonRecord = {};
    if (response.usageMetadata) providerMetadata.usage = response.usageMetadata;
    providerMetadata.gemini = response.modelVersion ? { model_version: response.modelVersion } : {};
    return { role: "assistant", content, provider_metadata: providerMetadata };
  }

  override async embed(request: EmbeddingRequest): Promise<number[][]> {
    const id = modelId(request.model);
    const vectors: number[][] = [];
    for (let offset = 0; offset < request.inputs.length; offset += EMBED_BATCH_SIZE) {
      const batch = request.inputs.slice(offset, offset + EMBED_BATCH_SIZE);
      const response = await requestJson<{ embeddings?: Array<{ values?: number[] }> }>({
        fetch: this.settings.fetch,
        provider: this.name,
        url: joinUrl(this.baseUrl, `models/${encodeURIComponent(id)}:batchEmbedContents`),
        headers: this.headers(),
        body: { requests: batch.map((input) => this.embedItem(id, input, request)) },
        signal: request.signal,
      });
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new ProviderError(this.name, `expected ${batch.length} embeddings, got ${embeddings.length}`);
      }
      for (const embedding of embeddings) {
        const values = embedding.values ?? [];
        if (values.length !== request.dimensions) {
          throw new ProviderError(this.name, `expected ${request.dimensions}-dimension embeddings, got ${values.length}`);
        }
        vectors.push(normalize(values));
      }
    }
    return vectors;
  }

  private embedItem(id: string, input: EmbeddingInput, request: EmbeddingRequest): JsonRecord {
    const config: JsonRecord = { taskType: request.mode === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" };
    if (request.mode === "document" && input.title?.trim()) config.title = input.title;
    config.outputDimensionality = request.dimensions;
    const item: JsonRecord = { model: `models/${id}`, content: { parts: [{ text: embeddingText(id, input, request) }] }, embedContentConfig: config };
    return mergeOptions(item, request.options, GEMINI_OPTIONS, "embeddings");
  }

  /** Transcription through generateContent: the model is asked for the transcript (or WebVTT) only. */
  override async transcribe(request: TranscriptionRequest): Promise<string> {
    const vtt = request.responseFormat === "vtt";
    const hint = request.language ? ` The spoken language is probably "${request.language}".` : "";
    const instruction = vtt
      ? `Transcribe this audio verbatim as a valid WebVTT document.${hint} Start with the line "WEBVTT", use accurate ` +
        `"HH:MM:SS.mmm --> HH:MM:SS.mmm" timestamps and cues of at most about 6 seconds. Return only the WebVTT document.`
      : `Transcribe this audio verbatim.${hint} Return only the transcript.`;
    const body = mergeOptions(
      { contents: [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType: canonicalAudioMimetype(request.mimetype), data: request.audio } }] }] },
      request.options,
      GEMINI_OPTIONS,
      "transcription",
    );
    const candidate = firstCandidate(await this.generate(request.model, body, request.signal));
    const raw = (candidate.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    const text = stripFence(raw).trim();
    // Silence legitimately gives an empty transcript; an empty answer for any other reason is an error.
    if (!text && candidate.finishReason && candidate.finishReason !== "STOP") throw emptyResponseError(candidate);
    return vtt ? toVtt(text) : text;
  }
}

/** L2-normalize: gemini-embedding-001 only normalizes its full 3072-dimension output. */
function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map((value) => value / norm) : values;
}
