import { describe, expect, it } from "vitest";

import { ProviderError, UnsupportedFeatureError } from "../../src/core/errors.js";
import type { AssistantMessage, OdooMessage, OdooTool, UserMessage } from "../../src/core/odoo-types.js";
import { webSourceId } from "../../src/providers/citations.js";
import { GeminiAdapter } from "../../src/providers/gemini.js";
import type { CompletionRequest, Effort, EmbeddingRequest, Feature, TranscriptionRequest } from "../../src/providers/types.js";
import { MockFetch, type RecordedCall, jsonResponse } from "../helpers/mock-fetch.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSPj4Kc3RyZWFtCg==";
const SIGNATURE = "CiQBjz1rX2vT0pWm3lNcS0o8wG4b1kqz7Xq9aF0uYt2LwPpVb0ESbQGPPWtf";

function setup(settings: { baseUrl?: string; headers?: Record<string, string> } = {}) {
  const mock = new MockFetch();
  const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: mock.fetch, ...settings });
  return { mock, adapter };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "gemini-3.5-flash",
    instructions: "You are Odoo's AI assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    webGrounding: false,
    imageGeneration: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A generateContent response the way Gemini 3 returns it. */
function geminiResponse(parts: unknown[], extra: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0, ...candidate }],
    usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 41, thoughtsTokenCount: 96, totalTokenCount: 949 },
    modelVersion: "gemini-3.5-flash",
    responseId: "p2TaaOz6JI2vkdUP0aW7gAQ",
    ...extra,
  };
}

const TOOLS: OdooTool[] = [
  {
    name: "search_partners",
    instructions: "Search contacts by name.",
    schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "int" } }, required: ["query"] },
  },
  { name: "get_company", instructions: "Return the current company.", schema: null },
];

/** Odoo's `ai_field` schema, including its `{"type": "text"}` quirk. */
const AI_FIELD_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "text" },
    confidence: { type: "number" },
  },
  required: ["value"],
};

describe("GeminiAdapter: request", () => {
  it("posts to generateContent with the API key header and the extra headers", async () => {
    const { mock, adapter } = setup({ headers: { "x-goog-user-project": "odoo-gw" } });
    mock.reply(geminiResponse([{ text: "Hi!" }]));
    const signal = new AbortController().signal;
    await adapter.complete(request({ model: "models/gemini-3.5-flash", signal }));

    expect(mock.last.url).toBe(`${BASE}/models/gemini-3.5-flash:generateContent`);
    expect(mock.last.method).toBe("POST");
    expect(mock.last.headers["x-goog-api-key"]).toBe("test-key");
    expect(mock.last.headers["x-goog-user-project"]).toBe("odoo-gw");
    expect(mock.last.headers["content-type"]).toBe("application/json");
    expect(mock.last.headers.authorization).toBeUndefined();
    expect(mock.last.signal).toBe(signal);
  });

  it("honours a custom base URL", async () => {
    const { mock, adapter } = setup({ baseUrl: "https://proxy.example.com/gemini/v1beta/" });
    mock.reply(geminiResponse([{ text: "Hi!" }]));
    await adapter.complete(request());
    expect(mock.last.url).toBe("https://proxy.example.com/gemini/v1beta/models/gemini-3.5-flash:generateContent");
  });

  it("sends the instructions as systemInstruction and omits it when empty", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "Hi!" }])).reply(geminiResponse([{ text: "Hi!" }]));

    await adapter.complete(request());
    expect(mock.calls[0]!.body.systemInstruction).toEqual({ parts: [{ text: "You are Odoo's AI assistant." }] });
    expect(mock.calls[0]!.body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
    expect(mock.calls[0]!.body).not.toHaveProperty("tools");
    expect(mock.calls[0]!.body).not.toHaveProperty("toolConfig");
    expect(mock.calls[0]!.body).not.toHaveProperty("generationConfig");

    await adapter.complete(request({ instructions: "" }));
    expect(mock.calls[1]!.body).not.toHaveProperty("systemInstruction");
  });

  it("translates text, images, PDFs and audio to inlineData without Odoo's metadata", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "A logo and an invoice." }]));
    await adapter.complete(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in these files?" },
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 42, image_path: "/web/image/42" } },
              { type: "inline_data", mimetype: "image/jpeg", data: PNG },
              { type: "inline_data", mimetype: "application/pdf", data: PDF, metadata: { attachment_id: 43 } },
              { type: "inline_data", mimetype: "audio/mpeg", data: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4" },
              { type: "text", text: "" },
              { type: "text", text: "<odoo_current_context>res.partner(7)</odoo_current_context>" },
            ],
          },
        ],
      }),
    );
    expect(mock.last.body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "What is in these files?" },
          { inlineData: { mimeType: "image/png", data: PNG } },
          { inlineData: { mimeType: "image/jpeg", data: PNG } },
          { inlineData: { mimeType: "application/pdf", data: PDF } },
          { inlineData: { mimeType: "audio/mpeg", data: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4" } },
          { text: "<odoo_current_context>res.partner(7)</odoo_current_context>" },
        ],
      },
    ]);
    expect(mock.last.rawBody).not.toContain("attachment_id");
  });

  it("declares Odoo tools as functionDeclarations with plain JSON Schema parameters", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "ok" }]));
    await adapter.complete(request({ tools: TOOLS }));
    expect(mock.last.body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "search_partners",
            description: "Search contacts by name.",
            parametersJsonSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "integer" } },
              required: ["query"],
            },
          },
          {
            name: "get_company",
            description: "Return the current company.",
            parametersJsonSchema: { type: "object", properties: {}, required: [] },
          },
        ],
      },
    ]);
    expect(mock.last.body).not.toHaveProperty("toolConfig");
  });

  it("maps maxOutputTokens and merges config options (generationConfig recursively)", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "ok" }]));
    await adapter.complete(
      request({
        effort: "low",
        maxOutputTokens: 2048,
        options: {
          generationConfig: { temperature: 0.2, thinkingConfig: { includeThoughts: false } },
          safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
        },
      }),
    );
    expect(mock.last.body.generationConfig).toEqual({
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: "low", includeThoughts: false },
      temperature: 0.2,
    });
    expect(mock.last.body.safetySettings).toEqual([{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }]);
  });
});

