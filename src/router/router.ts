/**
 * Job router: picks provider, model and effort for each request from configuration only.
 *
 * There is no model classifying "difficulty". The job comes from what Odoo sends:
 *   - the gateway route (`1/get_completions`, `1/get_embeddings`, ...);
 *   - `params.usage` (`agent:<xmlid>` / `agent:custom` from `ai.agent._get_usage_string`,
 *     `channel_name`, `ai_field`, `web_search`, `ai_action`, `website_builder_css_polish`,
 *     `website_builder_shapes`, `esg_metrics`);
 *   - the flags `boost_reasoning`, `web_grounding`, `image_generation`, plus `tools` and `schema`.
 *
 * Most specific wins:
 *   1. exact usage            (`routing.usages[usage]`)
 *   2. `agent:` prefix         (`routing.agent`)
 *   3. feature entries         (`routing.features.image_generation`, then `.web_grounding`)
 *   4. route                   (`routing.routes[route]`)
 *   5. default                 (`routing.default`)
 *
 * `boost_reasoning` moves the job one row up: to the next tier when the entry names a tier, or
 * one effort level up otherwise (also when already on the top tier).
 *
 * The chosen provider must support every feature the request needs; otherwise the request fails
 * with `UnsupportedFeatureError`. The router never switches to another provider.
 */
import { RoutingError, UnsupportedFeatureError } from "../core/errors.js";
import { attachmentKind, attachmentsOf } from "../core/odoo-history.js";
import type { CompletionParams } from "../core/odoo-types.js";
import type { Entry, GatewayConfig, Route, Target } from "../config/schema.js";
import { EFFORTS, type Effort, type Feature, type ProviderAdapter } from "../providers/types.js";

export type MatchKind = "usage" | "agent" | "feature:image_generation" | "feature:web_grounding" | "route" | "default";

export interface JobInput {
  route: Route;
  usage?: string | null;
  webGrounding?: boolean;
  imageGeneration?: boolean;
  boostReasoning?: boolean;
}

export interface RoutingDecision {
  /** Readable job id for logs, e.g. `usage:ai_field` or `route:1/get_embeddings`. */
  job: string;
  matchedBy: MatchKind;
  /** Tier used (after boost), when the entry referenced a tier. */
  tier?: string;
  boosted: boolean;
  target: Target;
}

interface Match {
  kind: MatchKind;
  job: string;
  entry: Entry;
}

function findEntry(config: GatewayConfig, input: JobInput): Match {
  const { routing } = config;
  const usage = input.usage || undefined;
  if (usage !== undefined && Object.hasOwn(routing.usages, usage)) {
    return { kind: "usage", job: `usage:${usage}`, entry: routing.usages[usage]! };
  }
  if (usage?.startsWith("agent:") && routing.agent !== undefined) {
    return { kind: "agent", job: `agent:* (${usage})`, entry: routing.agent };
  }
  if (input.imageGeneration && routing.features.image_generation !== undefined) {
    return { kind: "feature:image_generation", job: "feature:image_generation", entry: routing.features.image_generation };
  }
  if (input.webGrounding && routing.features.web_grounding !== undefined) {
    return { kind: "feature:web_grounding", job: "feature:web_grounding", entry: routing.features.web_grounding };
  }
  const routeEntry = routing.routes[input.route];
  if (routeEntry !== undefined) {
    return { kind: "route", job: `route:${input.route}`, entry: routeEntry };
  }
  return { kind: "default", job: "default", entry: routing.default };
}

/** One level up the effort ladder; an unset effort counts as the providers' usual "medium". */
export function bumpEffort(effort: Effort | undefined): Effort {
  const index = EFFORTS.indexOf(effort ?? "medium");
  return EFFORTS[Math.min(index + 1, EFFORTS.length - 1)]!;
}

function stripTierName(tier: GatewayConfig["tiers"][number]): Target {
  const { name: _name, ...target } = tier;
  return target;
}

export function resolveJob(config: GatewayConfig, input: JobInput): RoutingDecision {
  const match = findEntry(config, input);
  const boost = Boolean(input.boostReasoning);

  if (typeof match.entry === "string") {
    const index = config.tiers.findIndex((tier) => tier.name === match.entry);
    if (index < 0) throw new RoutingError(`Job ${match.job} references unknown tier "${match.entry}"`);
    if (!boost) {
      return { job: match.job, matchedBy: match.kind, tier: config.tiers[index]!.name, boosted: false, target: stripTierName(config.tiers[index]!) };
    }
    const next = config.tiers[index + 1];
    if (next) {
      return { job: match.job, matchedBy: match.kind, tier: next.name, boosted: true, target: stripTierName(next) };
    }
    const top = stripTierName(config.tiers[index]!);
    return { job: match.job, matchedBy: match.kind, tier: config.tiers[index]!.name, boosted: true, target: { ...top, effort: bumpEffort(top.effort) } };
  }

  const target: Target = boost ? { ...match.entry, effort: bumpEffort(match.entry.effort) } : match.entry;
  return { job: match.job, matchedBy: match.kind, boosted: boost, target };
}

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/**
 * Features a completion request needs from the provider. Attachments are classified like the
 * adapters classify them (`attachmentKind`): text files and SVG need no input feature.
 */
export function completionFeatures(params: CompletionParams): Feature[] {
  const features = new Set<Feature>(["completion"]);
  const tools = hasContent(params.tools);
  const schema = hasContent(params.schema);
  if (tools) features.add("tools");
  if (schema) features.add("schema");
  if (params.web_grounding) features.add("web_grounding");
  if (params.image_generation) features.add("image_generation");
  if (params.web_grounding && schema) features.add("web_grounding+schema");
  if (tools && schema) features.add("tools+schema");
  for (const part of attachmentsOf(params.messages ?? [])) {
    const kind = attachmentKind(part.mimetype);
    if (kind === "image") features.add("image_input");
    else if (kind === "pdf") features.add("pdf_input");
    else if (kind === "audio") features.add("audio_input");
  }
  return [...features];
}

/** Throw unless the routed provider supports every needed feature. No fallback provider. */
export function ensureSupported(adapter: ProviderAdapter, decision: RoutingDecision, features: Feature[]): void {
  const overrides = decision.target.capabilities ?? {};
  const missing = features.filter((feature) => {
    const forced = overrides[feature];
    return forced === undefined ? !adapter.supports(feature, decision.target.model) : !forced;
  });
  if (missing.length) {
    throw new UnsupportedFeatureError(adapter.name, decision.target.model, missing, decision.job);
  }
}
