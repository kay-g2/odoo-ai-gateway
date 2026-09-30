/**
 * Claude prompt caching, on histories shaped like Odoo's: agent chats rewrite the current turn's
 * user message every round (<odoo_current_context> with a timestamp), one-shot loops only append.
 */
import { describe, expect, it } from "vitest";

import type { OdooMessage } from "../../src/core/odoo-types.js";
import { ClaudeAdapter } from "../../src/providers/claude.js";
import { OpenRouterAdapter } from "../../src/providers/openrouter.js";
import { planPromptCache } from "../../src/providers/prompt-cache.js";
import type { CompletionRequest } from "../../src/providers/types.js";
import { MockFetch } from "../helpers/mock-fetch.js";

const CACHE = { type: "ephemeral" };
const ctx = (stamp: string) => ({ type: "text" as const, text: `<odoo_current_context>\n## Date\n${stamp} (UTC)</odoo_current_context>` });

/** Turn 1 finished; turn 2 in its second round (the model called a tool, Odoo ran it). */
function secondTurnHistory(stamp = "2026-09-29 18:54:52"): OdooMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "How many companies?" }] },
    { role: "assistant", content: [{ type: "text", text: "There are 2 companies." }], provider_metadata: {} },
    { role: "user", content: [{ type: "text", text: "And contacts?" }, ctx(stamp)] },
    { role: "assistant", content: [{ type: "tool_call", name: "search", args: { model: "res.partner" }, call_id: "c1" }], provider_metadata: {} },
    { role: "user", content: [{ type: "tool_result", tool_name: "search", tool_call_id: "c1", result: [{ type: "text", text: "60" }], success: true }] },
  ];
}

function request(model: string, messages: OdooMessage[], options?: Record<string, unknown>): CompletionRequest {
  return {
    model,
    instructions: "You are Odoo AI. ".repeat(50),
    messages,
    tools: [{ name: "search", instructions: "Search records", schema: null }],
    webGrounding: false,
    imageGeneration: false,
    ...(options ? { options } : {}),
    signal: new AbortController().signal,
  };
}

const claudeReply = { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} };
const openRouterReply = { id: "g", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} };

function markers(body: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "cache_control") found.push(path || "(top)");
        else walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(body, "");
  return found;
}

