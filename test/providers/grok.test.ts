import { describe, expect, it } from "vitest";

import { ProviderError, UnsupportedFeatureError } from "../../src/core/errors.js";
import type { AssistantMessage, OdooMessage } from "../../src/core/odoo-types.js";
import { webSourceId } from "../../src/providers/citations.js";
import { GrokAdapter } from "../../src/providers/grok.js";
import type { CompletionRequest, Effort, Feature } from "../../src/providers/types.js";
import { MockFetch } from "../helpers/mock-fetch.js";

const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function setup(settings: { baseUrl?: string; headers?: Record<string, string> } = {}) {
  const mock = new MockFetch();
  const adapter = new GrokAdapter({ apiKey: "test-key", fetch: mock.fetch, ...settings });
  return { mock, adapter };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "grok-4.7",
    instructions: "You are Odoo's AI assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    webGrounding: false,
    imageGeneration: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function textResponseBody(text: string, annotations: unknown[] = []) {
  return {
    id: "resp_grok_1",
    object: "response",
    status: "completed",
    model: "grok-4.7",
    output: [
      { type: "reasoning", id: "rs_g1", summary: [], encrypted_content: "xai-enc-1", status: "completed" },
      { type: "message", id: "msg_g1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations, logprobs: [] }] },
    ],
    usage: { input_tokens: 120, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 150 },
  };
}

const TOOL_CALL_RESPONSE = {
  id: "resp_grok_tool",
  object: "response",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_gt", summary: [], encrypted_content: "xai-enc-tool", status: "completed" },
    { type: "function_call", id: "fc_g1", call_id: "call_61234", name: "create_lead", arguments: '{"name":"Big deal","expected_revenue":5000}', status: "completed" },
  ],
  usage: { input_tokens: 300, output_tokens: 25, total_tokens: 325 },
};

describe("GrokAdapter.complete: request", () => {
  it("posts to the xAI Responses API with bearer auth", async () => {
    const { mock, adapter } = setup({ headers: { "X-Trace": "abc" } });
    mock.reply(textResponseBody("Hi!"));
    const result = await adapter.complete(request());
    expect(mock.last.url).toBe("https://api.x.ai/v1/responses");
    expect(mock.last.method).toBe("POST");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["x-trace"]).toBe("abc");
    expect(result.content).toEqual([{ type: "text", text: "Hi!" }]);
    expect(result.provider_metadata.provider).toBe("grok");
    expect(result.provider_metadata.usage).toEqual(textResponseBody("").usage);
  });

  it("maps instructions, text and images, dropping Odoo metadata", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("A red square."));
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "inline_data", mimetype: "image/jpeg", data: JPEG, metadata: { attachment_id: 5, image_path: "/web/image/5" } },
              { type: "inline_data", mimetype: "application/json", data: Buffer.from('{"a":1}').toString("base64") },
              { type: "text", text: "<odoo_current_context>discuss.channel</odoo_current_context>" },
            ],
          },
        ],
      }),
    );
    const body = mock.last.body;
    expect(body.model).toBe("grok-4.7");
    expect(body.instructions).toBe("You are Odoo's AI assistant.");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image" },
          { type: "input_image", image_url: `data:image/jpeg;base64,${JPEG}`, detail: "auto" },
          { type: "input_text", text: '{"a":1}' },
          { type: "input_text", text: "<odoo_current_context>discuss.channel</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
    expect(mock.last.rawBody).not.toContain("metadata");
  });

  it("sends only JPEG and PNG as input_image (xAI image understanding formats)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "inline_data", mimetype: "image/jpeg", data: JPEG },
              { type: "inline_data", mimetype: "image/png", data: PNG },
              { type: "inline_data", mimetype: "image/webp", data: "UklGRgAAAABXRUJQ" },
              { type: "inline_data", mimetype: "image/gif", data: "R0lGODlhAQABAAAAACw=" },
            ],
          },
        ],
      }),
    );
    expect(mock.last.body.input[0].content).toEqual([
      { type: "input_image", image_url: `data:image/jpeg;base64,${JPEG}`, detail: "auto" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
      { type: "input_text", text: "[Attached image/webp image omitted: grok only reads image/jpeg, image/png images]" },
      { type: "input_text", text: "[Attached image/gif image omitted: grok only reads image/jpeg, image/png images]" },
    ]);
  });

  it("does not send PDFs as input_file (pdf_input is unsupported)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({ messages: [{ role: "user", content: [{ type: "inline_data", mimetype: "application/pdf", data: "JVBERi0=" }] }] }),
    );
    expect(mock.last.rawBody).not.toContain("input_file");
    expect(mock.last.body.input[0].content[0].type).toBe("input_text");
  });

  it("declares function tools", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        tools: [
          { name: "list_leads", instructions: "List open leads", schema: null },
          { name: "create_lead", instructions: "Create a CRM lead", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        ],
      }),
    );
    expect(mock.last.body.tools).toEqual([
      { type: "function", name: "list_leads", description: "List open leads", parameters: { type: "object", properties: {}, required: [] }, strict: false },
      {
        type: "function",
        name: "create_lead",
        description: "Create a CRM lead",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        strict: false,
      },
    ]);
    expect(mock.last.body.tool_choice).toBe("auto");
    expect(mock.last.body.parallel_tool_calls).toBe(true);
  });

  it("maps maxOutputTokens and merges options", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ maxOutputTokens: 2048, options: { temperature: 0.2, web_search_tool: { allowed_domains: ["odoo.com"] } } }));
    expect(mock.last.body.max_output_tokens).toBe(2048);
    expect(mock.last.body.temperature).toBe(0.2);
    expect(mock.last.body).not.toHaveProperty("web_search_tool");
    expect(mock.last.body).not.toHaveProperty("tools");
  });
});

