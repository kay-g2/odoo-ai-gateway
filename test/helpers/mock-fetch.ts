/**
 * Offline stand-in for `fetch`: records every call and answers from a queue.
 * Adapters and the webhook sender receive `mock.fetch` instead of the global fetch.
 */
import type { FetchLike } from "../../src/providers/types.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, the FormData instance, raw text, or undefined. */
  body: any;
  rawBody?: string;
  signal?: AbortSignal | null;
  redirect?: RequestInit["redirect"];
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Responder[] = [];

  /** Queue a JSON body, a Response, or a function computing the Response from the call. */
  reply(response: unknown | Response | Responder, status = 200): this {
    if (typeof response === "function") this.queue.push(response as Responder);
    else if (response instanceof Response) this.queue.push(() => response);
    else this.queue.push(() => jsonResponse(response, status));
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  get last(): RecordedCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error("MockFetch: no call recorded");
    return call;
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).forEach((value, key) => {
      headers[key] = value;
    });
    let body: any;
    let rawBody: string | undefined;
    if (typeof init.body === "string") {
      rawBody = init.body;
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else {
      body = init.body ?? undefined;
    }
    const call: RecordedCall = { url, method: init.method ?? "GET", headers, body, signal: init.signal ?? null, redirect: init.redirect, ...(rawBody === undefined ? {} : { rawBody }) };
    this.calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    const responder = this.queue.shift();
    if (!responder) throw new Error(`MockFetch: unexpected ${call.method} ${url}`);
    return responder(call);
  };
}
