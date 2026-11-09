import { docCatalog, docPage, docSave, docSearch } from "./docIndex";
import {
  dbDatabases,
  dbMutate,
  dbQuery,
  dbTableDefinition,
  dbTablePage,
  dbTestConnection,
  loadDbEnvs,
  saveDbEnvs,
  DbEnvFile,
} from "./dbSession";
import { sqlCatalog, sqlSearch } from "./sqlIndex";

/** Docs / SQL / 数据库消息。不认识的类型返回 null，交给原来的处理。 */
export async function handleOceanMessage(
  type: string | undefined,
  payload: unknown,
  root: string,
  extraRoot = "",
): Promise<Record<string, unknown> | null> {
  const body = (payload || {}) as Record<string, unknown>;
  if (type === "docCatalog") {
    return { type: "docCatalog", payload: await docCatalog(root, Boolean(body.force), extraRoot) };
  }
  if (type === "docPage") {
    return { type: "docPage", payload: await docPage(root, String(body.id || ""), extraRoot) };
  }
  if (type === "docSearch") {
    return { type: "docSearch", payload: await docSearch(root, String(body.query || ""), 40, extraRoot) };
  }
  if (type === "docSave") {
    return {
      type: "docSaved",
      payload: { id: String(body.id || ""), ...(await docSave(root, String(body.id || ""), String(body.text ?? ""), extraRoot)) },
    };
  }
  if (type === "sqlCatalog") {
    return { type: "sqlCatalog", payload: await sqlCatalog(root, Boolean(body.force)) };
  }
  if (type === "sqlSearch") {
    return { type: "sqlSearch", payload: await sqlSearch(root, String(body.query || "")) };
  }
  if (type === "dbEnvLoad") {
    return { type: "dbEnvs", payload: await loadDbEnvs(root) };
  }
  if (type === "dbEnvSave") {
    return { type: "dbEnvs", payload: await saveDbEnvs(root, body as unknown as DbEnvFile) };
  }
  if (type === "dbTest") {
    return {
      type: "dbTest",
      payload: await dbTestConnection(root, {
        envId: String(body.envId || ""),
        env: (body.env || undefined) as Record<string, unknown> | undefined,
      }),
    };
  }
  if (type === "dbDatabases") {
    return {
      type: "dbDatabases",
      payload: await dbDatabases(root, { envId: String(body.envId || "") }),
    };
  }
  if (type === "dbTable") {
    return {
      type: "dbTable",
      payload: await dbTablePage(root, {
        envId: String(body.envId || ""),
        tableId: String(body.tableId || ""),
        limit: Number(body.limit || 50),
        offset: Number(body.offset || 0),
      }),
    };
  }
  if (type === "dbDefinition") {
    return {
      type: "dbDefinition",
      payload: await dbTableDefinition(root, {
        envId: String(body.envId || ""),
        tableId: String(body.tableId || ""),
      }),
    };
  }
  if (type === "dbUpdate" || type === "dbInsert" || type === "dbDelete") {
    const op = type === "dbUpdate" ? "update" : type === "dbInsert" ? "insert" : "delete";
    const result = await dbMutate(root, {
      op,
      envId: String(body.envId || ""),
      tableId: String(body.tableId || ""),
      pk: (body.pk || {}) as Record<string, unknown>,
      column: String(body.column || ""),
      value: body.value,
      values: (body.values || {}) as Record<string, unknown>,
    });
    return { type: "dbMutate", payload: result };
  }
  if (type === "dbQuery") {
    return { type: "dbQuery", payload: await dbQuery(root, { envId: String(body.envId || ""), sql: String(body.sql || "") }) };
  }
  return null;
}
