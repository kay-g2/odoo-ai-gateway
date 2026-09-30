import { z } from "zod";

import { EFFORTS, FEATURES, PROVIDER_NAMES } from "../providers/types.js";

export const effortSchema = z.enum(EFFORTS);
export const providerNameSchema = z.enum(PROVIDER_NAMES);
export const featureSchema = z.enum(FEATURES);

/** A concrete provider + model (+ effort) choice. */
export const targetSchema = z.strictObject({
  provider: providerNameSchema,
  model: z.string().min(1),
  effort: effortSchema.optional(),
  /** Public name for embedding models (what `1/get_default_embedding_model` returns). Defaults to `model`. */
  name: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Force a capability on/off for this entry (e.g. a new OpenRouter model). */
  capabilities: z.partialRecord(featureSchema, z.boolean()).optional(),
  /**
   * Extra provider request fields merged into the upstream body, plus the keys the adapter reads
   * itself. Checked against the provider's declarations after parsing (`providers/options.ts`).
   */
  options: z.record(z.string(), z.unknown()).optional(),
});
export type Target = z.infer<typeof targetSchema>;

/** A routing entry: an inline target, or the name of a tier. */
export const entrySchema = z.union([z.string().min(1), targetSchema]);
export type Entry = z.infer<typeof entrySchema>;

export const tierSchema = targetSchema.extend({ name: z.string().min(1) });
export type Tier = z.infer<typeof tierSchema>;

export const ROUTES = [
  "1/get_completions",
  "1/get_completions_sync",
  "1/get_embeddings",
  "1/get_default_embedding_model",
  "1/get_supported_embedding_models",
  "1/get_transcription",
  "1/get_realtime_session_token",
  "1/report_realtime_session_usage",
] as const;
export type Route = (typeof ROUTES)[number];

const routeKeySchema = z.enum(ROUTES);

export const providerConfigSchema = z.strictObject({
  apiKey: z.string().min(1),
  baseUrl: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const configSchema = z.strictObject({
  server: z
    .strictObject({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8080),
      /** Upper bound for a completion when Odoo does not send `timeout` (seconds). */
      completionTimeoutSeconds: z.number().positive().default(300),
      /**
       * Deadline for `1/get_completions_sync`: `call_odoo_ai` waits 60 s whatever `timeout` Odoo
       * puts in the params, so working longer only burns tokens nobody will read.
       */
      syncTimeoutSeconds: z.number().positive().default(60),
      /** Deadline for embeddings/transcription/realtime calls (seconds). */
      requestTimeoutSeconds: z.number().positive().default(120),
      maxBodyBytes: z.number().int().positive().default(64 * 1024 * 1024),
    })
    .prefault({}),
  auth: z
    .strictObject({
      /**
       * `iap.account` tokens (service `odoo_ai`) allowed to use the gateway. Odoo sends it as
       * `account_token` on every route except the embedding-model listings and usage reports.
       */
      accountTokens: z.array(z.string().min(1)).default([]),
      /** Accept any (or no) account token. Only for local development. */
      allowAnyAccountToken: z.boolean().default(false),
      /** HMAC key for the realtime `iap_transaction_token`. Random per process when omitted. */
      transactionTokenSecret: z.string().min(16).optional(),
    })
    .prefault({}),
  webhook: z
    .strictObject({
      /** Attempts to deliver the postback; only failures that never reached Odoo are retried. */
      maxAttempts: z.number().int().min(1).max(10).default(4),
      initialBackoffMs: z.number().int().min(0).default(500),
      /** Odoo runs the tool batch inside the callback request (nested LLM calls): allow minutes. */
      timeoutSeconds: z.number().positive().default(300),
      /** If set, only these hosts may be used as `webhook_url` (exact host or "*.example.com"). */
      allowedHosts: z.array(z.string().min(1)).optional(),
    })
    .prefault({}),
  providers: z.partialRecord(providerNameSchema, providerConfigSchema).default({}),
  /** Ordered lightest -> heaviest. `boost_reasoning` moves a tier-based job one row up. */
  tiers: z.array(tierSchema).default([]),
  routing: z.strictObject({
    /** Exact `params.usage` values ("channel_name", "ai_field", "agent:ai.ai_default_agent", ...). */
    usages: z.record(z.string().min(1), entrySchema).default({}),
    /** Any `agent:<xmlid>` / `agent:custom` usage without an exact entry. */
    agent: entrySchema.optional(),
    /** Own entries for requests flagged `image_generation` / `web_grounding`. */
    features: z
      .strictObject({
        image_generation: entrySchema.optional(),
        web_grounding: entrySchema.optional(),
      })
      .prefault({}),
    /** Per gateway route ("1/get_completions", "1/get_embeddings", ...). */
    routes: z.partialRecord(routeKeySchema, entrySchema).default({}),
    default: entrySchema,
  }),
  embeddings: z
    .strictObject({
      /**
       * Other embedding models accepted by `1/get_embeddings` and listed by
       * `1/get_supported_embedding_models` (the default is the `1/get_embeddings` route entry).
       * Odoo's daily cron `_cron_update_deprecated_embedding_models` moves agents and re-embeds
       * sources whose model is NOT listed; until it runs (and Odoo is restarted, the lists are
       * `ormcache`d), RAG queries naming a removed model fail. Keep a model here to keep it served.
       */
      additional: z.array(targetSchema).default([]),
    })
    .prefault({}),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type GatewayConfigInput = z.input<typeof configSchema>;
