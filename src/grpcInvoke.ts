import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import { Catalog } from "./catalog";

export interface GrpcStreamWrite {
  body: unknown;
  delayMs?: number;
}

export interface GrpcStreamPlan {
  /** 按序写入；客户端流 / 双向流在写完后 end */
  writes?: GrpcStreamWrite[];
  /** 无新收包超过该毫秒则结束读侧（默认 15000） */
  idleTimeoutMs?: number;
  /** 最多收多少条，防无限服务端流（默认 500） */
  maxMessages?: number;
}

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
  streamPlan?: GrpcStreamPlan;
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

    const plan = normalizePlan(req);
    const deadlineMs = computeDeadlineMs(plan, Boolean(descriptor.requestStream), Boolean(descriptor.responseStream));
    const deadline = new Date(Date.now() + deadlineMs);

    const body = await callMethod(client, req.method, {
      body: req.body ?? {},
      metadata: md,
      deadline,
      requestStream: Boolean(descriptor.requestStream),
      responseStream: Boolean(descriptor.responseStream),
      plan,
    });
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

function normalizePlan(req: GrpcInvokeRequest): Required<Pick<GrpcStreamPlan, "idleTimeoutMs" | "maxMessages">> & { writes: GrpcStreamWrite[] } {
  const raw = req.streamPlan;
  let writes = Array.isArray(raw?.writes) ? raw!.writes.filter((w) => w && typeof w === "object") : [];
  if (!writes.length) {
    // 无 plan：默认把 body 写一次（client/bidi 兜底）
    writes = [{ body: req.body ?? {} }];
  }
  return {
    writes,
    idleTimeoutMs: Math.max(500, Number(raw?.idleTimeoutMs || 15000) || 15000),
    maxMessages: Math.max(1, Math.min(5000, Number(raw?.maxMessages || 500) || 500)),
  };
}

function computeDeadlineMs(
  plan: { writes: GrpcStreamWrite[]; idleTimeoutMs: number },
  requestStream: boolean,
  responseStream: boolean,
): number {
  if (!requestStream && !responseStream) return 15000;
  let writeBudget = 0;
  for (const w of plan.writes) {
    writeBudget += Math.max(0, Number(w.delayMs || 0) || 0) + 50;
  }
  // 写完 + 空闲超时 + 缓冲
  return Math.max(15000, writeBudget + plan.idleTimeoutMs + 5000);
}

function callMethod(
  client: grpc.Client,
  method: string,
  options: {
    body: unknown;
    metadata: grpc.Metadata;
    deadline: Date;
    requestStream: boolean;
    responseStream: boolean;
    plan: { writes: GrpcStreamWrite[]; idleTimeoutMs: number; maxMessages: number };
  },
): Promise<unknown> {
  const fn = (client as unknown as Record<string, Function>)[method];
  if (typeof fn !== "function") return Promise.reject(new Error(`无法调用 ${method}`));

  const { body, metadata, deadline, requestStream, responseStream, plan } = options;

  // Unary
  if (!requestStream && !responseStream) {
    return new Promise((resolve, reject) => {
      fn.call(client, body, metadata, { deadline }, (error: Error | null, response: unknown) => {
        if (error) reject(error);
        else resolve(response ?? {});
      });
    });
  }

  // Server stream only
  if (!requestStream && responseStream) {
    return collectReadable(
      fn.call(client, body, metadata, { deadline }) as grpc.ClientReadableStream<unknown>,
      plan.idleTimeoutMs,
      plan.maxMessages,
    );
  }

  // Client stream only
  if (requestStream && !responseStream) {
    return new Promise((resolve, reject) => {
      const call = fn.call(client, metadata, { deadline }, (error: Error | null, response: unknown) => {
        if (error) reject(error);
        else resolve(response ?? {});
      }) as grpc.ClientWritableStream<unknown>;
      call.on("error", reject);
      void writeAll(call, plan.writes).then(() => {
        try { call.end(); } catch { /* ignore */ }
      }).catch(reject);
    });
  }

  // Bidi
  return new Promise((resolve, reject) => {
    const call = fn.call(client, metadata, { deadline }) as grpc.ClientDuplexStream<unknown, unknown>;
    const messages: unknown[] = [];
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        try { call.end(); } catch { /* ignore */ }
        try { call.cancel(); } catch { /* ignore */ }
        finish();
      }, plan.idleTimeoutMs);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearIdle();
      resolve(messages);
    };

    call.on("data", (item) => {
      messages.push(item);
      if (messages.length >= plan.maxMessages) {
        try { call.end(); } catch { /* ignore */ }
        try { call.cancel(); } catch { /* ignore */ }
        finish();
        return;
      }
      armIdle();
    });
    call.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(error);
    });
    call.on("end", finish);
    call.on("status", () => { /* status after end */ });

    void writeAll(call, plan.writes).then(() => {
      try { call.end(); } catch { /* ignore */ }
      armIdle();
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(error);
    });
  });
}