describe("planPromptCache", () => {
  it("agent chat: history ends right before the rewritten message, no tail caching", () => {
    expect(planPromptCache(secondTurnHistory(), undefined)).toEqual({ control: CACHE, historyEnd: 1, tail: false });
  });

  it("first turn of a chat: no stable history yet", () => {
    expect(planPromptCache([{ role: "user", content: [{ type: "text", text: "Hi" }, ctx("t")] }], undefined)).toEqual({ control: CACHE, historyEnd: -1, tail: false });
  });

  it("one-shot loop (no context marker): automatic tail caching", () => {
    expect(planPromptCache([{ role: "user", content: [{ type: "text", text: "Summarize" }] }], undefined)).toEqual({ control: CACHE, historyEnd: -1, tail: true });
  });

  it("options: false disables, '1h' switches the TTL", () => {
    expect(planPromptCache(secondTurnHistory(), false)).toBeUndefined();
    expect(planPromptCache(secondTurnHistory(), "1h")?.control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("ClaudeAdapter prompt caching", () => {
  const setup = () => {
    const mock = new MockFetch();
    return { mock, adapter: new ClaudeAdapter({ apiKey: "k", fetch: mock.fetch }) };
  };

  it("agent chat: caches tools+system and the previous turns; the rewritten tail is not cached", async () => {
    const { mock, adapter } = setup();
    mock.reply(claudeReply);
    await adapter.complete(request("claude-opus-5-5", secondTurnHistory()));
    const body = mock.last.body;
    expect(body.system).toEqual([{ type: "text", text: "You are Odoo AI. ".repeat(50), cache_control: CACHE }]);
    expect(markers(body)).toEqual(["system[0]", "messages[1].content[0]"]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "There are 2 companies.", cache_control: CACHE }] });
  });

  it("the cached prefix is byte-identical across rounds even though the timestamp changes", async () => {
    const { mock, adapter } = setup();
    mock.reply(claudeReply).reply(claudeReply);
    await adapter.complete(request("claude-opus-5-5", secondTurnHistory("2026-09-29 18:54:52")));
    await adapter.complete(request("claude-opus-5-5", secondTurnHistory("2026-09-29 18:55:10")));
    const [a, b] = mock.calls.map((call) => call.body);
    // Everything up to (and including) the last breakpoint renders the same.
    expect(JSON.stringify([a.tools, a.system, a.messages.slice(0, 2)])).toBe(JSON.stringify([b.tools, b.system, b.messages.slice(0, 2)]));
    expect(JSON.stringify(a.messages[2])).not.toBe(JSON.stringify(b.messages[2]));
  });

  it("one-shot loop: system breakpoint + top-level automatic caching", async () => {
    const { mock, adapter } = setup();
    mock.reply(claudeReply);
    await adapter.complete(request("claude-sonnet-5-5", [{ role: "user", content: [{ type: "text", text: "Summarize" }] }]));
    expect(markers(mock.last.body)).toEqual(["system[0]", "(top)"]);
  });

  it("prompt_cache: false sends no markers and the option never reaches the API; '1h' sets the TTL everywhere", async () => {
    const { mock, adapter } = setup();
    mock.reply(claudeReply).reply(claudeReply);
    await adapter.complete(request("claude-opus-5-5", secondTurnHistory(), { prompt_cache: false }));
    expect(markers(mock.calls[0]!.body)).toEqual([]);
    expect(mock.calls[0]!.body.system).toBe("You are Odoo AI. ".repeat(50));
    expect(mock.calls[0]!.body).not.toHaveProperty("prompt_cache");
    await adapter.complete(request("claude-opus-5-5", secondTurnHistory(), { prompt_cache: "1h" }));
    expect(mock.calls[1]!.body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(mock.calls[1]!.body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("OpenRouterAdapter prompt caching", () => {
  const setup = () => {
    const mock = new MockFetch();
    return { mock, adapter: new OpenRouterAdapter({ apiKey: "k", fetch: mock.fetch }) };
  };

  it("anthropic/* agent chat: system block + stable history breakpoint, no tail", async () => {
    const { mock, adapter } = setup();
    mock.reply(openRouterReply);
    await adapter.complete(request("anthropic/claude-sonnet-5.5", secondTurnHistory()));
    const body = mock.last.body;
    expect(body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "You are Odoo AI. ".repeat(50), cache_control: CACHE }] });
    expect(body.messages[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "There are 2 companies.", cache_control: CACHE }] });
    expect(markers(body)).toEqual(["messages[0].content[0]", "messages[2].content[0]"]);
  });

  it("anthropic/* one-shot loop: system block + top-level automatic caching", async () => {
    const { mock, adapter } = setup();
    mock.reply(openRouterReply);
    await adapter.complete(request("anthropic/claude-opus-5.5", [{ role: "user", content: [{ type: "text", text: "Summarize" }] }]));
    expect(markers(mock.last.body)).toEqual(["messages[0].content[0]", "(top)"]);
  });

  it("skips tool messages and tool-call-only assistant turns when placing the history breakpoint", async () => {
    const { mock, adapter } = setup();
    mock.reply(openRouterReply);
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Count contacts" }] },
      { role: "assistant", content: [{ type: "tool_call", name: "search", args: {}, call_id: "c0" }], provider_metadata: {} },
      { role: "user", content: [{ type: "tool_result", tool_name: "search", tool_call_id: "c0", result: [{ type: "text", text: "60" }], success: true }] },
      { role: "user", content: [{ type: "text", text: "Thanks, and companies?" }, ctx("t")] },
    ];
    await adapter.complete(request("anthropic/claude-sonnet-5.5", history));
    // Stable history ends with a tool message and a tool-call-only turn: the marker lands on the first user message.
    expect(markers(mock.last.body)).toEqual(["messages[0].content[0]", "messages[1].content[0]"]);
  });

  it("other vendors are left alone (they cache automatically)", async () => {
    const { mock, adapter } = setup();
    mock.reply(openRouterReply);
    await adapter.complete(request("openai/gpt-5.6-sol", secondTurnHistory(), { prompt_cache: "1h" }));
    expect(markers(mock.last.body)).toEqual([]);
    expect(mock.last.body.messages[0]).toEqual({ role: "system", content: "You are Odoo AI. ".repeat(50) });
    expect(mock.last.body).not.toHaveProperty("prompt_cache");
  });
});
