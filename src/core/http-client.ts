/**
 * Outbound HTTP for providers and the webhook, on Node's built-in `fetch`.
 *
 * Node's fetch gives up after 300 s without response headers (undici defaults), which would cut
 * long high-effort completions short of `completionTimeoutSeconds`. We keep the built-in fetch (it
 * understands the global FormData/Blob the transcription adapters send; the `undici` package's own
 * fetch does not) and only pass it a dispatcher whose timeouts sit above our AbortSignal deadlines.
 */
import { Agent } from "undici";

import type { FetchLike } from "../providers/types.js";

export interface HttpClient {
  fetch: FetchLike;
  /** Graceful close; `force` aborts requests still in flight (shutdown deadline reached). */
  close(force?: boolean): Promise<void>;
}

export function createHttpClient(timeoutSeconds: number, baseFetch: FetchLike = globalThis.fetch): HttpClient {
  const timeoutMs = (timeoutSeconds + 30) * 1000;
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: 30_000 });
  return {
    // `dispatcher` is Node's (undici) extension of RequestInit.
    fetch: (input, init) => baseFetch(input, { ...init, dispatcher } as unknown as RequestInit),
    close: (force = false) => (force ? dispatcher.destroy() : dispatcher.close()).catch(() => undefined),
  };
}
