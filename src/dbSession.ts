import * as fs from "fs/promises";
import * as path from "path";
import mysql from "mysql2/promise";
import { findSqlTable, sqlCatalog, SqlTableMeta } from "./sqlIndex";

export interface DbEnv {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** 上次选中的库；仅作默认值，不写入 activeId */
  database: string;
}

export interface DbEnvFile {
  envs: DbEnv[];
}

const pools = new Map<string, mysql.Pool>();

export function defaultDbEnvs(): DbEnvFile {
  return {
    envs: [{
      id: "local",
      name: "local",
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "",
      database: "",
    }],
  };
}

export async function loadDbEnvs(root: string): Promise<DbEnvFile> {
  const file = envFile(root);
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DbEnvFile> & { activeId?: string };
    const envs = Array.isArray(data.envs) ? data.envs.map(normalizeEnv).filter((item) => item.id) : [];
    if (!envs.length) return defaultDbEnvs();
    return { envs };
  } catch {
    return defaultDbEnvs();
  }
}

export async function saveDbEnvs(root: string, fileData: DbEnvFile): Promise<DbEnvFile> {
  const envs = (fileData.envs || []).map(normalizeEnv).filter((item) => item.id && item.name);
  const next = envs.length ? { envs } : defaultDbEnvs();
  const dir = path.join(path.resolve(root || ""), ".protoview");
  await fs.mkdir(dir, { recursive: true });
  // 只存环境定义：不写 activeId，也不固化当前选择
  await fs.writeFile(envFile(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  resetPools();
  return next;
}

export async function dbTestConnection(root: string, options: { envId?: string; env?: Partial<DbEnv> }): Promise<Record<string, unknown>> {
  const env = options.env ? normalizeEnv(options.env) : await envById(root, options.envId);
  if (!env) return { ok: false, error: "还没有数据库环境" };
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({
      host: env.host,
      port: env.port,
      user: env.user,
      password: env.password,
      database: env.database || undefined,
      connectTimeout: 6000,
      dateStrings: true,
    });
    const [rows] = await connection.query("SELECT VERSION() AS version");
    return {
      ok: true,
      version: String((rows as { version?: string }[])[0]?.version || ""),
      message: `连接成功 ${env.user}@${env.host}:${env.port}`,
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    if (connection) await connection.end().catch(() => undefined);
  }
}

export async function dbDatabases(root: string, options: { envId?: string }): Promise<Record<string, unknown>> {
  const env = await envById(root, options.envId);
  if (!env) return { ok: false, error: "还没有数据库环境", databases: [] };
  try {
    const pool = poolOf(env);
    const [rows] = await pool.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
    );
    return { ok: true, databases: (rows as { name: string }[]).map((row) => row.name) };
  } catch (error) {
    return { ok: false, error: errorText(error), databases: [] };
  }
}

export async function dbTableDefinition(root: string, options: { envId?: string; tableId: string; database?: string }): Promise<Record<string, unknown>> {
  const table = await tableById(root, options.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  const local = String(table.definition || "");
  const env = await envById(root, options.envId, options.database);
  if (!env) return { ok: false, error: "还没有数据库环境", local, table: table.name };
  try {
    const pool = poolOf(env);
    const [rows] = await pool.query(`SHOW CREATE TABLE ${quoteIdent(table.name)}`);
    const row = (rows as Record<string, unknown>[])[0] || {};
    const ddl = String(row["Create Table"] || row["Create View"] || Object.values(row).find((value) => typeof value === "string" && /CREATE/i.test(value)) || "");
    return { ok: true, table: table.name, local, ddl, relative: table.relative };
  } catch (error) {
    // 连不上库时也把本地定义返回，界面可以只看左边
    return { ok: false, error: errorText(error), local, table: table.name, relative: table.relative };
  }
}

export async function dbTablePage(root: string, options: {
  envId?: string;
  tableId: string;
  limit?: number;
  offset?: number;
  database?: string;
}): Promise<Record<string, unknown>> {
  const table = await tableById(root, options.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  const env = await envById(root, options.envId, options.database);
  if (!env) return { ok: false, error: "还没有数据库环境" };
  const limit = clamp(options.limit ?? 50, 1, 500);
  const offset = clamp(options.offset ?? 0, 0, 10_000_000);
  try {
    const pool = poolOf(env);
    const quoted = quoteIdent(table.name);
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM ${quoted}`);
    const total = Number((countRows as { total: number }[])[0]?.total || 0);
    const [rows, fields] = await pool.query(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, offset]);
    return {
      ok: true,
      table,
      columns: (fields as mysql.FieldPacket[]).map((field) => field.name),
      rows: rows as Record<string, unknown>[],
      total,
      offset,
      limit,
    };
  } catch (error) {
    return { ok: false, error: errorText(error), table };
  }
}

export async function dbMutate(root: string, edit: {
  op: "update" | "insert" | "delete";
  envId?: string;
  tableId: string;
  pk?: Record<string, unknown>;
  column?: string;
  value?: unknown;
  values?: Record<string, unknown>;
  database?: string;
}): Promise<Record<string, unknown>> {
  const table = await tableById(root, edit.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  if (!table.primaryKey.length) return { ok: false, error: "这张表没有主键，无法直接改数据" };
  const env = await envById(root, edit.envId, edit.database);
  if (!env) return { ok: false, error: "还没有数据库环境" };
  try {
    const pool = poolOf(env);
    const quoted = quoteIdent(table.name);
    if (edit.op === "update") {
      const column = String(edit.column || "");
      if (!knownColumn(table, column)) return { ok: false, error: "列不存在" };
      const where = pkWhere(table, edit.pk || {});
      const [result] = await pool.query(
        `UPDATE ${quoted} SET ${quoteIdent(column)} = ? WHERE ${where.sql} LIMIT 1`,
        [normalizeValue(edit.value), ...where.values],
      );
      return { ok: true, affected: resultAffected(result) };
    }
    if (edit.op === "delete") {
      const where = pkWhere(table, edit.pk || {});
      const [result] = await pool.query(`DELETE FROM ${quoted} WHERE ${where.sql} LIMIT 1`, where.values);
      return { ok: true, affected: resultAffected(result) };
    }
    const values = edit.values || {};
    const cols = Object.keys(values).filter((name) => knownColumn(table, name) && String(values[name] ?? "") !== "");
    if (!cols.length) return { ok: false, error: "没有可写入的列" };
    const [result] = await pool.query(
      `INSERT INTO ${quoted} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((name) => normalizeValue(values[name])),
    );
    return { ok: true, affected: resultAffected(result) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function dbQuery(root: string, options: { envId?: string; sql: string; database?: string }): Promise<Record<string, unknown>> {
  const env = await envById(root, options.envId, options.database);
  if (!env) return { ok: false, error: "还没有数据库环境" };
  const statements = splitStatements(options.sql).slice(0, 20);
  if (!statements.length) return { ok: false, error: "SQL 是空的" };
  try {
    const pool = poolOf(env);
    const results: { sql: string; rows?: Record<string, unknown>[]; columns?: string[]; affected?: number }[] = [];
    for (const sql of statements) {
      const [rows, fields] = await pool.query(sql);
      if (Array.isArray(rows)) {
        results.push({
          sql,
          columns: (fields as mysql.FieldPacket[]).map((field) => field.name),
          rows: (rows as Record<string, unknown>[]).slice(0, 500),
        });
      } else {
        results.push({ sql, affected: resultAffected(rows) });
      }
    }
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function tableById(root: string, id: string): Promise<SqlTableMeta | undefined> {
  const catalog = await sqlCatalog(root, false);
  return findSqlTable(catalog.tables, id);
}

async function envById(root: string, id?: string, database?: string): Promise<DbEnv | undefined> {
  const file = await loadDbEnvs(root);
  const env = file.envs.find((item) => item.id === id) || file.envs[0];
  if (!env) return undefined;
  // 前端切换表时会显式带上库名，避免「先保存再查询」的回包竞态
  const db = String(database || "").trim();
  return db && db !== env.database ? { ...env, database: db } : env;
}

function poolOf(env: DbEnv): mysql.Pool {
  const key = `${env.id}\u0000${env.host}\u0000${env.port}\u0000${env.user}\u0000${env.database}\u0000${env.password}`;
  const cached = pools.get(key);
  if (cached) return cached;
  const pool = mysql.createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database || undefined,
    connectionLimit: 4,
    connectTimeout: 8000,
    multipleStatements: false,
    dateStrings: true,
  });
  pools.set(key, pool);
  return pool;
}

function resetPools(): void {
  for (const pool of pools.values()) void pool.end().catch(() => undefined);
  pools.clear();
}

function pkWhere(table: SqlTableMeta, pk: Record<string, unknown>): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = table.primaryKey.map((name) => {
    if (!(name in pk)) throw new Error(`缺少主键 ${name}`);
    values.push(normalizeValue(pk[name]));
    return `${quoteIdent(name)} = ?`;
  }).join(" AND ");
  return { sql, values };
}

function knownColumn(table: SqlTableMeta, name: string): boolean {
  return table.columns.some((col) => col.name === name) || table.primaryKey.includes(name);
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`非法标识符 ${name}`);
  return `\`${name}\``;
}

function normalizeValue(value: unknown): unknown {
  if (value == null) return null;
  const text = String(value);
  if (text === "NULL") return null;
  return text;
}

function normalizeEnv(raw: Partial<DbEnv>): DbEnv {
  const name = String(raw.name || "local").trim() || "local";
  return {
    id: String(raw.id || name).trim(),
    name,
    host: String(raw.host || "127.0.0.1").trim() || "127.0.0.1",
    port: clamp(Number(raw.port ?? 3306), 1, 65535),
    user: String(raw.user || "root"),
    password: String(raw.password || ""),
    database: String(raw.database || "").trim(),
  };
}

function envFile(root: string): string {
  return path.join(path.resolve(root || ""), ".protoview", "db-envs.json");
}

function resultAffected(result: unknown): number {
  const info = result as { affectedRows?: number };
  return Number(info?.affectedRows || 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "#") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
