import { describe, expect, it } from "vitest";

import { ProviderError, UnsupportedFeatureError } from "../../src/core/errors.js";
import type { AssistantMessage, OdooMessage } from "../../src/core/odoo-types.js";
import { ClaudeAdapter } from "../../src/providers/claude.js";
import { webSourceId } from "../../src/providers/citations.js";
import type { CompletionRequest, Effort, Feature, ProviderSettings } from "../../src/providers/types.js";
import { MockFetch } from "../helpers/mock-fetch.js";

function setup(settings: Partial<ProviderSettings> = {}) {
  const mock = new MockFetch();
  const adapter = new ClaudeAdapter({ apiKey: "test-key", fetch: mock.fetch, ...settings });
  return { mock, adapter };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "claude-opus-5-5",
    instructions: "You are Odoo AI.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    webGrounding: false,
    imageGeneration: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const USAGE = { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function message(content: unknown[], stopReason = "end_turn", usage: Record<string, unknown> = USAGE) {
  return {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

const textReply = (text: string) => message([{ type: "text", text }]);

const THINKING = { type: "thinking", thinking: "The user wants the partner record.", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds" };
const TOOL_USE = { type: "tool_use", id: "toolu_01A09q90qw90lq917835lq9", name: "search_partner", input: { name: "Azure Interior", limit: 5 } };

const WEB_URL = "https://www.odoo.com/blog/odoo-20";
const NEWS_URL = "https://example.org/news/odoo-ai";
const SERVER_TOOL_USE = { type: "server_tool_use", id: "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE", name: "web_search", input: { query: "odoo 20 release" } };
const SEARCH_RESULT = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
  content: [
    { type: "web_search_result", url: WEB_URL, title: "Odoo 20 is here", encrypted_content: "EqgfCioIARgBIiQ3YTAw", page_age: "September 1, 2026" },
    { type: "web_search_result", url: NEWS_URL, title: "Odoo AI news", encrypted_content: "EpQBCioIARgBIiQ4ZjEx", page_age: "September 2, 2026" },
  ],
};
const cite = (url: string, title: string, citedText: string) => ({
  type: "web_search_result_location",
  url,
  title,
  cited_text: citedText,
  encrypted_index: "Eo8BCioIAhgBIiQyYjQ0OGRmZi00OGRjLTRlYjAt",
});

/** Deep copy without `cache_control` markers, to compare replayed content with what was stored. */
function withoutCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item))) as T;
}

const CACHE = { type: "ephemeral" };

