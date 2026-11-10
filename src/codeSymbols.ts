import * as fs from "fs/promises";
import * as path from "path";

export type CodeSymbolKind = "func" | "const";

export interface CodeSymbol {
  kind: CodeSymbolKind;
  title: string;
  /** 相对路径或包提示 */
  sub: string;
  file: string;
  line: number;
  hay: string;
}

const CODE_EXTS = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".cs", ".java", ".kt", ".rs", ".py",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "out", "dist", "vendor", "bin", "obj",
  ".vs", ".idea", "target", "__pycache__", ".next", "coverage",
  "build", ".cache", "third_party", "ThirdParty",
]);

const MAX_FILES = 800;
const MAX_SYMBOLS = 4000;
const MAX_FILE_BYTES = 512 * 1024;

interface SymbolFile {
  mtimeMs: number;
  size: number;
  symbols: CodeSymbol[];
}

const symbolFiles = new Map<string, SymbolFile>();
const symbolRoots = new Map<string, string[]>();
const symbolBuild = new Map<string, { promise: Promise<void>; force: boolean }>();

export async function collectCodeSymbols(root: string, force = false): Promise<CodeSymbol[]> {
  const absRoot = path.resolve(root || "");
  if (!String(root || "").trim()) return [];
  if (!force) {
    if (symbolRoots.has(absRoot)) return finishSymbols(absRoot);
    const running = symbolBuild.get(absRoot);
    if (running) {
      await running.promise;
      return finishSymbols(absRoot);
    }
  } else {
    const running = symbolBuild.get(absRoot);
    if (running?.force) {
      await running.promise;
      return finishSymbols(absRoot);
    }
  }
  const previous = symbolBuild.get(absRoot)?.promise;
  const promise = (async () => {
    if (previous && force) await previous.catch(() => undefined);
    await rebuildSymbols(absRoot);
  })();
  symbolBuild.set(absRoot, { promise, force });
  try {
    await promise;
  } finally {
    if (symbolBuild.get(absRoot)?.promise === promise) symbolBuild.delete(absRoot);
  }
  return finishSymbols(absRoot);
}

function finishSymbols(root: string): CodeSymbol[] {
  const paths = symbolRoots.get(root) ?? [];
  const items: CodeSymbol[] = [];
  for (const file of paths) {
    const parsed = symbolFiles.get(file);
    if (!parsed) continue;
    for (const item of parsed.symbols) {
      items.push(item);
      if (items.length >= MAX_SYMBOLS) break;
    }
    if (items.length >= MAX_SYMBOLS) break;
  }
  items.sort((a, b) => a.title.localeCompare(b.title) || a.sub.localeCompare(b.sub));
  return items.slice(0, MAX_SYMBOLS);
}

async function rebuildSymbols(root: string): Promise<void> {
  const files: string[] = [];
  await walk(root, files);
  const prev = symbolRoots.get(root) ?? [];
  const paths: string[] = [];
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
    paths.push(file);
    const cached = symbolFiles.get(file);
    if (cached && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1) continue;
    try {
      const text = await fs.readFile(file, "utf8");
      const rel = path.relative(root, file).replace(/\\/g, "/");
      const ext = path.extname(file).toLowerCase();
      const symbols: CodeSymbol[] = [];
      extractFromText(text, ext, file, rel, symbols);
      symbolFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, symbols });
    } catch {
      symbolFiles.delete(file);
    }
  }
  symbolRoots.set(root, paths);
  const next = new Set(paths);
  for (const old of prev) {
    if (next.has(old)) continue;
    let used = false;
    for (const list of symbolRoots.values()) {
      if (list.includes(old)) {
        used = true;
        break;
      }
    }
    if (!used) symbolFiles.delete(old);
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const name = entry.name;
    if (name.startsWith(".") && name !== ".go") {
      // keep scanning normal dirs; skip hidden except we already skip .git via SKIP_DIRS
    }
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      await walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (CODE_EXTS.has(ext)) out.push(full);
  }
}

