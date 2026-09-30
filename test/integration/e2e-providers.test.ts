/**
 * Full stack with the real adapters: Odoo JSON-RPC -> router -> adapter -> (mocked) provider HTTP
 * -> signed webhook -> Odoo runs the tool -> next turn replays provider state + tool_result.
 * Nothing leaves the process: provider and webhook calls go to MockFetch instances.
 */
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { parseConfig } from "../../src/config/load.js";
import { verifyWebhookBody } from "../../src/core/signature.js";
import { createAdapters } from "../../src/providers/index.js";
import type { ProviderName } from "../../src/providers/types.js";
import { MockFetch } from "../helpers/mock-fetch.js";

const TOOLS = [
  {
    name: "create_lead",
    instructions: "Create a CRM lead.",
    schema: { type: "object", properties: { name: { type: "string" }, tool_status: { type: "string" } }, required: ["name", "tool_status"] },
  },
];
const USER = {
  role: "user",
  content: [
    { type: "text", text: "Create a lead for Acme" },
    { type: "inline_data", mimetype: "image/png", data: "iVBORw0KGgo=", metadata: { image_path: "/web/image/ir.attachment/5/raw" } },
  ],
};
const ARGS = { name: "Acme", tool_status: "Creating the lead" };

function setup(provider: ProviderName, model: string, effort?: string) {
  const config = parseConfig({
    auth: { accountTokens: ["tok"] },
    webhook: { initialBackoffMs: 0 },
    providers: { [provider]: { apiKey: `test-${provider}` } },
    routing: { default: { provider, model, ...(effort ? { effort } : {}) } },
  });
  const upstream = new MockFetch();
  const webhook = new MockFetch();
  const { app, tasks } = createApp({ config, adapters: createAdapters(config, upstream.fetch), fetch: webhook.fetch });
  let id = 0;
  const submit = async (messages: unknown[], requestUuid: string, secret: string) => {
    const res = await app.request("/api/odoo_ai/1/get_completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: ++id,
        params: {
          messages,
          instructions: "You are Odoo's AI agent.",
          tools: TOOLS,
          usage: "agent:custom",
          boost_reasoning: false,
          request_uuid: requestUuid,
          webhook_url: "https://odoo.example.com/ai/completion_result_ready",
          webhook_secret: secret,
          webhook_dbname: "prod",
          llm_retry: false,
          account_token: "tok",
          dbuuid: "db",
        },
      }),
    });
    expect(await res.json()).toMatchObject({ result: {} });
    await tasks.idle();
    const body = webhook.last.body;
    expect(verifyWebhookBody(secret, body)).toBe(true);
    expect(body.llm_error).toBe(false);
    return body.llm_result.result;
  };
  /** Round 1 -> tool call; Odoo runs the tool; round 2 -> final text. Returns both upstream bodies. */
  const runLoop = async () => {
    webhook.reply({}).reply({});
    const assistant = await submit([USER], "r1", "secret-1");
    const toolCall = assistant.content.find((part: { type: string }) => part.type === "tool_call");
    expect(toolCall).toMatchObject({ type: "tool_call", name: "create_lead", args: ARGS });
    expect(typeof toolCall.call_id).toBe("string");
    expect(assistant.provider_metadata).toMatchObject({ provider, model });
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: toolCall.call_id, result: [{ type: "text", text: "Lead #7 created" }], success: true }],
    };
    const final = await submit([USER, assistant, toolResult], "r2", "secret-2");
    expect(final.content).toEqual([{ type: "text", text: "Done: lead #7." }]);
    expect(upstream.pending).toBe(0);
    return { first: upstream.calls[0]!, second: upstream.calls[1]!, toolCall, assistant };
  };
  return { upstream, webhook, submit, runLoop };
}

function noMetadataLeak(body: unknown) {
  expect(JSON.stringify(body)).not.toContain("image_path");
}

