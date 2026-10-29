import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { Catalog, buildCatalog } from "./catalog";
import {
  ClientEnvFile,
  defaultEnvFile,
  toClientCatalog,
} from "./clientModel";
import { cancelStress, runStress } from "./grpcStress";
import { decodeBytesMessage } from "./decodeBytes";
import { closeGrpcStream, openGrpcStream, writeGrpcStream } from "./grpcInvoke";
import { InvokePayload, dispatchInvoke } from "./invokeDispatch";
import { openInEditor } from "./openEditor";
import { ProtoParseError, parseProto } from "./parser";
import {
  ProtoSourceConfig,
  collectProtoFiles,
  sourceCacheDir,
  syncGitSource,
} from "./sourceCore";

export type HostSend = (message: Record<string, unknown>) => void;
export type HostLog = (line: string) => void;

export interface ClientHostOptions {
  /** Directory used for workspace .proto scan and .protoview/envs */
  workspaceRoot: string;
  showGoogle?: boolean;
  initialSource?: Partial<ProtoSourceConfig>;
  log?: HostLog;
}

export class ClientHost {
  private catalog: Catalog = buildCatalog([], []);
  private source: ProtoSourceConfig;
  private workspaceRoot: string;
  private showGoogle: boolean;
  private stressRunning = false;
  private log: HostLog;

  constructor(options: ClientHostOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.showGoogle = Boolean(options.showGoogle);
    this.log = options.log || (() => undefined);
    this.source = {
      mode: options.initialSource?.mode === "git" ? "git" : "workspace",
      gitUrl: options.initialSource?.gitUrl?.trim() || "",
      gitBranch: options.initialSource?.gitBranch?.trim() || "main",
      localPath: options.initialSource?.localPath || "",
      dirPath: options.initialSource?.dirPath?.trim()
        || (options.initialSource?.mode === "git" ? "" : this.workspaceRoot),
      lastError: options.initialSource?.lastError || "",
      lastLog: options.initialSource?.lastLog || "",
      lastSyncedAt: options.initialSource?.lastSyncedAt || 0,
    };
  }

  getSource(): ProtoSourceConfig {
    return { ...this.source };
  }

  getCatalog(): Catalog {
    return this.catalog;
  }

  sourceLabel(): string {
    if (this.source.mode === "git") {
      return `Git · ${this.source.gitBranch || "main"} · ${this.source.gitUrl || "未配置"}`;
    }
    const root = this.source.dirPath?.trim() || this.workspaceRoot;
    return `目录 · ${path.basename(root)}`;
  }

  async reload(syncGit = true): Promise<void> {
    if (this.source.mode === "git") {
      if (syncGit || !this.source.localPath) {
        this.source = await syncGitSource(this.source, this.log);
        if (this.source.lastError) {
          this.catalog = buildCatalog([], [{ file: "git", message: this.source.lastError }]);
          return;
        }
      }
      await this.loadFromDirectory(this.source.localPath);
      return;
    }
    const root = this.source.dirPath?.trim() || this.workspaceRoot;
    this.workspaceRoot = path.resolve(root);
    await this.loadFromDirectory(this.workspaceRoot);
  }

