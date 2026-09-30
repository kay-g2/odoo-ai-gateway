import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/load.js";
import type { Entry, GatewayConfigInput } from "../../src/config/schema.js";
import { OPTION_DECLARATIONS } from "../../src/providers/index.js";
import { mergeOptions, passthroughOptions, values, type OptionDeclarations } from "../../src/providers/options.js";
import { README, withOptionsTable } from "../../scripts/options-table.js";
import { baseConfig } from "../helpers/gateway.js";

const DECLARED: OptionDeclarations = {
  tool: { operations: ["completion"], merge: "adapter", gatewayKey: true, value: values.object, doc: "" },
  config: { operations: ["completion", "transcription"], merge: "deep", value: values.object, doc: "" },
};

describe("mergeOptions", () => {
  const body = { model: "m", config: { a: 1, nested: { b: 2 } }, max_tokens: 100 };

  it("keeps adapter keys out of the body, deep-merges deep keys and copies the rest over the body", () => {
    const merged = mergeOptions(body, { tool: { x: 1 }, config: { nested: { c: 3 } }, temperature: 0.2, max_tokens: 50 }, DECLARED, "completion");
    expect(merged).toEqual({ model: "m", config: { a: 1, nested: { b: 2, c: 3 } }, max_tokens: 50, temperature: 0.2 });
  });

  it("removes a body field set to null", () => {
    expect(mergeOptions(body, { max_tokens: null, absent: null }, DECLARED, "completion")).toEqual({ model: "m", config: body.config });
  });

  it("applies a declared key only to its operations (a shared tier never leaks it elsewhere)", () => {
    expect(mergeOptions({ model: "m" }, { config: { a: 1 }, tool: {} }, DECLARED, "embeddings")).toEqual({ model: "m" });
  });

  it("does not modify the body it is given", () => {
    const copy = structuredClone(body);
    mergeOptions(body, { config: { a: 9 }, max_tokens: null }, DECLARED, "completion");
    expect(body).toEqual(copy);
  });

  it("passes only undeclared keys as extra form fields", () => {
    expect(passthroughOptions({ tool: {}, config: {}, diarize: true }, DECLARED)).toEqual({ diarize: true });
  });
});

describe("options at config load", () => {
  const withDefault = (entry: Record<string, unknown>): GatewayConfigInput => ({ ...baseConfig(), routing: { ...baseConfig().routing!, default: entry as Entry } });

  it("accepts documented values and any undeclared provider field", () => {
    expect(() =>
      parseConfig(withDefault({ provider: "claude", model: "claude-opus-5-5", options: { prompt_cache: "1h", web_search_tool: { max_uses: 3 }, temperature: 0.2 } })),
    ).not.toThrow();
    // `reasoning` is an OpenRouter option but also a real OpenAI Responses field: passed through.
    expect(() => parseConfig(withDefault({ provider: "openai", model: "gpt-5.6", options: { reasoning: { summary: "auto" }, prompt_cache_key: false } }))).not.toThrow();
  });

  it("rejects a wrong value with the entry's path and what was expected", () => {
    expect(() => parseConfig(withDefault({ provider: "claude", model: "claude-opus-5-5", options: { prompt_cache: "1hr" } }))).toThrow(
      'routing.default.options.prompt_cache: expected true or false or "5m" or "1h", got "1hr"',
    );
    expect(() => parseConfig(withDefault({ provider: "openrouter", model: "x/y", options: { session_id: 42 } }))).toThrow(
      "routing.default.options.session_id: expected a string or false, got 42",
    );
  });

  it("rejects a gateway key on a provider that does not read it", () => {
    expect(() => parseConfig(withDefault({ provider: "openai", model: "gpt-5.6", options: { prompt_cache: "1h" } }))).toThrow(
      "routing.default.options.prompt_cache: not an option of openai (only claude, openrouter read it)",
    );
    expect(() => parseConfig(withDefault({ provider: "openai", model: "gpt-5.6", options: { embedding_prompt: true } }))).toThrow(/only gemini read it/);
  });

  it("checks tiers and additional embedding models too, and lists every problem at once", () => {
    const config = baseConfig({
      tiers: [{ name: "fast", provider: "grok", model: "grok-4.6", options: { x_search_tool: "yes" } }],
      embeddings: { additional: [{ provider: "gemini", model: "gemini-embedding-001", options: { embedContentConfig: "RETRIEVAL" } }] },
    });
    config.routing = { ...config.routing!, default: "fast", usages: {} };
    expect(() => parseConfig(config)).toThrow(
      /tiers\.fast\.options\.x_search_tool: expected true or false or an object[\s\S]*embeddings\.additional\.0\.options\.embedContentConfig: expected an object/,
    );
  });
});

describe("README options table", () => {
  it("matches the declarations (run `npm run docs:options` after changing them)", () => {
    const readme = readFileSync(README, "utf8");
    expect(withOptionsTable(readme)).toBe(readme);
  });

  it("covers every declared key", () => {
    const readme = readFileSync(README, "utf8");
    for (const [provider, declarations] of Object.entries(OPTION_DECLARATIONS)) {
      for (const key of Object.keys(declarations)) expect(readme).toContain(`| ${provider} | \`${key}\` |`);
    }
  });
});
