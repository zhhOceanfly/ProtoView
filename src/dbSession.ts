import * as fs from "fs/promises";
import * as path from "path";
import mysql from "mysql2/promise";
import { findSqlTable, sqlCatalog, SqlTableMeta } from "./sqlIndex";
import { databaseNameFor, diffTableSchema, parseCreateTable, ParsedTable } from "./dbSchema";

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
    // 兼容旧文件里的 database 字段：读出来也丢掉，库选择只留在本地
    const envs = Array.isArray(data.envs)
      ? data.envs.map((item) => ({ ...normalizeEnv(item), database: "" })).filter((item) => item.id)
      : [];
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
  // 只存环境定义：activeId、当前选的库都不落盘，避免每次切表都弄脏 db-envs.json
  const serialized = {
    envs: next.envs.map((env) => {
      const { database: _database, ...rest } = env;
      return rest;
    }),
  };
  await fs.writeFile(envFile(root), `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
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

export async function dbTableDefinition(root: string, options: { envId?: string; tableId: string; database?: string; hostOverride?: HostOverride | null }): Promise<Record<string, unknown>> {
  const table = await tableById(root, options.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  const local = String(table.definition || "");
  const env = await envById(root, options.envId, options.database, options.hostOverride);
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
  hostOverride?: HostOverride | null;
}): Promise<Record<string, unknown>> {
  const table = await tableById(root, options.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  const env = await envById(root, options.envId, options.database, options.hostOverride);
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
  hostOverride?: HostOverride | null;
}): Promise<Record<string, unknown>> {
  const table = await tableById(root, edit.tableId);
  if (!table) return { ok: false, error: "找不到这张表" };
  if (!table.primaryKey.length) return { ok: false, error: "这张表没有主键，无法直接改数据" };
  const env = await envById(root, edit.envId, edit.database, edit.hostOverride);
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

export async function dbQuery(root: string, options: { envId?: string; sql: string; database?: string; hostOverride?: HostOverride | null }): Promise<Record<string, unknown>> {
  const env = await envById(root, options.envId, options.database, options.hostOverride);
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

export interface HostOverride {
  host?: string;
  port?: number;
}

async function envById(root: string, id?: string, database?: string, hostOverride?: HostOverride | null): Promise<DbEnv | undefined> {
  const file = await loadDbEnvs(root);
  const env = file.envs.find((item) => item.id === id) || file.envs[0];
  const host = String(hostOverride?.host || "").trim();
  if (!env) {
    if (!host) return undefined;
    // 没有环境时用临时环境连接（默认 root / 空密码），方便手填地址连库
    return {
      id: "manual",
      name: "manual",
      host,
      port: clamp(Number(hostOverride?.port || 3306), 1, 65535),
      user: "root",
      password: "",
      database: String(database || "").trim(),
    };
  }
  // 前端切换表时会显式带上库名，避免「先保存再查询」的回包竞态；手填地址优先
  const db = String(database || "").trim();
  const port = Number(hostOverride?.port || 0);
  if ((db && db !== env.database) || (host && host !== env.host) || (port && port !== env.port)) {
    return {
      ...env,
      ...(host ? { host } : {}),
      ...(port ? { port } : {}),
      ...(db ? { database: db } : {}),
    };
  }
  return env;
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

// ===== 结构对比 / 初始化库 =====

async function rootPool(root: string, envId?: string): Promise<{ pool: mysql.Pool; env: DbEnv; db?: string } | { error: string }> {
  const env = await envById(root, envId);
  if (!env) return { error: "还没有数据库环境" };
  const pool = mysql.createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    connectionLimit: 3,
    connectTimeout: 8000,
    multipleStatements: true,
    dateStrings: true,
  });
  return { pool, env };
}

async function withRootConnection<T>(
  root: string,
  envId: string | undefined,
  run: (conn: mysql.PoolConnection, env: DbEnv) => Promise<T>,
): Promise<T | { error: string }> {
  const entry = await rootPool(root, envId);
  if ("error" in entry) return entry;
  const conn = await entry.pool.getConnection().catch((error: unknown) => {
    void entry.pool.end().catch(() => undefined);
    throw error;
  });
  try {
    return await run(conn, entry.env);
  } finally {
    conn.release();
    void entry.pool.end().catch(() => undefined);
  }
}

export interface DbTargetTable {
  table: string;
  /** 期望的库名：初始化与差异都会用它 */
  database: string;
  fileName: string;
  relative: string;
  definition: string;
}

/** 按模板算出每张表应该落在哪个库（同文件多表共用一个库） */
export async function dbPlanSchema(
  root: string,
  options: { template?: string; tables?: { fileName: string; relative: string; table?: string }[] },
): Promise<Record<string, unknown>> {
  const catalog = await sqlCatalog(root, false);
  const template = String(options.template || "mountain-{file}") || "mountain-{file}";
  const wanted = options.tables?.length
    ? options.tables.map((item) => ({ fileName: String(item.fileName || ""), relative: String(item.relative || ""), table: item.table }))
    : catalog.tables.map((table) => ({ fileName: table.fileName, relative: table.relative, table: table.name }));
  const picked = new Set(wanted.map((item) => `${item.relative}\u0000${item.fileName}`));
  const plan: DbTargetTable[] = [];
  for (const table of catalog.tables) {
    const key = `${table.relative}\u0000${table.fileName}`;
    if (!picked.has(key)) continue;
    const database = databaseNameFor(template, {
      file: table.fileName,
      table: table.name,
      dir: table.relative.includes("/") ? table.relative.slice(0, table.relative.lastIndexOf("/")) : "",
    });
    if (!database) continue;
    plan.push({
      table: table.name,
      database,
      fileName: table.fileName,
      relative: table.relative,
      definition: table.definition,
    });
  }
  return { ok: true, template, plan };
}

/** 给建表语句补上库名，避免在没有 USE 的会话里建到别的库 */
function qualifyCreateTable(definition: string, database: string): string {
  const text = String(definition || "").trim();
  if (!text) return "";
  const db = quoteIdent(database);
  // CREATE TABLE `name` / CREATE TABLE IF NOT EXISTS name → 加上 `db`.
  return text.replace(
    /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|([A-Za-z0-9_$]+))/i,
    (match, ifNotExists: string | undefined, ticked: string, quoted: string, bare: string) => {
      const name = ticked || quoted || bare || "";
      const prefix = `CREATE TABLE ${ifNotExists || ""}`;
      // 已经有库名前缀就不重复加
      if (new RegExp(`${quoteIdent(name)}\\.`).test(text)) return match;
      return `${prefix}${db}.${quoteIdent(name)}`;
    },
  );
}
/** 初始化数据库：按模板建库，再从 SQL 文件建表（已存在的表跳过） */
export async function dbInitDatabases(
  root: string,
  options: { envId?: string; template?: string; tables?: { fileName: string; relative: string }[]; createTables?: boolean },
): Promise<Record<string, unknown>> {
  const planResult = await dbPlanSchema(root, options);
  if (!planResult.ok) return planResult;
  const plan = planResult.plan as DbTargetTable[];
  if (!plan.length) return { ok: false, error: "没有可初始化的 SQL 文件" };
  const createTables = options.createTables !== false;
  const log: { database: string; ok: boolean; created: boolean; tables: number; error?: string }[] = [];
  try {
    const result = await withRootConnection(root, options.envId, async (conn) => {
      const [existingRows] = await conn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA");
      const existing = new Set((existingRows as { name: string }[]).map((row) => row.name.toLowerCase()));
      const byDatabase = new Map<string, DbTargetTable[]>();
      for (const item of plan) {
        const list = byDatabase.get(item.database) || [];
        list.push(item);
        byDatabase.set(item.database, list);
      }
      const log = [] as { database: string; ok: boolean; created: boolean; tables: number; error?: string }[];
      for (const [database, tables] of byDatabase) {
        const entry: { database: string; ok: boolean; created: boolean; tables: number; error?: string } = { database, ok: true, created: false, tables: 0 };
        try {
          if (!existing.has(database.toLowerCase())) {
            await conn.query(`CREATE DATABASE ${quoteIdent(database)} DEFAULT CHARACTER SET utf8mb4`);
            entry.created = true;
          }
          if (createTables) {
            for (const table of tables) {
              if (!table.definition) continue;
              try {
                // 显式带库名建表，避免会话里 USE 被别的操作改掉导致建错地方
                await conn.query(qualifyCreateTable(table.definition, database));
                entry.tables += 1;
              } catch (error) {
                const message = errorText(error);
                // 表已存在不算失败，方便重复初始化
                if (/already exists/i.test(message)) continue;
                entry.ok = false;
                entry.error = `${table.table || table.fileName}: ${message}`;
                break;
              }
            }
          }
        } catch (error) {
          entry.ok = false;
          entry.error = errorText(error);
        }
        log.push(entry);
      }
      return log;
    });
    if (!Array.isArray(result)) return result;
    return { ok: log.every((item) => item.ok), plan, log };
  } catch (error) {
    return { ok: false, error: errorText(error), plan };
  }
}

/** 差异对比：逐表比较「SQL 文件定义」与「库里的结构」，并给出以文件为准的 ALTER SQL */
export async function dbDiffSchemas(
  root: string,
  options: {
    envId?: string;
    template?: string;
    databases?: string[];
    tables?: { fileName: string; relative: string }[];
  },
): Promise<Record<string, unknown>> {
  const planResult = await dbPlanSchema(root, options);
  if (!planResult.ok) return planResult;
  const plan = (planResult.plan as DbTargetTable[]);
  if (!plan.length) return { ok: false, error: "没有可对比的 SQL 文件" };
  const only = Array.isArray(options.databases) ? options.databases.filter(Boolean) : [];
  const targets = only.length ? plan.filter((item) => only.some((name) => name.toLowerCase() === item.database.toLowerCase())) : plan;
  if (!targets.length) return { ok: false, error: "所选库里没有对应的 SQL 文件", plan, results: [] };
  try {
    const result = await withRootConnection(root, options.envId, async (conn) => {
      const [databaseRows] = await conn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA");
      const existing = new Set((databaseRows as { name: string }[]).map((row) => row.name.toLowerCase()));
      const results: Record<string, unknown>[] = [];
      for (const item of targets) {
        const fileParsed = parseCreateTable(item.definition);
        const entry: Record<string, unknown> = {
          table: item.table,
          database: item.database,
          fileName: item.fileName,
          relative: item.relative,
          local: item.definition,
          statements: [],
          changes: [],
        };
        if (!existing.has(item.database.toLowerCase())) {
          entry.status = "missingInDb";
          entry.remote = "";
          entry.error = `库 ${item.database} 不存在`;
          entry.changes = ["库不存在"];
          entry.statements = [
            `CREATE DATABASE ${quoteIdent(item.database)} DEFAULT CHARACTER SET utf8mb4;`,
            item.definition ? `${item.definition}` : "",
          ].filter(Boolean);
          results.push(entry);
          continue;
        }
        let remoteDdl = "";
        try {
          const [rows] = await conn.query(`SHOW CREATE TABLE ${quoteIdent(item.database)}.${quoteIdent(item.table)}`);
          const row = (rows as Record<string, unknown>[])[0] || {};
          remoteDdl = String(row["Create Table"] || Object.values(row).find((value) => typeof value === "string" && /CREATE/i.test(value)) || "");
        } catch (error) {
          const message = errorText(error);
          entry.status = "missingInDb";
          entry.remote = "";
          entry.error = message;
          entry.changes = ["库里没有这张表"];
          entry.statements = item.definition ? [item.definition] : [];
          results.push(entry);
          continue;
        }
        entry.remote = remoteDdl;
        if (!fileParsed) {
          entry.status = "same";
          entry.changes = [];
          results.push(entry);
          continue;
        }
        const remoteParsed = parseCreateTable(remoteDdl);
        const diff = diffTableSchema(fileParsed, remoteParsed as ParsedTable);
        entry.status = diff.changes.length ? "diff" : "same";
        entry.changes = diff.changes;
        entry.statements = diff.statements.map((sql) => sql.replace(/^ALTER TABLE `/i, `ALTER TABLE ${quoteIdent(item.database)}.`));
        results.push(entry);
      }
      return results;
    });
    if (!Array.isArray(result)) return result;
    const changed = result.filter((item) => (item as { status?: string }).status !== "same");
    const script = result
      .flatMap((item) => (item as { statements?: string[]; database?: string }).statements || [])
      .filter(Boolean)
      .join("\n\n");
    return {
      ok: true,
      plan,
      results: result,
      changed: changed.length,
      total: result.length,
      script,
    };
  } catch (error) {
    return { ok: false, error: errorText(error), plan, results: [] };
  }
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
  const raw = String(name || "");
  if (!raw) throw new Error("非法标识符");
  return `\`${raw.replace(/`/g, "``")}\``;
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
