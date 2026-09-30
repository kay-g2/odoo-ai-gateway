import { describe, expect, it } from "vitest";

import { applyCitations, sourceName, utf8OffsetToIndex, webSourceId } from "../../src/providers/citations.js";
import { isStrictCompatible, normalizeSchema, stripKeywords, toolParameters } from "../../src/providers/schema.js";
import { parseToolArguments, replayData } from "../../src/providers/parts.js";
import { buildVtt, cuesFromWords, isVtt, singleCueVtt, vttTimestamp } from "../../src/providers/vtt.js";

// The citation marker Odoo parses in a text part: [WEB_SOURCE:<lowercase hex id>] (docs/protocol.md).
const WEB_SOURCE_MARKER = /\[WEB_SOURCE:[a-f0-9]+\]/g;

describe("citations", () => {
  it("ids are lowercase hex, the alphabet of Odoo's citation markers", () => {
    expect(webSourceId("https://example.com/a")).toMatch(/^[a-f0-9]{12}$/);
    expect(webSourceId("https://example.com/a")).toBe(webSourceId("https://example.com/a"));
  });

  it("append mode puts markers after the supported span", () => {
    const text = "Odoo is an ERP. It is open source.";
    const out = applyCitations(text, [
      { start: 0, end: 15, url: "https://www.odoo.com/", title: "odoo.com" },
      { start: 16, end: 34, url: "https://github.com/odoo/odoo" },
      { start: 16, end: 34, url: "https://en.wikipedia.org/wiki/Odoo" },
    ], "append");
    const a = webSourceId("https://www.odoo.com/");
    const b = webSourceId("https://github.com/odoo/odoo");
    const c = webSourceId("https://en.wikipedia.org/wiki/Odoo");
    expect(out.text).toBe(`Odoo is an ERP.[WEB_SOURCE:${a}] It is open source.[WEB_SOURCE:${b}][WEB_SOURCE:${c}]`);
    expect(out.sources[a]).toEqual({ url: "https://www.odoo.com/", source_name: "odoo.com" });
    expect(out.sources[c]).toEqual({ url: "https://en.wikipedia.org/wiki/Odoo", source_name: "en.wikipedia.org" });
    expect([...out.text.matchAll(WEB_SOURCE_MARKER)]).toHaveLength(3);
  });

  it("replace mode swaps inline markdown citations for markers", () => {
    const text = "Paris is the capital ([wikipedia.org](https://en.wikipedia.org/wiki/Paris)).";
    const start = text.indexOf("[wikipedia");
    const end = text.indexOf(")", text.indexOf("](")) + 1;
    const out = applyCitations(text, [{ start, end, url: "https://en.wikipedia.org/wiki/Paris", title: "Paris" }], "replace");
    expect(out.text).toBe(`Paris is the capital[WEB_SOURCE:${webSourceId("https://en.wikipedia.org/wiki/Paris")}].`);
  });

  it("replace mode falls back to append for plain-text spans", () => {
    const out = applyCitations("Fact one.", [{ start: 0, end: 9, url: "https://a.com" }], "replace");
    expect(out.text).toBe(`Fact one.[WEB_SOURCE:${webSourceId("https://a.com")}]`);
  });

  it("ignores out-of-range spans", () => {
    expect(applyCitations("abc", [{ start: 2, end: 10, url: "https://a.com" }], "append")).toEqual({ text: "abc", sources: {} });
  });

  it("uses the title for Google grounding redirect URLs", () => {
    expect(sourceName("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC", "uefa.com")).toBe("uefa.com");
    expect(sourceName("https://www.example.com/x", "Example")).toBe("example.com");
  });

  it("converts UTF-8 byte offsets to string indices", () => {
    const text = "Café 🎉 ok";
    expect(utf8OffsetToIndex(text, 0)).toBe(0);
    expect(utf8OffsetToIndex(text, 5)).toBe(4); // "Café" is 5 bytes
    expect(utf8OffsetToIndex(text, 10)).toBe(7); // + " " + 4-byte emoji (2 code units)
    expect(utf8OffsetToIndex(text, 1000)).toBe(text.length);
  });
});

describe("schema helpers", () => {
  it("maps the ai_field fallback type 'text' to 'string'", () => {
    expect(normalizeSchema({ type: "object", properties: { value: { type: "text" }, n: { type: ["integer", "null"] } } })).toEqual({
      type: "object",
      properties: { value: { type: "string" }, n: { type: ["integer", "null"] } },
    });
  });

  it("tool parameters default to an empty object schema", () => {
    expect(toolParameters(null)).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("detects strict-compatible schemas", () => {
    expect(isStrictCompatible({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false })).toBe(true);
    expect(isStrictCompatible({ type: "object", properties: { a: { type: "string" } }, required: [] , additionalProperties: false })).toBe(false);
    expect(isStrictCompatible({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toBe(false);
  });

  it("strips keywords and closes objects", () => {
    expect(stripKeywords({ type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 } } }, ["minimum", "maximum"], { closeObjects: true })).toEqual({
      type: "object",
      properties: { n: { type: "integer" } },
      additionalProperties: false,
    });
  });
});

describe("parts helpers", () => {
  it("tool arguments always become an object", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("[1]")).toEqual({ __raw_arguments: "[1]" });
    expect(parseToolArguments("{broken")).toEqual({ __raw_arguments: "{broken" });
  });

  it("replay data is only used for the same provider", () => {
    const message = { role: "assistant" as const, content: [], provider_metadata: { provider: "openai", openai: { output: [1] } } };
    expect(replayData(message, "openai")).toEqual({ output: [1] });
    expect(replayData(message, "grok")).toBeUndefined();
    expect(replayData({ role: "assistant", content: [], provider_metadata: {} }, "openai")).toBeUndefined();
  });
});

describe("vtt", () => {
  it("formats timestamps and documents", () => {
    expect(vttTimestamp(3723.456)).toBe("01:02:03.456");
    const vtt = buildVtt(cuesFromWords([
      { text: "Hello", start: 0, end: 0.4 },
      { text: "world", start: 0.5, end: 0.9 },
      { text: ".", start: 0.9, end: 0.95 },
    ]));
    expect(vtt).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.950\nHello world.\n");
    expect(isVtt(vtt)).toBe(true);
    expect(isVtt(singleCueVtt("text"))).toBe(true);
  });
});
