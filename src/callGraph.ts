import * as fs from "fs/promises";
import * as path from "path";

export interface CallGraphDbHit {
  table: string;
  op: "read" | "write" | "unknown";
  line: number;
}

export interface CallGraphNode {
  id: string;
  name: string;
  receiver: string;
  file: string;
  abs: string;
  line: number;
  pkg: string;
  db: CallGraphDbHit[];
  unresolved: boolean;
}
export interface CallGraph {
  rootName: string;
  rootFile: string;
  rootId: string;
  depth: number;
  nodes: CallGraphNode[];
  edges: { from: string; to: string }[];
  truncated: boolean;
  scannedFiles: number;
}

interface FuncDef {
  name: string;
  receiver: string;
  abs: string;
  rel: string;
  line: number;
  endLine: number;
  pkg: string;
  body: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "out", "dist", "vendor", "bin", "obj",
  ".vs", ".idea", "target", "__pycache__", ".next", "coverage",
  "build", ".cache", "third_party", "ThirdParty",
]);

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NODES = 600;
const KEYWORDS = new Set([
  "if", "for", "switch", "select", "return", "func", "go", "defer", "range",
  "make", "new", "append", "len", "cap", "copy", "delete", "panic", "recover",
  "print", "println", "close", "complex", "real", "imag", "string", "byte",
  "rune", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16",
  "uint32", "uint64", "float32", "float64", "bool", "error", "interface",
  "struct", "map", "chan", "else", "case", "default", "type", "var", "const",
  "package", "import", "assert", "require", "catch", "switch", "while", "foreach",
]);

const fileIndexCache = new Map<string, { at: number; defs: FuncDef[] }>();

/** 收集项目里的函数定义（带函数体，用于解析调用）。 */
async function loadFuncDefs(root: string): Promise<FuncDef[]> {
  const absRoot = path.resolve(root || "");
  if (!absRoot) return [];
  const cached = fileIndexCache.get(absRoot);
  if (cached && Date.now() - cached.at < 30_000) return cached.defs;

  const files: string[] = [];
  await walk(absRoot, files);
  const defs: FuncDef[] = [];
  for (const file of files) {
    let text = "";
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(absRoot, file).replace(/\\/g, "/");
    defs.push(...parseGoFile(text, file, rel));
  }
  fileIndexCache.set(absRoot, { at: Date.now(), defs });
  return defs;
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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".go")) out.push(full);
  }
}

function parseGoFile(text: string, abs: string, rel: string): FuncDef[] {
  const lines = text.split(/\r?\n/);
  const pkgLine = lines.find((line) => /^\s*package\s+\w+/.test(line)) || "";
  const pkg = (pkgLine.match(/^\s*package\s+(\w+)/) || [])[1] || "";
  const out: FuncDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(/);
    if (!m) continue;
    const receiverRaw = (m[1] || "").trim();
    const receiver = receiverRaw.split(/\s+/).pop() || "";
    // 找函数体结束：从声明行开始计大括号
    let depth = 0;
    let started = false;
    let endLine = i;
    for (let j = i; j < lines.length; j++) {
      const textLine = lines[j];
      for (const ch of textLine) {
        if (ch === "{") { depth += 1; started = true; }
        else if (ch === "}") depth -= 1;
      }
      if (started && depth <= 0) { endLine = j; break; }
      endLine = j;
    }
    const body = lines.slice(i, Math.min(endLine + 1, i + 800)).join("\n");
    out.push({ name: m[2], receiver, abs, rel, line: i + 1, endLine: endLine + 1, pkg, body });
    i = endLine;
  }
  return out;
}

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const READ_METHODS = /^(find|first|last|take|get|list|all|count|scan|pluck|select|load|query|exist|fetch|where)$/i;
const WRITE_METHODS = /^(create|save|update|updates|delete|remove|insert|exec|upsert|patch|incr|set|put)$/i;

function opFromMethod(method: string): CallGraphDbHit["op"] {
  if (!method) return "unknown";
  if (READ_METHODS.test(method)) return "read";
  if (WRITE_METHODS.test(method)) return "write";
  return "unknown";
}