async function writeAll(
  call: { write: (msg: unknown, cb?: (error?: Error | null) => void) => boolean },
  writes: GrpcStreamWrite[],
): Promise<void> {
  for (const item of writes) {
    const delay = Math.max(0, Number(item.delayMs || 0) || 0);
    if (delay) await sleep(delay);
    await writeOne(call, item.body ?? {});
  }
}

function writeOne(
  call: { write: (msg: unknown, cb?: (error?: Error | null) => void) => boolean },
  body: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      call.write(body);
      resolve();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function collectReadable(
  stream: grpc.ClientReadableStream<unknown>,
  idleTimeoutMs: number,
  maxMessages: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        try { stream.cancel(); } catch { /* ignore */ }
        finish();
      }, idleTimeoutMs);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearIdle();
      resolve(messages);
    };
    stream.on("data", (item) => {
      messages.push(item);
      if (messages.length >= maxMessages) {
        try { stream.cancel(); } catch { /* ignore */ }
        finish();
        return;
      }
      armIdle();
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(error);
    });
    stream.on("end", finish);
    armIdle();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export type StreamDataHandler = (event: { streamId: string; message: unknown }) => void;
export type StreamEndHandler = (event: { streamId: string; ok: boolean; error?: string; messages: unknown[] }) => void;

interface LiveStreamSession {
  id: string;
  host: string;
  method: string;
  started: number;
  kind: "client" | "bidi";
  call: grpc.ClientWritableStream<unknown> | grpc.ClientDuplexStream<unknown, unknown>;
  messages: unknown[];
  settled: boolean;
  onData?: StreamDataHandler;
  onEnd?: StreamEndHandler;
  clientResolve?: (body: unknown) => void;
  clientReject?: (error: Error) => void;
}

const liveStreams = new Map<string, LiveStreamSession>();

function newStreamId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function endSession(session: LiveStreamSession, ok: boolean, error?: string): void {
  if (session.settled) return;
  session.settled = true;
  liveStreams.delete(session.id);
  try {
    session.call.end();
  } catch { /* ignore */ }
  try {
    session.call.cancel();
  } catch { /* ignore */ }
  if (session.kind === "client" && session.clientResolve && ok) {
    // client stream unary response already resolved via callback
  } else if (session.kind === "client" && session.clientReject && !ok) {
    session.clientReject(new Error(error || "stream closed"));
  }
  session.onEnd?.({ streamId: session.id, ok, error, messages: session.messages });
}

/** 建连后短等：主机不可达等错误常在 call 创建后异步冒泡，避免先返回假 CONNECTED */
function waitForEarlyStreamFailure(
  session: LiveStreamSession,
  ms: number,
): Promise<{ failed: boolean; error?: string }> {
  if (session.settled) {
    return Promise.resolve({ failed: true, error: "stream closed" });
  }
  return new Promise((resolve) => {
    const prev = session.onEnd;
    let done = false;
    const finish = (failed: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.onEnd = prev;
      resolve({ failed, error });
    };
    const timer = setTimeout(() => finish(false), ms);
    session.onEnd = (event) => {
      prev?.(event);
      finish(true, event.error || (!event.ok ? "stream closed" : undefined));
    };
  });
}

async function prepareGrpcCall(catalog: Catalog, req: GrpcInvokeRequest): Promise<{
  client: grpc.Client;
  method: string;
  host: string;
  md: grpc.Metadata;
  requestStream: boolean;
  responseStream: boolean;
  abs: string;
}> {
  const host = (req.host || "").trim();
  if (!host) throw new Error("未配置地址，请在顶部填写 host:port");
  const abs = resolveProto(catalog, req.file);
  if (!abs) throw new Error(`找不到 proto 文件：${req.file}`);
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
    throw new Error(`服务 ${req.package}.${req.service} 上没有方法 ${req.method}`);
  }
  if (!descriptor.requestStream) {
    throw new Error("仅客户端流 / 双向流支持保持连接");
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
  return {
    client,
    method: req.method,
    host,
    md,
    requestStream: Boolean(descriptor.requestStream),
    responseStream: Boolean(descriptor.responseStream),
    abs,
  };
}

