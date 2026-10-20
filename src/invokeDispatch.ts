import { Catalog } from "./catalog";
import { GrpcInvokeRequest, GrpcInvokeResult, invokeGrpc } from "./grpcInvoke";
import { invokeHttp } from "./httpInvoke";
import { invokeSse } from "./sseInvoke";
import { invokeWebSocket } from "./wsInvoke";

export type InvokeProtocol = "grpc" | "http" | "sse" | "websocket";

export type InvokePayload = GrpcInvokeRequest & {
  protocol?: string;
  httpMethod?: string;
  httpPath?: string;
};

export function normalizeProtocol(value?: string): InvokeProtocol {
  const p = (value || "grpc").toLowerCase();
  if (p === "http" || p === "sse" || p === "websocket" || p === "ws") {
    return p === "ws" ? "websocket" : p;
  }
  return "grpc";
}

export async function dispatchInvoke(
  catalog: Catalog,
  payload: InvokePayload,
): Promise<GrpcInvokeResult> {
  const protocol = normalizeProtocol(payload.protocol);
  if (protocol === "http") return invokeHttp(payload);
  if (protocol === "sse") return invokeSse(payload);
  if (protocol === "websocket") return invokeWebSocket(payload);
  return invokeGrpc(catalog, payload);
}
