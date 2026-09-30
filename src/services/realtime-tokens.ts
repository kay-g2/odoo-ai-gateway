/**
 * `iap_transaction_token` for realtime transcription sessions.
 *
 * `1/get_realtime_session_token` returns it next to the OpenAI ephemeral key; the browser later
 * sends it back (through Odoo) to `1/report_realtime_session_usage` with the token usage it
 * counted from `conversation.item.input_audio_transcription.completed` events. That route comes
 * without `account_token`, so the token itself is HMAC-signed to prove the gateway issued it.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { AccessDeniedError, InvalidRequestError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";

export interface TransactionClaims {
  jti: string;
  dbuuid?: string | undefined;
  provider: string;
  model: string;
  iat: number;
}

/** Token counts the browser collects (ai/static/src/editor/embedded_components/core/voice_transcription.js). */
export interface RealtimeUsage {
  input_tokens: { text: number; audio: number };
  output_tokens: number;
  duration_seconds: number;
}

export interface RealtimeUsageRecord {
  claims: TransactionClaims;
  usage: RealtimeUsage;
  reportedAt: number;
}

/** A recording can last a long meeting; after this the token is refused. */
const DEFAULT_TTL_SECONDS = 12 * 3600;
const MAX_COUNT = 1e9;

function count(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COUNT) {
    throw new InvalidRequestError(`usage.${field} must be a non-negative number`);
  }
  return value;
}

/** Keep only the documented numeric fields (the route is public, the payload browser-made). */
export function validateUsage(raw: unknown): RealtimeUsage {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new InvalidRequestError("usage must be an object");
  const usage = raw as Record<string, unknown>;
  const input = usage.input_tokens ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InvalidRequestError("usage.input_tokens must be an object");
  const inputRecord = input as Record<string, unknown>;
  return {
    input_tokens: { text: count(inputRecord.text, "input_tokens.text"), audio: count(inputRecord.audio, "input_tokens.audio") },
    output_tokens: count(usage.output_tokens, "output_tokens"),
    duration_seconds: count(usage.duration_seconds, "duration_seconds"),
  };
}

export class RealtimeTokenService {
  private readonly key: Buffer;
  /** Recent reports, newest last (bounded; export them from logs for billing). */
  readonly reports: RealtimeUsageRecord[] = [];
  /**
   * Reported token ids -> expiry (ms), so a token is accepted once. Per process: after a restart,
   * or on another instance sharing the secret, a token can be reported again within its TTL.
   */
  private readonly used = new Map<string, number>();

  constructor(
    secret: string | undefined,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly maxReports = 1000,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {
    this.key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  issue(claims: Omit<TransactionClaims, "jti" | "iat">): string {
    const full: TransactionClaims = { jti: randomUUID(), iat: Math.floor(this.now() / 1000), ...claims };
    const payload = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
    return `rt1.${payload}.${this.sign(payload)}`;
  }

  verify(token: unknown): TransactionClaims {
    if (typeof token !== "string") throw new AccessDeniedError("Missing iap_transaction_token");
    const [version, payload, signature] = token.split(".");
    if (version !== "rt1" || !payload || !signature) throw new AccessDeniedError("Malformed iap_transaction_token");
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AccessDeniedError("Invalid iap_transaction_token");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TransactionClaims;
    if (typeof claims.iat !== "number" || claims.iat * 1000 + this.ttlSeconds * 1000 < this.now()) {
      throw new AccessDeniedError("Expired iap_transaction_token");
    }
    return claims;
  }

  report(token: unknown, rawUsage: unknown): RealtimeUsageRecord {
    const claims = this.verify(token);
    const usage = validateUsage(rawUsage);
    const now = this.now();
    for (const [jti, expiry] of this.used) {
      if (expiry > now) break; // insertion order == expiry order
      this.used.delete(jti);
    }
    if (this.used.has(claims.jti)) throw new AccessDeniedError("iap_transaction_token already reported");
    this.used.set(claims.jti, claims.iat * 1000 + this.ttlSeconds * 1000);
    const record = { claims, usage, reportedAt: now };
    this.reports.push(record);
    if (this.reports.length > this.maxReports) this.reports.shift();
    this.logger.info("realtime usage reported", { jti: claims.jti, dbuuid: claims.dbuuid, provider: claims.provider, model: claims.model, usage });
    return record;
  }
}