describe("GeminiAdapter: effort", () => {
  const cases: Array<[string, Effort | undefined, Record<string, unknown> | undefined]> = [
    ["gemini-3.5-flash", undefined, undefined],
    ["gemini-3.5-flash", "none", { thinkingLevel: "minimal" }],
    ["gemini-3.5-flash", "minimal", { thinkingLevel: "minimal" }],
    ["gemini-3.5-flash", "low", { thinkingLevel: "low" }],
    ["gemini-3.5-flash", "medium", { thinkingLevel: "medium" }],
    ["gemini-3.5-flash", "high", { thinkingLevel: "high" }],
    ["gemini-3.5-flash", "xhigh", { thinkingLevel: "high" }],
    ["gemini-3.8-flash", "max", { thinkingLevel: "high" }],
    ["gemini-3.1-flash-lite", "none", { thinkingLevel: "minimal" }],
    ["gemini-3.1-pro-preview", "none", { thinkingLevel: "low" }],
    ["gemini-3.1-pro-preview", "minimal", { thinkingLevel: "low" }],
    ["gemini-3.1-pro-preview", "medium", { thinkingLevel: "medium" }],
    ["gemini-3.1-pro-preview", "max", { thinkingLevel: "high" }],
    ["gemini-flash-latest", "low", { thinkingLevel: "low" }],
    ["gemini-4-flash", "xhigh", { thinkingLevel: "high" }],
    ["gemini-2.5-flash", "none", { thinkingBudget: 0 }],
    ["gemini-2.5-flash", "minimal", { thinkingBudget: 512 }],
    ["gemini-2.5-flash", "low", { thinkingBudget: 1024 }],
    ["gemini-2.5-flash", "medium", { thinkingBudget: 8192 }],
    ["gemini-2.5-flash", "high", { thinkingBudget: 16384 }],
    ["gemini-2.5-flash", "xhigh", { thinkingBudget: 24576 }],
    ["gemini-2.5-flash", "max", { thinkingBudget: 24576 }],
    ["gemini-2.5-flash-lite", "none", { thinkingBudget: 0 }],
    ["gemini-2.5-pro", "none", { thinkingBudget: 128 }],
    ["gemini-2.5-pro", "xhigh", { thinkingBudget: 24576 }],
    ["gemini-2.5-pro", "max", { thinkingBudget: 32768 }],
    ["gemini-3.1-flash-image", "high", undefined],
    ["gemini-2.5-flash-image", "low", undefined],
    ["gemini-2.0-flash", "high", undefined],
    ["gemini-1.5-pro", "medium", undefined],
    // Regression: other families served by the API (Gemma) reject thinkingConfig.
    ["gemma-3-27b-it", "low", undefined],
    ["models/gemma-3-12b-it", "none", undefined],
  ];

  for (const [model, effort, expected] of cases) {
    it(`${model} with effort ${effort ?? "unset"} -> ${expected ? JSON.stringify(expected) : "no thinkingConfig"}`, async () => {
      const { mock, adapter } = setup();
      mock.reply(geminiResponse([{ text: "ok" }]));
      await adapter.complete(request({ model, ...(effort ? { effort } : {}) }));
      const thinking = mock.last.body.generationConfig?.thinkingConfig;
      expect(thinking).toEqual(expected);
      if (thinking) expect("thinkingLevel" in thinking && "thinkingBudget" in thinking).toBe(false);
    });
  }
});

