/**
 * Realtime voice transcription (the "Voice notes" editor component).
 *
 * `1/get_realtime_session_token` mints a short-lived OpenAI Realtime client secret configured
 * for a transcription session (24 kHz PCM16, language, prompt). The BROWSER then opens
 * `wss://api.openai.com/v1/realtime` directly with that key (ai/static/src/core/realtime_client.js):
 * the audio WebSocket never goes through Odoo or this gateway. The browser counts tokens from
 * `conversation.item.input_audio_transcription.completed` events and Odoo forwards them to
 * `1/report_realtime_session_usage` with the `iap_transaction_token` returned here.
 */
import { RoutingError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { GatewayConfig } from "../config/schema.js";
import { ensureSupported, resolveJob } from "../router/router.js";
import type { AdapterLookup } from "./completions.js";
import type { RealtimeTokenService } from "./realtime-tokens.js";

export class RealtimeService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly adapters: AdapterLookup,
    private readonly tokens: RealtimeTokenService,
    private readonly logger: Logger,
  ) {}

  async createSession(params: Record<string, unknown>): Promise<{ session_token: string; iap_transaction_token: string; expires_at?: number }> {
    const decision = resolveJob(this.config, { route: "1/get_realtime_session_token" });
    const adapter = this.adapters(decision.target.provider);
    if (!adapter) throw new RoutingError(`Realtime provider "${decision.target.provider}" is not configured`);
    ensureSupported(adapter, decision, ["realtime"]);
    const session = await adapter.createRealtimeSession({
      model: decision.target.model,
      ...(typeof params.language === "string" && params.language ? { language: params.language } : {}),
      ...(typeof params.prompt === "string" && params.prompt ? { prompt: params.prompt } : {}),
      ...(decision.target.options ? { options: decision.target.options } : {}),
      signal: AbortSignal.timeout(this.config.server.requestTimeoutSeconds * 1000),
    });
    const transactionToken = this.tokens.issue({
      dbuuid: typeof params.dbuuid === "string" ? params.dbuuid : undefined,
      provider: adapter.name,
      model: decision.target.model,
    });
    this.logger.info("realtime session created", { job: decision.job, provider: adapter.name, model: decision.target.model });
    return {
      session_token: session.token,
      iap_transaction_token: transactionToken,
      ...(session.expiresAt ? { expires_at: session.expiresAt } : {}),
    };
  }

  async reportUsage(params: Record<string, unknown>): Promise<Record<string, never>> {
    this.tokens.report(params.iap_transaction_token, params.usage);
    return {};
  }
}
