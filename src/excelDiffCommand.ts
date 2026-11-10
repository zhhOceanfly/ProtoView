import * as path from "path";
import * as vscode from "vscode";
import { diffWorkbook, diffWorkbookByUris, DiffUri, WorkbookDiff } from "./excelIndex";

/**
 * ExcelView 差异对比。
 *
 * 两种入口：
 * 1. 源码管理 / 编辑器右键命令：和 git HEAD 比；
 * 2. Git 侧边栏点开 Excel：VS Code 会用本扩展的两个自定义编辑器左右并排，
 *    两个 webview 各自只显示自己那一份，无法标出差异单元格。
 *    这里额外提供「ExcelView 差异对比」标签页，用一张 HTML 表同时呈现左右，
 *    变化的单元格高亮，读不到时给出明确提示。
 */
const SCHEME = "protoview-excel-diff";

class ExcelDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private seq = 0;

  public register(uri: vscode.Uri, text: string): void {
    this.store.set(uri.toString(), text);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? "";
  }

  public nextUri(label: string): vscode.Uri {
    this.seq += 1;
    return vscode.Uri.parse(`${SCHEME}:/${this.seq}/${encodeURIComponent(label)}`);
  }
}

let provider: ExcelDiffContentProvider | undefined;

export function registerExcelDiff(context: vscode.ExtensionContext): void {
  provider = new ExcelDiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand("protoview.excelDiff", async (arg?: unknown) => {
      const file = resolveTargetFile(arg);
      if (!file) {
        void vscode.window.showWarningMessage("请选择一个 Excel 文件（或在 Source Control 里右键该文件）。");
        return;
      }
      await showExcelDiff(file);
    }),
    // Git 侧的「比较」：直接传入左右两个 URI，不依赖目录扫描
    vscode.commands.registerCommand("protoview.excelDiffUris", async (left?: vscode.Uri, right?: vscode.Uri) => {
      await showExcelDiffByUris(left, right);
    }),
    // 从 git: 历史版本 URI 自动找到工作区版本，再左右对比
    vscode.commands.registerCommand("protoview.excelDiffGit", async (uri?: vscode.Uri) => {
      if (!uri || uri.scheme === "file") return;
      const working = vscode.Uri.file(uri.fsPath);
      await showExcelDiffByUris(uri, working);
    }),
    // Git 里双击 Excel 时，VS Code 会先打开内置文本 diff（显示「二进制文件」），
    // 这里监听标签变化，自动关掉那个标签，换成 ExcelView 差异页
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.opened) void replaceBinaryDiffTab(tab);
    }),
  );
}

/** 判断是不是 Excel 的 diff 标签（Git 打开二进制文件时产生的那两个） */
function excelDiffUriOf(tab: vscode.Tab | undefined): vscode.Uri | null {
  if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) return null;
  const { original, modified } = tab.input;
  const target = String(modified.path || modified.fsPath || original.path || original.fsPath || "");
  if (!/\.(xlsx|xlsm|xls|csv)$/i.test(target)) return null;
  // 历史版本的 scheme 可能是 git:（或者是我们自己的工作区版本）
  return modified.scheme === "file" ? modified : original;
}

/** 已处理过的文件，避免反复打开差异页 */
const handled = new Set<string>();

/** 关掉所有 Excel 的内置文本 diff 标签（Git 打开二进制文件时产生的左右两栏） */
export async function closeExcelTextDiffs(): Promise<void> {
  const closeThese = vscode.window.tabGroups.all
    .flatMap((item) => item.tabs)
    .filter((item) => item.input instanceof vscode.TabInputTextDiff && excelDiffUriOf(item));
  if (!closeThese.length) return;
  try {
    await vscode.window.tabGroups.close(closeThese, true);
  } catch { /* 关不掉也继续 */ }
}