describe("ClaudeAdapter request", () => {
  it("posts to /messages with the Anthropic auth headers, system prompt and default max_tokens", async () => {
    const { mock, adapter } = setup({ headers: { "anthropic-beta": "test-beta" } });
    mock.reply(textReply("Hi!"));
    const signal = new AbortController().signal;

    await adapter.complete(request({ signal }));

    const call = mock.last;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe("test-key");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-beta"]).toBe("test-beta");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.signal).toBe(signal);
    // One-shot request (no <odoo_current_context>): system breakpoint + automatic tail caching.
    expect(call.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: [{ type: "text", text: "You are Odoo AI.", cache_control: CACHE }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      cache_control: CACHE,
    });
  });

  it("honours a custom base URL, omits an empty system prompt and merges options last", async () => {
    const { mock, adapter } = setup({ baseUrl: "https://proxy.example.com/anthropic/v1/" });
    mock.reply(textReply("ok"));

    // (Sampling params such as temperature are a 400 on Opus 5.5, so the example options avoid them.)
    await adapter.complete(
      request({ instructions: "  ", maxOutputTokens: 4096, options: { stop_sequences: ["</answer>"], metadata: { user_id: "odoo-db" } } }),
    );

    expect(mock.last.url).toBe("https://proxy.example.com/anthropic/v1/messages");
    expect(mock.last.body.system).toBeUndefined();
    expect(mock.last.body.max_tokens).toBe(4096);
    expect(mock.last.body.stop_sequences).toEqual(["</answer>"]);
    expect(mock.last.body.metadata).toEqual({ user_id: "odoo-db" });
  });

  it("translates user text, images, PDFs and text files without Odoo metadata", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("Seen."));
    const csv = Buffer.from("name,qty\nDesk,2\n").toString("base64");

    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe these files" },
              { type: "text", text: "   " },
              { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=", metadata: { attachment_id: 12, image_path: "/web/image/12" } },
              { type: "inline_data", mimetype: "image/jpeg", data: "/9j/4AAQ" },
              { type: "inline_data", mimetype: "application/pdf", data: "JVBERi0xLjQ=", metadata: { attachment_id: 13 } },
              { type: "inline_data", mimetype: "text/csv", data: csv },
              { type: "inline_data", mimetype: "image/bmp", data: "Qk0=" },
              { type: "inline_data", mimetype: "application/zip", data: "UEsDBA==" },
              { type: "text", text: "<odoo_current_context>record: sale.order,7</odoo_current_context>" },
            ],
          },
        ],
      }),
    );

    expect(mock.last.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe these files" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" } },
          { type: "document", source: { type: "text", media_type: "text/plain", data: "name,qty\nDesk,2\n" } },
          { type: "text", text: "[image image/bmp omitted: unsupported format]" },
          { type: "text", text: "[attachment application/zip omitted]" },
          { type: "text", text: "<odoo_current_context>record: sale.order,7</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
    expect(mock.last.rawBody).not.toContain("metadata");
  });

  it("sends Odoo tools as Claude tool definitions", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));

    await adapter.complete(
      request({
        tools: [
          {
            name: "search_partner",
            instructions: "Search partners by name.",
            schema: { type: "object", properties: { name: { type: "text" }, limit: { type: "int" } }, required: ["name"] },
          },
          { name: "get_current_user", instructions: "Return the current user.", schema: null },
        ],
      }),
    );

    expect(mock.last.body.tools).toEqual([
      {
        name: "search_partner",
        description: "Search partners by name.",
        input_schema: { type: "object", properties: { name: { type: "string" }, limit: { type: "integer" } }, required: ["name"] },
      },
      { name: "get_current_user", description: "Return the current user.", input_schema: { type: "object", properties: {}, required: [] } },
    ]);
  });
});

