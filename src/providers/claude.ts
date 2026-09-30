/**
 * Anthropic Messages API adapter (`POST /v1/messages`).
 *
 * Provider quirks handled here:
 * - Consecutive same-role messages form one turn, and inside a user turn the `tool_result` blocks
 *   must come first: Odoo messages are merged per role and the tool results moved to the front.
 * - Assistant turns this adapter produced are replayed verbatim from
 *   `provider_metadata.claude.content`: thinking signatures, web search `encrypted_content` and
 *   citation `encrypted_index` must come back unchanged or the API answers 400.
 * - Reasoning is `thinking.budget_tokens` on 4.5-and-older models, and adaptive thinking plus
 *   `output_config.effort` on newer ones. Thinking tokens count toward `max_tokens`.
 * - Preserved thinking (Fable 5.1, Opus 5.5, Sonnet 5.5 and later): a thinking block's signature is
 *   bound to the system prompt, the tools and every earlier message, and replaying it after an edit
 *   is a 400 on accounts created since 2026-08-31. Odoo edits history every round (it re-appends
 *   `<odoo_current_context>` with the current time to the last user text message, appends loaded
 *   skills to the instructions, changes the tool set), so such requests ask the API to drop stale
 *   blocks (`thinking.block_binding`, beta `thinking-binding-controls-2026-08-01`).
 * - Server-side web search can stop with `pause_turn`; the turn is re-sent until it finishes.
 * - Structured outputs (`output_config.format`) cannot be combined with citations, so web
 *   grounding and a schema are never supported together.
 * - Claude has no image generation, embeddings, transcription or realtime API.
 *
 * `options` (declared in `CLAUDE_OPTIONS`, applied by `mergeOptions`): `web_search_tool` and
 * `prompt_cache` are read here; any other key replaces the body field of that name (an
 * `options.thinking` replaces the adapter's `thinking` object, `block_binding` included).
 */
import { createHash } from "node:crypto";

import { ProviderError } from "../core/errors.js";
import { attachmentKind } from "../core/odoo-history.js";
import type { AssistantMessage, AssistantPart, InlineDataPart, OdooMessage, ToolResultPart } from "../core/odoo-types.js";
import { BaseAdapter } from "./base.js";
import { applyCitations, type Citation } from "./citations.js";
import { joinUrl, requestJson } from "./http.js";
import { callId, decodeBase64Text, parseToolArguments, replayData, toolResultImages, toolResultText } from "./parts.js";
import { mergeOptions, objectOption, values, type OptionDeclarations } from "./options.js";
import { planPromptCache, PROMPT_CACHE_OPTION, type CacheControl, type PromptCachePlan } from "./prompt-cache.js";
import { stripKeywords, toolParameters } from "./schema.js";
import type { CompletionRequest, Effort, Feature } from "./types.js";

type Block = Record<string, unknown> & { type: string };

interface ClaudeMessage {
  role: "user" | "assistant";
  content: Block[];
}

interface ClaudeResponse {
  content?: unknown;
  stop_reason?: string | null;
  /** Only set for `stop_reason: "refusal"` (safety classifier category such as "cyber"). */
  stop_details?: { category?: string | null } | null;
  usage?: Record<string, unknown>;
}

/** Stored in `provider_metadata.claude` and read back by `replayData`. */
interface ClaudeReplay {
  content: Block[];
  stop_reason?: string | null;
}

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16_000;
/** Room kept for the visible answer on top of a thinking budget. */
const ANSWER_HEADROOM = 8192;
/** `pause_turn` continuations before giving up on the server tool loop. */
const MAX_CONTINUATIONS = 5;

export const CLAUDE_OPTIONS: OptionDeclarations = {
  web_search_tool: {
    operations: ["completion"],
    merge: "adapter",
    gatewayKey: true,
    value: values.object,
    doc: "Merged into the `web_search` server tool (`max_uses`, `allowed_domains`...).",
  },
  prompt_cache: PROMPT_CACHE_OPTION,
};
/** Unlocks `thinking.block_binding.prefix_mismatch_behavior` (preserved-thinking controls). */
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

const SUPPORTED = new Set<Feature>(["completion", "tools", "schema", "tools+schema", "image_input", "pdf_input", "web_grounding"]);

