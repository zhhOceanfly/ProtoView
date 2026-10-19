import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Catalog, buildCatalog, findSymbolAt } from "./catalog";
import { ClientPanel } from "./clientPanel";
import { openSource, ProtoPanel } from "./panel";
import { ProtoParseError, parseProto } from "./parser";
import {
  ProtoSourceConfig,
  collectProtoFiles,
  loadSourceConfig,
  saveSourceConfig,
  sourceCacheDir,
  syncGitSource,
} from "./source";
import { registerLanguageFeatures } from "./language";
import { ProtoNode, ProtoTree } from "./tree";

let catalog: Catalog | undefined;
let sourceConfig: ProtoSourceConfig;
let extensionContext: vscode.ExtensionContext;
let clientPanel: ClientPanel;
const output = vscode.window.createOutputChannel("ProtoView");

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  sourceConfig = loadSourceConfig(context);
  clientPanel = new ClientPanel(context.extensionUri);

  const tree = new ProtoTree(undefined, true, showGoogle(), sourceConfig);
  clientPanel.setRefreshHandler(() => {
    void reload(tree, panel, status, sourceConfig.mode === "git");
  });
  const view = vscode.window.createTreeView("protoview.explorer", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const panel = new ProtoPanel(context.extensionUri, (id) => {
    const node = tree.nodeFor(id);
    if (node) void view.reveal(node, { select: true, focus: false, expand: true });
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "protoview.explorer.focus";
  status.show();

  context.subscriptions.push(
    view,
    output,
    status,
    vscode.commands.registerCommand("protoview.show", (id?: string) => {
      if (!catalog) return;
      panel.show(catalog, id || "home");
    }),
    vscode.commands.registerCommand("protoview.openSource", (node?: ProtoNode) => {
      const target = node?.source ?? view.selection[0]?.source;
      if (target) void openSource(target.file, target.line);
    }),
    vscode.commands.registerCommand("protoview.refresh", () => void reload(tree, panel, status, true)),
    vscode.commands.registerCommand("protoview.toggleSourceMode", () => void toggleSourceMode(tree, panel, status)),
    vscode.commands.registerCommand("protoview.editGitUrl", () => void editGitUrl(tree, panel, status)),
    vscode.commands.registerCommand("protoview.editGitBranch", () => void editGitBranch(tree, panel, status)),
    vscode.commands.registerCommand("protoview.syncGitSource", () => void reload(tree, panel, status, true)),
    vscode.commands.registerCommand("protoview.showGitLog", () => showGitLog()),
    vscode.commands.registerCommand("protoview.openGitTemp", () => void openGitTemp()),
    vscode.commands.registerCommand("protoview.openClient", () => {
      if (!catalog) {
        void vscode.window.showWarningMessage("请先完成 Proto 解析，再打开 ProtoView Client。");
        return;
      }
      clientPanel.open(catalog, sourceLabel(), showGoogle());
    }),
    vscode.commands.registerCommand("protoview.showAtCursor", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !catalog) return;
      const id = findSymbolAt(catalog, editor.document.uri.fsPath, editor.selection.active.line + 1);
      panel.show(catalog, id ?? "home");
      if (id) {
        const node = tree.nodeFor(id);
        if (node) void view.reveal(node, { select: true, focus: false, expand: true });
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("protoview.showGoogle")) {
        tree.update(catalog, false, showGoogle(), sourceConfig);
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.proto");
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (sourceConfig.mode !== "workspace") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(tree, panel, status, false), 250);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (sourceConfig.mode === "workspace") void reload(tree, panel, status, false);
    }),
  );

  registerLanguageFeatures(context, () => catalog);

  void reload(tree, panel, status, sourceConfig.mode === "git");
}

