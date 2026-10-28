import * as fs from "fs";
import * as path from "path";
import * as protobuf from "protobufjs";
import { Catalog } from "./catalog";

export interface DecodeBytesRequest {
  id?: string;
  typeName: string;
  /** 可选：优先从该 proto 文件加载 */
  file?: string;
  data: unknown;
}

export interface DecodeBytesResult {
  id?: string;
  ok: boolean;
  body?: unknown;
  error?: string;
  typeName?: string;
}

function toBuffer(data: unknown): Buffer {
  if (data == null) throw new Error("bytes 为空");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "object" && data !== null) {
    const obj = data as { type?: string; data?: unknown };
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
    if (Array.isArray(obj.data) && typeof obj.data[0] === "number") {
      return Buffer.from(obj.data as number[]);
    }
  }
  if (Array.isArray(data) && typeof data[0] === "number") {
    return Buffer.from(data as number[]);
  }
  if (typeof data === "string") {
    const raw = data.trim();
    if (!raw) throw new Error("bytes 为空");
    // hex
    if (/^(0x)?[0-9a-fA-F]+$/.test(raw) && raw.replace(/^0x/i, "").length % 2 === 0) {
      return Buffer.from(raw.replace(/^0x/i, ""), "hex");
    }
    // base64（grpc-js / postMessage 常见）
    const b64 = Buffer.from(raw, "base64");
    if (b64.length > 0 || raw === "") return b64;
    return Buffer.from(raw, "utf8");
  }
  throw new Error("无法识别的 bytes 格式");
}

/** 按名字找所有候选类型（同名不同包很常见），优先精确 fullName / 与 RPC 同文件 */
function findTypeMetas(
  catalog: Catalog,
  typeName: string,
  preferFile?: string,
): Array<{ fullName: string; file: string }> {
  const raw = String(typeName || "").trim();
  if (!raw) return [];
  const bare = raw.includes(".") ? raw.split(".").pop()! : raw;
  const out: Array<{ fullName: string; file: string }> = [];
  const seen = new Set<string>();
  for (const pkg of catalog.packages) {
    for (const msg of pkg.messages) {
      const exact = msg.fullName === raw;
      if (!exact && !(msg.name === raw || msg.fullName.endsWith(`.${bare}`))) continue;
      if (seen.has(msg.fullName)) continue;
      seen.add(msg.fullName);
      out.push({ fullName: msg.fullName, file: msg.file });
    }
  }
  const rank = (item: { fullName: string; file: string }) =>
    (item.fullName === raw ? 0 : 2)
    + (preferFile && path.normalize(item.file) === path.normalize(preferFile) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

function includeDirs(catalog: Catalog): string[] {
  const dirs = new Set<string>();
  for (const pkg of catalog.packages) {
    for (const item of pkg.files) dirs.add(path.dirname(item.path));
  }
  return [...dirs];
}

export async function decodeBytesMessage(
  catalog: Catalog,
  req: DecodeBytesRequest,
): Promise<DecodeBytesResult> {
  const base = { id: req.id, typeName: String(req.typeName || "").trim() };
  const metas = findTypeMetas(catalog, base.typeName || "", req.file);
  if (!metas.length) {
    return { ...base, ok: false, error: `找不到 message 类型：${base.typeName}` };
  }
  // 同名类型可能有多个：依次尝试，第一个能解出来的就用
  let lastError = "";
  for (const meta of metas) {
    const result = await decodeWithMeta(catalog, req, base, meta);
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  return { ...base, ok: false, error: lastError || `无法用 ${base.typeName} 解析` };
}

async function decodeWithMeta(
  catalog: Catalog,
  req: DecodeBytesRequest,
  base: { id?: string; typeName: string },
  meta: { fullName: string; file: string },
): Promise<DecodeBytesResult> {
  try {
    const abs = req.file && path.isAbsolute(req.file) ? req.file : meta.file;
    const dirs = includeDirs(catalog);
    const root = new protobuf.Root();
    root.resolvePath = (origin, target) => {
      if (path.isAbsolute(target)) return target;
      const bases = [origin ? path.dirname(origin) : "", path.dirname(abs), ...dirs].filter(Boolean);
      for (const dir of bases) {
        const candidate = path.normalize(path.join(dir, target));
        if (fs.existsSync(candidate)) return candidate;
      }
      return path.join(path.dirname(abs), target);
    };
    await root.load(abs, { keepCase: true });
    const Type = root.lookupType(meta.fullName);
    if (!Type) {
      return { ...base, ok: false, error: `proto 中未找到类型 ${meta.fullName}` };
    }
    const buf = toBuffer(req.data);
    const message = Type.decode(buf);
    const body = Type.toObject(message, {
      longs: String,
      enums: Number,
      bytes: String,
      defaults: false,
    });
    return { ...base, ok: true, body, typeName: meta.fullName };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: `${meta.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      typeName: meta.fullName,
    };
  }
}
