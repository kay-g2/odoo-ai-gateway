/**
 * Conversation id: groups every request of one Odoo conversation for provider-side cache routing
 * (OpenRouter `session_id`, xAI/OpenAI `prompt_cache_key`) and for the logs.
 *
 * Odoo never sends a conversation id: `ai.session.id`, the channel and the resume token stay in
 * Odoo. What it does is store every assistant message verbatim (`provider_metadata` included) and
 * send the whole history back on every round and turn, without reading `provider_metadata`. So
 * the gateway mints the id on a conversation's first request, returns it in
 * `provider_metadata.conversation_id`, and reads it back from the history afterwards, the same
 * "the service issues it, Odoo echoes it" pattern as the realtime `iap_transaction_token`.
 *
 * The id is random, not derived from content, and short ASCII: it is part of the signed webhook
 * body, and jsonb storage may reorder `provider_metadata` keys but never changes a string.
 */
import { randomBytes } from "node:crypto";

import type { OdooMessage } from "../core/odoo-types.js";

export const CONVERSATION_ID_KEY = "conversation_id";

/** `cv_` + base64url. Anything else found in the history (foreign or tampered) is ignored. */
export const CONVERSATION_ID_PATTERN = /^cv_[A-Za-z0-9_-]{16,64}$/;

export function newConversationId(): string {
  return `cv_${randomBytes(16).toString("base64url")}`;
}

/**
 * The id carried by the oldest assistant message that has a valid one, or undefined for a new
 * conversation. Histories from before the gateway minted ids have none on their early messages,
 * hence the scan instead of looking only at the first assistant message.
 */
export function conversationIdOf(messages: readonly OdooMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const value: unknown = message.provider_metadata?.[CONVERSATION_ID_KEY];
    if (typeof value === "string" && CONVERSATION_ID_PATTERN.test(value)) return value;
  }
  return undefined;
}
