import { createHash } from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type SourceMode = "workspace" | "git";
export type SourceLogger = (line: string) => void;

export interface ProtoSourceConfig {
  mode: SourceMode;
  gitUrl: string;
  gitBranch: string;
  /** Git clone 目录，或（workspace 模式下）Client「自定义目录」覆盖路径 */
  localPath: string;
  /** Client 自定义目录；有值时优先于 VS Code 工作区文件夹扫描（侧边栏模式仍为 workspace） */
  dirPath: string;
  lastError: string;
  lastLog: string;
  lastSyncedAt: number;
}

export function sourceCacheDir(gitUrl: string): string {
  const hash = createHash("sha1").update(gitUrl.trim()).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), "protoview-git", hash);
}

export async function syncGitSource(
  config: ProtoSourceConfig,
  log: SourceLogger = () => undefined,
): Promise<ProtoSourceConfig> {
  const lines: string[] = [];
  const write = (line: string) => {
    const text = line.replace(/\s+$/g, "");
    if (!text) return;
    lines.push(text);
    log(text);
  };

  const url = config.gitUrl.trim();
  const branch = config.gitBranch.trim() || "main";
  const localPath = url ? sourceCacheDir(url) : "";

  write("======== ProtoView Git 同步开始 ========");
  write(`时间: ${new Date().toLocaleString()}`);
  write(`地址: ${url || "(空)"}`);
  write(`分支: ${branch}`);
  write(`临时目录: ${localPath || "(未生成)"}`);
  write(`系统临时根: ${os.tmpdir()}`);

  if (!url) {
    const lastError = "请先填写 Git 地址";
    write(`错误: ${lastError}`);
    return { ...config, lastError, localPath: "", lastLog: lines.join("\n"), lastSyncedAt: 0 };
  }
  if (!/^https?:\/\/|^git@|^ssh:\/\//i.test(url)) {
    const lastError = "Git 地址格式不正确";
    write(`错误: ${lastError}`);
    return { ...config, lastError, localPath, lastLog: lines.join("\n"), lastSyncedAt: 0 };
  }

  await fs.mkdir(path.dirname(localPath), { recursive: true });

  try {
    const version = await ensureGitAvailable(write);
    write(`Git 版本: ${version}`);

    const exists = await pathExists(path.join(localPath, ".git"));
    write(`本地仓库是否已存在: ${exists ? "是" : "否"}`);

    if (!exists) {
      write(`清理目录: ${localPath}`);
      await fs.rm(localPath, { recursive: true, force: true });
      await runGit(
        ["clone", "--progress", "--depth", "1", "--branch", branch, url, localPath],
        path.dirname(localPath),
        write,
      );
    } else {
      await runGit(["remote", "set-url", "origin", url], localPath, write);
      await runGit(["remote", "-v"], localPath, write);
      await runGit(["fetch", "--progress", "--depth", "1", "origin", branch], localPath, write);
      await runGit(["checkout", "-B", branch, `origin/${branch}`], localPath, write);
      await runGit(["status", "-sb"], localPath, write);
      await runGit(["rev-parse", "--short", "HEAD"], localPath, write);
    }

    write("同步成功");
    write("======== ProtoView Git 同步结束 ========");
    return {
      ...config,
      gitUrl: url,
      gitBranch: branch,
      localPath,
      lastError: "",
      lastLog: lines.join("\n"),
      lastSyncedAt: Date.now(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`错误: ${message}`);
    write("提示: 私有仓库需本机 Git 已登录；HTTPS 可用凭证管理器，SSH 需配置密钥。");
    write("提示: 也可在终端手动执行上面的 git 命令对照报错。");
    write("======== ProtoView Git 同步结束（失败） ========");
    return {
      ...config,
      gitUrl: url,
      gitBranch: branch,
      localPath,
      lastError: truncate(message, 240),
      lastLog: lines.join("\n"),
      lastSyncedAt: config.lastSyncedAt,
    };
  }
}

export async function collectProtoFiles(
  root: string,
): Promise<{ path: string; relPath: string }[]> {
  const out: { path: string; relPath: string }[] = [];
  const skip = new Set(["node_modules", ".git", "out", "dist", ".vs", ".idea"]);

  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".proto")) {
        const full = path.join(dir, entry.name);
        out.push({ path: full, relPath: path.relative(root, full) });
      }
    }
  };

  await walk(root);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

export function sourceSummary(config: ProtoSourceConfig): string {
  if (config.mode === "workspace") {
    if (config.dirPath?.trim()) return "工作区 · 自定义目录";
    return "工作区自动识别";
  }
  if (!config.gitUrl) return "Git · 未配置";
  const branch = config.gitBranch || "main";
  if (config.lastError) return `Git · ${branch} · 失败`;
  if (config.localPath) return `Git · ${branch}`;
  return `Git · ${branch} · 待同步`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

async function ensureGitAvailable(log: SourceLogger): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { windowsHide: true });
    return (stdout || "").trim();
  } catch {
    log("错误: 未找到 git 命令");
    throw new Error("未找到 git 命令，请先安装 Git 并确保已加入 PATH");
  }
}

async function runGit(args: string[], cwd: string, log: SourceLogger): Promise<string> {
  const command = `git ${args.map(shellQuote).join(" ")}`;
  log(`$ ${command}`);
  log(`  cwd: ${cwd}`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_TRACE: process.env.PROTOVIEW_GIT_TRACE || "",
      },
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (out) {
      for (const line of out.split(/\r?\n/)) log(`  ${line}`);
    } else {
      log("  (无输出)");
    }
    return out;
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string; code?: number };
    const detail = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
    if (detail) {
      for (const line of detail.split(/\r?\n/)) log(`  ! ${line}`);
    }
    if (typeof err.code === "number") log(`  exit code: ${err.code}`);
    throw new Error(detail || String(error));
  }
}

function shellQuote(value: string): string {
  if (!/[\s"']/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