async function toggleSourceMode(
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "工作区自动识别",
        description: "扫描当前打开项目中的 .proto",
        mode: "workspace" as const,
      },
      {
        label: "自定义 Git 来源",
        description: "填写仓库地址和分支，拉取到系统临时目录",
        mode: "git" as const,
      },
    ],
    { title: "选择 Proto 来源", placeHolder: "Proto 来源" },
  );
  if (!pick) return;
  sourceConfig = { ...sourceConfig, mode: pick.mode, lastError: "" };
  await saveSourceConfig(extensionContext, sourceConfig);
  if (pick.mode === "git" && !sourceConfig.gitUrl) {
    await editGitUrl(tree, panel, status);
    return;
  }
  await reload(tree, panel, status, pick.mode === "git");
}

async function editGitUrl(
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "Proto Git 地址",
    prompt: "支持 https / ssh，例如 https://github.com/org/repo.git",
    value: sourceConfig.gitUrl,
    ignoreFocusOut: true,
    validateInput: (text) => {
      const url = text.trim();
      if (!url) return "地址不能为空";
      if (!/^https?:\/\/|^git@|^ssh:\/\//i.test(url)) return "请输入有效的 Git 地址";
      return undefined;
    },
  });
  if (value === undefined) return;
  sourceConfig = {
    ...sourceConfig,
    mode: "git",
    gitUrl: value.trim(),
    localPath: "",
    lastError: "",
    lastSyncedAt: 0,
  };
  await saveSourceConfig(extensionContext, sourceConfig);
  if (!sourceConfig.gitBranch) {
    await editGitBranch(tree, panel, status);
    return;
  }
  await reload(tree, panel, status, true);
}

async function editGitBranch(
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "Proto Git 分支",
    prompt: "例如 main、master、develop",
    value: sourceConfig.gitBranch || "main",
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? undefined : "分支不能为空"),
  });
  if (value === undefined) return;
  sourceConfig = {
    ...sourceConfig,
    mode: "git",
    gitBranch: value.trim(),
    lastError: "",
  };
  await saveSourceConfig(extensionContext, sourceConfig);
  await reload(tree, panel, status, true);
}

async function reload(
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
  syncGit: boolean,
): Promise<void> {
  tree.update(catalog, true, showGoogle(), sourceConfig);
  status.text = "$(sync~spin) ProtoView 加载中";

  try {
    if (sourceConfig.mode === "git") {
      if (syncGit || !sourceConfig.localPath) {
        output.appendLine("");
        output.show(true);
        sourceConfig = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "ProtoView 正在拉取 Git Proto…",
            cancellable: false,
          },
          async () => syncGitSource(sourceConfig, (line) => output.appendLine(line)),
        );
        await saveSourceConfig(extensionContext, sourceConfig);
        if (sourceConfig.lastError) {
          catalog = buildCatalog([], [{ file: "git", message: sourceConfig.lastError }]);
          tree.update(catalog, false, showGoogle(), sourceConfig);
          panel.refresh(catalog);
          status.text = "$(error) ProtoView Git 失败";
          status.tooltip = `${sourceConfig.lastError}\n临时目录: ${sourceConfig.localPath || sourceCacheDir(sourceConfig.gitUrl)}`;
          const temp = sourceConfig.localPath || sourceCacheDir(sourceConfig.gitUrl);
          const action = await vscode.window.showErrorMessage(
            `ProtoView 拉取失败：${sourceConfig.lastError}`,
            "查看日志",
            "复制临时目录",
          );
          if (action === "查看日志") showGitLog();
          if (action === "复制临时目录" && temp) {
            await vscode.env.clipboard.writeText(temp);
            void vscode.window.showInformationMessage(`已复制：${temp}`);
          }
          return;
        }
      }
      await loadFromDirectory(sourceConfig.localPath, tree, panel, status, sourceConfig.localPath);
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      catalog = buildCatalog([], []);
      tree.update(catalog, false, showGoogle(), sourceConfig);
      status.text = "$(symbol-namespace) ProtoView 未打开文件夹";
      status.tooltip = "工作区模式下需要打开含 .proto 的文件夹";
      void vscode.window.showWarningMessage("ProtoView 工作区模式需要先打开文件夹；也可切换到 Git 来源。");
      return;
    }
    await loadFromWorkspace(folders[0].uri.fsPath, tree, panel, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalog = buildCatalog([], [{ file: "reload", message }]);
    tree.update(catalog, false, showGoogle(), sourceConfig);
    status.text = "$(error) ProtoView 失败";
    status.tooltip = message;
    output.appendLine(message);
    output.show(true);
  }
}

