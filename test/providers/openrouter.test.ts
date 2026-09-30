import { describe, expect, it } from "vitest";

import { ProviderError, UnsupportedFeatureError } from "../../src/core/errors.js";
import type { AssistantMessage, OdooMessage } from "../../src/core/odoo-types.js";
import { webSourceId } from "../../src/providers/citations.js";
import { OpenRouterAdapter } from "../../src/providers/openrouter.js";
import type { CompletionRequest, Effort, Feature, ProviderSettings } from "../../src/providers/types.js";
import { FEATURES } from "../../src/providers/types.js";
import { MockFetch, jsonResponse } from "../helpers/mock-fetch.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSPj4Kc3RyZWFtCg==";
const MP3 = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA";

function setup(settings: Partial<ProviderSettings> = {}) {
  const mock = new MockFetch();
  const adapter = new OpenRouterAdapter({ apiKey: "test-key", fetch: mock.fetch, ...settings });
  return { mock, adapter };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "openai/gpt-5.6",
    instructions: "You are Odoo AI, a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    webGrounding: false,
    imageGeneration: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A realistic OpenRouter chat completion. */
function chat(message: Record<string, unknown>, extra: Record<string, unknown> = {}, finishReason = "stop") {
  return {
    id: "gen-1790000000-AbCdEfGhIjKlMnOp",
    provider: "OpenAI",
    model: "openai/gpt-5.6-20260812",
    object: "chat.completion",
    created: 1790000000,
    choices: [
      {
        logprobs: null,
        finish_reason: finishReason,
        native_finish_reason: finishReason === "tool_calls" ? "tool_calls" : "completed",
        index: 0,
        message: { role: "assistant", content: null, refusal: null, reasoning: null, ...message },
      },
    ],
    usage: {
      prompt_tokens: 812,
      completion_tokens: 64,
      total_tokens: 876,
      cost: 0.00123,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 32 },
    },
    ...extra,
  };
}

const REASONING_DETAILS = [
  {
    type: "reasoning.summary",
    summary: "The user asks for the weather in Brussels; call get_weather.",
    id: "rs_0a1b2c3d",
    format: "openai-responses-v1",
    index: 0,
  },
  { type: "reasoning.encrypted", data: "gAAAAABo9x-encrypted-blob==", id: "rs_0a1b2c3d", format: "openai-responses-v1", index: 1 },
];

const WEATHER_TOOL = {
  name: "get_weather",
  instructions: "Get the current weather for a city.",
  schema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
};

