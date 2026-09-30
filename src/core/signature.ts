import { createHmac, timingSafeEqual } from "node:crypto";

import { PyTuple, printabilityVaries, pyRepr } from "./pyrepr.js";

/** Scope passed by Odoo to `odoo.tools.misc.hmac` in `ai/controllers/thread.py`. */
export const WEBHOOK_SCOPE = "odoo_ai-webhook";

const REPLACEMENT = "\uFFFD";
// Anything outside printable ASCII needs a closer look (fast path for base64 payloads).
const NEEDS_SCAN = /[^\x20-\x7e\t\n\r]/;

export interface SanitizeOptions {
  /**
   * Also replace characters assigned after Unicode 15.0 (default). Needed only for the signed
   * webhook: Python 3.12 escapes them in `repr()` while 3.13/3.14 print them, so the signature
   * could only match one Odoo Python version.
   */
  unicodeStable?: boolean;
}

/**
 * Make a string safe to send to Odoo (and, by default, to sign):
 * - lone surrogates and NUL become U+FFFD: PostgreSQL `jsonb` rejects them when Odoo stores the
 *   assistant message (`ai.session.event.metadata`), which would fail every retry;
 * - with `unicodeStable`, characters whose `repr()` differs across Odoo's Pythons become U+FFFD.
 */
export function sanitizeString(value: string, options: SanitizeOptions = {}): string {
  if (!NEEDS_SCAN.test(value)) return value;
  const unicodeStable = options.unicodeStable ?? true;
  let out = "";
  let changed = false;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    const bad = cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || (unicodeStable && printabilityVaries(cp));
    if (bad) changed = true;
    out += bad ? REPLACEMENT : ch;
  }
  return changed ? out : value;
}

/** Deep-copy JSON data applying `sanitizeString` to every string and key. */
export function sanitizeForOdoo<T>(value: T, options: SanitizeOptions = {}): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return sanitizeString(node, options);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [sanitizeString(key, options), walk(item)]));
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Re-parse a value exactly as the receiving side will see it once serialized as JSON:
 * drops `undefined`, applies `toJSON`, turns non-finite numbers into `null`, fixes key order.
 */
export function normalizeForJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value === undefined ? null : value)) as T;
}

/**
 * `odoo.tools.misc.hmac(env, scope, message, secret=secret)`:
 * `HMAC-SHA256(secret.encode(), repr((scope, message)).encode()).hexdigest()`.
 * `message` must already be normalized (see `normalizeForJson`).
 */
export function odooHmac(secret: string, scope: string, message: unknown): string {
  if (!scope) throw new Error("Non-empty scope required");
  if (!secret) throw new Error("Non-empty secret required");
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(pyRepr(new PyTuple(scope, message)), "utf8"))
    .digest("hex");
}

export interface WebhookBody {
  request_uuid: string;
  llm_result: unknown;
  llm_error: unknown;
  signature: string;
}

/**
 * Build the signed plain-JSON body POSTed to `webhook_url`. Odoo checks it with
 * `hmac(None, "odoo_ai-webhook", (request_uuid, llm_result, llm_error), secret=webhook_secret)`.
 */
export function buildWebhookBody(
  secret: string,
  requestUuid: string,
  llmResult: unknown,
  llmError: unknown,
): WebhookBody {
  const [uuid, result, error] = sanitizeForOdoo(normalizeForJson([requestUuid, llmResult, llmError])) as [string, unknown, unknown];
  return {
    request_uuid: uuid,
    llm_result: result,
    llm_error: error,
    signature: odooHmac(secret, WEBHOOK_SCOPE, new PyTuple(uuid, result, error)),
  };
}

/** Verify a webhook body the way Odoo's `completion_result_ready` does (constant-time compare). */
export function verifyWebhookBody(secret: string, body: Partial<WebhookBody>): boolean {
  if (typeof body.signature !== "string" || !body.signature) return false;
  const [uuid, result, error] = normalizeForJson([body.request_uuid ?? null, body.llm_result ?? null, body.llm_error ?? null]);
  const expected = odooHmac(secret, WEBHOOK_SCOPE, new PyTuple(uuid, result, error));
  const a = Buffer.from(body.signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