describe("GeminiAdapter: tool calls and replay", () => {
  const user: UserMessage = { role: "user", content: [{ type: "text", text: "Find Azure Interior and tell me our company." }] };

  it("parses parallel function calls into tool_call parts (args object, string call_id)", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([
        { functionCall: { id: "fc_7b1q", name: "search_partners", args: { query: "Azure", limit: 5 } }, thoughtSignature: SIGNATURE },
        { functionCall: { id: "fc_7b2r", name: "get_company", args: {} } },
      ]),
    );
    const message = await adapter.complete(request({ messages: [user], tools: TOOLS }));
    expect(message).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          name: "search_partners",
          args: { query: "Azure", limit: 5 },
          call_id: "fc_7b1q",
          provider_data: { gemini: { thought_signature: SIGNATURE, id: "fc_7b1q" } },
        },
        { type: "tool_call", name: "get_company", args: {}, call_id: "fc_7b2r", provider_data: { gemini: { id: "fc_7b2r" } } },
      ],
      provider_metadata: {
        usage: { promptTokenCount: 812, candidatesTokenCount: 41, thoughtsTokenCount: 96, totalTokenCount: 949 },
        gemini: { model_version: "gemini-3.5-flash" },
      },
    });
  });

  it("generates unique call ids when Gemini sends none (Gemini 2.5) and defaults args to {}", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([
        { functionCall: { name: "get_company" }, thoughtSignature: SIGNATURE },
        { functionCall: { name: "get_company" } },
      ]),
    );
    const message = await adapter.complete(request({ model: "gemini-2.5-flash", messages: [user], tools: TOOLS }));
    const [first, second] = message.content.filter((part) => part.type === "tool_call");
    expect(first).toEqual({
      type: "tool_call",
      name: "get_company",
      args: {},
      call_id: expect.stringMatching(/^call_0_get_company_[0-9a-f]{8}$/),
      provider_data: { gemini: { thought_signature: SIGNATURE } },
    });
    expect(second).toEqual({ type: "tool_call", name: "get_company", args: {}, call_id: expect.stringMatching(/^call_1_get_company_[0-9a-f]{8}$/) });
    expect(first!.call_id).not.toBe(second!.call_id);
  });

  it("builds the next turn from its own answer: ids, signatures and function responses", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([
        { text: "Let me look that up.", thoughtSignature: "c2lnLXRleHQ=" },
        { functionCall: { id: "fc_7b1q", name: "search_partners", args: { query: "Azure" } }, thoughtSignature: SIGNATURE },
        { functionCall: { id: "fc_7b2r", name: "get_company", args: {} } },
      ]),
    );
    const first = await adapter.complete(request({ messages: [user], tools: TOOLS }));
    // What Odoo sends back: the stored message, stamped by the completion service.
    const stored: AssistantMessage = { ...first, provider_metadata: { provider: "gemini", model: "gemini-3.5-flash", ...first.provider_metadata } };
    const results: UserMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_name: "search_partners",
          tool_call_id: "fc_7b1q",
          success: true,
          result: [
            { type: "text", text: '[{"id": 14, "name": "Azure Interior"}]' },
            { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { attachment_id: 9 } },
          ],
        },
        { type: "tool_result", tool_name: "get_company", tool_call_id: "fc_7b2r", success: false, result: [{ type: "text", text: "Error: access denied" }] },
      ],
    };

    mock.reply(geminiResponse([{ text: "Azure Interior is contact #14." }]));
    await adapter.complete(request({ messages: [user, stored, results], tools: TOOLS }));
    expect(mock.last.body.contents).toEqual([
      { role: "user", parts: [{ text: "Find Azure Interior and tell me our company." }] },
      {
        role: "model",
        parts: [
          { text: "Let me look that up.", thoughtSignature: "c2lnLXRleHQ=" },
          { functionCall: { id: "fc_7b1q", name: "search_partners", args: { query: "Azure" } }, thoughtSignature: SIGNATURE },
          { functionCall: { id: "fc_7b2r", name: "get_company", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "fc_7b1q", name: "search_partners", response: { result: '[{"id": 14, "name": "Azure Interior"}]' } } },
          { functionResponse: { id: "fc_7b2r", name: "get_company", response: { error: "Error: access denied" } } },
          { inlineData: { mimeType: "image/png", data: PNG } },
        ],
      },
    ]);
  });

  it("rebuilds cross-provider history: numeric call ids, no Gemini ids, placeholder signature", async () => {
    const { mock, adapter } = setup();
    const history: OdooMessage[] = [
      user,
      {
        role: "assistant",
        content: [
          { type: "tool_call", name: "search_partners", args: { query: "Azure" }, call_id: 1 },
          { type: "tool_call", name: "get_company", args: {}, call_id: 2 },
        ],
        provider_metadata: {},
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_name: "search_partners", tool_call_id: 1, success: true, result: [{ type: "text", text: "Azure Interior (14)" }] },
          { type: "tool_result", tool_name: "get_company", tool_call_id: 2, success: true, result: [] },
        ],
      },
    ];
    mock.reply(geminiResponse([{ text: "Done." }]));
    await adapter.complete(request({ messages: history, tools: TOOLS }));
    expect(mock.last.body.contents.slice(1)).toEqual([
      {
        role: "model",
        parts: [
          { functionCall: { name: "search_partners", args: { query: "Azure" } }, thoughtSignature: "skip_thought_signature_validator" },
          { functionCall: { name: "get_company", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "search_partners", response: { result: "Azure Interior (14)" } } },
          { functionResponse: { name: "get_company", response: { result: "success" } } },
        ],
      },
    ]);
  });

  it("ignores Gemini data on messages stamped by another provider and merges same-role turns", async () => {
    const { mock, adapter } = setup();
    const history: OdooMessage[] = [
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "get_company", args: {}, call_id: "call_abc", provider_data: { gemini: { id: "stale", thought_signature: "stale" } } }],
        provider_metadata: { provider: "openai", model: "gpt-5.6" },
      },
      { role: "user", content: [{ type: "tool_result", tool_name: "get_company", tool_call_id: "call_abc", success: true, result: [{ type: "text", text: "YourCompany" }] }] },
    ];
    mock.reply(geminiResponse([{ text: "YourCompany." }]));
    await adapter.complete(request({ messages: history, tools: TOOLS }));
    expect(mock.last.body.contents).toEqual([
      { role: "user", parts: [{ text: "First" }, { text: "Second" }] },
      { role: "model", parts: [{ functionCall: { name: "get_company", args: {} }, thoughtSignature: "skip_thought_signature_validator" }] },
      { role: "user", parts: [{ functionResponse: { name: "get_company", response: { result: "YourCompany" } } }] },
    ]);
  });

  it("joins consecutive text parts but keeps text around images and server-side tool parts apart (regression)", async () => {
    const { mock, adapter } = setup();
    const toolCall = { toolCall: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["logo"] } } };
    mock.reply(
      geminiResponse([
        { text: "Thinking...", thought: true },
        { text: "Here is " },
        { text: "the logo." },
        { inlineData: { mimeType: "image/png", data: PNG } },
        { text: "Want " },
        { text: "changes?" },
        toolCall,
        { text: " Searched too." },
      ]),
    );
    const message = await adapter.complete(request());
    expect(message.content).toEqual([
      { type: "text", text: "Here is the logo." },
      { type: "inline_data", mimetype: "image/png", data: PNG },
      { type: "text", text: "Want changes?" },
      { type: "text", text: " Searched too.", provider_data: { gemini: { parts_before: [toolCall] } } },
    ]);
  });

  it("drops thought parts from the answer", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "Thinking about partners...", thought: true }, { text: "Here you go." }]));
    const message = await adapter.complete(request());
    expect(message.content).toEqual([{ type: "text", text: "Here you go." }]);
  });
});

