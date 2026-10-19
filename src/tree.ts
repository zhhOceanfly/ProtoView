import * as vscode from "vscode";
import { Catalog, EnumView, MessageView, PackageView, RpcView, ServiceView } from "./catalog";
import { ProtoSourceConfig, sourceCacheDir, sourceSummary } from "./source";

export class ProtoNode extends vscode.TreeItem {
  parent?: ProtoNode;
  readonly children: ProtoNode[] = [];

  constructor(
    readonly treeId: string,
    label: string,
    readonly navId: string | undefined,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly source?: { file: string; line: number },
  ) {
    super(label, collapsible);
    this.id = treeId;
    if (source) this.contextValue = "source";
    if (navId) {
      this.command = {
        command: "protoview.show",
        title: "打开",
        arguments: [navId],
      };
    }
  }
}

export class ProtoTree implements vscode.TreeDataProvider<ProtoNode> {
  private roots: ProtoNode[] = [];
  private byNav = new Map<string, ProtoNode>();
  private readonly change = new vscode.EventEmitter<ProtoNode | undefined>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(
    private catalog: Catalog | undefined,
    private loading: boolean,
    private showGoogle: boolean,
    private sourceConfig?: ProtoSourceConfig,
  ) {}

  update(
    catalog: Catalog | undefined,
    loading: boolean,
    showGoogle: boolean,
    sourceConfig?: ProtoSourceConfig,
  ): void {
    this.catalog = catalog;
    this.loading = loading;
    this.showGoogle = showGoogle;
    if (sourceConfig) this.sourceConfig = sourceConfig;
    this.rebuild();
    this.change.fire(undefined);
  }

  getTreeItem(element: ProtoNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProtoNode): ProtoNode[] {
    if (!element) return this.roots;
    return element.children;
  }

  getParent(element: ProtoNode): ProtoNode | undefined {
    return element.parent;
  }

  nodeFor(navId: string): ProtoNode | undefined {
    return this.byNav.get(navId);
  }

