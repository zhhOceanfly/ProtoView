/**
 * MySQL CREATE TABLE 解析与「以 SQL 文件为准」的结构差异 SQL 生成。
 * 只做结构对比（列 / 主键 / 索引 / 表注释），不碰数据。
 */

export interface SchemaColumn {
  name: string;
  /** 完整列定义（用于 ADD / MODIFY COLUMN），来自文件或库 */
  raw: string;
  type: string;
  nullable: boolean;
  autoIncrement: boolean;
  defaultValue: string;
  comment: string;
}

export interface SchemaIndex {
  name: string;
  raw: string;
  kind: string;
}

export interface ParsedTable {
  name: string;
  columns: Map<string, SchemaColumn>;
  indexes: Map<string, SchemaIndex>;
  primary: string[];
  comment: string;
}

export interface TableDiff {
  table: string;
  /** same = 一致；diff = 结构不同；missingInDb = 库里没有；missingInFile = 库里有、文件里没有 */
  status: "same" | "diff" | "missingInDb" | "missingInFile";
  statements: string[];
  changes: string[];
  local: string;
  remote: string;
  error?: string;
}

const quote = (name: string): string => `\`${String(name).replace(/`/g, "``")}\``;

function stripQuotes(text: string): string {
  return String(text || "").replace(/^[`"']|[`"']$/g, "");
}

/** 找到 CREATE TABLE 后的括号体（支持嵌套括号与引号） */
function tableBody(ddl: string): string {
  const open = ddl.indexOf("(");
  if (open < 0) return "";
  let depth = 0;
  let quoteChar = "";
  for (let i = open; i < ddl.length; i += 1) {
    const ch = ddl[i];
    if (quoteChar) {
      if (ch === quoteChar && ddl[i - 1] !== "\\") quoteChar = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quoteChar = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return ddl.slice(open + 1, i);
    }
  }
  return "";
}

/** 顶层逗号切分 */
function splitDefs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoteChar = "";
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoteChar) {
      if (ch === quoteChar && body[i - 1] !== "\\") quoteChar = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quoteChar = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim()) out.push(tail);
  return out.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function parseColumn(line: string): SchemaColumn | null {
  const nameMatch = /^[`"]?([A-Za-z0-9_$]+)[`"]?\s+([\s\S]+)$/.exec(line);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const rest = nameMatch[2].trim();
  const typeMatch = /^([A-Za-z]+)(\s*\([^)]*\))?(\s+unsigned)?/i.exec(rest);
  const type = typeMatch ? `${typeMatch[1]}${typeMatch[2] || ""}${typeMatch[3] || ""}`.replace(/\s+/g, "").toLowerCase() : "";
  const comment = /COMMENT\s+'((?:[^'\\]|\\.)*)'/i.exec(rest)?.[1] || /COMMENT\s+"((?:[^"\\]|\\.)*)"/i.exec(rest)?.[1] || "";
  const defaultMatch = /\bDEFAULT\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+)/i.exec(rest);
  const nullable = !/\bNOT\s+NULL\b/i.test(rest);
  const autoIncrement = /\bAUTO_INCREMENT\b/i.test(rest);
  const defaultValue = normalizeDefault(defaultMatch?.[1] || "");
  return { name, raw: `${quote(name)} ${rest}`, type, nullable, autoIncrement, defaultValue, comment: comment.trim() };
}

/**
 * 归一化默认值：MySQL 对数值列返回 DEFAULT '0'、文件里常写 DEFAULT 0，
 * 引号只是写法差异，这里统一去掉并转小写；CURRENT_TIMESTAMP 之类保留。
 */
function normalizeDefault(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const unquoted = text.replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");
  const lower = unquoted.toLowerCase();
  if (lower === "null") return "null";
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return String(Number(unquoted));
  if (/^current_timestamp(\(\d*\))?$/i.test(lower)) return "current_timestamp";
  return lower;
}

/** 解析一段 CREATE TABLE（文件或 SHOW CREATE TABLE 的输出） */
export function parseCreateTable(ddl: string): ParsedTable | null {
  const text = String(ddl || "");
  const nameMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_$.]+)[`"]?/i.exec(text);
  if (!nameMatch) return null;
  const name = stripQuotes(nameMatch[1].split(".").pop() || "");
  const body = tableBody(text);
  const columns = new Map<string, SchemaColumn>();
  const indexes = new Map<string, SchemaIndex>();
  let primary: string[] = [];
  for (const def of splitDefs(body)) {
    const head = def.trim();
    const keyName = /^(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+[`"]?([A-Za-z0-9_$]+)[`"]?/.exec(head);
    const constraint = /^CONSTRAINT\s+[`"]?([A-Za-z0-9_$]+)[`"]?/.exec(head);
    if (/^PRIMARY\s+KEY/i.test(head)) {
      primary = [...head.matchAll(/[`"]?([A-Za-z0-9_$]+)[`"]?/g)]
        .map((m) => m[1])
        .filter((value, index) => index > 0 && !/^(KEY|PRIMARY)$/i.test(value));
      continue;
    }
    if (keyName) {
      const kind = /^UNIQUE/i.test(head) ? "unique" : /^FULLTEXT/i.test(head) ? "fulltext" : "key";
      indexes.set(keyName[1], { name: keyName[1], raw: head, kind });
      continue;
    }
    if (constraint || /^(KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(head)) {
      continue;
    }
    const column = parseColumn(head);
    if (column) columns.set(column.name, column);
  }
  const tail = text.slice(text.indexOf(body) + body.length);
  const comment = /COMMENT\s*=\s*'((?:[^'\\]|\\.)*)'/i.exec(tail)?.[1] || "";
  return { name, columns, indexes, primary, comment: comment.trim() };
}