describe("GeminiAdapter: structured output", () => {
  it("sends responseJsonSchema (normalized) and returns the JSON text", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: '{"value": "Azure Interior", "confidence": 0.92}' }]));
    const message = await adapter.complete(request({ schema: AI_FIELD_SCHEMA }));
    expect(mock.last.body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { value: { type: "string" }, confidence: { type: "number" } },
        required: ["value"],
      },
    });
    expect(message.content).toEqual([{ type: "text", text: '{"value": "Azure Interior", "confidence": 0.92}' }]);
    expect(JSON.parse((message.content[0] as { text: string }).text)).toEqual({ value: "Azure Interior", confidence: 0.92 });
  });

  it("joins split text parts, strips fences and never inserts citation markers", async () => {
    const { mock, adapter } = setup();
    const json = '{"value": "12 kg"}';
    mock.reply(
      geminiResponse([{ text: "```json\n" + json.slice(0, 8) }, { text: json.slice(8) + "\n```" }], {}, {
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/X", title: "example.com" } }],
          groundingSupports: [{ segment: { endIndex: 5, text: '{"val' }, groundingChunkIndices: [0] }],
        },
      }),
    );
    const message = await adapter.complete(request({ model: "gemini-3.5-flash", schema: AI_FIELD_SCHEMA, webGrounding: true }));
    expect(mock.last.body.tools).toEqual([{ googleSearch: {} }]);
    expect(message.content).toEqual([{ type: "text", text: json }]);
  });

  it("keeps the signature of the last JSON fragment on the merged part (regression)", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: '{"value": ' }, { text: '"12 kg"}', thoughtSignature: "c2NoZW1h" }]));
    const message = await adapter.complete(request({ schema: AI_FIELD_SCHEMA }));
    expect(message.content).toEqual([{ type: "text", text: '{"value": "12 kg"}', provider_data: { gemini: { thought_signature: "c2NoZW1h" } } }]);
  });
});