  private rebuild(): void {
    this.byNav.clear();
    const sourceRoot = this.sourceSection();
    const clientEntry = this.clientEntry();
    if (this.loading) {
      const node = new ProtoNode("loading", "正在解析 Proto…", undefined, vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon("loading~spin");
      this.roots = [sourceRoot, clientEntry, node];
      return;
    }
    const packages = (this.catalog?.packages ?? []).filter((pkg) => this.showGoogle || !pkg.wellKnown);
    if (!packages.length) {
      const node = new ProtoNode("empty", "没有找到 .proto", "home", vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon("info");
      this.roots = [sourceRoot, clientEntry, node];
      return;
    }
    this.roots = [sourceRoot, clientEntry, ...packages.map((pkg) => this.packageNode(pkg))];
  }

  private clientEntry(): ProtoNode {
    const node = new ProtoNode(
      "client-entry",
      "打开 ProtoView Client",
      undefined,
      vscode.TreeItemCollapsibleState.None,
    );
    node.iconPath = new vscode.ThemeIcon("window");
    node.description = "接口调试台";
    node.tooltip = "左侧浏览全部 service/接口，右侧配置环境与请求（可独立部署，暂不使用数据库）";
    node.command = { command: "protoview.openClient", title: "打开 ProtoView Client" };
    return node;
  }

  private sourceSection(): ProtoNode {
    const config = this.sourceConfig ?? {
      mode: "workspace" as const,
      gitUrl: "",
      gitBranch: "main",
      localPath: "",
      lastError: "",
      lastLog: "",
      lastSyncedAt: 0,
    };
    const root = new ProtoNode(
      "source-root",
      "Proto 来源",
      undefined,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    root.iconPath = new vscode.ThemeIcon("repo");
    root.description = sourceSummary(config);
    root.contextValue = "sourceRoot";
    root.tooltip = config.mode === "workspace"
      ? "默认读取当前工作区中的 .proto"
      : (config.lastError || config.localPath || "使用 Git 仓库中的 .proto");

    const mode = new ProtoNode(
      "source-mode",
      config.mode === "workspace" ? "模式：工作区自动识别" : "模式：自定义 Git",
      undefined,
      vscode.TreeItemCollapsibleState.None,
    );
    mode.parent = root;
    mode.iconPath = new vscode.ThemeIcon(config.mode === "workspace" ? "folder-library" : "git-branch");
    mode.description = "点击切换";
    mode.command = { command: "protoview.toggleSourceMode", title: "切换来源模式" };
    root.children.push(mode);

    if (config.mode === "git") {
      const url = new ProtoNode(
        "source-git-url",
        "Git 地址",
        undefined,
        vscode.TreeItemCollapsibleState.None,
      );
      url.parent = root;
      url.iconPath = new vscode.ThemeIcon("link");
      url.description = config.gitUrl || "点击填写";
      url.tooltip = config.gitUrl || "填写仓库地址，例如 https://github.com/org/repo.git";
      url.command = { command: "protoview.editGitUrl", title: "编辑 Git 地址" };
      root.children.push(url);

      const branch = new ProtoNode(
        "source-git-branch",
        "分支",
        undefined,
        vscode.TreeItemCollapsibleState.None,
      );
      branch.parent = root;
      branch.iconPath = new vscode.ThemeIcon("git-branch");
      branch.description = config.gitBranch || "main";
      branch.command = { command: "protoview.editGitBranch", title: "编辑分支" };
      root.children.push(branch);

      const tempPath = config.localPath || (config.gitUrl ? sourceCacheDir(config.gitUrl) : "");
      const temp = new ProtoNode(
        "source-git-temp",
        "临时目录",
        undefined,
        vscode.TreeItemCollapsibleState.None,
      );
      temp.parent = root;
      temp.iconPath = new vscode.ThemeIcon("folder");
      temp.description = tempPath || "填写地址后生成";
      temp.tooltip = tempPath
        ? `${tempPath}\n点击复制路径，并在资源管理器中打开`
        : "同步时会克隆到系统临时目录";
      temp.command = { command: "protoview.openGitTemp", title: "打开临时目录" };
      root.children.push(temp);

      const sync = new ProtoNode(
        "source-git-sync",
        config.lastError ? "同步失败，点击重试" : (config.localPath ? "重新拉取" : "拉取到临时目录"),
        undefined,
        vscode.TreeItemCollapsibleState.None,
      );
      sync.parent = root;
      sync.iconPath = new vscode.ThemeIcon(config.lastError ? "error" : "cloud-download");
      sync.description = config.lastSyncedAt
        ? new Date(config.lastSyncedAt).toLocaleString()
        : undefined;
      sync.tooltip = config.lastError || tempPath || "克隆或更新到系统临时目录";
      sync.command = { command: "protoview.syncGitSource", title: "同步 Git 来源" };
      root.children.push(sync);

      const logs = new ProtoNode(
        "source-git-log",
        config.lastError ? "查看拉取日志（失败）" : "查看拉取日志",
        undefined,
        vscode.TreeItemCollapsibleState.None,
      );
      logs.parent = root;
      logs.iconPath = new vscode.ThemeIcon(config.lastError ? "warning" : "output");
      logs.description = config.lastLog ? `${config.lastLog.split(/\r?\n/).length} 行` : "暂无";
      logs.tooltip = config.lastError || "在输出面板 ProtoView 中查看完整 git 日志";
      logs.command = { command: "protoview.showGitLog", title: "查看拉取日志" };
      root.children.push(logs);
    }

    return root;
  }

  private packageNode(pkg: PackageView): ProtoNode {
    const node = this.make(
      pkg.id,
      pkg.name,
      pkg.id,
      vscode.TreeItemCollapsibleState.Collapsed,
      pkg.files[0] ? { file: pkg.files[0].path, line: 1 } : undefined,
    );
    node.description = `${pkg.services.length} service · ${pkg.messages.length} msg`;
    node.iconPath = new vscode.ThemeIcon("package");
    for (const service of pkg.services) node.children.push(this.serviceNode(service, node));
    if (pkg.messages.length) node.children.push(this.group(node, `${pkg.id}:messages`, "消息", pkg.messages.map((item) => this.messageNode(item, node))));
    if (pkg.enums.length) node.children.push(this.group(node, `${pkg.id}:enums`, "枚举", pkg.enums.map((item) => this.enumNode(item, node))));
    return node;
  }

  private serviceNode(service: ServiceView, parent: ProtoNode): ProtoNode {
    const node = this.make(
      service.id,
      service.name,
      service.id,
      service.rpcs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      { file: service.file, line: service.line },
    );
    node.parent = parent;
    node.description = String(service.rpcs.length);
    node.iconPath = new vscode.ThemeIcon("symbol-interface");
    node.tooltip = service.relPath;
    for (const rpc of service.rpcs) node.children.push(this.rpcNode(rpc, node));
    return node;
  }

  private rpcNode(rpc: RpcView, parent: ProtoNode): ProtoNode {
    const node = this.make(
      rpc.id,
      rpc.name,
      rpc.id,
      vscode.TreeItemCollapsibleState.Collapsed,
      { file: rpc.file, line: rpc.line },
    );
    node.parent = parent;
    const signature = `${shortType(rpc.request.text)} → ${shortType(rpc.response.text)}`;
    const comment = firstLine(rpc.comment);
    node.description = comment ? `${comment} · ${signature}` : signature;
    node.iconPath = new vscode.ThemeIcon("symbol-method");
    node.tooltip = comment ? `${rpc.name}\n${comment}\n${signature}` : `${rpc.name}\n${signature}`;
    node.children.push(this.typeNode(node, `${rpc.id}:req`, "请求", rpc.request.text, rpc.request.navId, rpc.file, rpc.line));
    node.children.push(this.typeNode(node, `${rpc.id}:resp`, "响应", rpc.response.text, rpc.response.navId, rpc.file, rpc.line));
    return node;
  }

  private typeNode(parent: ProtoNode, treeId: string, role: string, typeName: string, navId: string | undefined, file: string, line: number): ProtoNode {
    let source = { file, line };
    const linked = navId ? this.catalog?.byId.get(navId) : undefined;
    if (linked && "file" in linked && "line" in linked) source = { file: linked.file, line: linked.line };
    const fields = linked && "fields" in linked ? linked.fields : [];
    const node = this.make(
      treeId,
      typeName,
      navId ?? parent.navId,
      fields.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      source,
    );
    node.parent = parent;
    node.description = role;
    node.iconPath = new vscode.ThemeIcon("symbol-structure");
    for (const field of fields) {
      const fieldNav = field.value.navId ?? field.key?.navId ?? navId;
      const child = this.make(
        `${treeId}:${field.number}:${field.name}`,
        field.name,
        fieldNav,
        vscode.TreeItemCollapsibleState.None,
        { file: field.file, line: field.line },
      );
      child.parent = node;
      const typeLabel = `${field.prefix ? `${field.prefix} ` : ""}${field.key ? `map<${field.key.text}, ${field.value.text}>` : field.value.text}`;
      child.description = field.oneof ? `${typeLabel} · ${field.oneof}` : typeLabel;
      child.tooltip = field.comment || typeLabel;
      child.iconPath = new vscode.ThemeIcon("symbol-field");
      node.children.push(child);
    }
    return node;
  }

  private messageNode(message: MessageView, parent: ProtoNode): ProtoNode {
    const node = this.make(
      `tree:${message.id}`,
      message.fullName,
      message.id,
      vscode.TreeItemCollapsibleState.None,
      { file: message.file, line: message.line },
    );
    node.parent = parent;
    node.description = message.comment || undefined;
    node.iconPath = new vscode.ThemeIcon("symbol-struct");
    this.byNav.set(message.id, node);
    return node;
  }

  private enumNode(item: EnumView, parent: ProtoNode): ProtoNode {
    const node = this.make(
      `tree:${item.id}`,
      item.fullName,
      item.id,
      vscode.TreeItemCollapsibleState.None,
      { file: item.file, line: item.line },
    );
    node.parent = parent;
    node.description = item.comment || `${item.values.length}`;
    node.iconPath = new vscode.ThemeIcon("symbol-enum");
    this.byNav.set(item.id, node);
    return node;
  }

  private group(parent: ProtoNode, treeId: string, label: string, children: ProtoNode[]): ProtoNode {
    const node = new ProtoNode(treeId, label, undefined, vscode.TreeItemCollapsibleState.Collapsed);
    node.parent = parent;
    node.description = String(children.length);
    node.iconPath = new vscode.ThemeIcon(label === "枚举" ? "symbol-enum" : "symbol-struct");
    for (const child of children) {
      child.parent = node;
      node.children.push(child);
    }
    return node;
  }

  private make(treeId: string, label: string, navId: string | undefined, state: vscode.TreeItemCollapsibleState, source?: { file: string; line: number }): ProtoNode {
    const node = new ProtoNode(treeId, label, navId, state, source);
    if (navId && !this.byNav.has(navId)) this.byNav.set(navId, node);
    return node;
  }
}

function shortType(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] || name;
}

function firstLine(comment: string): string {
  return comment.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
