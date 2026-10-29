import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface OpenEditorResult {
  ok: boolean;
  detail: string;
}

/**
 * CLI / 浏览器模式下打开本机编辑器。
 *
 * @param preferred 指定编辑器：cursor / code / notepad / 或模板命令；空则走 PROTOVIEW_EDITOR / 自动探测
 */
export async function openInEditor(
  file: string,
  line: number,
  preferred?: string,
): Promise<OpenEditorResult> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    return { ok: false, detail: `文件不存在：${abs}` };
  }
  const ln = Math.max(1, Math.floor(Number(line) || 1));

  const pick = String(preferred || process.env.PROTOVIEW_EDITOR || "").trim();
  if (pick) {
    const result = await runConfigured(pick, abs, ln);
    if (result.ok) return result;
    if (preferred) return { ok: false, detail: `无法用 ${preferred} 打开：${result.detail}` };
    return { ok: false, detail: `PROTOVIEW_EDITOR 打开失败：${result.detail}` };
  }

  for (const name of autoCandidates()) {
    if (!(await commandExists(name))) continue;
    const result = await runKnown(name, file, ln);
    if (result.ok) return result;
  }

  return {
    ok: false,
    detail: "未找到编辑器。可在页面选择 Cursor / VS Code / 记事本，或设置 PROTOVIEW_EDITOR=cursor",
  };
}

function autoCandidates(): string[] {
  if (process.platform === "win32") {
    return ["cursor", "code", "code-insiders", "idea64", "idea", "rider64", "rider", "webstorm64", "webstorm", "subl"];
  }
  return ["cursor", "code", "code-insiders", "idea", "rider", "webstorm", "pycharm", "goland", "clion", "subl"];
}

async function runConfigured(spec: string, file: string, line: number): Promise<OpenEditorResult> {
  if (spec.includes("{file}") || spec.includes("{line}")) {
    const tokens = tokenizeCommand(spec).map((token) =>
      token.replaceAll("{file}", file).replaceAll("{line}", String(line)),
    );
    if (!tokens.length) return { ok: false, detail: "空命令模板" };
    const [command, ...args] = tokens;
    return runDetached(command, args, `自定义：${spec}`);
  }
  const name = spec.split(/\s+/)[0] || spec;
  return runKnown(name, file, line);
}

async function runKnown(name: string, file: string, line: number): Promise<OpenEditorResult> {
  const lower = name.toLowerCase();
  if (lower === "notepad" || lower === "notepad.exe") {
    const cmd = process.platform === "win32" ? "notepad.exe" : "notepad";
    return runDetached(cmd, [file], `记事本 ${path.basename(file)}`);
  }
  if (lower === "cursor" || lower === "code" || lower === "code-insiders" || lower === "codium" || lower === "vscodium") {
    return runDetached(name, ["-g", `${file}:${line}`], `${name} -g ${path.basename(file)}:${line}`);
  }
  if (lower === "subl" || lower === "sublime_text") {
    return runDetached(name, [`${file}:${line}`], `${name} ${path.basename(file)}:${line}`);
  }
  if (/^(idea|idea64|rider|rider64|webstorm|webstorm64|pycharm|pycharm64|goland|goland64|clion|clion64|phpstorm|phpstorm64)$/i.test(name)) {
    return runDetached(name, ["--line", String(line), file], `${name} --line ${line}`);
  }
  // 未知命令：按 VS Code 风格尝试
  return runDetached(name, ["-g", `${file}:${line}`], `${name} -g …`);
}

/** 简单空白分词（支持 "..." / '...'），不经 shell 展开 */
function tokenizeCommand(spec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Windows CreateProcess 风格转义单个参数（用于不得已走 cmd.exe /c 时）。
 * @see https://learn.microsoft.com/en-us/archive/blogs/twistylittlepassagesallalike/everyone-quotes-command-line-arguments-the-wrong-way
 */
function quoteWinArg(arg: string): string {
  if (!arg.length) return '""';
  if (!/[\s"]/g.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function spawnArgv(command: string, args: string[]) {
  const argv = args.map(String);
  // Windows 上 code/cursor 常为 .cmd shim；不能 shell:true，改由 cmd.exe /d /s /c + 逐参转义
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const line = [quoteWinArg(command), ...argv.map(quoteWinArg)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, argv, {
    shell: false,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

function runDetached(command: string, args: string[], label: string): Promise<OpenEditorResult> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        let cmd = command;
        if (process.platform === "win32" && !path.isAbsolute(command) && !/[\\/]/.test(command)) {
          cmd = (await resolveOnPath(command)) || command;
        }
        const child = spawnArgv(cmd, args);
        child.on("error", (error) => {
          resolve({ ok: false, detail: error.message });
        });
        child.unref();
        // 编辑器常驻进程，spawn 成功即视为已拉起
        setTimeout(() => resolve({ ok: true, detail: label }), 80);
      } catch (error) {
        resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

async function resolveOnPath(name: string): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where.exe", [name], { windowsHide: true });
      const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // 优先 .exe，避免不必要的 cmd shim
      return hits.find((h) => /\.exe$/i.test(h)) || hits[0];
    }
    const { stdout } = await execFileAsync("which", [name]);
    return stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

function commandExists(name: string): Promise<boolean> {
  return resolveOnPath(name).then((hit) => Boolean(hit));
}
