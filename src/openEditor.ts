import { exec, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
    const result = await runKnown(name, abs, ln);
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
    const cmd = spec
      .replaceAll("{file}", quote(file))
      .replaceAll("{line}", String(line));
    return runShell(cmd, `自定义：${spec}`);
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

function runDetached(command: string, args: string[], label: string): Promise<OpenEditorResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => {
        resolve({ ok: false, detail: error.message });
      });
      child.unref();
      // 编辑器常驻进程，spawn 成功即视为已拉起
      setTimeout(() => resolve({ ok: true, detail: label }), 80);
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

function runShell(command: string, label: string): Promise<OpenEditorResult> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error) => {
      if (error) resolve({ ok: false, detail: error.message });
      else resolve({ ok: true, detail: label });
    });
  });
}

function commandExists(name: string): Promise<boolean> {
  const check = process.platform === "win32"
    ? `where ${name}`
    : `command -v ${name}`;
  return new Promise((resolve) => {
    exec(check, { windowsHide: true }, (error) => resolve(!error));
  });
}

function quote(file: string): string {
  if (!/[\s"']/.test(file)) return file;
  return `"${file.replace(/"/g, '\\"')}"`;
}