/** 这个文件当前是否正被 VS Code 当作 diff 打开（Git 侧点击就是这样） */
export function isOpenAsDiff(uri: vscode.Uri): boolean {
  const key = uri.toString();
  const pathKey = uri.path.replace(/^\/+/, "");
  const fsKey = (uri.fsPath || "").replace(/\\/g, "/").toLowerCase();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
      for (const target of [tab.input.original, tab.input.modified]) {
        if (target.toString() === key) return true;
        if (target.path.replace(/^\/+/, "") === pathKey) return true;
        const targetFs = (target.fsPath || "").replace(/\\/g, "/").toLowerCase();
        if (fsKey && targetFs === fsKey) return true;
      }
    }
  }
  return false;
}

async function replaceBinaryDiffTab(tab: vscode.Tab): Promise<void> {
  const uri = excelDiffUriOf(tab);
  if (!uri) return;
  const key = uri.toString();
  if (handled.has(key)) return;
  handled.add(key);
  // 处理完就释放，下次再次打开还能接管
  setTimeout(() => handled.delete(key), 6000);
  await closeExcelTextDiffs();
  const working = vscode.Uri.file(uri.fsPath);
  await showExcelDiffByUris(uri.scheme === "file" ? working : uri, working);
}

/** 从命令参数 / 当前编辑器 / Source Control 选中项解析出 xlsx 绝对路径 */
function resolveTargetFile(arg: unknown): string {
  const fromUri = (value: unknown): string => {
    if (value instanceof vscode.Uri) return value.fsPath;
    const record = value as { resourceUri?: vscode.Uri; uri?: vscode.Uri; fsPath?: string } | undefined;
    return record?.resourceUri?.fsPath || record?.uri?.fsPath || record?.fsPath || "";
  };
  const candidates: unknown[] = [arg, vscode.window.activeTextEditor?.document.uri];
  for (const item of candidates) {
    const file = fromUri(item);
    if (file && /\.(xlsx|xlsm|xls|csv)$/i.test(file)) return file;
  }
  return "";
}

async function readBytes(uri: DiffUri): Promise<Buffer | null> {
  const fs = await import("fs/promises");
  // git: 的 fsPath 指向工作区文件，直接 fs 会读到新内容，必须走 git 扩展
  if (uri.scheme === "file" || uri.scheme === "vscode-remote") {
    try {
      return await fs.readFile(uri.fsPath);
    } catch {
      return null;
    }
  }
  return readGitBytes(uri);
}

