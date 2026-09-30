/**
 * JSON schema helpers. Odoo's schemas (tool parameters, `ai_field`, `esg_metrics`, website
 * builder passes) are plain JSON Schema, sometimes with quirks such as `{"type": "text"}` in the
 * `ai_field` fallback branch. Adapters normalize them before handing them to a provider.
 */
type Schema = Record<string, unknown>;

const TYPE_ALIASES: Record<string, string> = { text: "string", int: "integer", float: "number", bool: "boolean", dict: "object", list: "array" };
const VALID_TYPES = new Set(["string", "number", "integer", "object", "array", "boolean", "null"]);

function fixType(type: unknown): unknown {
  if (typeof type === "string") {
    const mapped = TYPE_ALIASES[type] ?? type;
    return VALID_TYPES.has(mapped) ? mapped : "string";
  }
  if (Array.isArray(type)) return [...new Set(type.map((t) => fixType(t)))];
  return type;
}

function isObject(value: unknown): value is Schema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-copy a schema, mapping invalid `type` names ("text" -> "string"). */
export function normalizeSchema(schema: Schema): Schema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "type") out[key] = fixType(value);
      else if (key === "properties" && isObject(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub)]));
      } else out[key] = walk(value);
    }
    return out;
  };
  return walk(schema) as Schema;
}

/** Tool parameters: Odoo sends `schema: null` for tools without arguments. */
export function toolParameters(schema: Schema | null | undefined): Schema {
  if (!schema || !Object.keys(schema).length) return { type: "object", properties: {}, required: [] };
  const normalized = normalizeSchema(schema);
  if (normalized.type === undefined) normalized.type = "object";
  if (normalized.type === "object" && !isObject(normalized.properties)) normalized.properties = {};
  return normalized;
}

/**
 * OpenAI/xAI strict structured outputs need every object to list all its properties in
 * `required` and set `additionalProperties: false`. Use strict mode only when that already holds.
 */
export function isStrictCompatible(schema: Schema): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.every(walk);
    if (!isObject(node)) return true;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object") || isObject(node.properties)) {
      const properties = isObject(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? node.required : [];
      if (node.additionalProperties !== false) return false;
      if (!properties.every((name) => required.includes(name))) return false;
    }
    return Object.entries(node).every(([key, value]) => key === "enum" || key === "const" || walk(value));
  };
  return walk(schema);
}

/**
 * Remove keywords a provider rejects (e.g. Claude structured outputs: numeric/string bounds) and
 * close every object with `additionalProperties: false` when `closeObjects` is set.
 */
export function stripKeywords(schema: Schema, keywords: readonly string[], options: { closeObjects?: boolean } = {}): Schema {
  const drop = new Set(keywords);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (drop.has(key)) continue;
      if (key === "properties" && isObject(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub)]));
      } else if (key === "enum" || key === "const" || key === "required") {
        out[key] = value;
      } else out[key] = walk(value);
    }
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (options.closeObjects && (types.includes("object") || isObject(out.properties)) && out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(normalizeSchema(schema)) as Schema;
}