/** Models that take `thinking: {type: "enabled", budget_tokens}` and reject adaptive thinking. */
const BUDGET_MODELS = /^claude-(?:haiku-4-5|opus-4-5|sonnet-4-5|opus-4-1|opus-4-0|opus-4-2025|sonnet-4-0|sonnet-4-2025|3-7-sonnet)/;
/** Claude 3.x before 3.7: no extended thinking and no effort, so reasoning params are omitted. */
const LEGACY_MODELS = /^claude-3-(?!7)/;
/** Opus 4.0/4.1 cap the output at 32K tokens; the other budget models allow 64K. */
const OUTPUT_32K_MODELS = /^claude-opus-4-(?:0|1|2025)/;
/** Adaptive models that accept `output_config.effort: "xhigh"` (not Opus/Sonnet 4.6, Mythos Preview). */
const XHIGH_MODELS = /^claude-(?:opus-4-7|opus-4-8|opus-5|sonnet-5|fable|mythos(?!-preview))/;
/** Models without structured outputs (`output_config.format`). */
const NO_SCHEMA_MODELS = /^claude-(?:3-|opus-4-0|opus-4-2025|sonnet-4-0|sonnet-4-2025)/;
/**
 * Adaptive models whose thinking is off unless requested. Their signatures carry no conversation
 * binding, so they never need `block_binding`; every other adaptive model thinks by default.
 */
const THINKING_OFF_BY_DEFAULT = /^claude-(?:opus-4-[678]|sonnet-4-6)/;

const BUDGETS: Record<Exclude<Effort, "none">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
};

/**
 * Keywords Claude structured outputs reject: numeric/string bounds and complex array/object
 * constraints (`minItems` > 1 is dropped separately, `additionalProperties` is forced to false).
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "pattern",
  "format",
];

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBlock(value: unknown): value is Block {
  return isRecord(value) && typeof value.type === "string";
}

interface Reasoning {
  thinking?: Record<string, unknown>;
  effort?: string;
  budget?: number;
}

/**
 * Canonical effort -> Claude params. Undefined sends nothing (model default). Budget models get
 * a thinking budget; adaptive models get adaptive thinking + `output_config.effort`, where
 * "none" means the lowest effort without the `thinking` field (Fable/Opus 5.5 reject
 * `disabled`), "minimal" becomes "low" and "xhigh" falls back to "high" where unsupported.
 */
function reasoningFor(model: string, effort: Effort | undefined): Reasoning {
  if (effort === undefined || LEGACY_MODELS.test(model)) return {};
  if (BUDGET_MODELS.test(model)) {
    if (effort === "none") return {};
    const budget = BUDGETS[effort];
    return { thinking: { type: "enabled", budget_tokens: budget }, budget };
  }
  if (effort === "none") return { effort: "low" };
  const level = effort === "minimal" ? "low" : effort === "xhigh" && !XHIGH_MODELS.test(model) ? "high" : effort;
  return { thinking: { type: "adaptive" }, effort: level };
}

/**
 * `max_tokens` must exceed the thinking budget: raise it so the answer keeps `ANSWER_HEADROOM`
 * tokens (within the model's output cap), then shrink the budget if the cap leaves no room.
 */
function fitBudget(model: string, requested: number, budget: number): { maxTokens: number; budget: number } {
  const cap = OUTPUT_32K_MODELS.test(model) ? 32_000 : 64_000;
  const maxTokens = Math.max(requested, Math.min(cap, budget + ANSWER_HEADROOM));
  return { maxTokens, budget: Math.max(1024, Math.min(budget, maxTokens - ANSWER_HEADROOM)) };
}

/**
 * Tool ids must match `^[a-zA-Z0-9_-]+$`; applied identically to `tool_use` and `tool_result`.
 * A rewritten id gets a hash of the original so distinct ids ("call:1", "call/1") stay distinct.
 */
