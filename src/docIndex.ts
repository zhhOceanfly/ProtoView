import * as fs from "fs/promises";
import * as path from "path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".vs", ".idea", "build", "coverage", "vendor"]);
const DOC_EXTS = new Set([".md", ".markdown", ".mdx", ".docs", ".rst", ".txt", ".adoc", ".html"]);
/** 这些格式按正文搜索；其余只匹配文件名 */
const CONTENT_EXTS = new Set([".md", ".markdown", ".mdx"]);
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);
const MAX_FILES = 1200;
const MAX_BYTES = 1024 * 1024;

export interface DocMeta {
  id: string;
  file: string;
  fileName: string;
  relative: string;
  title: string;
  ext: string;
}

export interface DocPage {
  id: string;
  file: string;
  relative: string;
  title: string;
  text: string;
  ext: string;
  editable: boolean;
}

export interface DocSearchHit {
  id: string;
  fileName: string;
  relative: string;
  title: string;
  count: number;
  line: number;
  preview: string;
}

interface Cache {
  key: string;
  at: number;
  docs: (DocMeta & { text: string })[];
  warnings: string[];
}

let cache: Cache | null = null;

function rootsOf(root: string, extra = ""): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of [root, extra]) {
    const abs = path.resolve(item || "");
    if (!item || seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }
  return roots;
}

export async function docCatalog(root: string, force = false, extra = ""): Promise<{ source: string; docs: DocMeta[]; warnings: string[] }> {
  const roots = rootsOf(root, extra);
  const indexed = await load(roots, force);
  return {
    source: roots.join(" + "),
    docs: indexed.docs.map(({ text: _text, ...meta }) => meta),
    warnings: indexed.warnings,
  };
}

export async function docPage(root: string, id: string, extra = ""): Promise<DocPage | null> {
  const indexed = await load(rootsOf(root, extra), false);
  const doc = indexed.docs.find((item) => item.id === id);
  if (!doc) return null;
  const ext = path.extname(doc.file).toLowerCase();
  return {
    id: doc.id,
    file: doc.file,
    relative: doc.relative,
    title: doc.title,
    text: doc.text,
    ext,
    editable: DOC_EXTS.has(ext),
  };
}

/** 写回文档（仅文本类格式）。 */
export async function docSave(root: string, id: string, text: string, extra = ""): Promise<{ ok: boolean; error?: string }> {
  const indexed = await load(rootsOf(root, extra), false);
  const doc = indexed.docs.find((item) => item.id === id);
  if (!doc) return { ok: false, error: "找不到该文档" };
  if (!DOC_EXTS.has(path.extname(doc.file).toLowerCase())) return { ok: false, error: "该格式不支持编辑" };
  try {
    await fs.writeFile(doc.file, String(text ?? ""), "utf8");
    doc.text = String(text ?? "");
    cache = null;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function docSearch(root: string, query: string, limit = 40, extra = ""): Promise<DocSearchHit[]> {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const indexed = await load(rootsOf(root, extra), false);
  const hits: DocSearchHit[] = [];
  for (const doc of indexed.docs) {
    const nameBlob = `${doc.title}\n${doc.fileName}\n${doc.relative}`.toLowerCase();
    const nameHit = tokens.every((token) => nameBlob.includes(token));
    const searchBody = CONTENT_EXTS.has(doc.ext);
    let count = 0;
    let line = 0;
    let preview = "";
    if (searchBody) {
      doc.text.split(/\r?\n/).forEach((raw, index) => {
        const text = raw.toLowerCase();
        if (!tokens.some((token) => text.includes(token))) return;
        if (!tokens.every((token) => text.includes(token) || nameBlob.includes(token))) return;
        count += 1;
        if (!line) {
          line = index + 1;
          preview = raw.trim().slice(0, 160);
        }
      });
    }
    if (!count && !nameHit) continue;
    hits.push({
      id: doc.id,
      fileName: doc.fileName,
      relative: doc.relative,
      title: doc.title,
      count: count || 1,
      line: line || 1,
      preview: preview || doc.fileName,
    });
  }
  hits.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "zh"));
  return hits.slice(0, limit);
}

function relativeTo(file: string, roots: string[]): string {
  let best = file.split(path.sep).join("/");
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const norm = rel.split(path.sep).join("/");
    if (best === file.split(path.sep).join("/") || norm.length < best.length) best = norm;
  }
  return best;
}

async function load(roots: string[], force: boolean): Promise<Cache> {
  const key = roots.join("|");
  if (!force && cache && cache.key === key && Date.now() - cache.at < 60_000) return cache;
  const warnings: string[] = [];
  const docs: Cache["docs"] = [];
  if (!roots.length) {
    cache = { key, at: Date.now(), docs, warnings: ["未配置扫描目录"] };
    return cache;
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) await walk(root, files, false, seen);
  files.sort((a, b) => a.localeCompare(b, "zh", { numeric: true, sensitivity: "base" }));
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    try {
      const text = await fs.readFile(file, "utf8");
      const relative = relativeTo(file, roots);
      const heading = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
      docs.push({
        id: relative,
        file,
        fileName: path.basename(file),
        relative,
        title: heading || path.basename(file, path.extname(file)),
        ext: path.extname(file).toLowerCase(),
        text,
      });
    } catch (error) {
      warnings.push(`${relativeTo(file, roots)} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cache = { key, at: Date.now(), docs, warnings };
  return cache;
}

function rankEntry(entry: { name: string; isDirectory: () => boolean }): number {
  if (entry.isDirectory() && DOC_DIRS.has(entry.name.toLowerCase())) return 0;
  if (entry.isDirectory()) return 1;
  return 2;
}

async function walk(dir: string, out: string[], inDocs: boolean, seen: Set<string>): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => rankEntry(a) - rankEntry(b) || a.name.localeCompare(b.name, "zh"));
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const name = entry.name;
    if (!name || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(full, out, inDocs || DOC_DIRS.has(name.toLowerCase()), seen);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    const markdown = CONTENT_EXTS.has(ext) || ext === ".docs" || ext === ".rst";
    const insideDocs = inDocs && DOC_EXTS.has(ext);
    if (!markdown && !insideDocs) continue;
    const abs = path.resolve(full);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
}
