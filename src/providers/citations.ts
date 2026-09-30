/**
 * Web grounding output in the shape Odoo expects (ai/utils/ai_citation.py, `_ai_tool_web_search`):
 * the text carries `[WEB_SOURCE:<hex id>]` markers and the text part has
 * `sources: {<hex id>: {url, source_name}}`. Odoo keeps the sources in the session state and
 * `apply_web_citations` turns each marker into a link labelled with `source_name`.
 */
import { createHash } from "node:crypto";

import type { WebSource } from "../core/odoo-types.js";

export interface Citation {
  /** UTF-16 index (JavaScript string index) where the cited span starts. */
  start: number;
  /** UTF-16 index where the cited span ends (exclusive). */
  end: number;
  url: string;
  title?: string | undefined;
}

/**
 * "replace": the span is an inline citation the model wrote (OpenAI/xAI markdown links such as
 * `([example.com](https://...))`), replaced by the marker. Spans that do not look like a link
 * fall back to "append". "append": the span is the supported sentence (Gemini, Claude); the
 * marker goes right after it.
 */
export type CitationMode = "replace" | "append";

/** Stable lowercase-hex id (Odoo's regex is `[a-f0-9]+`). */
export function webSourceId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

const REDIRECT_HOSTS = new Set(["vertexaisearch.cloud.google.com"]);

/** Label shown by Odoo for the citation link: the site's domain. */
export function sourceName(url: string, title?: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (!REDIRECT_HOSTS.has(host)) return host;
  } catch {
    /* fall through */
  }
  return (title ?? "").trim() || url;
}

/** Convert a UTF-8 byte offset (Gemini grounding segments) into a JavaScript string index. */
export function utf8OffsetToIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes >= byteOffset) return index;
    const cp = char.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    index += char.length;
  }
  return index;
}

const LINK_LIKE = /\]\(|https?:\/\/|^\[\[?\d+\]?\]$/;

export interface CitedText {
  text: string;
  sources: Record<string, WebSource>;
}

export function applyCitations(text: string, citations: Citation[], mode: CitationMode): CitedText {
  const sources: Record<string, WebSource> = {};
  const valid = citations.filter(
    (c) => c.url && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 0 && c.end >= c.start && c.end <= text.length,
  );
  if (!valid.length) return { text, sources };

  // Group citations sharing a span so they become one `[WEB_SOURCE:a][WEB_SOURCE:b]` run.
  const groups = new Map<string, { start: number; end: number; ids: string[] }>();
  for (const citation of valid) {
    const id = webSourceId(citation.url);
    sources[id] = { url: citation.url, source_name: sourceName(citation.url, citation.title) };
    const key = `${citation.start}:${citation.end}`;
    const group = groups.get(key) ?? { start: citation.start, end: citation.end, ids: [] };
    if (!group.ids.includes(id)) group.ids.push(id);
    groups.set(key, group);
  }

  // Apply from the end so earlier indices stay valid. `floor` is the lowest index already
  // modified: a later (earlier-in-text) edit must end at or before it.
  const ordered = [...groups.values()].sort((a, b) => b.end - a.end || b.start - a.start);
  let out = text;
  let floor = text.length;
  for (const group of ordered) {
    if (group.end > floor) continue; // overlaps a span that was already replaced
    const marker = group.ids.map((id) => `[WEB_SOURCE:${id}]`).join("");
    const span = out.slice(group.start, group.end);
    const replace = mode === "replace" && group.end > group.start && LINK_LIKE.test(span);
    if (replace) {
      let start = group.start;
      let end = group.end;
      if (out[start - 1] === "(" && end < floor && out[end] === ")") {
        start -= 1;
        end += 1;
      }
      while (start > 0 && out[start - 1] === " ") start -= 1;
      out = `${out.slice(0, start)}${marker}${out.slice(end)}`;
      floor = start;
    } else {
      out = `${out.slice(0, group.end)}${marker}${out.slice(group.end)}`;
      floor = group.end;
    }
  }
  return { text: out, sources };
}
