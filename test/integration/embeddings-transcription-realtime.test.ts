import { describe, expect, it } from "vitest";

import { baseConfig, createTestGateway } from "../helpers/gateway.js";

describe("embeddings", () => {
  it("1/get_embeddings returns one 1536-d vector per input item", async () => {
    const gw = createTestGateway();
    const input = [
      { title: "Refund policy", content: "Refunds are accepted within 30 days." },
      { title: null, content: "Shipping takes 3 days." },
      { title: "Empty", content: "" },
    ];
    const res = await gw.rpc("1/get_embeddings", { input, model: "text-embedding-3-small", mode: "document" });
    expect(res.body.result.status).toBe("success");
    const vectors = res.body.result.embeddings as number[][];
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(1536);
      expect(vector.every((x) => typeof x === "number")).toBe(true);
    }
    const request = gw.adapters.openai.embeddings[0]!;
    expect(request).toMatchObject({ model: "text-embedding-3-small", mode: "document", dimensions: 1536 });
    expect(request.inputs).toEqual([
      { title: "Refund policy", content: "Refunds are accepted within 30 days." },
      { title: null, content: "Shipping takes 3 days." },
      { title: "Empty", content: "" },
    ]);
  });

  it("RAG query embedding (mode=query, no title) and missing model fall back to the default", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_embeddings", { input: [{ content: "How do refunds work?" }], model: null, mode: "query" });
    expect(res.body.result.embeddings).toHaveLength(1);
    expect(res.body.result.embeddings[0]).toHaveLength(1536);
    expect(gw.adapters.openai.embeddings[0]).toMatchObject({ mode: "query", model: "text-embedding-3-small" });
  });

  it("rejects vectors that are not 1536-d", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.embedDimensions = 3072;
    const res = await gw.rpc("1/get_embeddings", { input: [{ content: "x" }], model: "text-embedding-3-small", mode: "document" });
    expect(res.body.error.data.message).toContain("1536");
  });

  it("rejects unsupported embedding model names so Odoo's cron migrates them", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_embeddings", { input: [{ content: "x" }], model: "deprecated_embedding", mode: "document" });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.RoutingError");
  });

  it("default and supported models: a string and a list, without account_token", async () => {
    const config = baseConfig();
    config.embeddings = { additional: [{ provider: "gemini", model: "gemini-embedding-001", name: "gemini-embedding-001@1536" }] };
    const gw = createTestGateway(config);
    const def = await gw.rpc("1/get_default_embedding_model", {}, { withToken: false });
    expect(def.body.result).toBe("text-embedding-3-small");
    const supported = await gw.rpc("1/get_supported_embedding_models", {}, { withToken: false });
    expect(supported.body.result).toEqual(["text-embedding-3-small", "gemini-embedding-001@1536"]);

    const legacy = await gw.rpc("1/get_embeddings", { input: [{ content: "x" }], model: "gemini-embedding-001@1536", mode: "document" });
    expect(legacy.body.result.embeddings[0]).toHaveLength(1536);
    expect(gw.adapters.gemini.embeddings[0]!.model).toBe("gemini-embedding-001");
  });

  it("fails without fallback when the routed provider has no embeddings", async () => {
    const config = baseConfig();
    config.routing!.routes = { ...config.routing!.routes, "1/get_embeddings": { provider: "claude", model: "claude-haiku-4-5" } };
    const gw = createTestGateway(config, { unsupported: { claude: ["embeddings"] } });
    const res = await gw.rpc("1/get_embeddings", { input: [{ content: "x" }], model: "claude-haiku-4-5", mode: "document" });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.UnsupportedFeatureError");
    expect(gw.adapters.openai.embeddings).toHaveLength(0);
  });
});

describe("transcription", () => {
  it("1/get_transcription returns {text} for voice notes", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_transcription", { audio: "SUQzBAAAAAAA", mimetype: "audio/mp3", language: "fr" });
    expect(res.body.result).toEqual({ status: "success", text: "transcribed text" });
    expect(gw.adapters.openai.transcriptions[0]).toMatchObject({ model: "whisper-1", audio: "SUQzBAAAAAAA", mimetype: "audio/mp3", language: "fr", responseFormat: "text" });
  });

  it("call recordings ask for VTT (mail.call.artifact)", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_transcription", { audio: "T2dnUw==", response_format: "vtt", mimetype: "audio/ogg" });
    expect(res.body.result.text.startsWith("WEBVTT")).toBe(true);
    expect(gw.adapters.openai.transcriptions[0]!.responseFormat).toBe("vtt");
  });

  it("requires audio", async () => {
    const gw = createTestGateway();
    const res = await gw.rpc("1/get_transcription", { mimetype: "audio/mp3" });
    expect(res.body.error.data.message).toContain("audio");
  });
});

