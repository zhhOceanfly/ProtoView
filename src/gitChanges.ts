import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Git 变更集合：工作区 + 暂存区 + 与上游分支的差异。
 * 只在确实是 git 仓库时返回 ok，否则 ok=false，界面据此隐藏「只看变更」。
 */
export interface GitChanges {
  ok: boolean;
  root: string;
  /** git 仓库根（可能是 root 的上级） */
  repoRoot: string;
  branch: string;
  /** 全部变更文件（相对仓库根，统一 / 分隔） */
  files: string[];
  error?: string;
}

const cache = new Map<string, { at: number; changes: GitChanges }>();
const CACHE_MS = 4000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout || "");
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function gitChanges(root: string, force = false): Promise<GitChanges> {
  let abs = path.resolve(root || "");
  if (!abs) return { ok: false, root: abs, repoRoot: abs, branch: "", files: [] };
  // Windows 短路径（ZOCEAN~1）会让 path.relative 算错，先归一成真实路径
  try {
    abs = await fs.realpath(abs);
  } catch { /* 保底用 resolve 结果 */ }
  const cached = cache.get(abs);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.changes;
  const empty: GitChanges = { ok: false, root: abs, repoRoot: abs, branch: "", files: [] };
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return empty;
  } catch {
    return empty;
  }
  if (!(await isGitRepo(abs))) {
    // codeRoot 自己不在仓库里，但下面可能嵌了仓库（例如工作区里放了几个子项目）
    const nestedOnly = await findNestedRepos(abs, abs);
    if (!nestedOnly.length) {
      cache.set(abs, { at: Date.now(), changes: empty });
      return empty;
    }
    const filesOnly = new Set<string>();
    for (const repo of nestedOnly) {
      const prefix = path.relative(abs, repo).split(path.sep).join("/");
      const sub = await gitChanges(repo, force);
      if (!sub.ok) continue;
      for (const file of sub.files) filesOnly.add(prefix ? `${prefix}/${file}` : file);
    }
    const changesOnly: GitChanges = { ok: true, root: abs, repoRoot: abs, branch: "", files: [...filesOnly].sort() };
    cache.set(abs, { at: Date.now(), changes: changesOnly });
    return changesOnly;
  }
  let branch = "";
  let repoRoot = abs;
  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], abs)).trim();
  } catch { /* 允许空仓库 */ }
  try {
    const top = (await git(["rev-parse", "--show-toplevel"], abs)).trim();
    if (top) {
      try { repoRoot = await fs.realpath(path.resolve(top)); }
      catch { repoRoot = path.resolve(top); }
    }
  } catch { /* 保底用 root */ }
  const files = new Set<string>();
  const add = (text: string) => {
    for (const line of String(text || "").split(/\r?\n/)) {
      const rel = line.trim();
      if (rel) files.add(rel.replace(/\\/g, "/"));
    }
  };
  const runTasks = async (cwd: string, prefix: string) => {
    // 未跟踪：--others，其余用相对仓库根的名字
    const tasks: { args: string[]; parse: (out: string) => void }[] = [
      { args: ["diff", "--name-only"], parse: add },
      { args: ["diff", "--cached", "--name-only"], parse: add },
      { args: ["ls-files", "--others", "--exclude-standard"], parse: add },
      { args: ["diff", "--name-only", "@{upstream}"], parse: add },
    ];
    for (const task of tasks) {
      try {
        const out = await git(task.args, cwd);
        task.parse(out.split(/\r?\n/).map((line) => (line.trim() ? `${prefix}${line.trim()}` : "")).join("\n"));
      } catch {
        // 没有 upstream / detached HEAD 时忽略这一类
      }
    }
  };
  await runTasks(abs, "");

  // 子目录里嵌了独立的 git 仓库（子模块或普通嵌套仓库）：也要把它们的变更算进来
  const nested = await findNestedRepos(abs, repoRoot);
  for (const repo of nested) {
    const prefix = path.relative(repoRoot, repo).split(path.sep).join("/");
    await runTasks(repo, prefix ? `${prefix}/` : "");
  }
  const changes: GitChanges = { ok: true, root: abs, repoRoot, branch, files: [...files].sort() };
  cache.set(abs, { at: Date.now(), changes });
  return changes;
}

const SKIP_REPO_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", "coverage", "vendor", ".vs", ".idea"]);
const MAX_NESTED_DEPTH = 4;

/** 找出 codeRoot 下嵌套的 git 仓库（子模块、内嵌仓库），用于合并变更 */
async function findNestedRepos(root: string, outerRepo: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_NESTED_DEPTH || out.length >= 40) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 40) return;
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (SKIP_REPO_DIRS.has(entry.name)) continue;
      // 有 .git 目录或文件（子模块是 .git 文件）就算一个仓库
      let nested = false;
      try {
        const stat = await fs.stat(path.join(full, ".git"));
        nested = stat.isDirectory() || stat.isFile();
      } catch {
        nested = false;
      }
      if (nested && path.resolve(full) !== path.resolve(outerRepo)) {
        if (await isGitRepo(full)) out.push(full);
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** 合并多个根目录的变更（codeRoot 可能是临时 clone，工作区根才是真实仓库） */
export async function gitChangesMerged(roots: string[], force = false): Promise<GitChanges> {
  const seen = new Set<string>();
  const out: GitChanges = { ok: false, root: roots[0] || "", repoRoot: roots[0] || "", branch: "", files: [] };
  const files = new Set<string>();
  for (const root of roots) {
    const abs = path.resolve(root || "");
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const changes = await gitChanges(abs, force);
    if (!changes.ok) continue;
    out.ok = true;
    if (!out.branch) out.branch = changes.branch || "";
    if (!out.repoRoot) out.repoRoot = changes.repoRoot || abs;
    for (const file of changes.files) files.add(file);
  }
  out.files = [...files].sort();
  return out;
}

/**
 * 变更集合换成「相对 codeRoot」的路径集合，方便前端直接和 relative 比较。
 * codeRoot 在仓库子目录里时也要能对上。
 */
export function changedRelativeSet(changes: GitChanges, codeRoot: string): Set<string> {
  const out = new Set<string>();
  if (!changes.ok) return out;
  const base = path.relative(changes.repoRoot, path.resolve(codeRoot || changes.repoRoot))
    .split(path.sep).join("/");
  for (const file of changes.files) {
    if (!base || base === "." || base.startsWith("..")) out.add(file);
    else if (file === base) continue;
    else if (file.startsWith(`${base}/`)) out.add(file.slice(base.length + 1));
  }
  return out;
}

/** 把绝对路径或相对 codeRoot 的路径换算成仓库内相对路径 */
export function repoRelative(root: string, target: string): string {
  const absRoot = path.resolve(root || "");
  const absTarget = path.isAbsolute(target) ? path.resolve(target) : path.resolve(absRoot, target);
  const rel = path.relative(absRoot, absTarget).split(path.sep).join("/");
  return rel;
}
