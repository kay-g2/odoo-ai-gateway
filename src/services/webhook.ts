/**
 * Delivery of the `1/get_completions` result to Odoo's `webhook_url`
 * (`/ai/completion_result_ready`, a `type='json2'` route): plain JSON body, NOT JSON-RPC.
 *
 * `X-Odoo-Database` carries `webhook_dbname` so multi-database servers dispatch the stateless
 * request to the right database (odoo/http/router.py `_set_session_and_dbname`).
 *
 * The callback is NOT idempotent while it runs: Odoo executes the whole tool batch inside it
 * (nested LLM calls for web search or images, website builder passes...), which can take minutes.
 * A second POST arriving meanwhile still finds the session in `waiting_model` and runs the tools
 * again. So we only retry when the request certainly did not reach Odoo (connection refused, DNS
 * failure, connect timeout) or Odoo said it did not process it (429, 503). Timeouts, other 5xx
 * and 502/504 from proxies are ambiguous and are not retried. Redirects are not followed (that
 * would bypass `allowedHosts` and turn the POST into a GET): fix `web.base.url` instead.
 */
import type { WebhookBody } from "../core/signature.js";
import type { Logger } from "../core/logger.js";
import type { FetchLike } from "../providers/types.js";

export interface WebhookOptions {
  fetch: FetchLike;
  logger: Logger;
  maxAttempts: number;
  initialBackoffMs: number;
  timeoutSeconds: number;
  allowedHosts?: string[] | undefined;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/** Errors raised before the request could reach Odoo (undici `cause.code`). */
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isConnectError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERRORS.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const RETRYABLE_STATUS = new Set([429, 503]);

function hostAllowed(host: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  const hostname = host.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? hostname.endsWith(p.slice(1)) : hostname === p;
  });
}

/** Validate a `webhook_url` before accepting the job (scheme and optional host allow-list). */
export function checkWebhookUrl(url: string, allowedHosts?: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "webhook_url is not a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "webhook_url must use http or https";
  if (!hostAllowed(parsed.hostname, allowedHosts)) return `webhook_url host "${parsed.hostname}" is not allowed`;
  return null;
}

export class WebhookSender {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WebhookOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async deliver(url: string, body: WebhookBody, dbname?: string): Promise<DeliveryResult> {
    const { fetch, logger, maxAttempts, initialBackoffMs, timeoutSeconds } = this.options;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.options.userAgent ?? "odoo-ai-gateway",
    };
    if (dbname) headers["X-Odoo-Database"] = dbname;
    const payload = JSON.stringify(body);

    let lastError = "";
    let lastStatus: number | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      let retry = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });
        lastStatus = response.status;
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) {
          logger.info("webhook delivered", { request_uuid: body.request_uuid, status: response.status, attempt });
          return { delivered: true, attempts: attempt, status: response.status };
        }
        if (response.status >= 300 && response.status < 400) {
          lastError = `redirected (HTTP ${response.status}) to ${response.headers.get("location") ?? "?"}; set Odoo's web.base.url to the final URL`;
        } else {
          lastError = `HTTP ${response.status}`;
          retry = RETRYABLE_STATUS.has(response.status);
        }
      } catch (error) {
        lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        retry = isConnectError(error);
      }
      if (!retry) break;
      if (attempt < maxAttempts) await this.sleep(initialBackoffMs * 2 ** (attempt - 1));
    }
    logger.error("webhook delivery failed", { request_uuid: body.request_uuid, status: lastStatus, error: lastError });
    return { delivered: false, attempts, error: lastError, ...(lastStatus === undefined ? {} : { status: lastStatus }) };
  }
}
