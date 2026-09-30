import { describe, expect, it } from "vitest";

import { ProviderError } from "../../src/core/errors.js";
import type { AssistantMessage, OdooMessage } from "../../src/core/odoo-types.js";
import { webSourceId } from "../../src/providers/citations.js";
import { OpenAIAdapter } from "../../src/providers/openai.js";
import { clampEffort } from "../../src/providers/openai-responses.js";
import type { CompletionRequest, Effort, Feature } from "../../src/providers/types.js";
import { MockFetch, textResponse } from "../helpers/mock-fetch.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4 fake").toString("base64");
/** RIFF/WEBP header bytes, enough for format detection. */
const WEBP = Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00/\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00", "latin1").toString("base64");

function setup(settings: { baseUrl?: string; headers?: Record<string, string> } = {}) {
  const mock = new MockFetch();
  const adapter = new OpenAIAdapter({ apiKey: "test-key", fetch: mock.fetch, ...settings });
  return { mock, adapter };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "gpt-5.6",
    instructions: "You are Odoo's AI assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    webGrounding: false,
    imageGeneration: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function textResponseBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.6-2026-07-01",
    output: [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA-enc-1" },
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 81, output_tokens: 35, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 116 },
    ...extra,
  };
}

const TOOL_CALL_RESPONSE = {
  id: "resp_tool",
  object: "response",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_tool", summary: [], encrypted_content: "gAAAA-enc-tool" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_abc",
      name: "search_partner",
      arguments: '{"name":"Azure Interior","limit":5}',
      status: "completed",
    },
  ],
  usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
};

