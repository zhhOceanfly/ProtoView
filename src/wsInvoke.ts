import * as http from "http";
import * as https from "https";
import { HttpInvokeRequest, HttpInvokeResult } from "./httpInvoke";

export interface WsInvokeRequest extends HttpInvokeRequest {
  /** Collect messages until this many arrive (default 20). */
  maxMessages?: number;
  /** Wait for responses ms after send (default 8000). */
  timeoutMs?: number;
}

/**
 * Lightweight WebSocket client (text frames) without extra dependencies.
 * Sends Message JSON as one text frame, then collects server text frames.
 */
export async function invokeWebSocket(req: WsInvokeRequest): Promise<HttpInvokeResult> {
  const started = Date.now();
  const hostRaw = (req.host || "").trim();
  const path = req.httpPath || "/";
  const label = `WS ${path}`;
  const base = {
    id: req.id,
    host: hostRaw,
    method: label,
    ms: 0,
  };
  if (!hostRaw) {
    return { ...base, ok: false, status: "INVALID", error: "未配置地址" };
  }

  let url: URL;
  try {
    url = buildWsUrl(hostRaw, path, Boolean(req.tls));
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "INVALID",
      ms: Date.now() - started,
      error: `地址无效：${(error as Error).message}`,
    };
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.metadata ?? {})) {
    if (name.trim()) headers[name.trim().toLowerCase()] = String(value ?? "");
  }

  const payload =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const maxMessages = Math.min(100, Math.max(1, Math.floor(req.maxMessages || 20)));
  const timeoutMs = Math.min(60000, Math.max(1000, Math.floor(req.timeoutMs || 8000)));

  try {
    const messages = await wsExchange(url, headers, payload, maxMessages, timeoutMs);
    return {
      ...base,
      ok: true,
      status: "101",
      code: 101,
      ms: Date.now() - started,
      host: url.host,
      method: `WS ${url.pathname}${url.search}`,
      body: {
        messages: messages.map(tryParse),
        count: messages.length,
      },
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "ERROR",
      ms: Date.now() - started,
      host: url.host,
      error: (error as Error).message || String(error),
    };
  }
}

function buildWsUrl(hostRaw: string, path: string, tls: boolean): URL {
  if (/^wss?:\/\//i.test(path)) return new URL(path);
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u;
  }
  if (/^wss?:\/\//i.test(hostRaw)) {
    const base = new URL(hostRaw.endsWith("/") ? hostRaw : `${hostRaw}/`);
    return new URL(path.startsWith("/") ? path : `/${path}`, base);
  }
  if (/^https?:\/\//i.test(hostRaw)) {
    const httpUrl = new URL(hostRaw);
    const ws = new URL(httpUrl.toString());
    ws.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return new URL(path.startsWith("/") ? path : `/${path}`, ws);
  }
  const origin = `${tls ? "wss" : "ws"}://${hostRaw}`;
  const base = new URL(origin.endsWith("/") ? origin : `${origin}/`);
  return new URL(path.startsWith("/") ? path : `/${path}`, base);
}

function wsExchange(
  url: URL,
  extraHeaders: Record<string, string>,
  payload: string,
  maxMessages: number,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const key = randomKey();
    const isSecure = url.protocol === "wss:";
    const lib = isSecure ? https : http;
    const port = url.port ? Number(url.port) : isSecure ? 443 : 80;
    const messages: string[] = [];
    let settled = false;
    let socket: import("net").Socket | undefined;
    let buffer = Buffer.alloc(0);

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(messages);
    };

    const timer = setTimeout(() => {
      if (messages.length) done();
      else done(new Error("WebSocket 等待响应超时"));
    }, timeoutMs);

    const req = lib.request({
      protocol: isSecure ? "https:" : "http:",
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        host: url.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...extraHeaders,
      },
      timeout: timeoutMs,
    });

    req.on("upgrade", (res, sock, head) => {
      if (res.statusCode !== 101) {
        done(new Error(`WebSocket 升级失败：HTTP ${res.statusCode}`));
        return;
      }
      socket = sock;
      if (head?.length) buffer = Buffer.concat([buffer, head]);
      sock.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const parsed = parseFrame(buffer);
          if (!parsed) break;
          buffer = Buffer.from(parsed.rest);
          if (parsed.opcode === 0x8) {
            done();
            return;
          }
          if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
            messages.push(parsed.payload.toString("utf8"));
            if (messages.length >= maxMessages) {
              try { sock.write(closeFrame()); } catch { /* ignore */ }
              done();
              return;
            }
          } else if (parsed.opcode === 0x9) {
            try { sock.write(pongFrame(parsed.payload)); } catch { /* ignore */ }
          }
        }
      });
      sock.on("error", (err) => done(err));
      sock.on("close", () => done());
      try {
        sock.write(textFrame(payload));
      } catch (err) {
        done(err as Error);
      }
    });

    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        done(new Error(`WebSocket 握手失败：HTTP ${res.statusCode}${body ? ` ${body}` : ""}`));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      done(new Error("WebSocket 连接超时"));
    });
    req.on("error", (err) => done(err));
    req.end();
  });
}

function randomKey(): string {
  return Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString("base64");
}

function textFrame(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const len = data.length;
  const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function closeFrame(): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.from([0x88, 0x80, ...mask]);
}

function pongFrame(payload: Buffer): Buffer {
  const len = payload.length;
  const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  const header = Buffer.from([0x8a, 0x80 | len]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, rest: buf.subarray(offset + maskLen + len) };
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* keep text */ }
  }
  return text;
}
