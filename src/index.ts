/**
 * Node entrypoint: `node dist/index.js` (or `npm run dev`).
 * Config path: $ODOO_AI_GATEWAY_CONFIG, else ./gateway.config.yaml / .yml / .json.
 */
import { existsSync } from "node:fs";

import { serve } from "@hono/node-server";

import { createApp, VERSION } from "./app.js";
import { loadConfigFile } from "./config/load.js";
import { createHttpClient } from "./core/http-client.js";
import { createJsonLogger, type LogLevel } from "./core/logger.js";
import { createAdapters } from "./providers/index.js";

function findConfig(): string {
  const explicit = process.env.ODOO_AI_GATEWAY_CONFIG;
  if (explicit) return explicit;
  const candidate = ["gateway.config.yaml", "gateway.config.yml", "gateway.config.json"].find((file) => existsSync(file));
  if (!candidate) {
    throw new Error("No config found: set ODOO_AI_GATEWAY_CONFIG or create gateway.config.yaml (see gateway.config.example.yaml)");
  }
  return candidate;
}

const logger = createJsonLogger((process.env.LOG_LEVEL as LogLevel | undefined) ?? "info");
const configPath = findConfig();
const config = loadConfigFile(configPath);

const http = createHttpClient(
  Math.max(config.server.completionTimeoutSeconds, config.server.requestTimeoutSeconds, config.webhook.timeoutSeconds),
);
const { app, tasks } = createApp({ config, adapters: createAdapters(config, http.fetch), fetch: http.fetch, logger });

const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (info) => {
  logger.info("odoo-ai-gateway listening", {
    version: VERSION,
    address: info.address,
    port: info.port,
    config: configPath,
    providers: Object.keys(config.providers),
  });
  if (config.auth.allowAnyAccountToken) logger.warn("auth.allowAnyAccountToken is enabled: any caller can use your provider keys");
});

let stopping = false;
/**
 * Stop accepting connections, then wait for in-flight HTTP requests (sync completions,
 * embeddings, transcriptions) AND background async completions with their webhook deliveries,
 * under one deadline. Give the container at least this long to stop (docker --stop-timeout,
 * Kubernetes terminationGracePeriodSeconds).
 */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  const budgetSeconds = config.server.completionTimeoutSeconds + config.webhook.timeoutSeconds * config.webhook.maxAttempts;
  logger.info("shutting down, draining requests and pending completions", { signal, pending: tasks.size, budget_seconds: budgetSeconds });
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), budgetSeconds * 1000).unref());
  const outcome = await Promise.race([Promise.all([httpClosed, tasks.idle()]).then(() => "drained" as const), deadline]);
  if (outcome === "timeout") logger.warn("shutdown deadline reached, aborting in-flight requests", { pending: tasks.size });
  await http.close(outcome === "timeout");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