describe("OpenRouterAdapter.complete: request", () => {
  it("posts to /chat/completions with bearer auth and the attribution headers", async () => {
    const { mock, adapter } = setup({ headers: { "HTTP-Referer": "https://erp.example.com", "X-Title": "Odoo" } });
    mock.reply(chat({ content: "Hi!" }));
    const signal = new AbortController().signal;
    await adapter.complete(request({ signal }));

    expect(mock.last.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(mock.last.method).toBe("POST");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["http-referer"]).toBe("https://erp.example.com");
    expect(mock.last.headers["x-title"]).toBe("Odoo");
    expect(mock.last.headers["content-type"]).toBe("application/json");
    expect(mock.last.signal).toBe(signal);
    expect(mock.last.body.model).toBe("openai/gpt-5.6");
  });

  it("never lets a configured authorization header (any casing) clobber the API key", async () => {
    const { mock, adapter } = setup({ headers: { authorization: "Bearer stale-key", "X-Title": "Odoo" } });
    mock.reply(chat({ content: "Hi!" }));
    await adapter.complete(request());
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["x-title"]).toBe("Odoo");
  });

  it("honours a custom base URL", async () => {
    const { mock, adapter } = setup({ baseUrl: "https://proxy.example.com/openrouter/v1/" });
    mock.reply(chat({ content: "Hi!" }));
    await adapter.complete(request());
    expect(mock.last.url).toBe("https://proxy.example.com/openrouter/v1/chat/completions");
  });

  it("sends instructions as the system message, and none when empty", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Hi!" })).reply(chat({ content: "Hi!" }));
    await adapter.complete(request());
    expect(mock.last.body.messages[0]).toEqual({ role: "system", content: "You are Odoo AI, a helpful assistant." });
    expect(mock.last.body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "Hello" }] });

    await adapter.complete(request({ instructions: "  " }));
    expect(mock.last.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
  });

  it("translates text, images, PDFs, audio, text files and other binaries without Odoo metadata", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Done." }));
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize these." },
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 42, image_path: "/web/image/42" } },
              { type: "inline_data", mimetype: "application/pdf", data: PDF, metadata: { attachment_id: 43 } },
              { type: "inline_data", mimetype: "audio/mpeg", data: MP3, metadata: { attachment_id: 44 } },
              { type: "inline_data", mimetype: "text/csv", data: Buffer.from("name,qty\nDesk,2").toString("base64") },
              { type: "inline_data", mimetype: "application/zip", data: "UEsDBBQAAAAIAA==" },
              { type: "text", text: "<odoo_current_context>res.partner(7)</odoo_current_context>" },
            ],
          },
        ],
      }),
    );
    expect(mock.last.body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Summarize these." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF}` } },
        { type: "input_audio", input_audio: { data: MP3, format: "mp3" } },
        { type: "text", text: "name,qty\nDesk,2" },
        { type: "file", file: { filename: "file.zip", file_data: "data:application/zip;base64,UEsDBBQAAAAIAA==" } },
        { type: "text", text: "<odoo_current_context>res.partner(7)</odoo_current_context>" },
      ],
    });
    expect(mock.last.rawBody).not.toContain("metadata");
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("declares function tools (null schema -> empty object schema, 'text' type normalized)", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Ok" }));
    await adapter.complete(
      request({
        tools: [
          WEATHER_TOOL,
          { name: "list_leads", instructions: "List open CRM leads.", schema: null },
          { name: "set_note", instructions: "Set a note.", schema: { type: "object", properties: { note: { type: "text" } } } },
        ],
      }),
    );
    expect(mock.last.body.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: WEATHER_TOOL.schema } },
      { type: "function", function: { name: "list_leads", description: "List open CRM leads.", parameters: { type: "object", properties: {}, required: [] } } },
      { type: "function", function: { name: "set_note", description: "Set a note.", parameters: { type: "object", properties: { note: { type: "string" } } } } },
    ]);
    expect(mock.last.body).not.toHaveProperty("response_format");
    expect(mock.last.body).not.toHaveProperty("provider");
    expect(mock.last.body).not.toHaveProperty("modalities");
  });

  it("maps maxOutputTokens and shallow-merges options, keeping special keys out of the body", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Ok" }));
    await adapter.complete(
      request({
        maxOutputTokens: 4096,
        webGrounding: true,
        options: {
          temperature: 0.2,
          transforms: ["middle-out"],
          web_search_tool: { engine: "exa", max_results: 3 },
          provider: { order: ["openai"], allow_fallbacks: false },
        },
      }),
    );
    const body = mock.last.body;
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.2);
    expect(body.transforms).toEqual(["middle-out"]);
    expect(body.provider).toEqual({ order: ["openai"], allow_fallbacks: false });
    expect(body.tools).toEqual([{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: 3 } }]);
    expect(body).not.toHaveProperty("web_search_tool");
  });
});

describe("OpenRouterAdapter.complete: effort", () => {
  const cases: Array<{ model: string; effort: Effort | undefined; expected: Record<string, unknown> | undefined }> = [
    { model: "openai/gpt-5.6", effort: undefined, expected: undefined },
    { model: "openai/gpt-5.6", effort: "high", expected: { effort: "high" } },
    { model: "openai/gpt-6", effort: "xhigh", expected: { effort: "xhigh" } },
    { model: "openai/gpt-6", effort: "max", expected: { effort: "xhigh" } },
    // Claude accepts `max` natively but rejects `effort: "none"`: reasoning is disabled instead.
    { model: "anthropic/claude-opus-5.5", effort: "max", expected: { effort: "max" } },
    { model: "anthropic/claude-sonnet-5.5", effort: "none", expected: { enabled: false } },
    { model: "~anthropic/claude-sonnet-latest", effort: "none", expected: { enabled: false } },
    { model: "anthropic/claude-haiku-4.5", effort: "low", expected: { effort: "low" } },
    { model: "google/gemini-3.8-flash", effort: "none", expected: { effort: "none" } },
    { model: "openai/gpt-5.6", effort: "none", expected: { effort: "none" } },
    { model: "x-ai/grok-4.7", effort: "minimal", expected: { effort: "minimal" } },
    { model: "deepseek/deepseek-r2", effort: "medium", expected: { effort: "medium" } },
  ];
  for (const { model, effort, expected } of cases) {
    it(`${model} effort=${effort ?? "unset"} -> ${expected ? JSON.stringify(expected) : "no reasoning field"}`, async () => {
      const { mock, adapter } = setup();
      mock.reply(chat({ content: "Ok" }));
      await adapter.complete(request({ model, ...(effort ? { effort } : {}) }));
      if (expected) expect(mock.last.body.reasoning).toEqual(expected);
      else expect(mock.last.body).not.toHaveProperty("reasoning");
    });
  }

  it("merges options.reasoning over the effort; an explicit max_tokens budget replaces it", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Ok" })).reply(chat({ content: "Ok" }));
    await adapter.complete(request({ effort: "high", options: { reasoning: { exclude: true } } }));
    expect(mock.last.body.reasoning).toEqual({ effort: "high", exclude: true });

    await adapter.complete(request({ model: "anthropic/claude-sonnet-5.5", effort: "high", options: { reasoning: { max_tokens: 8000 } } }));
    expect(mock.last.body.reasoning).toEqual({ max_tokens: 8000 });
  });
});

