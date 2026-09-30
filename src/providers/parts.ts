/** Helpers to read Odoo message parts when translating them to a provider format. */
import { canonicalMimetype } from "../core/odoo-history.js";
import type { AssistantMessage, InlineDataPart, OdooMessage, TextPart, ToolResultPart } from "../core/odoo-types.js";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/flac": "flac",
  "video/webm": "webm",
  "text/plain": "txt",
};

export function extensionFor(mimetype: string): string {
  const base = canonicalMimetype(mimetype);
  return EXTENSIONS[base] ?? base.split("/")[1]?.replace(/[^a-z0-9]/g, "") ?? "bin";
}

/**
 * Mimetype of audio to transcribe, as providers accept it ("audio/mp3" -> "audio/mpeg"). Browsers
 * record voice notes as `video/webm` (audio only).
 */
export function canonicalAudioMimetype(mimetype: string): string {
  const base = canonicalMimetype(mimetype);
  return base === "video/webm" ? "audio/webm" : base;
}

export function dataUrl(part: { mimetype: string; data: string }): string {
  return `data:${part.mimetype};base64,${part.data}`;
}

export function decodeBase64Text(data: string): string {
  return Buffer.from(data, "base64").toString("utf8");
}

/** `get_text_from_parts`-like join of text parts. */
export function textOf(parts: ReadonlyArray<{ type: string }>): string {
  return parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : JSON.stringify(part.text)))
    .join("\n");
}

/** Text of a tool result (Odoo already prefixes failures with "Error: ..."). */
export function toolResultText(part: ToolResultPart): string {
  const text = textOf(part.result ?? []);
  if (text) return text;
  return part.success === false ? "Error" : "success";
}

export function toolResultImages(part: ToolResultPart): InlineDataPart[] {
  return (part.result ?? []).filter((inner): inner is InlineDataPart => inner.type === "inline_data");
}

/**
 * Tool arguments must reach Odoo as an object (`tool_call['args'].keys()`). Invalid JSON is kept
 * under `__raw_arguments` so Odoo's parameter validation reports it back to the model.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return { __raw_arguments: raw };
}

/** Provider-specific replay data is only reused when the message came from the same provider. */
export function replayData<T = Record<string, unknown>>(message: OdooMessage, provider: string): T | undefined {
  if (message.role !== "assistant") return undefined;
  const meta = (message as AssistantMessage).provider_metadata;
  if (!meta || meta.provider !== provider) return undefined;
  return meta[provider] as T | undefined;
}

/** `call_id` as the string providers expect (Odoo's own tests use integers). */
export function callId(value: unknown): string {
  return String(value ?? "");
}

/**
 * Remove a Markdown code fence around a whole answer ("```json\n{...}\n```"), in linear time
 * (a regex with lazy groups goes quadratic on long unterminated fences of whitespace).
 * The language tag only counts when followed by whitespace, so "```true```" stays "true".
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 6 || !trimmed.startsWith("```") || !trimmed.endsWith("```")) return text;
  let inner = trimmed.slice(3, -3);
  const tag = /^[A-Za-z0-9_+-]*/.exec(inner)![0];
  if (tag && /^\s/.test(inner.slice(tag.length))) inner = inner.slice(tag.length);
  return inner.trim();
}
