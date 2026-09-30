import { describe, expect, it } from "vitest";

import { createHttpClient } from "../../src/core/http-client.js";

describe("outbound http client", () => {
  it("delegates to the built-in fetch with the same body (FormData stays multipart) plus a dispatcher", async () => {
    const seen: Array<{ input: unknown; init: Record<string, unknown> }> = [];
    const client = createHttpClient(300, async (input, init) => {
      seen.push({ input, init: init as Record<string, unknown> });
      return new Response("{}");
    });
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }), "audio.mp3");
    const signal = AbortSignal.timeout(1000);
    await client.fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form, signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.body).toBe(form);
    expect(seen[0]!.init.signal).toBe(signal);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.dispatcher).toBeDefined();
    await client.close(true);
  });

  it("uses the global fetch by default, never the undici package's own fetch", async () => {
    // test/setup.ts stubs the global fetch with the offline guard: reaching it proves delegation.
    const client = createHttpClient(300);
    const call = async () => client.fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" });
    await expect(call()).rejects.toThrow(/Network access is disabled in tests/);
    await client.close();
  });
});
