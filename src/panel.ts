import * as vscode from "vscode";
import { Catalog } from "./catalog";
import { PAGE_CSS, renderPage } from "./render";

export class ProtoPanel {
  private panel: vscode.WebviewPanel | undefined;
  private history: string[] = [];
  private catalog: Catalog | undefined;
  private ready = false;
  private currentId = "home";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onNavigate: (id: string) => void,
  ) {}

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
    if (current !== "home" && current !== "ai" && !catalog.byId.has(current)) {
      this.history = ["home"];
      this.post("home");
      return;
    }
    this.post(current);
  }

  private ensure(): void {
    if (this.panel) return;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel("protoview.preview", "ProtoView", {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
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
    this.panel.title = id === "ai" ? "AI · 山海" : item && "name" in item ? item.name : "ProtoView";
    const qrUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "donate-wechat.png"));
    this.panel.webview.postMessage({
      type: "html",
      html: renderPage(this.catalog, id, this.history.length > 1, { qrUrl: qrUri.toString() }),
      page: id,
    });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      "default-src 'none'",
      `img-src ${this.panel!.webview.cspSource} data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');

    window.addEventListener('message', (event) => {
      if (!event.data || event.data.type !== 'html') return;
      app.innerHTML = event.data.html;
      if (event.data.page === 'ai') bootAiPage();
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

    function bootAiPage() {
      const root = document.getElementById('ai-root');
      const board = document.getElementById('ai-board');
      const reward = document.getElementById('ai-reward');
      const qr = document.getElementById('ai-qr');
      const shuffleBtn = document.getElementById('ai-shuffle');
      if (!root || !board || !reward || !qr || !shuffleBtn) return;

      const target = ['山', '海', '平', '爱'];
      let tiles = shuffle(target.slice());
      let selected = -1;
      let solved = false;
      qr.src = root.getAttribute('data-qr') || '';

      const render = () => {
        board.innerHTML = '';
        tiles.forEach((label, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ai-tile' + (solved ? ' done' : '') + (selected === index ? ' selected' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            if (solved) return;
            if (selected < 0) {
              selected = index;
            } else if (selected === index) {
              selected = -1;
            } else {
              const a = selected;
              const tmp = tiles[a];
              tiles[a] = tiles[index];
              tiles[index] = tmp;
              selected = -1;
              if (tiles.join('') === target.join('')) {
                solved = true;
                reward.classList.remove('hidden');
              }
            }
            render();
          });
          board.appendChild(btn);
        });
      };

      shuffleBtn.addEventListener('click', () => {
        if (solved) return;
        tiles = shuffle(target.slice());
        selected = -1;
        render();
      });

      render();
    }

    function shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
      if (list.join('') === '山海平爱') return shuffle(list);
      return list;
    }

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
