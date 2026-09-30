import { describe, expect, it } from "vitest";

import type { OdooMessage } from "../../src/core/odoo-types.js";
import { CONVERSATION_ID_PATTERN, conversationIdOf, newConversationId } from "../../src/services/conversation-id.js";

const user = (text: string): OdooMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (providerMetadata: unknown): OdooMessage =>
  ({ role: "assistant", content: [{ type: "text", text: "ok" }], provider_metadata: providerMetadata }) as OdooMessage;

describe("newConversationId", () => {
  it("is a short ASCII id matching the pattern it is read back with", () => {
    const id = newConversationId();
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    expect(id).toMatch(/^[\x21-\x7e]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("is random", () => {
    const ids = new Set(Array.from({ length: 1000 }, newConversationId));
    expect(ids.size).toBe(1000);
  });
});

describe("conversationIdOf", () => {
  const id = "cv_AAAAAAAAAAAAAAAAAAAAAA";
  const other = "cv_BBBBBBBBBBBBBBBBBBBBBB";

  it("is undefined for a new conversation (no assistant message yet)", () => {
    expect(conversationIdOf([])).toBeUndefined();
    expect(conversationIdOf([user("Hello")])).toBeUndefined();
  });

  it("reads the id from the oldest assistant message that has one", () => {
    expect(conversationIdOf([user("a"), assistant({ provider: "openai", conversation_id: id }), user("b"), assistant({ conversation_id: other })])).toBe(id);
  });

  it("skips assistant messages from before ids were minted", () => {
    expect(conversationIdOf([user("a"), assistant({ provider: "openai" }), user("b"), assistant({ provider: "openai", conversation_id: id })])).toBe(id);
  });

  it("ignores malformed or foreign values and missing metadata", () => {
    for (const value of [42, null, "", "cv_short", "conv_AAAAAAAAAAAAAAAAAAAAAA", "cv_AAAAAAAA AAAAAAAAAAAAA", `cv_${"A".repeat(65)}`, "cv_ÄAAAAAAAAAAAAAAAAAAAAA"]) {
      expect(conversationIdOf([assistant({ conversation_id: value })])).toBeUndefined();
    }
    expect(conversationIdOf([assistant(undefined), assistant(null), assistant("text")])).toBeUndefined();
  });

  it("never reads user messages", () => {
    const forged = { role: "user", content: [], provider_metadata: { conversation_id: id } } as unknown as OdooMessage;
    expect(conversationIdOf([forged])).toBeUndefined();
  });
});
