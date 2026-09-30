/**
 * `1/get_completions`: JSON-RPC ack `{}` within Odoo's 5 s transport timeout, then a signed
 * plain-JSON POST to `webhook_url` shaped like Odoo's own tests expect
 * (enterprise/ai/tests/common.py `_deliver_iap_callbacks`, ai_livechat test_ai_livechat_cors.py).
 */
import { describe, expect, it } from "vitest";

import { verifyWebhookBody } from "../../src/core/signature.js";
import { jsonResponse } from "../helpers/mock-fetch.js";
import { agentPayload, asyncParams, baseConfig, createTestGateway } from "../helpers/gateway.js";

describe("1/get_completions (async + webhook)", () => {
  it("acks with result {} and posts a signed plain JSON body to webhook_url", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "Hello from the gateway" }]);
    gw.webhook.reply(new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }));

    const params = { ...agentPayload({ usage: "agent:ai.ai_default_agent" }), ...asyncParams() };
    const ack = await gw.rpc("1/get_completions", params);
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({ jsonrpc: "2.0", id: "req1", result: {} });

    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(1);
    const call = gw.webhook.last;
    expect(call.url).toBe("https://odoo.example.com/ai/completion_result_ready");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-odoo-database"]).toBe("odoo_prod");

    // Plain JSON (type='json2' route), not a JSON-RPC envelope.
    const body = call.body;
    expect(Object.keys(body).sort()).toEqual(["llm_error", "llm_result", "request_uuid", "signature"]);
    expect(body).not.toHaveProperty("jsonrpc");
    expect(body.request_uuid).toBe(params.request_uuid);
    expect(body.llm_error).toBe(false);
    expect(body.llm_result.status).toBe("success");
    expect(body.llm_result.result).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello from the gateway" }],
      provider_metadata: { provider: "openai", model: "gpt-5.6" },
    });
    expect(body.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookBody(params.webhook_secret as string, body)).toBe(true);
    expect(verifyWebhookBody("another-secret", body)).toBe(false);
  });

  it("forwards instructions, messages and tools untouched and never runs tools", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "tool_call", name: "create_lead", args: { name: "Acme", tool_status: "Creating lead" }, call_id: "call_1" }]);
    gw.webhook.reply({});
    const params = { ...agentPayload(), ...asyncParams() };
    await gw.rpc("1/get_completions", params);
    await gw.tasks.idle();

    const request = gw.adapters.openai.completions[0]!;
    expect(request.instructions).toBe(params.instructions);
    expect(request.messages).toEqual(params.messages);
    expect(request.tools).toEqual(params.tools);
    const content = gw.webhook.last.body.llm_result.result.content;
    expect(content).toEqual([{ type: "tool_call", name: "create_lead", args: { name: "Acme", tool_status: "Creating lead" }, call_id: "call_1" }]);
  });

  it("reports provider failures as llm_result false + llm_error, still signed", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then(new Error("upstream exploded"));
    gw.webhook.reply({});
    const params = { ...agentPayload(), ...asyncParams() };
    const ack = await gw.rpc("1/get_completions", params);
    expect(ack.body.result).toEqual({});
    await gw.tasks.idle();
    const body = gw.webhook.last.body;
    expect(body.llm_result).toBe(false);
    expect(body.llm_error).toContain("upstream exploded");
    expect(verifyWebhookBody(params.webhook_secret as string, body)).toBe(true);
  });

  it("retries the postback only when it certainly did not reach Odoo (connect errors, 503)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    gw.webhook
      .reply(() => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" }) });
      })
      .reply(jsonResponse({ error: "busy" }, 503))
      .reply({});
    await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(3);
    expect(gw.webhook.calls[0]!.rawBody).toBe(gw.webhook.calls[2]!.rawBody);
  });

  it("does not retry ambiguous failures: Odoo may still be running the tool batch", async () => {
    for (const failure of [
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
      },
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 502),
      () => jsonResponse({}, 504),
    ]) {
      const gw = createTestGateway();
      gw.adapters.openai.then([{ type: "text", text: "ok" }]);
      gw.webhook.reply(failure).reply({});
      await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
      await gw.tasks.idle();
      expect(gw.webhook.calls).toHaveLength(1);
      expect(gw.webhook.pending).toBe(1);
    }
  });

  it("does not follow redirects (allow-list bypass, POST turned into GET)", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    gw.webhook.reply(new Response(null, { status: 307, headers: { Location: "http://169.254.169.254/latest/meta-data" } }));
    await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(1);
    expect(gw.webhook.last.redirect).toBe("manual");
  });

  it("does not retry a 4xx answer from Odoo", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    gw.webhook.reply(jsonResponse({}, 404));
    await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(1);
  });

  it("omits X-Odoo-Database when Odoo does not send webhook_dbname", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    gw.webhook.reply({});
    const params = { ...agentPayload(), ...asyncParams() };
    delete params.webhook_dbname;
    await gw.rpc("1/get_completions", params);
    await gw.tasks.idle();
    expect(gw.webhook.last.headers).not.toHaveProperty("x-odoo-database");
  });

  it("rejects missing webhook fields synchronously (Odoo then fails the session itself)", async () => {
    const gw = createTestGateway();
    for (const field of ["request_uuid", "webhook_url", "webhook_secret"]) {
      const params = { ...agentPayload(), ...asyncParams() };
      delete params[field];
      const res = await gw.rpc("1/get_completions", params);
      expect(res.status).toBe(200);
      expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.InvalidRequestError");
      expect(res.body.error.data.message).toContain(field);
    }
    const bad = await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams({ webhook_url: "ftp://odoo.example.com/x" }) });
    expect(bad.body.error.data.message).toContain("http");
    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(0);
    expect(gw.adapters.openai.completions).toHaveLength(0);
  });

  it("enforces webhook host allow-list when configured", async () => {
    const gw = createTestGateway(baseConfig({ webhook: { allowedHosts: ["*.odoo.com"], initialBackoffMs: 0 } }));
    const denied = await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
    expect(denied.body.error.data.message).toContain("not allowed");
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    gw.webhook.reply({});
    const allowed = await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams({ webhook_url: "https://acme.odoo.com/ai/completion_result_ready" }) });
    expect(allowed.body.result).toEqual({});
    await gw.tasks.idle();
  });

  it("acknowledges before the provider answers", async () => {
    const gw = createTestGateway();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gw.adapters.openai.then(async () => {
      await gate;
      return [{ type: "text", text: "late" }];
    });
    gw.webhook.reply({});
    const ack = await gw.rpc("1/get_completions", { ...agentPayload(), ...asyncParams() });
    expect(ack.body.result).toEqual({});
    expect(gw.webhook.calls).toHaveLength(0);
    expect(gw.tasks.size).toBe(1);
    release();
    await gw.tasks.idle();
    expect(gw.webhook.last.body.llm_result.result.content[0].text).toBe("late");
  });
});