/** 通过 git 子进程读取某个 ref 下的原始字节（xlsx/docx 是二进制，不能用字符串） */
async function readGitBytes(uri: DiffUri): Promise<Buffer | null> {
  const fs = await import("fs/promises");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  let ref = "";
  const candidates: string[] = [];
  try {
    const parsed = new URL(uri.toString());
    ref = parsed.searchParams.get("ref") || "";
    const fromQuery = parsed.searchParams.get("path") || "";
    if (fromQuery) candidates.push(decodeURIComponent(fromQuery).replace(/^\/+/, ""));
  } catch { /* 忽略 */ }
  if (uri.path) candidates.push(String(uri.path).replace(/^\/+/, ""));
  if (uri.fsPath) candidates.push(uri.fsPath);

  const show = async (cwd: string, relative: string): Promise<Buffer | null> => {
    try {
      const { stdout } = await run("git", ["show", `${ref || "HEAD"}:${relative}`], {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer" as unknown as "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return Buffer.isBuffer(stdout) && stdout.length ? stdout : null;
    } catch {
      return null;
    }
  };

  const absolute = candidates.find((item) => path.isAbsolute(item)) || uri.fsPath || "";
  if (absolute) {
    let dir = path.dirname(path.resolve(absolute));
    for (let i = 0; i < 12; i += 1) {
      const hasGit = await fs.access(path.join(dir, ".git")).then(() => true, () => false);
      if (hasGit) {
        const relative = path.relative(dir, path.resolve(absolute)).split(path.sep).join("/");
        const bytes = await show(dir, relative);
        if (bytes) return bytes;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri.toString()));
    return Buffer.from(doc.getText(), "utf8");
  } catch {
    return null;
  }
}

async function showExcelDiff(file: string): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const root = folder?.uri.fsPath || path.dirname(file);
  let diff: WorkbookDiff;
  try {
    diff = await diffWorkbook(root, file);
  } catch (error) {
    void vscode.window.showErrorMessage(`读取 Excel 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await openDiffTab(diff, path.basename(file));
}

async function showExcelDiffByUris(
  left?: vscode.Uri,
  right?: vscode.Uri,
  column?: vscode.ViewColumn,
): Promise<void> {
  const leftUri = left || (vscode.window.activeTextEditor?.document.uri ?? undefined);
  const rightUri = right || (vscode.window.activeTextEditor?.document.uri ?? undefined);
  if (!leftUri || !rightUri) {
    void vscode.window.showWarningMessage("没有拿到要对比的两个版本。");
    return;
  }
  let diff: WorkbookDiff;
  try {
    diff = await diffWorkbookByUris(readBytes, leftUri, rightUri);
  } catch (error) {
    void vscode.window.showErrorMessage(`读取 Excel 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const name = path.basename(rightUri.fsPath || rightUri.path || "excel");
  await openDiffTab(diff, name, column);
}

/** 供自定义编辑器调用：直接渲染「历史 vs 工作区」对比页（复用同一个面板） */
export async function openExcelCompare(
  history: vscode.Uri,
  working: vscode.Uri,
  column?: vscode.ViewColumn,
): Promise<void> {
  await closeExcelTextDiffs();
  await showExcelDiffByUris(history, working, column);
}

/** 复用的差异面板：同一时间只保留一个差异标签 */
let diffPanel: vscode.WebviewPanel | undefined;

/** 把差异渲染成一张 HTML 表并作为差异标签页打开（复用已有面板，不堆标签） */
async function openDiffTab(diff: WorkbookDiff, name: string, column?: vscode.ViewColumn): Promise<void> {
  if (!diff.ok) {
    void vscode.window.showWarningMessage(diff.error || "无法生成 Excel 差异");
    return;
  }
  if (!diff.sheets.length) {
    void vscode.window.showWarningMessage("这个文件里没有可对比的 Sheet。");
    return;
  }
  if (!diff.changedSheets.length) {
    void vscode.window.showInformationMessage(`${name}：与对比版本没有差异。`);
    if (diffPanel) {
      diffPanel.dispose();
      diffPanel = undefined;
    }
    return;
  }
  const title = `${name} · ExcelView 差异`;
  const target = column || vscode.ViewColumn.Active;
  if (diffPanel) {
    if (diffPanel.viewColumn === target) {
      // 同一列：直接把内容换掉并激活，标签数不变
      diffPanel.title = title;
      diffPanel.webview.html = renderDiffHtml(diff, name);
      diffPanel.reveal(target, false);
      return;
    }
    // 换了列（点了另一个工作区的 Excel）：关掉旧的，在新的当前列重建一个
    diffPanel.dispose();
    diffPanel = undefined;
  }
  diffPanel = vscode.window.createWebviewPanel(
    "protoview.excelDiffView",
    title,
    target,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  diffPanel.onDidDispose(() => { diffPanel = undefined; });
  diffPanel.webview.html = renderDiffHtml(diff, name);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnLetter(index: number): string {
  let n = Number(index) || 0;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function renderDiffHtml(diff: WorkbookDiff, name: string): string {
  const first = diff.changedSheets[0];
  const tabs = diff.sheets.map((sheet) => (
    `<button type="button" data-sheet="${escapeHtml(sheet.sheet)}"${sheet.sheet === first.sheet ? ' class="active"' : ""}>${escapeHtml(sheet.sheet)}${sheet.changedRows ? ` (${sheet.changedRows})` : ""}</button>`
  )).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body { margin: 0; display: flex; flex-direction: column; min-height: 0;
      font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground);
      background: var(--vscode-editor-background); }
    .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap; flex: 0 0 auto;
      border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
    .bar strong { font-size: 12px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar .spacer { flex: 1 1 auto; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
    label { font-size: 11px; color: var(--vscode-descriptionForeground); display: inline-flex; gap: 4px; align-items: center; }
    .tabs { display: flex; gap: 4px; padding: 6px 10px; flex-wrap: wrap; flex: 0 0 auto;
      border-bottom: 1px solid var(--vscode-panel-border); }
    button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; }
    .col { min-width: 0; min-height: 0; display: flex; flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border); }
    .col:last-child { border-right: 0; }
    .col-head { flex: 0 0 auto; padding: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground);
      background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
    table { border-collapse: collapse; font: 12px/1.4 var(--vscode-editor-font-family, monospace); }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; white-space: pre; vertical-align: top; }
    th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 1; }
    td.rowno, th.rowno { color: var(--vscode-descriptionForeground); text-align: right; position: sticky; left: 0;
      background: var(--vscode-editorWidget-background); z-index: 1; }
    td.cell-add { background: rgba(46, 160, 67, .30); }
    td.cell-del { background: rgba(248, 81, 73, .30); }
    td.cell-change { background: rgba(240, 180, 0, .34); }
    .empty { padding: 18px; color: var(--vscode-descriptionForeground); }
  </style></head><body>
  <div class="bar">
    <strong>${escapeHtml(name)}</strong>
    <label><input type="checkbox" id="onlyDiff" checked /> 只看差异</label>
    <span class="hint" id="meta"></span>
    <span class="spacer"></span>
  </div>
  <div class="tabs">${tabs}</div>
  <div class="cols">
    <div class="col"><div class="col-head">对比版本</div><div class="scroll" id="left"></div></div>
    <div class="col"><div class="col-head">当前版本</div><div class="scroll" id="right"></div></div>
  </div>
  <script>
    const data = ${JSON.stringify(diff.sheets)};
    const leftEl = document.getElementById("left");
    const rightEl = document.getElementById("right");
    const metaEl = document.getElementById("meta");
    const onlyDiffEl = document.getElementById("onlyDiff");
    let active = ${JSON.stringify(first.sheet)};
    function columnLetter(i) {
      let n = Number(i) || 0, out = "";
      do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
      return out;
    }
    function esc(v) {
      return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function render() {
      const sheet = data.find((s) => s.sheet === active) || data[0];
      if (!sheet) return;
      const onlyDiff = onlyDiffEl.checked;
      const rows = sheet.rows.filter((row) => !onlyDiff || row.type !== "same");
      const width = Math.max(1, ...rows.flatMap((row) => [row.left.length, row.right.length]));
      metaEl.textContent = sheet.sheet + " · " + sheet.changedRows + " 行有差异";
      const head = '<tr><th class="rowno">#</th>' + Array.from({ length: width }, (_, i) => '<th>' + columnLetter(i) + '</th>').join("") + '</tr>';
      const side = (row, isLeft) => {
        const values = isLeft ? row.left : row.right;
        const changed = new Map();
        for (const item of row.cells || []) {
          if (isLeft && item.type === "add") continue;
          if (!isLeft && item.type === "del") continue;
          changed.set(item.index, item.type);
        }
        let html = '<tr><td class="rowno">' + row.index + '</td>';
        for (let i = 0; i < width; i += 1) {
          const type = changed.get(i);
          const cls = type ? ' class="cell-' + type + '"' : "";
          html += '<td' + cls + '>' + esc(values[i] ?? "") + '</td>';
        }
        return html + '</tr>';
      };
      leftEl.innerHTML = '<table><thead>' + head + '</thead><tbody>' + (rows.map((row) => side(row, true)).join("") || '<tr><td class="empty">没有差异</td></tr>') + '</tbody></table>';
      rightEl.innerHTML = '<table><thead>' + head + '</thead><tbody>' + (rows.map((row) => side(row, false)).join("") || '<tr><td class="empty">没有差异</td></tr>') + '</tbody></table>';
    }
    document.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-sheet]");
      if (!tab) return;
      active = tab.getAttribute("data-sheet") || active;
      for (const el of document.querySelectorAll("[data-sheet]")) el.classList.toggle("active", el === tab);
      render();
    });
    onlyDiffEl.addEventListener("change", render);
    render();
    // 滚轮保持在内容区
    for (const el of [leftEl, rightEl]) el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  </script>
  </body></html>`;
}