describe("OpenAIAdapter.complete: request", () => {
  it("posts to /v1/responses with bearer auth and extra headers", async () => {
    const { mock, adapter } = setup({ headers: { "OpenAI-Organization": "org-123" } });
    mock.reply(textResponseBody("Hi!"));
    await adapter.complete(request());
    expect(mock.last.url).toBe("https://api.openai.com/v1/responses");
    expect(mock.last.method).toBe("POST");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["openai-organization"]).toBe("org-123");
    expect(mock.last.headers["content-type"]).toBe("application/json");
  });

  it("honours a custom base URL", async () => {
    const { mock, adapter } = setup({ baseUrl: "https://proxy.example.com/v1/" });
    mock.reply(textResponseBody("Hi!"));
    await adapter.complete(request());
    expect(mock.last.url).toBe("https://proxy.example.com/v1/responses");
  });

  it("maps instructions, text, images, PDFs and text files, dropping Odoo metadata", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("Done"));
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize these" },
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 42, image_path: "/web/image/42" } },
              { type: "inline_data", mimetype: "application/pdf", data: PDF, metadata: { attachment_id: 43 } },
              { type: "inline_data", mimetype: "text/plain", data: Buffer.from("plain notes").toString("base64") },
              { type: "inline_data", mimetype: "application/msword", data: "AAAA" },
              { type: "text", text: "<odoo_current_context>model: res.partner</odoo_current_context>" },
            ],
          },
        ],
      }),
    );
    const body = mock.last.body;
    expect(body.model).toBe("gpt-5.6");
    expect(body.instructions).toBe("You are Odoo's AI assistant.");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Summarize these" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
          { type: "input_file", filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF}` },
          { type: "input_text", text: "plain notes" },
          { type: "input_file", filename: "file.doc", file_data: "data:application/msword;base64,AAAA" },
          { type: "input_text", text: "<odoo_current_context>model: res.partner</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
    expect(mock.last.rawBody).not.toContain("metadata");
    expect(body.tools).toBeUndefined();
    expect(body.text).toBeUndefined();
  });

  it("sends only image formats vision accepts, SVG as text, and office files with real extensions", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "inline_data", mimetype: "image/jpeg", data: "/9j/AAAA" },
              { type: "inline_data", mimetype: "image/webp", data: WEBP },
              { type: "inline_data", mimetype: "image/svg+xml", data: Buffer.from(svg).toString("base64") },
              { type: "inline_data", mimetype: "image/bmp", data: "Qk0AAAA=" },
              { type: "inline_data", mimetype: docx, data: "UEsDBA==" },
              { type: "inline_data", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: "UEsDBA==" },
            ],
          },
        ],
      }),
    );
    expect(mock.last.body.input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/jpeg;base64,/9j/AAAA", detail: "auto" },
      { type: "input_image", image_url: `data:image/webp;base64,${WEBP}`, detail: "auto" },
      { type: "input_text", text: svg },
      { type: "input_text", text: "[Attached image/bmp image omitted: openai only reads image/png, image/jpeg, image/webp, image/gif images]" },
      { type: "input_file", filename: "file.docx", file_data: `data:${docx};base64,UEsDBA==` },
      {
        type: "input_file",
        filename: "file.xlsx",
        file_data: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==",
      },
    ]);
  });

  it("omits empty instructions", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("Hi"));
    await adapter.complete(request({ instructions: "" }));
    expect(mock.last.body).not.toHaveProperty("instructions");
  });

  it("declares function tools (null schema -> empty object schema)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        tools: [
          { name: "get_time", instructions: "Current server time", schema: null },
          {
            name: "search_partner",
            instructions: "Search partners by name",
            schema: { type: "object", properties: { name: { type: "text" }, limit: { type: "integer" } }, required: ["name"] },
          },
        ],
      }),
    );
    const body = mock.last.body;
    expect(body.tools).toEqual([
      { type: "function", name: "get_time", description: "Current server time", parameters: { type: "object", properties: {}, required: [] }, strict: false },
      {
        type: "function",
        name: "search_partner",
        description: "Search partners by name",
        parameters: { type: "object", properties: { name: { type: "string" }, limit: { type: "integer" } }, required: ["name"] },
        strict: false,
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("maps maxOutputTokens and merges options except the special tool keys", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        maxOutputTokens: 4096,
        webGrounding: true,
        options: { service_tier: "flex", web_search_tool: { search_context_size: "low" }, image_generation_tool: { quality: "high" } },
      }),
    );
    const body = mock.last.body;
    expect(body.max_output_tokens).toBe(4096);
    expect(body.service_tier).toBe("flex");
    expect(body).not.toHaveProperty("web_search_tool");
    expect(body).not.toHaveProperty("image_generation_tool");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
  });
});

describe("OpenAIAdapter.complete: tool loop", () => {
  it("parses a function call into a tool_call part with replay data", async () => {
    const { mock, adapter } = setup();
    mock.reply(TOOL_CALL_RESPONSE);
    const result = await adapter.complete(request({ tools: [{ name: "search_partner", instructions: "Search", schema: null }] }));
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "tool_call", name: "search_partner", args: { name: "Azure Interior", limit: 5 }, call_id: "call_abc" }]);
    expect(result.provider_metadata.provider).toBe("openai");
    expect(result.provider_metadata.usage).toEqual(TOOL_CALL_RESPONSE.usage);
    expect(result.provider_metadata.openai).toEqual({ output: TOOL_CALL_RESPONSE.output, response_id: "resp_tool" });
  });

  it("keeps invalid tool arguments under __raw_arguments", async () => {
    const { mock, adapter } = setup();
    mock.reply({ ...TOOL_CALL_RESPONSE, output: [{ type: "function_call", call_id: "call_x", name: "f", arguments: "{oops" }] });
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "tool_call", name: "f", args: { __raw_arguments: "{oops" }, call_id: "call_x" }]);
  });

  it("replays the previous output items verbatim on the next turn (same provider)", async () => {
    const { mock, adapter } = setup();
    mock.reply(TOOL_CALL_RESPONSE);
    const first = await adapter.complete(request());
    // Odoo stores the assistant message verbatim (the service adds provider/model) and sends it back.
    const stored: AssistantMessage = JSON.parse(JSON.stringify({ ...first, provider_metadata: { ...first.provider_metadata, model: "gpt-5.6" } }));
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Find Azure Interior" }] },
      stored,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_name: "search_partner", tool_call_id: "call_abc", result: [{ type: "text", text: '[{"id": 14}]' }], success: true },
          { type: "text", text: "<odoo_current_context>res.partner</odoo_current_context>" },
        ],
      },
    ];
    mock.reply(textResponseBody("Azure Interior has id 14."));
    const second = await adapter.complete(request({ messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Find Azure Interior" }] },
      TOOL_CALL_RESPONSE.output[0],
      TOOL_CALL_RESPONSE.output[1],
      { type: "function_call_output", call_id: "call_abc", output: '[{"id": 14}]' },
      { role: "user", content: [{ type: "input_text", text: "<odoo_current_context>res.partner</odoo_current_context>" }] },
    ]);
    expect(mock.last.body.include).toEqual(["reasoning.encrypted_content"]);
    expect(second.content).toEqual([{ type: "text", text: "Azure Interior has id 14." }]);
  });

  it("rebuilds cross-provider history (numeric call ids, tool result images, failures)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("Here is the chart."));
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Plot sales" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_call", name: "render_chart", args: { period: "2026-Q3" }, call_id: 7 },
          { type: "tool_call", name: "missing_tool", args: {}, call_id: 8 },
        ],
        provider_metadata: {},
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_name: "render_chart",
            tool_call_id: 7,
            result: [
              { type: "text", text: "chart rendered" },
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 9 } },
            ],
            success: true,
          },
          { type: "tool_result", tool_name: "missing_tool", tool_call_id: 8, result: [{ type: "text", text: "Error: unknown tool" }], success: false },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier Claude answer" }],
        provider_metadata: { provider: "claude", claude: { content: [{ type: "thinking", signature: "sig" }] } },
      },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ];
    await adapter.complete(request({ messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Plot sales" }] },
      { role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "7", name: "render_chart", arguments: '{"period":"2026-Q3"}' },
      { type: "function_call", call_id: "8", name: "missing_tool", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "7",
        output: [
          { type: "input_text", text: "chart rendered" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
        ],
      },
      { type: "function_call_output", call_id: "8", output: "Error: unknown tool" },
      { role: "assistant", content: "Earlier Claude answer" },
      { role: "user", content: [{ type: "input_text", text: "Thanks" }] },
    ]);
    expect(mock.last.rawBody).not.toContain("signature");
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("rebuilds reasoning history without item ids when the model has no reasoning", async () => {
    // Replaying `fc_1` without its reasoning item `rs_tool` is rejected ("provided without its
    // required 'reasoning' item"), and encrypted reasoning is rejected by non-reasoning models.
    const { mock, adapter } = setup();
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "search_partner", args: { name: "Azure Interior", limit: 5 }, call_id: "call_abc" }],
        provider_metadata: { provider: "openai", openai: { output: TOOL_CALL_RESPONSE.output } },
      },
      { role: "user", content: [{ type: "tool_result", tool_name: "search_partner", tool_call_id: "call_abc", result: [], success: true }] },
    ];
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ model: "gpt-4.1", messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { type: "function_call", call_id: "call_abc", name: "search_partner", arguments: '{"name":"Azure Interior","limit":5}' },
      { type: "function_call_output", call_id: "call_abc", output: "success" },
    ]);
    expect(mock.last.rawBody).not.toContain("gAAAA-enc-tool");
    expect(mock.last.rawBody).not.toContain("fc_1");
    expect(mock.last.body).not.toHaveProperty("include");
  });

  it("rebuilds from the parts when the stored items no longer match the tool calls", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "Edited by Odoo" }],
            provider_metadata: { provider: "openai", openai: { output: TOOL_CALL_RESPONSE.output } },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Stored nothing" }],
            provider_metadata: { provider: "openai", openai: { output: [] } },
          },
          { role: "user", content: [{ type: "text", text: "Next" }] },
        ],
      }),
    );
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { role: "assistant", content: "Edited by Odoo" },
      { role: "assistant", content: "Stored nothing" },
      { role: "user", content: [{ type: "input_text", text: "Next" }] },
    ]);
  });

  it("shortens call ids longer than 64 chars identically for the call and its output", async () => {
    // Gemini-minted ids look like `call_<n>_<tool name>_<hex>` and can exceed the 64-char limit.
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    const longId = `call_0_${"x".repeat(60)}_1a2b3c4d`;
    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Go" }] },
          {
            role: "assistant",
            content: [{ type: "tool_call", name: "search", args: '{"q":"desk"}' as unknown as Record<string, unknown>, call_id: longId }],
            provider_metadata: { provider: "gemini", gemini: {} },
          },
          { role: "user", content: [{ type: "tool_result", tool_name: "search", tool_call_id: longId, result: [{ type: "text", text: "1 desk" }], success: true }] },
        ],
      }),
    );
    const [, call, output] = mock.last.body.input;
    expect(call.call_id).toMatch(/^call_[0-9a-f]{40}$/);
    expect(output.call_id).toBe(call.call_id);
    // String arguments from another provider are sent as one JSON object, not a JSON-encoded string.
    expect(call.arguments).toBe('{"q":"desk"}');
  });
});

describe("OpenAIAdapter.complete: reasoning effort", () => {
  const cases: Array<[string, Effort | undefined, string | undefined]> = [
    ["gpt-5.6", "max", "max"],
    ["gpt-5.6-sol", "minimal", "low"],
    ["gpt-5.6-luna", "none", "none"],
    ["gpt-5.5", "none", "none"],
    ["gpt-5.5", "max", "xhigh"],
    ["gpt-6-astra", "none", "low"],
    ["gpt-6-sol", "minimal", "low"],
    ["gpt-6-luna", "none", "none"],
    ["gpt-6-sol", "max", "max"],
    ["gpt-5.4", "max", "xhigh"],
    ["gpt-5.4-mini", "minimal", "low"],
    ["gpt-5.1", "xhigh", "high"],
    ["gpt-5.2-codex", "none", "none"],
    ["gpt-5.3", "max", "high"],
    ["gpt-5", "none", "minimal"],
    ["gpt-5-mini", "max", "high"],
    ["gpt-5-nano", "medium", "medium"],
    ["gpt-5-pro", "medium", "high"],
    ["gpt-5-codex", "minimal", "low"],
    ["o3", "none", "low"],
    ["o4-mini", "xhigh", "high"],
    ["gpt-5.9-preview", "xhigh", "xhigh"],
    ["gpt-4.1", "high", undefined],
    ["gpt-4o-mini", "low", undefined],
    ["chatgpt-4o-latest", "low", undefined],
    ["gpt-5-chat-latest", "high", undefined],
    ["gpt-5.6", undefined, undefined],
  ];

  for (const [model, effort, expected] of cases) {
    it(`${model} + ${effort ?? "no effort"} -> ${expected ?? "omitted"}`, async () => {
      const { mock, adapter } = setup();
      mock.reply(textResponseBody("ok"));
      await adapter.complete(request({ model, ...(effort ? { effort } : {}) }));
      if (expected === undefined) expect(mock.last.body).not.toHaveProperty("reasoning");
      else expect(mock.last.body.reasoning).toEqual({ effort: expected });
    });
  }

  it("sends the encrypted reasoning include only to reasoning models", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok")).reply(textResponseBody("ok"));
    await adapter.complete(request({ model: "o3" }));
    expect(mock.last.body.include).toEqual(["reasoning.encrypted_content"]);
    await adapter.complete(request({ model: "gpt-4o" }));
    expect(mock.last.body).not.toHaveProperty("include");
  });

  it("raises gpt-5 minimal effort to low when web search is on", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ model: "gpt-5", effort: "minimal", webGrounding: true }));
    expect(mock.last.body.reasoning).toEqual({ effort: "low" });
  });

  it("clampEffort picks the nearest level, ties going up", () => {
    expect(clampEffort("medium", ["low", "high"])).toBe("high");
    expect(clampEffort("minimal", ["none", "low"])).toBe("low");
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("none", ["minimal", "low"])).toBe("minimal");
  });
});

describe("OpenAIAdapter.complete: structured output", () => {
  const AI_FIELD_SCHEMA = {
    type: "object",
    properties: { value: { type: "text" } },
    required: ["value"],
    additionalProperties: false,
  };

  it("sends a strict json_schema format and returns the JSON text", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody('{"value":"Azure Interior"}'));
    const result = await adapter.complete(request({ schema: AI_FIELD_SCHEMA }));
    expect(mock.last.body.text).toEqual({
      format: {
        type: "json_schema",
        name: "response",
        strict: true,
        schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      },
    });
    expect(result.content).toEqual([{ type: "text", text: '{"value":"Azure Interior"}' }]);
  });

  it("falls back to non-strict mode for schemas strict mode rejects", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody('{"a":1}'));
    await adapter.complete(request({ schema: { type: "object", properties: { a: { type: "integer" }, b: { type: "string" } }, required: ["a"] } }));
    expect(mock.last.body.text.format.strict).toBe(false);
  });

  it("does not insert citation markers into JSON when web grounding is on", async () => {
    const { mock, adapter } = setup();
    const json = '{"value":"Odoo 20"}';
    const body = textResponseBody(json);
    (body.output[1] as any).content[0].annotations = [{ type: "url_citation", url: "https://www.odoo.com", title: "Odoo", start_index: 0, end_index: 5 }];
    mock.reply(body);
    const result = await adapter.complete(request({ schema: AI_FIELD_SCHEMA, webGrounding: true }));
    expect(result.content).toEqual([{ type: "text", text: json }]);
    expect(mock.last.body.tools).toEqual([{ type: "web_search" }]);
  });

  it("reports a truncated structured answer with the incomplete reason", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody('{"value":"Azure Inte', { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    await expect(adapter.complete(request({ schema: AI_FIELD_SCHEMA }))).rejects.toThrow(/incomplete \(max_output_tokens\).*cut off/);
  });

  it("turns a structured-output refusal into a ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({
      id: "resp_r",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    });
    await expect(adapter.complete(request({ schema: AI_FIELD_SCHEMA }))).rejects.toThrow(/refused.*can't help/);
  });

  it("returns a refusal as text without a schema", async () => {
    const { mock, adapter } = setup();
    mock.reply({
      id: "resp_r",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    });
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "text", text: "I can't help with that." }]);
  });
});

describe("OpenAIAdapter.complete: web grounding", () => {
  it("adds the web_search tool and turns url_citation annotations into WEB_SOURCE markers", async () => {
    const { mock, adapter } = setup();
    const link1 = "[odoo.com](https://www.odoo.com/blog/odoo-20?utm_source=openai)";
    const link2 = "[wikipedia.org](https://en.wikipedia.org/wiki/Odoo?utm_source=openai)";
    const text = `Odoo 20 was released in October 2026 (${link1}). Odoo is an ERP suite (${link2}).`;
    const start1 = text.indexOf(link1);
    const start2 = text.indexOf(link2);
    const url1 = "https://www.odoo.com/blog/odoo-20?utm_source=openai";
    const url2 = "https://en.wikipedia.org/wiki/Odoo?utm_source=openai";
    mock.reply({
      id: "resp_web",
      status: "completed",
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Odoo 20 release" } },
        {
          type: "message",
          id: "msg_web",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text,
              annotations: [
                { type: "url_citation", url: url1, title: "Odoo 20 is here", start_index: start1, end_index: start1 + link1.length },
                { type: "url_citation", url: url2, title: "Odoo - Wikipedia", start_index: start2, end_index: start2 + link2.length },
              ],
            },
          ],
        },
      ],
    });
    const result = await adapter.complete(request({ webGrounding: true }));
    expect(mock.last.body.tools).toEqual([{ type: "web_search" }]);
    expect(mock.last.body.tool_choice).toBe("auto");
    const id1 = webSourceId(url1);
    const id2 = webSourceId(url2);
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Odoo 20 was released in October 2026[WEB_SOURCE:${id1}]. Odoo is an ERP suite[WEB_SOURCE:${id2}].`,
        sources: {
          [id1]: { url: url1, source_name: "odoo.com" },
          [id2]: { url: url2, source_name: "en.wikipedia.org" },
        },
      },
    ]);
    const replay = result.provider_metadata.openai as { output: Array<{ type: string }> };
    expect(replay.output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
  });

  it("maps character offsets (not UTF-16 units) when emoji precede the citation", async () => {
    // Offsets count characters server-side: each emoji is 1 there but 2 JavaScript string units.
    const { mock, adapter } = setup();
    const url = "https://www.odoo.com/page/release-notes?utm_source=openai";
    const link = `([odoo.com](${url}))`;
    const text = `🚀 Odoo 20 ships 🎉 new AI agents ${link}. More soon.`;
    const start = [...text.slice(0, text.indexOf(link))].length; // code points, as Python counts
    expect(start).not.toBe(text.indexOf(link));
    mock.reply({
      id: "r",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url, title: "Release notes", start_index: start, end_index: start + [...link].length }] }],
        },
      ],
    });
    const result = await adapter.complete(request({ webGrounding: true }));
    const id = webSourceId(url);
    expect(result.content).toEqual([
      { type: "text", text: `🚀 Odoo 20 ships 🎉 new AI agents[WEB_SOURCE:${id}]. More soon.`, sources: { [id]: { url, source_name: "odoo.com" } } },
    ]);
  });
});