describe("authentication", () => {
  it("rejects a missing or unknown account_token on protected routes", async () => {
    const gw = createTestGateway();
    const missing = await gw.rpc("1/get_completions_sync", agentPayload(), { withToken: false });
    expect(missing.body.error.data.name).toBe("odoo_ai_gateway.errors.AccessDeniedError");
    const payload = { jsonrpc: "2.0", method: "call", id: 1, params: { ...agentPayload(), account_token: "nope" } };
    const res = await gw.app.request("/api/odoo_ai/1/get_completions_sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(body.id).toBe(1);
    expect(body.error.data.message).toBe("Unknown account_token");
    expect(gw.adapters.openai.completions).toHaveLength(0);
  });

  it("answers JSON-RPC errors with HTTP 200 and error.data.name (iap_jsonrpc contract)", async () => {
    const gw = createTestGateway();
    const res = await gw.app.request("/api/odoo_ai/1/get_completions_sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32700);
    expect(typeof body.error.data.name).toBe("string");
    const notRpc = await gw.app.request("/api/odoo_ai/1/get_completions_sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) });
    expect(((await notRpc.json()) as any).error.code).toBe(-32600);
  });

  it("tolerates ai.endpoint with a trailing slash or a path prefix", async () => {
    const gw = createTestGateway();
    for (const path of ["//api/odoo_ai/1/get_default_embedding_model", "/ai-gateway/api/odoo_ai/1/get_default_embedding_model"]) {
      const res = await gw.app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: {} }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "text-embedding-3-small" });
    }
  });

  it("returns a JSON-RPC error for unknown routes", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_something_else", {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32601);
  });
});