describe("GrokAdapter.complete: tool loop", () => {
  it("parses a function call and replays it on the next turn", async () => {
    const { mock, adapter } = setup();
    mock.reply(TOOL_CALL_RESPONSE);
    const first = await adapter.complete(request({ tools: [{ name: "create_lead", instructions: "Create a lead", schema: null }] }));
    expect(first.content).toEqual([{ type: "tool_call", name: "create_lead", args: { name: "Big deal", expected_revenue: 5000 }, call_id: "call_61234" }]);
    expect(first.provider_metadata.grok).toEqual({ output: TOOL_CALL_RESPONSE.output, response_id: "resp_grok_tool" });

    const stored: AssistantMessage = JSON.parse(JSON.stringify(first));
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Create a lead named Big deal" }] },
      stored,
      {
        role: "user",
        content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: "call_61234", result: [{ type: "text", text: "Lead #88 created" }], success: true }],
      },
    ];
    mock.reply(textResponseBody("Lead #88 is created."));
    const second = await adapter.complete(request({ messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Create a lead named Big deal" }] },
      TOOL_CALL_RESPONSE.output[0],
      TOOL_CALL_RESPONSE.output[1],
      { type: "function_call_output", call_id: "call_61234", output: "Lead #88 created" },
    ]);
    expect(mock.last.body.include).toEqual(["reasoning.encrypted_content"]);
    expect(second.content).toEqual([{ type: "text", text: "Lead #88 is created." }]);
  });

  it("rebuilds cross-provider history and moves tool result images into a user message", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("It is a bar chart."));
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Show the chart" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "render_chart", args: { period: "Q3" }, call_id: 3 }],
        provider_metadata: {},
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_name: "render_chart",
            tool_call_id: 3,
            result: [
              { type: "text", text: "rendered" },
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 1 } },
            ],
            success: true,
          },
          { type: "text", text: "<odoo_current_context>x</odoo_current_context>" },
        ],
      },
    ];
    await adapter.complete(request({ messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Show the chart" }] },
      { type: "function_call", call_id: "3", name: "render_chart", arguments: '{"period":"Q3"}' },
      { type: "function_call_output", call_id: "3", output: "rendered" },
      {
        role: "user",
        content: [
          { type: "input_text", text: 'Attachments returned by the tool "render_chart":' },
          { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
          { type: "input_text", text: "<odoo_current_context>x</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("rebuilds Grok history without reasoning items for a non-reasoning model", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "Create it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "create_lead", args: { name: "Big deal", expected_revenue: 5000 }, call_id: "call_61234" }],
        provider_metadata: { provider: "grok", grok: { output: TOOL_CALL_RESPONSE.output } },
      },
      { role: "user", content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: "call_61234", result: [{ type: "text", text: "ok" }], success: true }] },
    ];
    await adapter.complete(request({ model: "grok-4.20-0309-non-reasoning", messages: history }));
    expect(mock.last.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Create it" }] },
      { type: "function_call", call_id: "call_61234", name: "create_lead", arguments: '{"name":"Big deal","expected_revenue":5000}' },
      { type: "function_call_output", call_id: "call_61234", output: "ok" },
    ]);
    expect(mock.last.rawBody).not.toContain("xai-enc-tool");
  });

  it("ignores OpenAI replay data (different provider)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello from GPT" }],
            provider_metadata: { provider: "openai", openai: { output: [{ type: "reasoning", id: "rs_openai", encrypted_content: "openai-enc" }] } },
          },
          { role: "user", content: [{ type: "text", text: "Again" }] },
        ],
      }),
    );
    expect(mock.last.body.input[1]).toEqual({ role: "assistant", content: "Hello from GPT" });
    expect(mock.last.rawBody).not.toContain("openai-enc");
  });
});

