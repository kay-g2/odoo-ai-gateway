import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/load.js";
import { UnsupportedFeatureError } from "../../src/core/errors.js";
import type { CompletionParams } from "../../src/core/odoo-types.js";
import { bumpEffort, completionFeatures, ensureSupported, resolveJob } from "../../src/router/router.js";
import { agentPayload, baseConfig, createTestGateway } from "../helpers/gateway.js";
import { ScriptedAdapter } from "../helpers/scripted-adapter.js";

const config = parseConfig(baseConfig());

describe("resolveJob: most specific entry wins", () => {
  it("1. exact usage", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "ai_field", webGrounding: true });
    expect(d).toMatchObject({ matchedBy: "usage", job: "usage:ai_field", target: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" } });
  });

  it("1. exact usage for a specific agent beats the agent: prefix", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "agent:ai.ai_default_agent" });
    expect(d).toMatchObject({ matchedBy: "usage", tier: "balanced", target: { provider: "openai", model: "gpt-5.6" } });
  });

  it("2. agent: prefix for any other agent (xmlid or custom)", () => {
    for (const usage of ["agent:ai_livechat.ai_agent_livechat", "agent:custom"]) {
      const d = resolveJob(config, { route: "1/get_completions", usage });
      expect(d).toMatchObject({ matchedBy: "agent", target: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" } });
    }
  });

  it("2. agent: prefix beats feature entries and route", () => {
    const d = resolveJob(config, { route: "1/get_completions_sync", usage: "agent:custom", webGrounding: true });
    expect(d.matchedBy).toBe("agent");
  });

  it("3. image_generation has its own entry (Odoo sends no usage for images)", () => {
    const d = resolveJob(config, { route: "1/get_completions_sync", imageGeneration: true });
    expect(d).toMatchObject({ matchedBy: "feature:image_generation", target: { provider: "gemini", model: "gemini-3.1-flash-image" } });
  });

  it("3. web_grounding has its own entry when the usage has none", () => {
    const d = resolveJob(config, { route: "1/get_completions_sync", usage: "some_future_usage", webGrounding: true });
    expect(d).toMatchObject({ matchedBy: "feature:web_grounding", target: { provider: "gemini", effort: "low" } });
  });

  it("3. image_generation is checked before web_grounding", () => {
    const d = resolveJob(config, { route: "1/get_completions_sync", imageGeneration: true, webGrounding: true });
    expect(d.matchedBy).toBe("feature:image_generation");
  });

  it("4. route entry", () => {
    const d = resolveJob(config, { route: "1/get_transcription" });
    expect(d).toMatchObject({ matchedBy: "route", job: "route:1/get_transcription", target: { provider: "openai", model: "whisper-1" } });
  });

  it("5. default when nothing else matches (unknown usage, no flags, no route entry)", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "some_future_usage" });
    expect(d).toMatchObject({ matchedBy: "default", tier: "balanced", target: { provider: "openai", model: "gpt-5.6", effort: "low" } });
  });

  it("route entry for completions applies when present", () => {
    const withRoute = parseConfig(baseConfig({
      routing: { ...baseConfig().routing!, routes: { "1/get_completions_sync": { provider: "openrouter", model: "x/y" } } },
    }));
    expect(resolveJob(withRoute, { route: "1/get_completions_sync", usage: "some_future_usage" })).toMatchObject({ matchedBy: "route", target: { provider: "openrouter" } });
    expect(resolveJob(withRoute, { route: "1/get_completions", usage: "some_future_usage" }).matchedBy).toBe("default");
    expect(resolveJob(withRoute, { route: "1/get_completions_sync" }).matchedBy).toBe("route");
  });

  it("every Odoo 20 usage routes to its own exact entry", () => {
    const expected: Record<string, { provider: string; model: string; effort?: string }> = {
      channel_name: { provider: "openai", model: "gpt-5.6-luna", effort: "minimal" },
      ai_field: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      web_search: { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      ai_action: { provider: "openai", model: "gpt-5.6-sol", effort: "medium" },
      website_builder_css_polish: { provider: "openai", model: "gpt-5.6-luna", effort: "minimal" },
      website_builder_shapes: { provider: "grok", model: "grok-4.5", effort: "low" },
      esg_metrics: { provider: "openrouter", model: "openai/gpt-5.6-sol", effort: "medium" },
      "agent:ai.ai_default_agent": { provider: "openai", model: "gpt-5.6", effort: "low" },
    };
    // Flags Odoo sends with each usage must not steal the exact match.
    const flags: Record<string, { webGrounding?: boolean }> = { ai_field: { webGrounding: true }, web_search: { webGrounding: true } };
    for (const [usage, target] of Object.entries(expected)) {
      for (const route of ["1/get_completions", "1/get_completions_sync"] as const) {
        const d = resolveJob(config, { route, usage, ...flags[usage] });
        expect(d.matchedBy, usage).toBe("usage");
        expect(d.job).toBe(`usage:${usage}`);
        expect(d.target).toMatchObject(target);
      }
    }
  });

  it("an unknown usage without flags or route entry falls to default, never to another usage", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "website_builder" });
    expect(d.matchedBy).toBe("default");
  });
});