function extractFromText(
  text: string,
  ext: string,
  file: string,
  rel: string,
  out: CodeSymbol[],
): void {
  const lines = text.split(/\r?\n/);
  if (ext === ".go") {
    extractGo(lines, file, rel, out);
    return;
  }
  if (ext === ".py") {
    extractPython(lines, file, rel, out);
    return;
  }
  if (ext === ".rs") {
    extractRust(lines, file, rel, out);
    return;
  }
  if (ext === ".cs" || ext === ".java" || ext === ".kt") {
    extractCLike(lines, file, rel, out);
    return;
  }
  extractJsTs(lines, file, rel, out);
}

function push(
  out: CodeSymbol[],
  kind: CodeSymbolKind,
  title: string,
  file: string,
  rel: string,
  line: number,
): void {
  if (!title || out.length >= MAX_SYMBOLS) return;
  if (kind === "func" && isNoiseFunc(title)) return;
  out.push({
    kind,
    title,
    sub: rel,
    file,
    line,
    hay: `${title} ${rel}`.toLowerCase(),
  });
}

function isNoiseFunc(name: string): boolean {
  return name === "init" || name === "main" || name.startsWith("_");
}

function extractGo(lines: string[], file: string, rel: string, out: CodeSymbol[]): void {
  let inConst = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const func = line.match(/^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/);
    if (func) {
      push(out, "func", func[1], file, rel, i + 1);
      continue;
    }
    if (/^const\s*\(/.test(line)) {
      inConst = true;
      continue;
    }
    if (inConst) {
      if (/^\)/.test(line)) {
        inConst = false;
        continue;
      }
      const c = line.match(/^\s*([A-Za-z_]\w*)\s*=/);
      if (c) push(out, "const", c[1], file, rel, i + 1);
      continue;
    }
    const single = line.match(/^const\s+([A-Za-z_]\w*)\s+/);
    if (single) push(out, "const", single[1], file, rel, i + 1);
  }
}

function extractJsTs(lines: string[], file: string, rel: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fn = line.match(
      /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (fn) {
      push(out, "func", fn[1], file, rel, i + 1);
      continue;
    }
    const arrow = line.match(
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    );
    if (arrow) {
      push(out, "func", arrow[1], file, rel, i + 1);
      continue;
    }
    const c = line.match(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{1,})\s*=/);
    if (c) push(out, "const", c[1], file, rel, i + 1);
  }
}

function extractPython(lines: string[], file: string, rel: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fn = line.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) {
      push(out, "func", fn[1], file, rel, i + 1);
      continue;
    }
    const c = line.match(/^([A-Z][A-Z0-9_]{1,})\s*=/);
    if (c) push(out, "const", c[1], file, rel, i + 1);
  }
}

function extractRust(lines: string[], file: string, rel: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fn = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/);
    if (fn) {
      push(out, "func", fn[1], file, rel, i + 1);
      continue;
    }
    const c = line.match(/^(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)\s*:/);
    if (c) push(out, "const", c[1], file, rel, i + 1);
  }
}

function extractCLike(lines: string[], file: string, rel: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const c = line.match(
      /^\s*(?:public|private|protected|internal|static|\s)*(?:const|readonly)\s+\S+\s+([A-Za-z_]\w*)\s*=/,
    );
    if (c) {
      push(out, "const", c[1], file, rel, i + 1);
      continue;
    }
    const fn = line.match(
      /^\s*(?:public|private|protected|internal|static|async|override|virtual|sealed|\s)+[\w.<>,\[\]?]+\s+([A-Za-z_]\w*)\s*\(/,
    );
    if (fn && !/^(if|for|while|switch|catch|using|lock|return)$/.test(fn[1])) {
      push(out, "func", fn[1], file, rel, i + 1);
    }
  }
}
