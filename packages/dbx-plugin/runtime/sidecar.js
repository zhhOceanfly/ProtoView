#!/usr/bin/env node
/**
 * ProtoView DBX Sidecar — JSON-RPC 2.0 over stdio (JSONL).
 * stdout = protocol only; logs go to stderr.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PLUGIN_ID = "io.github.zhhoceanfly.protoview";
const PLUGIN_VERSION = "0.1.1";

const coreDir = path.join(__dirname, "core");
const { ClientHost } = require(path.join(coreDir, "hostCore.js"));
const { materializeProtoUpload, materializeGhzUpload } = require("./uploadProtoDir.js");

const dataDir = process.env.DBX_PLUGIN_DATA_DIR
  ? path.resolve(process.env.DBX_PLUGIN_DATA_DIR)
  : path.join(require("os").tmpdir(), "protoview-dbx-data");

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (error) {
  log(`mkdir data dir failed: ${error.message || error}`);
}

const workspaceRoot = path.join(dataDir, "workspace");
try {
  fs.mkdirSync(workspaceRoot, { recursive: true });
} catch {
  /* ignore */
}

const host = new ClientHost({
  workspaceRoot,
  showGoogle: false,
  initialSource: { mode: "workspace", dirPath: workspaceRoot },
  log: (line) => log(line),
});

let writeQueue = Promise.resolve();

function log(line) {
  process.stderr.write(`[protoview-dbx] ${line}\n`);
}

function writeLine(obj) {
  writeQueue = writeQueue.then(() => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }).catch((error) => {
    log(`stdout write failed: ${error.message || error}`);
  });
  return writeQueue;
}

function emit(method, params) {
  return writeLine({ jsonrpc: "2.0", method, params: params ?? {} });
}