describe("OpenRouterAdapter.complete: tool calling round trip", () => {
  const firstUser: OdooMessage = {
    role: "user",
    content: [
      { type: "text", text: "What's the weather in Brussels?" },
      { type: "text", text: "<odoo_current_context>discuss.channel(3)</odoo_current_context>" },
    ],
  };

  async function firstTurn() {
    const { mock, adapter } = setup();
    mock.reply(
      chat(
        {
          content: "",
          reasoning: "The user asks for the weather in Brussels; call get_weather.",
          reasoning_details: REASONING_DETAILS,
          tool_calls: [
            { id: "call_Xk3pQ9", type: "function", index: 0, function: { name: "get_weather", arguments: '{"city":"Brussels"}' } },
            { id: "call_Yz7", type: "function", index: 1, function: { name: "get_weather", arguments: "{not json" } },
          ],
        },
        {},
        "tool_calls",
      ),
    );
    const result = await adapter.complete(request({ tools: [WEATHER_TOOL], messages: [firstUser], effort: "medium" }));
    return { mock, adapter, result };
  }

  it("parses tool calls into Odoo tool_call parts and stores replay data", async () => {
    const { result } = await firstTurn();
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([
      { type: "tool_call", name: "get_weather", args: { city: "Brussels" }, call_id: "call_Xk3pQ9" },
      { type: "tool_call", name: "get_weather", args: { __raw_arguments: "{not json" }, call_id: "call_Yz7" },
    ]);
    expect(result.provider_metadata.provider).toBe("openrouter");
    expect(result.provider_metadata.usage).toMatchObject({ prompt_tokens: 812, completion_tokens: 64 });
    expect(result.provider_metadata.openrouter).toEqual({
      reasoning_details: REASONING_DETAILS,
      model: "openai/gpt-5.6-20260812",
      id: "gen-1790000000-AbCdEfGhIjKlMnOp",
    });
  });

  it("builds the next turn from history, replaying reasoning_details verbatim", async () => {
    const { mock, adapter, result } = await firstTurn();
    // Odoo stores the message with provider/model added by the service, then sends it back.
    const stored = JSON.parse(JSON.stringify({ ...result, provider_metadata: { ...result.provider_metadata, model: "openai/gpt-5.6" } })) as AssistantMessage;
    mock.reply(chat({ content: "It is 18°C and sunny in Brussels." }));
    const second = await adapter.complete(
      request({
        tools: [WEATHER_TOOL],
        messages: [
          firstUser,
          stored,
          {
            role: "user",
            content: [
              { type: "tool_result", tool_name: "get_weather", tool_call_id: "call_Xk3pQ9", success: true, result: [{ type: "text", text: '{"temp_c":18,"sky":"sunny"}' }] },
              {
                type: "tool_result",
                tool_name: "get_weather",
                tool_call_id: "call_Yz7",
                success: false,
                result: [
                  { type: "text", text: "Error: invalid arguments" },
                  { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 9 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(mock.last.body.messages).toEqual([
      { role: "system", content: "You are Odoo AI, a helpful assistant." },
      {
        role: "user",
        content: [
          { type: "text", text: "What's the weather in Brussels?" },
          { type: "text", text: "<odoo_current_context>discuss.channel(3)</odoo_current_context>" },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_Xk3pQ9", type: "function", function: { name: "get_weather", arguments: '{"city":"Brussels"}' } },
          { id: "call_Yz7", type: "function", function: { name: "get_weather", arguments: '{"__raw_arguments":"{not json"}' } },
        ],
        reasoning_details: REASONING_DETAILS,
      },
      { role: "tool", tool_call_id: "call_Xk3pQ9", content: '{"temp_c":18,"sky":"sunny"}' },
      { role: "tool", tool_call_id: "call_Yz7", content: "Error: invalid arguments" },
      {
        role: "user",
        content: [
          { type: "text", text: "Images returned by tool get_weather:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
    ]);
    expect(second.content).toEqual([{ type: "text", text: "It is 18°C and sunny in Brussels." }]);
    // No reasoning_details in this response: none stored.
    expect(second.provider_metadata.openrouter).toEqual({ model: "openai/gpt-5.6-20260812", id: "gen-1790000000-AbCdEfGhIjKlMnOp" });
  });

  it("replays reasoning_details only to a model of the same vendor (tier / boost switches)", async () => {
    const { mock, adapter, result } = await firstTurn();
    const stored = JSON.parse(JSON.stringify(result)) as AssistantMessage;
    const toolResult: OdooMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_name: "get_weather", tool_call_id: "call_Xk3pQ9", success: true, result: [{ type: "text", text: "18°C" }] },
        { type: "tool_result", tool_name: "get_weather", tool_call_id: "call_Yz7", success: true, result: [{ type: "text", text: "18°C" }] },
      ],
    };
    const assistantOf = () => mock.last.body.messages.find((m: { role: string }) => m.role === "assistant");

    // Boosted to another OpenAI model: the OpenAI reasoning items still apply.
    mock.reply(chat({ content: "Sunny." }));
    await adapter.complete(request({ model: "openai/gpt-6", tools: [WEATHER_TOOL], messages: [firstUser, stored, toolResult] }));
    expect(assistantOf().reasoning_details).toEqual(REASONING_DETAILS);

    // Switched to a Claude model: OpenAI encrypted reasoning must not reach Anthropic.
    mock.reply(chat({ content: "Sunny." }));
    await adapter.complete(request({ model: "anthropic/claude-opus-5.5", tools: [WEATHER_TOOL], messages: [firstUser, stored, toolResult] }));
    expect(assistantOf()).not.toHaveProperty("reasoning_details");
    expect(assistantOf().tool_calls).toHaveLength(2);
  });

  it("rebuilds cross-provider history from generic parts (numeric call ids, no replay data)", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Done." }));
    await adapter.complete(
      request({
        tools: [WEATHER_TOOL],
        messages: [
          { role: "user", content: [{ type: "text", text: "Weather in Ghent and Liège?" }] },
          // Odoo test fixture shape: empty provider_metadata, integer call ids.
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_call", name: "get_weather", args: { city: "Ghent" }, call_id: 1 },
            ],
            provider_metadata: {},
          },
          { role: "user", content: [{ type: "tool_result", tool_name: "get_weather", tool_call_id: 1, success: true, result: [] }] },
          // A Claude-produced turn: its replay data must not leak into an OpenRouter request.
          {
            role: "assistant",
            content: [{ type: "tool_call", name: "get_weather", args: { city: "Liège" }, call_id: "toolu_01AbC", provider_data: { signature: "x" } }],
            provider_metadata: { provider: "claude", model: "claude-opus-5-5", claude: { thinking: [{ type: "thinking", signature: "sig" }] }, openrouter: { reasoning_details: [{ type: "reasoning.text", text: "stale" }] } },
          },
          { role: "user", content: [{ type: "tool_result", tool_name: "get_weather", tool_call_id: "toolu_01AbC", success: true, result: [{ type: "text", text: "12°C" }] }] },
          // Assistant image-only turn (generated image) is not replayed.
          { role: "assistant", content: [{ type: "inline_data", mimetype: "image/png", data: PNG }], provider_metadata: {} },
          { role: "user", content: [{ type: "text", text: "Thanks" }] },
        ],
      }),
    );
    expect(mock.last.body.messages.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "Weather in Ghent and Liège?" }] },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "1", type: "function", function: { name: "get_weather", arguments: '{"city":"Ghent"}' } }],
      },
      { role: "tool", tool_call_id: "1", content: "success" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_01AbC", type: "function", function: { name: "get_weather", arguments: '{"city":"Liège"}' } }],
      },
      { role: "tool", tool_call_id: "toolu_01AbC", content: "12°C" },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ]);
  });
});