describe("GeminiAdapter: web grounding", () => {
  const seg1 = "Zürich hat rund 447’000 Einwohner.";
  const seg2 = "Die Stadt liegt am Zürichsee 🌊.";
  const text = `${seg1} ${seg2}`;
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  const uriA = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHa1";
  const uriB = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHb2";

  it("adds the googleSearch tool and turns byte-offset supports into WEB_SOURCE markers", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([{ text }], {}, {
        groundingMetadata: {
          webSearchQueries: ["Zürich Einwohner"],
          searchEntryPoint: { renderedContent: "<style></style>" },
          groundingChunks: [{ web: { uri: uriA, title: "stadt-zuerich.ch" } }, { web: { uri: uriB, title: "de.wikipedia.org" } }],
          groundingSupports: [
            { segment: { endIndex: bytes(seg1), text: seg1 }, groundingChunkIndices: [0, 1], confidenceScores: [0.97, 0.9] },
            {
              segment: { partIndex: 0, startIndex: bytes(`${seg1} `), endIndex: bytes(text), text: seg2 },
              groundingChunkIndices: [1],
              confidenceScores: [0.88],
            },
          ],
        },
      }),
    );
    const message = await adapter.complete(request({ webGrounding: true }));
    expect(mock.last.body.tools).toEqual([{ googleSearch: {} }]);
    expect(mock.last.body).not.toHaveProperty("toolConfig");

    const a = webSourceId(uriA);
    const b = webSourceId(uriB);
    expect(message.content).toEqual([
      {
        type: "text",
        text: `${seg1}[WEB_SOURCE:${a}][WEB_SOURCE:${b}] ${seg2}[WEB_SOURCE:${b}]`,
        sources: {
          [a]: { url: uriA, source_name: "stadt-zuerich.ch" },
          [b]: { url: uriB, source_name: "de.wikipedia.org" },
        },
      },
    ]);
  });

  it("merges a grounded answer split over several parts into one text part (regression)", async () => {
    // Odoo's web search tool reads only `_get_direct_response(...)[0]` (text + sources) and
    // `get_text_from_parts` joins parts with "\n": the whole answer must be a single text part.
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([{ text: `${seg1} ` }, { text: seg2, thoughtSignature: "c2lnLWxhc3Q=" }], {}, {
        groundingMetadata: {
          groundingChunks: [{ web: { uri: uriA, title: "stadt-zuerich.ch" } }, { web: { uri: uriB, title: "de.wikipedia.org" } }],
          groundingSupports: [
            { segment: { endIndex: bytes(seg1), text: seg1 }, groundingChunkIndices: [0] },
            // Offsets are relative to part 1, not to the whole answer.
            { segment: { partIndex: 1, endIndex: bytes(seg2), text: seg2 }, groundingChunkIndices: [1] },
          ],
        },
      }),
    );
    const message = await adapter.complete(request({ webGrounding: true }));
    const a = webSourceId(uriA);
    const b = webSourceId(uriB);
    expect(message.content).toEqual([
      {
        type: "text",
        text: `${seg1}[WEB_SOURCE:${a}] ${seg2}[WEB_SOURCE:${b}]`,
        sources: { [a]: { url: uriA, source_name: "stadt-zuerich.ch" }, [b]: { url: uriB, source_name: "de.wikipedia.org" } },
        provider_data: { gemini: { thought_signature: "c2lnLWxhc3Q=" } },
      },
    ]);
  });

  it("falls back to searching segment.text when the offsets do not match", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse([{ text }], {}, {
        groundingMetadata: {
          groundingChunks: [{ web: { uri: uriB, title: "de.wikipedia.org" } }],
          // Character offsets instead of bytes: off by the multi-byte characters before it.
          groundingSupports: [{ segment: { startIndex: seg1.length + 1, endIndex: text.length, text: seg2 }, groundingChunkIndices: [0] }],
        },
      }),
    );
    const message = await adapter.complete(request({ webGrounding: true }));
    expect(message.content[0]).toMatchObject({ text: `${seg1} ${seg2}[WEB_SOURCE:${webSourceId(uriB)}]` });
  });

  it("combines search with function calling and replays the server-side tool parts", async () => {
    const { mock, adapter } = setup();
    const toolCall = { toolCall: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["Azure Interior"] } }, thoughtSignature: "c2Vydg==" };
    const toolResponse = { toolResponse: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", response: { search_suggestions: "" } } };
    mock.reply(geminiResponse([toolCall, toolResponse, { functionCall: { id: "fc_1", name: "get_company", args: {} }, thoughtSignature: SIGNATURE }]));
    const first = await adapter.complete(
      request({ webGrounding: true, tools: TOOLS, options: { web_search_tool: { excludeDomains: ["example.org"] }, toolConfig: { functionCallingConfig: { mode: "AUTO" } } } }),
    );
    expect(mock.last.body.tools).toEqual([
      expect.objectContaining({ functionDeclarations: expect.any(Array) }),
      { googleSearch: { excludeDomains: ["example.org"] } },
    ]);
    expect(mock.last.body.toolConfig).toEqual({ includeServerSideToolInvocations: true, functionCallingConfig: { mode: "AUTO" } });
    expect(mock.last.body).not.toHaveProperty("web_search_tool");
    expect(first.content).toEqual([
      {
        type: "tool_call",
        name: "get_company",
        args: {},
        call_id: "fc_1",
        provider_data: { gemini: { thought_signature: SIGNATURE, id: "fc_1", parts_before: [toolCall, toolResponse] } },
      },
    ]);

    mock.reply(geminiResponse([{ text: "YourCompany." }]));
    const results: UserMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_name: "get_company", tool_call_id: "fc_1", success: true, result: [{ type: "text", text: "YourCompany" }] }],
    };
    await adapter.complete(request({ webGrounding: true, tools: TOOLS, messages: [request().messages[0]!, first, results] }));
    expect(mock.last.body.contents[1]).toEqual({
      role: "model",
      parts: [toolCall, toolResponse, { functionCall: { id: "fc_1", name: "get_company", args: {} }, thoughtSignature: SIGNATURE }],
    });
    expect(mock.last.body.contents[2].parts[0]).toEqual({ functionResponse: { id: "fc_1", name: "get_company", response: { result: "YourCompany" } } });
  });
});

describe("GeminiAdapter: image generation", () => {
  it("asks for TEXT and IMAGE with the aspect ratio and returns inline_data parts", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      geminiResponse(
        [
          { text: "Here is a minimalist logo." },
          { inlineData: { mimeType: "image/png", data: PNG }, thoughtSignature: "aW1hZ2Utc2ln" },
        ],
        { modelVersion: "gemini-3.1-flash-image" },
      ),
    );
    const message = await adapter.complete(request({ model: "gemini-3.1-flash-image", imageGeneration: true, aspectRatio: "16:9", effort: "high" }));
    expect(mock.last.url).toBe(`${BASE}/models/gemini-3.1-flash-image:generateContent`);
    expect(mock.last.body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } });
    expect(message.content).toEqual([
      { type: "text", text: "Here is a minimalist logo." },
      { type: "inline_data", mimetype: "image/png", data: PNG, provider_data: { gemini: { thought_signature: "aW1hZ2Utc2ln" } } },
    ]);
    expect(message.provider_metadata.gemini).toEqual({ model_version: "gemini-3.1-flash-image" });
  });

  it("replays generated images with their signature (placeholder for foreign images)", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ inlineData: { mimeType: "image/png", data: PNG } }]));
    await adapter.complete(
      request({
        model: "gemini-3.1-flash-image",
        imageGeneration: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "Draw a chair" }] },
          {
            role: "assistant",
            content: [
              { type: "inline_data", mimetype: "image/png", data: PNG, metadata: { aspect_ratio: "1:1" }, provider_data: { gemini: { thought_signature: "aW1n" } } },
            ],
            provider_metadata: { provider: "gemini" },
          },
          { role: "assistant", content: [{ type: "inline_data", mimetype: "image/png", data: PNG }], provider_metadata: {} },
          { role: "user", content: [{ type: "text", text: "Make it blue" }] },
        ],
      }),
    );
    expect(mock.last.body.contents[1]).toEqual({
      role: "model",
      parts: [
        { inlineData: { mimeType: "image/png", data: PNG }, thoughtSignature: "aW1n" },
        { inlineData: { mimeType: "image/png", data: PNG }, thoughtSignature: "skip_thought_signature_validator" },
      ],
    });
  });
});

