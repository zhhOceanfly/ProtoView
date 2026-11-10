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

interface IndexedTable extends SqlTableMeta {
  blob: string;
  nameBlob: string;
  colLines: string[];
  defLines: string[];
}

interface ParsedSql {
  mtimeMs: number;
  size: number;
  tables: IndexedTable[];
}

interface SqlRoot {
  paths: string[];
  warnings: string[];
}

const sqlFiles = new Map<string, ParsedSql>();
const sqlRoots = new Map<string, SqlRoot>();
const sqlBuild = new Map<string, { promise: Promise<void>; force: boolean }>();

export async function sqlCatalog(root: string, force = false): Promise<SqlCatalog> {
  const abs = path.resolve(root || "");
  const indexed = await load(abs, force);
  return {
    source: abs,
    scannedAt: Date.now(),
    tables: indexed.tables.map(({ blob: _blob, nameBlob: _name, colLines: _cols, defLines: _defs, ...meta }) => meta),
    warnings: indexed.warnings,
  };
}

export async function sqlSearch(root: string, query: string, limit = 40): Promise<SqlSearchHit[]> {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const indexed = await load(path.resolve(root || ""), false);
  const hits: { hit: SqlSearchHit; score: number }[] = [];
  for (const table of indexed.tables) {
    if (!tokens.every((token) => table.blob.includes(token))) continue;
    let count = 0;
    const nameHit = tokens.every((token) => table.nameBlob.includes(token));
    if (nameHit) count += 1;
    for (const line of table.colLines) {
      if (tokens.some((token) => line.includes(token))) count += 1;
    }
    for (const line of table.defLines) {
      if (tokens.some((token) => line.includes(token))) count += 1;
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

function sqlStampSame(parsed: ParsedSql, stat: { mtimeMs: number; size: number }): boolean {
  return parsed.size === stat.size && Math.abs(parsed.mtimeMs - stat.mtimeMs) < 1;
}

function indexSqlFile(root: string, file: string, text: string, stat: { mtimeMs: number; size: number }): ParsedSql {
  const relative = relativeOf(root, file);
  const fileName = path.basename(file);
  const tables = parseTables(text).map((table): IndexedTable => {
    const colLines = table.columns.map((col) => `${col.name} ${col.type} ${col.comment}`.toLowerCase());
    const defLines = (table.definition || "").split(/\n/).map((line) => line.toLowerCase()).filter((line) => line.trim());
    const nameBlob = `${table.name} ${table.comment} ${fileName}`.toLowerCase();
    const blob = `${fileName}\n${relative}\n${table.name}\n${table.comment}\n${table.definition || ""}\n${table.columns.map((col) => `${col.name} ${col.type} ${col.comment}`).join("\n")}`.toLowerCase();
    return {
      ...table,
      id: `${relative}\u0000${table.name}`,
      file,
      fileName,
      relative,
      blob,
      nameBlob,
      colLines,
      defLines,
    };
  });
  return { mtimeMs: stat.mtimeMs, size: stat.size, tables };
}

function tablesOf(root: string): IndexedTable[] {
  const index = sqlRoots.get(root);
  if (!index) return [];
  const tables: IndexedTable[] = [];
  for (const file of index.paths) {
    const parsed = sqlFiles.get(file);
    if (parsed) tables.push(...parsed.tables);
  }
  return tables;
}

async function load(root: string, force: boolean): Promise<{ tables: IndexedTable[]; warnings: string[] }> {
  const abs = path.resolve(root || "");
  if (!abs || !String(root || "").trim()) return { tables: [], warnings: ["未配置扫描目录"] };
  if (!force) {
    const hit = sqlRoots.get(abs);
    if (hit) return { tables: tablesOf(abs), warnings: hit.warnings };
    const running = sqlBuild.get(abs);
    if (running) {
      await running.promise;
      return { tables: tablesOf(abs), warnings: sqlRoots.get(abs)?.warnings ?? [] };
    }
  } else {
    const running = sqlBuild.get(abs);
    if (running?.force) {
      await running.promise;
      return { tables: tablesOf(abs), warnings: sqlRoots.get(abs)?.warnings ?? [] };
    }
  }
  const previous = sqlBuild.get(abs)?.promise;
  const promise = (async () => {
    if (previous && force) await previous.catch(() => undefined);
    await rebuildSql(abs);
  })();
  sqlBuild.set(abs, { promise, force });
  try {
    await promise;
  } finally {
    if (sqlBuild.get(abs)?.promise === promise) sqlBuild.delete(abs);
  }
  return { tables: tablesOf(abs), warnings: sqlRoots.get(abs)?.warnings ?? [] };
}

async function rebuildSql(root: string): Promise<void> {
  const warnings: string[] = [];
  const files: string[] = [];
  await walk(root, files);
  files.sort((a, b) => a.localeCompare(b, "zh", { numeric: true, sensitivity: "base" }));
  const prev = sqlRoots.get(root)?.paths ?? [];
  const paths: string[] = [];
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      warnings.push(`${relativeOf(root, file)} 超过 2MB，已跳过`);
      continue;
    }
    paths.push(file);
    const cached = sqlFiles.get(file);
    if (cached && sqlStampSame(cached, stat)) continue;
    try {
      const text = await fs.readFile(file, "utf8");
      sqlFiles.set(file, indexSqlFile(root, file, text, stat));
    } catch (error) {
      sqlFiles.delete(file);
      warnings.push(`${relativeOf(root, file)} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  sqlRoots.set(root, { paths, warnings });
  const next = new Set(paths);
  for (const old of prev) {
    if (next.has(old)) continue;
    let used = false;
    for (const index of sqlRoots.values()) {
      if (index.paths.includes(old)) {
        used = true;
        break;
      }
    }
    if (!used) sqlFiles.delete(old);
  }
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