describe("GrokAdapter.complete: reasoning effort", () => {
  const cases: Array<[string, Effort | undefined, string | undefined]> = [
    ["grok-4.7", "max", "xhigh"],
    ["grok-4.7", "high", "high"],
    ["grok-4.6", "none", "low"],
    ["grok-4.6", "xhigh", "xhigh"],
    ["grok-4.5", "xhigh", "high"],
    ["grok-4.5", "minimal", "low"],
    ["grok-4.3", "none", "none"],
    ["grok-4.3", "minimal", "low"],
    ["grok-4.3", "max", "high"],
    ["grok-3-mini", "medium", "high"],
    ["grok-3-mini", "minimal", "low"],
    ["grok-4.20-0309-reasoning", "high", undefined],
    ["grok-4.20-0309-non-reasoning", "high", undefined],
    ["grok-4.20-multi-agent-0309", "high", undefined],
    ["grok-build-0.1", "high", undefined],
    ["grok-4.7", undefined, undefined],
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

  it("asks for encrypted reasoning only from reasoning models", async () => {
    const { mock, adapter } = setup();
    const includeFor = async (model: string) => {
      mock.reply(textResponseBody("ok"));
      await adapter.complete(request({ model }));
      return mock.last.body.include;
    };
    expect(await includeFor("grok-4.6")).toEqual(["reasoning.encrypted_content"]);
    expect(await includeFor("grok-4.20-0309-reasoning")).toEqual(["reasoning.encrypted_content"]);
    expect(await includeFor("grok-4.20-0309-non-reasoning")).toBeUndefined();
    expect(await includeFor("grok-build-0.1")).toBeUndefined();
  });
});

describe("GrokAdapter.complete: structured output", () => {
  const AI_FIELD_SCHEMA = {
    type: "object",
    properties: { value: { type: "text" } },
    required: ["value"],
    additionalProperties: false,
  };

  it("sends text.format json_schema and returns the JSON text", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody('{"value":"Deco Addict"}'));
    const result = await adapter.complete(request({ schema: AI_FIELD_SCHEMA }));
    expect(mock.last.body.text).toEqual({
      format: {
        type: "json_schema",
        name: "response",
        strict: true,
        schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      },
    });
    expect(result.content).toEqual([{ type: "text", text: '{"value":"Deco Addict"}' }]);
  });

  it("turns inline citations off when web grounding is combined with a schema", async () => {
    const { mock, adapter } = setup();
    const json = '{"value":"Grok 4.7"}';
    mock.reply(textResponseBody(json, [{ type: "url_citation", url: "https://x.ai", title: "1", start_index: 0, end_index: 4 }]));
    const result = await adapter.complete(request({ schema: AI_FIELD_SCHEMA, webGrounding: true }));
    expect(mock.last.body.include).toEqual(["reasoning.encrypted_content", "no_inline_citations"]);
    expect(mock.last.body.tools).toEqual([{ type: "web_search" }]);
    expect(result.content).toEqual([{ type: "text", text: json }]);
  });
});

