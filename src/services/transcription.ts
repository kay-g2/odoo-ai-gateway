/**
 * `1/get_transcription`: `{audio: base64, mimetype, language?, response_format?}` -> `{text}`.
 *
 * Callers: the voice-note `/ai/transcription` controller (mimetype audio/mp3, plain text) and
 * `mail.call.artifact` for call recordings (`response_format: "vtt"`, stored as the VTT transcript).
 */
import { InvalidRequestError, RoutingError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { GatewayConfig } from "../config/schema.js";
import { ensureSupported, resolveJob } from "../router/router.js";
import type { AdapterLookup } from "./completions.js";

export class TranscriptionService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly adapters: AdapterLookup,
    private readonly logger: Logger,
  ) {}

  async transcribe(params: Record<string, unknown>): Promise<{ status: "success"; text: string }> {
    const audio = params.audio;
    if (typeof audio !== "string" || !audio) throw new InvalidRequestError("params.audio (base64) is required");
    const mimetype = typeof params.mimetype === "string" && params.mimetype ? params.mimetype : "audio/mpeg";
    const responseFormat = params.response_format === "vtt" ? "vtt" : "text";
    const decision = resolveJob(this.config, { route: "1/get_transcription", usage: typeof params.usage === "string" ? params.usage : undefined });
    const adapter = this.adapters(decision.target.provider);
    if (!adapter) throw new RoutingError(`Transcription provider "${decision.target.provider}" is not configured`);
    ensureSupported(adapter, decision, ["transcription"]);
    const text = await adapter.transcribe({
      model: decision.target.model,
      audio,
      mimetype,
      responseFormat,
      ...(typeof params.language === "string" && params.language ? { language: params.language } : {}),
      ...(decision.target.options ? { options: decision.target.options } : {}),
      signal: AbortSignal.timeout(this.config.server.requestTimeoutSeconds * 1000),
    });
    this.logger.info("transcription done", { job: decision.job, provider: adapter.name, model: decision.target.model, format: responseFormat });
    return { status: "success", text };
  }
}
