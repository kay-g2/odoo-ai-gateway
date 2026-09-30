/** Small fetch helpers shared by the adapters (no SDKs: every provider is plain HTTP + JSON). */
import { ProviderError } from "../core/errors.js";
import type { FetchLike } from "./types.js";

export interface HttpRequest {
  fetch: FetchLike;
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** JSON-serialized when it is not FormData/string. */
  body?: unknown;
  signal?: AbortSignal;
}

/** Extract a readable message from the error bodies used by OpenAI, Anthropic, Gemini, xAI and OpenRouter. */
export function upstreamErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.detail === "string" && record.detail) return record.detail;
  }
  return fallback;
}

async function send(request: HttpRequest): Promise<Response> {
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  let body: RequestInit["body"] | undefined;
  if (request.body instanceof FormData || typeof request.body === "string") {
    body = request.body;
  } else if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers["Content-Type"] ??= "application/json";
  }
  const response = await request.fetch(request.url, {
    method: request.method ?? "POST",
    headers,
    ...(body === undefined ? {} : { body }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    const message = upstreamErrorMessage(parsed, text.slice(0, 500) || response.statusText);
    throw new ProviderError(request.provider, `HTTP ${response.status}: ${message}`, response.status, text.slice(0, 2000));
  }
  return response;
}

export async function requestJson<T = Record<string, unknown>>(request: HttpRequest): Promise<T> {
  const response = await send(request);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProviderError(request.provider, "response is not valid JSON", response.status, text.slice(0, 2000), error);
  }
}

export async function requestText(request: HttpRequest): Promise<string> {
  const response = await send(request);
  return response.text();
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
