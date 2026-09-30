import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { interpolateEnv, loadConfigFile, parseConfig } from "../../src/config/load.js";
import { baseConfig } from "../helpers/gateway.js";

describe("config", () => {
  it("interpolates ${VAR} and ${VAR:-default}", () => {
    const env = { KEY: "sk-test" };
    expect(interpolateEnv({ a: "${KEY}", b: ["x-${KEY}"], c: "${MISSING:-fallback}", d: 3 }, env)).toEqual({ a: "sk-test", b: ["x-sk-test"], c: "fallback", d: 3 });
    expect(() => interpolateEnv("${MISSING}", env)).toThrow(/MISSING/);
  });

  it("applies defaults", () => {
    const config = parseConfig(baseConfig());
    expect(config.server.port).toBe(8080);
    expect(config.server.completionTimeoutSeconds).toBe(300);
    expect(config.embeddings.additional).toEqual([]);
  });

  it("rejects unknown tiers, unknown providers and missing auth", () => {
    expect(() => parseConfig(baseConfig({ routing: { default: "nope" } }))).toThrow(/unknown tier "nope"/);
    expect(() => parseConfig({ ...baseConfig(), routing: { default: { provider: "mistral", model: "x" } } })).toThrow(/Invalid gateway configuration/);
    expect(() => parseConfig(baseConfig({ auth: {} }))).toThrow(/accountTokens/);
    expect(() => parseConfig(baseConfig({ auth: { allowAnyAccountToken: true } }))).not.toThrow();
    expect(() => parseConfig({ ...baseConfig(), routing: { ...baseConfig().routing!, default: { provider: "openai", model: "m", effort: "extreme" } } })).toThrow();
  });

  it("loads YAML with env interpolation", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    const path = join(dir, "gateway.config.yaml");
    writeFileSync(
      path,
      [
        "auth:",
        "  accountTokens: ['${TOKEN}']",
        "providers:",
        "  openai: { apiKey: '${OPENAI_KEY}' }",
        "routing:",
        "  default: { provider: openai, model: gpt-5.6, effort: low }",
      ].join("\n"),
    );
    const config = loadConfigFile(path, { TOKEN: "t", OPENAI_KEY: "k" });
    expect(config.auth.accountTokens).toEqual(["t"]);
    expect(config.providers.openai?.apiKey).toBe("k");
  });
});

describe("gateway.config.example.yaml", () => {
  it("is a valid configuration", () => {
    const env = {
      ODOO_AI_ACCOUNT_TOKEN: "t",
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      GEMINI_API_KEY: "k",
      XAI_API_KEY: "k",
      OPENROUTER_API_KEY: "k",
    };
    const config = loadConfigFile(join(import.meta.dirname, "../../gateway.config.example.yaml"), env);
    expect(config.routing.usages["agent:ai_website.ai_agent_website_builder"]).toMatchObject({ provider: "claude" });
    expect(config.routing.routes["1/get_embeddings"]).toMatchObject({ model: "text-embedding-3-small" });
    expect(config.tiers.map((tier) => tier.name)).toEqual(["fast", "balanced", "deep"]);
  });
});