describe("GrokAdapter.complete: web grounding", () => {
  it("replaces inline [[n]](url) citations with WEB_SOURCE markers named after the domain", async () => {
    const { mock, adapter } = setup();
    const url1 = "https://x.ai/news/grok-4-7";
    const url2 = "https://docs.x.ai/docs/models";
    const link1 = `[[1]](${url1})`;
    const link2 = `[[2]](${url2})`;
    const text = `Grok 4.7 launched in 2026 ${link1}. It has a 500k context window ${link2}.`;
    const s1 = text.indexOf(link1);
    const s2 = text.indexOf(link2);
    mock.reply({
      id: "resp_web",
      status: "completed",
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "grok 4.7" } },
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
                { type: "url_citation", url: url1, title: "1", start_index: s1, end_index: s1 + link1.length },
                { type: "url_citation", url: url2, title: "2", start_index: s2, end_index: s2 + link2.length },
              ],
            },
          ],
        },
      ],
    });
    const result = await adapter.complete(
      request({ webGrounding: true, options: { web_search_tool: { allowed_domains: ["x.ai"] }, x_search_tool: true } }),
    );
    expect(mock.last.body.tools).toEqual([{ type: "web_search", allowed_domains: ["x.ai"] }, { type: "x_search" }]);
    expect(mock.last.body).not.toHaveProperty("x_search_tool");
    const id1 = webSourceId(url1);
    const id2 = webSourceId(url2);
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Grok 4.7 launched in 2026[WEB_SOURCE:${id1}]. It has a 500k context window[WEB_SOURCE:${id2}].`,
        sources: { [id1]: { url: url1, source_name: "x.ai" }, [id2]: { url: url2, source_name: "docs.x.ai" } },
      },
    ]);
  });

  it("handles the documented xAI citation payload (URL with parentheses, no space before the link)", async () => {
    // Text and offsets copied from docs.x.ai "citations" (Responses API, JSON Response Structure).
    const { mock, adapter } = setup();
    const text =
      '**xAI is an artificial intelligence company founded by Elon Musk in March 2023.** Its stated mission is to "understand the universe" by building advanced AI systems that accelerate human scientific discovery.[[1]](https://x.ai/company)\n\n### Key Details\n- **Flagship product**: Grok, a family of frontier AI models focused on reasoning, code, voice, image generation, and video. These are trained on massive infrastructure, including what the company describes as the world\'s largest supercluster (Colossus). Grok powers chatbots, APIs, and multimodal tools available via a unified API.[[2]](https://x.ai/)\n- **Current status (as of mid-2026)**: xAI operates as a subsidiary of SpaceX following an acquisition in February 2026. It is also connected to the X social platform (formerly Twitter), which xAI effectively became the parent of in 2025. The company has expanded into data centers and enterprise AI offerings (e.g., integrations with Amazon Bedrock and Databricks).[[3]](https://en.wikipedia.org/wiki/XAI_(company))';
    const annotations = [
      { type: "url_citation", url: "https://x.ai/company", start_index: 208, end_index: 235, title: "1" },
      { type: "url_citation", url: "https://x.ai/", start_index: 585, end_index: 605, title: "2" },
      { type: "url_citation", url: "https://en.wikipedia.org/wiki/XAI_(company)", start_index: 972, end_index: 1022, title: "3" },
    ];
    mock.reply({
      id: "5808284d-ae14-9981-9289-73515f67ebda",
      object: "response",
      status: "completed",
      output: [{ type: "message", id: "msg_5808284d", role: "assistant", status: "completed", content: [{ type: "output_text", text, logprobs: [], annotations }] }],
    });
    const result = await adapter.complete(request({ webGrounding: true }));
    const part = result.content[0] as { text: string; sources: Record<string, { url: string; source_name: string }> };
    const [a, b, c] = annotations.map((annotation) => webSourceId(annotation.url));
    expect(part.text).toContain(`scientific discovery.[WEB_SOURCE:${a}]\n\n### Key Details`);
    expect(part.text).toContain(`via a unified API.[WEB_SOURCE:${b}]\n- **Current status`);
    expect(part.text.endsWith(`Amazon Bedrock and Databricks).[WEB_SOURCE:${c}]`)).toBe(true);
    expect(part.text).not.toContain("](");
    expect(part.sources).toEqual({
      [a!]: { url: "https://x.ai/company", source_name: "x.ai" },
      [b!]: { url: "https://x.ai/", source_name: "x.ai" },
      [c!]: { url: "https://en.wikipedia.org/wiki/XAI_(company)", source_name: "en.wikipedia.org" },
    });
  });

  it("maps byte offsets when non-ASCII text precedes the citation", async () => {
    const { mock, adapter } = setup();
    const url = "https://www.lemonde.fr/economie/odoo";
    const link = `[[1]](${url})`;
    const text = `Odoo, éditeur belge à Grand-Rosière, a levé des fonds ${link}.`;
    const start = Buffer.byteLength(text.slice(0, text.indexOf(link)), "utf8");
    mock.reply({
      id: "r",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url, title: "1", start_index: start, end_index: start + link.length }] }] }],
    });
    const result = await adapter.complete(request({ webGrounding: true }));
    const id = webSourceId(url);
    expect(result.content).toEqual([
      { type: "text", text: `Odoo, éditeur belge à Grand-Rosière, a levé des fonds[WEB_SOURCE:${id}].`, sources: { [id]: { url, source_name: "lemonde.fr" } } },
    ]);
  });
});

