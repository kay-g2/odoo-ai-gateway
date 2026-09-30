import { InvalidRequestError, ProviderError, ProviderTimeoutError, RoutingError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { normalizeHistory } from "../core/odoo-history.js";
import type { AssistantMessage, AssistantPart, CompletionParams, OdooMessage, OdooTool } from "../core/odoo-types.js";
import { sanitizeForOdoo } from "../core/signature.js";
import { stripCodeFence } from "../providers/parts.js";
import type { GatewayConfig, Route } from "../config/schema.js";
import type { ProviderAdapter, ProviderName } from "../providers/types.js";
import { completionFeatures, ensureSupported, resolveJob, type RoutingDecision } from "../router/router.js";
import { CONVERSATION_ID_KEY, conversationIdOf, newConversationId } from "./conversation-id.js";

export type AdapterLookup = (provider: ProviderName) => ProviderAdapter | undefined;

export interface PreparedCompletion {
  decision: RoutingDecision;
  adapter: ProviderAdapter;
  instructions: string;
  /** The normalized history (`core/odoo-history.ts`): what the router and the adapter read. */
  messages: OdooMessage[];
  tools: OdooTool[];
  schema?: Record<string, unknown>;
  webGrounding: boolean;
  imageGeneration: boolean;
  aspectRatio?: string;
  timeoutSeconds: number;
  /** Read from the history, or minted for a new conversation; returned in `provider_metadata`. */
  conversationId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTools(raw: unknown): OdooTool[] {
  // `_run_agentic_loop` sends `{}` when there are no tools; `None`/missing also mean none.
  if (raw === undefined || raw === null || (isPlainObject(raw) && Object.keys(raw).length === 0)) return [];
  if (!Array.isArray(raw)) throw new InvalidRequestError("params.tools must be a list");
  return raw.map((tool, index) => {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !tool.name) {
      throw new InvalidRequestError(`params.tools[${index}] must be {name, instructions, schema}`);
    }
    return {
      name: tool.name,
      instructions: typeof tool.instructions === "string" ? tool.instructions : "",
      schema: isPlainObject(tool.schema) ? tool.schema : null,
    };
  });
}

/**
 * With a schema, Odoo does `json.loads(get_text_from_parts(parts))`: the answer must be exactly
 * one text part holding JSON. Merge text parts, strip fences, and check it parses.
 */
function enforceSchemaText(message: AssistantMessage, provider: string): AssistantMessage {
  const texts = message.content.filter((part) => part.type === "text");
  if (message.content.some((part) => part.type === "tool_call")) return message;
  const joined = stripCodeFence(texts.map((part) => (part.type === "text" ? part.text : "")).join("")).trim();
  try {
    JSON.parse(joined);
  } catch {
    throw new ProviderError(provider, "structured output is not valid JSON");
  }
  const others = message.content.filter((part) => part.type !== "text");
  return { ...message, content: [{ type: "text", text: joined }, ...others] };
}

function sanitizeAssistantMessage(
  message: AssistantMessage,
  provider: ProviderName,
  model: string,
  conversationId: string,
): AssistantMessage {
  const content: AssistantPart[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      if (part.text || part.sources) content.push(part);
    } else if (part.type === "tool_call") {
      content.push({
        ...part,
        args: isPlainObject(part.args) ? part.args : {},
        call_id: String(part.call_id),
      });
    } else if (part.type === "inline_data") {
      content.push(part);
    }
  }
  return {
    role: "assistant",
    content,
    provider_metadata: { provider, model, ...(message.provider_metadata ?? {}), [CONVERSATION_ID_KEY]: conversationId },
  };
}

export class CompletionService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly adapters: AdapterLookup,
    private readonly logger: Logger,
  ) {}

  adapterFor(decision: RoutingDecision): ProviderAdapter {
    const adapter = this.adapters(decision.target.provider);
    if (!adapter) {
      throw new RoutingError(`Job ${decision.job} routes to provider "${decision.target.provider}", which is not configured`);
    }
    return adapter;
  }

  /** Validate params, route the job and check capabilities. Throws before anything is queued. */
  prepare(route: Route, params: CompletionParams): PreparedCompletion {
    const messages = normalizeHistory(params.messages);
    const tools = normalizeTools(params.tools);
    const schema = isPlainObject(params.schema) && Object.keys(params.schema).length ? params.schema : undefined;
    const instructions = typeof params.instructions === "string" ? params.instructions : "";
    const webGrounding = Boolean(params.web_grounding);
    const imageGeneration = Boolean(params.image_generation);

    const decision = resolveJob(this.config, {
      route,
      usage: typeof params.usage === "string" ? params.usage : undefined,
      webGrounding,
      imageGeneration,
      boostReasoning: Boolean(params.boost_reasoning),
    });
    const adapter = this.adapterFor(decision);
    ensureSupported(adapter, decision, completionFeatures({ ...params, messages, tools, schema: schema ?? null }));

    // Odoo's `timeout` param is a hint for the provider deadline. For the sync route Odoo's own HTTP
    // client gives up after 60 s (`call_odoo_ai` default) whatever the param says, so cap it there.
    const cap = route === "1/get_completions_sync" ? this.config.server.syncTimeoutSeconds : this.config.server.completionTimeoutSeconds;
    const requested = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : cap;
    const prepared: PreparedCompletion = {
      decision,
      adapter,
      instructions,
      messages,
      tools,
      webGrounding,
      imageGeneration,
      timeoutSeconds: Math.min(requested, cap),
      conversationId: conversationIdOf(messages) ?? newConversationId(),
    };
    if (schema) prepared.schema = schema;
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio) prepared.aspectRatio = params.aspect_ratio;
    return prepared;
  }

  async run(prepared: PreparedCompletion): Promise<AssistantMessage> {
    const { decision, adapter } = prepared;
    const { target } = decision;
    const started = Date.now();
    const signal = AbortSignal.timeout(prepared.timeoutSeconds * 1000);
    let message: AssistantMessage;
    try {
      message = await adapter.complete({
        model: target.model,
        ...(target.effort ? { effort: target.effort } : {}),
        ...(target.maxOutputTokens ? { maxOutputTokens: target.maxOutputTokens } : {}),
        ...(target.options ? { options: target.options } : {}),
        ...(prepared.schema ? { schema: prepared.schema } : {}),
        ...(prepared.aspectRatio ? { aspectRatio: prepared.aspectRatio } : {}),
        conversationId: prepared.conversationId,
        instructions: prepared.instructions,
        messages: prepared.messages,
        tools: prepared.tools,
        webGrounding: prepared.webGrounding,
        imageGeneration: prepared.imageGeneration,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderTimeoutError(adapter.name, prepared.timeoutSeconds);
      throw error;
    }
    // jsonb-safety only here; the webhook adds the Unicode-stable replacement it needs for signing.
    let result = sanitizeForOdoo(sanitizeAssistantMessage(message, adapter.name, target.model, prepared.conversationId), { unicodeStable: false });
    if (prepared.schema) result = enforceSchemaText(result, adapter.name);
    this.logger.info("completion done", {
      job: decision.job,
      conversation: prepared.conversationId,
      provider: adapter.name,
      model: target.model,
      effort: target.effort,
      tier: decision.tier,
      boosted: decision.boosted,
      ms: Date.now() - started,
      parts: result.content.map((part) => part.type),
      usage: result.provider_metadata.usage,
    });
    return result;
  }
}
