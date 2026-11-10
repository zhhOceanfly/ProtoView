import * as path from "path";
import * as vscode from "vscode";
import { docTextFromBuffer } from "./docIndex";
import { parseWorkbookBuffer, WorkbookSheetData } from "./excelIndex";
import { closeExcelTextDiffs, isOpenAsDiff, openExcelCompare } from "./excelDiffCommand";

/**
 * Excel / Docs 的自定义编辑器（Custom Editor）。
 * 关键点：
 * 1. 直接用 VS Code 的 document 内容（支持 git: 只读旧版本），不依赖目录扫描，
 *    所以 Git 左右对比里也能正常渲染；
 * 2. Excel 单元格可直接双击编辑，保存走 WorkspaceEdit 写回原文件；
 * 3. 顶部「在 ExcelView / DocsView Client 中编辑」会带文件路径跳到 webview 并定位。
 */

async function readDocumentBytes(document: vscode.CustomDocument & { uri: vscode.Uri }): Promise<Buffer> {
  return (await readUriBytes(document.uri)) || Buffer.alloc(0);
}
void readDocumentBytes;

/** 防止 Git diff 的左右两栏各触发一次对比页 */
let compareOpening = false;

class ExcelViewEditorProvider implements vscode.CustomEditorProvider {
  public static readonly viewType = "protoview.excelViewer";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      ExcelViewEditorProvider.viewType,
      new ExcelViewEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ExcelDocument>>();
  public readonly onDidChangeCustomDocument = this.changed.event;
  /** 当前打开过的编辑器面板，用于「与 git HEAD 对比」按钮 */
  public static panels = new Map<string, vscode.WebviewPanel>();

  public async openCustomDocument(uri: vscode.Uri): Promise<ExcelDocument> {
    const bytes = (await readUriBytes(uri)) || Buffer.alloc(0);
    return new ExcelDocument(uri, bytes);
  }

  private async readBytes(uri: vscode.Uri): Promise<Buffer> {
    return (await readUriBytes(uri)) || Buffer.alloc(0);
  }

  /** 读工作区里同一路径的当前版本，用于和 git 历史版本对比 */
  private async readWorking(fsPath: string): Promise<Buffer | null> {
    if (!fsPath) return null;
    const fs = await import("fs/promises");
    try {
      return await fs.readFile(fsPath);
    } catch {
      return null;
    }
  }

  public async saveCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    await document.save();
  }

  public async saveCustomDocumentAs(document: ExcelDocument, destination: vscode.Uri): Promise<void> {
    await document.saveAs(destination);
  }

  public async revertCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    document.revert();
  }

  public async backupCustomDocument(
    document: ExcelDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await this.saveCustomDocument(document, new vscode.CancellationTokenSource().token);
    return { id: context.destination.toString(), delete: () => undefined };
  }

  public async resolveCustomEditor(document: ExcelDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    // 在 Git 里"比较"打开时会走到这里：VS Code 已为左右两栏各建了一个自定义编辑器
    // 标签（旧版本 + 工作区）。继续各自渲染会出现重复表格，所以直接关掉这两栏，
    // 换成一张"对比状态"的差异页。
    // 普通双击打开不受影响：那种情况标签是 TabInputCustom，isOpenAsDiff 返回 false。
    if (document.uri.scheme !== "file" || isOpenAsDiff(document.uri)) {
      const working = vscode.Uri.file(document.uri.fsPath);
      const history = document.uri.scheme === "file" ? working : document.uri;
      // 左右两栏会各调一次 resolveCustomEditor，用标记保证只开一个对比页
      if (!compareOpening) {
        compareOpening = true;
        setTimeout(() => { compareOpening = false; }, 1500);
        panel.dispose();
        // 在当前活动列打开，让对比页直接顶替掉这个标签
        const column = vscode.window.tabGroups.activeTabGroup?.viewColumn
          || vscode.ViewColumn.Active;
        await openExcelCompare(history, working, column);
      } else {
        panel.dispose();
      }
      return;
    }
    const render = () => {
      panel.webview.html = renderExcelHtml(document);
    };
    render();
    ExcelViewEditorProvider.panels.set(document.uri.toString(), panel);
    panel.onDidDispose(() => ExcelViewEditorProvider.panels.delete(document.uri.toString()));
    panel.webview.onDidReceiveMessage(async (message: {
      type?: string;
      sheet?: string;
      row?: number;
      col?: number;
      value?: string;
    }) => {
      if (!message) return;
      if (message.type === "diffHead") {
        await vscode.commands.executeCommand("protoview.excelDiff", document.uri);
        return;
      }
      if (message.type === "openClient") {
        await openInClient("excel", document.uri.fsPath);
        return;
      }
      if (message.type === "selectSheet") {
        const name = String(message.sheet || "");
        if (name) {
          sheetMemory.set(document.uri.toString(), name);
          panel.webview.html = renderExcelHtml(document);
        }
        return;
      }
      if (message.type === "editCell") {
        const row = Number(message.row);
        const col = Number(message.col);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        const ok = document.setCell(String(message.sheet || ""), row, col, String(message.value ?? ""));
        if (ok) panel.webview.html = renderExcelHtml(document);
        panel.webview.postMessage({ type: "cellSaved", ok, row, col });
      }
    });
  }
}