describe("GrokAdapter.complete: image generation", () => {
  const imageRequest = (overrides: Partial<CompletionRequest> = {}) =>
    request({
      model: "grok-imagine-image-2.0",
      imageGeneration: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello" }], provider_metadata: {} },
        {
          role: "user",
          content: [
            { type: "text", text: "A watercolor fox in a snowy forest" },
            { type: "text", text: "<odoo_current_context>\nmodel: website.page\n</odoo_current_context>" },
          ],
        },
      ],
      ...overrides,
    });

  it("calls /images/generations with the last user prompt and returns inline_data", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ b64_json: PNG, mime_type: "image/png", revised_prompt: "A watercolor fox..." }] });
    const result = await adapter.complete(imageRequest({ aspectRatio: "16:9", options: { image_generation_tool: { resolution: "2k" } } }));
    expect(mock.last.url).toBe("https://api.x.ai/v1/images/generations");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.body).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "A watercolor fox in a snowy forest",
      n: 1,
      aspect_ratio: "16:9",
      response_format: "b64_json",
      resolution: "2k",
    });
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/png", data: PNG }]);
    expect(result.provider_metadata.provider).toBe("grok");
  });

  it("uses auto for aspect ratios xAI does not list and defaults the mimetype to JPEG", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ b64_json: JPEG }] });
    const result = await adapter.complete(imageRequest({ aspectRatio: "5:4" }));
    expect(mock.last.body.aspect_ratio).toBe("auto");
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/jpeg", data: JPEG }]);
  });

  it("types the image from its bytes when mime_type is missing", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [{ b64_json: PNG }] });
    const result = await adapter.complete(imageRequest());
    expect(result.content).toEqual([{ type: "inline_data", mimetype: "image/png", data: PNG }]);
  });

  it("maps a response without images to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ data: [] });
    await expect(adapter.complete(imageRequest())).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("GrokAdapter.complete: errors", () => {
  it("maps HTTP 400 to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ code: "Client specified an invalid argument", error: "Model grok-9 does not exist or your team does not have access to it." }, 400);
    const error = await adapter.complete(request({ model: "grok-9" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as Error).message).toContain("grok-9 does not exist");
  });

  it("maps a failed response to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "r", status: "failed", error: { code: "internal_error", message: "upstream failure" }, output: [] });
    await expect(adapter.complete(request())).rejects.toThrow(/upstream failure/);
  });

  it("maps an incomplete empty response to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });
    await expect(adapter.complete(request())).rejects.toThrow(/content_filter/);
  });
});

