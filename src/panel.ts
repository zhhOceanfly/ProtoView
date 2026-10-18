import * as vscode from "vscode";
import { Catalog } from "./catalog";
import { PAGE_CSS, renderPage } from "./render";

export class ProtoPanel {
  private panel: vscode.WebviewPanel | undefined;
  private history: string[] = [];
  private catalog: Catalog | undefined;
  private ready = false;
  private currentId = "home";

  constructor(private readonly onNavigate: (id: string) => void) {}

  show(catalog: Catalog, id: string): void {
    this.catalog = catalog;
    this.ensure();
    if (this.history[this.history.length - 1] !== id) this.history.push(id);
    if (this.history.length > 40) this.history.splice(0, this.history.length - 40);
    this.post(id);
    this.panel?.reveal(vscode.ViewColumn.Beside, true);
  }

  refresh(catalog: Catalog): void {
    this.catalog = catalog;
    if (!this.panel) return;
    const current = this.history[this.history.length - 1] ?? "home";
    if (current !== "home" && !catalog.byId.has(current)) {
      this.history = ["home"];
      this.post("home");
      return;
    }
    this.post(current);
  }

  private ensure(): void {
    if (this.panel) return;
    this.panel = vscode.window.createWebviewPanel("protoview.preview", "Proto", {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.history = [];
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage(async (message: { type?: string; id?: string; file?: string; line?: string }) => {
      if (message.type === "ready") {
        this.ready = true;
        this.post(this.currentId);
        return;
      }
      if (message.type === "nav" && message.id) {
        this.show(this.catalog!, message.id);
        this.onNavigate(message.id);
        return;
      }
      if (message.type === "back") {
        if (this.history.length <= 1) return;
        this.history.pop();
        const id = this.history[this.history.length - 1] ?? "home";
        this.post(id);
        this.onNavigate(id);
        return;
      }
      if (message.type === "src" && message.file) {
        await openSource(decodeURIComponent(message.file), Number(message.line || 1));
      }
    });
    this.panel.webview.html = this.html();
  }

  private post(id: string): void {
    this.currentId = id;
    if (!this.panel || !this.catalog || !this.ready) return;
    const item = this.catalog.byId.get(id);
    const title = item && "name" in item ? item.name : "Proto";
    this.panel.title = title;
    this.panel.webview.postMessage({
      type: "html",
      html: renderPage(this.catalog, id, this.history.length > 1),
    });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'html') app.innerHTML = event.data.html;
    });
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const nav = target.closest('[data-nav]');
      if (nav) {
        vscode.postMessage({ type: 'nav', id: nav.getAttribute('data-nav') });
        return;
      }
      const src = target.closest('[data-src]');
      if (src) {
        vscode.postMessage({ type: 'src', file: src.getAttribute('data-src'), line: src.getAttribute('data-line') });
        return;
      }
      if (target.closest('[data-back]')) vscode.postMessage({ type: 'back' });
    });
    document.addEventListener('input', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.classList.contains('search')) return;
      const scope = input.parentElement;
      if (!scope) return;
      const query = input.value.trim().toLowerCase();
      for (const node of scope.querySelectorAll('[data-filter]')) {
        if (!(node instanceof HTMLElement)) continue;
        node.style.display = !query || (node.dataset.filter || '').includes(query) ? '' : 'none';
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export async function openSource(file: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
