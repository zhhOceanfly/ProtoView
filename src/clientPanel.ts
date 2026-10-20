import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Catalog } from "./catalog";
import {
  ClientEnvFile,
  defaultEnvFile,
  toClientCatalog,
} from "./clientModel";
import { GrpcInvokeRequest } from "./grpcInvoke";
import { cancelStress, runStress } from "./grpcStress";
import { dispatchInvoke } from "./invokeDispatch";
import { openSource } from "./panel";
import { ProtoSourceConfig } from "./source";

export interface ClientSourceState {
  /** Client 弹层：directory | git（侧边栏仍用 workspace | git） */
  mode: "directory" | "git";
  dirPath: string;
  gitUrl: string;
  gitBranch: string;
  localPath: string;
  lastError: string;
}

export class ClientPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private catalog: Catalog | undefined;
  private sourceLabel = "工作区";
  private showGoogle = false;
  private sourceState: ClientSourceState = {
    mode: "directory",
    dirPath: "",
    gitUrl: "",
    gitBranch: "main",
    localPath: "",
    lastError: "",
  };
  private onRefresh: (() => void) | undefined;
  private onSetSource: ((next: ClientSourceState) => void | Promise<void>) | undefined;
  private stressRunning = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setRefreshHandler(handler: () => void): void {
    this.onRefresh = handler;
  }

  setSourceHandler(handler: (next: ClientSourceState) => void | Promise<void>): void {
    this.onSetSource = handler;
  }

  open(catalog: Catalog, sourceLabel: string, showGoogle: boolean, source?: ProtoSourceConfig): void {
    this.catalog = catalog;
    this.sourceLabel = sourceLabel;
    this.showGoogle = showGoogle;
    if (source) this.sourceState = toClientSource(source);
    this.ensure();
    this.panel?.reveal(vscode.ViewColumn.Beside, false);
    if (this.ready) void this.postBootstrap();
  }

  refresh(catalog: Catalog, sourceLabel: string, showGoogle: boolean, source?: ProtoSourceConfig): void {
    this.catalog = catalog;
    this.sourceLabel = sourceLabel;
    this.showGoogle = showGoogle;
    if (source) this.sourceState = toClientSource(source);
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
      payload?: ClientEnvFile & GrpcInvokeRequest & {
        protocol?: string;
        httpMethod?: string;
        httpPath?: string;
        concurrency?: number;
        total?: number;
        command?: string;
        args?: string[];
      } & Record<string, unknown>;
      file?: string;
      line?: number;
      id?: string;
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
      if (message.type === "pickProtoDir" && this.panel) {
        const uris = await vscode.window.showOpenDialog({
          title: "选择 Proto 目录",
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择",
        });
        if (uris?.[0]) {
          this.panel.webview.postMessage({ type: "pickedProtoDir", path: uris[0].fsPath });
        }
        return;
      }
      if (message.type === "pickGhzBinary" && this.panel) {
        const uris = await vscode.window.showOpenDialog({
          title: "选择本机 ghz 可执行文件",
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "选择",
          filters: process.platform === "win32"
            ? { Executable: ["exe", "cmd", "bat"], All: ["*"] }
            : { All: ["*"] },
        });
        if (uris?.[0]) {
          this.panel.webview.postMessage({ type: "pickedGhzBinary", path: uris[0].fsPath });
        }
        return;
      }
      if (message.type === "setSource" && message.payload && this.onSetSource) {
        const mode = message.payload.mode === "git" ? "git" : "directory";
        const next: ClientSourceState = {
          mode,
          dirPath: String(message.payload.dirPath || "").trim(),
          gitUrl: String(message.payload.gitUrl || "").trim(),
          gitBranch: String(message.payload.gitBranch || "main").trim() || "main",
          localPath: this.sourceState.localPath,
          lastError: "",
        };
        await this.onSetSource(next);
        return;
      }
      if (message.type === "exportFlow" && message.payload && this.panel) {
        await exportFlowFile(message.payload);
        return;
      }
      if (message.type === "importFlow" && this.panel) {
        const data = await importFlowFile();
        if (data) this.panel.webview.postMessage({ type: "flowImportData", payload: data });
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
        const result = await dispatchInvoke(this.catalog, message.payload);
        this.panel.webview.postMessage({ type: "invokeResult", ...result });
        return;
      }
      if (message.type === "stressCancel" && message.id) {
        cancelStress(message.id);
        return;
      }
      if (message.type === "stress" && message.payload && this.catalog && this.panel) {
        if (this.stressRunning) {
          this.panel.webview.postMessage({
            type: "stressResult",
            id: message.payload.id,
            error: "已有压测在进行中",
          });
          return;
        }
        this.stressRunning = true;
        const id = String(message.payload.id || Date.now());
        try {
          const summary = await runStress(
            this.catalog,
            message.payload,
            {
              id,
              concurrency: Number(message.payload.concurrency || 1),
              total: Number(message.payload.total || 1),
            },
            (progress) => this.panel?.webview.postMessage({ ...progress, type: "stressProgress" }),
          );
          this.panel.webview.postMessage({ ...summary, type: "stressResult" });
        } finally {
          this.stressRunning = false;
        }
        return;
      }
      if (message.type === "runGhz" && message.payload?.args && this.panel) {
        await this.runGhz(
          message.payload.args,
          String(message.payload.id || Date.now()),
          String((message.payload as { binary?: string }).binary || "ghz"),
        );
      }
    });
    this.panel.webview.html = this.html();
  }

  private async runGhz(args: string[], id: string, binary = "ghz"): Promise<void> {
    if (!this.panel) return;
    const cmd = (binary || "ghz").trim() || "ghz";
    this.panel.webview.postMessage({ type: "ghzProgress", id, text: `运行: ${cmd} ${args.join(" ")}\n` });
    await new Promise<void>((resolve) => {
      const child = spawn(cmd, args, { shell: true, windowsHide: true });
      const push = (chunk: Buffer) => {
        this.panel?.webview.postMessage({ type: "ghzProgress", id, text: chunk.toString() });
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (error) => {
        this.panel?.webview.postMessage({
          type: "ghzResult",
          id,
          ok: false,
          text: `无法启动 ghz：${error.message}\n请填写正确的 ghz 路径，或改用「复制 ghz 命令」。`,
        });
        resolve();
      });
      child.on("close", (code) => {
        this.panel?.webview.postMessage({
          type: "ghzResult",
          id,
          ok: code === 0,
          text: `\n[exit ${code ?? "null"}]\n`,
        });
        resolve();
      });
    });
  }

  private async postBootstrap(): Promise<void> {
    if (!this.panel || !this.catalog) return;
    const envs = await loadEnvFile();
    const qr = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "donate-wechat.png"));
    this.panel.webview.postMessage({
      type: "bootstrap",
      catalog: toClientCatalog(this.catalog, this.sourceLabel, this.showGoogle),
      envs,
      source: this.sourceState,
      qr: qr.toString(),
    });
  }

  private html(): string {
    const webview = this.panel!.webview;
    const nonce = Math.random().toString(36).slice(2);
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "client", "styles.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "client", "app.js"));
    const flowScript = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "client", "flow.js"));
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
        <div class="side-meta-row">
          <div class="side-meta-group">
            <div class="side-meta" id="sourceMeta">加载中…</div>
            <button class="btn side-source-btn" id="sourceConfigBtn" type="button" title="在 Client 内配置工作区或 Git 来源">自定义源</button>
          </div>
          <button class="btn side-flow-btn primary" id="flowBtn" type="button" title="链路调试">链路调试</button>
        </div>
        <input class="side-search" id="filter" placeholder="筛选 package / service / 接口" />
      </div>
      <div class="tree" id="tree"></div>
    </aside>
    <main class="main" id="mainClient">
      <div class="topbar">
        <select class="pill" id="protocolSelect" title="协议">
          <option value="grpc">gRPC</option>
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
          <option value="websocket">WebSocket</option>
        </select>
        <select class="pill hidden" id="httpMethodSelect" title="HTTP 方法">
          <option>GET</option>
          <option selected>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
        <input class="pill hidden http-path" id="httpPath" placeholder="/path" title="HTTP 路径" />
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
        <button class="tab" data-tab="stress" type="button">压测</button>
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
              <div class="message-layout">
                <aside class="rpc-info" id="rpcInfo">
                  <div class="rpc-info-empty">选择左侧接口后显示定义与说明。</div>
                </aside>
                <textarea class="editor" id="messageEditor" spellcheck="false">{}</textarea>
              </div>
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
            <div class="view" id="view-stress">
              <div class="stress-panel">
                <div class="stress-head">
                  <div class="stress-modes" id="stressModes">
                    <button class="btn stress-mode active" type="button" data-stress-mode="light">轻量压测</button>
                    <button class="btn stress-mode" type="button" data-stress-mode="ghz">ghz</button>
                  </div>
                  <p class="stress-note" id="stressNote">复用当前 Message / Auth / Metadata，在插件进程内有限并发调用。</p>
                </div>
                <div class="stress-light" id="stressLight">
                  <div class="stress-form">
                    <label>并发 <input id="stressConcurrency" type="number" min="1" max="10" value="2" /></label>
                    <label>总请求 <input id="stressTotal" type="number" min="1" max="200" value="20" /></label>
                    <button class="btn primary" id="stressStartBtn" type="button">开始压测</button>
                    <button class="btn" id="stressStopBtn" type="button" disabled>停止</button>
                  </div>
                  <div class="stress-progress-wrap">
                    <div class="stress-progress-bar"><i id="stressProgressBar"></i></div>
                    <div class="stress-progress-text" id="stressProgressText">未开始</div>
                  </div>
                </div>
                <div class="stress-ghz hidden" id="stressGhz">
                  <p class="stress-note">指定本机 <code>ghz</code> 可执行文件路径；留空则使用 PATH 中的 <code>ghz</code>。</p>
                  <div class="stress-form">
                    <label class="stress-path">ghz 路径
                      <div class="source-dir-row">
                        <input id="ghzPath" type="text" placeholder="留空则用 PATH 中的 ghz" />
                        <button class="btn" id="pickGhzPathBtn" type="button" title="选择本机 ghz 可执行文件">浏览</button>
                      </div>
                    </label>
                    <label>并发 <input id="ghzConcurrency" type="number" min="1" max="200" value="20" /></label>
                    <label>总请求 <input id="ghzTotal" type="number" min="1" max="100000" value="200" /></label>
                    <button class="btn" id="copyGhzBtn" type="button">复制 ghz 命令</button>
                    <button class="btn primary" id="runGhzBtn" type="button">尝试运行 ghz</button>
                  </div>
                  <textarea id="ghzCommand" class="stress-cmd" rows="8" readonly></textarea>
                </div>
                <div class="stress-result" id="stressResult">
                  <div class="stress-empty">压测结果会显示在这里。</div>
                </div>
              </div>
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
    <main class="main flow-main hidden" id="mainFlow">
      <div class="flow-topbar">
        <strong>链路调试</strong>
        <span class="flow-hint">按住左侧接口拖到画布松手 · 双击也可添加 · 右键节点编辑</span>
        <div class="spacer"></div>
        <button class="btn" id="flowAddSelectedBtn" type="button">添加选中接口</button>
        <button class="btn" id="flowClearBtn" type="button">清空画布</button>
        <button class="btn primary" id="flowRunBtn" type="button">运行链路</button>
        <button class="btn" id="flowStressBtn" type="button">压测</button>
        <button class="btn" id="flowExportBtn" type="button" title="导出当前链路节点与连线配置">导出</button>
        <button class="btn" id="flowImportBtn" type="button" title="从文件导入链路配置">导入</button>
        <button class="btn" id="flowCloseBtn" type="button">返回 Client</button>
      </div>
      <div class="flow-stage" id="flowStage">
        <div class="flow-empty" id="flowEmpty">从左侧拖入接口，或点「添加选中接口」</div>
        <svg class="flow-edges" id="flowEdges"></svg>
        <div class="flow-world" id="flowWorld"></div>
      </div>
      <div class="flow-menu hidden" id="flowMenu" style="display:none">
        <button type="button" data-flow-act="edit">编辑</button>
        <button type="button" data-flow-act="view-resp">查看响应</button>
        <button type="button" data-flow-act="delete">删除</button>
      </div>
      <div class="flow-drawer-mask" id="flowStressDrawer">
        <aside class="flow-drawer" role="dialog" aria-label="链路压测">
          <div class="flow-drawer-head">
            <strong>链路压测</strong>
            <button class="icon-btn" id="flowStressClose" type="button" title="关闭">✕</button>
          </div>
          <div class="flow-drawer-body">
            <p class="stress-note">按拓扑顺序重复跑整条链路（轻量并发，无 ghz）。复用节点 Message / Metadata / 变量提取。</p>
            <div class="stress-form">
              <label>并发 <input id="flowStressConcurrency" type="number" min="1" max="5" value="1" /></label>
              <label>总次数 <input id="flowStressTotal" type="number" min="1" max="100" value="10" /></label>
            </div>
            <div class="flow-drawer-actions">
              <button class="btn primary" id="flowStressStartBtn" type="button">开始压测</button>
              <button class="btn" id="flowStressStopBtn" type="button" disabled>停止</button>
            </div>
            <div class="stress-progress-wrap">
              <div class="stress-progress-bar"><i id="flowStressProgressBar"></i></div>
              <div class="stress-progress-text" id="flowStressProgressText">未开始</div>
            </div>
            <div class="stress-result" id="flowStressResult">
              <div class="stress-empty">压测结果会显示在这里。</div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  </div>
  <div class="modal-mask" id="flowEditModal">
    <div class="modal flow-edit-modal">
      <div class="modal-head">
        <span id="flowEditTitle">编辑节点</span>
        <button class="icon-btn" id="closeFlowEdit" type="button">✕</button>
      </div>
      <div class="modal-body">
        <div class="flow-node-transport">
          <label>协议
            <select id="flowNodeProtocol">
              <option value="grpc">gRPC</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
              <option value="websocket">WebSocket</option>
            </select>
          </label>
          <label id="flowNodeMethodWrap" class="hidden">方法
            <select id="flowNodeHttpMethod">
              <option>GET</option>
              <option>POST</option>
              <option>PUT</option>
              <option>PATCH</option>
              <option>DELETE</option>
            </select>
          </label>
          <label id="flowNodePathWrap" class="hidden">路径
            <input id="flowNodeHttpPath" placeholder="/path" />
          </label>
          <label>环境
            <select id="flowNodeEnv"></select>
          </label>
        </div>
        <p class="stress-note">请求字段值支持 <code>{{变量名}}</code>；响应字段可填写「提取变量」供后续节点使用（如写入 Metadata / Header）。</p>
        <h4 class="flow-edit-h">Message</h4>
        <div id="flowMsgBody" class="flow-msg-tree"></div>
        <h4 class="flow-edit-h">Metadata</h4>
        <table class="meta-table flow-edit-table">
          <thead><tr><th>Name</th><th>Value（可用 {{var}}）</th><th></th></tr></thead>
          <tbody id="flowMetaBody"></tbody>
        </table>
        <button class="btn" id="flowAddMetaBtn" type="button">添加 Metadata</button>
        <h4 class="flow-edit-h">响应提取变量 <span class="flow-edit-h-sub">嵌套字段可展开，填写变量名供后续 {{var}} 引用</span></h4>
        <div id="flowExtractBody" class="flow-extract-tree"></div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" id="saveFlowEditBtn" type="button">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-mask" id="flowHistoryModal">
    <div class="modal flow-history-modal">
      <div class="modal-head">
        <span id="flowHistoryTitle">响应历史</span>
        <button class="icon-btn" id="closeFlowHistory" type="button">✕</button>
      </div>
      <div class="modal-body flow-history-layout">
        <div class="flow-history-list" id="flowHistoryList"></div>
        <pre class="flow-history-detail" id="flowHistoryDetail">选择左侧一条记录查看</pre>
      </div>
    </div>
  </div>
  <div class="modal-mask" id="sourceModal">
    <div class="modal">
      <div class="modal-head">
        <span>自定义 Proto 来源</span>
        <button class="icon-btn" id="closeSourceModal" type="button">✕</button>
      </div>
      <div class="modal-body">
        <p class="stress-note">在此选择本地目录或 Git；侧边栏「Proto 来源」仍可单独使用工作区 / Git。</p>
        <div class="source-mode-row">
          <label class="source-mode-opt"><input type="radio" name="sourceMode" value="directory" /> 自定义目录</label>
          <label class="source-mode-opt"><input type="radio" name="sourceMode" value="git" /> 自定义 Git 来源</label>
        </div>
        <div id="sourceDirFields" class="source-git-fields">
          <label>目录路径
            <div class="source-dir-row">
              <input id="sourceDirPath" placeholder="例如 D:\\proto 或 /home/me/api" />
              <button class="btn" id="pickSourceDirBtn" type="button" title="选择文件夹">浏览</button>
            </div>
          </label>
          <p class="stress-note" id="sourceDirHint">扫描该目录下全部 .proto（含子目录）。</p>
        </div>
        <div id="sourceGitFields" class="source-git-fields hidden">
          <label>Git 地址<input id="sourceGitUrl" placeholder="https://github.com/org/repo.git" /></label>
          <label>分支<input id="sourceGitBranch" placeholder="main" /></label>
          <p class="stress-note" id="sourceGitHint"></p>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" id="applySourceBtn" type="button">应用并刷新</button>
      </div>
    </div>
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
  <script nonce="${nonce}" src="${flowScript}"></script>
