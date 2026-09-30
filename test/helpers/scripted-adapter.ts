/**
 * Provider stand-in for route/router tests: records normalized requests and answers from a script.
 * Provider translation itself is covered by test/providers/*.test.ts with mocked HTTP.
 */
import type { AssistantMessage, AssistantPart } from "../../src/core/odoo-types.js";
import { UnsupportedFeatureError } from "../../src/core/errors.js";
import type {
  CompletionRequest,
  EmbeddingRequest,
  Feature,
  ProviderAdapter,
  ProviderName,
  RealtimeSession,
  RealtimeSessionRequest,
  TranscriptionRequest,
} from "../../src/providers/types.js";

type CompletionScript = AssistantPart[] | ((request: CompletionRequest) => AssistantPart[] | Promise<AssistantPart[]>) | Error;

export class ScriptedAdapter implements ProviderAdapter {
  readonly completions: CompletionRequest[] = [];
  readonly embeddings: EmbeddingRequest[] = [];
  readonly transcriptions: TranscriptionRequest[] = [];
  readonly realtimeSessions: RealtimeSessionRequest[] = [];
  private readonly script: CompletionScript[] = [];
  embedDimensions = 1536;
  transcript = "transcribed text";

  constructor(
    readonly name: ProviderName,
    private readonly unsupported: ReadonlySet<Feature> = new Set(),
  ) {}

  /** Queue the content of the next assistant message (or an error to throw). */
  then(content: CompletionScript): this {
    this.script.push(content);
    return this;
  }

  supports(feature: Feature): boolean {
    return !this.unsupported.has(feature);
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    this.completions.push(structuredClone({ ...request, signal: undefined }) as unknown as CompletionRequest);
    const next = this.script.shift();
    if (next === undefined) throw new Error(`ScriptedAdapter(${this.name}): no scripted completion left`);
    if (next instanceof Error) throw next;
    const content = typeof next === "function" ? await next(request) : next;
    return {
      role: "assistant",
      content,
      provider_metadata: { provider: this.name, model: request.model, [this.name]: { turn: this.completions.length } },
    };
  }

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (this.unsupported.has("embeddings")) throw new UnsupportedFeatureError(this.name, request.model, ["embeddings"]);
    this.embeddings.push({ ...request, signal: undefined } as unknown as EmbeddingRequest);
    return request.inputs.map((_, index) => Array.from({ length: this.embedDimensions }, (__, i) => (index + 1) / (i + 1)));
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    this.transcriptions.push({ ...request, signal: undefined } as unknown as TranscriptionRequest);
    return request.responseFormat === "vtt" ? `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n${this.transcript}\n` : this.transcript;
  }

  async createRealtimeSession(request: RealtimeSessionRequest): Promise<RealtimeSession> {
    this.realtimeSessions.push({ ...request, signal: undefined } as unknown as RealtimeSessionRequest);
    return { token: "ek_test_ephemeral", expiresAt: 1_900_000_000 };
  }
}