  async handleMessage(message: {
    type?: string;
    payload?: InvokePayload & ClientEnvFile & {
      mode?: string;
      dirPath?: string;
      gitUrl?: string;
      gitBranch?: string;
      concurrency?: number;
      total?: number;
      args?: string[];
      binary?: string;
      id?: string;
    };
    file?: string;
    line?: number;
    editor?: string;
    id?: string;
  }, send: HostSend): Promise<void> {
    const type = message.type;
    if (type === "ready") {
      await this.postBootstrap(send);
      return;
    }
    if (type === "refresh") {
      await this.reload(this.source.mode === "git");
      await this.postBootstrap(send);
      return;
    }
    if (type === "setSource" && message.payload) {
      const mode = message.payload.mode === "git" ? "git" : "workspace";
      const gitUrl = String(message.payload.gitUrl || "").trim();
      const gitBranch = String(message.payload.gitBranch || "main").trim() || "main";
      const dirPath = String(message.payload.dirPath || "").trim();
      const prevUrl = this.source.gitUrl;
      if (mode === "git") {
        this.source = {
          ...this.source,
          mode: "git",
          gitUrl,
          gitBranch,
          dirPath: "",
          lastError: "",
          localPath: gitUrl === prevUrl ? this.source.localPath : "",
          lastSyncedAt: gitUrl === prevUrl ? this.source.lastSyncedAt : 0,
        };
      } else {
        this.source = {
          ...this.source,
          mode: "workspace",
          dirPath: dirPath || this.workspaceRoot,
          lastError: "",
        };
      }
      await this.reload(mode === "git");
      await this.postBootstrap(send);
      return;
    }
    if (type === "saveEnvs" && message.payload) {
      await saveEnvFileAt(this.workspaceRoot, message.payload);
      return;
    }
    if (type === "readSource" && message.file) {
      const abs = path.resolve(String(message.file));
      const line = Math.max(1, Math.floor(Number(message.line || 1) || 1));
      try {
        const content = await fs.readFile(abs, "utf8");
        send({ type: "sourceContent", file: abs, line, content });
      } catch (error) {
        send({
          type: "toast",
          level: "err",
          text: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (type === "openSource" && message.file) {
      const line = Number(message.line || 1);
      const editor = String(message.editor || "").trim();
      this.log(`openSource: ${message.file}:${line}${editor ? ` (${editor})` : ""}`);
      const result = await openInEditor(String(message.file), line, editor || undefined);
      send({
        type: "toast",
        level: result.ok ? "ok" : "err",
        text: result.ok
          ? `已在编辑器打开 ${path.basename(String(message.file))}:${line}`
          : result.detail,
      });
      return;
    }
    if (type === "invoke" && message.payload) {
      const result = await dispatchInvoke(this.catalog, message.payload);
      send({ type: "invokeResult", ...result });
      return;
    }
    if (type === "streamOpen" && message.payload && this.catalog) {
      const result = await openGrpcStream(this.catalog, message.payload as Parameters<typeof openGrpcStream>[1], {
        onData: (event) => send({ type: "streamData", ...event }),
        onEnd: (event) => send({ type: "streamEnded", ...event }),
      });
      send({ type: "streamOpenResult", ...result });
      return;
    }
    if (type === "streamWrite" && message.payload) {
      const streamId = String((message.payload as { streamId?: string }).streamId || "");
      const body = (message.payload as { body?: unknown }).body;
      const result = await writeGrpcStream(streamId, body);
      send({ type: "streamWriteResult", id: message.payload.id, streamId, ...result });
      return;
    }
    if (type === "streamClose" && message.payload) {
      const streamId = String((message.payload as { streamId?: string }).streamId || "");
      const result = await closeGrpcStream(streamId);
      send({ type: "streamCloseResult", id: (message.payload as { id?: string }).id, ...result });
      return;
    }
    if (type === "decodeBytes" && message.payload && this.catalog) {
      const result = await decodeBytesMessage(
        this.catalog,
        message.payload as unknown as Parameters<typeof decodeBytesMessage>[1],
      );
      send({ type: "decodeBytesResult", ...result });
      return;
    }
    if (type === "stressCancel" && message.id) {
      cancelStress(message.id);
      return;
    }
    if (type === "stress" && message.payload) {
      if (this.stressRunning) {
        send({
          type: "stressResult",
          id: message.payload.id,
          error: "已有压测在进行中",
        });
        return;
      }
      this.stressRunning = true;
      const id = String(message.payload.id || Date.now());
      try {
        const summary = await runStress(
          this.catalog,
          message.payload,
          {
            id,
            concurrency: Number(message.payload.concurrency || 1),
            total: Number(message.payload.total || 1),
          },
          (progress) => send({ ...progress, type: "stressProgress" }),
        );
        send({ ...summary, type: "stressResult" });
      } finally {
        this.stressRunning = false;
      }
      return;
    }
    if (type === "runGhz" && message.payload?.args) {
      await runGhz(
        message.payload.args,
        String(message.payload.id || Date.now()),
        String(message.payload.binary || "ghz"),
        send,
      );
    }
    // exportFlow / importFlow: handled in browser for CLI (download / file input)
  }

  async postBootstrap(send: HostSend): Promise<void> {
    const envs = await loadEnvFileAt(this.workspaceRoot);
    send({
      type: "bootstrap",
      catalog: toClientCatalog(this.catalog, this.sourceLabel(), this.showGoogle),
      envs,
      source: {
        mode: this.source.mode === "git" ? "git" : "directory",
        dirPath: this.source.dirPath || this.workspaceRoot,
        gitUrl: this.source.gitUrl,
        gitBranch: this.source.gitBranch,
        localPath: this.source.localPath,
        lastError: this.source.lastError,
      },
    });
  }

  private async loadFromDirectory(root: string): Promise<void> {
    const entries = await collectProtoFiles(root);
    this.log(`加载 ${root}，共 ${entries.length} 个 .proto`);
    const errors: { file: string; message: string }[] = [];
    const files = [];
    for (const entry of entries) {
      try {
        const text = await fs.readFile(entry.path, "utf8");
        files.push(parseProto(text, entry.path, entry.relPath));
      } catch (error) {
        const message = error instanceof ProtoParseError || error instanceof Error
          ? error.message
          : String(error);
        errors.push({ file: entry.relPath, message });
        this.log(`${entry.relPath}: ${message}`);
      }
    }
    this.catalog = buildCatalog(files, errors);
  }
}

export function defaultSourceConfig(): ProtoSourceConfig {
  return {
    mode: "workspace",
    gitUrl: "",
    gitBranch: "main",
    localPath: "",
    dirPath: "",
    lastError: "",
    lastLog: "",
    lastSyncedAt: 0,
  };
}

export async function loadEnvFileAt(root: string): Promise<ClientEnvFile> {
  const file = path.join(root, ".protoview", "environments.json");
  try {
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text) as ClientEnvFile;
    if (!Array.isArray(data.envs) || !data.envs.length) return defaultEnvFile();
    return {
      activeEnvId: data.activeEnvId || data.envs[0].id,
      envs: data.envs,
    };
  } catch {
    return defaultEnvFile();
  }
}

export async function saveEnvFileAt(root: string, data: ClientEnvFile): Promise<void> {
  const dir = path.join(root, ".protoview");
  const file = path.join(dir, "environments.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function runGhz(
  args: string[],
  id: string,
  binary: string,
  send: HostSend,
): Promise<void> {
  const cmd = (binary || "ghz").trim() || "ghz";
  const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
  send({ type: "ghzProgress", id, text: `运行: ${cmd} ${argv.join(" ")}\n` });
  await new Promise<void>((resolve) => {
    // execFile + argv：避免 shell:true 下用户路径 / host / metadata 注入
    const child = execFile(cmd, argv, { windowsHide: true, shell: false });
    const push = (chunk: Buffer) => {
      send({ type: "ghzProgress", id, text: chunk.toString() });
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (error) => {
      send({
        type: "ghzResult",
        id,
        ok: false,
        text: `无法启动 ghz：${error.message}\n请填写正确的 ghz 路径，或改用「复制 ghz 命令」。`,
      });
      resolve();
    });
    child.on("close", (code) => {
      send({
        type: "ghzResult",
        id,
        ok: code === 0,
        text: `\n[exit ${code ?? "null"}]\n`,
      });
      resolve();
    });
  });
}

export { sourceCacheDir, syncGitSource };