/** 列签名：类型 / 可空 / 自增 / 默认值 / 注释一致才算没变 */
function columnSignature(column: SchemaColumn): string {
  // 类型按原样比较：int(11) 与 int 视为不同
  return [column.type, column.nullable ? "null" : "notnull", column.autoIncrement ? "ai" : "", column.defaultValue, column.comment].join("|");
}

function indexSignature(index: SchemaIndex): string {
  return index.raw.toLowerCase().replace(/[`"\s]/g, "");
}

export interface TableDiffResult {
  statements: string[];
  changes: string[];
}

/** 以文件定义为准，生成把库表改成文件结构的 ALTER 语句 */
export function diffTableSchema(file: ParsedTable, remote: ParsedTable | null): TableDiffResult {
  const statements: string[] = [];
  const changes: string[] = [];
  const table = quote(file.name);
  if (!remote) {
    statements.push(`-- 库里没有这张表，直接建表`);
    return { statements, changes: ["表不存在"] };
  }
  const addColumns: string[] = [];
  const modifyColumns: string[] = [];
  for (const [name, column] of file.columns) {
    const current = remote.columns.get(name);
    if (!current) {
      addColumns.push(`ADD COLUMN ${column.raw}`);
      changes.push(`新增列 ${name}`);
      continue;
    }
    if (columnSignature(column) !== columnSignature(current)) {
      modifyColumns.push(`MODIFY COLUMN ${column.raw}`);
      changes.push(`修改列 ${name}`);
    }
  }
  const dropColumns: string[] = [];
  for (const name of remote.columns.keys()) {
    if (!file.columns.has(name)) {
      dropColumns.push(`DROP COLUMN ${quote(name)}`);
      changes.push(`删除列 ${name}（文件里没有）`);
    }
  }
  const clauses = [...addColumns, ...modifyColumns, ...dropColumns];

  const filePk = file.primary.join(",").toLowerCase();
  const remotePk = remote.primary.join(",").toLowerCase();
  if (filePk !== remotePk) {
    if (remote.primary.length) clauses.push("DROP PRIMARY KEY");
    if (file.primary.length) clauses.push(`ADD PRIMARY KEY (${file.primary.map(quote).join(", ")})`);
    changes.push(`主键 ${remotePk || "无"} → ${filePk || "无"}`);
  }

  for (const [name, index] of file.indexes) {
    const current = remote.indexes.get(name);
    if (current && indexSignature(current) === indexSignature(index)) continue;
    if (current) clauses.push(`DROP INDEX ${quote(name)}`);
    clauses.push(`ADD ${index.raw}`);
    changes.push(`${current ? "修改" : "新增"}索引 ${name}`);
  }
  for (const name of remote.indexes.keys()) {
    if (file.indexes.has(name)) continue;
    clauses.push(`DROP INDEX ${quote(name)}`);
    changes.push(`删除索引 ${name}（文件里没有）`);
  }

  if (clauses.length) statements.push(`ALTER TABLE ${table}\n  ${clauses.join(",\n  ")};`);
  if ((file.comment || "") !== (remote.comment || "")) {
    statements.push(`ALTER TABLE ${table} COMMENT = ${file.comment ? `'${file.comment.replace(/'/g, "''")}'` : "''"};`);
    changes.push("表注释不同");
  }
  return { statements, changes };
}

/** 初始化库名：模板里的 {file} / {table} / {dir} 占位符；文件名统一转小写蛇形 */
export function databaseNameFor(template: string, context: { file: string; table?: string; dir?: string }): string {
  const stem = String(context.file || "").replace(/\.[^.]+$/, "");
  const file = snakeCaseName(stem);
  const table = snakeCaseName(String(context.table || "")) || file;
  const dir = snakeCaseName(String(context.dir || ""));
  const raw = String(template || "").replace(/\{(file|table|dir)\}/gi, (_, token) => {
    const key = String(token).toLowerCase();
    if (key === "file") return file;
    if (key === "table") return table;
    return dir;
  });
  // MySQL 库名允许字母数字下划线美元与横线（标识符统一用反引号包住），其余替换成下划线
  return raw.replace(/[^A-Za-z0-9_$-]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

/** GamePlayerStorage → game_player_storage */
function snakeCaseName(name: string): string {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}
