import type { AssistantMessage, OdooMessage, OdooTool } from "../core/odoo-types.js";

export const PROVIDER_NAMES = ["openai", "grok", "claude", "gemini", "openrouter"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Canonical reasoning effort, from lightest to heaviest (the rows `boost_reasoning` climbs).
 * Each adapter translates it to its own API and clamps it to what the model accepts:
 * OpenAI/Grok `reasoning.effort`, Claude `output_config.effort` + thinking, Gemini
 * `thinkingLevel`/`thinkingBudget`, OpenRouter `reasoning.effort`.
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * What a request needs from a provider. The router derives them from the route and the
 * request (tools, schema, web_grounding, image_generation, attachments) and asks the chosen
 * adapter whether it supports each one. Combined features (`a+b`) cover provider limits such as
 * "search grounding cannot be combined with a response schema".
 */
export const FEATURES = [
  "completion",
  "tools",
  "schema",
  "web_grounding",
  "image_generation",
  "image_input",
  "pdf_input",
  "audio_input",
  "web_grounding+schema",
  "tools+schema",
  "embeddings",
  "transcription",
  "realtime",
] as const;
export type Feature = (typeof FEATURES)[number];

export interface CompletionRequest {
  model: string;
  effort?: Effort;
  instructions: string;
  /**
   * The normalized Odoo history (`core/odoo-history.ts`): canonical attachment mimetypes, no empty
   * attachments, no Odoo `metadata`. Adapters translate it; they do not re-check it.
   */
  messages: OdooMessage[];
  tools: OdooTool[];
  /** JSON schema the final text must follow (the text part is then that JSON, serialized). */
  schema?: Record<string, unknown>;
  webGrounding: boolean;
  imageGeneration: boolean;
  /** One of Odoo's `closest_aspect_ratio` values ("1:1", "16:9", "3:2", ...). */
  aspectRatio?: string;
  maxOutputTokens?: number;
  /** Extra provider-specific request fields from the routing entry, merged into the body. */
  options?: Record<string, unknown>;
  /**
   * Stable id of the Odoo conversation (`services/conversation-id.ts`), for provider cache
   * routing: OpenRouter `session_id`, xAI `prompt_cache_key` (OpenAI only when opted in).
   */
  conversationId?: string;
  signal: AbortSignal;
}

export interface EmbeddingInput {
  title?: string | null;
  content: string;
}

export interface EmbeddingRequest {
  model: string;
  inputs: EmbeddingInput[];
  /** "document" when indexing sources, "query" for the RAG query. */
  mode: "document" | "query";
  /** Always 1536: `ai.embedding.embedding_vector = Vector(size=1536)`. */
  dimensions: number;
  options?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface TranscriptionRequest {
  model: string;
  /** Base64 audio. */
  audio: string;
  mimetype: string;
  language?: string;
  /** "vtt" for call recordings (`mail.call.artifact`), plain text otherwise. */
  responseFormat?: "text" | "vtt";
  options?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface RealtimeSessionRequest {
  model: string;
  language?: string;
  prompt?: string;
  options?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface RealtimeSession {
  /** Ephemeral key the browser passes as `openai-insecure-api-key.<token>` subprotocol. */
  token: string;
  expiresAt?: number;
}

/** Same interface for every provider; unsupported operations throw `UnsupportedFeatureError`. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  supports(feature: Feature, model: string): boolean;
  complete(request: CompletionRequest): Promise<AssistantMessage>;
  embed(request: EmbeddingRequest): Promise<number[][]>;
  transcribe(request: TranscriptionRequest): Promise<string>;
  createRealtimeSession(request: RealtimeSessionRequest): Promise<RealtimeSession>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderSettings {
  apiKey: string;
  baseUrl?: string;
  /** Extra headers sent on every request (e.g. OpenRouter attribution, OpenAI organization). */
  headers?: Record<string, string>;
  fetch: FetchLike;
}