async function loadFromWorkspace(
  root: string,
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const uris = await vscode.workspace.findFiles("**/*.proto", "**/{node_modules,.git,out}/**");
  const entries = uris.map((uri) => ({
    path: uri.fsPath,
    relPath: path.relative(root, uri.fsPath),
  }));
  await parseEntries(entries, tree, panel, status);
}

async function loadFromDirectory(
  root: string,
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
  labelRoot: string,
): Promise<void> {
  const entries = await collectProtoFiles(root);
  output.appendLine(`Git 来源：${labelRoot}，共 ${entries.length} 个 .proto`);
  await parseEntries(entries, tree, panel, status);
}

async function parseEntries(
  entries: { path: string; relPath: string }[],
  tree: ProtoTree,
  panel: ProtoPanel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const errors: { file: string; message: string }[] = [];
  const files = [];
  for (const entry of entries) {
    try {
      const text = await fs.readFile(entry.path, "utf8");
      files.push(parseProto(text, entry.path, entry.relPath));
    } catch (error) {
      const message = error instanceof ProtoParseError || error instanceof Error ? error.message : String(error);
      errors.push({ file: entry.relPath, message });
      output.appendLine(`${entry.relPath}: ${message}`);
    }
  }
  catalog = buildCatalog(files, errors);
  tree.update(catalog, false, showGoogle(), sourceConfig);
  panel.refresh(catalog);
  clientPanel.refresh(catalog, sourceLabel(), showGoogle());
  const visible = catalog.packages.filter((pkg) => showGoogle() || !pkg.wellKnown).length;
  const modeLabel = sourceConfig.mode === "git" ? "Git" : "工作区";
  status.text = `$(symbol-namespace) ProtoView ${visible}`;
  status.tooltip = errors.length
    ? `${modeLabel} · ${errors.length} 个文件解析失败，见输出 ProtoView`
    : `${modeLabel} · 打开 ProtoView 侧边栏`;
  if (errors.length) output.show(true);
}

function showGitLog(): void {
  output.appendLine("");
  output.appendLine("======== 最近一次 Git 同步日志 ========");
  if (sourceConfig.lastLog) {
    for (const line of sourceConfig.lastLog.split(/\r?\n/)) output.appendLine(line);
  } else {
    output.appendLine("(还没有同步记录，请先点击「重新拉取」)");
  }
  const temp = sourceConfig.localPath || (sourceConfig.gitUrl ? sourceCacheDir(sourceConfig.gitUrl) : "");
  if (temp) output.appendLine(`临时目录: ${temp}`);
  output.appendLine("======== 日志结束 ========");
  output.show(true);
}

async function openGitTemp(): Promise<void> {
  const temp = sourceConfig.localPath || (sourceConfig.gitUrl ? sourceCacheDir(sourceConfig.gitUrl) : "");
  if (!temp) {
    void vscode.window.showWarningMessage("请先填写 Git 地址，同步后才会生成临时目录。");
    return;
  }
  await vscode.env.clipboard.writeText(temp);
  try {
    await fs.mkdir(temp, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(temp));
  } catch {
    // ignore open failures; path is already copied
  }
  void vscode.window.showInformationMessage(`临时目录已复制：${temp}`);
}

function sourceLabel(): string {
  if (sourceConfig.mode === "git") {
    return `Git · ${sourceConfig.gitBranch || "main"} · ${sourceConfig.gitUrl || "未配置"}`;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.name;
  return folder ? `工作区 · ${folder}` : "工作区自动识别";
}

function showGoogle(): boolean {
  return vscode.workspace.getConfiguration("protoview").get<boolean>("showGoogle") === true;
}

export function deactivate(): void {
  catalog = undefined;
}
