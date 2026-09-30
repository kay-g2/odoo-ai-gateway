import { UnsupportedFeatureError } from "../core/errors.js";
import type { AssistantMessage } from "../core/odoo-types.js";
import type {
  CompletionRequest,
  EmbeddingRequest,
  Feature,
  ProviderAdapter,
  ProviderName,
  ProviderSettings,
  RealtimeSession,
  RealtimeSessionRequest,
  TranscriptionRequest,
} from "./types.js";

/**
 * Common base: every adapter exposes the same four operations. Operations a provider does not
 * offer throw `UnsupportedFeatureError` (the router checks `supports()` first, so this is only a
 * safety net).
 */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly name: ProviderName;
  protected abstract readonly defaultBaseUrl: string;

  constructor(protected readonly settings: ProviderSettings) {}

  protected get baseUrl(): string {
    return (this.settings.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, "");
  }

  abstract supports(feature: Feature, model: string): boolean;
  abstract complete(request: CompletionRequest): Promise<AssistantMessage>;

  embed(request: EmbeddingRequest): Promise<number[][]> {
    return Promise.reject(new UnsupportedFeatureError(this.name, request.model, ["embeddings"]));
  }

  transcribe(request: TranscriptionRequest): Promise<string> {
    return Promise.reject(new UnsupportedFeatureError(this.name, request.model, ["transcription"]));
  }

  createRealtimeSession(request: RealtimeSessionRequest): Promise<RealtimeSession> {
    return Promise.reject(new UnsupportedFeatureError(this.name, request.model, ["realtime"]));
  }
}