describe("OpenAIAdapter.complete: image generation", () => {
  const sizes: Array<[string | undefined, string]> = [
    ["1:1", "1024x1024"],
    ["16:9", "1536x1024"],
    ["3:2", "1536x1024"],
    ["2:3", "1024x1536"],
    ["9:16", "1024x1536"],
    [undefined, "1024x1024"],
  ];
  for (const [ratio, size] of sizes) {
    it(`uses size ${size} for aspect ratio ${ratio ?? "(none)"}`, async () => {
      const { mock, adapter } = setup();
      mock.reply({ id: "r", status: "completed", output: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: PNG }] });
      await adapter.complete(request({ imageGeneration: true, ...(ratio ? { aspectRatio: ratio } : {}) }));
      expect(mock.last.body.tools).toEqual([{ type: "image_generation", output_format: "png", size }]);
    });
  }

  // The docs' image_generation_call echoes `revised_prompt` but not `output_format`.
  const IMAGE_RESPONSE = {
    id: "resp_img",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_img", summary: [], encrypted_content: "enc" },
      { type: "image_generation_call", id: "ig_1", status: "completed", revised_prompt: "A cat", result: WEBP },
      { type: "message", id: "msg_img", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Here is your cat.", annotations: [] }] },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };

  it("returns the generated image as inline_data typed from its bytes, without base64 in the replay data", async () => {
    const { mock, adapter } = setup();
    mock.reply(IMAGE_RESPONSE);
    const result = await adapter.complete(
      request({ imageGeneration: true, aspectRatio: "16:9", options: { image_generation_tool: { quality: "high", output_format: "webp" } } }),
    );
    expect(mock.last.body.tools).toEqual([{ type: "image_generation", output_format: "webp", size: "1536x1024", quality: "high" }]);
    expect(result.content).toEqual([
      { type: "inline_data", mimetype: "image/webp", data: WEBP },
      { type: "text", text: "Here is your cat." },
    ]);
    const replay = result.provider_metadata.openai as { output: Array<Record<string, unknown>>; inline_images: number[] };
    expect(replay.output.map((item) => item.type)).toEqual(["reasoning", "image_generation_call", "message"]);
    expect(replay.output[1]).toEqual({ type: "image_generation_call", id: "ig_1", status: "completed", revised_prompt: "A cat" });
    expect(replay.inline_images).toEqual([1]);
    expect(JSON.stringify(result.provider_metadata)).not.toContain(WEBP);
  });

  it("replays the whole image turn, restoring the image from the inline_data part", async () => {
    const { mock, adapter } = setup();
    mock.reply(IMAGE_RESPONSE);
    const first = await adapter.complete(request({ imageGeneration: true }));
    // Odoo adds its bookkeeping to the stored image part.
    const stored = JSON.parse(JSON.stringify(first)) as AssistantMessage;
    (stored.content[0] as { metadata?: unknown }).metadata = { attachment_id: 12 };
    mock.reply(textResponseBody("Made it realistic."));
    await adapter.complete(
      request({
        imageGeneration: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "Draw a cat" }] },
          stored,
          { role: "user", content: [{ type: "text", text: "Now make it realistic" }] },
        ],
      }),
    );
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Draw a cat" }] },
      IMAGE_RESPONSE.output[0],
      IMAGE_RESPONSE.output[1],
      IMAGE_RESPONSE.output[2],
      { role: "user", content: [{ type: "input_text", text: "Now make it realistic" }] },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("rebuilds the image turn from its text when the image data is gone", async () => {
    const { mock, adapter } = setup();
    mock.reply(IMAGE_RESPONSE);
    const first = await adapter.complete(request({ imageGeneration: true }));
    const stored: AssistantMessage = { ...first, content: first.content.filter((part) => part.type === "text") };
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ messages: [{ role: "user", content: [{ type: "text", text: "Draw" }] }, stored, { role: "user", content: [{ type: "text", text: "Thanks" }] }] }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Draw" }] },
      { role: "assistant", content: "Here is your cat." },
      { role: "user", content: [{ type: "input_text", text: "Thanks" }] },
    ]);
  });

  it("falls back to the requested output_format when the bytes are not recognised", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "r", status: "completed", output: [{ type: "image_generation_call", id: "ig", status: "completed", result: "AAAA", output_format: "jpeg" }] });
    const result = await adapter.complete(request({ imageGeneration: true }));
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/jpeg", data: "AAAA" }]);
  });

  it("skips generated images from assistant history", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Draw a cat" }] },
          { role: "assistant", content: [{ type: "inline_data", mimetype: "image/png", data: PNG }, { type: "text", text: "Done" }], provider_metadata: {} },
          { role: "user", content: [{ type: "text", text: "Thanks" }] },
        ],
      }),
    );
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Draw a cat" }] },
      { role: "assistant", content: "Done" },
      { role: "user", content: [{ type: "input_text", text: "Thanks" }] },
    ]);
  });
});

