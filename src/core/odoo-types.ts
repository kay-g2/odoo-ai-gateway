/**
 * Wire types of the Odoo 20 AI client (enterprise/ai/utils/types.py), as sent to and read back
 * from `{ai.endpoint}/api/odoo_ai/{route}`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A web source referenced by `[WEB_SOURCE:<hex id>]` markers (ai/utils/ai_citation.py). */
export interface WebSource {
  url: string;
  source_name: string;
}

export interface TextPart {
  type: "text";
  text: string;
  /** Web grounding: `{hexId: {url, source_name}}`, popped by `_ai_tool_web_search`. */
  sources?: Record<string, WebSource>;
  provider_data?: Record<string, unknown>;
}

export interface InlineDataPart {
  type: "inline_data";
  /** Base64 encoded content. */
  data: string;
  mimetype: string;
  /** Odoo-side bookkeeping (image_path, attachment_id, aspect_ratio...). Never sent to providers. */
  metadata?: Record<string, unknown>;
  provider_data?: Record<string, unknown>;
}

export interface ToolCallPart {
  type: "tool_call";
  name: string;
  /** Always a JSON object: Odoo reads `tool_call['args'].keys()`. */
  args: Record<string, unknown>;
  /** Odoo echoes it back as `tool_result.tool_call_id` (its own tests use ints). */
  call_id: string | number;
  provider_data?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  tool_name: string;
  tool_call_id: string | number;
  result: Array<TextPart | InlineDataPart>;
  success: boolean;
}

export type UserPart = TextPart | InlineDataPart | ToolResultPart;
export type AssistantPart = TextPart | InlineDataPart | ToolCallPart;
export type AnyPart = UserPart | AssistantPart;

export interface UserMessage {
  role: "user";
  content: UserPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantPart[];
  /** Opaque to Odoo; stored with the session event and sent back with the history. */
  provider_metadata: Record<string, unknown>;
}

export type OdooMessage = UserMessage | AssistantMessage;

/** `ai.session._prepare_tools`: `{name, instructions, schema}`. */
export interface OdooTool {
  name: string;
  instructions: string;
  schema: Record<string, unknown> | null;
}

/** Params of `1/get_completions` and `1/get_completions_sync`. */
export interface CompletionParams {
  messages: OdooMessage[];
  instructions: string;
  /** A list, but `_run_agentic_loop` sends `{}` when there are no tools, and `None` is possible. */
  tools?: OdooTool[] | Record<string, never> | null;
  schema?: Record<string, unknown> | null;
  usage?: string | null;
  web_grounding?: boolean | null;
  image_generation?: boolean | null;
  boost_reasoning?: boolean | null;
  aspect_ratio?: string | null;
  /** Seconds. Sent by website/campaign builders and one-shot callers (`_get_direct_response`). */
  timeout?: number | null;
  // Async only:
  request_uuid?: string;
  webhook_url?: string;
  webhook_secret?: string;
  webhook_dbname?: string;
  llm_retry?: boolean;
  // IAP identification (not for embedding-model listing routes):
  account_token?: string;
  dbuuid?: string;
  [key: string]: unknown;
}

/** `llm_result` of the webhook and `result` of `1/get_completions_sync`. */
export interface CompletionResult {
  status: "success";
  result: AssistantMessage;
}