function replyResult(id, result) {
  return writeLine({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  return writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendToUi(message) {
  return emit("client/push", message || {});
}

async function handleInitialize(id, params) {
  const versions = params?.host?.protocolVersions || params?.protocolVersions || [1];
  const selected = Array.isArray(versions) && versions.includes(1) ? 1 : null;
  if (!selected) {
    await replyError(id, -32602, "Unsupported protocol version");
    return;
  }
  // Host expects capabilities as a string sequence (Vec<String>), not a map.
  await replyResult(id, {
    protocolVersion: selected,
    capabilities: [],
    plugin: {
      id: PLUGIN_ID,
      version: PLUGIN_VERSION,
    },
  });
}

async function handleClientMessage(id, params) {
  const message = params?.message || params || {};
  const type = message.type;

  try {
    if (type === "uploadProtoDir") {
      const result = await materializeProtoUpload(message.payload || {});
      if (!result.count) {
        await sendToUi({ type: "toast", level: "err", text: "目录中未找到 .proto 文件" });
      } else {
        await sendToUi({
          type: "pickedProtoDir",
          path: result.dir,
          label: result.label,
          count: result.count,
        });
      }
      await replyResult(id, { ok: true });
      return;
    }

    if (type === "uploadGhzBinary") {
      const file = await materializeGhzUpload(message.payload || {});
      if (file) await sendToUi({ type: "pickedGhzBinary", path: file });
      await replyResult(id, { ok: true });
      return;
    }

    await host.handleMessage(message, (m) => {
      void sendToUi(m);
    });
    await replyResult(id, { ok: true });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await sendToUi({
      type: "invokeResult",
      ok: false,
      status: "ERROR",
      error: text,
    });
    await replyError(id, -32000, text);
  }
}

const connections = new Set();

function connectionIdFrom(params) {
  const connection = params?.connection;
  if (connection && typeof connection === "object") {
    return String(connection.id || connection.connectionId || "").trim();
  }
  return String(params?.connectionId || "").trim();
}

function readExternalConfig(connection) {
  const cfg = connection?.external_config || connection?.externalConfig || connection?.config || {};
  return cfg && typeof cfg === "object" ? cfg : {};
}

function describeProtoSource(connection) {
  const cfg = readExternalConfig(connection);
  const mode = String(cfg.source_mode || "directory").trim() || "directory";
  if (mode === "git") {
    const url = String(cfg.git_url || "").trim();
    const branch = String(cfg.git_branch || "main").trim() || "main";
    if (!url) return { ok: false, message: "请填写 Git 地址" };
    return { ok: true, message: `Git · ${branch} · ${url}`, mode, gitUrl: url, gitBranch: branch };
  }
  const dirPath = String(cfg.dir_path || "").trim();
  if (!dirPath) return { ok: false, message: "请选择 Proto 目录" };
  return { ok: true, message: `目录 · ${dirPath}`, mode: "directory", dirPath };
}

async function applyConnectionSource(connection) {
  const source = describeProtoSource(connection);
  if (!source.ok) return source;
  if (source.mode === "git") {
    await host.handleMessage(
      {
        type: "setSource",
        payload: {
          mode: "git",
          gitUrl: source.gitUrl,
          gitBranch: source.gitBranch,
        },
      },
      () => undefined,
    );
  } else {
    await host.handleMessage(
      {
        type: "setSource",
        payload: {
          mode: "directory",
          dirPath: source.dirPath,
        },
      },
      () => undefined,
    );
  }
  return source;
}

async function handleConnection(method, id, params) {
  const connection = params?.connection && typeof params.connection === "object"
    ? params.connection
    : {};
  const connectionId = connectionIdFrom(params);

  if (method === "connection/test") {
    const source = describeProtoSource(connection);
    await replyResult(id, {
      success: source.ok,
      message: source.message,
      connection,
    });
    return;
  }

  if (method === "connection/connect") {
    if (!connectionId) {
      await replyError(id, -32602, "Missing connection id");
      return;
    }
    const applied = await applyConnectionSource(connection);
    if (!applied.ok) {
      await replyResult(id, { success: false, message: applied.message });
      return;
    }
    connections.add(connectionId);
    await replyResult(id, { success: true, message: applied.message });
    return;
  }

  if (method === "connection/disconnect") {
    if (connectionId) connections.delete(connectionId);
    await replyResult(id, { success: true });
    return;
  }

  await replyError(id, -32601, `Method not found: ${method}`);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) {
    // notification — ignore unknown
    return;
  }

  if (method === "plugin/initialize") {
    await handleInitialize(id, params || {});
    return;
  }
  if (method === "client/ping") {
    await replyResult(id, { ok: true, t: Date.now() });
    return;
  }
  if (method === "client/message") {
    await handleClientMessage(id, params || {});
    return;
  }
  if (
    method === "connection/test"
    || method === "connection/connect"
    || method === "connection/disconnect"
  ) {
    await handleConnection(method, id, params || {});
    return;
  }

  await replyError(id, -32601, `Method not found: ${method}`);
}

async function main() {
  log(`sidecar start id=${PLUGIN_ID} v=${PLUGIN_VERSION} data=${dataDir}`);
  try {
    await host.reload(false);
  } catch (error) {
    log(`initial reload: ${error.message || error}`);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = [];

  rl.on("line", (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (error) {
      log(`invalid json: ${error.message || error}`);
      return;
    }
    if (!msg || msg.jsonrpc !== "2.0" || !msg.method) {
      log("invalid json-rpc frame");
      return;
    }
    const job = handleRequest(msg).catch((error) => {
      log(`request failed: ${error.message || error}`);
      if (msg.id !== undefined && msg.id !== null) {
        return replyError(msg.id, -32603, error instanceof Error ? error.message : String(error));
      }
    });
    pending.push(job);
    void job.finally(() => {
      const i = pending.indexOf(job);
      if (i >= 0) pending.splice(i, 1);
    });
  });

  rl.on("close", () => {
    log("stdin closed");
    process.exit(0);
  });
}

main().catch((error) => {
  log(`fatal: ${error.message || error}`);
  process.exit(1);
});
