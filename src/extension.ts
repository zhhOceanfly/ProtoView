import * as path from "path";
import * as vscode from "vscode";
import { Catalog, buildCatalog, findSymbolAt } from "./catalog";
import { openSource, ProtoPanel } from "./panel";
import { ProtoParseError, parseProto } from "./parser";
import { ProtoNode, ProtoTree } from "./tree";

let catalog: Catalog | undefined;
const output = vscode.window.createOutputChannel("ProtoView");

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ProtoTree(undefined, true, showGoogle());
  const view = vscode.window.createTreeView("protoview.explorer", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const panel = new ProtoPanel((id) => {
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
    vscode.commands.registerCommand("protoview.refresh", () => void reload(tree, panel, status)),
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
        tree.update(catalog, false, showGoogle());
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.proto");
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(tree, panel, status), 250);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void reload(tree, panel, status)),
  );

  void reload(tree, panel, status);
}

async function reload(tree: ProtoTree, panel: ProtoPanel, status: vscode.StatusBarItem): Promise<void> {
  tree.update(catalog, true, showGoogle());
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    catalog = buildCatalog([], []);
    tree.update(catalog, false, showGoogle());
    status.text = "$(symbol-namespace) Proto 未打开文件夹";
    status.tooltip = "调试窗口没有工作区，ProtoView 无法读取 .proto";
    void vscode.window.showWarningMessage("ProtoView 没有打开工作区。请停止调试后重新按 F5，或在这个窗口里打开含 .proto 的文件夹。");
    return;
  }
  const root = folders[0].uri.fsPath;
  const uris = await vscode.workspace.findFiles("**/*.proto", "**/{node_modules,.git,out}/**");
  const errors: { file: string; message: string }[] = [];
  const files = [];
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const relPath = root ? path.relative(root, uri.fsPath) : uri.fsPath;
    try {
      files.push(parseProto(Buffer.from(bytes).toString("utf8"), uri.fsPath, relPath));
    } catch (error) {
      const message = error instanceof ProtoParseError || error instanceof Error ? error.message : String(error);
      errors.push({ file: relPath, message });
      output.appendLine(`${relPath}: ${message}`);
    }
  }
  catalog = buildCatalog(files, errors);
  tree.update(catalog, false, showGoogle());
  panel.refresh(catalog);
  const visible = catalog.packages.filter((pkg) => showGoogle() || !pkg.wellKnown).length;
  status.text = `$(symbol-namespace) Proto ${visible}`;
  status.tooltip = errors.length ? `${errors.length} 个文件解析失败，见输出 ProtoView` : "打开 Proto 侧边栏";
  if (errors.length) output.show(true);
}

function showGoogle(): boolean {
  return vscode.workspace.getConfiguration("protoview").get<boolean>("showGoogle") === true;
}

export function deactivate(): void {
  catalog = undefined;
}