describe("boost_reasoning moves one row up", () => {
  it("tier entry -> next tier", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "agent:ai.ai_default_agent", boostReasoning: true });
    expect(d).toMatchObject({ boosted: true, tier: "deep", target: { provider: "claude", model: "claude-opus-5-5", effort: "high" } });
  });

  it("fast -> balanced", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "channel_name", boostReasoning: true });
    expect(d).toMatchObject({ tier: "balanced", target: { model: "gpt-5.6", effort: "low" } });
  });

  it("top tier -> one effort level up", () => {
    const top = parseConfig(baseConfig({ routing: { ...baseConfig().routing!, default: "deep" } }));
    const d = resolveJob(top, { route: "1/get_completions", usage: "some_future_usage", boostReasoning: true });
    expect(d).toMatchObject({ boosted: true, tier: "deep", target: { model: "claude-opus-5-5", effort: "xhigh" } });
  });

  it("inline entry -> one effort level up, same provider and model", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "agent:custom", boostReasoning: true });
    expect(d).toMatchObject({ boosted: true, target: { provider: "claude", model: "claude-sonnet-5-5", effort: "high" } });
  });

  it("without boost nothing changes", () => {
    const d = resolveJob(config, { route: "1/get_completions", usage: "agent:custom", boostReasoning: false });
    expect(d).toMatchObject({ boosted: false, target: { effort: "medium" } });
  });

  it("effort ladder", () => {
    expect(bumpEffort("none")).toBe("minimal");
    expect(bumpEffort("minimal")).toBe("low");
    expect(bumpEffort("low")).toBe("medium");
    expect(bumpEffort("medium")).toBe("high");
    expect(bumpEffort("high")).toBe("xhigh");
    expect(bumpEffort("xhigh")).toBe("max");
    expect(bumpEffort("max")).toBe("max");
    expect(bumpEffort(undefined)).toBe("high");
  });
});

