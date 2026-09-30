/**
 * JSON-RPC 2.0 as spoken by `odoo.addons.iap.tools.iap_tools.iap_jsonrpc`:
 *
 *   request:  {"jsonrpc": "2.0", "method": "call", "params": {...}, "id": "<hex>"}
 *   success:  {"jsonrpc": "2.0", "id": ..., "result": ...}
 *   failure:  {"jsonrpc": "2.0", "id": ..., "error": {"code", "message", "data": {"name", "message", ...}}}
 *
 * The client calls `raise_for_status()` before reading the body, so errors are sent with HTTP 200
 * and must carry `error.data.name` (it does `data.get('name').rpartition('.')`).
 */
import { GatewayError, InvalidRequestError } from "./errors.js";

export type RpcId = string | number | null;

export interface RpcRequest {
  id: RpcId;
  params: Record<string, unknown>;
}

export function parseRpcRequest(body: unknown): RpcRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidRequestError("Expected a JSON-RPC 2.0 request object", { rpcCode: -32600 });
  }
  const envelope = body as Record<string, unknown>;
  const id = (typeof envelope.id === "string" || typeof envelope.id === "number" ? envelope.id : null) as RpcId;
  if (envelope.jsonrpc !== "2.0") {
    throw new InvalidRequestError('Expected "jsonrpc": "2.0"', { rpcCode: -32600 });
  }
  const params = envelope.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new InvalidRequestError("JSON-RPC params must be an object", { rpcCode: -32602 });
  }
  return { id, params: params as Record<string, unknown> };
}

export function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function rpcError(id: RpcId, error: unknown) {
  const gatewayError = error instanceof GatewayError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  const name = gatewayError?.errorName ?? "odoo_ai_gateway.errors.InternalError";
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code: gatewayError?.rpcCode ?? 200,
      message: "Odoo AI Gateway Error",
      data: {
        name,
        message,
        arguments: [message],
        context: {},
        debug: "",
      },
    },
  };
}