describe("ClaudeAdapter response", () => {
  it("returns text and tool calls, keeping the full content for replay", async () => {
    const { mock, adapter } = setup();
    const content = [THINKING, { type: "text", text: "Let me look that up." }, TOOL_USE];
    mock.reply(message(content, "tool_use"));

    const result = await adapter.complete(request({ effort: "high" }));

    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([
      { type: "text", text: "Let me look that up." },
      { type: "tool_call", name: "search_partner", args: { name: "Azure Interior", limit: 5 }, call_id: "toolu_01A09q90qw90lq917835lq9" },
    ]);
    expect(result.provider_metadata).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      usage: USAGE,
      claude: { content, stop_reason: "tool_use" },
    });
  });

  it("joins consecutive text blocks into one part and splits around tool calls", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      message(
        [
          { type: "text", text: "First " },
          { type: "text", text: "part." },
          { ...TOOL_USE, input: "not-an-object" },
          { type: "text", text: "After." },
        ],
        "tool_use",
      ),
    );

    const result = await adapter.complete(request());

    expect(result.content).toEqual([
      { type: "text", text: "First part." },
      { type: "tool_call", name: "search_partner", args: { __raw_arguments: "not-an-object" }, call_id: TOOL_USE.id },
      { type: "text", text: "After." },
    ]);
  });

  it("maps HTTP errors to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      { type: "error", error: { type: "invalid_request_error", message: "messages.0.content.0: unknown block type" }, request_id: "req_011CSHoEeqs5C35K2UUqR7Fy" },
      400,
    );

    const error = await adapter.complete(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).message).toContain("HTTP 400: messages.0.content.0: unknown block type");
  });

  it("maps a refusal without text and an empty answer to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply(message([], "refusal"));
    await expect(adapter.complete(request())).rejects.toThrow(/refused/);

    mock.reply({ ...message([], "refusal"), stop_details: { type: "refusal", category: "cyber", explanation: "..." } });
    await expect(adapter.complete(request())).rejects.toThrow(/refused to answer \(stop_reason "refusal", category "cyber"\)/);

    mock.reply(message([THINKING], "max_tokens"));
    await expect(adapter.complete(request())).rejects.toThrow(/empty response \(stop_reason "max_tokens"\)/);

    mock.reply({ type: "message", content: null });
    await expect(adapter.complete(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it("lets aborts propagate", async () => {
    const { mock, adapter } = setup();
    const controller = new AbortController();
    controller.abort();
    mock.reply(textReply("never"));

    await expect(adapter.complete(request({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ClaudeAdapter history", () => {
  it("replays its own assistant turn verbatim (thinking + signature) on the next turn", async () => {
    const { mock, adapter } = setup();
    const firstContent = [THINKING, { type: "text", text: "Let me look that up." }, TOOL_USE];
    mock.reply(message(firstContent, "tool_use"));
    const user: OdooMessage = { role: "user", content: [{ type: "text", text: "Find Azure Interior" }] };
    const assistant: AssistantMessage = await adapter.complete(request({ effort: "high", messages: [user] }));
    const call = assistant.content.find((part) => part.type === "tool_call");
    expect(call?.type).toBe("tool_call");

    mock.reply(textReply("Azure Interior is partner #3."));
    await adapter.complete(
      request({
        effort: "high",
        messages: [
          user,
          assistant,
          {
            role: "user",
            content: [
              { type: "text", text: "<odoo_current_context>none</odoo_current_context>" },
              {
                type: "tool_result",
                tool_name: "search_partner",
                tool_call_id: call?.type === "tool_call" ? call.call_id : "",
                result: [{ type: "text", text: '[{"id": 3, "name": "Azure Interior"}]' }],
                success: true,
              },
            ],
          },
        ],
      }),
    );

    const body = mock.last.body;
    expect(body.messages).toHaveLength(3);
    // Replayed verbatim; only a cache breakpoint is added on the last cacheable block of the stable
    // history (the message before the one carrying <odoo_current_context>), never on thinking.
    expect(withoutCache(body.messages[1])).toStrictEqual({ role: "assistant", content: firstContent });
    expect(body.messages[1].content.at(-1).cache_control).toEqual(CACHE);
    expect(body.messages[1].content.filter((block: { type: string; cache_control?: unknown }) => block.type === "thinking" && block.cache_control)).toEqual([]);
    expect(body).not.toHaveProperty("cache_control");
    expect(body.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_01A09q90qw90lq917835lq9",
        content: [{ type: "text", text: '[{"id": 3, "name": "Azure Interior"}]' }],
        is_error: false,
      },
      { type: "text", text: "<odoo_current_context>none</odoo_current_context>" },
    ]);
    // Replayed thinking on a preserved-thinking model: the API drops blocks Odoo's edits invalidated.
    expect(body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(mock.last.headers["anthropic-beta"]).toBe("thinking-binding-controls-2026-08-01");
    expect(body.output_config).toEqual({ effort: "high" });
  });

  /**
   * Odoo's own round shape (ai_session._submit_agent_request): every round re-appends a fresh
   * `<odoo_current_context>` (with the current time) to the last user message that has text, so the
   * message before the replayed thinking block differs from the one Claude saw. On accounts enforced
   * for preserved thinking that is a 400 unless the request asks the API to drop stale blocks.
   */
  it("asks the API to drop stale thinking blocks when Odoo rewrites the history (Opus 5.5, default effort)", async () => {
    const { mock, adapter } = setup({ headers: { "Anthropic-Beta": "some-other-beta-2026-01-01" } });
    const firstContent = [THINKING, TOOL_USE];
    mock.reply(message(firstContent, "tool_use"));
    const question = { type: "text" as const, text: "Find Azure Interior" };
    const context = (time: string) => ({ type: "text" as const, text: `<odoo_current_context>\n## Date\n2026-09-29 ${time} (UTC)</odoo_current_context>` });

    const assistant = await adapter.complete(request({ messages: [{ role: "user", content: [question, context("10:00:00")] }] }));
    expect(mock.last.body.thinking).toBeUndefined();
    expect(mock.last.headers["anthropic-beta"]).toBe("some-other-beta-2026-01-01");

    mock.reply(textReply("Azure Interior is partner #3."));
    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [question, context("10:00:07")] },
          assistant,
          {
            role: "user",
            content: [{ type: "tool_result", tool_name: "search_partner", tool_call_id: TOOL_USE.id, result: [{ type: "text", text: "[3]" }], success: true }],
          },
        ],
      }),
    );

    const call = mock.last;
    expect(call.body.messages[1]).toStrictEqual({ role: "assistant", content: firstContent });
    // Effort undefined: adaptive is Opus 5.5's default, so only block_binding is added; no effort.
    expect(call.body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(call.body.output_config).toBeUndefined();
    expect(call.headers["anthropic-beta"]).toBe("some-other-beta-2026-01-01,thinking-binding-controls-2026-08-01");
    expect(Object.keys(call.headers).filter((key) => key.toLowerCase() === "anthropic-beta")).toHaveLength(1);
  });

  it("does not add block_binding for models without conversation-bound thinking", async () => {
    const history = (model: string): OdooMessage[] => [
      { role: "user", content: [{ type: "text", text: "Find Azure Interior" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: TOOL_USE.name, args: TOOL_USE.input, call_id: TOOL_USE.id }],
        provider_metadata: { provider: "claude", model, claude: { content: [THINKING, TOOL_USE], stop_reason: "tool_use" } },
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_name: "search_partner", tool_call_id: TOOL_USE.id, result: [{ type: "text", text: "[3]" }], success: true }],
      },
    ];
    const { mock, adapter } = setup();
    mock.reply(textReply("ok")).reply(textReply("ok")).reply(textReply("ok"));

    // Opus 4.7: thinking is off by default and its blocks carry no conversation binding.
    await adapter.complete(request({ model: "claude-opus-4-7", messages: history("claude-opus-4-7") }));
    expect(mock.last.body.thinking).toBeUndefined();
    expect(mock.last.headers["anthropic-beta"]).toBeUndefined();

    await adapter.complete(request({ model: "claude-opus-4-7", effort: "high", messages: history("claude-opus-4-7") }));
    expect(mock.last.body.thinking).toEqual({ type: "adaptive" });
    expect(mock.last.headers["anthropic-beta"]).toBeUndefined();

    // Haiku 4.5 (manual budget): the loop opener starts with thinking, so the budget stays.
    await adapter.complete(request({ model: "claude-haiku-4-5", effort: "low", messages: history("claude-haiku-4-5") }));
    expect(mock.last.body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(mock.last.headers["anthropic-beta"]).toBeUndefined();
  });

  const crossProviderHistory = (): OdooMessage[] => [
    { role: "user", content: [{ type: "text", text: "Find Azure and its invoice" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=" },
        { type: "tool_call", name: "search_partner", args: { name: "Azure" }, call_id: 7 },
        { type: "tool_call", name: "get_invoice", args: {}, call_id: "call:abc/1" },
      ],
      provider_metadata: {},
    },
    {
      role: "user",
      content: [
        { type: "text", text: "<odoo_current_context>none</odoo_current_context>" },
        { type: "tool_result", tool_name: "search_partner", tool_call_id: 7, result: [{ type: "text", text: "[3]" }], success: true },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_name: "get_invoice",
          tool_call_id: "call:abc/1",
          result: [
            { type: "text", text: "Error: invoice not found" },
            { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=", metadata: { attachment_id: 9 } },
          ],
          success: false,
        },
      ],
    },
  ];

  it("rebuilds another provider's history with sanitized tool ids and merged user turns", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("Done."));

    await adapter.complete(request({ messages: crossProviderHistory() }));

    const invoiceId = mock.last.body.messages[1].content[2].id as string;
    expect(invoiceId).toMatch(/^call_abc_1_[0-9a-f]{8}$/);
    expect(mock.last.body.messages[1].content[2].cache_control).toEqual(CACHE);
    expect(withoutCache(mock.last.body.messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "Find Azure and its invoice" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "7", name: "search_partner", input: { name: "Azure" } },
          { type: "tool_use", id: invoiceId, name: "get_invoice", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "7", content: [{ type: "text", text: "[3]" }], is_error: false },
          {
            type: "tool_result",
            tool_use_id: invoiceId,
            content: [
              { type: "text", text: "Error: invoice not found" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
            is_error: true,
          },
          { type: "text", text: "<odoo_current_context>none</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("ignores replay data stored by another provider", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));
    const history = crossProviderHistory();
    (history[1] as AssistantMessage).provider_metadata = { provider: "openai", openai: { content: [{ type: "reasoning", id: "rs_1" }] } };

    await adapter.complete(request({ messages: history }));

    expect(mock.last.body.messages[1].content[0]).toEqual({ type: "text", text: "Searching." });
    expect(mock.last.rawBody).not.toContain("rs_1");
  });

  it("keeps distinct call ids distinct after sanitizing them", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));
    const ids = ["call:1", "call/1", "call_1"];

    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Run the three tools" }] },
          { role: "assistant", content: ids.map((id) => ({ type: "tool_call" as const, name: "noop", args: {}, call_id: id })), provider_metadata: {} },
          {
            role: "user",
            content: ids.map((id) => ({ type: "tool_result" as const, tool_name: "noop", tool_call_id: id, result: [], success: true })),
          },
        ],
      }),
    );

    const uses = (mock.last.body.messages[1].content as Array<{ id: string }>).map((block) => block.id);
    const results = (mock.last.body.messages[2].content as Array<{ tool_use_id: string }>).map((block) => block.tool_use_id);
    expect(new Set(uses).size).toBe(3);
    expect(uses[2]).toBe("call_1");
    expect(results).toEqual(uses);
    for (const id of uses) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("leaves manual (budget) thinking off while a tool loop opened without thinking blocks is pending", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok")).reply(textReply("ok")).reply(textReply("ok"));

    // Manual thinking requires the loop opener to start with a thinking block: it has none here.
    await adapter.complete(request({ model: "claude-sonnet-4-5", effort: "high", messages: crossProviderHistory() }));
    expect(mock.last.body.thinking).toBeUndefined();
    expect(mock.last.body.max_tokens).toBe(16000);

    // A new user question after the loop: budget thinking is allowed again.
    const history = [...crossProviderHistory(), { role: "assistant", content: [{ type: "text", text: "Done." }], provider_metadata: {} } as AssistantMessage];
    history.push({ role: "user", content: [{ type: "text", text: "Thanks, and now?" }] });
    await adapter.complete(request({ model: "claude-sonnet-4-5", effort: "high", messages: history }));
    expect(mock.last.body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  });

  it("keeps adaptive thinking on in a tool loop whose opener skipped thinking", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok")).reply(textReply("ok"));

    // Adaptive turns need not start with a thinking block; the configuration stays stable per loop.
    await adapter.complete(request({ model: "claude-opus-4-7", effort: "high", messages: crossProviderHistory() }));
    expect(mock.last.body.thinking).toEqual({ type: "adaptive" });
    expect(mock.last.body.output_config).toEqual({ effort: "high" });

    await adapter.complete(request({ model: "claude-opus-5-5", effort: "high", messages: crossProviderHistory() }));
    expect(mock.last.body.thinking).toEqual({ type: "adaptive" });
    expect(mock.last.headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("ClaudeAdapter effort", () => {
  const cases: Array<[string, Effort | undefined, Record<string, unknown> | undefined, Record<string, unknown> | undefined, number]> = [
    // Adaptive family: output_config.effort (+ adaptive thinking unless "none").
    ["claude-opus-5-5", undefined, undefined, undefined, 16000],
    ["claude-opus-5-5", "none", undefined, { effort: "low" }, 16000],
    ["claude-opus-5-5", "minimal", { type: "adaptive" }, { effort: "low" }, 16000],
    ["claude-opus-5-5", "low", { type: "adaptive" }, { effort: "low" }, 16000],
    ["claude-opus-5-5", "medium", { type: "adaptive" }, { effort: "medium" }, 16000],
    ["claude-opus-5-5", "xhigh", { type: "adaptive" }, { effort: "xhigh" }, 16000],
    ["claude-opus-5-5", "max", { type: "adaptive" }, { effort: "max" }, 16000],
    ["claude-sonnet-5-5", "high", { type: "adaptive" }, { effort: "high" }, 16000],
    ["claude-fable-5-1", "xhigh", { type: "adaptive" }, { effort: "xhigh" }, 16000],
    ["claude-opus-4-7", "xhigh", { type: "adaptive" }, { effort: "xhigh" }, 16000],
    ["claude-opus-4-6", "xhigh", { type: "adaptive" }, { effort: "high" }, 16000],
    ["claude-sonnet-4-6", "xhigh", { type: "adaptive" }, { effort: "high" }, 16000],
    ["claude-mythos-preview", "xhigh", { type: "adaptive" }, { effort: "high" }, 16000],
    ["claude-opus-7", "max", { type: "adaptive" }, { effort: "max" }, 16000],
    // Budget family: thinking.budget_tokens, no output_config.effort, max_tokens above the budget.
    ["claude-haiku-4-5", undefined, undefined, undefined, 16000],
    ["claude-haiku-4-5", "none", undefined, undefined, 16000],
    ["claude-haiku-4-5", "minimal", { type: "enabled", budget_tokens: 1024 }, undefined, 16000],
    ["claude-sonnet-4-5", "low", { type: "enabled", budget_tokens: 2048 }, undefined, 16000],
    ["claude-haiku-4-5-20251001", "medium", { type: "enabled", budget_tokens: 8192 }, undefined, 16384],
    ["claude-opus-4-5-20251101", "high", { type: "enabled", budget_tokens: 16384 }, undefined, 24576],
    ["claude-3-7-sonnet-20250219", "xhigh", { type: "enabled", budget_tokens: 24576 }, undefined, 32768],
    ["claude-haiku-4-5", "max", { type: "enabled", budget_tokens: 32000 }, undefined, 40192],
    // Opus 4.1 caps output at 32K: the budget shrinks to leave room for the answer.
    ["claude-opus-4-1-20250805", "max", { type: "enabled", budget_tokens: 23808 }, undefined, 32000],
    // Claude 3.5 has neither thinking nor effort.
    ["claude-3-5-haiku-20241022", "high", undefined, undefined, 16000],
  ];

  it.each(cases)("%s with effort %s", async (model, effort, thinking, outputConfig, maxTokens) => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));

    await adapter.complete(request({ model, ...(effort ? { effort } : {}) }));

    expect(mock.last.body.thinking).toEqual(thinking);
    expect(mock.last.body.output_config).toEqual(outputConfig);
    expect(mock.last.body.max_tokens).toBe(maxTokens);
  });

  it("keeps a configured max_tokens that already exceeds the thinking budget", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));

    await adapter.complete(request({ model: "claude-haiku-4-5", effort: "medium", maxOutputTokens: 64000 }));

    expect(mock.last.body.max_tokens).toBe(64000);
    expect(mock.last.body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });
});