describe("GeminiAdapter: errors", () => {
  it("maps HTTP 400 to ProviderError with Gemini's message", async () => {
    const { mock, adapter } = setup();
    mock.reply(
      jsonResponse(
        { error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts.", status: "INVALID_ARGUMENT" } },
        400,
      ),
    );
    const error = await adapter.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect((error as ProviderError).message).toContain("HTTP 400: Function call is missing a thought_signature");
  });

  it("rejects a blocked prompt", async () => {
    const { mock, adapter } = setup();
    mock.reply({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 10 }, modelVersion: "gemini-3.5-flash" });
    await expect(adapter.complete(request())).rejects.toThrow(/prompt blocked by Gemini \(PROHIBITED_CONTENT\)/);
  });

  it("rejects candidates without usable parts, naming the finish reason", async () => {
    const { mock, adapter } = setup();
    mock
      .reply({ candidates: [{ finishReason: "SAFETY", index: 0, safetyRatings: [] }], modelVersion: "gemini-3.5-flash" })
      .reply(geminiResponse([], {}, { finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "Malformed function call: get_company(" }))
      .reply(geminiResponse([{ text: "" }]))
      .reply({ candidates: [], modelVersion: "gemini-3.5-flash" });
    await expect(adapter.complete(request())).rejects.toThrow(/blocked by Gemini \(SAFETY\)/);
    await expect(adapter.complete(request())).rejects.toThrow(/malformed function call \(MALFORMED_FUNCTION_CALL\)/);
    await expect(adapter.complete(request())).rejects.toThrow(/empty response \(finishReason STOP\)/);
    await expect(adapter.complete(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it("lets aborts propagate", async () => {
    const { mock, adapter } = setup();
    const controller = new AbortController();
    controller.abort();
    mock.reply(geminiResponse([{ text: "never" }]));
    await expect(adapter.complete(request({ signal: controller.signal }))).rejects.toThrow(/abort/i);
  });
});

describe("GeminiAdapter: supports()", () => {
  const always: Feature[] = ["completion", "tools", "schema", "web_grounding", "image_input", "pdf_input", "audio_input", "transcription"];
  const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: new MockFetch().fetch });

  it("supports the common features on current models", () => {
    for (const feature of always) expect(adapter.supports(feature, "gemini-3.5-flash"), feature).toBe(true);
    expect(adapter.supports("web_grounding+schema", "gemini-3.5-flash")).toBe(true);
    expect(adapter.supports("tools+schema", "models/gemini-3.1-pro-preview")).toBe(true);
    expect(adapter.supports("tools+schema", "gemini-flash-latest")).toBe(true);
  });

  it("limits image generation to image models and schema combos to Gemini 3+", () => {
    expect(adapter.supports("image_generation", "gemini-3.5-flash")).toBe(false);
    expect(adapter.supports("image_generation", "gemini-3.1-flash-image")).toBe(true);
    expect(adapter.supports("image_generation", "gemini-3-pro-image")).toBe(true);
    expect(adapter.supports("web_grounding+schema", "gemini-2.5-flash")).toBe(false);
    expect(adapter.supports("tools+schema", "gemini-2.5-pro")).toBe(false);
    expect(adapter.supports("tools+schema", "gemini-2.0-flash")).toBe(false);
    expect(adapter.supports("tools+schema", "gemini-1.5-pro")).toBe(false);
  });

  it("has no realtime and no chat on embedding models", () => {
    expect(adapter.supports("realtime", "gemini-3.5-flash")).toBe(false);
    expect(adapter.supports("embeddings", "gemini-embedding-001")).toBe(true);
    expect(adapter.supports("embeddings", "models/gemini-embedding-2-preview")).toBe(true);
    expect(adapter.supports("completion", "gemini-embedding-001")).toBe(false);
    expect(adapter.supports("transcription", "gemini-embedding-001")).toBe(false);
  });

  it("does not claim embeddings on chat models or image generation on Imagen (regression)", () => {
    // batchEmbedContents answers 400 on generateContent models; Imagen uses `:predict`, not generateContent.
    expect(adapter.supports("embeddings", "gemini-3.5-flash")).toBe(false);
    expect(adapter.supports("embeddings", "gemini-3.1-flash-image")).toBe(false);
    expect(adapter.supports("image_generation", "imagen-4.0-generate-001")).toBe(false);
    expect(adapter.supports("image_generation", "gemini-2.5-flash-image")).toBe(true);
  });

  it("rejects realtime sessions", async () => {
    await expect(adapter.createRealtimeSession({ model: "gemini-3.5-flash", signal: new AbortController().signal })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
  });
});

describe("GeminiAdapter: embeddings", () => {
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, i) => ((i % 7) + seed) / 10);
  const norm = (values: number[]) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));

  function embedRequest(overrides: Partial<EmbeddingRequest> = {}): EmbeddingRequest {
    return {
      model: "gemini-embedding-001",
      inputs: [{ title: "Return policy", content: "Items can be returned within 30 days." }, { title: null, content: "" }],
      mode: "document",
      dimensions: 1536,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it("calls batchEmbedContents and returns one normalized 1536-d vector per input", async () => {
    const { mock, adapter } = setup();
    mock.reply({ embeddings: [{ values: vector(1) }, { values: vector(2) }] });
    const vectors = await adapter.embed(embedRequest());

    expect(mock.last.url).toBe(`${BASE}/models/gemini-embedding-001:batchEmbedContents`);
    expect(mock.last.headers["x-goog-api-key"]).toBe("test-key");
    expect(mock.last.body).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "Items can be returned within 30 days." }] },
          embedContentConfig: { taskType: "RETRIEVAL_DOCUMENT", title: "Return policy", outputDimensionality: 1536 },
        },
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: " " }] },
          embedContentConfig: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 1536 },
        },
      ],
    });
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v).toHaveLength(1536);
      expect(norm(v)).toBeCloseTo(1, 10);
    }
  });

  it("uses RETRIEVAL_QUERY without titles for queries and merges embedContentConfig options", async () => {
    const { mock, adapter } = setup();
    mock.reply({ embeddings: [{ values: vector(3) }] });
    await adapter.embed(
      embedRequest({ model: "models/gemini-embedding-001", mode: "query", inputs: [{ title: "ignored", content: "return policy?" }], options: { embedContentConfig: { autoTruncate: true } } }),
    );
    expect(mock.last.body.requests[0].embedContentConfig).toEqual({ taskType: "RETRIEVAL_QUERY", outputDimensionality: 1536, autoTruncate: true });
  });

  it("never sends completion-only options of a shared tier to batchEmbedContents", async () => {
    const { mock, adapter } = setup();
    mock.reply({ embeddings: [{ values: vector(1) }] });
    const options = { generationConfig: { temperature: 0.2 }, toolConfig: {}, web_search_tool: {}, embedContentConfig: { autoTruncate: true } };
    await adapter.embed(embedRequest({ model: "gemini-embedding-001", inputs: [{ content: "a" }], options }));
    expect(Object.keys(mock.last.body.requests[0]).sort()).toEqual(["content", "embedContentConfig", "model"]);
  });

  it("splits large inputs into batches of 100", async () => {
    const { mock, adapter } = setup();
    const inputs = Array.from({ length: 150 }, (_, i) => ({ content: `chunk ${i}` }));
    mock.reply((call: RecordedCall) => jsonResponse({ embeddings: call.body.requests.map(() => ({ values: vector(1) })) }));
    mock.reply((call: RecordedCall) => jsonResponse({ embeddings: call.body.requests.map(() => ({ values: vector(2) })) }));
    const vectors = await adapter.embed(embedRequest({ inputs }));
    expect(mock.calls.map((call) => call.body.requests.length)).toEqual([100, 50]);
    expect(vectors).toHaveLength(150);
  });

  it("rejects a response with the wrong count or dimensions", async () => {
    const { mock, adapter } = setup();
    mock.reply({ embeddings: [{ values: vector(1) }] }).reply({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
    await expect(adapter.embed(embedRequest())).rejects.toThrow(/expected 2 embeddings, got 1/);
    await expect(adapter.embed(embedRequest())).rejects.toThrow(/expected 1536-dimension embeddings, got 2/);
  });
});

