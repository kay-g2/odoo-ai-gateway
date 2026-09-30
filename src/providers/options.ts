/**
 * Routing-entry `options`: extra fields for the provider request, and a few keys the adapters
 * read themselves. Each adapter declares the keys it reads (`OptionDeclarations`). The config
 * loader checks every entry against its provider's declarations, so a wrong value, or a gateway
 * key meant for another provider, fails at startup instead of on the first request. `mergeOptions`
 * applies them the same way in every adapter:
 *
 * - a declared `adapter` key is read by the adapter (a tool definition, a cache setting...) and is
 *   never copied into the request body;
 * - a declared `deep` key is merged recursively into the object of the same name the adapter built;
 * - any other key is copied into the body as is, replacing what the adapter built; `null` removes
 *   that field instead.
 *
 * A declared key only applies to the operations it lists, so a tier shared by several routes never
 * sends a completion-only key to, say, the embeddings API.
 */
import { PROVIDER_NAMES, type ProviderName } from "./types.js";

export const OPERATIONS = ["completion", "embeddings", "transcription", "realtime"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Accepted values of an option, checked at config load. */
export interface ValueRule {
  accepts(value: unknown): boolean;
  /** Human description for errors and the README ("an object", `false or "1h"`). */
  expects: string;
}

export interface OptionSpec {
  operations: readonly Operation[];
  merge: "adapter" | "deep";
  /**
   * The name is the gateway's own, not a field of any provider API (`web_search_tool`,
   * `prompt_cache`...): an entry for a provider that does not declare it is a mistake.
   */
  gatewayKey?: boolean;
  value: ValueRule;
  /** One line for the README options table (Markdown). */
  doc: string;
}

export type OptionDeclarations = Readonly<Record<string, OptionSpec>>;

type Options = Record<string, unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const rule = (accepts: (value: unknown) => boolean, expects: string): ValueRule => ({ accepts, expects });

/** Building blocks for `OptionSpec.value`. */
export const values = {
  object: rule(isRecord, "an object"),
  objectOrNull: rule((value) => value === null || isRecord(value), "an object or null"),
  boolean: rule((value) => typeof value === "boolean", "true or false"),
  positiveInteger: rule((value) => Number.isInteger(value) && (value as number) > 0, "a positive integer"),
  text: rule((value) => typeof value === "string" && value !== "", "a string"),
  oneOf: (...allowed: unknown[]): ValueRule =>
    rule((value) => allowed.includes(value), allowed.map((value) => JSON.stringify(value)).join(" or ")),
  anyOf: (...rules: ValueRule[]): ValueRule =>
    rule((value) => rules.some((r) => r.accepts(value)), rules.map((r) => r.expects).join(" or ")),
};

function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/** `body` with the entry's options applied for `operation` (see the module comment). */
export function mergeOptions(
  body: Record<string, unknown>,
  options: Options,
  declarations: OptionDeclarations,
  operation: Operation,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(options ?? {})) {
    const spec = declarations[key];
    if (spec) {
      if (spec.merge !== "deep" || !spec.operations.includes(operation)) continue;
      const current = out[key];
      out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
    } else if (value === null) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The options that are not declared: extra form fields for multipart uploads (transcription). */
export function passthroughOptions(options: Options, declarations: OptionDeclarations): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !declarations[key]));
}

/** An `adapter` option holding an object (a tool definition...), or `{}`. */
export function objectOption(options: Options, key: string): Record<string, unknown> {
  const value = options?.[key];
  return isRecord(value) ? value : {};
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Config problems in one routing target's options, as `<path>.options.<key>: ...` lines. */
export function optionProblems(
  all: Readonly<Record<ProviderName, OptionDeclarations>>,
  provider: ProviderName,
  options: Options,
  path: string,
): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(options ?? {})) {
    const spec = all[provider][key];
    if (spec) {
      if (!spec.value.accepts(value)) problems.push(`${path}.options.${key}: expected ${spec.value.expects}, got ${preview(value)}`);
      continue;
    }
    const owners = PROVIDER_NAMES.filter((name) => all[name][key]?.gatewayKey);
    if (owners.length) problems.push(`${path}.options.${key}: not an option of ${provider} (only ${owners.join(", ")} read it)`);
  }
  return problems;
}

const escapeCell = (text: string) => text.replace(/\|/g, "\\|");

/** The README table of every declared option (`npm run docs:options` writes it). */
export function renderOptionsTable(all: Readonly<Record<ProviderName, OptionDeclarations>>): string {
  const rows = ["| Provider | Key | Operations | Value | Effect |", "|---|---|---|---|---|"];
  for (const provider of PROVIDER_NAMES) {
    for (const [key, spec] of Object.entries(all[provider])) {
      const how = spec.merge === "deep" ? `Merged recursively into the adapter's \`${key}\`: ` : "";
      rows.push(`| ${provider} | \`${key}\` | ${spec.operations.join(", ")} | ${escapeCell(spec.value.expects)} | ${escapeCell(how + spec.doc)} |`);
    }
  }
  return rows.join("\n");
}
