/**
 * Global offline guard: the suite must never reach a real provider, webhook or any network.
 * Every outbound HTTP call in the gateway goes through an injected `fetch`; tests inject mocks.
 * Anything that falls back to the global `fetch` fails loudly here.
 */
import { afterEach, beforeAll, vi } from "vitest";

const blockedFetch = (input: unknown) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url;
  throw new Error(`Network access is disabled in tests (attempted fetch: ${url})`);
};

beforeAll(() => {
  vi.stubGlobal("fetch", blockedFetch);
  for (const key of Object.keys(process.env)) {
    if (/(_API_KEY|_TOKEN|_SECRET)$/.test(key)) delete process.env[key];
  }
});

afterEach(() => {
  vi.stubGlobal("fetch", blockedFetch);
});