describe("end to end with real adapters (mocked HTTP)", () => {
  it("OpenAI Responses: reasoning items + function_call replayed, function_call_output sent", async () => {
    const { upstream, runLoop } = setup("openai", "gpt-5.6", "low");
    upstream
      .reply({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA-encrypted" },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "create_lead", arguments: JSON.stringify(ARGS), status: "completed" },
        ],
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      })
      .reply({
        id: "resp_2",
        status: "completed",
        output: [{ type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done: lead #7.", annotations: [] }] }],
        usage: { input_tokens: 200, output_tokens: 8, total_tokens: 208 },
      });
    const { first, second, toolCall } = await runLoop();
    expect(first.url).toBe("https://api.openai.com/v1/responses");
    expect(first.headers.authorization).toBe("Bearer test-openai");
    expect(first.body).toMatchObject({ model: "gpt-5.6", instructions: "You are Odoo's AI agent.", store: false, reasoning: { effort: "low" } });
    expect(first.body.tools).toEqual([expect.objectContaining({ type: "function", name: "create_lead", description: "Create a CRM lead." })]);
    noMetadataLeak(first.body);
    expect(toolCall.call_id).toBe("call_1");

    const input = second.body.input as Array<Record<string, unknown>>;
    const reasoningAt = input.findIndex((item) => item.type === "reasoning");
    const callAt = input.findIndex((item) => item.type === "function_call");
    const outputAt = input.findIndex((item) => item.type === "function_call_output");
    expect(input[reasoningAt]).toMatchObject({ id: "rs_1", encrypted_content: "gAAAA-encrypted" });
    expect(input[callAt]).toMatchObject({ call_id: "call_1", name: "create_lead" });
    expect(input[outputAt]).toMatchObject({ call_id: "call_1", output: "Lead #7 created" });
    expect(reasoningAt).toBeLessThan(callAt);
    expect(callAt).toBeLessThan(outputAt);
  });

  it("Grok (xAI Responses): same loop against api.x.ai", async () => {
    const { upstream, runLoop } = setup("grok", "grok-4.6", "medium");
    upstream
      .reply({
        id: "resp_x1",
        status: "completed",
        output: [{ type: "function_call", id: "fc_x", call_id: "call_x1", name: "create_lead", arguments: JSON.stringify(ARGS), status: "completed" }],
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .reply({
        id: "resp_x2",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: lead #7.", annotations: [] }] }],
      });
    const { first, second } = await runLoop();
    expect(first.url).toBe("https://api.x.ai/v1/responses");
    expect(first.headers.authorization).toBe("Bearer test-grok");
    expect(first.body.reasoning).toEqual({ effort: "medium" });
    const input = second.body.input as Array<Record<string, unknown>>;
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_x1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_x1", output: "Lead #7 created" }),
    ]));
  });

  it("Claude: thinking block with signature replayed verbatim before tool_use; tool_result first in the user turn", async () => {
    const { upstream, runLoop } = setup("claude", "claude-opus-5-5", "high");
    const thinking = { type: "thinking", thinking: "", signature: "EqQBCkYIBRgCKkD-signature" };
    upstream
      .reply({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [thinking, { type: "tool_use", id: "toolu_01", name: "create_lead", input: ARGS }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 40 },
      })
      .reply({
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Done: lead #7." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 150, output_tokens: 6 },
      });
    const { first, second, toolCall } = await runLoop();
    expect(first.url).toBe("https://api.anthropic.com/v1/messages");
    expect(first.headers["x-api-key"]).toBe("test-claude");
    expect(first.headers["anthropic-version"]).toBe("2023-06-01");
    expect(first.body).toMatchObject({ model: "claude-opus-5-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    // Prompt caching: breakpoint on the system prompt (caches tools + system), automatic tail.
    expect(first.body.system).toEqual([{ type: "text", text: "You are Odoo's AI agent.", cache_control: { type: "ephemeral" } }]);
    expect(first.body.cache_control).toEqual({ type: "ephemeral" });
    expect(first.body.max_tokens).toBeGreaterThan(0);
    noMetadataLeak(first.body);
    expect(toolCall.call_id).toBe("toolu_01");

    const messages = second.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content[0]).toEqual(thinking);
    expect(messages[1]!.content[1]).toMatchObject({ type: "tool_use", id: "toolu_01", input: ARGS });
    expect(messages[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_01" });
    expect(JSON.stringify(messages[2]!.content[0])).toContain("Lead #7 created");
  });

  it("Gemini: thoughtSignature and functionCall id replayed; functionResponse matches", async () => {
    const { upstream, runLoop } = setup("gemini", "gemini-3.8-flash", "low");
    upstream
      .reply({
        candidates: [{
          content: { role: "model", parts: [{ functionCall: { id: "fc-1", name: "create_lead", args: ARGS }, thoughtSignature: "CiQBsig==" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12, totalTokenCount: 92 },
        modelVersion: "gemini-3.8-flash",
      })
      .reply({
        candidates: [{ content: { role: "model", parts: [{ text: "Done: lead #7." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
      });
    const { first, second } = await runLoop();
    expect(first.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(first.headers["x-goog-api-key"]).toBe("test-gemini");
    expect(first.body.systemInstruction).toEqual({ parts: [{ text: "You are Odoo's AI agent." }] });
    expect(first.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    noMetadataLeak(first.body);

    const contents = second.body.contents as Array<{ role: string; parts: Array<Record<string, any>> }>;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]!.parts[0]).toMatchObject({ functionCall: { name: "create_lead", args: ARGS, id: "fc-1" }, thoughtSignature: "CiQBsig==" });
    expect(contents[2]!.parts[0]!.functionResponse).toMatchObject({ name: "create_lead", id: "fc-1", response: { result: "Lead #7 created" } });
  });

  it("OpenRouter: reasoning_details replayed with tool_calls; tool message carries the result", async () => {
    const { upstream, runLoop } = setup("openrouter", "anthropic/claude-sonnet-5.5", "medium");
    const reasoningDetails = [{ type: "reasoning.text", text: "Need to call the tool", signature: "sig-or", id: "rd_1", format: "anthropic-claude-v1", index: 0 }];
    upstream
      .reply({
        id: "gen-1",
        model: "anthropic/claude-sonnet-5.5",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_or1", type: "function", function: { name: "create_lead", arguments: JSON.stringify(ARGS) } }],
            reasoning_details: reasoningDetails,
          },
        }],
        usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      })
      .reply({
        id: "gen-2",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done: lead #7." } }],
        usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
      });
    const { first, second } = await runLoop();
    expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(first.headers.authorization).toBe("Bearer test-openrouter");
    expect(first.body.reasoning).toEqual({ effort: "medium" });
    // Claude through OpenRouter: explicit breakpoint on the system prompt + automatic tail caching.
    expect(first.body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "You are Odoo's AI agent.", cache_control: { type: "ephemeral" } }] });
    expect(first.body.cache_control).toEqual({ type: "ephemeral" });
    noMetadataLeak(first.body);

    const messages = second.body.messages as Array<Record<string, any>>;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls[0]).toMatchObject({ id: "call_or1", function: { name: "create_lead" } });
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual(ARGS);
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
    expect(messages.find((m) => m.role === "tool")).toEqual({ role: "tool", tool_call_id: "call_or1", content: "Lead #7 created" });
  });
});

/** A plain text answer in each provider's response format. */
const TEXT_REPLY: Record<ProviderName, unknown> = {
  openai: { id: "resp", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Seen.", annotations: [] }] }] },
  grok: { id: "resp", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Seen.", annotations: [] }] }] },
  claude: { id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "Seen." }], stop_reason: "end_turn" },
  gemini: { candidates: [{ content: { role: "model", parts: [{ text: "Seen." }] }, finishReason: "STOP" }] },
  openrouter: { id: "gen", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Seen." } }] },
};

const MODELS: Record<ProviderName, string> = {
  openai: "gpt-5.6",
  grok: "grok-4.6",
  claude: "claude-opus-5-5",
  gemini: "gemini-3.8-flash",
  openrouter: "anthropic/claude-sonnet-5.5",
};

describe("Odoo attachments reach every provider normalized", () => {
  const PNG = "iVBORw0KGgo=";
  const SVG = "<svg><circle r='4'/></svg>";

  it.each(Object.keys(MODELS) as ProviderName[])("%s", async (provider) => {
    const { upstream, webhook, submit } = setup(provider, MODELS[provider]);
    upstream.reply(TEXT_REPLY[provider]);
    webhook.reply({});
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Look" },
        // An empty image field: Odoo sends `data: ''`.
        { type: "inline_data", mimetype: "image/png", data: "", metadata: { image_path: "/web/image/ir.attachment/9/raw" } },
        // PNG bytes under the attachment's original, misspelled mimetype.
        { type: "inline_data", mimetype: "IMAGE/JPG", data: PNG, metadata: { attachment_id: 9 } },
        { type: "inline_data", mimetype: "image/svg+xml; charset=utf-8", data: Buffer.from(SVG).toString("base64") },
      ],
    };
    const result = await submit([message], "r-attachments", "secret-attachments");
    expect(result.content).toEqual([{ type: "text", text: "Seen." }]);

    const raw = upstream.calls[0]!.rawBody ?? "";
    expect(raw).not.toMatch(/"data":""|base64,"|image\/jpg|IMAGE|jpeg|charset|metadata|image_path|attachment_id/);
    expect(raw).toContain("image/png");
    expect(raw.split(PNG)).toHaveLength(2);
    expect(raw).toContain(SVG);
    expect(raw).not.toContain("image/svg+xml");
  });
});
