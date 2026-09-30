/**
 * The agent loop lives in Odoo (`ai.session`): a tool_call goes back to Odoo, Odoo runs the
 * Python tool, then calls the gateway again with the assistant turn and a tool_result turn.
 */
import { describe, expect, it } from "vitest";

import { verifyWebhookBody } from "../../src/core/signature.js";
import { agentPayload, asyncParams, createTestGateway } from "../helpers/gateway.js";

describe("tool_call round trip", () => {
  it("returns a tool_call, then completes the next turn with the tool_result", async () => {
    const gw = createTestGateway();
    const toolCall = { type: "tool_call", name: "create_lead", args: { name: "Acme", tool_status: "Creating the lead" }, call_id: "call_42" } as const;
    gw.adapters.openai.then([{ type: "text", text: "Let me create it." }, toolCall]);
    gw.adapters.openai.then((request) => {
      const last = request.messages.at(-1)!;
      const result = last.content.find((part) => part.type === "tool_result");
      if (!result || result.type !== "tool_result") throw new Error("missing tool_result");
      return [{ type: "text", text: `Done: ${result.result[0]?.type === "text" ? result.result[0].text : ""}` }];
    });
    gw.webhook.reply({}).reply({});

    // Round 1 (`_submit_agent_request(message)`).
    const round1 = { ...agentPayload(), ...asyncParams({ request_uuid: "round-1" }) };
    await gw.rpc("1/get_completions", round1);
    await gw.tasks.idle();
    const first = gw.webhook.calls[0]!.body;
    expect(verifyWebhookBody(round1.webhook_secret as string, first)).toBe(true);
    const assistant = first.llm_result.result;
    expect(assistant.content).toEqual([{ type: "text", text: "Let me create it." }, toolCall]);
    expect(typeof assistant.content[1].args).toBe("object");

    // Odoo stores the assistant message verbatim, runs the tool, and submits round 2 with a
    // new request_uuid/secret (`_submit_agent_request()` without message).
    const history = [
      ...(round1.messages as unknown[]),
      assistant,
      {
        role: "user",
        content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: "call_42", result: [{ type: "text", text: "Lead #7 created" }], success: true }],
      },
    ];
    const round2 = { ...agentPayload({ messages: history }), ...asyncParams({ request_uuid: "round-2", webhook_secret: "second-secret" }) };
    await gw.rpc("1/get_completions", round2);
    await gw.tasks.idle();

    const second = gw.webhook.calls[1]!.body;
    expect(second.request_uuid).toBe("round-2");
    expect(verifyWebhookBody("second-secret", second)).toBe(true);
    expect(verifyWebhookBody(round1.webhook_secret as string, second)).toBe(false);
    expect(second.llm_result.result.content).toEqual([{ type: "text", text: "Done: Lead #7 created" }]);

    // The provider saw the replayed assistant turn (with its provider_metadata) and the result.
    const replay = gw.adapters.openai.completions[1]!;
    expect(replay.messages).toHaveLength(3);
    expect(replay.messages[1]).toEqual(assistant);
    expect(replay.messages[1]!.role === "assistant" && replay.messages[1]!.provider_metadata).toMatchObject({ provider: "openai", openai: { turn: 1 } });
    expect(replay.tools.map((tool) => tool.name)).toEqual(["create_lead"]);
  });

  it("normalizes numeric call ids and non-object args coming back from a provider", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "tool_call", name: "create_lead", args: "not-an-object" as never, call_id: 7 }]);
    const res = await gw.rpc("1/get_completions_sync", agentPayload());
    expect(res.body.result.result.content).toEqual([{ type: "tool_call", name: "create_lead", args: {}, call_id: "7" }]);
  });

  it("accepts the tools shapes Odoo sends: list, {} (no tools) and null", async () => {
    const gw = createTestGateway();
    for (const tools of [{}, null, []]) {
      gw.adapters.openai.then([{ type: "text", text: "ok" }]);
      const res = await gw.rpc("1/get_completions_sync", agentPayload({ tools }));
      expect(res.body.result.status).toBe("success");
      expect(gw.adapters.openai.completions.at(-1)!.tools).toEqual([]);
    }
  });

  it("uses the turn-limit round like any other (ask_user_question tool only)", async () => {
    const gw = createTestGateway();
    const askTool = { name: "ai_tool_ask_user_question", instructions: "Ask the user", schema: { type: "object", properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["question", "choices"] } };
    gw.adapters.openai.then([{ type: "tool_call", name: "ai_tool_ask_user_question", args: { question: "Continue?", choices: ["Yes", "No"] }, call_id: "c1" }]);
    const res = await gw.rpc("1/get_completions_sync", agentPayload({ tools: [askTool] }));
    expect(res.body.result.result.content[0].name).toBe("ai_tool_ask_user_question");
  });
});
