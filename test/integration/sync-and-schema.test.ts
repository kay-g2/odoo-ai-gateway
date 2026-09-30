/** `1/get_completions_sync` (one-shot `_get_direct_response`) and structured output (`ai_field`). */
import { describe, expect, it } from "vitest";

import { CONVERSATION_ID_PATTERN } from "../../src/services/conversation-id.js";
import { createTestGateway } from "../helpers/gateway.js";

/** The schema `ai/utils/ai_fields_tools.py` builds for a many2one field. */
const AI_FIELD_SCHEMA = {
  type: "object",
  properties: {
    value: {
      type: ["integer", "null"],
      enum: [3, 7, 12, null],
      description: "Id of the matching record, or null when none matches",
    },
    could_not_resolve: { type: "boolean", description: "Whether no value could be determined" },
    unresolved_cause: { type: ["string", "null"], description: "Short explanation" },
  },
  required: ["value", "could_not_resolve", "unresolved_cause"],
  additionalProperties: false,
};

function aiFieldPayload(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Which country is the customer in? Partner: Acme GmbH, Berlin" }] }],
    instructions: "Fill the field",
    tools: {},
    schema: AI_FIELD_SCHEMA,
    web_grounding: true,
    usage: "ai_field",
    ...extra,
  };
}

describe("1/get_completions_sync", () => {
  it("answers in the same POST with {status, result: assistant message}", async () => {
    const gw = createTestGateway();
    gw.adapters.claude.then([{ type: "text", text: "Summary of the call" }]);
    const res = await gw.rpc("1/get_completions_sync", {
      messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
      instructions: "You summarize calls",
      tools: {},
      usage: "agent:voip_ai.voip_call_summary_agent",
      timeout: 115,
      resolve_web_sources: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      status: "success",
      result: {
        role: "assistant",
        content: [{ type: "text", text: "Summary of the call" }],
        provider_metadata: {
          provider: "claude",
          model: "claude-sonnet-5-5",
          claude: { turn: 1 },
          conversation_id: expect.stringMatching(CONVERSATION_ID_PATTERN),
        },
      },
    });
    const request = gw.adapters.claude.completions[0]!;
    expect(request.conversationId).toBe(res.body.result.result.provider_metadata.conversation_id);
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.effort).toBe("medium");
  });

  it("returns generated images as inline_data parts", async () => {
    const gw = createTestGateway();
    gw.adapters.gemini.then([{ type: "text", text: "Here it is" }, { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=" }]);
    const res = await gw.rpc("1/get_completions_sync", {
      messages: [{ role: "user", content: [{ type: "text", text: "A red bicycle" }] }],
      instructions: "<system_prompt>no text in images</system_prompt>",
      tools: null,
      timeout: 115,
      aspect_ratio: "16:9",
      web_grounding: false,
      image_generation: true,
    });
    expect(res.body.result.result.content).toEqual([
      { type: "text", text: "Here it is" },
      { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=" },
    ]);
    const request = gw.adapters.gemini.completions[0]!;
    expect(request.model).toBe("gemini-3.1-flash-image");
    expect(request.imageGeneration).toBe(true);
    expect(request.aspectRatio).toBe("16:9");
  });

  it("relabels images whose bytes do not match the mimetype (Odoo re-encodes big images as PNG)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "A cat" }]);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/";
    await gw.rpc("1/get_completions_sync", {
      messages: [
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "inline_data", mimetype: "image/jpeg", data: png, metadata: { image_path: "/web/image/1" } }] },
        { role: "assistant", content: [{ type: "tool_call", name: "read_image", args: {}, call_id: "c1" }], provider_metadata: {} },
        { role: "user", content: [{ type: "tool_result", tool_name: "read_image", tool_call_id: "c1", success: true, result: [
          { type: "inline_data", mimetype: "image/webp", data: png },
          { type: "inline_data", mimetype: "image/jpeg", data: jpeg },
          { type: "text", text: "done" },
        ] }] },
      ],
      instructions: "",
      tools: [{ name: "read_image", instructions: "", schema: null }],
    });
    const sent = gw.adapters.openai.completions[0]!.messages;
    const first = sent[0]!.content[1] as { mimetype: string; metadata?: unknown };
    expect(first.mimetype).toBe("image/png");
    const results = (sent[2]!.content[0] as { result: Array<{ type: string; mimetype?: string }> }).result;
    expect(results.map((part) => part.mimetype)).toEqual(["image/png", "image/jpeg", undefined]);
  });

  it("keeps new Unicode characters on the sync route (only the signed webhook replaces them)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: `tired ${String.fromCodePoint(0x1fae9)} a\u0000b` }]);
    const res = await gw.rpc("1/get_completions_sync", { messages: [], instructions: "" });
    expect(res.body.result.result.content[0].text).toBe(`tired ${String.fromCodePoint(0x1fae9)} a\ufffdb`);
  });

  it("maps provider errors to a JSON-RPC error", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then(new Error("rate limited"));
    const res = await gw.rpc("1/get_completions_sync", { messages: [], instructions: "x", tools: [] });
    expect(res.status).toBe(200);
    expect(res.body.error.data.message).toContain("rate limited");
    expect(res.body).not.toHaveProperty("result");
  });

  it("validates messages", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_completions_sync", { messages: [{ role: "system", content: "x" }], instructions: "x" });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.InvalidRequestError");
  });

  it("caps the provider deadline with params.timeout", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    const res = await gw.rpc("1/get_completions_sync", { messages: [], instructions: "x", timeout: 0.05 });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.ProviderTimeoutError");
  });
});