describe("OpenAIAdapter.complete: errors", () => {
  it("maps HTTP 400 to ProviderError with the upstream message", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { message: "Invalid value: 'max'. Supported values are: 'low'.", type: "invalid_request_error", param: "reasoning.effort" } }, 400);
    const error = await adapter.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as Error).message).toContain("Invalid value: 'max'");
  });

  it("maps a failed response to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "r", status: "failed", error: { code: "server_error", message: "The model crashed" }, output: [] });
    await expect(adapter.complete(request())).rejects.toThrow(/The model crashed/);
  });

  it("maps an incomplete response without output to ProviderError with the reason", async () => {
    const { mock, adapter } = setup();
    mock.reply({
      id: "r",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", id: "rs", summary: [], encrypted_content: "x" }],
    });
    await expect(adapter.complete(request())).rejects.toThrow(/max_output_tokens/);
  });

  it("keeps partial text of an incomplete response", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("Partial answer", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "text", text: "Partial answer" }]);
  });

  it("maps an empty completed response to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "r", status: "completed", output: [{ type: "reasoning", id: "rs", summary: [] }] });
    await expect(adapter.complete(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it("lets aborts propagate unchanged", async () => {
    const { mock, adapter } = setup();
    const controller = new AbortController();
    controller.abort(new DOMException("The operation was aborted", "AbortError"));
    const error = await adapter.complete(request({ signal: controller.signal })).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).name).toBe("AbortError");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("OpenAIAdapter.supports", () => {
  const supported: Feature[] = [
    "completion",
    "tools",
    "schema",
    "tools+schema",
    "image_input",
    "pdf_input",
    "web_grounding",
    "web_grounding+schema",
    "image_generation",
    "embeddings",
    "transcription",
    "realtime",
  ];
  it("supports every feature except audio input", () => {
    const { adapter } = setup();
    for (const feature of supported) expect(adapter.supports(feature, "gpt-5.6")).toBe(true);
    expect(adapter.supports("audio_input", "gpt-5.6")).toBe(false);
  });
});

describe("OpenAIAdapter.embed", () => {
  it("posts inputs with 1536 dimensions and returns vectors in input order", async () => {
    const { mock, adapter } = setup();
    const vector = (seed: number) => Array.from({ length: 1536 }, (_, i) => (i === 0 ? seed : 0.001));
    mock.reply({
      object: "list",
      data: [
        { object: "embedding", index: 1, embedding: vector(2) },
        { object: "embedding", index: 0, embedding: vector(1) },
        { object: "embedding", index: 2, embedding: vector(3) },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 12, total_tokens: 12 },
    });
    const vectors = await adapter.embed({
      model: "text-embedding-3-small",
      inputs: [{ title: "Refund policy", content: "Refunds within 30 days." }, { content: "" }, { title: null, content: "What is the refund policy?" }],
      mode: "document",
      dimensions: 1536,
      signal: new AbortController().signal,
    });
    expect(mock.last.url).toBe("https://api.openai.com/v1/embeddings");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.body).toEqual({
      model: "text-embedding-3-small",
      input: ["Refund policy\n\nRefunds within 30 days.", " ", "What is the refund policy?"],
      dimensions: 1536,
      encoding_format: "float",
    });
    expect(vectors).toHaveLength(3);
    expect(vectors.map((v) => v.length)).toEqual([1536, 1536, 1536]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it("drops dimensions with options.dimensions: null and never sends completion-only options", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] });
    await adapter.embed({
      model: "text-embedding-3-small",
      inputs: [{ content: "a" }],
      mode: "query",
      dimensions: 1536,
      options: { dimensions: null, prompt_cache_key: "conversation", web_search_tool: {}, user: "odoo-db" },
      signal: new AbortController().signal,
    });
    expect(mock.last.body).toEqual({ model: "text-embedding-3-small", input: ["a"], encoding_format: "float", user: "odoo-db" });
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] });
    await expect(
      adapter.embed({ model: "text-embedding-3-small", inputs: [{ content: "a" }, { content: "b" }], mode: "query", dimensions: 1536, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenAIAdapter.transcribe", () => {
  const AUDIO = Buffer.from("ID3 fake mp3 audio").toString("base64");

  it("sends multipart audio and returns the json text", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "Bonjour, ceci est un test.", usage: { type: "tokens", input_tokens: 14, output_tokens: 8, total_tokens: 22 } });
    const text = await adapter.transcribe({ model: "gpt-4o-transcribe", audio: AUDIO, mimetype: "audio/mp3", language: "fr", signal: new AbortController().signal });
    expect(text).toBe("Bonjour, ceci est un test.");
    expect(mock.last.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["content-type"]).toBeUndefined();
    const form = mock.last.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(AUDIO);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("fr");
    expect(form.get("response_format")).toBe("json");
  });

  it("asks whisper-1 for native VTT", async () => {
    const { mock, adapter } = setup();
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello everyone.\n";
    mock.reply(textResponse(vtt, 200, "text/vtt"));
    const text = await adapter.transcribe({ model: "whisper-1", audio: AUDIO, mimetype: "audio/webm", responseFormat: "vtt", signal: new AbortController().signal });
    expect(text).toBe(vtt);
    const form = mock.last.body as FormData;
    expect(form.get("response_format")).toBe("vtt");
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  it("wraps text in a single-cue VTT for models without VTT output", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "Hello everyone." });
    const text = await adapter.transcribe({ model: "gpt-4o-mini-transcribe", audio: AUDIO, mimetype: "audio/wav", responseFormat: "vtt", signal: new AbortController().signal });
    expect((mock.last.body as FormData).get("response_format")).toBe("json");
    expect(text.startsWith("WEBVTT\n\n1\n00:00:00.000 --> ")).toBe(true);
    expect(text).toContain("Hello everyone.");
  });

  it("sends array options as repeated form fields", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "ok" });
    await adapter.transcribe({
      model: "gpt-4o-transcribe",
      audio: AUDIO,
      mimetype: "audio/mp3",
      options: { "include[]": ["logprobs"], temperature: 0, prompt: "Odoo" },
      signal: new AbortController().signal,
    });
    const form = mock.last.body as FormData;
    expect(form.getAll("include[]")).toEqual(["logprobs"]);
    expect(form.get("temperature")).toBe("0");
    expect(form.get("prompt")).toBe("Odoo");
  });

  it("never turns declared options of a shared tier into form fields", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "ok" });
    await adapter.transcribe({
      model: "gpt-4o-transcribe",
      audio: AUDIO,
      mimetype: "audio/mp3",
      options: { prompt_cache_key: "conversation", web_search_tool: { search_context_size: "low" }, expires_after_seconds: 60, temperature: 0 },
      signal: new AbortController().signal,
    });
    const form = mock.last.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "model", "response_format", "temperature"]);
  });

  it("maps HTTP errors to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { message: "Audio file is too short" } }, 400);
    await expect(
      adapter.transcribe({ model: "gpt-4o-transcribe", audio: AUDIO, mimetype: "audio/mp3", signal: new AbortController().signal }),
    ).rejects.toThrow(/too short/);
  });
});