class DocsViewEditorProvider implements vscode.CustomEditorProvider {
  public static readonly viewType = "protoview.docsViewer";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DocsViewEditorProvider.viewType,
      new DocsViewEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DocsDocument>>();
  public readonly onDidChangeCustomDocument = this.changed.event;

  public async openCustomDocument(uri: vscode.Uri): Promise<DocsDocument> {
    const text = await readDocsText(uri);
    return new DocsDocument(uri, text);
  }
  public async saveCustomDocument(document: DocsDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    await document.save();
  }

  public async saveCustomDocumentAs(document: DocsDocument, destination: vscode.Uri): Promise<void> {
    await document.saveAs(destination);
  }

  public async revertCustomDocument(document: DocsDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    document.revert();
  }

  public async backupCustomDocument(
    document: DocsDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    void document;
    return { id: context.destination.toString(), delete: () => undefined };
  }

  public async resolveCustomEditor(document: DocsDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderDocsHtml(document);
    panel.webview.onDidReceiveMessage(async (message: { type?: string; text?: string }) => {
      if (!message) return;
      if (message.type === "openClient") {
        await openInClient("docs", document.uri.fsPath);
        return;
      }
      if (message.type === "save") {
        document.setText(String(message.text ?? ""));
        await document.save();
        void vscode.window.showInformationMessage("已保存");
      }
    });
  }
}

/** 从任意 URI 读文档文本：file 直读，git: 走 git 扩展取历史内容 */
async function readDocsText(uri: vscode.Uri): Promise<string> {
  const bytes = await readUriBytes(uri);
  if (bytes) return docTextFromBuffer(bytes, uri.fsPath || uri.path);
  return "";
}

/**
 * 拿 URI 的原始字节。
 * 注意：git: 这类 URI 的 fsPath 指向的是「当前工作区文件」，直接 fs 读会拿到新内容，
 * 所以非 file scheme 必须先走 git 扩展取历史版本，不能先 fs。
 */
async function readUriBytes(uri: vscode.Uri): Promise<Buffer | null> {
  const fs = await import("fs/promises");
  if (uri.scheme === "file" || uri.scheme === "vscode-remote") {
    try {
      return await fs.readFile(uri.fsPath);
    } catch {
      return null;
    }
  }
  // 1) git 扩展：用 ref + 相对路径取历史内容
  const fromGit = await readGitBytes(uri);
  if (fromGit) return fromGit;
  // 2) 其他只读 scheme：退回 VS Code 文档（文本类文件有效）
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return Buffer.from(doc.getText(), "utf8");
  } catch {
    return null;
  }
}

/**
 * 读取 git 历史版本里的原始字节。
 * 注意两点：
 * 1. 不能用 vscode.git 的 repo.show()，它返回字符串，xlsx/docx 这类二进制会被破坏
 *    （表现为只解析出一行或读到空文档）；
 * 2. git: URI 的 fsPath 有时不可靠，路径优先从 URI 的 query 里取，再退回 fsPath。
 */