describe("OpenRouterAdapter.complete: structured output", () => {
  // `ai_field`-like schema, including Odoo's `{"type": "text"}` quirk.
  const AI_FIELD_SCHEMA = {
    type: "object",
    properties: { value: { type: "text" }, confidence: { type: "float" } },
    required: ["value"],
  };

  it("sends a json_schema response_format with require_parameters and returns the JSON text", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      chat({
        content: '{"value":"Blue","confidence":0.9}',
        annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/colors", title: "Colors", start_index: 0, end_index: 5 } }],
      }),
    );
    const result = await adapter.complete(
      request({ schema: AI_FIELD_SCHEMA, webGrounding: true, options: { provider: { order: ["anthropic"] } } }),
    );
    expect(mock.last.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: false,
        schema: { type: "object", properties: { value: { type: "string" }, confidence: { type: "number" } }, required: ["value"] },
      },
    });
    expect(mock.last.body.provider).toEqual({ require_parameters: true, order: ["anthropic"] });
    expect(mock.last.body.tools).toEqual([{ type: "openrouter:web_search" }]);
    // With a schema the text is the bare JSON: no markers, no sources.
    expect(result.content).toEqual([{ type: "text", text: '{"value":"Blue","confidence":0.9}' }]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ value: "Blue", confidence: 0.9 });
  });

  it("uses strict mode when the schema already satisfies it", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: '{"value":"Blue"}' }));
    const schema = { type: "object", properties: { value: { type: "text" } }, required: ["value"], additionalProperties: false };
    await adapter.complete(request({ schema, tools: [WEATHER_TOOL] }));
    expect(mock.last.body.response_format.json_schema.strict).toBe(true);
    expect(mock.last.body.response_format.json_schema.schema.properties.value).toEqual({ type: "string" });
    expect(mock.last.body.tools).toHaveLength(1);
    expect(mock.last.body.provider).toEqual({ require_parameters: true });
  });
});