/** 从函数体里找读写的 DB 表。 */
export function extractDbTables(func: FuncDef): CallGraphDbHit[] {
  const hits = new Map<string, CallGraphDbHit>();
  const lines = func.body.split("\n");
  const add = (table: string, op: CallGraphDbHit["op"], line: number) => {
    const finalOp = op === "unknown" ? guessOpByName(func.name) : op;
    const key = `${table}|${finalOp}`;
    if (!hits.has(key)) hits.set(key, { table, op: finalOp, line });
  };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const lineNo = func.line + i;
    // 1) gorm / 常见 ORM：.Table("xxx") / Table(xxxTable)；读写方向看同一语句链上的方法名
    const tableCall = text.match(/\.Table\(\s*(?:"([\w.]+)"|([A-Za-z_]\w*))\s*\)/);
    if (tableCall) {
      const raw = tableCall[1] || tableCall[2];
      const table = tableCall[1] ? raw : inferConstTableName(raw, func.body);
      const tail = lines.slice(i, i + 4).join(" ");
      const after = tail.slice(tail.indexOf(tableCall[0]) + tableCall[0].length);
      const method = (after.match(/\.\s*([A-Za-z_]\w*)\s*\(/) || [])[1] || "";
      add(table, opFromMethod(method), lineNo);
    }
    // 2) 原始 SQL 字面量
    const sql = text.match(/(?:SELECT\s+[\s\S]{0,120}?FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"]?([A-Za-z_][\w.]*)/i);
    if (sql) {
      const verb = sql[0].trim().split(/\s+/)[0].toUpperCase();
      add(sql[1], verb === "SELECT" ? "read" : "write", lineNo);
    }
    // 3) .Model(&User{}) —— 用结构体名推断表名
    const model = text.match(/\.Model\(\s*&?([A-Z]\w*)\s*\{/);
    if (model) {
      const after = text.slice(text.indexOf(model[0]) + model[0].length);
      const method = (after.match(/\.\s*([A-Za-z_]\w*)\s*\(/) || [])[1] || "";
      add(snakeCase(model[1]), opFromMethod(method), lineNo);
    }
  }
  return [...hits.values()];
}

function inferConstTableName(ident: string, body: string): string {
  // 尝试在同一函数体内找 tableName = "xxx"
  const re = new RegExp(`${ident}\\s*=\\s*"([\\w.]+)"`);
  const hit = body.match(re);
  return hit ? hit[1] : ident;
}

function guessOpByName(funcName: string): CallGraphDbHit["op"] {
  const name = funcName.toLowerCase();
  if (/^(get|query|find|list|select|load|fetch|search|count|exist|has|read)/.test(name)) return "read";
  if (/^(create|insert|add|update|save|delete|remove|set|put|write|incr)/.test(name)) return "write";
  return "unknown";
}

function collectCalls(body: string): string[] {
  const names = new Set<string>();
  const re = /(?:\.\s*)?([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (name.length < 3) continue;
    names.add(name);
  }
  return [...names];
}

function pickDef(name: string, from: FuncDef, index: Map<string, FuncDef[]>): FuncDef | undefined {
  const list = index.get(name);
  if (!list?.length) return undefined;
  if (list.length === 1) return list[0];
  const dir = path.dirname(from.rel);
  return (
    list.find((def) => path.dirname(def.rel) === dir && def.pkg === from.pkg)
    || list.find((def) => def.pkg === from.pkg)
    || list[0]
  );
}

export async function buildCallGraph(options: {
  root: string;
  name: string;
  file?: string;
  depth?: number;
}): Promise<CallGraph> {
  const depth = Math.max(1, Math.min(6, Math.floor(Number(options.depth) || 2)));
  const defs = await loadFuncDefs(options.root);
  const index = new Map<string, FuncDef[]>();
  for (const def of defs) {
    const list = index.get(def.name) || [];
    list.push(def);
    index.set(def.name, list);
  }
  const targetFile = String(options.file || "").replace(/\\/g, "/");
  const name = String(options.name || "").trim();

  let rootDef: FuncDef | undefined;
  // 1) 精确同名（函数名），优先同文件
  if (targetFile) {
    rootDef = defs.find((def) => def.name === name
      && (def.abs.replace(/\\/g, "/").endsWith(targetFile) || targetFile.endsWith(def.rel)));
  }
  rootDef = rootDef || index.get(name)?.[0];
  // 2) 接口名兜底：gRPC 方法名常映射为 `XxxServer.Xxx` 方法（如 ReqBaseAccountRegister）
  if (!rootDef && name) {
    rootDef = defs.find((def) => def.name === name && def.receiver)
      || defs.find((def) => def.name.toLowerCase() === name.toLowerCase());
  }
  // 3) 再兜底：proto 名去掉 Req/Resp/Rpc 前缀后按处理器名匹配
  if (!rootDef && name) {
    const bare = name.replace(/^(Req|Resp|Rpc|Handle|On)/i, "");
    rootDef = index.get(bare)?.[0] || index.get(`Handle${bare}`)?.[0] || index.get(`On${bare}`)?.[0];
  }

  if (!rootDef) {
    return {
      rootName: name,
      rootFile: targetFile,
      rootId: "",
      depth,
      nodes: [],
      edges: [],
      truncated: false,
      scannedFiles: defs.length,
    };
  }

  const nodes = new Map<string, CallGraphNode>();
  const edges: { from: string; to: string }[] = [];
  const edgeKeys = new Set<string>();
  let truncated = false;

  const idOf = (def: FuncDef) => `${def.rel}:${def.line}:${def.name}`;
  const visit = (def: FuncDef, level: number): string => {
    const id = idOf(def);
    const existing = nodes.get(id);
    if (existing) return id;
    if (nodes.size >= MAX_NODES) { truncated = true; return id; }
    nodes.set(id, {
      id,
      name: def.name,
      receiver: def.receiver,
      file: def.rel,
      abs: def.abs,
      line: def.line,
      pkg: def.pkg,
      db: extractDbTables(def),
      unresolved: false,
    });
    if (level >= depth) return id;
    for (const callName of collectCalls(def.body)) {
      const callee = pickDef(callName, def, index);
      if (!callee) continue;
      const childId = visit(callee, level + 1);
      const key = `${id}->${childId}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ from: id, to: childId });
      }
    }
    return id;
  };

  const rootId = visit(rootDef, 1);

  return {
    rootName: rootDef.name,
    rootFile: rootDef.rel,
    rootId,
    depth,
    nodes: [...nodes.values()],
    edges,
    truncated,
    scannedFiles: defs.length,
  };
}
