import { describe, expect, it } from "vitest";

import { InvalidRequestError } from "../../src/core/errors.js";
import {
  attachmentKind,
  canonicalMimetype,
  normalizeHistory,
  stripOdooContext,
  volatileMessageIndex,
} from "../../src/core/odoo-history.js";
import type { OdooMessage } from "../../src/core/odoo-types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const JPEG = "/9j/4AAQSkZJRgABAQ==";
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("normalizeHistory", () => {
  it("gives every attachment a canonical mimetype: lowercase, no parameters, aliases resolved", () => {
    const [message] = normalizeHistory([
      {
        role: "user",
        content: [
          { type: "inline_data", mimetype: "Application/PDF; name=invoice.pdf", data: "JVBERi0=" },
          { type: "inline_data", mimetype: "application/json; charset=utf-8", data: b64("{}") },
          { type: "inline_data", mimetype: "audio/mp3", data: "SUQz" },
          { type: "inline_data", mimetype: "audio/x-wav", data: "UklGR" },
          { type: "inline_data", mimetype: "image/jpg", data: "AAAA" },
          { type: "inline_data", data: "AAAA" },
        ],
      },
    ]);
    expect(message!.content.map((part) => (part.type === "inline_data" ? part.mimetype : part.type))).toEqual([
      "application/pdf",
      "application/json",
      "audio/mpeg",
      "audio/wav",
      "image/jpeg",
      "application/octet-stream",
    ]);
  });

  it("trusts image bytes over the declared type (Odoo re-encodes large images as PNG)", () => {
    const [message] = normalizeHistory([
      {
        role: "user",
        content: [
          { type: "inline_data", mimetype: "image/jpeg", data: PNG },
          { type: "inline_data", mimetype: "IMAGE/PNG", data: JPEG },
          { type: "inline_data", mimetype: "image/heic", data: "AAAA" },
        ],
      },
    ]);
    expect(message!.content).toEqual([
      { type: "inline_data", mimetype: "image/png", data: PNG },
      { type: "inline_data", mimetype: "image/jpeg", data: JPEG },
      { type: "inline_data", mimetype: "image/heic", data: "AAAA" },
    ]);
  });

  it("drops attachments without content everywhere (Odoo's `data: content or ''`)", () => {
    const history = normalizeHistory([
      { role: "user", content: [{ type: "text", text: "Look" }, { type: "inline_data", mimetype: "image/png", data: "" }, { type: "inline_data", mimetype: "image/png" }] },
      { role: "assistant", content: [{ type: "inline_data", mimetype: "image/png", data: "" }], provider_metadata: { provider: "openai" } },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_name: "t", tool_call_id: "c1", success: true, result: [{ type: "text", text: "ok" }, { type: "inline_data", mimetype: "image/png", data: "" }] },
        ],
      },
    ]);
    expect(history).toEqual([
      { role: "user", content: [{ type: "text", text: "Look" }] },
      { role: "assistant", content: [], provider_metadata: { provider: "openai" } },
      { role: "user", content: [{ type: "tool_result", tool_name: "t", tool_call_id: "c1", success: true, result: [{ type: "text", text: "ok" }] }] },
    ]);
  });

  it("removes Odoo's metadata and keeps provider replay data", () => {
    const [message] = normalizeHistory([
      {
        role: "assistant",
        content: [{ type: "inline_data", mimetype: "image/png", data: PNG, metadata: { aspect_ratio: "1:1" }, provider_data: { gemini: { thought_signature: "c2ln" } } }],
        provider_metadata: { provider: "gemini" },
      },
    ]);
    expect(message).toEqual({
      role: "assistant",
      content: [{ type: "inline_data", mimetype: "image/png", data: PNG, provider_data: { gemini: { thought_signature: "c2ln" } } }],
      provider_metadata: { provider: "gemini" },
    });
  });

  it("does not modify the request and keeps every message at its index", () => {
    const raw = [
      { role: "user", content: [{ type: "inline_data", mimetype: "image/jpg", data: PNG, metadata: { attachment_id: 5 } }] },
      { role: "user", content: [{ type: "inline_data", mimetype: "image/png", data: "" }] },
    ];
    const copy = structuredClone(raw);
    const history = normalizeHistory(raw);
    expect(raw).toEqual(copy);
    expect(history).toHaveLength(2);
    expect(history[1]!.content).toEqual([]);
  });

  it("rejects what is not an Odoo history", () => {
    expect(() => normalizeHistory({})).toThrow(InvalidRequestError);
    expect(() => normalizeHistory([{ role: "system", content: [] }])).toThrow(/messages\[0\]/);
    expect(() => normalizeHistory([{ role: "user", content: "hi" }])).toThrow(/messages\[0\]/);
  });
});

describe("attachmentKind", () => {
  it("is the one classification the router and the adapters share", () => {
    const kinds = Object.fromEntries(
      [
        "image/png",
        "image/bmp",
        "application/pdf",
        "text/csv",
        "application/json",
        "application/ld+json",
        "application/xml",
        "image/svg+xml",
        "audio/mpeg",
        "video/mp4",
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].map((type) => [type, attachmentKind(type)]),
    );
    expect(kinds).toEqual({
      "image/png": "image",
      "image/bmp": "image",
      "application/pdf": "pdf",
      "text/csv": "text",
      "application/json": "text",
      "application/ld+json": "text",
      "application/xml": "text",
      "image/svg+xml": "text",
      "audio/mpeg": "audio",
      "video/mp4": "file",
      "application/zip": "file",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "file",
    });
  });

  it("classifies raw mimetypes the same way as canonical ones", () => {
    expect(attachmentKind("Application/PDF; name=x.pdf")).toBe("pdf");
    expect(attachmentKind("image/svg+xml; charset=utf-8")).toBe("text");
    expect(canonicalMimetype(canonicalMimetype(" Image/JPG ; q=1"))).toBe("image/jpeg");
  });
});

describe("<odoo_current_context>", () => {
  const ctx = { type: "text" as const, text: "<odoo_current_context>\n## Date\n2026-09-30 10:00:00 (UTC)</odoo_current_context>" };

  it("finds the user message Odoo rewrites every round", () => {
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }, ctx] },
      { role: "assistant", content: [{ type: "text", text: "b" }], provider_metadata: {} },
      { role: "user", content: [{ type: "text", text: "c" }, ctx] },
      { role: "assistant", content: [{ type: "tool_call", name: "t", args: {}, call_id: "1" }], provider_metadata: {} },
      { role: "user", content: [{ type: "tool_result", tool_name: "t", tool_call_id: "1", success: true, result: [] }] },
    ];
    expect(volatileMessageIndex(history)).toBe(2);
    expect(volatileMessageIndex([{ role: "user", content: [{ type: "text", text: "one-shot" }] }])).toBe(-1);
  });

  it("strips the block from a prompt", () => {
    expect(stripOdooContext(`Draw a cat\n${ctx.text}`)).toBe("Draw a cat");
    expect(stripOdooContext(ctx.text)).toBe("");
  });
});