describe("OpenRouterAdapter.complete: web grounding", () => {
  it("adds the web search server tool and turns url_citation annotations into markers + sources", async () => {
    const { mock, adapter } = setup();
    const link = "[odoo.com](https://www.odoo.com/blog/odoo-20)";
    const sentence = "It ships AI agents.";
    const content = `Odoo 20 was released in October 2026 (${link}). ${sentence}`;
    mock.reply(
      chat({
        content,
        annotations: [
          {
            type: "url_citation",
            url_citation: { url: "https://www.odoo.com/blog/odoo-20", title: "Odoo 20 release", content: "…", start_index: content.indexOf(link), end_index: content.indexOf(link) + link.length },
          },
          // Plain-sentence span: marker appended after it.
          {
            type: "url_citation",
            url_citation: { url: "https://techcrunch.com/odoo-ai", title: "TechCrunch", start_index: content.indexOf(sentence), end_index: content.indexOf(sentence) + sentence.length },
          },
          // Flat OpenAI shape without indices: marker appended at the end.
          { type: "url_citation", url: "https://en.wikipedia.org/wiki/Odoo", title: "Odoo - Wikipedia" },
          { type: "file", file: { name: "ignored.pdf" } },
        ],
      }),
    );
    const result = await adapter.complete(request({ webGrounding: true }));

    expect(mock.last.body.tools).toEqual([{ type: "openrouter:web_search" }]);
    const odoo = webSourceId("https://www.odoo.com/blog/odoo-20");
    const tc = webSourceId("https://techcrunch.com/odoo-ai");
    const wiki = webSourceId("https://en.wikipedia.org/wiki/Odoo");
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Odoo 20 was released in October 2026[WEB_SOURCE:${odoo}]. It ships AI agents.[WEB_SOURCE:${tc}] [WEB_SOURCE:${wiki}]`,
        sources: {
          [odoo]: { url: "https://www.odoo.com/blog/odoo-20", source_name: "odoo.com" },
          [tc]: { url: "https://techcrunch.com/odoo-ai", source_name: "techcrunch.com" },
          [wiki]: { url: "https://en.wikipedia.org/wiki/Odoo", source_name: "en.wikipedia.org" },
        },
      },
    ]);
  });

  it("replaces the model's [domain](url) links when the annotations carry no usable indices", async () => {
    const { mock, adapter } = setup();
    // OpenRouter's search prompt: "Cite them using markdown links named using the domain of the source."
    const content = "Odoo 20 ships AI agents [odoo.com](https://www.odoo.com/blog/odoo-20). Pricing is unchanged [odoo.com](https://www.odoo.com/pricing).";
    mock.reply(
      chat({
        content,
        annotations: [
          { type: "url_citation", url_citation: { url: "https://www.odoo.com/blog/odoo-20", title: "Odoo 20", start_index: 0, end_index: 0 } },
          { type: "url_citation", url_citation: { url: "https://www.odoo.com/pricing", title: "Pricing" } },
        ],
      }),
    );
    const result = await adapter.complete(request({ webGrounding: true }));
    const blog = webSourceId("https://www.odoo.com/blog/odoo-20");
    const pricing = webSourceId("https://www.odoo.com/pricing");
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Odoo 20 ships AI agents[WEB_SOURCE:${blog}]. Pricing is unchanged[WEB_SOURCE:${pricing}].`,
        sources: {
          [blog]: { url: "https://www.odoo.com/blog/odoo-20", source_name: "odoo.com" },
          [pricing]: { url: "https://www.odoo.com/pricing", source_name: "odoo.com" },
        },
      },
    ]);
  });

  it("realigns citation indices counted in code points when the text has emoji", async () => {
    const { mock, adapter } = setup();
    const link = "([odoo.com](https://www.odoo.com/blog/odoo-20))";
    const content = `🚀🚀 Odoo 20 is out ${link}.`;
    const codePointStart = [...content.slice(0, content.indexOf(link))].length;
    const codePointEnd = codePointStart + [...link].length;
    expect(codePointStart).not.toBe(content.indexOf(link));
    mock.reply(
      chat({
        content,
        annotations: [{ type: "url_citation", url_citation: { url: "https://www.odoo.com/blog/odoo-20", title: "Odoo 20", start_index: codePointStart, end_index: codePointEnd } }],
      }),
    );
    const result = await adapter.complete(request({ webGrounding: true }));
    const id = webSourceId("https://www.odoo.com/blog/odoo-20");
    expect((result.content[0] as { text: string }).text).toBe(`🚀🚀 Odoo 20 is out[WEB_SOURCE:${id}].`);
  });

  it("ignores annotations when web grounding was not requested", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "Plain answer.", annotations: [{ type: "url_citation", url_citation: { url: "https://a.example", start_index: 0, end_index: 5 } }] }));
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "text", text: "Plain answer." }]);
    expect(mock.last.body).not.toHaveProperty("tools");
  });

  it("accepts content returned as an array of text parts", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: [{ type: "text", text: "Part one. " }, { type: "text", text: "Part two." }] }));
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "text", text: "Part one. Part two." }]);
  });
});