describe("GeminiAdapter: transcription", () => {
  function transcriptionRequest(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
    return { model: "gemini-3.5-flash", audio: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4", mimetype: "audio/mp3", signal: new AbortController().signal, ...overrides };
  }

  it("sends the audio with a verbatim-transcript instruction and returns the text", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "Bonjour, je voudrais un devis.\n" }]));
    const text = await adapter.transcribe(transcriptionRequest({ language: "fr_FR" }));
    expect(text).toBe("Bonjour, je voudrais un devis.");
    expect(mock.last.url).toBe(`${BASE}/models/gemini-3.5-flash:generateContent`);
    const [prompt, audio] = mock.last.body.contents[0].parts;
    expect(prompt.text).toMatch(/Transcribe this audio verbatim/);
    expect(prompt.text).toContain("fr_FR");
    expect(prompt.text).toMatch(/Return only the transcript/);
    expect(audio).toEqual({ inlineData: { mimeType: "audio/mpeg", data: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4" } });
  });

  it("returns WebVTT for vtt requests (fences stripped)", async () => {
    const { mock, adapter } = setup();
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:04.200\nHello, thanks for calling.\n\n00:00:04.200 --> 00:00:08.900\nHow can I help?";
    mock.reply(geminiResponse([{ text: "```vtt\n" + vtt + "\n```" }]));
    const out = await adapter.transcribe(transcriptionRequest({ mimetype: "audio/webm", responseFormat: "vtt" }));
    expect(out).toBe(`${vtt}\n`);
    expect(mock.last.body.contents[0].parts[0].text).toMatch(/WebVTT/);
    expect(mock.last.body.contents[0].parts[0].text).toMatch(/6 seconds/);
  });

  it("wraps a plain-text answer into a single-cue WebVTT document", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "Hello, thanks for calling." }]));
    const out = await adapter.transcribe(transcriptionRequest({ responseFormat: "vtt" }));
    expect(out.startsWith("WEBVTT\n\n1\n00:00:00.000 --> ")).toBe(true);
    expect(out).toContain("Hello, thanks for calling.");
  });

  /** Cues as Odoo's call debrief parser (transcript_parser.js `parseTimedText`) finds them. */
  function odooCues(vtt: string): Array<{ timing: string; text: string }> {
    const blocks = vtt.replace(/^WEBVTT.*\n/, "").trim().split(/\n\s*\n/);
    return blocks.flatMap((block) => {
      const lines = block.split("\n");
      const at = lines.findIndex((line) => line.includes("-->"));
      return at < 0 ? [] : [{ timing: lines[at]!, text: lines.slice(at + 1).join("\n") }];
    });
  }

  it("turns a WEBVTT header without cue timings into a single cue (regression)", async () => {
    // Odoo drops every block without a "-->" line: this answer would have produced no transcript.
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "WEBVTT\n\nHello, thanks for calling. How can I help?" }]));
    const out = await adapter.transcribe(transcriptionRequest({ responseFormat: "vtt" }));
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(odooCues(out)).toEqual([{ timing: expect.stringMatching(/^00:00:00\.000 --> /), text: "Hello, thanks for calling. How can I help?" }]);
  });

  it("repairs cue lists without header, SRT commas, short millis and a missing blank line (regression)", async () => {
    const { mock, adapter } = setup();
    mock
      .reply(geminiResponse([{ text: "00:00:00,000 --> 00:00:04,200\nHello\n\n00:04.2 --> 00:06.5 align:start\nBye" }]))
      .reply(geminiResponse([{ text: "WEBVTT\n00:00:00.000 --> 00:00:01.000\nHi" }]));
    const first = await adapter.transcribe(transcriptionRequest({ responseFormat: "vtt" }));
    expect(first).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:04.200\nHello\n\n00:00:04.200 --> 00:00:06.500 align:start\nBye\n");
    expect(odooCues(first).map((cue) => cue.text)).toEqual(["Hello", "Bye"]);
    const second = await adapter.transcribe(transcriptionRequest({ responseFormat: "vtt" }));
    expect(second).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n");
  });

  it("maps non-standard audio mimetypes to the names Gemini lists", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "Hi." }])).reply(geminiResponse([{ text: "Hi." }]));
    await adapter.transcribe(transcriptionRequest({ mimetype: "audio/x-wav" }));
    expect(mock.last.body.contents[0].parts[1].inlineData.mimeType).toBe("audio/wav");
    await adapter.transcribe(transcriptionRequest({ mimetype: "video/webm;codecs=opus" }));
    expect(mock.last.body.contents[0].parts[1].inlineData.mimeType).toBe("audio/webm");
  });

  it("accepts silence but rejects a blocked transcription", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([])).reply({ candidates: [{ finishReason: "RECITATION", index: 0 }] });
    await expect(adapter.transcribe(transcriptionRequest())).resolves.toBe("");
    await expect(adapter.transcribe(transcriptionRequest())).rejects.toThrow(/RECITATION/);
  });
});