function toolUseId(value: unknown): string {
  const raw = callId(value);
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "call"}_${hash}`;
}

function textBlock(text: unknown): Block | undefined {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  // The API rejects empty and whitespace-only text blocks.
  return value.trim() ? { type: "text", text: value } : undefined;
}

/** Odoo attachment (normalized history) -> Claude block. */
function attachmentBlock(part: InlineDataPart): Block {
  const media = part.mimetype;
  switch (attachmentKind(media)) {
    case "image":
      if (IMAGE_TYPES.has(media)) return { type: "image", source: { type: "base64", media_type: media, data: part.data } };
      return { type: "text", text: `[image ${media} omitted: unsupported format]` };
    case "pdf":
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: part.data } };
    case "text": {
      const text = decodeBase64Text(part.data);
      if (text.trim()) return { type: "document", source: { type: "text", media_type: "text/plain", data: text } };
      break;
    }
  }
  return { type: "text", text: `[attachment ${media} omitted]` };
}

function toolResultBlock(part: ToolResultPart): Block {
  // Whitespace-only text blocks are rejected, even inside a tool_result.
  const text = toolResultText(part);
  const content: Block[] = [{ type: "text", text: text.trim() ? text : part.success === false ? "Error" : "success" }];
  for (const inner of toolResultImages(part)) content.push(attachmentBlock(inner));
  return { type: "tool_result", tool_use_id: toolUseId(part.tool_call_id), content, is_error: part.success === false };
}

function userBlocks(message: OdooMessage): Block[] {
  const blocks: Block[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      const block = textBlock(part.text);
      if (block) blocks.push(block);
    } else if (part.type === "inline_data") blocks.push(attachmentBlock(part));
    else if (part.type === "tool_result") blocks.push(toolResultBlock(part));
  }
  return blocks;
}

/** Same-provider turns replay verbatim; anything else is rebuilt from the generic parts. */
function assistantBlocks(message: OdooMessage): Block[] {
  const replay = replayData<ClaudeReplay>(message, "claude");
  if (replay && Array.isArray(replay.content)) return replay.content.filter(isBlock);
  const blocks: Block[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      const block = textBlock(part.text);
      if (block) blocks.push(block);
    } else if (part.type === "tool_call") {
      blocks.push({ type: "tool_use", id: toolUseId(part.call_id), name: part.name, input: parseToolArguments(part.args) });
    }
    // Generated images (inline_data) cannot be sent as assistant content: skipped.
  }
  return blocks;
}

function append(messages: ClaudeMessage[], role: ClaudeMessage["role"], content: Block[]): void {
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...content);
  else messages.push({ role, content: [...content] });
}

/** Odoo history -> alternating Claude messages (consecutive same-role messages are merged). */
function toClaudeMessages(history: OdooMessage[]): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  for (const message of history) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = role === "assistant" ? assistantBlocks(message) : userBlocks(message);
    if (content.length) append(messages, role, content);
  }
  for (const message of messages) {
    if (message.role !== "user") continue;
    message.content = [
      ...message.content.filter((block) => block.type === "tool_result"),
      ...message.content.filter((block) => block.type !== "tool_result"),
    ];
  }
  return messages;
}

const hasType = (message: ClaudeMessage | undefined, type: string): boolean =>
  Boolean(message?.content.some((block) => block.type === type));

/**
 * Manual thinking (`{type: "enabled", budget_tokens}`) requires the assistant message that opened
 * the pending tool loop to start with its thinking block. Turns rebuilt from another provider (or
 * produced without thinking) have none, so budget thinking is left off for such a request.
 * Adaptive thinking has no such rule (a turn may skip thinking), so it is never dropped: that would
 * change the thinking configuration in the middle of a tool loop.
 */
function toolLoopLacksThinking(messages: ClaudeMessage[]): boolean {
  let opener: ClaudeMessage | undefined;
  for (let i = messages.length - 1; i >= 1; i -= 2) {
    const result = messages[i];
    const call = messages[i - 1];
    if (result?.role !== "user" || !hasType(result, "tool_result") || call?.role !== "assistant" || !hasType(call, "tool_use")) break;
    opener = call;
  }
  const first = opener?.content[0]?.type;
  return opener !== undefined && first !== "thinking" && first !== "redacted_thinking";
}

const replaysThinking = (messages: ClaudeMessage[]): boolean =>
  messages.some((message) => message.role === "assistant" && (hasType(message, "thinking") || hasType(message, "redacted_thinking")));

const cacheable = (block: Block | undefined): boolean =>
  Boolean(block) &&
  block!.type !== "thinking" &&
  block!.type !== "redacted_thinking" &&
  (block!.type !== "text" || (typeof block!.text === "string" && block!.text.trim() !== ""));

/**
 * Put a cache breakpoint on the last block that renders from the stable history (the Odoo
 * messages before the one Odoo rewrites every round). `stable` is the same conversion applied to
 * that prefix alone; if the full conversion does not start with it byte for byte (a merge moved
 * blocks around), no breakpoint is added. Blocks are copied, never mutated (they may be replayed
 * provider state).
 */
function markStableHistory(messages: ClaudeMessage[], stable: ClaudeMessage[], control: CacheControl): ClaudeMessage[] {
  const at = stable.length - 1;
  const last = stable[at];
  const target = messages[at];
  if (!last || !target || target.role !== last.role) return messages;
  for (let i = 0; i < at; i++) if (JSON.stringify(messages[i]) !== JSON.stringify(stable[i])) return messages;
  if (JSON.stringify(target.content.slice(0, last.content.length)) !== JSON.stringify(last.content)) return messages;
  for (let b = last.content.length - 1; b >= 0; b--) {
    if (!cacheable(target.content[b])) continue;
    const content = [...target.content];
    content[b] = { ...content[b]!, cache_control: control };
    const out = [...messages];
    out[at] = { ...target, content };
    return out;
  }
  return messages;
}

/**
 * Models whose thinking blocks are bound to the conversation (preserved thinking) or may be: every
 * adaptive model that thinks by default. `{type: "adaptive"}` is their default, so sending it
 * explicitly (to carry `block_binding`) changes nothing else.
 */
function bindsThinking(model: string): boolean {
  return !LEGACY_MODELS.test(model) && !BUDGET_MODELS.test(model) && !THINKING_OFF_BY_DEFAULT.test(model);
}

/** Merge extra `anthropic-beta` values into the (case-insensitive) configured header. */
function withBetas(headers: Record<string, string>, betas: string[]): Record<string, string> {
  if (!betas.length) return headers;
  const out: Record<string, string> = {};
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "anthropic-beta") values.push(...value.split(",").map((beta) => beta.trim()).filter(Boolean));
    else out[key] = value;
  }
  for (const beta of betas) if (!values.includes(beta)) values.push(beta);
  out["anthropic-beta"] = values.join(",");
  return out;
}

/**
 * Structured-output schema: drop unsupported keywords, close objects, drop `minItems` > 1. Claude
 * only accepts `additionalProperties: false`, so a map-like `true`/sub-schema is closed too.
 */
function outputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "minItems" && typeof value === "number" && value > 1) continue;
      if (key === "additionalProperties") {
        out[key] = false;
        continue;
      }
      if (key === "properties" && isRecord(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub)]));
      } else out[key] = key === "enum" || key === "const" ? value : walk(value);
    }
    return out;
  };
  return walk(stripKeywords(schema, UNSUPPORTED_SCHEMA_KEYWORDS, { closeObjects: true })) as Record<string, unknown>;
}

/** Sum token counters across `pause_turn` continuations. */
function addUsage(total: Record<string, unknown> | undefined, next: unknown): Record<string, unknown> | undefined {
  if (!isRecord(next)) return total;
  if (!total) return { ...next };
  const out: Record<string, unknown> = { ...total };
  for (const [key, value] of Object.entries(next)) {
    const previous = out[key];
    if (typeof value === "number" && typeof previous === "number") out[key] = previous + value;
    else if (isRecord(value) && isRecord(previous)) out[key] = addUsage(previous, value);
    else out[key] = value;
  }
  return out;
}

/**
 * Claude blocks -> Odoo parts. Consecutive text blocks (split around citations) form one text
 * part; `tool_use` ends it. Thinking and server tool blocks stay hidden (kept for replay only);
 * a paragraph break is added where one separated two runs of text.
 */
function toParts(blocks: Block[], grounded: boolean): AssistantPart[] {
  const parts: AssistantPart[] = [];
  let text = "";
  let citations: Citation[] = [];
  let separated = false;
  const flush = () => {
    if (text) {
      const cited = grounded ? applyCitations(text, citations, "append") : { text, sources: {} };
      parts.push({ type: "text", text: cited.text, ...(Object.keys(cited.sources).length ? { sources: cited.sources } : {}) });
    }
    text = "";
    citations = [];
    separated = false;
  };
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      if (separated && text && !/\s$/.test(text) && !/^\s/.test(block.text)) text += "\n\n";
      separated = false;
      const start = text.length;
      text += block.text;
      if (!grounded || !Array.isArray(block.citations)) continue;
      for (const citation of block.citations) {
        if (!isRecord(citation) || citation.type !== "web_search_result_location" || typeof citation.url !== "string") continue;
        citations.push({ start, end: text.length, url: citation.url, title: typeof citation.title === "string" ? citation.title : undefined });
      }
    } else if (block.type === "tool_use") {
      flush();
      parts.push({ type: "tool_call", name: String(block.name ?? ""), args: parseToolArguments(block.input), call_id: String(block.id ?? "") });
    } else {
      separated = true;
    }
  }
  flush();
  return parts;
}

export class ClaudeAdapter extends BaseAdapter {
  readonly name = "claude" as const;
  protected readonly defaultBaseUrl = "https://api.anthropic.com/v1";

  supports(feature: Feature, model: string): boolean {
    if ((feature === "schema" || feature === "tools+schema") && NO_SCHEMA_MODELS.test(model.toLowerCase())) return false;
    return SUPPORTED.has(feature);
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    const cache = planPromptCache(request.messages, request.options?.prompt_cache);
    let messages = toClaudeMessages(request.messages);
    if (cache && cache.historyEnd >= 0) {
      messages = markStableHistory(messages, toClaudeMessages(request.messages.slice(0, cache.historyEnd + 1)), cache.control);
    }
    const { body, betas } = this.buildBody(request, messages, cache);
    const headers = withBetas(
      { "x-api-key": this.settings.apiKey, "anthropic-version": API_VERSION, ...(this.settings.headers ?? {}) },
      betas,
    );
    const grounded = request.webGrounding && !request.schema;

    let content: Block[] = [];
    let usage: Record<string, unknown> | undefined;
    let stopReason: string | null | undefined;
    let refusalCategory: string | null | undefined;
    for (let continuation = 0; ; continuation++) {
      // `pause_turn`: send the partial assistant turn back so Claude resumes it.
      const turn = messages.map((message) => ({ ...message, content: [...message.content] }));
      if (content.length) append(turn, "assistant", content);
      const response = await requestJson<ClaudeResponse>({
        fetch: this.settings.fetch,
        provider: this.name,
        url: joinUrl(this.baseUrl, "messages"),
        headers,
        body: { ...body, messages: turn },
        signal: request.signal,
      });
      if (!Array.isArray(response.content)) throw new ProviderError(this.name, "response has no content blocks");
      content = [...content, ...response.content.filter(isBlock)];
      usage = addUsage(usage, response.usage);
      stopReason = response.stop_reason;
      refusalCategory = response.stop_details?.category;
      if (stopReason !== "pause_turn" || continuation >= MAX_CONTINUATIONS) break;
    }

    const parts = toParts(content, grounded);
    if (!parts.length) {
      if (stopReason === "refusal") {
        const category = refusalCategory ? `, category "${refusalCategory}"` : "";
        throw new ProviderError(this.name, `the model refused to answer (stop_reason "refusal"${category})`);
      }
      throw new ProviderError(this.name, `empty response (stop_reason "${stopReason ?? "unknown"}")`);
    }
    const replay: ClaudeReplay = { content, stop_reason: stopReason ?? null };
    return {
      role: "assistant",
      content: parts,
      provider_metadata: { provider: this.name, model: request.model, ...(usage ? { usage } : {}), [this.name]: replay },
    };
  }

  private buildBody(
    request: CompletionRequest,
    messages: ClaudeMessage[],
    cache?: PromptCachePlan,
  ): { body: Record<string, unknown>; betas: string[] } {
    const model = request.model.toLowerCase();
    const betas: string[] = [];

    let reasoning = reasoningFor(model, request.effort);
    if (reasoning.budget !== undefined && toolLoopLacksThinking(messages)) reasoning = {};

    let maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    let thinking = reasoning.thinking;
    if (reasoning.budget !== undefined) {
      const fitted = fitBudget(model, maxTokens, reasoning.budget);
      maxTokens = fitted.maxTokens;
      thinking = { type: "enabled", budget_tokens: fitted.budget };
    } else if (bindsThinking(model) && replaysThinking(messages)) {
      // Odoo's edited history would otherwise make replayed blocks a 400 (see the header comment).
      thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
      betas.push(THINKING_BINDING_BETA);
    }

    const tools: Record<string, unknown>[] = (request.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.instructions ? { description: tool.instructions } : {}),
      input_schema: toolParameters(tool.schema),
    }));
    if (request.webGrounding) {
      tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5, ...objectOption(request.options, "web_search_tool") });
    }

    const outputConfig: Record<string, unknown> = {
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      ...(request.schema ? { format: { type: "json_schema", schema: outputSchema(request.schema) } } : {}),
    };

    const body = mergeOptions(
      {
        model: request.model,
        max_tokens: maxTokens,
        // A breakpoint on the (only) system block caches tools + system together.
        ...(request.instructions.trim()
          ? { system: cache ? [{ type: "text", text: request.instructions, cache_control: cache.control }] : request.instructions }
          : {}),
        messages,
        // One-shot loops only append: automatic caching follows the growing tail.
        ...(cache?.tail ? { cache_control: cache.control } : {}),
        ...(tools.length ? { tools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      },
      request.options,
      CLAUDE_OPTIONS,
      "completion",
    );
    return { body, betas };
  }
}
