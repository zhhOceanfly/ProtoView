import * as fs from "fs/promises";
import * as path from "path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".vs", ".idea", "build", "coverage", "vendor"]);
const MAX_FILES = 400;
const MAX_BYTES = 2 * 1024 * 1024;

export interface SqlColumn {
  name: string;
  type: string;
  comment: string;
  primary: boolean;
}

export interface SqlTableMeta {
  id: string;
  file: string;
  fileName: string;
  relative: string;
  name: string;
  comment: string;
  columns: SqlColumn[];
  primaryKey: string[];
  /** 项目 SQL 文件里的原始 CREATE TABLE 语句 */
  definition: string;
}

export interface SqlCatalog {
  source: string;
  scannedAt: number;
  tables: SqlTableMeta[];
  warnings: string[];
}

export interface SqlSearchHit {
  id: string;
  fileName: string;
  relative: string;
  table: string;
  count: number;
  preview: string;
}

interface Cache {
  root: string;
  at: number;
  tables: SqlTableMeta[];
  warnings: string[];
}

let cache: Cache | null = null;

export async function sqlCatalog(root: string, force = false): Promise<SqlCatalog> {
  const abs = path.resolve(root || "");
  const indexed = await load(abs, force);
  return { source: abs, scannedAt: Date.now(), tables: indexed.tables, warnings: indexed.warnings };
}

export async function sqlSearch(root: string, query: string, limit = 40): Promise<SqlSearchHit[]> {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const indexed = await load(path.resolve(root || ""), false);
  const hits: { hit: SqlSearchHit; score: number }[] = [];
  for (const table of indexed.tables) {
    const blob = `${table.fileName}\n${table.relative}\n${table.name}\n${table.comment}\n${table.definition || ""}\n${table.columns.map((col) => `${col.name} ${col.type} ${col.comment}`).join("\n")}`.toLowerCase();
    if (!tokens.every((token) => blob.includes(token))) continue;
    let count = 0;
    const nameHit = tokens.every((token) => `${table.name} ${table.comment} ${table.fileName}`.toLowerCase().includes(token));
    if (nameHit) count += 1;
    for (const col of table.columns) {
      const line = `${col.name} ${col.type} ${col.comment}`.toLowerCase();
      if (tokens.some((token) => line.includes(token))) count += 1;
    }
    for (const line of (table.definition || "").split(/\n/)) {
      if (tokens.some((token) => line.toLowerCase().includes(token))) count += 1;
    }
    hits.push({
      score: nameHit ? 80 : 40,
      hit: {
        id: table.id,
        fileName: table.fileName,
        relative: table.relative,
        table: table.name,
        count: Math.max(1, count),
        preview: table.comment || table.columns.slice(0, 6).map((col) => col.name).join(" · "),
      },
    });
  }
  hits.sort((a, b) => b.score - a.score || b.hit.count - a.hit.count || a.hit.table.localeCompare(b.hit.table));
  return hits.slice(0, limit).map((item) => item.hit);
}

export function findSqlTable(tables: SqlTableMeta[], id: string): SqlTableMeta | undefined {
  return tables.find((table) => table.id === id);
}

async function load(root: string, force: boolean): Promise<Cache> {
  if (!force && cache && cache.root === root && Date.now() - cache.at < 60_000) return cache;
  const warnings: string[] = [];
  const tables: SqlTableMeta[] = [];
  if (!root) {
    cache = { root, at: Date.now(), tables, warnings: ["未配置扫描目录"] };
    return cache;
  }
  const files: string[] = [];
  await walk(root, files);
  files.sort((a, b) => a.localeCompare(b, "zh", { numeric: true, sensitivity: "base" }));
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      if (stat?.isFile()) warnings.push(`${relativeOf(root, file)} 超过 2MB，已跳过`);
      continue;
    }
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      warnings.push(`${relativeOf(root, file)} 无法读取：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const relative = relativeOf(root, file);
    for (const table of parseTables(text)) {
      tables.push({
        ...table,
        id: `${relative}\u0000${table.name}`,
        file,
        fileName: path.basename(file),
        relative,
      });
    }
  }
  cache = { root, at: Date.now(), tables, warnings };
  return cache;
}

export function parseTables(sql: string): Omit<SqlTableMeta, "id" | "file" | "fileName" | "relative">[] {
  const tables: Omit<SqlTableMeta, "id" | "file" | "fileName" | "relative">[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)[`"]?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    const body = sql.slice(open + 1, close);
    const tail = sql.slice(close + 1, close + 400);
    const columns: SqlColumn[] = [];
    const primary = new Set<string>();
    for (const raw of splitSqlList(body)) {
      const line = raw.trim();
      const pk = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(line);
      if (pk) {
        for (const name of pk[1].matchAll(/[`"]?([A-Za-z0-9_]+)[`"]?/g)) primary.add(name[1]);
        continue;
      }
      const col = /^[`"]?([A-Za-z0-9_]+)[`"]?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/.exec(line);
      if (!col) continue;
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FULLTEXT|SPATIAL)\b/i.test(col[1])) continue;
      const comment = /COMMENT\s+'([^']*)'/i.exec(line)?.[1] || /COMMENT\s+"([^"]*)"/i.exec(line)?.[1] || "";
      columns.push({ name: col[1], type: col[2].replace(/\s+/g, ""), comment: comment.trim(), primary: false });
    }
    for (const col of columns) col.primary = primary.has(col.name);
    const comment = /COMMENT\s*=\s*'([^']*)'/i.exec(tail)?.[1] || /COMMENT\s*=\s*"([^"]*)"/i.exec(tail)?.[1] || "";
    const statementEnd = sql.indexOf(";", close);
    const definition = sql.slice(match.index, statementEnd < 0 ? close + 1 : statementEnd + 1).trim();
    tables.push({
      name: match[1],
      comment: comment.replace(/\*\*.*$/, "").trim(),
      columns,
      primaryKey: [...primary],
      definition,
    });
    re.lastIndex = close + 1;
  }
  return tables;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitSqlList(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote && body[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
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
    if (!name || name.startsWith("~$") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(full, out);
      continue;
    }
    if (entry.isFile() && path.extname(name).toLowerCase() === ".sql") out.push(full);
  }
}

function relativeOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
