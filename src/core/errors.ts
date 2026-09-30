/**
 * Errors returned to Odoo as JSON-RPC errors.
 *
 * Odoo's `iap_tools._iap_jsonrpc` reads `response['error']['data']['name']`, and only treats the
 * last dotted segment `InsufficientCreditError` specially; anything else becomes an
 * `IAPServerError` (the user sees "Odoo AI is unreachable"). The details still land in the Odoo
 * server log and in the gateway log.
 */
export class GatewayError extends Error {
  /** Exposed as `error.data.name` (dotted, like Odoo exception names). */
  readonly errorName: string;
  /** JSON-RPC `error.code`. Odoo uses 200 for server-side exceptions. */
  readonly rpcCode: number;

  constructor(message: string, options: { errorName?: string; rpcCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.errorName = `odoo_ai_gateway.errors.${options.errorName ?? new.target.name}`;
    this.rpcCode = options.rpcCode ?? 200;
  }
}

/** Malformed JSON-RPC envelope or missing/invalid params. */
export class InvalidRequestError extends GatewayError {}

/** Missing or unknown `account_token`, or forged realtime transaction token. */
export class AccessDeniedError extends GatewayError {}

/** No usable routing entry, unknown provider, unsupported embedding model name... */
export class RoutingError extends GatewayError {}

/**
 * The provider chosen for the job cannot do what the request needs (tools, schema, web
 * grounding, image generation, embeddings...). The gateway never falls back to another provider.
 */
export class UnsupportedFeatureError extends GatewayError {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly features: readonly string[],
    readonly job?: string,
  ) {
    super(
      `Provider "${provider}" (model "${model}") does not support: ${features.join(", ")}` +
        (job ? ` (job ${job})` : "") +
        ". Configure another provider for this job; the gateway does not switch providers.",
    );
  }
}

/** The upstream provider answered with an error or an unusable payload. */
export class ProviderError extends GatewayError {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly body?: string,
    cause?: unknown,
  ) {
    super(`${provider}: ${message}`, { cause });
  }
}

/** The provider call exceeded the job deadline. */
export class ProviderTimeoutError extends GatewayError {
  constructor(provider: string, seconds: number) {
    super(`${provider}: no response within ${seconds}s`);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
