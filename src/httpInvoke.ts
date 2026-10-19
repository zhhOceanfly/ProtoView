import * as http from "http";
import * as https from "https";

export interface HttpInvokeRequest {
  id?: string;
  host: string;
  httpMethod?: string;
  httpPath?: string;
  body?: unknown;
  metadata?: Record<string, string>;
  tls?: boolean;
  package?: string;
  service?: string;
  method?: string;
}

export interface HttpInvokeResult {
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

export async function invokeHttp(req: HttpInvokeRequest): Promise<HttpInvokeResult> {
  const started = Date.now();
  const verb = (req.httpMethod || "POST").toUpperCase();
  const label = `${verb} ${req.httpPath || "/"}`;
  const hostRaw = (req.host || "").trim();
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
    return { ...base, ok: false, status: "INVALID", ms: Date.now() - started, error: `地址无效：${(error as Error).message}` };
  }

  const noBody = verb === "GET" || verb === "HEAD" || verb === "DELETE";
  if (noBody && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  const payload = noBody ? "" : JSON.stringify(req.body ?? {});
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
  };
  if (!noBody) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  for (const [name, value] of Object.entries(req.metadata ?? {})) {
    if (name.trim()) headers[name.trim().toLowerCase()] = String(value ?? "");
  }

  try {
    const response = await requestOnce(url, verb, headers, payload);
    const parsed = parseBody(response.text, response.contentType);
    const ok = response.status >= 200 && response.status < 300;
    return {
      ...base,
      ok,
      status: String(response.status),
      code: response.status,
      ms: Date.now() - started,
      host: url.host,
      method: `${verb} ${url.pathname}${url.search}`,
      body: parsed,
      error: ok ? undefined : `HTTP ${response.status}`,
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

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  payload: string,
): Promise<{ status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method, headers, timeout: 15000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] || ""),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseBody(text: string, contentType: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* keep text */ }
  }
  return text;
}