describe("GeminiAdapter: gemini-embedding-2 task prefixes (the format Odoo's own service used)", () => {
  const vector = Array.from({ length: 1536 }, (_, i) => (i % 7) - 3);
  const reply = (n: number) => ({ embeddings: Array.from({ length: n }, () => ({ values: vector })) });
  const embedRequest = (model: string, mode: "document" | "query", inputs: Array<{ title?: string | null; content: string }>, options?: Record<string, unknown>) => ({
    model,
    inputs,
    mode,
    dimensions: 1536,
    ...(options ? { options } : {}),
    signal: new AbortController().signal,
  });

  it("documents: 'title: <title | none> | text: <content>'", async () => {
    const mock = new MockFetch().reply(reply(2));
    const adapter = new GeminiAdapter({ apiKey: "k", fetch: mock.fetch });
    await adapter.embed(embedRequest("gemini-embedding-2", "document", [
      { title: "Odoo Enterprise Agreement.pdf", content: "1. Term of the agreement..." },
      { title: null, content: "Shipping takes 3 days." },
    ]));
    const texts = mock.last.body.requests.map((r: any) => r.content.parts[0].text);
    expect(texts).toEqual([
      "title: Odoo Enterprise Agreement.pdf | text: 1. Term of the agreement...",
      "title: none | text: Shipping takes 3 days.",
    ]);
    expect(mock.last.body.requests[0].embedContentConfig.outputDimensionality).toBe(1536);
  });

  it("queries: 'task: search result | query: <content>'", async () => {
    const mock = new MockFetch().reply(reply(1));
    const adapter = new GeminiAdapter({ apiKey: "k", fetch: mock.fetch });
    await adapter.embed(embedRequest("gemini-embedding-2", "query", [{ content: "How do I terminate the contract?" }]));
    expect(mock.last.body.requests[0].content.parts[0].text).toBe("task: search result | query: How do I terminate the contract?");
  });

  it("gemini-embedding-001 keeps plain text (it honours taskType and title)", async () => {
    const mock = new MockFetch().reply(reply(1));
    const adapter = new GeminiAdapter({ apiKey: "k", fetch: mock.fetch });
    await adapter.embed(embedRequest("gemini-embedding-001", "document", [{ title: "Doc", content: "Body" }]));
    expect(mock.last.body.requests[0].content.parts[0].text).toBe("Body");
    expect(mock.last.body.requests[0].embedContentConfig).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT", title: "Doc" });
  });

  it("options.embedding_prompt forces the format and never reaches the API", async () => {
    const mock = new MockFetch().reply(reply(1)).reply(reply(1));
    const adapter = new GeminiAdapter({ apiKey: "k", fetch: mock.fetch });
    await adapter.embed(embedRequest("gemini-embedding-2", "query", [{ content: "q" }], { embedding_prompt: false }));
    expect(mock.calls[0]!.body.requests[0].content.parts[0].text).toBe("q");
    expect(JSON.stringify(mock.calls[0]!.body)).not.toContain("embedding_prompt");
    await adapter.embed(embedRequest("gemini-embedding-001", "query", [{ content: "q" }], { embedding_prompt: true }));
    expect(mock.calls[1]!.body.requests[0].content.parts[0].text).toBe("task: search result | query: q");
  });
});

describe("GeminiAdapter: conversation id", () => {
  it("is not sent: Gemini's implicit cache has no routing key", async () => {
    const { mock, adapter } = setup();
    mock.reply(geminiResponse([{ text: "ok" }]));
    await adapter.complete(request({ conversationId: "cv_AAAAAAAAAAAAAAAAAAAAAA" }));
    expect(JSON.stringify(mock.last.body)).not.toContain("cv_AAAAAAAAAAAAAAAAAAAAAA");
    expect(JSON.stringify(mock.last.headers)).not.toContain("cv_AAAAAAAAAAAAAAAAAAAAAA");
  });
});