describe("OpenRouterAdapter.complete: image generation", () => {
  it("requests image modalities with the aspect ratio and returns inline_data parts", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      chat({
        content: "Here is your banner.",
        images: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` }, index: 0 },
          { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRhYAAABXRUJQ" }, index: 1 },
        ],
      }),
    );
    const result = await adapter.complete(
      request({ model: "google/gemini-3.8-flash-image", imageGeneration: true, aspectRatio: "16:9", options: { image_config: { image_size: "2K" } } }),
    );
    expect(mock.last.body.modalities).toEqual(["image", "text"]);
    expect(mock.last.body.image_config).toEqual({ image_size: "2K", aspect_ratio: "16:9" });
    expect(result.content).toEqual([
      { type: "text", text: "Here is your banner." },
      { type: "inline_data", mimetype: "image/png", data: PNG },
      { type: "inline_data", mimetype: "image/webp", data: "UklGRhYAAABXRUJQ" },
    ]);
  });

  it("returns an image-only answer and omits image_config without an aspect ratio", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: null, images: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } }] }));
    const result = await adapter.complete(request({ model: "openai/gpt-5-image", imageGeneration: true }));
    expect(mock.last.body).not.toHaveProperty("image_config");
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/jpeg", data: PNG }]);
  });

  it("strips line breaks from wrapped base64 in image data URLs", async () => {
    const { mock, adapter } = setup();
    const wrapped = `${PNG.slice(0, 40)}\n${PNG.slice(40)}`;
    mock.reply(chat({ content: null, images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${wrapped}` } }] }));
    const result = await adapter.complete(request({ imageGeneration: true }));
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/png", data: PNG }]);
  });
});

