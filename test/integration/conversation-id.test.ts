/**
 * Conversation id round trip through Odoo: minted on a conversation's first request, returned in
 * `provider_metadata.conversation_id`, stored by Odoo in `ai.session.event` (jsonb) and read back
 * from the history on every later round and turn.
 */
import { describe, expect, it } from "vitest";

import { verifyWebhookBody } from "../../src/core/signature.js";
import { CONVERSATION_ID_PATTERN } from "../../src/services/conversation-id.js";
import { agentPayload, asyncParams, createTestGateway, type TestGateway } from "../helpers/gateway.js";

/** PostgreSQL jsonb key order: shorter keys first, then bytewise. */
function jsonbRoundTrip<T>(value: T): T {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (!node || typeof node !== "object") return node;
    const keys = Object.keys(node).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((key) => [key, sort((node as Record<string, unknown>)[key])]));
  };
  return sort(JSON.parse(JSON.stringify(value))) as T;
}

const context = (time: string) => ({ type: "text", text: `<odoo_current_context>\n## Date\n2026-09-29 ${time} (UTC)</odoo_current_context>` });

/** Run one async round the way Odoo does and return the (signature-checked) assistant message. */
async function round(gw: TestGateway, messages: unknown[], extra: Record<string, unknown> = {}) {
  const secret = `secret-${gw.webhook.calls.length}`;
  const params = { ...agentPayload({ messages, ...extra }), ...asyncParams({ request_uuid: `round-${gw.webhook.calls.length}`, webhook_secret: secret }) };
  gw.webhook.reply({});
  const ack = await gw.rpc("1/get_completions", params);
  expect(ack.body.result).toEqual({});
  await gw.tasks.idle();
  const body = gw.webhook.last.body;
  expect(verifyWebhookBody(secret, body)).toBe(true);
  expect(body.llm_error).toBe(false);
  return body.llm_result.result;
}

describe("conversation id", () => {
  it("is minted on the first round and read back on every later round and turn, across jsonb storage", async () => {
    const gw = createTestGateway();
    const toolCall = { type: "tool_call", name: "create_lead", args: { name: "Acme", tool_status: "Creating" }, call_id: "call_1" } as const;
    gw.adapters.openai.then([toolCall]).then([{ type: "text", text: "Lead created." }]).then([{ type: "text", text: "It is lead #7." }]);

    // Turn 1, round 1: nothing in the history yet.
    const firstUser = { role: "user", content: [{ type: "text", text: "Create a lead for Acme" }, context("10:00:00")] };
    const a1 = await round(gw, [firstUser]);
    const id = a1.provider_metadata.conversation_id;
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    expect(gw.adapters.openai.completions[0]!.conversationId).toBe(id);

    // Round 2: Odoo stored the message as jsonb (keys reordered) and rewrote the context block.
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: "call_1", result: [{ type: "text", text: "Lead #7" }], success: true }],
    };
    const stored1 = jsonbRoundTrip(a1);
    expect(Object.keys(stored1.provider_metadata)).not.toEqual(Object.keys(a1.provider_metadata));
    const history2 = [{ ...firstUser, content: [firstUser.content[0], context("10:00:07")] }, stored1, toolResult];
    const a2 = await round(gw, history2);
    expect(gw.adapters.openai.completions[1]!.conversationId).toBe(id);
    expect(a2.provider_metadata.conversation_id).toBe(id);

    // Turn 2: a new user message; the context block moves to it.
    const history3 = [firstUser, stored1, toolResult, jsonbRoundTrip(a2), { role: "user", content: [{ type: "text", text: "Which id?" }, context("10:05:00")] }];
    const a3 = await round(gw, history3);
    expect(gw.adapters.openai.completions[2]!.conversationId).toBe(id);
    expect(a3.provider_metadata.conversation_id).toBe(id);
  });

  it("survives a provider switch (\"Think longer\" moves the job to another tier)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "Quick answer" }]);
    gw.adapters.claude.then([{ type: "text", text: "Deeper answer" }]);
    const first = { role: "user", content: [{ type: "text", text: "Plan my week" }] };
    const a1 = await round(gw, [first]);
    const a2 = await round(gw, [first, jsonbRoundTrip(a1), { role: "user", content: [{ type: "text", text: "Think harder" }] }], { boost_reasoning: true });
    expect(a2.provider_metadata.provider).toBe("claude");
    expect(gw.adapters.claude.completions[0]!.conversationId).toBe(a1.provider_metadata.conversation_id);
    expect(a2.provider_metadata.conversation_id).toBe(a1.provider_metadata.conversation_id);
  });

  it("gives separate conversations separate ids", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "one" }]).then([{ type: "text", text: "two" }]);
    const a = await round(gw, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
    const b = await round(gw, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
    expect(a.provider_metadata.conversation_id).not.toBe(b.provider_metadata.conversation_id);
  });

  it("starts an id for histories from before ids existed, then keeps it", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "new" }]).then([{ type: "text", text: "newer" }]);
    const legacy = { role: "assistant", content: [{ type: "text", text: "old" }], provider_metadata: { provider: "openai", model: "gpt-5.6" } };
    const history = [{ role: "user", content: [{ type: "text", text: "a" }] }, legacy, { role: "user", content: [{ type: "text", text: "b" }] }];
    const a1 = await round(gw, history);
    const id = a1.provider_metadata.conversation_id;
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    const a2 = await round(gw, [...history, jsonbRoundTrip(a1), { role: "user", content: [{ type: "text", text: "c" }] }]);
    expect(a2.provider_metadata.conversation_id).toBe(id);
  });

  it("never forwards a malformed id from the history", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    const tampered = { role: "assistant", content: [{ type: "text", text: "x" }], provider_metadata: { conversation_id: "cv_<script>alert(1)</script>" } };
    const a1 = await round(gw, [{ role: "user", content: [{ type: "text", text: "a" }] }, tampered, { role: "user", content: [{ type: "text", text: "b" }] }]);
    const id = a1.provider_metadata.conversation_id;
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    expect(gw.adapters.openai.completions[0]!.conversationId).toBe(id);
  });

  it("is returned by the sync route too (one-shot loops keep the message in memory)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "tool_call", name: "create_lead", args: { name: "Acme" }, call_id: "c1" }]).then([{ type: "text", text: "done" }]);
    const first = { role: "user", content: [{ type: "text", text: "Create Acme" }] };
    const r1 = await gw.rpc("1/get_completions_sync", agentPayload({ messages: [first] }));
    const a1 = r1.body.result.result;
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_name: "create_lead", tool_call_id: "c1", result: [{ type: "text", text: "ok" }], success: true }] };
    const r2 = await gw.rpc("1/get_completions_sync", agentPayload({ messages: [first, a1, toolResult] }));
    expect(r2.body.result.result.provider_metadata.conversation_id).toBe(a1.provider_metadata.conversation_id);
    expect(gw.adapters.openai.completions.map((request) => request.conversationId)).toEqual([
      a1.provider_metadata.conversation_id,
      a1.provider_metadata.conversation_id,
    ]);
  });
});
