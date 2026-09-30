import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { parse as parseYaml } from "yaml";

import { OPTION_DECLARATIONS } from "../providers/index.js";
import { optionProblems } from "../providers/options.js";
import { configSchema, type Entry, type GatewayConfig, type GatewayConfigInput } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replace `${VAR}` / `${VAR:-default}` in every string of the raw config. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(`Config references environment variable ${name}, which is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env)]));
  }
  return value;
}

/** Validate a config object (already interpolated) and check cross references. */
export function parseConfig(raw: GatewayConfigInput | unknown): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid gateway configuration:\n${issues.join("\n")}`);
  }
  const config = result.data;
  const problems: string[] = [];
  const tierNames = new Set<string>();
  for (const tier of config.tiers) {
    if (tierNames.has(tier.name)) problems.push(`tiers: duplicate tier name "${tier.name}"`);
    tierNames.add(tier.name);
  }

  const checkEntry = (path: string, entry: Entry | undefined) => {
    if (entry === undefined) return;
    if (typeof entry === "string") {
      if (!tierNames.has(entry)) problems.push(`${path}: unknown tier "${entry}"`);
      return;
    }
    if (!config.providers[entry.provider]) {
      problems.push(`${path}: provider "${entry.provider}" has no credentials under "providers"`);
    }
    problems.push(...optionProblems(OPTION_DECLARATIONS, entry.provider, entry.options, path));
  };
  for (const tier of config.tiers) checkEntry(`tiers.${tier.name}`, { ...tier, name: undefined });
  for (const [usage, entry] of Object.entries(config.routing.usages)) checkEntry(`routing.usages.${usage}`, entry);
  checkEntry("routing.agent", config.routing.agent);
  checkEntry("routing.features.image_generation", config.routing.features.image_generation);
  checkEntry("routing.features.web_grounding", config.routing.features.web_grounding);
  for (const [route, entry] of Object.entries(config.routing.routes)) checkEntry(`routing.routes.${route}`, entry);
  checkEntry("routing.default", config.routing.default);
  config.embeddings.additional.forEach((target, index) => checkEntry(`embeddings.additional.${index}`, target));

  if (!config.auth.allowAnyAccountToken && config.auth.accountTokens.length === 0) {
    problems.push("auth: set auth.accountTokens (the Odoo `odoo_ai` IAP account token) or auth.allowAnyAccountToken: true");
  }
  if (problems.length) {
    throw new Error(`Invalid gateway configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return config;
}

/** Load YAML or JSON config from disk, interpolating environment variables. */
export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const text = readFileSync(path, "utf8");
  const raw = extname(path) === ".json" ? JSON.parse(text) : parseYaml(text);
  return parseConfig(interpolateEnv(raw, env));
}