describe("OpenRouterAdapter.complete: errors", () => {
  it("maps HTTP 400 to ProviderError with the upstream message", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { code: 400, message: "openai/gpt-9 is not a valid model ID", metadata: {} } }, 400);
    const error = await adapter.complete(request({ model: "openai/gpt-9" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).message).toContain("openai/gpt-9 is not a valid model ID");
  });

  it("maps an error body with HTTP 200 to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { code: 502, message: "Upstream provider timed out", metadata: { provider_name: "Anthropic" } } });
    await expect(adapter.complete(request())).rejects.toThrow(/Upstream provider timed out/);
  });

  it("maps finish_reason error to ProviderError", async () => {
    const { mock, adapter } = setup();
    const body = chat({ content: "" }, {}, "error");
    (body.choices[0] as Record<string, unknown>).error = { code: 502, message: "Internal provider error" };
    mock.reply(body);
    await expect(adapter.complete(request())).rejects.toThrow(ProviderError);
  });

  it("maps an empty answer to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "" }, {}, "content_filter"));
    await expect(adapter.complete(request())).rejects.toThrow(/empty response \(finish_reason: content_filter\)/);
  });

  it("returns a refusal as text, but fails a schema request with a clear message", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: null, refusal: "I can't help with that." })).reply(chat({ content: null, refusal: "I can't help with that." }));
    const result = await adapter.complete(request());
    expect(result.content).toEqual([{ type: "text", text: "I can't help with that." }]);
    await expect(adapter.complete(request({ schema: { type: "object", properties: { value: { type: "string" } } } }))).rejects.toThrow(
      /refused to answer: I can't help with that\./,
    );
  });

  it("maps a response without choices to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "gen-1", choices: [] });
    await expect(adapter.complete(request())).rejects.toThrow(ProviderError);
  });

  it("lets aborts propagate untouched", async () => {
    const { mock, adapter } = setup();
    const controller = new AbortController();
    controller.abort();
    mock.reply(chat({ content: "never" }));
    const error = await adapter.complete(request({ signal: controller.signal })).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("OpenRouterAdapter.supports", () => {
  const { adapter } = setup();
  const expected: Record<Feature, boolean> = {
    completion: true,
    tools: true,
    schema: true,
    web_grounding: true,
    image_generation: true,
    image_input: true,
    pdf_input: true,
    audio_input: true,
    "web_grounding+schema": true,
    "tools+schema": true,
    embeddings: true,
    transcription: true,
    realtime: false,
  };
  for (const feature of FEATURES) {
    it(`${feature} -> ${expected[feature]}`, () => {
      expect(adapter.supports(feature, "openai/gpt-5.6")).toBe(expected[feature]);
      expect(adapter.supports(feature, "anthropic/claude-sonnet-5.5")).toBe(expected[feature]);
    });
  }

  it("has no realtime sessions", async () => {
    await expect(adapter.createRealtimeSession({ model: "openai/gpt-realtime", signal: new AbortController().signal })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
  });
});

describe("OpenRouterAdapter.embed", () => {
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) / 10);

  it("posts to /embeddings and returns one 1536-dim vector per input, in input order", async () => {
    const { mock, adapter } = setup();
    mock.reply({
      object: "list",
      model: "openai/text-embedding-3-small",
      data: [
        { object: "embedding", index: 2, embedding: vector(2) },
        { object: "embedding", index: 0, embedding: vector(0) },
        { object: "embedding", index: 1, embedding: vector(1) },
      ],
      usage: { prompt_tokens: 21, total_tokens: 21 },
    });
    const result = await adapter.embed({
      model: "openai/text-embedding-3-small",
      inputs: [{ title: "Refund policy", content: "Refunds within 30 days." }, { title: null, content: "How do I get a refund?" }, { content: "" }],
      mode: "document",
      dimensions: 1536,
      signal: new AbortController().signal,
    });
    expect(mock.last.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.body).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["Refund policy\n\nRefunds within 30 days.", "How do I get a refund?", " "],
      dimensions: 1536,
    });
    expect(result).toHaveLength(3);
    for (const [i, item] of result.entries()) {
      expect(item).toHaveLength(1536);
      expect(item).toEqual(vector(i));
    }
  });

  it("omits dimensions for text-embedding-ada-002 (fixed 1536, rejects the parameter) and on options.dimensions null", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ index: 0, embedding: vector(0) }] }).reply({ data: [{ index: 0, embedding: vector(0) }] });
    const base = { mode: "document" as const, dimensions: 1536, inputs: [{ content: "Desk" }], signal: new AbortController().signal };
    await adapter.embed({ ...base, model: "openai/text-embedding-ada-002" });
    expect(mock.last.body).toEqual({ model: "openai/text-embedding-ada-002", input: ["Desk"] });
    await adapter.embed({ ...base, model: "acme/embed-1536", options: { dimensions: null, encoding_format: "float" } });
    expect(mock.last.body).toEqual({ model: "acme/embed-1536", input: ["Desk"], encoding_format: "float" });
  });

  it("rejects vectors of the wrong size or count", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }).reply({ data: [] });
    const base = { model: "qwen/qwen3-embedding-8b", mode: "query" as const, dimensions: 1536, signal: new AbortController().signal };
    await expect(adapter.embed({ ...base, inputs: [{ content: "q" }] })).rejects.toThrow(/1536/);
    await expect(adapter.embed({ ...base, inputs: [{ content: "q" }] })).rejects.toThrow(/expected 1 embeddings, got 0/);
  });
});

