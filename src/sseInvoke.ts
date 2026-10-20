import * as http from "http";
import * as https from "https";
import { HttpInvokeRequest, HttpInvokeResult } from "./httpInvoke";

export interface SseInvokeRequest extends HttpInvokeRequest {
  /** Collect events until this many arrive (default 50). */
  maxEvents?: number;
  /** Overall read timeout ms (default 15000). */
  timeoutMs?: number;
}

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export async function invokeSse(req: SseInvokeRequest): Promise<HttpInvokeResult> {
  const started = Date.now();
  const verb = (req.httpMethod || "GET").toUpperCase();
  const hostRaw = (req.host || "").trim();
  const label = `SSE ${verb} ${req.httpPath || "/"}`;
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
    url = buildUrl(hostRaw, req.httpPath || "/", Boolean(req.tls));
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "INVALID",
      ms: Date.now() - started,
      error: `地址无效：${(error as Error).message}`,
    };
  }

  const noBody = verb === "GET" || verb === "HEAD";
  if (noBody && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  const payload = noBody ? "" : JSON.stringify(req.body ?? {});
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "cache-control": "no-cache",
  };
  if (!noBody) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  for (const [name, value] of Object.entries(req.metadata ?? {})) {
    if (name.trim()) headers[name.trim().toLowerCase()] = String(value ?? "");
  }

  const maxEvents = Math.min(200, Math.max(1, Math.floor(req.maxEvents || 50)));
  const timeoutMs = Math.min(60000, Math.max(1000, Math.floor(req.timeoutMs || 15000)));

  try {
    const { status, events, raw } = await readSse(url, verb, headers, payload, maxEvents, timeoutMs);
    const ok = status >= 200 && status < 300;
    return {
      ...base,
      ok,
      status: String(status),
      code: status,
      ms: Date.now() - started,
      host: url.host,
      method: `SSE ${verb} ${url.pathname}${url.search}`,
      body: {
        events: events.map((ev) => ({
          event: ev.event || "message",
          id: ev.id,
          data: tryParse(ev.data),
        })),
        count: events.length,
        raw: raw.slice(0, 4000),
      },
      error: ok ? undefined : `HTTP ${status}`,
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

function buildUrl(hostRaw: string, path: string, tls: boolean): URL {
  if (/^https?:\/\//i.test(path)) return new URL(path);
  const origin = /^https?:\/\//i.test(hostRaw)
    ? hostRaw
    : `${tls ? "https" : "http"}://${hostRaw}`;
  const base = new URL(origin.endsWith("/") ? origin : `${origin}/`);
  const rel = path.startsWith("/") ? path : `/${path}`;
  return new URL(rel, base);
}

function readSse(
  url: URL,
  method: string,
  headers: Record<string, string>,
  payload: string,
  maxEvents: number,
  timeoutMs: number,
): Promise<{ status: number; events: SseEvent[]; raw: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const events: SseEvent[] = [];
    let raw = "";
    let buffer = "";
    let settled = false;
    let current: SseEvent = { data: "" };

    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      flushEvent();
      resolve({ status, events, raw });
    };

    const req = lib.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      const ctype = String(res.headers["content-type"] || "");
      if (status >= 400) {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          raw = Buffer.concat(chunks).toString("utf8");
          finish(status);
        });
        return;
      }
      if (ctype && !ctype.includes("text/event-stream") && !ctype.includes("text/plain")) {
        // still try to parse as SSE if server mislabels
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            flushEvent();
            if (events.length >= maxEvents) {
              req.destroy();
              finish(status);
              return;
            }
            continue;
          }
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") {
            current.data = current.data ? `${current.data}\n${value}` : value;
          } else if (field === "event") {
            current.event = value;
          } else if (field === "id") {
            current.id = value;
          }
        }
      });
      res.on("end", () => finish(status));
      res.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      if (!settled) finish(200);
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();

    function flushEvent() {
      if (!current.data && !current.event && !current.id) {
        current = { data: "" };
        return;
      }
      events.push(current);
      current = { data: "" };
    }
  });
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* keep text */ }
  }
  return text;
}
