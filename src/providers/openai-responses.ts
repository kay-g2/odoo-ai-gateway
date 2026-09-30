/**
 * Shared translator for the OpenAI Responses API (`POST /responses`), used by the OpenAI adapter
 * and by the Grok adapter (xAI's Responses API is OpenAI compatible).
 *
 * Requests are stateless (`store: false`): the whole Odoo history is sent every turn. To keep
 * reasoning across an agent loop, the assistant message returned to Odoo carries every output item
 * (reasoning items with `encrypted_content`, messages, function calls, search calls) under
 * `provider_metadata[<provider>].output`; the next turn replays them verbatim, in order.
 * Generated images are the exception: their base64 lives only in the `inline_data` parts and is
 * put back into the `image_generation_call` items on replay.
 */
import { createHash } from "node:crypto";

import { ProviderError } from "../core/errors.js";
import { attachmentKind, sniffImageMimetype } from "../core/odoo-history.js";
import type {
  AssistantMessage,
  AssistantPart,
  InlineDataPart,
  OdooMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../core/odoo-types.js";
import { applyCitations, utf8OffsetToIndex, type Citation, type CitationMode } from "./citations.js";
import {
  callId,
  dataUrl,
  decodeBase64Text,
  extensionFor,
  parseToolArguments,
  replayData,
  toolResultText,
} from "./parts.js";
import { mergeOptions, values, type OptionDeclarations, type OptionSpec } from "./options.js";
import { isStrictCompatible, normalizeSchema, toolParameters } from "./schema.js";
import { EFFORTS, type CompletionRequest, type Effort, type ProviderName } from "./types.js";

type Item = Record<string, unknown>;

/** What differs between Responses API providers. */
export interface ResponsesProfile {
  provider: ProviderName;
  /** Reasoning family: send `include: ["reasoning.encrypted_content"]` and replay reasoning items. */
  isReasoningModel(model: string): boolean;
  /** `reasoning.effort` for a defined canonical effort, or undefined to omit `reasoning`. */
  reasoningEffort(model: string, effort: Effort, request: CompletionRequest): string | undefined;
  /** Hosted tools (web search, image generation) appended after the function tools. */
  hostedTools(request: CompletionRequest): Item[];
  /** Extra `include` entries for this request. */
  extraInclude?(request: CompletionRequest): string[];
  /** The provider's `options` declarations; completion requests apply them with `mergeOptions`. */
  options: OptionDeclarations;
  /**
   * Send the conversation id as `prompt_cache_key` unless `options.prompt_cache_key` says
   * otherwise. Requests with different keys never share cached prefixes, so a per-conversation key
   * only pays off where the provider routes by it (xAI); OpenAI routes GPT-5.6+ automatically.
   */
  conversationCacheKey: boolean;
  citationMode: CitationMode;
  /** Whether an `url_citation.title` is a page title (OpenAI) or just a number label (xAI). */
  citationTitles: boolean;
  /** `function_call_output.output` may be a list of input parts (images, files). */
  toolOutputParts: boolean;
  /** `input_file` with inline `file_data` is accepted (PDFs and other documents). */
  fileInput: boolean;
  /** Image mimetypes `input_image` accepts; other images become a text note instead of a 400. */
  imageMimetypes: readonly string[];
}

/** Replay data stored under `provider_metadata[<provider>]`. */
export interface ResponsesReplay {
  output: Item[];
  response_id?: string;
  /**
   * Indices of `image_generation_call` items whose base64 `result` was left out (it is already
   * the message's `inline_data` part, in the same order) and is restored on replay.
   */
  inline_images?: number[];
}

/**
 * Clamp a canonical effort to the levels a model accepts: the nearest allowed level on the
 * ladder `none < minimal < low < medium < high < xhigh < max`, ties going up.
 */
export function clampEffort(effort: Effort, allowed: readonly Effort[]): Effort {
  const target = EFFORTS.indexOf(effort);
  let best: Effort | undefined;
  let bestDistance = Infinity;
  for (const level of allowed) {
    const index = EFFORTS.indexOf(level);
    const distance = Math.abs(index - target);
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && index > EFFORTS.indexOf(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best ?? effort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function partText(part: TextPart): string {
  return typeof part.text === "string" ? part.text : JSON.stringify(part.text);
}

/**
 * `call_id` as the Responses API accepts it (1-64 chars). Ids minted by other providers can be
 * longer (e.g. `call_<n>_<tool name>_<hex>`); they are shortened the same way for the call and
 * its output, so the pair still matches.
 */
export function responsesCallId(value: unknown): string {
  const id = callId(value);
  if (id && id.length <= 64) return id;
  return `call_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** The provider infers the document type from the filename: use real extensions for office files. */
const FILE_EXTENSIONS: Record<string, string> = {
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "application/epub+zip": "epub",
};

/** One `inline_data` part of the normalized history as Responses input content. */
function inputContent(part: InlineDataPart, profile: ResponsesProfile): Item {
  const mimetype = part.mimetype;
  const kind = attachmentKind(mimetype);
  if (kind === "text") return { type: "input_text", text: decodeBase64Text(part.data) };
  if (kind === "image") {
    if (profile.imageMimetypes.includes(mimetype)) return { type: "input_image", image_url: dataUrl(part), detail: "auto" };
    return { type: "input_text", text: `[Attached ${mimetype} image omitted: ${profile.provider} only reads ${profile.imageMimetypes.join(", ")} images]` };
  }
  if (!profile.fileInput) return { type: "input_text", text: `[Attached ${mimetype} file omitted: not supported by this provider]` };
  if (kind === "pdf") return { type: "input_file", filename: "document.pdf", file_data: dataUrl(part) };
  return { type: "input_file", filename: `file.${FILE_EXTENSIONS[mimetype] ?? extensionFor(mimetype)}`, file_data: dataUrl(part) };
}

function toolOutput(part: ToolResultPart, profile: ResponsesProfile): { item: Item; attachments: Item[] } {
  const media = (part.result ?? []).filter((inner): inner is InlineDataPart => inner.type === "inline_data");
  const text = toolResultText(part);
  const item: Item = { type: "function_call_output", call_id: responsesCallId(part.tool_call_id), output: text };
  if (!media.length) return { item, attachments: [] };
  const content = media.map((inner) => inputContent(inner, profile));
  if (profile.toolOutputParts) {
    item.output = [{ type: "input_text", text }, ...content];
    return { item, attachments: [] };
  }
  // No multimodal tool outputs: show the media to the model in the following user message.
  return { item, attachments: [{ type: "input_text", text: `Attachments returned by the tool "${part.tool_name}":` }, ...content] };
}

function userItems(message: OdooMessage, profile: ResponsesProfile): Item[] {
  const items: Item[] = [];
  const content: Item[] = [];
  const attachments: Item[] = [];
  for (const part of message.content) {
    if (part.type === "tool_result") {
      const output = toolOutput(part, profile);
      items.push(output.item);
      attachments.push(...output.attachments);
    } else if (part.type === "text") {
      content.push({ type: "input_text", text: partText(part) });
    } else if (part.type === "inline_data") {
      content.push(inputContent(part, profile));
    }
  }
  const all = [...attachments, ...content];
  if (all.length) items.push({ role: "user", content: all });
  return items;
}

/**
 * The stored output items of a message this provider produced, ready to replay; undefined when
 * they cannot be replayed as-is and the message must be rebuilt from its generic parts:
 * - the model has no reasoning: its encrypted reasoning is rejected, and dropping only the
 *   reasoning items is rejected too (the kept `msg_`/`fc_` ids point at their reasoning item);
 * - the tool calls no longer match the message content (edited history);
 * - a generated image's base64 is no longer in the message.
 */
function replayOutput(message: OdooMessage, replay: ResponsesReplay, model: string, profile: ResponsesProfile): Item[] | undefined {
  const output = replay.output.filter(isRecord);
  if (!output.length) return undefined;
  if (!profile.isReasoningModel(model) && output.some((item) => item.type === "reasoning")) return undefined;

  const storedCalls = output.filter((item) => item.type === "function_call").map((item) => String(item.call_id)).sort();
  const contentCalls = message.content
    .filter((part): part is ToolCallPart => part.type === "tool_call")
    .map((part) => callId(part.call_id))
    .sort();
  if (storedCalls.join("\n") !== contentCalls.join("\n")) return undefined;

  const detached = new Set(Array.isArray(replay.inline_images) ? replay.inline_images : []);
  if (!detached.size) return output;
  const images = message.content
    .filter((part): part is InlineDataPart => part.type === "inline_data" && attachmentKind(part.mimetype) === "image")
    .map((part) => part.data);
  if (images.length < detached.size) return undefined;
  let next = 0;
  return replay.output.map((item, index) => (detached.has(index) ? { ...item, result: images[next++] } : item)).filter(isRecord);
}

function assistantItems(message: OdooMessage, model: string, profile: ResponsesProfile): Item[] {
  const replay = replayData<ResponsesReplay>(message, profile.provider);
  const replayed = replay && Array.isArray(replay.output) ? replayOutput(message, replay, model, profile) : undefined;
  if (replayed) return replayed;
  // Cross-provider history (or Odoo fixtures): rebuild from the generic parts.
  const items: Item[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      const text = partText(part);
      if (text) items.push({ role: "assistant", content: text });
    } else if (part.type === "tool_call") {
      items.push({
        type: "function_call",
        call_id: responsesCallId(part.call_id),
        name: part.name,
        // Other providers may have stored the arguments as a JSON string: send one JSON object.
        arguments: JSON.stringify(parseToolArguments(part.args)),
      });
    }
    // Assistant inline_data (generated images) has no assistant-side input representation.
  }
  return items;
}

export function buildInput(request: CompletionRequest, profile: ResponsesProfile): Item[] {
  const input: Item[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant") input.push(...assistantItems(message, request.model, profile));
    else input.push(...userItems(message, profile));
  }
  return input;
}

/** The `POST /responses` body for a completion request. */
export function buildResponsesBody(request: CompletionRequest, profile: ResponsesProfile): Record<string, unknown> {
  const reasoning = profile.isReasoningModel(request.model);
  const body: Record<string, unknown> = { model: request.model };
  if (request.instructions) body.instructions = request.instructions;
  body.input = buildInput(request, profile);
  body.store = false;

  const include = [...(reasoning ? ["reasoning.encrypted_content"] : []), ...(profile.extraInclude?.(request) ?? [])];
  if (include.length) body.include = include;
  if (request.effort !== undefined && reasoning) {
    const effort = profile.reasoningEffort(request.model, request.effort, request);
    if (effort !== undefined) body.reasoning = { effort };
  }
  if (request.maxOutputTokens) body.max_output_tokens = request.maxOutputTokens;
  if (request.schema) {
    const schema = normalizeSchema(request.schema);
    body.text = { format: { type: "json_schema", name: "response", schema, strict: isStrictCompatible(schema) } };
  }

  const functions: Item[] = request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.instructions,
    parameters: toolParameters(tool.schema),
    strict: false,
  }));
  const tools = [...functions, ...profile.hostedTools(request)];
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (functions.length) body.parallel_tool_calls = true;

  const merged = mergeOptions(body, request.options, profile.options, "completion");
  const cacheKey = promptCacheKey(request, profile);
  if (cacheKey) merged.prompt_cache_key = cacheKey;
  return merged;
}

/**
 * `options.prompt_cache_key`: `"conversation"` uses the Odoo conversation id, another string is
 * sent as is (e.g. one key per agent to share its prefix across conversations), `false` sends
 * none. Unset follows `profile.conversationCacheKey`.
 */
export function promptCacheKeyOption(byDefault: string): OptionSpec {
  return {
    operations: ["completion"],
    merge: "adapter",
    value: values.anyOf(values.text, values.oneOf(false)),
    doc: `\`"conversation"\` sends the conversation id (see Conversation id), another string is sent as is, \`false\` sends none. Default: ${byDefault}.`,
  };
}

function promptCacheKey(request: CompletionRequest, profile: ResponsesProfile): string | undefined {
  const option = request.options?.prompt_cache_key;
  const value = option === undefined ? (profile.conversationCacheKey ? "conversation" : undefined) : option;
  if (value === "conversation") return request.conversationId;
  return typeof value === "string" && value ? value : undefined;
}

interface OutputText {
  type: "output_text";
  text?: string;
  annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }>;
}

/** JavaScript (UTF-16) index of an offset counted in Unicode code points; -1 past the end. */
function codePointOffsetToIndex(text: string, offset: number): number {
  let count = 0;
  let index = 0;
  for (const char of text) {
    if (count >= offset) return index;
    count += 1;
    index += char.length;
  }
  return count === offset ? index : -1;
}

/** An inline citation link as written by the model: `([site](url))`, `[site](url)`, `[[1]](url)`. */
function isLinkSpan(span: string): boolean {
  return /^[([]/.test(span) && span.endsWith(")") && span.includes("](");
}

/**
 * `start_index`/`end_index` count characters on the provider side, which is not necessarily the
 * UTF-16 index JavaScript uses (emoji and other astral characters count once in Python, several
 * UTF-8 bytes in byte-based backends). For non-ASCII text, pick the reading whose span is exactly
 * the inline link; otherwise keep the indices as sent.
 */
function citationSpan(text: string, start: number, end: number): { start: number; end: number } {
  const asSent = { start, end };
  if (!Number.isInteger(start) || !Number.isInteger(end) || !/[^\x00-\x7f]/.test(text)) return asSent;
  const readings = [
    asSent,
    { start: codePointOffsetToIndex(text, start), end: codePointOffsetToIndex(text, end) },
    { start: utf8OffsetToIndex(text, start), end: utf8OffsetToIndex(text, end) },
  ];
  const valid = (r: { start: number; end: number }) => r.start >= 0 && r.end > r.start && r.end <= text.length;
  return readings.find((r) => valid(r) && isLinkSpan(text.slice(r.start, r.end))) ?? asSent;
}

function textPart(content: OutputText, request: CompletionRequest, profile: ResponsesProfile): TextPart | undefined {
  const text = content.text ?? "";
  if (!text) return undefined;
  if (!request.webGrounding || request.schema) return { type: "text", text };
  const citations: Citation[] = (content.annotations ?? [])
    .filter((annotation) => annotation.type === "url_citation" && typeof annotation.url === "string")
    .map((annotation) => ({
      ...citationSpan(text, annotation.start_index ?? -1, annotation.end_index ?? -1),
      url: annotation.url!,
      title: profile.citationTitles ? annotation.title : undefined,
    }));
  const cited = applyCitations(text, citations, profile.citationMode);
  return Object.keys(cited.sources).length ? { type: "text", text: cited.text, sources: cited.sources } : { type: "text", text: cited.text };
}

/**
 * Items kept for replay: every output item, in order (with `store: false` the whole sequence must
 * be replayed; dropping an item orphans the reasoning item paired with it). The base64 `result` of
 * generated images is left out: Odoo already stores it as the `inline_data` part.
 */
function storedReplay(output: Item[]): Pick<ResponsesReplay, "output" | "inline_images"> {
  const inlineImages: number[] = [];
  const kept = output.map((item, index) => {
    if (item.type !== "image_generation_call" || typeof item.result !== "string" || !item.result) return item;
    inlineImages.push(index);
    const { result: _result, ...rest } = item;
    return rest;
  });
  return inlineImages.length ? { output: kept, inline_images: inlineImages } : { output: kept };
}

/** Translate a `/responses` result into the assistant message returned to Odoo. */
export function parseResponsesResponse(response: Record<string, unknown>, request: CompletionRequest, profile: ResponsesProfile): AssistantMessage {
  const provider = profile.provider;
  const error = isRecord(response.error) ? response.error : undefined;
  if (response.status === "failed" || response.status === "cancelled" || error) {
    const detail = (typeof error?.message === "string" && error.message) || (typeof error?.code === "string" && error.code) || String(response.status);
    throw new ProviderError(provider, `response failed: ${detail}`);
  }

  const output = Array.isArray(response.output) ? response.output.filter(isRecord) : [];
  const content: AssistantPart[] = [];
  const refusals: string[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const inner of item.content.filter(isRecord)) {
        if (inner.type === "output_text") {
          const part = textPart(inner as unknown as OutputText, request, profile);
          if (part) content.push(part);
        } else if (inner.type === "refusal" && typeof inner.refusal === "string" && inner.refusal) {
          refusals.push(inner.refusal);
          content.push({ type: "text", text: inner.refusal });
        }
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      content.push({ type: "tool_call", name: item.name, args: parseToolArguments(item.arguments), call_id: callId(item.call_id ?? item.id) });
    } else if (item.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      // The item does not reliably echo `output_format`: trust the bytes first.
      const format = typeof item.output_format === "string" && item.output_format ? item.output_format : "png";
      const mimetype = sniffImageMimetype(item.result) ?? `image/${format === "jpg" ? "jpeg" : format}`;
      content.push({ type: "inline_data", mimetype, data: item.result });
    }
  }

  const incomplete = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  const reason = String(incomplete?.reason ?? "unknown reason");
  if (!content.length) {
    if (response.status === "incomplete") {
      throw new ProviderError(provider, `response incomplete (${reason}) with no usable output`);
    }
    throw new ProviderError(provider, "empty response (no text, tool call or image)");
  }
  const hasToolCall = content.some((part) => part.type === "tool_call");
  if (request.schema && refusals.length && !hasToolCall && content.length === refusals.length) {
    throw new ProviderError(provider, `model refused the structured output request: ${refusals.join(" ")}`);
  }
  // A truncated structured answer is not valid JSON: report why instead of a parse error.
  if (request.schema && response.status === "incomplete" && !hasToolCall) {
    throw new ProviderError(provider, `response incomplete (${reason}): the structured output was cut off`);
  }

  const replay: ResponsesReplay = storedReplay(output);
  if (typeof response.id === "string") replay.response_id = response.id;
  const metadata: Record<string, unknown> = { provider, model: request.model };
  if (response.usage !== undefined) metadata.usage = response.usage;
  metadata[provider] = replay;
  return { role: "assistant", content, provider_metadata: metadata };
}
