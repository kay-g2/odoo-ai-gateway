/**
 * Hono app serving `{ai.endpoint}/api/odoo_ai/{route}` for the Odoo 20 AI client.
 *
 * Point Odoo at it with the system parameter `ai.endpoint` (e.g. `https://ai-gateway.example.com`).
 * The agent loop stays in Odoo (`ai.session`): the gateway receives instructions, messages and
 * tool definitions, returns what the model said (text, tool calls, images), and never executes
 * tools. When a tool call comes back, Odoo runs the Python tool and calls the gateway again.
 */
import { timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { AccessDeniedError, InvalidRequestError, errorMessage } from "./core/errors.js";
import { parseRpcRequest, rpcError, rpcResult, type RpcId } from "./core/jsonrpc.js";
import { silentLogger, type Logger } from "./core/logger.js";
import type { CompletionParams, CompletionResult } from "./core/odoo-types.js";
import { buildWebhookBody } from "./core/signature.js";
import type { GatewayConfig, Route } from "./config/schema.js";
import type { FetchLike, ProviderAdapter, ProviderName } from "./providers/types.js";
import { BackgroundTasks } from "./services/background.js";
import { CompletionService } from "./services/completions.js";
import { EmbeddingService } from "./services/embeddings.js";
import { RealtimeService } from "./services/realtime.js";
import { RealtimeTokenService } from "./services/realtime-tokens.js";
import { TranscriptionService } from "./services/transcription.js";
import { WebhookSender, checkWebhookUrl } from "./services/webhook.js";

export const API_PREFIX = "/api/odoo_ai";
export const VERSION = "0.1.0"; // x-release-please-version
const PUBLIC_ROUTE_MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  config: GatewayConfig;
  /** Provider adapters by name (only configured providers need to be present). */
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  /** Used for the webhook postback. Providers get their own fetch through their settings. */
  fetch: FetchLike;
  logger?: Logger;
  tasks?: BackgroundTasks;
  realtimeTokens?: RealtimeTokenService;
  /** Webhook retry sleep (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

export interface GatewayApp {
  app: Hono;
  tasks: BackgroundTasks;
  realtimeTokens: RealtimeTokenService;
}

type Handler = (params: Record<string, unknown>, c: Context) => Promise<unknown>;

/**
 * Odoo builds `f"{ai.endpoint}/api/odoo_ai/{route}"` without normalizing, so an endpoint ending in
 * "/" yields "//api/odoo_ai/...", and a gateway mounted under a path prefix (reverse proxy) sees
 * "/prefix/api/odoo_ai/...". Route on the collapsed path from "/api/odoo_ai/" on.
 */
function routingPath(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/{2,}/g, "/");
  const at = path.indexOf(`${API_PREFIX}/`);
  return at > 0 ? path.slice(at) : path;
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp(deps: AppDeps): GatewayApp {
  const { config } = deps;
  const logger = deps.logger ?? silentLogger;
  const tasks = deps.tasks ?? new BackgroundTasks();
  const realtimeTokens = deps.realtimeTokens ?? new RealtimeTokenService(config.auth.transactionTokenSecret, logger);
  const lookup = (name: ProviderName) => deps.adapters[name];

  const completions = new CompletionService(config, lookup, logger);
  const embeddings = new EmbeddingService(config, lookup, logger);
  const transcription = new TranscriptionService(config, lookup, logger);
  const realtime = new RealtimeService(config, lookup, realtimeTokens, logger);
  const webhook = new WebhookSender({
    fetch: deps.fetch,
    logger,
    maxAttempts: config.webhook.maxAttempts,
    initialBackoffMs: config.webhook.initialBackoffMs,
    timeoutSeconds: config.webhook.timeoutSeconds,
    allowedHosts: config.webhook.allowedHosts,
    userAgent: `odoo-ai-gateway/${VERSION}`,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const requireAccount = (params: Record<string, unknown>) => {
    if (config.auth.allowAnyAccountToken) return;
    const token = params.account_token;
    if (typeof token !== "string" || !token) throw new AccessDeniedError("Missing account_token");
    if (!config.auth.accountTokens.some((allowed) => sameToken(allowed, token))) {
      throw new AccessDeniedError("Unknown account_token");
    }
  };

  const app = new Hono({ getPath: routingPath });

  app.get("/", (c) => c.json({ service: "odoo-ai-gateway", version: VERSION }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use(`${API_PREFIX}/*`, bodyLimit({
    maxSize: config.server.maxBodyBytes,
    onError: (c) => c.json(rpcError(null, new InvalidRequestError("Request body too large")), 413),
  }));

  // Routes without account_token take tiny bodies: cap them well below the global limit.
  for (const route of ["1/get_default_embedding_model", "1/get_supported_embedding_models", "1/report_realtime_session_usage"]) {
    app.use(`${API_PREFIX}/${route}`, bodyLimit({
      maxSize: PUBLIC_ROUTE_MAX_BODY_BYTES,
      onError: (c) => c.json(rpcError(null, new InvalidRequestError("Request body too large")), 413),
    }));
  }

  const rpc = (route: Route, handler: Handler, options: { auth: boolean }) => {
    app.post(`${API_PREFIX}/${route}`, async (c) => {
      let id: RpcId = null;
      try {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          throw new InvalidRequestError("Request body is not valid JSON", { rpcCode: -32700 });
        }
        const request = parseRpcRequest(body);
        id = request.id;
        if (options.auth) requireAccount(request.params);
        return c.json(rpcResult(id, await handler(request.params, c)));
      } catch (error) {
        logger.warn("request failed", { route, error: errorMessage(error), name: error instanceof Error ? error.name : undefined });
        return c.json(rpcError(id, error));
      }
    });
  };

  // Async completion: acknowledge with `{}` (Odoo waits at most 5 s), then POST the signed result.
  rpc("1/get_completions", async (params, c) => {
    const requestUuid = params.request_uuid;
    const webhookUrl = params.webhook_url;
    const webhookSecret = params.webhook_secret;
    if (typeof requestUuid !== "string" || !requestUuid) throw new InvalidRequestError("params.request_uuid is required");
    if (typeof webhookUrl !== "string" || !webhookUrl) throw new InvalidRequestError("params.webhook_url is required");
    if (typeof webhookSecret !== "string" || !webhookSecret) throw new InvalidRequestError("params.webhook_secret is required");
    const urlProblem = checkWebhookUrl(webhookUrl, config.webhook.allowedHosts);
    if (urlProblem) throw new InvalidRequestError(urlProblem);
    const dbname = typeof params.webhook_dbname === "string" ? params.webhook_dbname : undefined;

    const prepared = completions.prepare("1/get_completions", params as CompletionParams);
    logger.info("completion accepted", {
      request_uuid: requestUuid,
      conversation: prepared.conversationId,
      job: prepared.decision.job,
      provider: prepared.decision.target.provider,
      model: prepared.decision.target.model,
    });

    let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      waitUntil = (promise) => ctx.waitUntil(promise);
    } catch {
      waitUntil = undefined; // Node: no execution context, the promise just keeps running.
    }

    tasks.run(async () => {
      let body;
      try {
        const message = await completions.run(prepared);
        const llmResult: CompletionResult = { status: "success", result: message };
        body = buildWebhookBody(webhookSecret, requestUuid, llmResult, false);
      } catch (error) {
        logger.warn("completion failed", { request_uuid: requestUuid, job: prepared.decision.job, error: errorMessage(error) });
        body = buildWebhookBody(webhookSecret, requestUuid, false, errorMessage(error));
      }
      await webhook.deliver(webhookUrl, body, dbname);
    }, waitUntil);
    return {};
  }, { auth: true });

  rpc("1/get_completions_sync", async (params) => {
    const prepared = completions.prepare("1/get_completions_sync", params as CompletionParams);
    const message = await completions.run(prepared);
    const result: CompletionResult = { status: "success", result: message };
    return result;
  }, { auth: true });

  rpc("1/get_embeddings", async (params) => embeddings.embed(params), { auth: true });
  // Called with `add_iap_token=False`: no account_token.
  rpc("1/get_default_embedding_model", async () => embeddings.defaultModelName(), { auth: false });
  rpc("1/get_supported_embedding_models", async () => embeddings.supportedModelNames(), { auth: false });

  rpc("1/get_transcription", async (params) => transcription.transcribe(params), { auth: true });

  rpc("1/get_realtime_session_token", async (params) => realtime.createSession(params), { auth: true });
  // Called with `add_iap_token=False`; authenticated by the signed iap_transaction_token.
  rpc("1/report_realtime_session_usage", async (params) => realtime.reportUsage(params), { auth: false });

  app.notFound((c) => {
    if (c.req.path.startsWith(`${API_PREFIX}/`)) {
      return c.json(rpcError(null, new InvalidRequestError(`Unknown route ${c.req.path.slice(API_PREFIX.length + 1)}`, { rpcCode: -32601 })), 404);
    }
    return c.json({ error: "not found" }, 404);
  });

  return { app, tasks, realtimeTokens };
}
