import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Catalog } from "./catalog";
import {
  ClientEnvFile,
  defaultEnvFile,
  toClientCatalog,
} from "./clientModel";
import { GrpcInvokeRequest, invokeGrpc } from "./grpcInvoke";
import { openSource } from "./panel";

export class ClientPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private catalog: Catalog | undefined;
  private sourceLabel = "工作区";
  private showGoogle = false;
  private onRefresh: (() => void) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setRefreshHandler(handler: () => void): void {
    this.onRefresh = handler;
  }

  open(catalog: Catalog, sourceLabel: string, showGoogle: boolean): void {
    this.catalog = catalog;
    this.sourceLabel = sourceLabel;
    this.showGoogle = showGoogle;
    this.ensure();
    this.panel?.reveal(vscode.ViewColumn.Beside, false);
    if (this.ready) void this.postBootstrap();
  }

  refresh(catalog: Catalog, sourceLabel: string, showGoogle: boolean): void {
    this.catalog = catalog;
    this.sourceLabel = sourceLabel;
    this.showGoogle = showGoogle;
    if (this.panel && this.ready) void this.postBootstrap();
  }

  private ensure(): void {
    if (this.panel) return;
    const clientRoot = vscode.Uri.joinPath(this.extensionUri, "client");
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel(
      "protoview.client",
      "ProtoView Client",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [clientRoot, mediaRoot],
      },
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage(async (message: {
      type?: string;
      payload?: ClientEnvFile & GrpcInvokeRequest;
      file?: string;
      line?: number;
    }) => {
      if (message.type === "ready") {
        this.ready = true;
        await this.postBootstrap();
        return;
      }
      if (message.type === "refresh") {
        this.onRefresh?.();
        return;
      }
      if (message.type === "saveEnvs" && message.payload) {
        await saveEnvFile(message.payload);
        void vscode.window.setStatusBarMessage("ProtoView Client 环境已保存", 2000);
        return;
      }
      if (message.type === "openSource" && message.file) {
        await openSource(message.file, Number(message.line || 1));
        return;
      }
      if (message.type === "invoke" && message.payload && this.catalog && this.panel) {
        const result = await invokeGrpc(this.catalog, message.payload);
        this.panel.webview.postMessage({ type: "invokeResult", ...result });
      }
    });
    this.panel.webview.html = this.html();
  }

  private async postBootstrap(): Promise<void> {
    if (!this.panel || !this.catalog) return;
    const envs = await loadEnvFile();
    const qr = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "donate-wechat.png"));
    this.panel.webview.postMessage({
      type: "bootstrap",
      catalog: toClientCatalog(this.catalog, this.sourceLabel, this.showGoogle),
      envs,
      qr: qr.toString(),
    });
  }

  private html(): string {
    const webview = this.panel!.webview;
    const nonce = Math.random().toString(36).slice(2);
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "client", "styles.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "client", "app.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ProtoView Client</title>
  <link rel="stylesheet" href="${styles}" />
</head>
<body>
  <div id="app">
    <aside class="sidebar">
      <div class="side-head">
        <div class="brand-row">
          <div class="brand">Proto<span>View</span> Client</div>
          <div class="side-tools">
            <button class="icon-btn" id="treeToggleBtn" type="button" title="全部收起">▸</button>
            <button class="icon-btn" id="themeBtn" type="button" title="切换亮/暗色">◐</button>
            <button class="icon-btn" id="refreshBtn" type="button" title="刷新">↻</button>
            <button class="btn ai-btn" id="aiBtn" type="button" title="AI"><span class="ai-spark">✦</span>AI</button>
          </div>
        </div>
        <div class="side-meta" id="sourceMeta">加载中…</div>
        <input class="side-search" id="filter" placeholder="筛选 package / service / 接口" />
      </div>
      <div class="tree" id="tree"></div>
    </aside>
    <main class="main">
      <div class="topbar">
        <select class="pill" id="envSelect" title="环境"></select>
        <button class="btn" id="envConfigBtn" type="button">环境配置</button>
        <input class="pill addr" id="address" placeholder="gRPC host:port" />
        <div class="pill method" id="methodLabel">未选择接口</div>
        <button class="btn" id="grpcurlBtn" type="button" title="Generate grpcurl command">&lt;/&gt;</button>
        <label class="tls-toggle" title="不勾选时使用明文 gRPC"><input id="tlsCheck" type="checkbox" /> TLS</label>
        <button class="btn primary" id="sendBtn" type="button" disabled>发送</button>
      </div>
      <div class="tabs" id="tabs">
        <button class="tab active" data-tab="message" type="button">Message</button>
        <button class="tab" data-tab="metadata" type="button">Metadata</button>
        <button class="tab" data-tab="auth" type="button">Auth</button>
        <button class="tab" data-tab="docs" type="button">Docs</button>
        <button class="tab" data-tab="history" type="button">History</button>
      </div>
      <div class="toolbar" id="toolbar">
        <button class="btn" id="genMsgBtn" type="button">自动生成</button>
        <button class="btn" id="formatMsgBtn" type="button">格式化</button>
        <button class="btn" id="clearMsgBtn" type="button">清空</button>
        <div class="spacer"></div>
        <div class="hint" id="toolbarHint">根据请求 message 字段生成 JSON</div>
      </div>
      <div class="workspace" id="workspace">
        <section class="pane request-pane" id="requestPane">
          <div class="pane-body">
            <div class="view active" id="view-message">
              <textarea class="editor" id="messageEditor" spellcheck="false">{}</textarea>
            </div>
            <div class="view" id="view-metadata">
              <div class="meta-wrap">
                <table class="meta-table">
                  <thead>
                    <tr>
                      <th class="col-name">Name</th>
                      <th class="col-value">Value</th>
                      <th class="col-desc">Description</th>
                      <th class="col-act"></th>
                    </tr>
                  </thead>
                  <tbody id="metaBody"></tbody>
                </table>
                <div class="meta-foot">
                  <button class="btn" id="addMetaBtn" type="button">添加一行</button>
                  <button class="link" id="bulkMetaBtn" type="button">Bulk Edit</button>
                </div>
              </div>
            </div>
            <div class="view" id="view-auth">
              <div class="auth-panel">
                <div class="auth-head">
                  <div>
                    <div class="auth-title">Auth</div>
                    <p class="auth-note">gRPC 无集合级 Inherit，请在本接口配置。鉴权会写入 Metadata 并在发送时生效。</p>
                  </div>
                  <select id="authType" class="pill auth-type" title="Auth 类型">
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="basic">Basic Auth</option>
                    <option value="apikey">API Key</option>
                    <option value="oauth2">OAuth 2.0</option>
                    <option value="wsse">WSSE Auth</option>
                  </select>
                </div>
                <div class="auth-body" id="authBody"></div>
                <div class="auth-preview" id="authPreview">将注入：无</div>
              </div>
            </div>
            <div class="view" id="view-docs">
              <div class="docs" id="docsView"><div class="doc-empty">选择左侧接口后显示注释与请求/响应字段。</div></div>
            </div>
            <div class="view" id="view-history">
              <div class="history" id="historyView">发送记录会显示在这里（当前为本地会话历史，无数据库）。</div>
            </div>
          </div>
        </section>
        <div class="split-bar" id="splitBar" title="拖动调整高度">
          <button class="split-btn" id="collapseReqBtn" type="button" title="收起请求区">▲</button>
          <div class="split-grip" id="splitHandle"></div>
          <button class="split-btn" id="collapseRespBtn" type="button" title="收起响应区">▼</button>
        </div>
        <section class="pane response-pane" id="responsePane">
          <div class="toolbar">
            <strong class="resp-title">Response</strong>
            <span class="resp-badge" id="respBadge"></span>
            <div class="spacer"></div>
            <button class="btn" id="clearRespBtn" type="button">清空响应</button>
          </div>
          <div class="response" id="responseView"><div class="resp-empty">选择接口，配置地址后发送。</div></div>
        </section>
      </div>
    </main>
  </div>
  <div class="modal-mask" id="envModal">
    <div class="modal">
      <div class="modal-head">
        <span>环境配置</span>
        <button class="icon-btn" id="closeEnvModal" type="button">✕</button>
      </div>
      <div class="modal-body">
        <div class="env-list" id="envList"></div>
        <label>环境名<input id="envName" /></label>
        <label>接口地址<input id="envHost" placeholder="host:port" /></label>
        <label>备注<input id="envNote" placeholder="可选" /></label>
      </div>
      <div class="modal-foot">
        <button class="btn" id="addEnvBtn" type="button">新增环境</button>
        <button class="btn primary" id="saveEnvBtn" type="button">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-mask" id="curlModal">
    <div class="modal">
      <div class="modal-head">
        <span>grpcurl</span>
        <button class="icon-btn" id="closeCurlModal" type="button">✕</button>
      </div>
      <div class="modal-body">
        <textarea id="curlText" rows="12" readonly></textarea>
      </div>
      <div class="modal-foot">
        <button class="btn primary" id="copyCurlBtn" type="button">复制命令</button>
      </div>
    </div>
  </div>
  <div class="modal-mask" id="bulkModal">
    <div class="modal">
      <div class="modal-head">
        <span>Metadata Bulk Edit</span>
        <button class="icon-btn" id="closeBulkModal" type="button">✕</button>
      </div>
      <div class="modal-body">
        <label>每行一条：Name: Value
          <textarea id="bulkText" rows="10" placeholder="authorization: Bearer xxx"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn primary" id="applyBulkBtn" type="button">应用</button>
      </div>
    </div>
  </div>
  <div class="ai-overlay" id="aiOverlay">
    <div class="ai-page">
      <div class="ai-top">
        <div>
          <div class="doc-crumbs"><span>ProtoView</span><span>/</span><span>AI</span></div>
          <h2 class="doc-title">山海<span class="ai-heart">♥</span></h2>
          <p class="ai-poem">所爱隔山海，山海亦可平<br/>消耗了 token，贡献点爱心<br/>尊重每个热爱开发的程序员</p>
        </div>
        <div class="ai-actions">
          <button class="btn" id="aiMusicBtn" type="button">音乐</button>
          <button class="btn" id="closeAiBtn" type="button">关闭</button>
        </div>
      </div>
      <div class="ai-stage">
        <div class="ai-game" id="aiGame">
          <div class="doc-kicker">解谜 · 山海归位</div>
          <p class="doc-lead">点击两张牌交换，拼出「山海平爱」。成功后会点亮爱心。</p>
          <div class="ai-board" id="aiBoard"></div>
          <button class="btn" id="aiShuffle" type="button">打乱重来</button>
        </div>
        <div class="ai-reward hidden" id="aiReward">
          <div class="ai-heart burst">♥</div>
          <div class="doc-kicker">解谜成功</div>
          <p class="doc-lead">谢谢你的心意。扫一扫，给热爱开发的人一点支持。</p>
          <img class="ai-qr" id="aiQr" alt="微信支付二维码" hidden />
          <p class="doc-file">微信支付 · 辉</p>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

async function envFilePath(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return undefined;
  return path.join(folder, ".protoview", "environments.json");
}

export async function loadEnvFile(): Promise<ClientEnvFile> {
  const file = await envFilePath();
  if (!file) return defaultEnvFile();
  try {
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text) as ClientEnvFile;
    if (!Array.isArray(data.envs) || !data.envs.length) return defaultEnvFile();
    return {
      activeEnvId: data.activeEnvId || data.envs[0].id,
      envs: data.envs,
    };
  } catch {
    return defaultEnvFile();
  }
}

export async function saveEnvFile(data: ClientEnvFile): Promise<void> {
  const file = await envFilePath();
  if (!file) {
    void vscode.window.showWarningMessage("未打开工作区，环境仅保存在 Client 页面会话中。");
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