/** 打开客户端流/双向流并保持连接，供后续 write / close */
export async function openGrpcStream(
  catalog: Catalog,
  req: GrpcInvokeRequest,
  hooks?: { onData?: StreamDataHandler; onEnd?: StreamEndHandler },
): Promise<GrpcInvokeResult & { streamId?: string }> {
  const started = Date.now();
  const methodLabel = `${req.package}.${req.service}/${req.method}`;
  const host = (req.host || "").trim();
  const base = { id: req.id, host, method: methodLabel, ms: 0 };
  try {
    const prepared = await prepareGrpcCall(catalog, req);
    const fn = (prepared.client as unknown as Record<string, Function>)[prepared.method];
    if (typeof fn !== "function") {
      return { ...base, ok: false, status: "ERROR", ms: Date.now() - started, error: `无法调用 ${prepared.method}` };
    }
    const streamId = newStreamId();
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);

    if (!prepared.responseStream) {
      // client stream → unary response
      let clientResolve: ((body: unknown) => void) | undefined;
      let clientReject: ((error: Error) => void) | undefined;
      const responsePromise = new Promise<unknown>((resolve, reject) => {
        clientResolve = resolve;
        clientReject = reject;
      });
      const call = fn.call(
        prepared.client,
        prepared.md,
        { deadline },
        (error: Error | null, response: unknown) => {
          const session = liveStreams.get(streamId);
          if (error) {
            if (session) endSession(session, false, error.message);
            clientReject?.(error);
          } else {
            if (session) {
              session.messages = [response ?? {}];
              endSession(session, true);
            }
            clientResolve?.(response ?? {});
          }
        },
      ) as grpc.ClientWritableStream<unknown>;
      const session: LiveStreamSession = {
        id: streamId,
        host: prepared.host,
        method: methodLabel,
        started,
        kind: "client",
        call,
        messages: [],
        settled: false,
        onData: hooks?.onData,
        onEnd: hooks?.onEnd,
        clientResolve,
        clientReject,
      };
      call.on("error", (error) => {
        endSession(session, false, error.message);
        clientReject?.(error);
      });
      liveStreams.set(streamId, session);
      void responsePromise;
      const early = await waitForEarlyStreamFailure(session, 300);
      if (early.failed || session.settled || !liveStreams.has(streamId)) {
        return {
          ...base,
          ok: false,
          status: "ERROR",
          ms: Date.now() - started,
          error: early.error || "建流失败",
          streamId,
          body: [],
        };
      }
      return { ...base, ok: true, status: "CONNECTED", ms: Date.now() - started, streamId, body: [] };
    }

    // bidi
    const call = fn.call(prepared.client, prepared.md, { deadline }) as grpc.ClientDuplexStream<unknown, unknown>;
    const session: LiveStreamSession = {
      id: streamId,
      host: prepared.host,
      method: methodLabel,
      started,
      kind: "bidi",
      call,
      messages: [],
      settled: false,
      onData: hooks?.onData,
      onEnd: hooks?.onEnd,
    };
    call.on("data", (item) => {
      session.messages.push(item);
      hooks?.onData?.({ streamId, message: item });
    });
    call.on("error", (error) => {
      endSession(session, false, error.message);
    });
    call.on("end", () => {
      endSession(session, true);
    });
    liveStreams.set(streamId, session);
    const early = await waitForEarlyStreamFailure(session, 300);
    if (early.failed || session.settled || !liveStreams.has(streamId)) {
      return {
        ...base,
        ok: false,
        status: "ERROR",
        ms: Date.now() - started,
        error: early.error || "建流失败",
        streamId,
        body: [],
      };
    }
    return { ...base, ok: true, status: "CONNECTED", ms: Date.now() - started, streamId, body: [] };
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

export async function writeGrpcStream(streamId: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const session = liveStreams.get(streamId);
  if (!session || session.settled) {
    return { ok: false, error: "流已断开或不存在" };
  }
  try {
    await writeOne(session.call, body ?? {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function closeGrpcStream(streamId: string): Promise<GrpcInvokeResult & { streamId?: string }> {
  const session = liveStreams.get(streamId);
  if (!session) {
    return { ok: false, status: "NOT_FOUND", ms: 0, host: "", method: "", error: "流不存在或已关闭", streamId };
  }
  const ms = Date.now() - session.started;
  const messages = [...session.messages];
  if (session.kind === "client") {
    try { session.call.end(); } catch { /* ignore */ }
    // wait briefly for unary response
    await sleep(50);
    const body = session.messages.length ? session.messages[session.messages.length - 1] : messages;
    endSession(session, true);
    return {
      id: undefined,
      ok: true,
      status: "OK",
      ms,
      host: session.host,
      method: session.method,
      body,
      streamId,
    };
  }
  try { session.call.end(); } catch { /* ignore */ }
  await sleep(30);
  endSession(session, true);
  return {
    ok: true,
    status: "OK",
    ms,
    host: session.host,
    method: session.method,
    body: messages,
    streamId,
  };
}

export function getGrpcStreamMessages(streamId: string): unknown[] {
  return liveStreams.get(streamId)?.messages ?? [];
}
