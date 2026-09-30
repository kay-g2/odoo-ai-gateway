/** Build a gateway app wired to scripted adapters and a mocked webhook receiver. */
import { createApp } from "../../src/app.js";
import { parseConfig } from "../../src/config/load.js";
import type { GatewayConfig, GatewayConfigInput } from "../../src/config/schema.js";
import type { ProviderAdapter, ProviderName } from "../../src/providers/types.js";
import { MockFetch } from "./mock-fetch.js";
import { ScriptedAdapter } from "./scripted-adapter.js";

export const ACCOUNT_TOKEN = "odoo-iap-account-token";

export function baseConfig(overrides: Partial<GatewayConfigInput> = {}): GatewayConfigInput {
  return {
    auth: { accountTokens: [ACCOUNT_TOKEN] },
    webhook: { maxAttempts: 3, initialBackoffMs: 0, timeoutSeconds: 5 },
    providers: {
      openai: { apiKey: "test-openai" },
      claude: { apiKey: "test-claude" },
      gemini: { apiKey: "test-gemini" },
      grok: { apiKey: "test-grok" },
      openrouter: { apiKey: "test-openrouter" },
    },
    tiers: [
      { name: "fast", provider: "openai", model: "gpt-5.6-luna", effort: "minimal" },
      { name: "balanced", provider: "openai", model: "gpt-5.6", effort: "low" },
      { name: "deep", provider: "claude", model: "claude-opus-5-5", effort: "high" },
    ],
    routing: {
      default: "balanced",
      usages: {
        channel_name: "fast",
        ai_field: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
        web_search: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
        "agent:ai.ai_default_agent": "balanced",
        website_builder_css_polish: { provider: "openai", model: "gpt-5.6-luna", effort: "minimal" },
        website_builder_shapes: { provider: "grok", model: "grok-4.5", effort: "low" },
        ai_action: { provider: "openai", model: "gpt-5.6-sol", effort: "medium" },
        esg_metrics: { provider: "openrouter", model: "openai/gpt-5.6-sol", effort: "medium" },
      },
      agent: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      features: {
        image_generation: { provider: "gemini", model: "gemini-3.1-flash-image" },
        web_grounding: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      },
      routes: {
        "1/get_embeddings": { provider: "openai", model: "text-embedding-3-small" },
        "1/get_transcription": { provider: "openai", model: "whisper-1" },
        "1/get_realtime_session_token": { provider: "openai", model: "gpt-4o-transcribe" },
      },
    },
    ...overrides,
  };
}

export interface TestGateway {
  config: GatewayConfig;
  app: ReturnType<typeof createApp>["app"];
  tasks: ReturnType<typeof createApp>["tasks"];
  realtimeTokens: ReturnType<typeof createApp>["realtimeTokens"];
  webhook: MockFetch;
  adapters: Record<ProviderName, ScriptedAdapter>;
  /** POST a JSON-RPC 2.0 call like odoo.addons.iap.tools.iap_tools.iap_jsonrpc. */
  rpc(route: string, params: Record<string, unknown>, options?: { withToken?: boolean }): Promise<{ status: number; body: any }>;
}

export function createTestGateway(
  configInput: GatewayConfigInput = baseConfig(),
  options: { unsupported?: Partial<Record<ProviderName, string[]>>; adapters?: Partial<Record<ProviderName, ProviderAdapter>> } = {},
): TestGateway {
  const config = parseConfig(configInput);
  const webhook = new MockFetch();
  const adapters = Object.fromEntries(
    (["openai", "grok", "claude", "gemini", "openrouter"] as const).map((name) => [
      name,
      new ScriptedAdapter(name, new Set((options.unsupported?.[name] ?? []) as never[])),
    ]),
  ) as Record<ProviderName, ScriptedAdapter>;
  const { app, tasks, realtimeTokens } = createApp({
    config,
    adapters: { ...adapters, ...(options.adapters ?? {}) },
    fetch: webhook.fetch,
    sleep: async () => {},
  });
  let counter = 0;
  return {
    config,
    app,
    tasks,
    realtimeTokens,
    webhook,
    adapters,
    async rpc(route, params, { withToken = true } = {}) {
      const payload = {
        jsonrpc: "2.0",
        method: "call",
        params: withToken ? { ...params, account_token: ACCOUNT_TOKEN, dbuuid: "db-uuid-1" } : params,
        id: `req${++counter}`,
      };
      const response = await app.request(`/api/odoo_ai/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

/** Params Odoo's `_save_and_submit_request` adds to every async completion. */
export function asyncParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_uuid: "7d0c3f0e-6a53-4a8e-9a55-3d7c1c1f9e10",
    webhook_url: "https://odoo.example.com/ai/completion_result_ready",
    webhook_secret: "test-webhook-secret",
    webhook_dbname: "odoo_prod",
    llm_retry: false,
    ...extra,
  };
}

/** A realistic first-round agent payload (`ai.session._submit_agent_request`). */
export function agentPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Create a lead for Acme" },
          { type: "text", text: "<odoo_current_context>\n## Date\n2026-09-29 10:00:00 (UTC)</odoo_current_context>" },
        ],
      },
    ],
    instructions: "You are Odoo's AI agent.",
    tools: [
      {
        name: "create_lead",
        instructions: "Create a CRM lead.",
        schema: { type: "object", properties: { name: { type: "string" }, tool_status: { type: "string" } }, required: ["name", "tool_status"] },
      },
    ],
    usage: "agent:ai.ai_default_agent",
    boost_reasoning: false,
    ...extra,
  };
}