describe("GrokAdapter.supports", () => {
  it("reports the capability matrix", () => {
    const { adapter } = setup();
    const yes: Feature[] = ["completion", "tools", "schema", "tools+schema", "image_input", "web_grounding", "web_grounding+schema", "transcription"];
    const no: Feature[] = ["pdf_input", "audio_input", "embeddings", "realtime", "image_generation"];
    for (const feature of yes) expect(adapter.supports(feature, "grok-4.7")).toBe(true);
    for (const feature of no) expect(adapter.supports(feature, "grok-4.7")).toBe(false);
    expect(adapter.supports("image_generation", "grok-imagine-image-2.0")).toBe(true);
    expect(adapter.supports("image_generation", "grok-imagine-image-quality")).toBe(true);
  });

  it("rejects embeddings and realtime sessions", async () => {
    const { adapter } = setup();
    const signal = new AbortController().signal;
    await expect(adapter.embed({ model: "x", inputs: [{ content: "a" }], mode: "query", dimensions: 1536, signal })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
    await expect(adapter.createRealtimeSession({ model: "x", signal })).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});

describe("GrokAdapter.transcribe", () => {
  const AUDIO = Buffer.from("OggS fake audio").toString("base64");
  const STT_RESPONSE = {
    text: "Hello everyone. Let's start the meeting.",
    language: "en",
    duration: 3.2,
    words: [
      { text: "Hello", start: 0.0, end: 0.4, confidence: 0.99 },
      { text: "everyone.", start: 0.45, end: 1.0, confidence: 0.98 },
      { text: "Let's", start: 1.5, end: 1.8, confidence: 0.97 },
      { text: "start", start: 1.85, end: 2.1, confidence: 0.99 },
      { text: "the", start: 2.15, end: 2.3, confidence: 0.99 },
      { text: "meeting.", start: 2.35, end: 3.0, confidence: 0.99 },
    ],
  };

  it("posts multipart to /stt with the file last and returns plain text", async () => {
    const { mock, adapter } = setup();
    mock.reply(STT_RESPONSE);
    const text = await adapter.transcribe({ model: "grok-stt", audio: AUDIO, mimetype: "audio/ogg", language: "en", signal: new AbortController().signal });
    expect(text).toBe("Hello everyone. Let's start the meeting.");
    expect(mock.last.url).toBe("https://api.x.ai/v1/stt");
    expect(mock.last.headers.authorization).toBe("Bearer test-key");
    expect(mock.last.headers["content-type"]).toBeUndefined();
    const form = mock.last.body as FormData;
    expect([...form.keys()]).toEqual(["language", "format", "file"]);
    expect(form.get("format")).toBe("true");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(AUDIO);
  });

  it("sends array options (keyterm) as repeated fields, still before the file", async () => {
    const { mock, adapter } = setup();
    mock.reply(STT_RESPONSE);
    await adapter.transcribe({
      model: "grok-stt",
      audio: AUDIO,
      mimetype: "audio/ogg",
      options: { keyterm: ["Odoo", "Grand-Rosière"], diarize: true },
      signal: new AbortController().signal,
    });
    const form = mock.last.body as FormData;
    expect([...form.keys()]).toEqual(["format", "keyterm", "keyterm", "diarize", "file"]);
    expect(form.getAll("keyterm")).toEqual(["Odoo", "Grand-Rosière"]);
    expect(form.get("diarize")).toBe("true");
  });

  it("builds VTT cues from word timings", async () => {
    const { mock, adapter } = setup();
    mock.reply(STT_RESPONSE);
    const vtt = await adapter.transcribe({ model: "grok-stt", audio: AUDIO, mimetype: "audio/mp3", responseFormat: "vtt", signal: new AbortController().signal });
    expect(vtt).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.000\nHello everyone. Let's start the meeting.\n");
    expect(((mock.last.body as FormData).get("file") as File).name).toBe("audio.mp3");
  });

  it("falls back to a single cue when no word timings are returned", async () => {
    const { mock, adapter } = setup();
    mock.reply({ text: "Short note.", words: [] });
    const vtt = await adapter.transcribe({ model: "grok-stt", audio: AUDIO, mimetype: "audio/webm", responseFormat: "vtt", signal: new AbortController().signal });
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> ")).toBe(true);
    expect(vtt).toContain("Short note.");
  });

  it("maps HTTP errors to ProviderError", async () => {
    const { mock, adapter } = setup();
    mock.reply({ error: "Unsupported audio format" }, 400);
    await expect(
      adapter.transcribe({ model: "grok-stt", audio: AUDIO, mimetype: "audio/ogg", signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("GrokAdapter.complete: prompt_cache_key", () => {
  const conversationId = "cv_AAAAAAAAAAAAAAAAAAAAAA";

  it("sends the conversation id by default (xAI routes the key to the server holding the cache)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request({ conversationId }));
    expect(mock.last.body.prompt_cache_key).toBe(conversationId);
    expect(mock.last.headers).not.toHaveProperty("x-grok-conv-id");
  });

  it("sends none without a conversation id", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok"));
    await adapter.complete(request());
    expect(mock.last.body).not.toHaveProperty("prompt_cache_key");
  });

  it("lets options.prompt_cache_key replace it (string) or turn it off (false)", async () => {
    const { mock, adapter } = setup();
    mock.reply(textResponseBody("ok")).reply(textResponseBody("ok"));
    await adapter.complete(request({ conversationId, options: { prompt_cache_key: "shared" } }));
    expect(mock.last.body.prompt_cache_key).toBe("shared");
    await adapter.complete(request({ conversationId, options: { prompt_cache_key: false } }));
    expect(mock.last.body).not.toHaveProperty("prompt_cache_key");
  });
});
