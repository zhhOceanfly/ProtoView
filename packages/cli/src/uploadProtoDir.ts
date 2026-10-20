import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface UploadedProtoFile {
  path: string;
  content: string;
}

/** 将浏览器选中的 .proto 树落到系统临时目录，返回绝对路径。 */
export async function materializeProtoUpload(options: {
  name?: string;
  files?: UploadedProtoFile[];
}): Promise<{ dir: string; count: number; label: string }> {
  const files = Array.isArray(options.files) ? options.files : [];
  const label = String(options.name || "proto").trim() || "proto";
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "protoview-dir-"));
  let count = 0;
  for (const file of files) {
    const relRaw = String(file?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relRaw || relRaw.includes("\0")) continue;
    const rel = path.normalize(relRaw);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!rel.replace(/\\/g, "/").toLowerCase().endsWith(".proto")) continue;
    const dest = path.resolve(root, rel);
    if (!dest.startsWith(path.resolve(root) + path.sep) && dest !== path.resolve(root)) continue;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, String(file.content ?? ""), "utf8");
    count += 1;
  }
  return { dir: root, count, label };
}

/** 将浏览器选中的 ghz 可执行文件落到临时目录。 */
export async function materializeGhzUpload(options: {
  name?: string;
  base64?: string;
}): Promise<string | undefined> {
  const name = path.basename(String(options.name || "ghz").trim() || "ghz");
  const b64 = String(options.base64 || "");
  if (!b64) return undefined;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "protoview-ghz-"));
  const dest = path.join(dir, name);
  await fs.promises.writeFile(dest, Buffer.from(b64, "base64"));
  if (process.platform !== "win32") {
    await fs.promises.chmod(dest, 0o755);
  }
  return dest;
}
