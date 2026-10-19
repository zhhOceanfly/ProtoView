import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import { Catalog } from "./catalog";

export interface GrpcInvokeRequest {
  id?: string;
  host: string;
  package: string;
  service: string;
  method: string;
  file: string;
  body: unknown;
  metadata?: Record<string, string>;
  tls?: boolean;
}

export interface GrpcInvokeResult {
  id?: string;
  ok: boolean;
  status: string;
  code?: number;
  ms: number;
  host: string;
  method: string;
  body?: unknown;
  error?: string;
}

const clients = new Map<string, grpc.Client>();

export async function invokeGrpc(catalog: Catalog, req: GrpcInvokeRequest): Promise<GrpcInvokeResult> {
  const started = Date.now();
  const method = `${req.package}.${req.service}/${req.method}`;
  const host = (req.host || "").trim();
  const base = {
    id: req.id,
    host,
    method,
    ms: 0,
  };
  if (!host) {
    return { ...base, ok: false, status: "INVALID", error: "未配置地址，请在顶部填写 host:port" };
  }
  try {
    const abs = resolveProto(catalog, req.file);
    if (!abs) {
      return { ...base, ok: false, status: "NOT_FOUND", ms: Date.now() - started, error: `找不到 proto 文件：${req.file}` };
    }
    const includeDirs = protoIncludeDirs(catalog);
    const packageDefinition = protoLoader.loadSync(abs, {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>;
    const Service = lookupService(loaded, req.package, req.service);
    const descriptor = (Service as unknown as { service?: Record<string, { requestStream?: boolean; responseStream?: boolean }> }).service?.[req.method];
    if (!descriptor) {
      return { ...base, ok: false, status: "NOT_FOUND", ms: Date.now() - started, error: `服务 ${req.package}.${req.service} 上没有方法 ${req.method}` };
    }
    if (descriptor.requestStream) {
      return { ...base, ok: false, status: "UNIMPLEMENTED", ms: Date.now() - started, error: "暂不支持客户端流式 RPC" };
    }
    const key = `${host}|${req.tls ? "tls" : "plain"}|${abs}|${req.package}.${req.service}`;
    let client = clients.get(key);
    if (!client) {
      const creds = req.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
      client = new (Service as unknown as new (address: string, creds: grpc.ChannelCredentials) => grpc.Client)(host, creds);
      clients.set(key, client);
    }
    const md = new grpc.Metadata();
    for (const [name, value] of Object.entries(req.metadata ?? {})) {
      if (name.trim()) md.set(name.trim(), String(value ?? ""));
    }
    const deadline = new Date(Date.now() + 15000);
    const body = await callMethod(client, req.method, req.body ?? {}, md, deadline, Boolean(descriptor.responseStream));
    return { ...base, ok: true, status: "OK", ms: Date.now() - started, body };
  } catch (error) {
    const grpcError = error as { code?: number; details?: string; message?: string };
    const code = typeof grpcError.code === "number" ? grpcError.code : undefined;
    const status = code !== undefined ? grpc.status[code] ?? String(code) : "ERROR";
    if (code === grpc.status.UNAVAILABLE) dropClients(host);
    return {
      ...base,
      ok: false,
      status,
      code,
      ms: Date.now() - started,
      error: grpcError.details || grpcError.message || String(error),
    };
  }
}

function callMethod(
  client: grpc.Client,
  method: string,
  body: unknown,
  metadata: grpc.Metadata,
  deadline: Date,
  responseStream: boolean,
): Promise<unknown> {
  const fn = (client as unknown as Record<string, Function>)[method];
  if (typeof fn !== "function") return Promise.reject(new Error(`无法调用 ${method}`));
  if (!responseStream) {
    return new Promise((resolve, reject) => {
      fn.call(client, body, metadata, { deadline }, (error: Error | null, response: unknown) => {
        if (error) reject(error);
        else resolve(response ?? {});
      });
    });
  }
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const stream = fn.call(client, body, metadata, { deadline }) as grpc.ClientReadableStream<unknown>;
    stream.on("data", (item) => messages.push(item));
    stream.on("error", reject);
    stream.on("end", () => resolve(messages));
  });
}

function lookupService(root: Record<string, unknown>, packageName: string, service: string): unknown {
  let cursor: unknown = root;
  for (const part of packageName.split(".")) {
    cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[part] : undefined;
  }
  const ctor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[service] : undefined;
  if (typeof ctor !== "function") {
    throw new Error(`找不到服务 ${packageName}.${service}。请确认 proto 的 package / service 名称。`);
  }
  return ctor;
}

function resolveProto(catalog: Catalog, file: string): string | undefined {
  const target = file.replace(/\\/g, "/");
  for (const pkg of catalog.packages) {
    for (const item of pkg.files) {
      if (item.relPath.replace(/\\/g, "/") === target || item.path === file) return item.path;
    }
    for (const service of pkg.services) {
      if (service.relPath.replace(/\\/g, "/") === target) return service.file;
      for (const rpc of service.rpcs) {
        if (rpc.relPath.replace(/\\/g, "/") === target) return rpc.file;
      }
    }
  }
  if (path.isAbsolute(file)) return file;
  return undefined;
}

function protoIncludeDirs(catalog: Catalog): string[] {
  const dirs = new Set<string>();
  for (const pkg of catalog.packages) {
    for (const item of pkg.files) dirs.add(path.dirname(item.path));
  }
  return [...dirs];
}

function dropClients(host: string): void {
  for (const [key, client] of clients) {
    if (key.startsWith(`${host}|`)) {
      client.close();
      clients.delete(key);
    }
  }
}