</body>
</html>`;
  }
}

function toClientSource(config: ProtoSourceConfig): ClientSourceState {
  return {
    mode: config.mode === "git" ? "git" : "directory",
    dirPath: config.dirPath || "",
    gitUrl: config.gitUrl || "",
    gitBranch: config.gitBranch || "main",
    localPath: config.localPath || "",
    lastError: config.lastError || "",
  };
}

async function exportFlowFile(payload: unknown): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    title: "导出链路配置",
    saveLabel: "导出",
    filters: { JSON: ["json"] },
    defaultUri: vscode.Uri.file(`protoview-flow-${stamp()}.json`),
  });
  if (!uri) return;
  await fs.writeFile(uri.fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  void vscode.window.showInformationMessage(`链路配置已导出：${uri.fsPath}`);
}

async function importFlowFile(): Promise<unknown | undefined> {
  const uris = await vscode.window.showOpenDialog({
    title: "导入链路配置",
    openLabel: "导入",
    canSelectMany: false,
    filters: { JSON: ["json"] },
  });
  if (!uris?.length) return undefined;
  try {
    const text = await fs.readFile(uris[0].fsPath, "utf8");
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object") {
      void vscode.window.showErrorMessage("链路配置文件无效：根节点不是对象");
      return undefined;
    }
    return data;
  } catch (error) {
    void vscode.window.showErrorMessage(`导入失败：${(error as Error).message || error}`);
    return undefined;
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
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