describe("ClaudeAdapter structured output", () => {
  const aiFieldSchema = {
    type: "object",
    properties: {
      value: { type: "text" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      tags: { type: "array", items: { type: "string", maxLength: 30, pattern: "^[a-z]+$" }, minItems: 2, maxItems: 5 },
      contact: { type: "object", properties: { email: { type: "string", format: "email" } }, minItems: 1 },
      kind: { type: "string", enum: ["lead", "opportunity"] },
    },
    required: ["value"],
  };

  it("sends output_config.format with a Claude-compatible schema and returns the JSON text", async () => {
    const { mock, adapter } = setup();
    const json = '{"value":"Blue","confidence":0.9,"tags":["color","paint"],"kind":"lead"}';
    mock.reply(textReply(json));

    const result = await adapter.complete(
      request({
        schema: aiFieldSchema,
        effort: "medium",
        tools: [{ name: "lookup", instructions: "Look up a record.", schema: null }],
      }),
    );

    expect(mock.last.body.output_config).toEqual({
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            value: { type: "string" },
            confidence: { type: "number" },
            tags: { type: "array", items: { type: "string" } },
            contact: { type: "object", properties: { email: { type: "string" } }, minItems: 1, additionalProperties: false },
            kind: { type: "string", enum: ["lead", "opportunity"] },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });
    expect(mock.last.body.output_config.format.name).toBeUndefined();
    expect(mock.last.body.output_config.format.strict).toBeUndefined();
    expect(mock.last.body.tools).toHaveLength(1);
    expect(result.content).toEqual([{ type: "text", text: json }]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ value: "Blue" });
  });

  it("closes map-like objects and drops complex constraints Claude rejects (ai_field many2one shape)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply('{"value":7,"could_not_resolve":false,"unresolved_cause":null,"meta":{}}'));

    await adapter.complete(
      request({
        schema: {
          type: "object",
          properties: {
            value: { type: ["integer", "null"], enum: [3, 7, null], description: "The ID of the record" },
            could_not_resolve: { type: "boolean" },
            unresolved_cause: { type: ["string", "null"] },
            meta: { type: "object", additionalProperties: { type: "string" }, minProperties: 1 },
            labels: { type: "array", items: { type: "string" }, uniqueItems: true, contains: { const: "x" } },
          },
          required: ["value", "could_not_resolve", "unresolved_cause"],
          additionalProperties: true,
        },
      }),
    );

    expect(mock.last.body.output_config.format.schema).toEqual({
      type: "object",
      properties: {
        value: { type: ["integer", "null"], enum: [3, 7, null], description: "The ID of the record" },
        could_not_resolve: { type: "boolean" },
        unresolved_cause: { type: ["string", "null"] },
        meta: { type: "object", additionalProperties: false },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["value", "could_not_resolve", "unresolved_cause"],
      additionalProperties: false,
    });
  });
});