describe("OpenAIAdapter.createRealtimeSession", () => {
  it("mints a GA client secret bound to a transcription session", async () => {
    const { mock, adapter } = setup();
    mock.reply({ value: "ek_68af296e", expires_at: 1756310470, session: { type: "transcription" } });
    const session = await adapter.createRealtimeSession({
      model: "gpt-4o-transcribe",
      language: "en",
      prompt: "Odoo, CRM",
      signal: new AbortController().signal,
    });
    expect(session).toEqual({ token: "ek_68af296e", expiresAt: 1756310470 });
    expect(mock.last.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.body).toEqual({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-transcribe", language: "en", prompt: "Odoo, CRM" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
            noise_reduction: { type: "near_field" },
          },
        },
      },
    });
  });

  it("disables turn detection for models that require it and honours options", async () => {
    const { mock, adapter } = setup();
    mock.reply({ value: "ek_1", expires_at: 1 });
    await adapter.createRealtimeSession({
      model: "gpt-realtime-whisper",
      options: { expires_after_seconds: 300, noise_reduction: null, transcription: { delay: "low" } },
      signal: new AbortController().signal,
    });
    const body = mock.last.body;
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 300 });
    expect(body.session.audio.input.turn_detection).toBeNull();
    expect(body.session.audio.input.noise_reduction).toBeNull();
    expect(body.session.audio.input.transcription).toEqual({ model: "gpt-realtime-whisper", delay: "low" });
    expect(body).not.toHaveProperty("expires_after_seconds");
    expect(body).not.toHaveProperty("transcription");
  });

  it("never sends completion-only options of a shared tier to client_secrets", async () => {
    const { mock, adapter } = setup();
    mock.reply({ value: "ek_3", expires_at: 3 });
    await adapter.createRealtimeSession({
      model: "gpt-4o-transcribe",
      options: { web_search_tool: {}, image_generation_tool: {}, prompt_cache_key: "conversation" },
      signal: new AbortController().signal,
    });
    expect(Object.keys(mock.last.body).sort()).toEqual(["expires_after", "session"]);
  });

  it("disables turn detection for dated snapshots of those models too", async () => {
    const { mock, adapter } = setup();
    mock.reply({ value: "ek_2", expires_at: 2 });
    await adapter.createRealtimeSession({ model: "gpt-realtime-whisper-2026-05-01", signal: new AbortController().signal });
    expect(mock.last.body.session.audio.input.turn_detection).toBeNull();
  });

  it("accepts the legacy client_secret shape", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "sess_1", client_secret: { value: "ek_legacy", expires_at: 1756310000 } });
    const session = await adapter.createRealtimeSession({ model: "gpt-live-transcribe", signal: new AbortController().signal });
    expect(session).toEqual({ token: "ek_legacy", expiresAt: 1756310000 });
    expect(mock.last.body.session.audio.input.turn_detection).toBeNull();
  });

  it("rejects a response without a secret", async () => {
    const { mock, adapter } = setup();
    mock.reply({ session: {} });
    await expect(adapter.createRealtimeSession({ model: "gpt-4o-transcribe", signal: new AbortController().signal })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("OpenAIAdapter.complete: effort rejected by the API", () => {
  it("retries once with a level the model accepts and remembers it for that model", async () => {
    const { mock, adapter } = setup();
    const rejection = {
      error: {
        message: "Unsupported value: 'xhigh' is not supported with the 'gpt-7-preview' model. Supported values are: 'none', 'low', 'medium', and 'high'.",
        type: "invalid_request_error",
        param: "reasoning.effort",
        code: "unsupported_value",
      },
    };
    mock.reply(rejection, 400).reply(textResponseBody("ok")).reply(textResponseBody("again"));
    const first = await adapter.complete(request({ model: "gpt-7-preview", effort: "xhigh" }));
    expect(first.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mock.calls[0]!.body.reasoning).toEqual({ effort: "xhigh" });
    expect(mock.calls[1]!.body.reasoning).toEqual({ effort: "high" });
    expect(mock.calls[1]!.body.model).toBe("gpt-7-preview");
    await adapter.complete(request({ model: "gpt-7-preview", effort: "max" }));
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[2]!.body.reasoning).toEqual({ effort: "high" });
  });

  it("does not retry other 400 errors", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { message: "Invalid schema for function 'x'", type: "invalid_request_error" } }, 400);
    await expect(adapter.complete(request({ model: "gpt-5.6", effort: "low" }))).rejects.toThrow(/Invalid schema/);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("OpenAIAdapter.complete: prompt_cache_key", () => {
  const conversationId = "cv_AAAAAAAAAAAAAAAAAAAAAA";

  it("sends none by default: different keys never share cached prefixes", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ conversationId }));
    expect(mock.last.body).not.toHaveProperty("prompt_cache_key");
    expect(JSON.stringify(mock.last.body)).not.toContain(conversationId);
  });

  it('uses the conversation id with options.prompt_cache_key: "conversation"', async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok")).reply(textResponseBody("ok"));
    await adapter.complete(request({ conversationId, options: { prompt_cache_key: "conversation" } }));
    expect(mock.last.body.prompt_cache_key).toBe(conversationId);
    // No conversation id (e.g. a direct call): nothing rather than the literal "conversation".
    await adapter.complete(request({ options: { prompt_cache_key: "conversation" } }));
    expect(mock.last.body).not.toHaveProperty("prompt_cache_key");
  });

  it("sends any other string as is, and nothing for false", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok")).reply(textResponseBody("ok"));
    await adapter.complete(request({ conversationId, options: { prompt_cache_key: "agent:sales" } }));
    expect(mock.last.body.prompt_cache_key).toBe("agent:sales");
    await adapter.complete(request({ conversationId, options: { prompt_cache_key: false } }));
    expect(mock.last.body).not.toHaveProperty("prompt_cache_key");
  });
});