async function readGitBytes(uri: vscode.Uri): Promise<Buffer | null> {
  // 路径候选：query.path > uri.path（去掉前导 /）> fsPath
  const candidates: string[] = [];
  let ref = "";
  try {
    const query = uri.query ? JSON.parse(uri.query) : null;
    ref = String(query?.ref || query?.refName || "");
    if (query?.path) candidates.push(String(query.path).replace(/^\/+/, ""));
  } catch { /* query 不是 JSON */ }
  if (uri.path) candidates.push(uri.path.replace(/^\/+/, ""));
  if (uri.fsPath) candidates.push(uri.fsPath);

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs/promises");
  const run = promisify(execFile);

  const show = async (cwd: string, relative: string, revision: string): Promise<Buffer | null> => {
    try {
      const { stdout } = await run("git", ["show", `${revision}:${relative}`], {
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

  // 1) 从文件所在目录往上找仓库根，用相对路径取内容
  const startDir = (() => {
    const guess = candidates.find((item) => path.isAbsolute(item)) || uri.fsPath || "";
    return guess ? path.dirname(path.resolve(guess)) : "";
  })();
  if (startDir) {
    let dir = startDir;
    for (let i = 0; i < 12; i += 1) {
      const hasGit = await fs.access(path.join(dir, ".git")).then(() => true, () => false);
      if (hasGit) {
        const full = path.resolve(candidates.find((item) => path.isAbsolute(item)) || uri.fsPath);
        const relative = path.relative(dir, full).split(path.sep).join("/");
        const bytes = await show(dir, relative, ref || "HEAD");
        if (bytes) return bytes;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 2) 退回到 git 扩展给出的仓库根 + 相对路径
  try {
    const gitExt = vscode.extensions.getExtension("vscode.git");
    if (gitExt) {
      const api = await gitExt.activate();
      const repos = api?.getAPI?.(1)?.repositories || [];
      const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      for (const repo of repos) {
        const root = String(repo.rootUri?.fsPath || "");
        if (!root) continue;
        const bytes = await show(root, relative, ref || "HEAD");
        if (bytes) return bytes;
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 打开 Client 并定位到该文件对应的视图 */
async function openInClient(view: "excel" | "docs", file: string): Promise<void> {
  const command = view === "excel" ? "protoview.openExcelView" : "protoview.openDocsView";
  // 让快速入口命令拿到目标文件：临时把 URI 记在命令参数里
  await vscode.commands.executeCommand(command, vscode.Uri.file(file));
}

export { openInClient };

/** Excel 文档模型：持有内存中的工作表，改动后写回磁盘 */
class ExcelDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private buffer: Buffer;
  private sheetNames: string[] = [];
  public get sheetNameList(): string[] { return this.sheetNames.slice(); }
  private sheets = new Map<string, WorkbookSheetData>();
  private dirty = false;

  public constructor(uri: vscode.Uri, buffer: Buffer) {
    this.uri = uri;
    this.buffer = buffer;
    this.load(buffer);
  }

  private load(buffer: Buffer): void {
    const parsed = parseWorkbookBuffer(buffer);
    this.sheets.clear();
    this.sheetNames = parsed.map((sheet) => sheet.name);
    for (const sheet of parsed) this.sheets.set(sheet.name, sheet);
  }

  public names(): string[] {
    return this.sheetNames.slice();
  }

  public sheet(name: string): WorkbookSheetData | undefined {
    return this.sheets.get(name) || this.sheets.get(this.sheetNames[0]);
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  /** 设置单元格；行号是 Excel 的 1 基行号 */
  public setCell(sheetName: string, row: number, col: number, value: string): boolean {
    const sheet = this.sheet(sheetName);
    if (!sheet) return false;
    const rowIndex = row - 1 - (sheet.rowOffset || 0);
    if (rowIndex < 0 || rowIndex >= sheet.rows.length) return false;
    while (sheet.rows[rowIndex].length <= col) sheet.rows[rowIndex].push("");
    sheet.rows[rowIndex][col] = value;
    this.dirty = true;
    return true;
  }

  public async save(): Promise<void> {
    if (!this.dirty) return;
    const XLSX = await import("xlsx");
    const book = XLSX.read(this.buffer, { type: "buffer", cellDates: true, cellNF: true });
    for (const name of this.sheetNames) {
      const sheet = this.sheets.get(name);
      const ws = book.Sheets[name];
      if (!sheet || !ws) continue;
      for (let r = 0; r < sheet.rows.length; r += 1) {
        const absoluteRow = r + (sheet.rowOffset || 0);
        const cells = sheet.rows[r] || [];
        for (let c = 0; c < cells.length; c += 1) {
          const addr = XLSX.utils.encode_cell({ r: absoluteRow, c });
          const text = cells[c] ?? "";
          if (!text) delete ws[addr];
          else ws[addr] = { t: "s", v: text };
        }
      }
    }
    const out = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    const fs = await import("fs/promises");
    await fs.writeFile(this.uri.fsPath, out);
    this.buffer = out;
    this.dirty = false;
  }

  public async saveAs(destination: vscode.Uri): Promise<void> {
    const fs = await import("fs/promises");
    await fs.writeFile(destination.fsPath, this.buffer);
  }

  public revert(): void {
    this.load(this.buffer);
    this.dirty = false;
  }

  public dispose(): void { /* 无资源需要释放 */ }
}

/** Docs 文档模型：文本可直接改并保存（docx 只读） */
class DocsDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private text: string;
  private original: string;
  private dirty = false;

  public constructor(uri: vscode.Uri, text: string) {
    this.uri = uri;
    this.text = text;
    this.original = text;
  }

  public getText(): string {
    return this.text;
  }

  public setText(text: string): void {
    this.text = text;
    this.dirty = text !== this.original;
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  public async save(): Promise<void> {
    if (!this.dirty) return;
    const fs = await import("fs/promises");
    await fs.writeFile(this.uri.fsPath, this.text, "utf8");
    this.original = this.text;
    this.dirty = false;
  }

  public async saveAs(destination: vscode.Uri): Promise<void> {
    const fs = await import("fs/promises");
    await fs.writeFile(destination.fsPath, this.text, "utf8");
  }

  public revert(): void {
    this.text = this.original;
    this.dirty = false;
  }

  public dispose(): void { /* 无资源需要释放 */ }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function baseStyles(): string {
  return `
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; min-height: 0;
    font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background);
    flex: 0 0 auto; }
  .bar strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34%; }
  .bar .spacer { flex: 1 1 auto; }
  button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { opacity: .9; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .tabs { display: flex; gap: 4px; padding: 6px 10px; flex-wrap: wrap; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border); }
  .tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  /* 关键：内容区自己滚动，滚轮不会失效 */
  .wrap { flex: 1 1 auto; min-height: 0; overflow: auto; }
  table { border-collapse: collapse; font: 12px/1.4 var(--vscode-editor-font-family, monospace); }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; white-space: pre;
    vertical-align: top; min-width: 60px; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 1; }
  td.rowno, th.rowno { color: var(--vscode-descriptionForeground); text-align: right; position: sticky;
    left: 0; background: var(--vscode-editorWidget-background); z-index: 1; }
  td.editable:focus { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-editor-selectionBackground); }
  .diff-cell { background: rgba(240, 180, 0, .32); }
  pre { margin: 0; padding: 10px 14px; white-space: pre-wrap; word-break: break-word;
    font: 12.5px/1.65 var(--vscode-editor-font-family, monospace); }
  textarea { width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none; padding: 12px 14px;
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font: 12.5px/1.65 var(--vscode-editor-font-family, monospace); outline: none; }
  .empty { padding: 24px; color: var(--vscode-descriptionForeground); }
  .readonly-tip { color: var(--vscode-descriptionForeground); font-size: 11px; }
  `;
}

function renderExcelHtml(document: ExcelDocument): string {
  const names = document.names();
  // 记住当前 sheet：重新渲染时用上一次的选择
  const activeName = lastSheet(document.uri.toString()) || names[0] || "";
  const sheet = document.sheet(activeName);
  const readonly = document.uri.scheme !== "file";
  const tabs = names.map((name) => (
    `<button type="button" data-sheet="${escapeHtml(name)}"${name === activeName ? ' class="active"' : ""}>${escapeHtml(name)}</button>`
  )).join("");
  const width = Math.max(...(sheet?.rows || []).map((row) => row.length), 1);
  const head = sheet
    ? `<tr><th class="rowno">#</th>${Array.from({ length: width }, (_, i) => `<th>${columnLetter(i)}</th>`).join("")}</tr>`
    : "";
  const body = sheet
    ? sheet.rows.map((row, index) => {
      const excelRow = index + 1 + (sheet.rowOffset || 0);
      const cells = Array.from({ length: width }, (_, c) => {
        const value = row[c] ?? "";
        const cls = readonly ? "" : " editable";
        return `<td class="${cls.trim()}" data-row="${excelRow}" data-col="${c}"${readonly ? "" : ' contenteditable="true" spellcheck="false"'}>${escapeHtml(value)}</td>`;
      }).join("");
      return `<tr><td class="rowno">${excelRow}</td>${cells}</tr>`;
    }).join("")
    : "";
  const content = sheet
    ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
    : `<div class="empty">这个文件里没有可显示的 Sheet。</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}</style></head><body>
    <div class="bar">
      <strong>${escapeHtml(path.basename(document.uri.fsPath || document.uri.path))}</strong>
      <span class="hint">${sheet ? `${sheet.rows.length} 行` : ""}${readonly ? " · 只读（Git 历史版本）" : " · 双击单元格可直接修改"}</span>
      <span class="spacer"></span>
      ${readonly ? "" : '<button type="button" data-diff-head title="与 git HEAD 版本对比，高亮变化的单元格">与 git 对比</button>'}
      <button class="primary" type="button" data-open-client>在 ExcelView Client 中编辑</button>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="wrap">${content}</div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {}, getState: () => ({}), setState: () => {} }; }
      })();
      const uriKey = ${JSON.stringify(document.uri.toString())};
      const state = vscode.getState() || {};
      state.sheet = state.sheet || ${JSON.stringify(activeName)};
      vscode.setState(state);
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) {
          vscode.postMessage({ type: "openClient" });
          return;
        }
        if (event.target.closest("[data-diff-head]")) {
          vscode.postMessage({ type: "diffHead" });
          return;
        }
        const tab = event.target.closest("[data-sheet]");
        if (tab) {
          state.sheet = tab.getAttribute("data-sheet") || "";
          vscode.setState(state);
          vscode.postMessage({ type: "selectSheet", sheet: state.sheet });
        }
      });
      // 单元格：回车 / 失焦提交，Esc 还原
      let editing = null;
      document.addEventListener("focusin", (event) => {
        const cell = event.target.closest("td.editable");
        if (!cell) return;
        editing = { cell, before: cell.textContent || "" };
      });
      document.addEventListener("keydown", (event) => {
        const cell = event.target.closest?.("td.editable");
        if (!cell) return;
        if (event.key === "Enter") {
          event.preventDefault();
          cell.blur();
        }
        if (event.key === "Escape") {
          if (editing && editing.cell === cell) cell.textContent = editing.before;
          cell.blur();
        }
      });
      document.addEventListener("focusout", (event) => {
        const cell = event.target.closest?.("td.editable");
        if (!cell || !editing || editing.cell !== cell) return;
        const value = cell.textContent || "";
        const before = editing.before;
        editing = null;
        if (value === before) return;
        vscode.postMessage({
          type: "editCell",
          sheet: state.sheet,
          row: Number(cell.getAttribute("data-row")),
          col: Number(cell.getAttribute("data-col")),
          value,
        });
      });
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (data?.type === "cellSaved" && !data.ok) console.warn("保存单元格失败");
      });
      // 滚轮直达内容区，避免被 webview 外层吞掉
      document.querySelector(".wrap")?.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      void uriKey;
    </script>
  </body></html>`;
}

const sheetMemory = new Map<string, string>();
function lastSheet(key: string): string {
  return sheetMemory.get(key) || "";
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

/** Git 历史版本标签：左右并排对比，变化的单元格高亮 */
/** 单个版本（Git 历史 或 工作区）的只读表格；git 侧额外给「与 git 对比」入口 */
function renderVersionHtml(document: ExcelDocument, label: string): string {
  const names = document.sheetNameList;
  const activeName = lastSheet(document.uri.toString()) || names[0] || "";
  const sheet = document.sheet(activeName);
  const tabs = names.map((name) => (
    `<button type="button" data-sheet="${escapeHtml(name)}"${name === activeName ? ' class="active"' : ""}>${escapeHtml(name)}</button>`
  )).join("");
  const width = Math.max(...(sheet?.rows || []).map((row) => row.length), 1);
  const head = sheet
    ? `<tr><th class="rowno">#</th>${Array.from({ length: width }, (_, i) => `<th>${columnLetter(i)}</th>`).join("")}</tr>`
    : "";
  const body = sheet
    ? sheet.rows.map((row, index) => {
      const excelRow = index + 1 + (sheet.rowOffset || 0);
      const cells = Array.from({ length: width }, (_, c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("");
      return `<tr><td class="rowno">${excelRow}</td>${cells}</tr>`;
    }).join("")
    : "";
  const content = sheet
    ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
    : `<div class="empty">这个文件里没有可显示的 Sheet。</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}</style></head><body>
    <div class="bar">
      <strong>${escapeHtml(path.basename(document.uri.fsPath || document.uri.path))}</strong>
      <span class="hint">${label} · 只读</span>
      <span class="spacer"></span>
      <button type="button" data-diff-head title="打开单元格级差异对比">与 git 对比</button>
      <button class="primary" type="button" data-open-client>在 ExcelView Client 中编辑</button>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="wrap">${content}</div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {} }; }
      })();
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) {
          vscode.postMessage({ type: "openClient" });
          return;
        }
        if (event.target.closest("[data-diff-head]")) {
          vscode.postMessage({ type: "diffHead" });
          return;
        }
      });
    </script>
  </body></html>`;
}

/** 极简 Markdown → HTML：标题 / 列表 / 表格 / 代码块 / 引用 / 强调，够文档预览用 */
function markdownToHtml(text: string): string {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listType = "";
  let tableBuf: string[] = [];

  const inline = (raw: string): string => {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = "";
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter((row) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(row));
    const cellsOf = (row: string) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
    if (rows.length) {
      const head = cellsOf(rows[0]).map((cell) => `<th>${inline(cell)}</th>`).join("");
      const body = rows.slice(1).map((row) => `<tr>${cellsOf(row).map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    }
    tableBuf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  flushTable();
  closeList();
  return out.join("\n");
}

function renderDocsHtml(document: DocsDocument): string {
  const name = path.basename(document.uri.fsPath || document.uri.path);
  // docx 和 git 历史版本只读；md / markdown / mdx 与普通文本可阅读、可编辑、可分栏
  const binary = /\.docx$/i.test(document.uri.path);
  const readonly = document.uri.scheme !== "file" || binary;
  const isMarkdown = /\.(md|markdown|mdx|docx)$/i.test(document.uri.path);
  const text = document.getText();
  const tip = readonly ? "只读预览" : "阅读 / 编辑 / 分栏 · Ctrl+S 保存";
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}
      .doc-body { max-width: 860px; margin: 0 auto; padding: 22px 28px 60px;
        font: 14px/1.75 var(--vscode-font-family); color: var(--vscode-foreground); }
      .doc-body h1 { font-size: 1.7em; margin: 1.1em 0 .5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
      .doc-body h2 { font-size: 1.4em; margin: 1em 0 .45em; }
      .doc-body h3 { font-size: 1.18em; margin: .9em 0 .4em; }
      .doc-body h4, .doc-body h5, .doc-body h6 { font-size: 1em; margin: .8em 0 .35em; }
      .doc-body p { margin: .55em 0; }
      .doc-body ul, .doc-body ol { margin: .5em 0 .5em 1.4em; padding: 0; }
      .doc-body li { margin: .18em 0; }
      .doc-body blockquote { margin: .6em 0; padding: .2em .9em; border-left: 3px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground); }
      .doc-body code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em;
        background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: .1em .35em; }
      .doc-body pre { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 10px 12px;
        overflow: auto; white-space: pre; }
      .doc-body pre code { background: none; padding: 0; }
      .doc-body table { border-collapse: collapse; margin: .7em 0; font-size: .95em; }
      .doc-body th, .doc-body td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
      .doc-body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 1.2em 0; }
      .doc-body a { color: var(--vscode-textLink-foreground); }
      .modes { display: flex; gap: 4px; }
      .modes button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      #stage { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
      #stage.single { grid-template-columns: 1fr; }
      #stage > * { min-width: 0; min-height: 0; }
      #stage > #previewWrap { border-right: 1px solid var(--vscode-panel-border); }
      #stage.single > #previewWrap { border-right: 0; }
      #editor { width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none;
        padding: 12px 14px; background: var(--vscode-editor-background); color: var(--vscode-foreground);
        font: 12.5px/1.7 var(--vscode-editor-font-family, monospace); outline: none; }
      .hidden { display: none !important; }
    </style></head><body>
    <div class="bar">
      <strong>${escapeHtml(name)}</strong>
      <span class="hint">${tip}</span>
      <span class="spacer"></span>
      ${readonly ? "" : `<div class="modes">
            <button type="button" data-mode="preview">阅读</button>
            <button type="button" data-mode="edit">编辑</button>
            <button type="button" data-mode="split">分栏</button>
          </div>`}
      <button class="primary" type="button" data-open-client>在 DocsView Client 中编辑</button>
    </div>
    <div id="stage" class="single">
      <div class="wrap" id="previewWrap"><div class="doc-body" id="preview"></div></div>
      <textarea id="editor" spellcheck="false" class="hidden"></textarea>
    </div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {}, getState: () => ({}), setState: () => {} }; }
      })();
      const isMarkdown = ${isMarkdown ? "true" : "false"};
      const readonly = ${readonly ? "true" : "false"};
      const previewEl = document.getElementById("preview");
      const previewWrap = document.getElementById("previewWrap");
      const editorEl = document.getElementById("editor");
      const stage = document.getElementById("stage");
      let text = ${JSON.stringify(text)};
      editorEl.value = text;
      function escapeHtml(v) {
        return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function inline(raw) {
        let s = escapeHtml(raw);
        s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>");
        s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
        s = s.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img alt="$1" src="$2" />');
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
        return s;
      }
      function render(src) {
        const lines = String(src || "").split("\\n");
        const out = [];
        let inCode = false, code = [], list = "", table = [];
        const closeList = () => { if (list) { out.push("</" + list + ">"); list = ""; } };
        const flushTable = () => {
          if (!table.length) return;
          const rows = table.filter((r) => !/^\\s*\\|?[\\s:-]+\\|[\\s:|-]*$/.test(r));
          const cellsOf = (r) => r.replace(/^\\s*\\|/, "").replace(/\\|\\s*$/, "").split("|").map((c) => c.trim());
          if (rows.length) {
            const head = cellsOf(rows[0]).map((c) => "<th>" + inline(c) + "</th>").join("");
            const body = rows.slice(1).map((r) => "<tr>" + cellsOf(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("");
            out.push("<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>");
          }
          table = [];
        };
        for (const line of lines) {
          if (/^\\s*\`\`\`/.test(line)) {
            if (inCode) { out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>"); code = []; inCode = false; }
            else { closeList(); inCode = true; }
            continue;
          }
          if (inCode) { code.push(line); continue; }
          if (/^\\s*\\|/.test(line)) { closeList(); table.push(line); continue; }
          flushTable();
          if (!line.trim()) { closeList(); continue; }
          const h = /^(#{1,6})\\s+(.*)$/.exec(line);
          if (h) { closeList(); out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); continue; }
          if (/^\\s*([-*_])\\1{2,}\\s*$/.test(line)) { closeList(); out.push("<hr />"); continue; }
          const q = /^\\s*>\\s?(.*)$/.exec(line);
          if (q) { closeList(); out.push("<blockquote>" + inline(q[1]) + "</blockquote>"); continue; }
          const b = /^\\s*[-*+]\\s+(.*)$/.exec(line);
          if (b) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(b[1]) + "</li>"); continue; }
          const o = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
          if (o) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(o[1]) + "</li>"); continue; }
          closeList();
          out.push("<p>" + inline(line) + "</p>");
        }
        if (inCode && code.length) out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>");
        flushTable();
        closeList();
        return out.join("\\n");
      }
      function paint() {
        previewEl.innerHTML = isMarkdown ? render(text) : "<pre>" + escapeHtml(text) + "</pre>";
      }
      function setMode(mode) {
        const next = readonly ? "preview" : mode;
        for (const btn of document.querySelectorAll("[data-mode]")) btn.classList.toggle("active", btn.getAttribute("data-mode") === next);
        previewWrap.classList.toggle("hidden", next === "edit");
        editorEl.classList.toggle("hidden", next === "preview");
        stage.classList.toggle("single", next !== "split");
        if (next !== "edit") paint();
      }
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) { vscode.postMessage({ type: "openClient" }); return; }
        const btn = event.target.closest("[data-mode]");
        if (btn) setMode(btn.getAttribute("data-mode"));
      });
      editorEl.addEventListener("input", () => {
        text = editorEl.value;
        if (stage.classList.contains("single") === false) paint();
      });
      document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (readonly) return;
          vscode.postMessage({ type: "save", text: editorEl.value });
        }
      });
      setMode(readonly ? "preview" : (isMarkdown ? "split" : "preview"));
      for (const el of [previewWrap, editorEl]) el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    </script>
  </body></html>`;
}

export function registerCustomViewers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    ExcelViewEditorProvider.register(context),
    DocsViewEditorProvider.register(context),
  );
}