describe("ClaudeAdapter tool results and attachments", () => {
  it("never sends a whitespace-only text block inside a tool_result", async () => {
    const { mock, adapter } = setup();
    mock.reply(textReply("ok"));

    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Go" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_call", name: "a", args: {}, call_id: "call_a" },
              { type: "tool_call", name: "b", args: {}, call_id: "call_b" },
            ],
            provider_metadata: {},
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_name: "a", tool_call_id: "call_a", result: [{ type: "text", text: "  \n" }], success: true },
              { type: "tool_result", tool_name: "b", tool_call_id: "call_b", result: [{ type: "text", text: " " }], success: false },
            ],
          },
        ],
      }),
    );

    expect(mock.last.body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "success" }], is_error: false },
      { type: "tool_result", tool_use_id: "call_b", content: [{ type: "text", text: "Error" }], is_error: true },
    ]);
  });
});

describe("ClaudeAdapter web grounding", () => {
  it("adds the web search tool (options.web_search_tool merged) and turns citations into markers", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      message(
        [
          { type: "text", text: "I'll search for that." },
          SERVER_TOOL_USE,
          SEARCH_RESULT,
          { type: "text", text: "According to the official blog, " },
          { type: "text", text: "Odoo 20 was released in September 2026", citations: [cite(WEB_URL, "Odoo 20 is here", "Odoo 20 was released")] },
          {
            type: "text",
            text: " and it ships a new AI module",
            citations: [cite(NEWS_URL, "Odoo AI news", "a new AI module"), cite(WEB_URL, "Odoo 20 is here", "AI module")],
          },
          { type: "text", text: "." },
        ],
        "end_turn",
        { ...USAGE, server_tool_use: { web_search_requests: 1 } },
      ),
    );

    const result = await adapter.complete(
      request({
        webGrounding: true,
        options: { web_search_tool: { max_uses: 3, allowed_domains: ["odoo.com", "example.org"] }, metadata: { user_id: "odoo-db" } },
      }),
    );

    expect(mock.last.body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["odoo.com", "example.org"] },
    ]);
    expect(mock.last.body.web_search_tool).toBeUndefined();
    expect(mock.last.body.metadata).toEqual({ user_id: "odoo-db" });

    const blog = webSourceId(WEB_URL);
    const news = webSourceId(NEWS_URL);
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "I'll search for that.\n\nAccording to the official blog, Odoo 20 was released in September 2026" +
          `[WEB_SOURCE:${blog}] and it ships a new AI module[WEB_SOURCE:${news}][WEB_SOURCE:${blog}].`,
        sources: {
          [blog]: { url: WEB_URL, source_name: "odoo.com" },
          [news]: { url: NEWS_URL, source_name: "example.org" },
        },
      },
    ]);
    const replay = result.provider_metadata.claude as { content: unknown[] };
    expect(replay.content).toContainEqual(SEARCH_RESULT);
  });

  it("uses the default web search tool and no markers without web grounding", async () => {
    const { mock, adapter } = setup();
    mock.reply(message([{ type: "text", text: "Cited", citations: [cite(WEB_URL, "Odoo", "Cited")] }]));
    const plain = await adapter.complete(request());
    expect(plain.content).toEqual([{ type: "text", text: "Cited" }]);

    mock.reply(textReply("ok"));
    await adapter.complete(request({ webGrounding: true }));
    expect(mock.last.body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  });

  it("continues a pause_turn with the partial assistant turn and accumulates content and usage", async () => {
    const { mock, adapter } = setup();
    mock.reply(message([SERVER_TOOL_USE, SEARCH_RESULT], "pause_turn", { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } }));
    mock.reply(
      message([{ type: "text", text: "Odoo 20 is out.", citations: [cite(WEB_URL, "Odoo 20 is here", "Odoo 20")] }], "end_turn", {
        input_tokens: 150,
        output_tokens: 40,
        server_tool_use: { web_search_requests: 0 },
      }),
    );

    const result = await adapter.complete(request({ webGrounding: true }));

    expect(mock.calls).toHaveLength(2);
    const second = mock.calls[1]!.body;
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: "assistant", content: [SERVER_TOOL_USE, SEARCH_RESULT] });
    expect(mock.calls[0]!.body.messages).toHaveLength(1);
    expect(result.content).toEqual([
      { type: "text", text: `Odoo 20 is out.[WEB_SOURCE:${webSourceId(WEB_URL)}]`, sources: { [webSourceId(WEB_URL)]: { url: WEB_URL, source_name: "odoo.com" } } },
    ]);
    expect(result.provider_metadata.usage).toEqual({ input_tokens: 250, output_tokens: 60, server_tool_use: { web_search_requests: 1 } });
    expect((result.provider_metadata.claude as { content: unknown[]; stop_reason: string }).content).toHaveLength(3);
    expect((result.provider_metadata.claude as { stop_reason: string }).stop_reason).toBe("end_turn");
  });

  it("stops after 5 pause_turn continuations", async () => {
    const { mock, adapter } = setup();
    for (let i = 0; i < 6; i++) mock.reply(message([{ type: "text", text: `step ${i}. ` }], "pause_turn"));

    const result = await adapter.complete(request({ webGrounding: true }));

    expect(mock.calls).toHaveLength(6);
    expect(mock.pending).toBe(0);
    expect(result.content).toEqual([{ type: "text", text: "step 0. step 1. step 2. step 3. step 4. step 5. " }]);
  });
});

