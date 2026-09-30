/**
 * Prompt caching plan for Claude (direct API and through OpenRouter). Unlike OpenAI and Gemini,
 * Claude only caches at explicit `cache_control` breakpoints, so without them every round of an
 * Odoo tool loop pays the full prompt again.
 *
 * Where the breakpoints go depends on how Odoo builds the history:
 *
 * - Agent chats (`ai.session._submit_agent_request`) append `<odoo_current_context>` (with the
 *   current timestamp) to the current turn's user message on EVERY round. Everything from that
 *   message on changes each request, so caching the tail would only pay the write premium. The
 *   stable parts are the tools + system prompt and the turns before the current one.
 * - One-shot loops (`_get_direct_response` / `_run_agentic_loop`) only append: the whole
 *   conversation is a growing prefix, so the tail is worth caching too.
 *
 * Plan: always a breakpoint on the system prompt (caches tools + system); in agent chats one more
 * on the last block before the rewritten message; in one-shot loops automatic (top-level) caching
 * for the tail. At most three of Claude's four breakpoints, all with the same TTL.
 */
import { volatileMessageIndex } from "../core/odoo-history.js";
import type { OdooMessage } from "../core/odoo-types.js";
import { values, type OptionSpec } from "./options.js";

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface PromptCachePlan {
  control: CacheControl;
  /** Index (in the Odoo messages) of the last message that stays byte-identical, or -1. */
  historyEnd: number;
  /** Use automatic (top-level) caching for the growing tail. */
  tail: boolean;
}

/**
 * `options.prompt_cache` (Claude, and Claude models through OpenRouter). The one-hour TTL makes
 * writes cost 2x instead of 1.25x: worth it when the same prompt comes back less often than every
 * 5 minutes.
 */
export const PROMPT_CACHE_OPTION: OptionSpec = {
  operations: ["completion"],
  merge: "adapter",
  gatewayKey: true,
  value: values.oneOf(true, false, "5m", "1h"),
  doc: "Cache breakpoints (see Prompt caching): `false` turns them off, `\"1h\"` uses the one-hour TTL. Default: on, 5 minutes.",
};

export function planPromptCache(messages: readonly OdooMessage[], option: unknown): PromptCachePlan | undefined {
  if (option === false) return undefined;
  const control: CacheControl = option === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const volatile = volatileMessageIndex(messages);
  return volatile >= 0 ? { control, historyEnd: volatile - 1, tail: false } : { control, historyEnd: -1, tail: true };
}