describe("structured output (schema)", () => {
  it("ai_field: the text part is JSON following the schema", async () => {
    const gw = createTestGateway();
    gw.adapters.gemini.then([{ type: "text", text: '{"value": 7, "could_not_resolve": false, "unresolved_cause": null}' }]);
    const res = await gw.rpc("1/get_completions_sync", aiFieldPayload());
    const content = res.body.result.result.content;
    expect(content).toHaveLength(1);
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toEqual({ value: 7, could_not_resolve: false, unresolved_cause: null });
    expect(Object.keys(parsed).sort()).toEqual([...AI_FIELD_SCHEMA.required].sort());

    const request = gw.adapters.gemini.completions[0]!;
    expect(request.schema).toEqual(AI_FIELD_SCHEMA);
    expect(request.webGrounding).toBe(true);
    expect(request.model).toBe("gemini-3.8-flash");
  });

  it("strips Markdown fences and merges split text parts so json.loads works", async () => {
    const gw = createTestGateway();
    gw.adapters.gemini.then([
      { type: "text", text: '```json\n{"value": null, "could_not_resolve": true,' },
      { type: "text", text: ' "unresolved_cause": "No country"}\n```' },
    ]);
    const res = await gw.rpc("1/get_completions_sync", aiFieldPayload());
    const content = res.body.result.result.content;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toEqual({ value: null, could_not_resolve: true, unresolved_cause: "No country" });
  });

  it("fails when the model does not return JSON", async () => {
    const gw = createTestGateway();
    gw.adapters.gemini.then([{ type: "text", text: "The customer is in Germany." }]);
    const res = await gw.rpc("1/get_completions_sync", aiFieldPayload());
    expect(res.body.error.data.message).toContain("not valid JSON");
  });

  it("esg_metrics: schema without web grounding goes to its own usage entry", async () => {
    const gw = createTestGateway();
    gw.adapters.openrouter.then([{ type: "text", text: '{"items": []}' }]);
    const res = await gw.rpc("1/get_completions_sync", {
      messages: [{ role: "user", content: [{ type: "text", text: "Suggest metrics" }] }],
      instructions: "Answer the request with the JSON object",
      tools: {},
      schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } }, required: ["items"], additionalProperties: false },
      usage: "esg_metrics",
    });
    expect(JSON.parse(res.body.result.result.content[0].text)).toEqual({ items: [] });
    expect(gw.adapters.openrouter.completions[0]!.model).toBe("openai/gpt-5.6-sol");
  });
});

describe("deadlines", () => {
  it("sync calls are capped at Odoo's 60 s HTTP timeout, async ones at the configured cap", async () => {
    const gw = createTestGateway();
    const { CompletionService } = await import("../../src/services/completions.js");
    const service = new CompletionService(gw.config, (name) => gw.adapters[name], (await import("../../src/core/logger.js")).silentLogger);
    const payload = { messages: [], instructions: "" };
    expect(service.prepare("1/get_completions_sync", payload).timeoutSeconds).toBe(60);
    expect(service.prepare("1/get_completions", payload).timeoutSeconds).toBe(300);
    expect(service.prepare("1/get_completions", { ...payload, timeout: 115 }).timeoutSeconds).toBe(115);
    // Odoo's HTTP client stops waiting after 60 s on sync calls, whatever `timeout` says (115 for images).
    expect(service.prepare("1/get_completions_sync", { ...payload, timeout: 115 }).timeoutSeconds).toBe(60);
    expect(service.prepare("1/get_completions_sync", { ...payload, timeout: 20 }).timeoutSeconds).toBe(20);
    expect(service.prepare("1/get_completions", { ...payload, timeout: 9999 }).timeoutSeconds).toBe(300);
  });
});