describe("OpenRouterAdapter.transcribe", () => {
  const base = { model: "openai/whisper-1", audio: MP3, mimetype: "audio/mp3", signal: new AbortController().signal };

  it("posts base64 JSON to /audio/transcriptions and returns the text", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: " Bonjour, ceci est une note vocale. ", usage: { seconds: 4 } });
    const text = await adapter.transcribe({ ...base, language: "fr", responseFormat: "text" });
    expect(mock.last.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(mock.last.body).toEqual({ model: "openai/whisper-1", input_audio: { data: MP3, format: "mp3" }, language: "fr", response_format: "json" });
    expect(text).toBe("Bonjour, ceci est une note vocale.");
  });

  it("builds WebVTT from verbose_json segments", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      jsonResponse({
        task: "transcribe",
        language: "english",
        duration: 7.5,
        text: "Hello everyone. Let's start the meeting.",
        segments: [
          { id: 0, start: 0, end: 2.4, text: " Hello everyone." },
          { id: 1, start: 2.4, end: 7.5, text: " Let's start the meeting." },
        ],
      }),
    );
    const vtt = await adapter.transcribe({ ...base, mimetype: "audio/webm", responseFormat: "vtt" });
    expect(mock.last.body.response_format).toBe("verbose_json");
    expect(mock.last.body.input_audio.format).toBe("webm");
    expect(vtt).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.400\nHello everyone.\n\n2\n00:00:02.400 --> 00:00:07.500\nLet's start the meeting.\n");
  });

  it("falls back to a single cue when the model returns no segments", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "Short call.", duration: 3.2 });
    const vtt = await adapter.transcribe({ ...base, responseFormat: "vtt" });
    expect(vtt).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.200\nShort call.\n");
  });

  it("maps HTTP errors to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: { code: 413, message: "Audio file too large" } }, 413);
    await expect(adapter.transcribe({ ...base })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenRouterAdapter.complete: conversation stickiness", () => {
  const conversationId = "cv_AAAAAAAAAAAAAAAAAAAAAA";

  it("sends the conversation id as session_id, for every vendor", async () => {
    for (const model of ["openai/gpt-5.6", "anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash"]) {
      const { mock, adapter } = setup();
      mock.reply(chat({ content: "ok" }));
      await adapter.complete(request({ model, conversationId }));
      expect(mock.last.body.session_id).toBe(conversationId);
    }
  });

  it("sends no session_id without a conversation id", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "ok" }));
    await adapter.complete(request());
    expect(mock.last.body).not.toHaveProperty("session_id");
  });

  it("lets options.session_id replace it (string) or turn it off (false)", async () => {
    const { mock, adapter } = setup();
    mock.reply(chat({ content: "ok" })).reply(chat({ content: "ok" }));
    await adapter.complete(request({ conversationId, options: { session_id: "website-builder" } }));
    expect(mock.last.body.session_id).toBe("website-builder");
    await adapter.complete(request({ conversationId, options: { session_id: false } }));
    expect(mock.last.body).not.toHaveProperty("session_id");
  });
});
