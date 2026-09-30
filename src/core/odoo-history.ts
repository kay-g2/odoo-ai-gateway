/**
 * The Odoo history as the gateway reads it. `CompletionService.prepare` runs `normalizeHistory`
 * once on `params.messages`; the router and every adapter then read the same messages, so none of
 * them repeats Odoo's input quirks:
 *
 * - Every `inline_data` part (user content, tool results, generated images in assistant turns)
 *   has a canonical mimetype: lowercase, without parameters, aliases resolved (`image/jpg`,
 *   `audio/mp3`, `audio/x-wav`), and the real format when an image's bytes say otherwise (Odoo
 *   re-encodes images larger than 1024 px as PNG but keeps the attachment's original mimetype,
 *   `ir.attachment._ai_read`; providers check the declared type against the bytes).
 * - `inline_data` without content is dropped: Odoo sends `data: ''` for an empty image field
 *   (`data: content or ''`), and providers reject empty attachments.
 * - Odoo's `metadata` bookkeeping (attachment_id, image_path, aspect_ratio) is removed: it is
 *   never meant for a provider.
 *
 * `attachmentKind` is the one classification of an attachment, used by the router (which feature
 * the request needs) and by the adapters (how to send it). The `<odoo_current_context>` helpers
 * cover the block Odoo appends to the current turn on every round of an agent chat.
 */
import { InvalidRequestError } from "./errors.js";
import type { InlineDataPart, OdooMessage } from "./odoo-types.js";

/**
 * - `image`: raster images (providers differ in which formats they read);
 * - `pdf`;
 * - `text`: `text/*`, JSON, XML and SVG (XML text: no provider reads it as an image), sent as
 *   decoded text;
 * - `audio`;
 * - `file`: anything else (office documents, archives, video).
 */
export type AttachmentKind = "image" | "pdf" | "text" | "audio" | "file";

/** Non-standard spellings browsers and Odoo use, mapped to the names providers list. */
const MIMETYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
};

const TEXT_TYPES = new Set(["application/json", "application/xml"]);

const FALLBACK_MIMETYPE = "application/octet-stream";

/** Lowercase mimetype without parameters, aliases resolved. Idempotent. */
export function canonicalMimetype(mimetype: unknown): string {
  if (typeof mimetype !== "string") return FALLBACK_MIMETYPE;
  const base = mimetype.split(";")[0]!.trim().toLowerCase();
  if (!base) return FALLBACK_MIMETYPE;
  return MIMETYPE_ALIASES[base] ?? base;
}

export function attachmentKind(mimetype: string): AttachmentKind {
  const type = canonicalMimetype(mimetype);
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

/** Real image format from the base64 magic bytes (PNG, JPEG, GIF, WEBP), if recognizable. */
export function sniffImageMimetype(base64: string): string | undefined {
  const head = Buffer.from(base64.slice(0, 24), "base64").toString("latin1");
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The part as adapters may read it, or undefined when it has no content. */
function normalizeInline(part: InlineDataPart): InlineDataPart | undefined {
  if (typeof part.data !== "string" || !part.data) return undefined;
  const { metadata: _metadata, ...rest } = part;
  let mimetype = canonicalMimetype(part.mimetype);
  if (attachmentKind(mimetype) === "image") mimetype = sniffImageMimetype(part.data) ?? mimetype;
  return { ...rest, mimetype };
}

function normalizeParts<P extends { type: string }>(parts: readonly P[]): P[] {
  const out: P[] = [];
  for (const part of parts) {
    if (part.type === "inline_data") {
      const inline = normalizeInline(part as unknown as InlineDataPart);
      if (inline) out.push(inline as unknown as P);
    } else if (part.type === "tool_result") {
      const result = (part as { result?: unknown }).result;
      out.push({ ...part, result: normalizeParts(Array.isArray(result) ? result : []) });
    } else {
      out.push(part);
    }
  }
  return out;
}

/**
 * Validate `params.messages` and return the normalized copy described above (the input is not
 * modified). Messages keep their index, even when normalization leaves one without content.
 */
export function normalizeHistory(raw: unknown): OdooMessage[] {
  if (!Array.isArray(raw)) throw new InvalidRequestError("params.messages must be a list");
  return raw.map((message, index) => {
    if (!isPlainObject(message) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content)) {
      throw new InvalidRequestError(`params.messages[${index}] must be {role: "user"|"assistant", content: [...]}`);
    }
    const content = message.content.filter((part): part is { type: string } => isPlainObject(part) && typeof part.type === "string");
    return { ...message, content: normalizeParts(content) } as unknown as OdooMessage;
  });
}

/** Every attachment of the history, tool results included. */
export function attachmentsOf(messages: readonly OdooMessage[]): InlineDataPart[] {
  const out: InlineDataPart[] = [];
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "inline_data") out.push(part);
      if (part.type === "tool_result") for (const inner of part.result ?? []) if (inner.type === "inline_data") out.push(inner);
    }
  }
  return out;
}

export const ODOO_CONTEXT_MARKER = "<odoo_current_context>";

const ODOO_CONTEXT_BLOCK = /<odoo_current_context>[\s\S]*?<\/odoo_current_context>/g;

/**
 * Index of the user message Odoo rewrites every round, or -1. Agent chats
 * (`ai.session._submit_agent_request`) append `<odoo_current_context>`, with the current time, to
 * the current turn's user message on every round; one-shot loops never do.
 */
export function volatileMessageIndex(messages: readonly OdooMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const rewritten = message.content.some(
      (part) => part.type === "text" && typeof part.text === "string" && part.text.includes(ODOO_CONTEXT_MARKER),
    );
    if (rewritten) return index;
  }
  return -1;
}

/** The text without the `<odoo_current_context>` blocks, trimmed (for prompts that are not chats). */
export function stripOdooContext(text: string): string {
  return text.replace(ODOO_CONTEXT_BLOCK, "").trim();
}