describe("realtime transcription session", () => {
  it("returns session_token and iap_transaction_token; usage report comes without account_token", async () => {
    const gw = createTestGateway();
    const session = await gw.rpc("1/get_realtime_session_token", { language: "en", prompt: "Meeting notes about Q3" });
    expect(session.body.result.session_token).toBe("ek_test_ephemeral");
    expect(session.body.result.iap_transaction_token).toMatch(/^rt1\./);
    expect(gw.adapters.openai.realtimeSessions[0]).toMatchObject({ model: "gpt-4o-transcribe", language: "en", prompt: "Meeting notes about Q3" });

    const usage = { input_tokens: { text: 12, audio: 480 }, output_tokens: 64, duration_seconds: 31.5 };
    const report = await gw.rpc(
      "1/report_realtime_session_usage",
      { iap_transaction_token: session.body.result.iap_transaction_token, usage },
      { withToken: false },
    );
    expect(report.body.result).toEqual({});
    expect(gw.realtimeTokens.reports).toHaveLength(1);
    expect(gw.realtimeTokens.reports[0]!.usage).toEqual(usage);
    expect(gw.realtimeTokens.reports[0]!.claims).toMatchObject({ dbuuid: "db-uuid-1", provider: "openai", model: "gpt-4o-transcribe" });
  });

  it("rejects a forged transaction token", async () => {
    const gw = createTestGateway();
    const session = await gw.rpc("1/get_realtime_session_token", { language: "en" });
    const token: string = session.body.result.iap_transaction_token;
    const [v, payload] = token.split(".");
    const forged = `${v}.${payload}.AAAA`;
    const res = await gw.rpc("1/report_realtime_session_usage", { iap_transaction_token: forged, usage: {} }, { withToken: false });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.AccessDeniedError");
    expect(gw.realtimeTokens.reports).toHaveLength(0);
  });

  it("accepts each transaction token once and keeps only the documented numbers", async () => {
    const gw = createTestGateway();
    const session = await gw.rpc("1/get_realtime_session_token", { language: "en" });
    const token = session.body.result.iap_transaction_token;
    const usage = { input_tokens: { text: 1, audio: 2, extra: "x".repeat(100) }, output_tokens: 3, duration_seconds: 4, note: "ignored" };
    const first = await gw.rpc("1/report_realtime_session_usage", { iap_transaction_token: token, usage }, { withToken: false });
    expect(first.body.result).toEqual({});
    expect(gw.realtimeTokens.reports[0]!.usage).toEqual({ input_tokens: { text: 1, audio: 2 }, output_tokens: 3, duration_seconds: 4 });
    const replay = await gw.rpc("1/report_realtime_session_usage", { iap_transaction_token: token, usage }, { withToken: false });
    expect(replay.body.error.data.message).toContain("already reported");
    expect(gw.realtimeTokens.reports).toHaveLength(1);
  });

  it("rejects malformed usage and oversized bodies on the public route", async () => {
    const gw = createTestGateway();
    const token = (await gw.rpc("1/get_realtime_session_token", { language: "en" })).body.result.iap_transaction_token;
    const bad = await gw.rpc("1/report_realtime_session_usage", { iap_transaction_token: token, usage: { output_tokens: -5 } }, { withToken: false });
    expect(bad.body.error.data.name).toBe("odoo_ai_gateway.errors.InvalidRequestError");
    const huge = await gw.app.request("/api/odoo_ai/1/report_realtime_session_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { iap_transaction_token: token, usage: { pad: "x".repeat(200_000) } } }),
    });
    expect(huge.status).toBe(413);
    expect(gw.realtimeTokens.reports).toHaveLength(0);
  });

  it("rejects expired transaction tokens", async () => {
    const { RealtimeTokenService } = await import("../../src/services/realtime-tokens.js");
    const { silentLogger } = await import("../../src/core/logger.js");
    let now = Date.UTC(2026, 8, 29, 8, 0, 0);
    const tokens = new RealtimeTokenService("a-long-enough-secret", silentLogger, () => now);
    const token = tokens.issue({ provider: "openai", model: "gpt-4o-transcribe" });
    now += 13 * 3600 * 1000;
    expect(() => tokens.report(token, {})).toThrow(/Expired/);
  });

  it("fails when the routed provider cannot mint realtime sessions", async () => {
    const config = baseConfig();
    config.routing!.routes = { ...config.routing!.routes, "1/get_realtime_session_token": { provider: "gemini", model: "gemini-3.8-flash" } };
    const gw = createTestGateway(config, { unsupported: { gemini: ["realtime"] } });
    const res = await gw.rpc("1/get_realtime_session_token", { language: "en" });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.UnsupportedFeatureError");
  });
});