describe("ClaudeAdapter capabilities", () => {
  const adapter = new ClaudeAdapter({ apiKey: "test-key", fetch: new MockFetch().fetch });

  it.each<[Feature, boolean]>([
    ["completion", true],
    ["tools", true],
    ["schema", true],
    ["tools+schema", true],
    ["image_input", true],
    ["pdf_input", true],
    ["web_grounding", true],
    ["web_grounding+schema", false],
    ["image_generation", false],
    ["audio_input", false],
    ["embeddings", false],
    ["transcription", false],
    ["realtime", false],
  ])("supports(%s) = %s", (feature, expected) => {
    expect(adapter.supports(feature, "claude-opus-5-5")).toBe(expected);
  });

  it("reports no structured outputs on models without output_config.format", () => {
    expect(adapter.supports("schema", "claude-3-7-sonnet-20250219")).toBe(false);
    expect(adapter.supports("tools+schema", "claude-sonnet-4-20250514")).toBe(false);
    expect(adapter.supports("schema", "claude-haiku-4-5")).toBe(true);
    expect(adapter.supports("completion", "claude-3-7-sonnet-20250219")).toBe(true);
  });

  it("rejects embeddings, transcription and realtime without calling the network", async () => {
    const mock = new MockFetch();
    const claude = new ClaudeAdapter({ apiKey: "test-key", fetch: mock.fetch });
    const signal = new AbortController().signal;

    await expect(claude.embed({ model: "claude-opus-5-5", inputs: [{ content: "x" }], mode: "query", dimensions: 1536, signal })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
    await expect(claude.transcribe({ model: "claude-opus-5-5", audio: "AAAA", mimetype: "audio/mpeg", responseFormat: "vtt", signal })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
    await expect(claude.createRealtimeSession({ model: "claude-opus-5-5", signal })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("ClaudeAdapter conversation id", () => {
  it("is not sent: Claude's cache is keyed by content at the cache_control breakpoints", async () => {
    const { mock, adapter } = setup();
    mock.reply(message([{ type: "text", text: "ok" }]));
    await adapter.complete(request({ conversationId: "cv_AAAAAAAAAAAAAAAAAAAAAA" }));
    expect(JSON.stringify(mock.last.body)).not.toContain("cv_AAAAAAAAAAAAAAAAAAAAAA");
    expect(JSON.stringify(mock.last.headers)).not.toContain("cv_AAAAAAAAAAAAAAAAAAAAAA");
  });
});
