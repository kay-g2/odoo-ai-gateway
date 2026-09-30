/**
 * `1/get_embeddings`, `1/get_default_embedding_model`, `1/get_supported_embedding_models`.
 *
 * Odoo stores vectors in `ai.embedding.embedding_vector = Vector(size=1536)`, so every model
 * served here must produce 1536 dimensions. The default embedding model is the target routed for
 * `1/get_embeddings`; its public name (`name`, else `model`) is what Odoo saves on each agent and
 * sends back as `params.model`. Names listed in `embeddings.additional` stay accepted.
 */
import { InvalidRequestError, ProviderError, RoutingError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { GatewayConfig, Target } from "../config/schema.js";
import type { EmbeddingInput } from "../providers/types.js";
import { ensureSupported, resolveJob, type RoutingDecision } from "../router/router.js";
import type { AdapterLookup } from "./completions.js";

export const EMBEDDING_DIMENSIONS = 1536;

export function embeddingName(target: Target): string {
  return target.name ?? target.model;
}

export class EmbeddingService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly adapters: AdapterLookup,
    private readonly logger: Logger,
  ) {}

  private defaultDecision(): RoutingDecision {
    return resolveJob(this.config, { route: "1/get_embeddings" });
  }

  defaultModelName(): string {
    return embeddingName(this.defaultDecision().target);
  }

  supportedModelNames(): string[] {
    const names = [this.defaultModelName(), ...this.config.embeddings.additional.map(embeddingName)];
    return [...new Set(names)];
  }

  /** Resolve Odoo's `params.model` (empty for agents created at install time) to a target. */
  private decisionFor(model: unknown): RoutingDecision {
    const byDefault = this.defaultDecision();
    if (model === undefined || model === null || model === false || model === "" || model === embeddingName(byDefault.target)) {
      return byDefault;
    }
    const additional = this.config.embeddings.additional.find((target) => embeddingName(target) === model);
    if (!additional) {
      throw new RoutingError(
        `Unsupported embedding model "${String(model)}"; supported: ${this.supportedModelNames().join(", ")}. ` +
          "After changing the embedding model, restart Odoo (the model list is cached) and run the scheduled action " +
          '"AI Embedding: Update deprecated embedding models" so agents and sources move to the new model.',
      );
    }
    return { job: `embeddings:${embeddingName(additional)}`, matchedBy: "route", boosted: false, target: additional };
  }

  async embed(params: Record<string, unknown>): Promise<{ status: "success"; embeddings: number[][] }> {
    const rawInputs = params.input;
    if (!Array.isArray(rawInputs)) throw new InvalidRequestError("params.input must be a list of {title, content}");
    const inputs: EmbeddingInput[] = rawInputs.map((item, index) => {
      if (typeof item === "string") return { content: item };
      if (!item || typeof item !== "object") throw new InvalidRequestError(`params.input[${index}] must be {title, content}`);
      const { title, content } = item as Record<string, unknown>;
      return {
        title: typeof title === "string" ? title : null,
        content: typeof content === "string" ? content : content == null || content === false ? "" : String(content),
      };
    });
    const mode = params.mode === "query" ? "query" : "document";
    const decision = this.decisionFor(params.model);
    const adapter = this.adapters(decision.target.provider);
    if (!adapter) throw new RoutingError(`Embedding provider "${decision.target.provider}" is not configured`);
    ensureSupported(adapter, decision, ["embeddings"]);
    if (inputs.length === 0) return { status: "success", embeddings: [] };

    const vectors = await adapter.embed({
      model: decision.target.model,
      inputs,
      mode,
      dimensions: EMBEDDING_DIMENSIONS,
      ...(decision.target.options ? { options: decision.target.options } : {}),
      signal: AbortSignal.timeout(this.config.server.requestTimeoutSeconds * 1000),
    });
    if (vectors.length !== inputs.length) {
      throw new ProviderError(adapter.name, `returned ${vectors.length} embeddings for ${inputs.length} inputs`);
    }
    vectors.forEach((vector, index) => {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new ProviderError(adapter.name, `embedding ${index} has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
    });
    this.logger.info("embeddings done", { job: decision.job, provider: adapter.name, model: decision.target.model, count: inputs.length, mode });
    return { status: "success", embeddings: vectors };
  }
}