describe("features and capability checks", () => {
  const base: CompletionParams = { messages: [], instructions: "" };

  it("derives features from tools, schema, flags and attachments", () => {
    expect(completionFeatures(base)).toEqual(["completion"]);
    expect(completionFeatures({ ...base, tools: {} })).toEqual(["completion"]);
    expect(completionFeatures({ ...base, tools: [{ name: "t", instructions: "", schema: null }] })).toContain("tools");
    const aiField = completionFeatures({ ...base, schema: { type: "object" }, web_grounding: true });
    expect(aiField).toEqual(expect.arrayContaining(["schema", "web_grounding", "web_grounding+schema"]));
    const withFiles = completionFeatures({
      ...base,
      messages: [
        { role: "user", content: [{ type: "inline_data", mimetype: "application/pdf", data: "JVBERi0=" }] },
        { role: "user", content: [{ type: "tool_result", tool_name: "t", tool_call_id: "1", success: true, result: [{ type: "inline_data", mimetype: "image/png", data: "iVBO" }] }] },
      ],
    });
    expect(withFiles).toEqual(expect.arrayContaining(["pdf_input", "image_input"]));
    expect(completionFeatures({ ...base, image_generation: true })).toContain("image_generation");
    expect(completionFeatures({ ...base, tools: [{ name: "t", instructions: "", schema: null }], schema: { type: "object" } })).toContain("tools+schema");
  });

  it("unsupported feature fails and names the provider, model and job", () => {
    const decision = resolveJob(config, { route: "1/get_completions_sync", usage: "ai_field", webGrounding: true });
    const adapter = new ScriptedAdapter("gemini", new Set(["web_grounding+schema"]));
    expect(() => ensureSupported(adapter, decision, ["completion", "schema", "web_grounding", "web_grounding+schema"])).toThrow(UnsupportedFeatureError);
    try {
      ensureSupported(adapter, decision, ["completion", "schema", "web_grounding", "web_grounding+schema"]);
    } catch (error) {
      expect((error as UnsupportedFeatureError).features).toEqual(["web_grounding+schema"]);
      expect((error as Error).message).toContain("gemini");
      expect((error as Error).message).toContain("usage:ai_field");
    }
  });

  it("per-entry capability overrides win over the adapter", () => {
    const decision = { job: "x", matchedBy: "default" as const, boosted: false, target: { provider: "openrouter" as const, model: "m", capabilities: { image_generation: false, pdf_input: true } } };
    const adapter = new ScriptedAdapter("openrouter", new Set(["pdf_input"]));
    expect(() => ensureSupported(adapter, decision, ["image_generation"])).toThrow(UnsupportedFeatureError);
    expect(() => ensureSupported(adapter, decision, ["pdf_input"])).not.toThrow();
  });
});

describe("unsupported feature through the routes: fail, never switch provider", () => {
  it("image_generation routed to a provider without it", async () => {
    const cfg = baseConfig();
    cfg.routing!.features = { image_generation: { provider: "claude", model: "claude-opus-5-5" } };
    const gw = createTestGateway(cfg, { unsupported: { claude: ["image_generation"] } });
    const res = await gw.rpc("1/get_completions_sync", { messages: [], instructions: "", image_generation: true });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.UnsupportedFeatureError");
    expect(res.body.error.data.message).toContain("image_generation");
    for (const adapter of Object.values(gw.adapters)) expect(adapter.completions).toHaveLength(0);
  });

  it("async route: unsupported feature is refused in the JSON-RPC ack, no webhook", async () => {
    const gw = createTestGateway(baseConfig(), { unsupported: { claude: ["tools"] } });
    const res = await gw.rpc("1/get_completions", {
      ...agentPayload({ usage: "agent:custom" }),
      request_uuid: "u1",
      webhook_url: "https://odoo.example.com/ai/completion_result_ready",
      webhook_secret: "s",
    });
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.UnsupportedFeatureError");
    await gw.tasks.idle();
    expect(gw.webhook.calls).toHaveLength(0);
    expect(gw.adapters.openai.completions).toHaveLength(0);
  });

  it("ai_field (schema + web grounding) on a provider that cannot combine them", async () => {
    const gw = createTestGateway(baseConfig(), { unsupported: { gemini: ["web_grounding+schema"] } });
    const res = await gw.rpc("1/get_completions_sync", {
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      instructions: "",
      schema: { type: "object", properties: {} },
      web_grounding: true,
      usage: "ai_field",
    });
    expect(res.body.error.data.message).toContain("web_grounding+schema");
    expect(gw.adapters.gemini.completions).toHaveLength(0);
  });

  it("routing to a provider without credentials is a configuration error", () => {
    const cfg = baseConfig({ providers: { openai: { apiKey: "k" } } });
    expect(() => parseConfig(cfg)).toThrow(/no credentials/);
  });
});
