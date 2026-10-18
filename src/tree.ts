import * as vscode from "vscode";
import { Catalog, EnumView, MessageView, PackageView, RpcView, ServiceView } from "./catalog";

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

  constructor(private catalog: Catalog | undefined, private loading: boolean, private showGoogle: boolean) {}

  update(catalog: Catalog | undefined, loading: boolean, showGoogle: boolean): void {
    this.catalog = catalog;
    this.loading = loading;
    this.showGoogle = showGoogle;
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
    if (this.loading) {
      const node = new ProtoNode("loading", "正在解析 Proto…", undefined, vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon("loading~spin");
      this.roots = [node];
      return;
    }
    const packages = (this.catalog?.packages ?? []).filter((pkg) => this.showGoogle || !pkg.wellKnown);
    if (!packages.length) {
      const node = new ProtoNode("empty", "没有找到 .proto", "home", vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon("info");
      this.roots = [node];
      return;
    }
    this.roots = packages.map((pkg) => this.packageNode(pkg));
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
