(() => {
  ensureLocalStorageShim();
  const isVsCodeWebview = typeof acquireVsCodeApi === "function";
  const isDbxWorkbench = typeof window !== "undefined" && !!window.dbxPlugin;
  if (isDbxWorkbench) {
    document.title = "ApiMan";
    const brand = document.querySelector(".brand");
    if (brand) brand.innerHTML = "Api<span>Man</span>";
    const crumb = document.querySelector(".doc-crumbs span");
    if (crumb && crumb.textContent === "ProtoView") crumb.textContent = "ApiMan";
  }
  const vscode = isVsCodeWebview
    ? acquireVsCodeApi()
    : isDbxWorkbench
      ? createDbxBridge()
      : createWsBridge();
  const THEME_KEY = "protoview.client.theme";
  const SIDEBAR_BREAKPOINT = 960;
  const SIDEBAR_WIDTH_KEY = "protoview.client.sidebarWidth";
  const DRAFT_KEY = "protoview.client.drafts";
  const HISTORY_KEY = "protoview.client.history";
  const SPLIT_KEY = "protoview.client.split";
  /** null=跟宽度走；true/false=手动覆盖（窗口跨过断点后清除） */
  let sidebarManual = null;
  let sidebarWasNarrow = null;

  /** DBX opaque-origin sandboxes reject localStorage; keep an in-memory shim. */
  function ensureLocalStorageShim() {
    try {
      const k = "__protoview_ls_probe__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return;
    } catch {
      /* fall through */
    }
    const mem = new Map();
    const shim = {
      getItem(key) {
        return mem.has(String(key)) ? mem.get(String(key)) : null;
      },
      setItem(key, value) {
        mem.set(String(key), String(value));
      },
      removeItem(key) {
        mem.delete(String(key));
      },
      clear() {
        mem.clear();
      },
      key(index) {
        return [...mem.keys()][index] ?? null;
      },
      get length() {
        return mem.size;
      },
    };
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          return shim;
        },
      });
    } catch {
      /* ignore if locked */
    }
  }

  /** DBX workbench: same postMessage protocol via Sidecar JSON-RPC + client/push events. */
  function createDbxBridge() {
    const api = window.dbxPlugin;
    const queue = [];
    let ready = false;

    function pushToUi(data) {
      window.dispatchEvent(new MessageEvent("message", { data }));
    }

    function handleHostEvent(ev) {
      if (!ev) return;
      // Host may deliver { method, params } or the params object itself.
      if (ev.method === "client/push") {
        pushToUi(ev.params || {});
        return;
      }
      if (ev.params && ev.params.type) {
        pushToUi(ev.params);
        return;
      }
      if (ev.type) pushToUi(ev);
    }

    void (async () => {
      try {
        await api.ready;
        if (typeof api.onEvent === "function") {
          api.onEvent(handleHostEvent);
        }
        // Apply DBX theme tokens when available
        try {
          const appearance = api.theme?.appearance;
          if (appearance === "light" || appearance === "dark") {
            document.documentElement.setAttribute("data-theme", appearance);
            document.documentElement.setAttribute("data-dbx-theme", appearance);
          }
        } catch { /* ignore */ }
        window.addEventListener("dbx-plugin-env", (event) => {
          const appearance = event?.detail?.theme?.appearance || api.theme?.appearance;
          if (appearance === "light" || appearance === "dark") {
            document.documentElement.setAttribute("data-theme", appearance);
          }
        });
        ready = true;
        while (queue.length) {
          const msg = queue.shift();
          void api.invoke("client/message", { message: msg }).catch((err) => {
            pushToUi({
              type: "toast",
              level: "err",
              text: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        pushToUi({
          type: "toast",
          level: "err",
          text: `DBX Host 初始化失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();

    return {
      postMessage(msg) {
        if (!ready) {
          queue.push(msg || {});
          return;
        }
        void api.invoke("client/message", { message: msg || {} }).catch((err) => {
          pushToUi({
            type: "toast",
            level: "err",
            text: err instanceof Error ? err.message : String(err),
          });
        });
      },
      dispose() {},
    };
  }

  /** Browser / CLI: talk to local Node host over WebSocket (same message protocol as the extension). */
  function createWsBridge() {
    if (typeof WebSocket === "undefined" || !location.host) return null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    let socket = null;
    const queue = [];
    let closed = false;

    function connect() {
      if (closed) return;
      try {
        socket = new WebSocket(url);
      } catch {
        return;
      }
      socket.addEventListener("open", () => {
        while (queue.length && socket?.readyState === WebSocket.OPEN) {
          socket.send(queue.shift());
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data || ""));
          window.dispatchEvent(new MessageEvent("message", { data }));
        } catch { /* ignore bad frames */ }
      });
      socket.addEventListener("close", () => {
        socket = null;
        if (!closed) setTimeout(connect, 1500);
      });
      socket.addEventListener("error", () => {
        try { socket?.close(); } catch { /* ignore */ }
      });
    }

    connect();
    return {
      postMessage(msg) {
        const text = JSON.stringify(msg || {});
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
        else queue.push(text);
      },
      dispose() {
        closed = true;
        try { socket?.close(); } catch { /* ignore */ }
      },
    };
  }

  const state = {
    catalog: { packages: [], types: {}, sourceLabel: "独立模式" },
    envs: defaultEnvs(),
    activeEnvId: "local",
    selected: null,
    tab: "message",
    expanded: new Set(),
    expandedReady: false,
    docsNav: [],
    metadata: [{ name: "", value: "", description: "" }],
    auth: defaultAuth(),
    history: loadHistory(),
    drafts: loadDrafts(),
    messageDirty: false,
    stressMode: "light",
    stressId: "",
    ghzLog: "",
    source: {
      mode: "directory",
      dirPath: "",
      gitUrl: "",
      gitBranch: "main",
      localPath: "",
      lastError: "",
    },
  };

  const GS_KIND_LABEL = { rpc: "接口", enum: "枚举", func: "函数", const: "常量", excel: "Excel", docs: "文档", db: "数据表" };
  const GS_TABS = ["all", "rpc", "enum", "func", "const", "excel", "docs", "db"];
  const globalSearch = {
    items: [],
    active: 0,
    open: false,
    tab: "all",
    codeItems: [],
    codeLoaded: false,
    codeLoading: false,
    excelHits: [],
    excelLoaded: false,
    excelQuery: "",
    docsHits: [],
    docsQuery: "",
    dbHits: [],
    dbQuery: "",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    tree: $("tree"),
    filter: $("filter"),
    sourceMeta: $("sourceMeta"),
    envSelect: $("envSelect"),
    address: $("address"),
    methodLabel: $("methodLabel"),
    messageEditor: $("messageEditor"),
    rpcInfo: $("rpcInfo"),
    metaBody: $("metaBody"),
    docsView: $("docsView"),
    historyView: $("historyView"),
    responseView: $("responseView"),
    stressResult: $("stressResult"),
    sendBtn: $("sendBtn"),
    toolbar: $("toolbar"),
    toolbarHint: $("toolbarHint"),
    themeBtn: $("themeBtn"),
    envName: $("envName"),
    envHost: $("envHost"),
    envNote: $("envNote"),
    envList: $("envList"),
    envModal: $("envModal"),
    sourceModal: $("sourceModal"),
    bulkModal: $("bulkModal"),
    bulkText: $("bulkText"),
  };

  function defaultEnvs() {
    return [
      { id: "local", name: "local", host: "127.0.0.1:19200", note: "本地" },
      { id: "test", name: "test", host: "", note: "测试" },
    ];
  }

  function defaultAuth() {
    return {
      type: "none",
      token: "",
      username: "",
      password: "",
      apiKey: "x-api-key",
      apiValue: "",
      oauthToken: "",
      wsseUser: "",
      wssePass: "",
    };
  }

  function normalizeAuth(raw) {
    return { ...defaultAuth(), ...(raw && typeof raw === "object" ? raw : {}) };
  }

  function persistCurrentDraft() {
    if (clientSnapshot || !state.selected) return;
    state.drafts[state.selected.id] = {
      message: els.messageEditor.value,
      metadata: state.metadata,
      auth: state.auth,
      protocol: $("protocolSelect")?.value || "grpc",
      httpMethod: $("httpMethodSelect")?.value || "POST",
      httpPath: $("httpPath")?.value || "",
    };
    saveDrafts();
  }

  /** 打开链路浮窗前记下 Client 正在编辑的请求，返回时还原，避免被节点草稿盖掉 */
  let clientSnapshot = null;

  function captureClientSnapshot() {
    if (clientSnapshot || !state.selected) return;
    clientSnapshot = {
      rpcId: state.selected.id,
      message: els.messageEditor.value,
      metadata: state.metadata.map((row) => ({ ...row })),
      auth: { ...state.auth },
      protocol: $("protocolSelect")?.value || "grpc",
      httpMethod: $("httpMethodSelect")?.value || "POST",
      httpPath: $("httpPath")?.value || "",
      tab: state.tab || "message",
      messageDirty: state.messageDirty,
    };
  }

  function discardClientSnapshot() {
    clientSnapshot = null;
  }

  function restoreClientSnapshot() {
    const snap = clientSnapshot;
    if (!snap) return false;
    clientSnapshot = null;
    if (!findRpc(snap.rpcId)) return false;
    selectRpc(snap.rpcId, {
      skipPersist: true,
      tab: snap.tab || "message",
      draft: {
        message: snap.message,
        metadata: snap.metadata,
        auth: snap.auth,
        protocol: snap.protocol,
        httpMethod: snap.httpMethod,
        httpPath: snap.httpPath,
      },
    });
    state.messageDirty = Boolean(snap.messageDirty);
    return true;
  }

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 40)));
    } catch { /* ignore */ }
  }

  function saveDrafts() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.drafts));
  }

  function activeEnv() {
    return state.envs.find((item) => item.id === state.activeEnvId) || state.envs[0];
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    paintThemeButtons(saved);
  }

  function paintThemeButtons(theme) {
    const icon = theme === "light" ? "☾" : "◐";
    if (els.themeBtn) els.themeBtn.textContent = icon;
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => { btn.textContent = icon; });
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    paintThemeButtons(next);
  }

  function isSidebarCollapsed() {
    return document.getElementById("app")?.classList.contains("sidebar-collapsed");
  }

  function setSidebarCollapsed(collapsed) {
    const app = document.getElementById("app");
    if (!app) return;
    app.classList.toggle("sidebar-collapsed", Boolean(collapsed));
    $("sidebarResize")?.setAttribute("tabindex", collapsed ? "-1" : "0");
    for (const toggle of document.querySelectorAll("[data-sidebar-toggle]")) {
      toggle.title = collapsed ? "展开侧栏" : "收起侧栏";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
  }

  function appWidth() {
    return document.getElementById("app")?.clientWidth || window.innerWidth || 0;
  }

  function syncSidebarByWidth() {
    const narrow = appWidth() < SIDEBAR_BREAKPOINT;
    if (sidebarWasNarrow !== null && sidebarWasNarrow !== narrow) {
      sidebarManual = null;
    }
    sidebarWasNarrow = narrow;
    const collapsed = sidebarManual !== null ? sidebarManual : narrow;
    setSidebarCollapsed(collapsed);
  }

  function initSidebarCollapsed() {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(width) && width >= 200 && width <= 600) {
      document.getElementById("app")?.style.setProperty("--sidebar-size", `${width}px`);
    }
    syncSidebarByWidth();
    const app = document.getElementById("app");
    if (!app || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncSidebarByWidth);
      return;
    }
    const ro = new ResizeObserver(() => syncSidebarByWidth());
    ro.observe(app);
  }

  function toggleSidebar() {
    sidebarManual = !isSidebarCollapsed();
    setSidebarCollapsed(sidebarManual);
  }

  function initSidebarResize() {
    const app = $("app");
    const handle = $("sidebarResize");
    if (!app || !handle) return;
    const setWidth = (width) => {
      const max = Math.max(200, Math.min(600, app.clientWidth - 100));
      const next = Math.round(Math.min(max, Math.max(200, width)));
      app.style.setProperty("--sidebar-size", `${next}px`);
      handle.setAttribute("aria-valuenow", String(next));
      return next;
    };
    let dragging = false;
    handle.setAttribute("aria-valuemin", "200");
    handle.setAttribute("aria-valuemax", "600");
    handle.setAttribute("aria-valuenow", String(Math.round(Number.parseFloat(app.style.getPropertyValue("--sidebar-size")) || 260)));
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isSidebarCollapsed()) return;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("sidebar-resizing");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (dragging) setWidth(event.clientX - app.getBoundingClientRect().left);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("sidebar-resizing");
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(app.querySelector(".sidebar").getBoundingClientRect().width)));
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("keydown", (event) => {
      if (isSidebarCollapsed() || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      const width = app.querySelector(".sidebar").getBoundingClientRect().width;
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(setWidth(width + (event.key === "ArrowRight" ? 10 : -10))));
    });
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function treeIsOpen() {
    for (const pkg of state.catalog.packages || []) {
      if (state.expanded.has(`pkg:${pkg.name}`)) return true;
      if (state.expanded.has(`pkg:${pkg.name}:messages`)) return true;
      if (state.expanded.has(`pkg:${pkg.name}:enums`)) return true;
      for (const service of pkg.services || []) {
        if (state.expanded.has(`svc:${service.id}`)) return true;
      }
    }
    return false;
  }

  function syncTreeToggle() {
    const btn = $("treeToggleBtn");
    if (!btn) return;
    const open = treeIsOpen();
    btn.textContent = open ? "▸" : "▾";
    btn.title = open ? "全部收起" : "全部展开";
  }

  function setAllExpanded(open) {
    state.expanded.clear();
    state.expandedReady = true;
    if (open) {
      for (const pkg of state.catalog.packages || []) {
        state.expanded.add(`pkg:${pkg.name}`);
        for (const service of pkg.services || []) state.expanded.add(`svc:${service.id}`);
        if ((pkg.messages || []).length) state.expanded.add(`pkg:${pkg.name}:messages`);
        if ((pkg.enums || []).length) state.expanded.add(`pkg:${pkg.name}:enums`);
      }
    }
    renderTree();
  }

  function ensureExpandedDefaults() {
    if (state.expandedReady) return;
    state.expandedReady = true;
    for (const pkg of state.catalog.packages || []) {
      state.expanded.add(`pkg:${pkg.name}`);
      for (const service of pkg.services || []) state.expanded.add(`svc:${service.id}`);
    }
  }

  function envOptionsHtml() {
    return state.envs
      .map((env) => `<option value="${esc(env.id)}"${env.id === state.activeEnvId ? " selected" : ""}>${esc(env.name)}</option>`)
      .join("");
  }

  function renderEnvSelect() {
    const html = envOptionsHtml();
    els.envSelect.innerHTML = html;
    const env = activeEnv();
    if (env && document.activeElement !== els.address) els.address.value = env.host || "";
    fillEnvForm();
    renderEnvList();
  }

  function applyEnvId(id) {
    if (!id) return;
    state.activeEnvId = id;
    const env = activeEnv();
    els.address.value = env?.host || "";
    els.envSelect.value = id;
    fillEnvForm();
    persistEnvs();
  }

  function currentProtocol() {
    const raw = ($("protocolSelect")?.value || "grpc").toLowerCase();
    if (raw === "http" || raw === "sse" || raw === "websocket") return raw;
    return "grpc";
  }

  function syncProtocolUi() {
    const protocol = currentProtocol();
    const needsPath = protocol === "http" || protocol === "sse" || protocol === "websocket";
    const needsMethod = protocol === "http" || protocol === "sse";
    const grpcOnly = protocol === "grpc";
    $("httpMethodSelect")?.classList.toggle("hidden", !needsMethod);
    $("httpPath")?.classList.toggle("hidden", !needsPath);
    document.querySelector('[data-stress-mode="ghz"]')?.classList.toggle("hidden", !grpcOnly);
    if (!grpcOnly && state.stressMode === "ghz") setStressMode("light");
    if (els.address) {
      const placeholders = {
        grpc: "gRPC host:port",
        http: "HTTP host:port 或 https://host",
        sse: "SSE host:port 或 https://host",
        websocket: "WS host:port 或 wss://host",
      };
      els.address.placeholder = placeholders[protocol] || placeholders.grpc;
    }
  }

  function fillEnvForm() {
    const env = activeEnv();
    if (!env) return;
    els.envName.value = env.name;
    els.envHost.value = env.host || "";
    els.envNote.value = env.note || "";
  }

  function renderEnvList() {
    els.envList.innerHTML = state.envs.map((env) => `
      <div class="env-item${env.id === state.activeEnvId ? " active" : ""}" data-env-pick="${esc(env.id)}">
        <div>
          <strong>${esc(env.name)}</strong>
          <span>${esc(env.host || "(未配置地址)")}</span>
        </div>
        <div class="env-actions">
          <button class="icon-btn" type="button" data-env-del="${esc(env.id)}" title="删除">✕</button>
        </div>
      </div>
    `).join("");
  }

  /** 切换环境前把当前表单写回，避免输入丢失 */
  function commitEnvForm() {
    const env = activeEnv();
    if (!env) return;
    env.name = els.envName.value.trim() || env.id;
    env.host = els.envHost.value.trim();
    env.note = els.envNote.value.trim();
  }

  /** VS Code webview 里 window.confirm 常被禁用，统一走自建对话框 */
  function showConfirm(message) {
    const builtin = window.ProtoViewDialog?.confirm;
    if (typeof builtin === "function") return builtin(message);
    return Promise.resolve(window.confirm(message));
  }

  async function deleteEnv(id) {
    const index = state.envs.findIndex((env) => env.id === id);
    if (index < 0) return;
    const ok = await showConfirm(`删除环境「${state.envs[index].name}」？`);
    if (!ok) return;
    state.envs.splice(index, 1);
    if (state.activeEnvId === id) state.activeEnvId = state.envs[0]?.id || "";
    persistEnvs();
    renderEnvSelect();
  }

  function renderTree() {
    const query = (els.filter.value || "").trim().toLowerCase();
    const changeOnly = window.ProtoViewGit?.changeOnly?.("rpcChangeOnly");
    const packs = state.catalog.packages || [];
    if (!packs.length) {
      els.tree.innerHTML = `<div class="empty-side">还没有接口数据。点击刷新，或确认 Proto 来源已解析成功。</div>`;
      return;
    }
    ensureExpandedDefaults();
    const activeTypeId = state.docsNav[state.docsNav.length - 1] || "";
    let html = "";
    for (const pkg of packs) {
      const pkgMatched = !query || pkg.name.toLowerCase().includes(query);
      const services = (pkg.services || []).filter((service) => matchService(pkg, service, query, changeOnly));
      const messages = (pkg.messages || []).filter((item) => (pkgMatched || matchTypeRef(item, query)) && (!changeOnly || typeChanged(item)));
      const enums = (pkg.enums || []).filter((item) => (pkgMatched || matchTypeRef(item, query)) && (!changeOnly || typeChanged(item)));
      if (!services.length && !messages.length && !enums.length) continue;
      const pkgKey = `pkg:${pkg.name}`;
      if (query && (messages.length || enums.length)) {
        state.expanded.add(pkgKey);
        if (messages.length) state.expanded.add(`pkg:${pkg.name}:messages`);
        if (enums.length) state.expanded.add(`pkg:${pkg.name}:enums`);
      }
      const pkgOpen = state.expanded.has(pkgKey);
      const rpcCount = services.reduce((n, s) => n + (s.rpcs || []).length, 0);
      const typeCount = messages.length + enums.length;
      const countLabel = typeCount ? `${rpcCount} · ${typeCount}` : String(rpcCount);
      html += `<div class="node">
        <button class="node-row" type="button" data-toggle="${esc(pkgKey)}">
          <span class="caret">${pkgOpen ? "▼" : "▶"}</span>
          <span class="kind">📦</span>
          <span class="label">${esc(pkg.name)}</span>
          <span class="count">${esc(countLabel)}</span>
        </button>
        <div class="children${pkgOpen ? "" : " collapsed"}">`;
      for (const service of services) {
        const svcKey = `svc:${service.id}`;
        const svcOpen = state.expanded.has(svcKey);
        const rpcs = (service.rpcs || []).filter((rpc) => matchRpc(pkg, service, rpc, query, changeOnly));
        html += `<div class="node">
          <button class="node-row" type="button" data-toggle="${esc(svcKey)}">
            <span class="caret">${svcOpen ? "▼" : "▶"}</span>
            <span class="kind">◇</span>
            <span class="label">${esc(service.name)}</span>
            <span class="count">${rpcs.length}</span>
          </button>
          <div class="children${svcOpen ? "" : " collapsed"}">`;
        for (const rpc of rpcs) {
          const active = state.selected?.id === rpc.id ? " active" : "";
          const streamHint = rpc.requestStream && rpc.responseStream ? " · bidi"
            : rpc.requestStream ? " · client-stream"
            : rpc.responseStream ? " · server-stream"
            : "";
          html += `<div>
            <button class="node-row${active}" type="button" data-rpc="${esc(rpc.id)}" title="在链路调试中按住拖到画布">
              <span class="caret"></span>
              <span class="kind">⇢</span>
              <span class="label">${esc(rpc.name)}${esc(streamHint)}</span>
            </button>
            <div class="rpc-desc">${esc(rpc.comment || `${rpc.requestStream ? "stream " : ""}${rpc.request} → ${rpc.responseStream ? "stream " : ""}${rpc.response}`)}</div>
          </div>`;
        }
        html += `</div></div>`;
      }
      html += typeGroupHtml(pkg, "messages", "消息", "▣", messages, activeTypeId);
      html += typeGroupHtml(pkg, "enums", "枚举", "☰", enums, activeTypeId);
      html += `</div></div>`;
    }
    els.tree.innerHTML = html || `<div class="empty-side">没有匹配的接口 / 类型</div>`;
    syncTreeToggle();
  }

  function typeGroupHtml(pkg, kind, label, icon, items, activeTypeId) {
    if (!items.length) return "";
    const key = `pkg:${pkg.name}:${kind}`;
    const open = state.expanded.has(key);
    let html = `<div class="node">
      <button class="node-row" type="button" data-toggle="${esc(key)}">
        <span class="caret">${open ? "▼" : "▶"}</span>
        <span class="kind">${icon}</span>
        <span class="label">${esc(label)}</span>
        <span class="count">${items.length}</span>
      </button>
      <div class="children${open ? "" : " collapsed"}">`;
    for (const item of items) {
      const active = activeTypeId === item.id ? " active" : "";
      const title = item.comment || item.fullName || item.name;
      html += `<div>
        <button class="node-row${active}" type="button" data-type-id="${esc(item.id)}" title="${esc(title)}">
          <span class="caret"></span>
          <span class="kind">${kind === "enums" ? "≡" : "▢"}</span>
          <span class="label">${esc(item.fullName || item.name)}</span>
        </button>
        <div class="rpc-desc">${esc(item.comment || (kind === "enums" ? "enum" : "message"))}</div>
      </div>`;
    }
    return `${html}</div></div>`;
  }

  function matchService(pkg, service, query, changeOnly = false) {
    const list = (service.rpcs || []).filter((rpc) => matchRpc(pkg, service, rpc, query, changeOnly));
    if (changeOnly && !list.length) {
      // 服务里没有变更的 rpc 时，若 proto 文件本身变更也保留
      return Boolean(query) && pkg.name.toLowerCase().includes(query);
    }
    if (!query) return list.length > 0 || !changeOnly;
    if (pkg.name.toLowerCase().includes(query) || service.name.toLowerCase().includes(query)) {
      return changeOnly ? list.length > 0 || Boolean(service.path && fileChanged(service.path)) : true;
    }
    return list.length > 0;
  }

  function fileChanged(path) {
    if (!path) return false;
    return Boolean(window.ProtoViewGit?.isChanged?.(path));
  }

  function typeChanged(item) {
    return fileChanged(item?.path || item?.file);
  }

  function matchRpc(pkg, service, rpc, query, changeOnly = false) {
    if (changeOnly && !fileChanged(rpc.path || service.path || pkg.path)) return false;
    if (!query) return true;
    const hay = `${pkg.name} ${service.name} ${rpc.name} ${rpc.comment || ""} ${rpc.request} ${rpc.response}`.toLowerCase();
    if (hay.includes(query)) return true;
    if (matchFields(rpc.requestFields, query) || matchFields(rpc.responseFields, query)) return true;
    if (matchTypeId(rpc.requestId, query) || matchTypeId(rpc.responseId, query)) return true;
    return false;
  }

  function matchTypeRef(item, query) {
    if (!query) return true;
    const hay = `${item.fullName || ""} ${item.name || ""} ${item.comment || ""}`.toLowerCase();
    if (hay.includes(query)) return true;
    return matchTypeId(item.id, query);
  }

  function matchTypeId(id, query) {
    if (!id || !query) return false;
    const type = state.catalog.types?.[id];
    if (!type) return false;
    const head = `${type.fullName || ""} ${type.name || ""} ${type.comment || ""}`.toLowerCase();
    if (head.includes(query)) return true;
    if (type.kind === "enum") return matchEnumValues(type.values, query);
    if (matchFields(type.fields, query)) return true;
    for (const nested of type.nested || []) {
      const nestedHay = `${nested.name || ""} ${nested.comment || ""}`.toLowerCase();
      if (nestedHay.includes(query)) return true;
      if (matchTypeId(nested.id, query)) return true;
    }
    return false;
  }

  function matchFields(fields, query) {
    for (const field of fields || []) {
      const hay = [
        field.name,
        field.type,
        field.key,
        field.comment,
        field.oneof,
      ].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(query)) return true;
      if (field.typeId && matchTypeIdShallow(field.typeId, query)) return true;
      if (field.keyId && matchTypeIdShallow(field.keyId, query)) return true;
    }
    return false;
  }

  /** 字段类型只比名称/枚举值，避免递归炸栈 */
  function matchTypeIdShallow(id, query) {
    const type = state.catalog.types?.[id];
    if (!type) return false;
    const head = `${type.fullName || ""} ${type.name || ""} ${type.comment || ""}`.toLowerCase();
    if (head.includes(query)) return true;
    if (type.kind === "enum") return matchEnumValues(type.values, query);
    return false;
  }

  function matchEnumValues(values, query) {
    for (const value of values || []) {
      const hay = `${value.name || ""} ${value.comment || ""}`.toLowerCase();
      if (hay.includes(query)) return true;
    }
    return false;
  }

  function findRpc(id) {
    for (const pkg of state.catalog.packages || []) {
      for (const service of pkg.services || []) {
        const rpc = (service.rpcs || []).find((item) => item.id === id);
        if (rpc) return { pkg, service, rpc };
      }
    }
    return null;
  }

  /** 请求区头部：显示当前接口与字段数，方便确认在编辑哪个请求 */
  function updateRequestMeta() {
    const el = $("requestMeta");
    if (!el) return;
    const rpc = state.selected;
    if (!rpc) {
      el.textContent = "";
      return;
    }
    const text = String(els.messageEditor?.value || "").trim();
    const lines = text ? text.split("\n").length : 0;
    el.textContent = `${rpc.package}.${rpc.service}/${rpc.name} · ${(rpc.requestFields || []).length} 字段 · ${lines} 行`;
  }

  function selectRpc(id, opts = {}) {
    const hit = findRpc(id);
    if (!hit) return;
    if (state.selected && state.messageDirty && !opts.skipPersist) persistCurrentDraft();
    const { pkg, service, rpc } = hit;
    state.expanded.add(`pkg:${pkg.name}`);
    state.expanded.add(`svc:${service.id}`);
    state.selected = { ...rpc, package: pkg.name, service: service.name, serviceId: service.id };
    els.methodLabel.textContent = `${pkg.name}.${service.name}/${rpc.name}`;
    els.sendBtn.disabled = false;

    const draft = opts.draft || (!opts.forceGenerate ? state.drafts[rpc.id] : null);
    if (draft) {
      els.messageEditor.value = draft.message || generateMessage(rpc);
      state.metadata = Array.isArray(draft.metadata) && draft.metadata.length
        ? draft.metadata
        : [{ name: "", value: "", description: "" }];
      state.auth = normalizeAuth(draft.auth);
      if ($("protocolSelect")) {
        const p = (draft.protocol || "grpc").toLowerCase();
        $("protocolSelect").value = ["http", "sse", "websocket"].includes(p) ? p : "grpc";
      }
      if ($("httpMethodSelect")) {
        $("httpMethodSelect").value = draft.httpMethod
          || (draft.protocol === "sse" ? "GET" : rpc.httpVerb || "POST");
      }
      if ($("httpPath")) $("httpPath").value = draft.httpPath || rpc.httpPath || "";
    } else {
      els.messageEditor.value = generateMessage(rpc);
      state.metadata = [{ name: "", value: "", description: "" }];
      state.auth = defaultAuth();
      if ($("protocolSelect")) $("protocolSelect").value = "grpc";
      if ($("httpMethodSelect")) $("httpMethodSelect").value = rpc.httpVerb || "POST";
      if ($("httpPath")) $("httpPath").value = rpc.httpPath || "";
    }
    state.messageDirty = false;
    state.docsNav = [];
    syncProtocolUi();
    renderMetadata();
    renderAuth();
    renderRpcInfo();
    paintDocs();
    refreshGhzCommand();
    renderTree();
    setTab(opts.tab || state.tab);
    updateRequestMeta();
    syncScopedHistory(Boolean(opts.showLatest));
  }

  function renderRpcInfo() {
    const el = els.rpcInfo;
    if (!el) return;
    const rpc = state.selected;
    if (!rpc) {
      el.innerHTML = `<div class="rpc-info-empty">选择左侧接口后显示定义与说明。</div>`;
      return;
    }
    const chips = [];
    if (rpc.httpVerb) chips.push(`<span class="rpc-info-chip">${esc(rpc.httpVerb)} ${esc(rpc.httpPath || "")}</span>`);
    for (const badge of rpc.badges || []) {
      chips.push(`<span class="rpc-info-chip${badge.warn ? " warn" : ""}">${esc(badge.text)}</span>`);
    }
    const source = rpc.source
      ? `<details class="rpc-info-block rpc-info-def" open><summary>接口定义</summary><pre>${esc(rpc.source)}</pre></details>`
      : "";
    el.innerHTML = `
      <section class="rpc-info-block">
        <h3 class="rpc-info-title">${esc(rpc.name)}</h3>
        <p class="rpc-info-lead">${esc(rpc.comment || "无注释")}</p>
        <p class="rpc-info-meta">${esc(rpc.package)}.${esc(rpc.service)} · ${esc(rpc.file || "")}${rpc.line ? `:${rpc.line}` : ""}</p>
        ${chips.length ? `<div class="rpc-info-chips">${chips.join("")}</div>` : ""}
      </section>
      <section class="rpc-info-block rpc-info-row"><span>请求</span><code>${esc(rpc.request)}</code></section>
      <section class="rpc-info-block rpc-info-row"><span>响应</span><code>${esc(rpc.response)}</code></section>
      <section class="rpc-info-block rpc-info-row"><span>字段</span><code>${(rpc.requestFields || []).length} 个请求字段</code></section>
      ${source}
      ${rpc.path ? `<section class="rpc-info-block"><button class="btn" type="button" data-src="${esc(rpc.path)}" data-line="${rpc.line || 1}">跳转到源码</button></section>` : ""}
    `;
  }

  function preferIntAsString(field) {
    if (!field) return false;
    if (field.jstype === "JS_STRING") return true;
    if (field.jstype === "JS_NUMBER") return false;
    return /^(int64|uint64|sint64|fixed64|sfixed64)$/i.test(String(field.type || ""));
  }

  function canBeSafeIntegerText(digitStr) {
    if (!/^-?\d+$/.test(digitStr)) return false;
    const n = Number(digitStr);
    return Number.isSafeInteger(n) && String(n) === digitStr;
  }

  /** JSON.parse 前把超大整型字面量加引号，避免 JS Number 丢精度；jstype/int64 发送时保持字符串 */
  function parseJsonPreserveLongs(raw) {
    const src = String(raw ?? "").trim() || "{}";
    const quoted = src.replace(/([:\[,]\s*)(-?\d+)(\s*[,\]\}])/g, (m, pre, digits, post) => {
      if (canBeSafeIntegerText(digits)) return m;
      return `${pre}"${digits}"${post}`;
    });
    return JSON.parse(quoted);
  }

  function normalizeBodyLongs(value, fields) {
    if (!fields?.length || value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value;
    const out = { ...value };
    for (const field of fields) {
      if (!field || !Object.prototype.hasOwnProperty.call(out, field.name)) continue;
      const raw = out[field.name];
      if (field.repeated && Array.isArray(raw)) {
        const itemField = { ...field, repeated: false };
        out[field.name] = raw.map((item) => {
          if (preferIntAsString(itemField) && (typeof item === "number" || typeof item === "string")) {
            return String(item);
          }
          if (item && typeof item === "object") {
            const typeDef = field.typeId ? state.catalog.types?.[field.typeId] : undefined;
            if (typeDef?.kind === "message") return normalizeBodyLongs(item, typeDef.fields || []);
          }
          return item;
        });
        continue;
      }
      if (preferIntAsString(field) && (typeof raw === "number" || (typeof raw === "string" && /^-?\d+$/.test(raw)))) {
        out[field.name] = String(raw);
        continue;
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && !field.key) {
        const typeDef = field.typeId ? state.catalog.types?.[field.typeId] : undefined;
        if (typeDef?.kind === "message") {
          out[field.name] = normalizeBodyLongs(raw, typeDef.fields || []);
        }
      }
    }
    return out;
  }

  function sampleValue(field, depth = 0, seen = new Set()) {
    if (field.repeated) {
      if (depth >= 2) return [];
      return [sampleValue({ ...field, repeated: false }, depth + 1, seen)];
    }
    if (field.key) {
      if (depth >= 2) return {};
      const keySample = sampleScalar(field.key, `${field.name}Key`, field);
      return { [String(keySample)]: sampleValue({ ...field, key: undefined }, depth + 1, seen) };
    }

    const type = (field.type || "").replace(/^\./, "");
    const typeDef = field.typeId ? state.catalog.types?.[field.typeId] : undefined;
    if (typeDef?.kind === "enum") return sampleEnum(typeDef);
    if (typeDef?.kind === "message") return sampleMessage(typeDef, depth, seen);
    return sampleScalar(type, field.name, field);
  }

  function sampleEnum(typeDef) {
    const values = typeDef.values || [];
    if (!values.length) return 0;
    const preferred = values.find((item) => item.number !== 0) || values[0];
    return preferred.number;
  }

  function sampleMessage(typeDef, depth, seen) {
    if (depth >= 2 || seen.has(typeDef.id)) return {};
    const next = new Set(seen);
    next.add(typeDef.id);
    const body = {};
    for (const field of typeDef.fields || []) {
      body[field.name] = sampleValue(field, depth + 1, next);
    }
    return body;
  }

  function sampleScalar(type, fieldName, field) {
    const name = fieldName || "";
    const lower = name.toLowerCase();
    const hint = nameHint(lower);

    if (type === "bool") {
      if (hint === "enable" || /enable|active|valid|success|ok|visible|open/.test(lower)) return true;
      return false;
    }
    if (type === "bytes") return "Ynl0ZXM=";
    if (type === "string") return sampleString(name, lower, hint);
    if (["double", "float"].includes(type)) {
      if (hint === "ratio" || /rate|ratio|percent|score/.test(lower)) return 0.85;
      if (hint === "price" || /price|amount|cost|money|fee/.test(lower)) return 9.9;
      return 1.5;
    }
    if (["int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64"].includes(type)) {
      const asString = preferIntAsString(field || { type, jstype: field?.jstype });
      const n = sampleNumber(name, lower, hint, type.includes("64") || asString);
      return asString ? String(n) : n;
    }
    return sampleString(name, lower, "default");
  }

  function nameHint(lower) {
    if (/(email|mail)/.test(lower)) return "email";
    if (/(phone|mobile|tel)/.test(lower)) return "phone";
    if (/(url|uri|link|href)/.test(lower)) return "url";
    if (/(token|jwt|authorization|auth|secret|password|passwd|pwd)/.test(lower)) return "token";
    if (/(uuid|guid)/.test(lower)) return "uuid";
    if (/(ip$|ipaddr|host)/.test(lower)) return "host";
    if (/(time|timestamp|expire|deadline|created|updated|at$)/.test(lower)) return "time";
    if (/(date|day|birthday)/.test(lower)) return "date";
    if (/(count|num|amount|qty|quantity|size|len|limit|page|offset|index|cap)/.test(lower)) return "count";
    if (/(price|cost|money|fee|balance)/.test(lower)) return "price";
    if (/(rate|ratio|percent|score)/.test(lower)) return "ratio";
    if (/(version|ver)/.test(lower)) return "version";
    if (/(code|status)/.test(lower)) return "code";
    if (/(name|title|nick)/.test(lower)) return "name";
    if (/(desc|comment|remark|note|msg|message|text|content|reason)/.test(lower)) return "text";
    if (/(id$|_id)/.test(lower) || lower === "id") return "id";
    if (/(enable|active|valid|success|ok|visible|open)/.test(lower)) return "enable";
    return "default";
  }

  function sampleString(name, lower, hint) {
    switch (hint) {
      case "email": return "player@example.com";
      case "phone": return "13800138000";
      case "url": return "https://example.com/api";
      case "token": return "Bearer demo-token";
      case "uuid": return "550e8400-e29b-41d4-a716-446655440000";
      case "host": return "127.0.0.1";
      case "time": return String(Math.floor(Date.now() / 1000));
      case "date": return new Date().toISOString().slice(0, 10);
      case "version": return "1.0.0";
      case "code": return "OK";
      case "name": return name.replace(/name$/i, "") ? `${prettyLabel(name)}Demo` : "Demo";
      case "text": return `${prettyLabel(name) || "示例"}说明`;
      case "id": return `${prettyLabel(name) || "id"}_demo`;
      default:
        if (/lang|locale/.test(lower)) return "zh-CN";
        if (/currency|coin/.test(lower)) return "CNY";
        return prettyLabel(name) || "demo";
    }
  }

  function sampleNumber(name, lower, hint, is64) {
    if (hint === "time") return Math.floor(Date.now() / 1000);
    if (hint === "count") {
      if (/page/.test(lower)) return 1;
      if (/offset|index/.test(lower)) return 0;
      if (/limit|size|len|cap/.test(lower)) return 20;
      return 3;
    }
    if (hint === "price") return 100;
    if (hint === "version") return 1;
    if (hint === "code") return 0;
    if (hint === "id" || /id$|_id/.test(lower) || lower === "id") return is64 ? "10001" : 10001;
    if (/level|lv/.test(lower)) return 1;
    if (/port/.test(lower)) return 19200;
    if (/pos|slot|site/.test(lower)) return 1;
    return is64 ? "1" : 1;
  }

  function prettyLabel(name) {
    return String(name || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\s+/g, "");
  }

  function generateMessage(rpc) {
    const body = {};
    for (const field of rpc.requestFields || []) {
      body[field.name] = sampleValue(field);
    }
    return JSON.stringify(body, null, 2);
  }

  function formatMessage() {
    try {
      const obj = parseJsonPreserveLongs(els.messageEditor.value || "{}");
      const rpc = state.selected;
      const normalized = rpc ? normalizeBodyLongs(obj, rpc.requestFields || []) : obj;
      els.messageEditor.value = JSON.stringify(normalized, null, 2);
      state.messageDirty = true;
      setRespBadge("ok", "Message 已格式化");
    } catch (error) {
      setRespBadge("err", `JSON 无法格式化：${error.message}`);
    }
  }

  function paintDocs() {
    const hit = state.selected ? findRpc(state.selected.id) : null;
    const typeId = state.docsNav[state.docsNav.length - 1];
    if (typeId && state.catalog.types?.[typeId]) {
      renderTypeDoc(hit, typeId);
      return;
    }
    if (!hit) {
      els.docsView.innerHTML = `<div class="doc-empty">选择左侧接口、消息或枚举后显示注释与字段。</div>`;
      return;
    }
    renderDocs(hit.pkg, hit.service, hit.rpc);
  }

  function openType(id) {
    if (!id || !state.catalog.types?.[id]) return;
    state.docsNav.push(id);
    setTab("docs");
    paintDocs();
    renderTree();
  }

  function selectType(id) {
    if (!id || !state.catalog.types?.[id]) return;
    const type = state.catalog.types[id];
    state.expanded.add(`pkg:${type.package}`);
    state.expanded.add(`pkg:${type.package}:${type.kind === "enum" ? "enums" : "messages"}`);
    state.docsNav = [id];
    setTab("docs");
    paintDocs();
    renderTree();
  }

  function typeLink(text, id) {
    if (!id || !state.catalog.types?.[id]) return `<span class="doc-type">${esc(text)}</span>`;
    return `<button class="doc-link" type="button" data-type="${esc(id)}">${esc(text)}</button>`;
  }

  function fieldTypeHtml(field) {
    const prefix = field.repeated ? "repeated " : field.optional ? "optional " : "";
    const oneof = field.oneof ? `<span class="doc-chip">oneof ${esc(field.oneof)}</span> ` : "";
    if (field.key) {
      return `${oneof}<span class="doc-type">${esc(prefix)}map&lt;</span>${typeLink(field.key, field.keyId)}<span class="doc-type">, </span>${typeLink(field.type, field.typeId)}<span class="doc-type">&gt;</span>`;
    }
    return `${oneof}${prefix ? `<span class="doc-type">${esc(prefix)}</span>` : ""}${typeLink(field.type, field.typeId)}`;
  }

  function fieldRows(fields) {
    return (fields || []).map((field) => `<tr>
      <td class="doc-num">${field.number}</td>
      <td>${fieldTypeHtml(field)}</td>
      <td class="doc-name">${esc(field.name)}</td>
      <td class="doc-comment">${esc(field.comment || "")}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="doc-comment">无字段</td></tr>`;
  }

  function sourceButton(path, line) {
    if (!path) return "";
    return `<button class="btn" type="button" data-src="${esc(path)}" data-line="${Number(line) || 1}">跳转到源码</button>`;
  }

  function renderDocs(pkg, service, rpc) {
    els.docsView.innerHTML = `<div class="doc-page">
      <div class="doc-toolbar">${sourceButton(rpc.path || rpc.file, rpc.line)}</div>
      <div class="doc-crumbs"><span>${esc(pkg.name)}</span><span>/</span><span>${esc(service.name)}</span><span>/</span><span>${esc(rpc.name)}</span></div>
      <h2 class="doc-title">${esc(rpc.name)}</h2>
      <p class="doc-lead">${esc(rpc.comment || "无注释")}</p>
      <p class="doc-file">${esc(rpc.file || "")}${rpc.line ? `:${rpc.line}` : ""}</p>
      <div class="doc-pair">
        ${docCard("请求", rpc.request, rpc.requestId, rpc.requestFields)}
        ${docCard("响应", rpc.response, rpc.responseId, rpc.responseFields)}
      </div>
    </div>`;
  }

  function renderTypeDoc(hit, id) {
    const type = state.catalog.types[id];
    const canBack = state.docsNav.length > 1 || !!hit;
    const back = canBack ? `<button class="btn" type="button" data-doc-back="1">返回</button>` : "";
    const crumbs = state.docsNav.map((item) => {
      const node = state.catalog.types[item];
      return node ? esc(node.fullName || node.name) : esc(item);
    }).join(`<span>/</span>`);
    const prefix = hit
      ? `<span>${esc(hit.pkg.name)}</span><span>/</span><span>${esc(hit.service.name)}</span><span>/</span><span>${esc(hit.rpc.name)}</span><span>/</span>`
      : `<span>${esc(type.package || "")}</span><span>/</span>`;
    const body = type.kind === "enum" ? enumTable(type) : `<div class="doc-card"><table>
      <thead><tr><th>#</th><th>类型</th><th>字段</th><th>说明</th></tr></thead>
      <tbody>${fieldRows(type.fields)}</tbody>
    </table></div>${nestedList(type)}`;
    els.docsView.innerHTML = `<div class="doc-page">
      <div class="doc-toolbar">${back}${sourceButton(type.path || type.file, type.line)}</div>
      <div class="doc-crumbs">${prefix}${crumbs}</div>
      <h2 class="doc-title">${esc(type.fullName || type.name)}</h2>
      <p class="doc-lead">${esc(type.comment || (type.kind === "enum" ? "枚举" : "message"))}</p>
      <p class="doc-file">${esc(type.file || "")}${type.line ? `:${type.line}` : ""}</p>
      ${body}
    </div>`;
  }

  function enumTable(type) {
    const rows = (type.values || []).map((value) => `<tr>
      <td class="doc-num">${value.number}</td>
      <td class="doc-name">${esc(value.name)}</td>
      <td class="doc-comment">${esc(value.comment || "")}</td>
    </tr>`).join("") || `<tr><td colspan="3" class="doc-comment">无枚举项</td></tr>`;
    return `<div class="doc-card"><table>
      <thead><tr><th>#</th><th>名称</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function nestedList(type) {
    const items = type.nested || [];
    if (!items.length) return "";
    const rows = items.map((item) => `<button class="doc-row" type="button" data-type="${esc(item.id)}">
      <span class="doc-name">${esc(item.name)}</span>
      <span class="doc-comment">${esc(item.comment || item.kind)}</span>
    </button>`).join("");
    return `<div class="doc-nested"><div class="doc-kicker">嵌套定义</div>${rows}</div>`;
  }

  function docCard(title, typeName, typeId, fields) {
    return `<div class="doc-card">
      <div class="doc-kicker">${esc(title)}</div>
      <h3>${typeLink(typeName, typeId)}</h3>
      <table>
        <thead><tr><th>#</th><th>类型</th><th>字段</th><th>说明</th></tr></thead>
        <tbody>${fieldRows(fields)}</tbody>
      </table>
    </div>`;
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function toBase64(text) {
    try {
      return btoa(unescape(encodeURIComponent(text)));
    } catch {
      return btoa(text);
    }
  }

  function authMetadata() {
    const auth = state.auth || defaultAuth();
    const out = {};
    switch (auth.type) {
      case "bearer": {
        const token = (auth.token || "").trim();
        if (token) out.authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
        break;
      }
      case "basic": {
        const user = auth.username || "";
        const pass = auth.password || "";
        if (user || pass) out.authorization = `Basic ${toBase64(`${user}:${pass}`)}`;
        break;
      }
      case "apikey": {
        const key = (auth.apiKey || "").trim();
        if (key) out[key] = auth.apiValue ?? "";
        break;
      }
      case "oauth2": {
        const token = (auth.oauthToken || "").trim();
        if (token) out.authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
        break;
      }
      case "wsse": {
        const user = (auth.wsseUser || "").trim();
        const pass = auth.wssePass || "";
        if (user) {
          const created = new Date().toISOString();
          const nonce = Math.random().toString(36).slice(2, 14);
          out["x-wsse"] = `UsernameToken Username="${user}", PasswordDigest="${toBase64(pass)}", Nonce="${nonce}", Created="${created}"`;
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  function requestMetadata() {
    return { ...metadataObject(), ...authMetadata() };
  }

  function buildGrpcurl() {
    const rpc = state.selected;
    if (!rpc) return "";
    const host = els.address.value.trim() || activeEnv()?.host || "localhost:50051";
    let body = (els.messageEditor.value || "{}").trim();
    try {
      const rpc = state.selected;
      const parsed = parseJsonPreserveLongs(body);
      body = JSON.stringify(rpc ? normalizeBodyLongs(parsed, rpc.requestFields || []) : parsed);
    } catch { /* keep raw */ }
    const headers = Object.entries(requestMetadata())
      .map(([name, value]) => `  -H ${shellQuote(`${name}: ${value ?? ""}`)}`);
    const proto = rpc.file ? `  -proto ${shellQuote(rpc.file)}` : "";
    const method = `${rpc.package}.${rpc.service}/${rpc.name}`;
    return [
      "grpcurl -plaintext \\",
      ...headers.map((line) => `${line} \\`),
      `  -d ${shellQuote(body)} \\`,
      proto ? `${proto} \\` : "",
      `  ${shellQuote(host)} \\`,
      `  ${shellQuote(method)}`,
    ].filter(Boolean).join("\n");
  }

  function renderAuth() {
    const auth = state.auth = normalizeAuth(state.auth);
    const typeEl = $("authType");
    if (typeEl) typeEl.value = auth.type || "none";
    const body = $("authBody");
    if (!body) return;
    const field = (label, id, value, opts = {}) => `<label class="auth-field">
      <span>${esc(label)}</span>
      <input id="${esc(id)}" type="${opts.type || "text"}" value="${esc(value || "")}" placeholder="${esc(opts.placeholder || "")}" ${opts.autocomplete ? `autocomplete="${esc(opts.autocomplete)}"` : ""} />
    </label>`;
    let html = "";
    switch (auth.type) {
      case "bearer":
        html = field("Token", "authToken", auth.token, { placeholder: "eyJhbGciOi..." });
        break;
      case "basic":
        html = field("Username", "authUsername", auth.username, { autocomplete: "username" })
          + field("Password", "authPassword", auth.password, { type: "password", autocomplete: "current-password" });
        break;
      case "apikey":
        html = field("Key", "authApiKey", auth.apiKey, { placeholder: "x-api-key" })
          + field("Value", "authApiValue", auth.apiValue, { placeholder: "your-api-key" });
        break;
      case "oauth2":
        html = `<p class="auth-hint">仅粘贴已有 Access Token（不做授权码跳转）。发送时写入 authorization Bearer。</p>`
          + field("Access Token", "authOauthToken", auth.oauthToken, { placeholder: "access_token" });
        break;
      case "wsse":
        html = field("Username", "authWsseUser", auth.wsseUser)
          + field("Password", "authWssePass", auth.wssePass, { type: "password" });
        break;
      default:
        html = `<p class="auth-hint">当前不注入鉴权头。需要登录时可选择 Bearer / Basic / API Key 等；也可在 Metadata 里手动添加 authorization。</p>`;
    }
    body.innerHTML = html;
    updateAuthPreview();
  }

  function readAuthForm() {
    const auth = normalizeAuth(state.auth);
    auth.type = $("authType")?.value || "none";
    if ($("authToken")) auth.token = $("authToken").value;
    if ($("authUsername")) auth.username = $("authUsername").value;
    if ($("authPassword")) auth.password = $("authPassword").value;
    if ($("authApiKey")) auth.apiKey = $("authApiKey").value;
    if ($("authApiValue")) auth.apiValue = $("authApiValue").value;
    if ($("authOauthToken")) auth.oauthToken = $("authOauthToken").value;
    if ($("authWsseUser")) auth.wsseUser = $("authWsseUser").value;
    if ($("authWssePass")) auth.wssePass = $("authWssePass").value;
    state.auth = auth;
    return auth;
  }

  function updateAuthPreview() {
    const preview = $("authPreview");
    if (!preview) return;
    const injected = authMetadata();
    const keys = Object.keys(injected);
    if (!keys.length) {
      preview.textContent = "将注入：无";
      return;
    }
    preview.textContent = `将注入：${keys.map((key) => `${key}: ${maskAuthValue(key, injected[key])}`).join(" · ")}`;
  }

  function maskAuthValue(key, value) {
    const text = String(value ?? "");
    if (!text) return "";
    if (/authorization|password|token|secret|wsse/i.test(key) || /Bearer |Basic /i.test(text)) {
      if (text.length <= 12) return "••••";
      return `${text.slice(0, 10)}…`;
    }
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  }

  function renderMetadata() {
    if (!state.metadata.length) state.metadata = [{ name: "", value: "", description: "" }];
    els.metaBody.innerHTML = state.metadata.map((row, index) => `
      <tr data-meta-index="${index}">
        <td class="col-name"><input data-meta-key="name" placeholder="Name" value="${esc(row.name)}" /></td>
        <td class="col-value"><input data-meta-key="value" placeholder="Value" value="${esc(row.value)}" /></td>
        <td class="col-desc"><input data-meta-key="description" placeholder="Description" value="${esc(row.description)}" /></td>
        <td class="col-act"><button class="link danger" type="button" data-meta-del="${index}">删除</button></td>
      </tr>
    `).join("");
  }

  function metadataObject() {
    const out = {};
    for (const row of state.metadata) {
      const name = (row.name || "").trim();
      if (!name) continue;
      out[name] = row.value ?? "";
    }
    return out;
  }

  function setTab(tab) {
    state.tab = tab;
    for (const node of document.querySelectorAll(".tab")) {
      node.classList.toggle("active", node.getAttribute("data-tab") === tab);
    }
    // 只切换主面板的 view-*；db 的 .view 面板单独由 db.js 管理
    for (const node of document.querySelectorAll(".view[id^='view-']")) {
      node.classList.toggle("active", node.id === `view-${tab}`);
    }
    const messageTools = tab === "message";
    $("genMsgBtn").hidden = !messageTools;
    $("formatMsgBtn").hidden = !messageTools;
    $("clearMsgBtn").hidden = !messageTools;
    $("clearHistoryBarBtn")?.classList.toggle("hidden", tab !== "history");
    if (tab === "history") renderHistory();
    els.toolbarHint.textContent = tab === "message"
      ? "左侧为接口说明，右侧编辑请求 JSON"
      : tab === "metadata"
        ? "表格编辑 metadata，支持 Bulk Edit"
        : tab === "auth"
          ? "鉴权写入 Metadata；与表格同名键时以 Auth 为准"
          : tab === "stress"
            ? "轻量压测或 ghz；结果在下方面板查看"
            : "";
    if (tab === "auth") renderAuth();
    if (tab === "stress") {
      setStressMode(state.stressMode);
      refreshGhzCommand();
    }
  }

  let activeEnvStorageKey = "protoview.client.activeEnvId";

  function persistEnvs() {
    try { localStorage.setItem(activeEnvStorageKey, state.activeEnvId); } catch { /* ignore */ }
    const payload = { envs: state.envs };
    if (vscode) vscode.postMessage({ type: "saveEnvs", payload });
    else localStorage.setItem("protoview.client.envs", JSON.stringify(payload));
  }

  function loadLocalEnvs() {
    try {
      const raw = localStorage.getItem("protoview.client.envs");
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.envs) && data.envs.length) {
        state.envs = data.envs;
        state.activeEnvId = localStorage.getItem(activeEnvStorageKey) || data.envs[0].id;
      }
    } catch {
      // ignore
    }
  }

  function applyBootstrap(data) {
    const prevSelected = state.selected?.id;
    if (data.catalog) state.catalog = data.catalog;
    activeEnvStorageKey = `protoview.client.activeEnvId:${data.workspaceKey || "default"}`;
    if (data.envs && Array.isArray(data.envs.envs) && data.envs.envs.length) {
      state.envs = data.envs.envs;
      let savedId = "";
      try { savedId = localStorage.getItem(activeEnvStorageKey) || ""; } catch { /* ignore */ }
      state.activeEnvId = state.envs.some((env) => env.id === savedId) ? savedId : state.envs[0].id;
    }
    if (data.source && typeof data.source === "object") {
      const mode = data.source.mode === "git" ? "git" : "directory";
      state.source = {
        mode,
        dirPath: data.source.dirPath || data.source.localPath || "",
        gitUrl: data.source.gitUrl || "",
        gitBranch: data.source.gitBranch || "main",
        localPath: data.source.localPath || "",
        lastError: data.source.lastError || "",
      };
    }
    els.sourceMeta.textContent = state.catalog.sourceLabel || (isDbxWorkbench ? "ApiMan" : "ProtoView Client");
    if (data.qr) state.qr = data.qr;
    renderEnvSelect();
    renderTree();
    if (prevSelected && findRpc(prevSelected)) selectRpc(prevSelected);
    else if (!state.selected) {
      const first = state.catalog.packages?.[0]?.services?.[0]?.rpcs?.[0];
      if (first) selectRpc(first.id);
    }
  }

  function syncSourceModalUi() {
    const mode = document.querySelector('input[name="sourceMode"]:checked')?.value || "directory";
    $("sourceGitFields")?.classList.toggle("hidden", mode !== "git");
    $("sourceDirFields")?.classList.toggle("hidden", mode !== "directory");
    const pickBtn = $("pickSourceDirBtn");
    if (pickBtn) pickBtn.classList.toggle("hidden", !vscode);
  }

  function bytesToBase64(bytes) {
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  const OPEN_WITH_KEY = "protoview.client.openWith";

  function getOpenWithTarget() {
    const el = $("openWithSelect");
    const v = el?.value || localStorage.getItem(OPEN_WITH_KEY) || "preview";
    return ["preview", "cursor", "code", "notepad", "auto"].includes(v) ? v : "preview";
  }

  function initOpenWithUi() {
    const wrap = $("openWithWrap");
    const sel = $("openWithSelect");
    if (!wrap || !sel) return;
    // 仅 npm / 浏览器端需要选择打开方式；VS Code 插件直接在编辑器打开
    wrap.classList.toggle("hidden", isVsCodeWebview);
    const saved = localStorage.getItem(OPEN_WITH_KEY) || "preview";
    if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;
    sel.addEventListener("change", () => {
      localStorage.setItem(OPEN_WITH_KEY, sel.value);
    });
  }

  let sourcePreview = { file: "", line: 1 };
  /** 抽屉当前模式：code=代码预览，graph=函数调用链路图 */
  let sourceDrawerMode = "code";
  let callGraphState = { zoom: 1, item: null, depth: 2, graph: null, panX: 0, panY: 0 };

  function applyCallGraphTransform() {
    const world = $("callGraphWorld");
    if (!world) return;
    const { zoom, panX, panY } = callGraphState;
    world.style.transformOrigin = "0 0";
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const reset = $("callGraphZoomReset");
    if (reset) reset.textContent = `${Math.round(zoom * 100)}%`;
  }

  function applyCallGraphZoom() {
    callGraphState.zoom = Math.max(0.25, Math.min(2.5, callGraphState.zoom));
    applyCallGraphTransform();
  }

  // 画布平移 + 滚轮缩放（缩放以指针为中心）
  function bindCallGraphPanZoom() {
    const board = $("callGraphBoard");
    const world = $("callGraphWorld");
    if (!board || !world || board.dataset.panZoomBound === "1") return;
    board.dataset.panZoomBound = "1";

    board.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = board.getBoundingClientRect();
      const mx = event.clientX - rect.left - board.scrollLeft;
      const my = event.clientY - rect.top - board.scrollTop;
      const prev = callGraphState.zoom;
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      const next = Math.max(0.25, Math.min(2.5, prev * factor));
      if (next === prev) return;
      // 让指针下的点在缩放前后保持不动
      callGraphState.panX = mx - ((mx - callGraphState.panX) / prev) * next;
      callGraphState.panY = my - ((my - callGraphState.panY) / prev) * next;
      callGraphState.zoom = next;
      applyCallGraphTransform();
    }, { passive: false });

    let drag = null;
    board.addEventListener("mousedown", (event) => {
      // 点在按钮/节点上不拖动，交给点击逻辑
      if (event.button !== 0) return;
      if (event.target.closest?.(".call-graph-node, .gs-action, .call-graph-db-panel")) return;
      drag = { x: event.clientX, y: event.clientY, panX: callGraphState.panX, panY: callGraphState.panY };
      board.classList.add("panning");
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!drag) return;
      callGraphState.panX = drag.panX + (event.clientX - drag.x);
      callGraphState.panY = drag.panY + (event.clientY - drag.y);
      applyCallGraphTransform();
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      board.classList.remove("panning");
    });
  }

  function setSourceDrawerMode(mode) {
    sourceDrawerMode = mode === "graph" ? "graph" : "code";
    const isGraph = sourceDrawerMode === "graph";
    $("callGraphBar")?.classList.toggle("hidden", !isGraph);
    $("callGraphBoard")?.classList.toggle("hidden", !isGraph);
    $("sourceDrawerCode")?.classList.toggle("hidden", isGraph);
    document.getElementById("app")?.classList.toggle("graph-mode", isGraph);
    const ext = $("sourceDrawerExtBtn");
    if (ext) ext.textContent = isGraph ? "打开源码" : "外部打开";
  }

  function closeSourceDrawer() {
    const drawer = $("sourceDrawer");
    const app = document.getElementById("app");
    drawer?.classList.add("hidden");
    app?.classList.remove("source-open");
  }

  function openDrawer() {
    const drawer = $("sourceDrawer");
    const app = document.getElementById("app");
    drawer?.classList.remove("hidden");
    app?.classList.add("source-open");
  }

  function showSourceDrawer(file, line, content) {
    const drawer = $("sourceDrawer");
    const code = $("sourceDrawerCode");
    const nameEl = $("sourceDrawerName");
    const metaEl = $("sourceDrawerMeta");
    if (!drawer || !code) return;
    setSourceDrawerMode("code");
    sourcePreview = { file: String(file || ""), line: Math.max(1, Number(line) || 1) };
    const base = String(file || "").replace(/\\/g, "/").split("/").pop() || "源码";
    if (nameEl) nameEl.textContent = base;
    if (metaEl) metaEl.textContent = `${file}:${sourcePreview.line}`;
    const lines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
    code.innerHTML = lines.map((text, i) => {
      const n = i + 1;
      const mark = n === sourcePreview.line ? " is-target" : "";
      return `<div class="source-line${mark}" data-line="${n}"><span class="source-line-no">${n}</span><span class="source-line-text">${esc(text)}</span></div>`;
    }).join("");
    openDrawer();
    requestAnimationFrame(() => {
      code.querySelector(".source-line.is-target")?.scrollIntoView({ block: "center" });
    });
  }

  // ===== 函数调用链路图 =====
  /** 统一成 {name,file,line}，避免状态里存 title 又读 name 导致清空 */
  function callGraphTarget(item) {
    return {
      name: String(item?.name || item?.title || ""),
      file: String(item?.file || ""),
      line: Math.max(1, Number(item?.line) || 1),
    };
  }

  function requestCallGraph(item, depth) {
    const target = callGraphTarget(item);
    if (!target.name && !target.file) return;
    const next = Math.max(1, Math.min(5, Math.floor(Number(depth) || callGraphState.depth || 2)));
    callGraphState.item = target;
    callGraphState.depth = next;
    const sel = $("callGraphDepth");
    if (sel) sel.value = String(next);
    const stat = $("callGraphStat");
    if (stat) stat.textContent = "扫描中…";
    const world = $("callGraphWorld");
    if (world) world.innerHTML = `<div class="call-graph-empty">正在分析调用链路…</div>`;
    if (!vscode) {
      if (stat) stat.textContent = "独立模式无法分析项目调用链";
      return;
    }
    vscode.postMessage({
      type: "loadCallGraph",
      payload: { name: target.name, file: target.file, depth: next },
    });
  }

  function showCallGraphPreview(item) {
    const target = callGraphTarget(item);
    if (!target.name && !target.file) return;
    setSourceDrawerMode("graph");
    callGraphState.item = target;
    sourcePreview = { file: target.file, line: target.line };
    const nameEl = $("sourceDrawerName");
    const metaEl = $("sourceDrawerMeta");
    if (nameEl) nameEl.textContent = `${target.name} 调用链路`;
    if (metaEl) metaEl.textContent = target.file ? `${target.file}:${target.line}` : "";
    openDrawer();
    requestCallGraph(target, callGraphState.depth || 2);
  }

  function applyCallGraphZoom() {
    callGraphState.zoom = Math.max(0.25, Math.min(2.5, callGraphState.zoom));
    applyCallGraphTransform();
  }

  function renderCallGraph(graph) {
    const world = $("callGraphWorld");
    const stat = $("callGraphStat");
    if (!world) return;
    if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) {
      const name = esc(callGraphState.item?.name || "");
      const scanned = graph ? `，已扫描 ${graph.scannedFiles} 个 .go 文件` : "";
      world.innerHTML = `<div class="call-graph-empty">没有找到「${name}」的函数调用信息${scanned}
        <div class="call-graph-empty-tip">接口名通常不是 Go 函数名，可先「跳转源码」找到实现函数名，再到函数 Tab 里预览。</div>
      </div>`;
      if (stat) stat.textContent = graph ? `${graph.scannedFiles} 个文件` : "分析失败";
      return;
    }
    // 按层分布：BFS 计算每层序号
    const children = new Map();
    for (const edge of graph.edges || []) {
      const list = children.get(edge.from) || [];
      list.push(edge.to);
      children.set(edge.from, list);
    }
    const rootId = graph.rootId || graph.nodes[0].id;
    const levels = new Map([[rootId, 0]]);
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      for (const child of children.get(id) || []) {
        if (!levels.has(child)) {
          levels.set(child, (levels.get(id) || 0) + 1);
          queue.push(child);
        }
      }
    }
    const perLevel = new Map();
    const placed = new Map();
    for (const node of graph.nodes) {
      const level = levels.get(node.id) ?? 0;
      const idx = perLevel.get(level) || 0;
      perLevel.set(level, idx + 1);
      placed.set(node.id, { x: 60 + level * 250, y: 40 + idx * 96, level });
    }
    const nodeCard = (node) => {
      const pos = placed.get(node.id);
      const dbTags = (node.db || []).map((hit) =>
        `<span class="call-graph-db-tag is-${hit.op}" title="${esc(hit.table)}">${hit.op === "read" ? "读" : hit.op === "write" ? "写" : "?"} ${esc(hit.table)}</span>`,
      ).join("");
      const depthLabel = levels.get(node.id) ?? 0;
      return `<div class="call-graph-node lv-${depthLabel > 0 ? "child" : "root"}" data-cg-node="${esc(node.id)}"
        style="left:${pos.x}px;top:${pos.y}px"
        data-cg-name="${esc(node.name)}" data-cg-file="${esc(node.file)}" data-cg-abs="${esc(node.abs || "")}" data-cg-line="${node.line}">
        <div class="call-graph-node-head">
          <strong>${esc(node.receiver ? `${node.receiver}.${node.name}` : node.name)}</strong>
          <span>${esc(node.file)}:${node.line}</span>
        </div>
        ${dbTags ? `<div class="call-graph-db">${dbTags}</div>` : ""}
        <div class="call-graph-node-actions">
          <button class="gs-action" type="button" data-cg-src title="跳转源码">跳转源码</button>
          <button class="gs-action" type="button" data-cg-db title="查看读写的数据库表">查看 DB</button>
        </div>
      </div>`;
    };
    const lines = (graph.edges || []).map((edge) => {
      const from = placed.get(edge.from);
      const to = placed.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + 190;
      const y1 = from.y + 34;
      const x2 = to.x;
      const y2 = to.y + 34;
      const mx = (x1 + x2) / 2;
      return `<path class="call-graph-edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" />`;
    }).join("");
    world.innerHTML = `${nodeCardGraphSvg(lines)}
      ${graph.nodes.map(nodeCard).join("")}`;
    const width = Math.max(600, ...[...placed.values()].map((p) => p.x + 240));
    const height = Math.max(320, ...[...placed.values()].map((p) => p.y + 110));
    const svg = world.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    const board = $("callGraphBoard");
    if (board) {
      board.style.setProperty("--cg-w", `${width}px`);
      board.style.setProperty("--cg-h", `${height}px`);
    }
    if (stat) {
      stat.textContent = `${graph.nodes.length} 函数 · 深度 ${graph.depth}${graph.truncated ? " · 已截断" : ""}`;
    }
    callGraphState.graph = graph;
    callGraphState.panX = 0;
    callGraphState.panY = 0;
    applyCallGraphTransform();
  }

  function nodeCardGraphSvg(inner) {
    return `<svg class="call-graph-svg" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  }

  /** CLI：浏览器选目录并上传 .proto（宿主落盘后自动应用） */
  async function pickProtoDirViaBrowser() {
    if (!vscode) return;
    const files = [];
    let label = "";
    try {
      await new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.setAttribute("webkitdirectory", "");
        input.style.display = "none";
        input.addEventListener("change", async () => {
          try {
            const list = Array.from(input.files || []);
            input.remove();
            for (const file of list) {
              if (!/\.proto$/i.test(file.name)) continue;
              const rel = String(file.webkitRelativePath || file.name).replace(/\\/g, "/");
              if (!label) label = rel.split("/")[0] || file.name;
              files.push({ path: rel, content: await file.text() });
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        input.addEventListener("cancel", () => {
          input.remove();
          resolve();
        });
        document.body.appendChild(input);
        input.click();
      });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setRespBadge("err", (error && error.message) || "选择目录失败");
      return;
    }
    if (!files.length) {
      setRespBadge("err", "目录中未找到 .proto 文件");
      return;
    }
    setRespBadge("wait", `正在导入 ${files.length} 个 .proto…`);
    vscode.postMessage({
      type: "uploadProtoDir",
      payload: { name: label || "proto", files },
    });
  }

  async function pickGhzViaBrowser() {
    if (!vscode) return;
    try {
      let file;
      if (typeof showOpenFilePicker === "function") {
        const handles = await showOpenFilePicker({
          multiple: false,
          excludeAcceptAllOption: false,
        });
        file = await handles[0].getFile();
      } else {
        file = await new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.style.display = "none";
          input.addEventListener("change", () => {
            const f = input.files?.[0];
            input.remove();
            resolve(f || null);
          });
          input.addEventListener("cancel", () => {
            input.remove();
            resolve(null);
          });
          document.body.appendChild(input);
          input.click();
        });
      }
      if (!file) return;
      setRespBadge("wait", "正在导入 ghz…");
      const buf = new Uint8Array(await file.arrayBuffer());
      vscode.postMessage({
        type: "uploadGhzBinary",
        payload: { name: file.name, base64: bytesToBase64(buf) },
      });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setRespBadge("err", (error && error.message) || "选择文件失败");
    }
  }

  function fillSourceModal() {
    const mode = state.source.mode === "git" ? "git" : "directory";
    for (const input of document.querySelectorAll('input[name="sourceMode"]')) {
      input.checked = input.value === mode;
    }
    if ($("sourceDirPath")) $("sourceDirPath").value = state.source.dirPath || "";
    if ($("sourceGitUrl")) $("sourceGitUrl").value = state.source.gitUrl || "";
    if ($("sourceGitBranch")) $("sourceGitBranch").value = state.source.gitBranch || "main";
    const dirHint = $("sourceDirHint");
    if (dirHint) {
      dirHint.textContent = state.source.dirPath
        ? `当前：${state.source.dirPath}`
        : (isVsCodeWebview
          ? "点「浏览」选择目录，再点「应用并刷新」。"
          : "点「浏览」选文件夹并确认上传，再点「应用并刷新」；也可直接填本机绝对路径。");
    }
    const hint = $("sourceGitHint");
    if (hint) {
      const parts = [];
      if (state.source.localPath) parts.push(`临时目录：${state.source.localPath}`);
      if (state.source.lastError) parts.push(`上次错误：${state.source.lastError}`);
      hint.textContent = parts.join(" · ") || "应用后会 clone/fetch 到系统临时目录并刷新接口树。";
    }
    syncSourceModalUi();
  }

  function openSourceModal() {
    fillSourceModal();
    openModal(els.sourceModal);
  }

  function applySourceFromModal() {
    const mode = document.querySelector('input[name="sourceMode"]:checked')?.value === "git" ? "git" : "directory";
    const dirPath = ($("sourceDirPath")?.value || "").trim();
    const gitUrl = ($("sourceGitUrl")?.value || "").trim();
    const gitBranch = ($("sourceGitBranch")?.value || "main").trim() || "main";
    if (mode === "directory") {
      if (!dirPath) {
        setRespBadge("err", "请填写目录路径");
        return;
      }
    }
    if (mode === "git") {
      if (!gitUrl) {
        setRespBadge("err", "请填写 Git 地址");
        return;
      }
      if (!/^https?:\/\/|^git@|^ssh:\/\//i.test(gitUrl)) {
        setRespBadge("err", "Git 地址格式无效");
        return;
      }
    }
    state.source = { ...state.source, mode, dirPath, gitUrl, gitBranch, lastError: "" };
    closeModal(els.sourceModal);
    if (!vscode) {
      els.sourceMeta.textContent = mode === "git"
        ? `Git · ${gitBranch} · ${gitUrl}`
        : `目录 · ${dirPath}`;
      setRespBadge("wait", "未连接宿主：请用扩展打开 Client，或运行 npx @zhhoceanfly/protoview");
      return;
    }
    setRespBadge("wait", mode === "git" ? "正在应用 Git 来源…" : "正在加载目录…");
    vscode.postMessage({
      type: "setSource",
      payload: { mode, dirPath, gitUrl, gitBranch },
    });
  }

  function openModal(el) { el.classList.add("show"); }
  function closeModal(el) { el.classList.remove("show"); }

  function pushHistory(entry) {
    if (entry && !entry.rpcId && state.selected) entry.rpcId = state.selected.id;
    state.history.unshift(entry);
    state.history = state.history.slice(0, 40);
    saveHistory();
    renderHistory();
  }

  function historyMatches(item, rpc) {
    if (!rpc || !item) return false;
    if (item.rpcId && rpc.id) return item.rpcId === rpc.id;
    return historyLabel(item) === `${rpc.package}.${rpc.service}/${rpc.name}`;
  }

  function scopedHistory() {
    const rpc = state.selected;
    if (!rpc) return [];
    return state.history.filter((item) => historyMatches(item, rpc));
  }

  function recordHistoryResult(id, data) {
    const entry = state.history.find((item) => item.id === id);
    if (!entry) return;
    entry.response = {
      ok: Boolean(data?.ok),
      status: data?.status || "",
      ms: Number(data?.ms) || 0,
      body: data?.body,
      error: data?.error || "",
      at: new Date().toLocaleTimeString(),
    };
    saveHistory();
    renderHistory();
  }

  /** 链路里发出的请求也进同一个 History，方便回看 */
  function pushFlowSend(entry) {
    if (!entry || !entry.method) return "";
    const id = entry.id || `flow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pushHistory({
      id,
      time: new Date().toLocaleString(),
      protocol: entry.protocol || "grpc",
      host: entry.host || "",
      package: entry.package || "",
      service: entry.service || "",
      method: entry.method,
      body: entry.body || {},
      metadata: entry.metadata || {},
      message: entry.message || "",
      label: entry.label || "",
      rpcId: entry.rpcId || "",
      nodeId: entry.nodeId || "",
      response: entry.response || null,
    });
    return id;
  }

  function historyLabel(item) {
    const name = item.method?.includes("/")
      ? item.method
      : `${item.package ? `${item.package}.${item.service}/` : ""}${item.method || ""}`;
    return name || "(未知接口)";
  }

  function renderHistory() {
    if (!els.historyView) return;
    const title = document.querySelector(".history-title");
    const rpc = state.selected;
    if (title) title.textContent = rpc ? `${rpc.name} 的发送记录` : "发送记录";
    const items = scopedHistory();
    if (!rpc) {
      els.historyView.innerHTML = `<div class="history-empty">先选择一个接口，这里只显示该接口的发送记录。</div>`;
      return;
    }
    if (!items.length) {
      els.historyView.innerHTML = `<div class="history-empty">「${esc(rpc.name)}」还没有发送记录。</div>`;
      return;
    }
    els.historyView.innerHTML = items.map((item, visibleIndex) => {
      const index = state.history.indexOf(item);
      const resp = item.response;
      const status = !resp ? "未返回" : resp.ok ? (resp.status || "OK") : (resp.status || "ERROR");
      const tag = resp ? (resp.ok ? "ok" : "err") : "wait";
      const ms = resp?.ms ? ` · ${resp.ms}ms` : "";
      const active = item.id && item.id === state.historyActiveId ? " active" : "";
      return `<button class="history-row${active}" type="button" data-history-index="${index}" data-history-id="${esc(item.id || "")}" title="双击在链路浮窗的 History 中打开">
        <span class="history-idx">${visibleIndex + 1}</span>
        <span class="history-main">
          <strong>${esc(historyLabel(item))}</strong>
          <span class="history-sub">${esc(item.time || "")} · ${esc(item.host || "")}${ms}</span>
        </span>
        <span class="history-tag ${tag}">${esc(status)}</span>
      </button>`;
    }).join("");
  }

  function showLatestForSelection() {
    const rpc = state.selected;
    if (!rpc) return;
    state.responseRpcId = rpc.id;
    const latest = state.history.find((item) => historyMatches(item, rpc) && item.response);
    if (!latest) {
      state.historyActiveId = "";
      setRespBadge("", "");
      if (els.responseView) els.responseView.innerHTML = `<div class="resp-empty">该接口还没有响应。</div>`;
      renderHistory();
      return;
    }
    state.historyActiveId = latest.id || "";
    renderHistory();
    showHistoryEntry(state.history.indexOf(latest), { activate: false });
  }

  function syncScopedHistory(forceLatest = false) {
    const rpc = state.selected;
    const changed = !rpc || state.responseRpcId !== rpc.id;
    if (forceLatest || changed) showLatestForSelection();
    else renderHistory();
  }

  function showHistoryEntry(index, { activate = false } = {}) {
    const item = state.history[index];
    if (!item) return;
    if (state.selected && !historyMatches(item, state.selected)) return;
    state.historyActiveId = item.id || "";
    state.responseRpcId = state.selected?.id || item.rpcId || "";
    for (const row of els.historyView?.querySelectorAll(".history-row") || []) {
      row.classList.toggle("active", row.getAttribute("data-history-id") === (item.id || ""));
    }
    const resp = item.response;
    if (!resp) {
      setRespBadge("wait", "该次请求还没有结果");
      return;
    }
    state.pendingResponse = { protocol: item.protocol, fields: undefined };
    showInvokeResult({
      ok: resp.ok,
      status: resp.status,
      ms: resp.ms,
      body: resp.body,
      error: resp.error,
      method: historyLabel(item),
      host: item.host,
    });
    if (activate) setTab("message");
  }

  // events
  initTheme();
  initOpenWithUi();
  renderHistory();
  initSidebarCollapsed();
  initSidebarResize();
  els.themeBtn.addEventListener("click", toggleTheme);
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-theme-toggle]")) toggleTheme();
    if (event.target.closest?.("[data-open-ai]")) openAi();
  });
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => button.addEventListener("click", toggleSidebar));
  $("aiBtn").addEventListener("click", openAi);
  $("closeAiBtn").addEventListener("click", closeAi);
  $("aiShuffle").addEventListener("click", () => {
    if (ai.solved) return;
    ai.tiles = shuffleTiles(ai.target.slice());
    ai.selected = -1;
    renderAiBoard();
  });
  $("refreshBtn").addEventListener("click", () => {
    if (vscode) vscode.postMessage({ type: "refresh" });
    else location.reload();
  });
  $("sourceConfigBtn")?.addEventListener("click", openSourceModal);
  $("closeSourceModal")?.addEventListener("click", () => closeModal(els.sourceModal));
  $("applySourceBtn")?.addEventListener("click", applySourceFromModal);
  $("pickSourceDirBtn")?.addEventListener("click", () => {
    if (!vscode) return;
    if (isVsCodeWebview) {
      // 先收起 HTML 弹层，避免挡住 / 干扰 VS Code 原生选目录对话框
      closeModal(els.sourceModal);
      setRespBadge("wait", "请选择目录…");
      vscode.postMessage({ type: "pickProtoDir" });
      return;
    }
    setRespBadge("wait", "请选择本地目录…");
    void pickProtoDirViaBrowser();
  });
  $("sourceDrawerClose")?.addEventListener("click", closeSourceDrawer);
  // 抽屉「外部打开」：代码/调用图都直接拆出或复用 VS Code 右侧编辑器分组
  $("sourceDrawerExtBtn")?.addEventListener("click", () => {
    if (!vscode || !sourcePreview.file) return;
    vscode.postMessage({
      type: "openSource",
      file: sourcePreview.file,
      line: sourcePreview.line,
    });
    setRespBadge("ok", "已在右侧编辑器打开源码");
  });
  $("callGraphDepth")?.addEventListener("change", () => {
    const depth = Number($("callGraphDepth")?.value || 2);
    // 深度是相对当前根节点函数的跳数，换深度就用同一根重新展开
    if (!callGraphState.item) return;
    requestCallGraph(callGraphState.item, depth);
  });
  $("callGraphZoomIn")?.addEventListener("click", () => {
    callGraphState.zoom = Math.min(2.5, callGraphState.zoom + 0.15);
    applyCallGraphZoom();
  });
  $("callGraphZoomOut")?.addEventListener("click", () => {
    callGraphState.zoom = Math.max(0.25, callGraphState.zoom - 0.15);
    applyCallGraphZoom();
  });
  $("callGraphZoomReset")?.addEventListener("click", () => {
    callGraphState.zoom = 1;
    callGraphState.panX = 0;
    callGraphState.panY = 0;
    applyCallGraphTransform();
  });
  bindCallGraphPanZoom();
  $("callGraphBoard")?.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-cg-db-close]")) {
      event.preventDefault();
      event.stopPropagation();
      event.target.closest(".call-graph-db-panel")?.remove();
      return;
    }
    const dbOpen = event.target.closest?.("[data-cg-db-open]");
    if (dbOpen) {
      event.preventDefault();
      event.stopPropagation();
      openDbTableFromCallGraph(dbOpen.getAttribute("data-cg-db-open") || "");
      return;
    }
    const nodeEl = event.target.closest?.("[data-cg-node]");
    if (!nodeEl) return;
    const name = nodeEl.getAttribute("data-cg-name") || "";
    const file = nodeEl.getAttribute("data-cg-abs") || nodeEl.getAttribute("data-cg-file") || "";
    const line = Number(nodeEl.getAttribute("data-cg-line") || 1) || 1;
    if (event.target.closest?.("[data-cg-src]")) {
      event.preventDefault();
      event.stopPropagation();
      jumpToSource({ name, file, line });
      return;
    }
    if (event.target.closest?.("[data-cg-db]")) {
      event.preventDefault();
      event.stopPropagation();
      showCallGraphDb(name, nodeEl.getAttribute("data-cg-file") || file);
    }
  });
  $("callGraphWorld")?.addEventListener("contextmenu", (event) => {
    const nodeEl = event.target.closest?.("[data-cg-node]");
    if (!nodeEl) return;
    event.preventDefault();
    jumpToSource({
      name: nodeEl.getAttribute("data-cg-name") || "",
      file: nodeEl.getAttribute("data-cg-abs") || nodeEl.getAttribute("data-cg-file") || "",
      line: Number(nodeEl.getAttribute("data-cg-line") || 1) || 1,
    });
  });
  for (const input of document.querySelectorAll('input[name="sourceMode"]')) {
    input.addEventListener("change", syncSourceModalUi);
  }
  els.sourceModal?.addEventListener("click", (event) => {
    if (event.target === els.sourceModal) closeModal(els.sourceModal);
  });
  $("treeToggleBtn").addEventListener("click", () => setAllExpanded(!treeIsOpen()));
  $("grpcurlBtn").addEventListener("click", () => {
    if (!state.selected) return;
    $("curlText").value = buildGrpcurl();
    openModal($("curlModal"));
  });
  $("closeCurlModal").addEventListener("click", () => closeModal($("curlModal")));
  $("copyCurlBtn").addEventListener("click", async () => {
    const text = $("curlText").value;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      $("curlText").select();
      document.execCommand("copy");
    }
    setRespBadge("ok", "grpcurl 命令已复制");
  });
  els.filter.addEventListener("input", renderTree);
  $("rpcChangeOnly")?.addEventListener("change", () => {
    window.ProtoViewGit?.request?.();
    renderTree();
  });
  els.envSelect.addEventListener("change", () => applyEnvId(els.envSelect.value));
  $("protocolSelect")?.addEventListener("change", () => {
    const protocol = currentProtocol();
    if (protocol === "sse" && $("httpMethodSelect") && !$("httpMethodSelect").dataset.userSet) {
      $("httpMethodSelect").value = "GET";
    }
    syncProtocolUi();
    persistCurrentDraft();
  });
  $("httpMethodSelect")?.addEventListener("change", persistCurrentDraft);
  $("httpPath")?.addEventListener("change", persistCurrentDraft);
  els.address.addEventListener("change", () => {
    const env = activeEnv();
    if (!env) return;
    env.host = els.address.value.trim();
    fillEnvForm();
    persistEnvs();
  });
  function openSourceFromUi(src) {
    const file = src.getAttribute("data-src");
    const line = Number(src.getAttribute("data-line") || 1);
    if (!file) return;
    if (!vscode) {
      const loc = `${file}:${line}`;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(loc).then(
          () => setRespBadge("ok", `已复制路径 ${loc}`),
          () => setRespBadge("err", loc),
        );
      } else {
        setRespBadge("err", loc);
      }
      return;
    }
    // VS Code 插件：直接在编辑器打开
    if (isVsCodeWebview) {
      vscode.postMessage({ type: "openSource", file, line });
      return;
    }
    // npm / 浏览器：按顶部「源码」下拉选择打开方式
    const target = getOpenWithTarget();
    if (target === "preview") {
      setRespBadge("wait", "加载源码…");
      vscode.postMessage({ type: "readSource", file, line });
      return;
    }
    vscode.postMessage({
      type: "openSource",
      file,
      line,
      editor: target === "auto" ? "" : target,
    });
    setRespBadge("ok", "正在打开源码…");
  }

  els.rpcInfo.addEventListener("click", (event) => {
    const src = event.target.closest("[data-src]");
    if (src) openSourceFromUi(src);
  });
  els.docsView.addEventListener("click", (event) => {
    const back = event.target.closest("[data-doc-back]");
    if (back) {
      state.docsNav.pop();
      paintDocs();
      renderTree();
      return;
    }
    const src = event.target.closest("[data-src]");
    if (src) {
      openSourceFromUi(src);
      return;
    }
    const link = event.target.closest("[data-type]");
    if (link) openType(link.getAttribute("data-type"));
  });
  els.tree.addEventListener("click", (event) => {
    if (window.__protoviewFlowDragged) {
      window.__protoviewFlowDragged = false;
      return;
    }
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {      const key = toggle.getAttribute("data-toggle");
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderTree();
      return;
    }
    const typeBtn = event.target.closest("[data-type-id]");
    if (typeBtn) {
      selectType(typeBtn.getAttribute("data-type-id"));
      return;
    }
    const rpc = event.target.closest("[data-rpc]");
    if (rpc) selectRpc(rpc.getAttribute("data-rpc"), { tab: "message" });
  });
  els.tree.addEventListener("dblclick", (event) => {
    const rpc = event.target.closest("[data-rpc]");
    if (!rpc) return;
    const rpcId = rpc.getAttribute("data-rpc");
    const label = rpc.querySelector(".label")?.textContent || rpcId;
    placeFlowRpc(rpcId, label);
  });

  // ProcessOn-style: press on sidebar RPC, drag onto canvas, release to place
  let flowDrag = null;
  function isFlowMode() {
    return document.getElementById("app")?.classList.contains("flow-mode");
  }
  function placeFlowRpc(rpcId, label, clientX, clientY) {
    if (!rpcId) return;
    if (window.ProtoViewFlow?.addAtScreen && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      window.ProtoViewFlow.addAtScreen(rpcId, clientX, clientY, label);
      return;
    }
    if (window.ProtoViewFlow?.addNode) {
      window.ProtoViewFlow.addNode(rpcId, undefined, undefined, label);
      return;
    }
    window.dispatchEvent(new CustomEvent("protoview-flow-add", {
      detail: { rpcId, label, clientX, clientY },
    }));
  }
  document.addEventListener("mousedown", (event) => {
    if (!isFlowMode() || event.button !== 0) return;
    const rpc = event.target.closest?.("[data-rpc]");
    if (!rpc || !els.tree.contains(rpc)) return;
    flowDrag = {
      rpcId: rpc.getAttribute("data-rpc"),
      label: rpc.querySelector(".label")?.textContent || rpc.getAttribute("data-rpc"),
      x: event.clientX,
      y: event.clientY,
      active: false,
      ghost: null,
    };
  }, true);
  document.addEventListener("mousemove", (event) => {
    if (!flowDrag) return;
    const dist = Math.hypot(event.clientX - flowDrag.x, event.clientY - flowDrag.y);
    if (!flowDrag.active && dist > 6) {
      flowDrag.active = true;
      flowDrag.ghost = document.createElement("div");
      flowDrag.ghost.className = "flow-drag-ghost";
      flowDrag.ghost.innerHTML = `<span class="flow-node-icon">⇢</span><strong></strong>`;
      flowDrag.ghost.querySelector("strong").textContent = flowDrag.label;
      document.body.appendChild(flowDrag.ghost);
      document.getElementById("flowStage")?.classList.add("drop-target");
    }
    if (flowDrag.ghost) {
      flowDrag.ghost.style.left = `${event.clientX + 14}px`;
      flowDrag.ghost.style.top = `${event.clientY + 14}px`;
    }
  }, true);
  document.addEventListener("mouseup", (event) => {
    if (!flowDrag) return;
    const drag = flowDrag;
    flowDrag = null;
    document.getElementById("flowStage")?.classList.remove("drop-target");
    if (drag.ghost) drag.ghost.remove();
    if (!drag.active) return;
    window.__protoviewFlowDragged = true;
    const stage = document.getElementById("flowStage");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      return;
    }
    placeFlowRpc(drag.rpcId, drag.label, event.clientX, event.clientY);
  }, true);
  $("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) setTab(tab.getAttribute("data-tab"));
  });
  $("genMsgBtn").addEventListener("click", () => {
    if (!state.selected) return;
    els.messageEditor.value = generateMessage(state.selected);
    state.messageDirty = true;
    updateRequestMeta();
  });
  $("formatMsgBtn").addEventListener("click", formatMessage);
  $("clearMsgBtn").addEventListener("click", () => {
    els.messageEditor.value = "{}";
    state.messageDirty = true;
  });
  els.messageEditor.addEventListener("input", () => {
    state.messageDirty = true;
    updateRequestMeta();
  });
  $("clearRespBtn").addEventListener("click", () => {
    setRespBadge("", "");
    els.responseView.innerHTML = `<div class="resp-empty">选择接口，配置地址后发送。</div>`;
  });
  $("historyView")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-history-index]");
    if (!row) return;
    showHistoryEntry(Number(row.getAttribute("data-history-index")), { activate: false });
  });
  $("historyView")?.addEventListener("dblclick", (event) => {
    const row = event.target.closest("[data-history-index]");
    if (!row) return;
    const item = state.history[Number(row.getAttribute("data-history-index"))];
    if (!item) return;
    showHistoryEntry(state.history.indexOf(item), { activate: false });
    const flowApi = window.ProtoViewFlow;
    if (!flowApi?.isFlowOpen?.()) return;
    const nodeId = item.nodeId || flowApi.nodeIdForRpc?.(item.rpcId || state.selected?.id);
    if (nodeId) flowApi.openInspect?.(nodeId, { tab: "history" });
  });
  function clearCurrentHistory() {
    const rpc = state.selected;
    const items = rpc ? state.history.filter((item) => historyMatches(item, rpc)) : state.history.slice();
    if (!items.length) return;
    const drop = new Set(items);
    state.history = state.history.filter((item) => !drop.has(item));
    saveHistory();
    state.historyActiveId = "";
    // 响应区一起清掉，避免还留着刚删除的那次结果
    state.responseRpcId = "";
    state.pendingResponse = null;
    setRespBadge("", "");
    if (els.responseView) els.responseView.innerHTML = `<div class="resp-empty">该接口还没有响应。</div>`;
    renderHistory();
  }
  $("clearHistoryBtn")?.addEventListener("click", clearCurrentHistory);
  $("clearHistoryBarBtn")?.addEventListener("click", clearCurrentHistory);

  els.metaBody.addEventListener("input", (event) => {
    const input = event.target.closest("input[data-meta-key]");
    if (!input) return;
    const tr = input.closest("[data-meta-index]");
    const index = Number(tr.getAttribute("data-meta-index"));
    const key = input.getAttribute("data-meta-key");
    state.metadata[index][key] = input.value;
    state.messageDirty = true;
    persistCurrentDraft();
  });
  els.metaBody.addEventListener("click", (event) => {
    const del = event.target.closest("[data-meta-del]");
    if (!del) return;
    const index = Number(del.getAttribute("data-meta-del"));
    state.metadata.splice(index, 1);
    renderMetadata();
    persistCurrentDraft();
  });
  $("addMetaBtn").addEventListener("click", () => {
    state.metadata.push({ name: "", value: "", description: "" });
    renderMetadata();
    persistCurrentDraft();
  });
  $("bulkMetaBtn").addEventListener("click", () => {
    els.bulkText.value = state.metadata
      .filter((row) => row.name)
      .map((row) => `${row.name}: ${row.value}`)
      .join("\n");
    openModal(els.bulkModal);
  });
  $("closeBulkModal").addEventListener("click", () => closeModal(els.bulkModal));
  $("applyBulkBtn").addEventListener("click", () => {
    const rows = els.bulkText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return { name: line, value: "", description: "" };
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim(), description: "" };
    });
    state.metadata = rows.length ? rows : [{ name: "", value: "", description: "" }];
    renderMetadata();
    persistCurrentDraft();
    closeModal(els.bulkModal);
  });

  $("authType").addEventListener("change", () => {
    readAuthForm();
    renderAuth();
    persistCurrentDraft();
  });
  $("authBody").addEventListener("input", () => {
    readAuthForm();
    updateAuthPreview();
    persistCurrentDraft();
  });

  $("envConfigBtn").addEventListener("click", () => {
    fillEnvForm();
    renderEnvList();
    openModal(els.envModal);
  });
  $("closeEnvModal").addEventListener("click", () => {
    commitEnvForm();
    persistEnvs();
    closeModal(els.envModal);
  });
  els.envList.addEventListener("click", (event) => {
    const del = event.target.closest("[data-env-del]");
    if (del) {
      event.preventDefault();
      event.stopPropagation();
      deleteEnv(del.getAttribute("data-env-del"));
      return;
    }
    const item = event.target.closest("[data-env-pick]");
    if (!item) return;
    const id = item.getAttribute("data-env-pick");
    if (id === state.activeEnvId) return;
    commitEnvForm();
    state.activeEnvId = id;
    persistEnvs();
    fillEnvForm();
    renderEnvSelect();
  });
  $("addEnvBtn").addEventListener("click", () => {
    commitEnvForm();
    const id = `env_${Date.now().toString(36)}`;
    state.envs.push({ id, name: `env-${state.envs.length + 1}`, host: "", note: "" });
    state.activeEnvId = id;
    persistEnvs();
    renderEnvList();
    fillEnvForm();
    renderEnvSelect();
  });
  $("saveEnvBtn").addEventListener("click", () => {
    const env = activeEnv();
    if (!env) return;
    env.name = els.envName.value.trim() || env.id;
    env.host = els.envHost.value.trim();
    env.note = els.envNote.value.trim();
    els.address.value = env.host;
    persistEnvs();
    renderEnvSelect();
    closeModal(els.envModal);
    setRespBadge("ok", `环境「${env.name}」已保存`);
  });

  function setRespBadge(kind, text) {
    const badge = $("respBadge");
    badge.className = `resp-badge${kind ? ` ${kind}` : ""}`;
    badge.textContent = text || "";
  }

  function highlightJson(value) {
    const text = esc(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return text.replace(
      /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (match, str, colon, bool) => {
        if (str) return `<span class="${colon ? "k" : "s"}">${str}</span>${colon || ""}`;
        if (bool) return `<span class="b">${bool}</span>`;
        return `<span class="n">${match}</span>`;
      },
    );
  }

  function displayResponseEnums(body, fields) {
    if (Array.isArray(body)) return body.map((item) => displayResponseEnums(item, fields));
    if (!body || typeof body !== "object") return body;
    const result = { ...body };
    for (const field of fields || []) {
      if (!Object.prototype.hasOwnProperty.call(result, field.name)) continue;
      const type = field.typeId ? state.catalog.types?.[field.typeId] : null;
      if (!type) continue;
      const convert = (value) => {
        if (type.kind === "enum") return type.values?.find((item) => item.number === value)?.name ?? value;
        if (type.kind === "message") return displayResponseEnums(value, type.fields);
        return value;
      };
      const value = result[field.name];
      if (field.key && value && typeof value === "object" && !Array.isArray(value)) {
        result[field.name] = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]));
      } else if (field.repeated && Array.isArray(value)) {
        result[field.name] = value.map(convert);
      } else result[field.name] = convert(value);
    }
    return result;
  }

  function showInvokeResult(data) {
    if (state.selected) state.responseRpcId = data.rpcId || state.selected.id;
    const kind = data.ok ? "ok" : "err";
    const timing = typeof data.ms === "number" ? ` · ${data.ms} ms` : "";
    setRespBadge(kind, `${data.status || (data.ok ? "OK" : "ERROR")}${timing}`);
    const parts = [`<div class="resp-line">${esc(data.method || "")}${data.host ? ` · ${esc(data.host)}` : ""}</div>`];
    if (data.error) parts.push(`<pre class="resp-error">${esc(data.error)}</pre>`);
    if (data.body !== undefined) {
      const response = state.pendingResponse;
      const body = response?.protocol === "grpc" ? displayResponseEnums(data.body, response.fields) : data.body;
      parts.push(`<pre class="resp-json">${highlightJson(body)}</pre>`);
    }
    els.responseView.innerHTML = `<div class="resp-block">${parts.join("")}</div>`;
  }

  els.sendBtn.addEventListener("click", () => {
    const rpc = state.selected;
    if (!rpc) return;
    const env = activeEnv();
    const host = els.address.value.trim() || env?.host || "";
    let body = {};
    try {
      body = normalizeBodyLongs(parseJsonPreserveLongs(els.messageEditor.value || "{}"), rpc.requestFields || []);
    } catch (error) {
      showInvokeResult({ ok: false, status: "INVALID", method: `${rpc.package}.${rpc.service}/${rpc.name}`, host, error: `Message 不是合法 JSON：${error.message}` });
      return;
    }
    const protocol = currentProtocol();
    const httpMethod = $("httpMethodSelect")?.value || (protocol === "sse" ? "GET" : "POST");
    const httpPath = $("httpPath")?.value || rpc.httpPath || "/";
    const payload = {
      id: String(Date.now()),
      time: new Date().toLocaleString(),
      protocol,
      httpMethod,
      httpPath,
      host,
      package: rpc.package,
      service: rpc.service,
      method: rpc.name,
      file: rpc.file,
      body,
      metadata: requestMetadata(),
      tls: $("tlsCheck").checked,
      message: els.messageEditor.value,
    };
    state.pendingInvoke = payload.id;
    state.pendingResponse = { protocol, fields: rpc.responseFields };
    pushHistory(payload);
    persistCurrentDraft();
    if (!vscode) {
      showInvokeResult({
        ok: false,
        status: "UNAVAILABLE",
        method: `${rpc.package}.${rpc.service}/${rpc.name}`,
        host,
        error: "浏览器页面不能直接发送原生 gRPC。请在 VS Code 里打开 ProtoView Client，由插件进程代发。",
      });
      return;
    }
    setRespBadge("wait", "发送中…");
    const label = protocol === "grpc"
      ? `${rpc.package}.${rpc.service}/${rpc.name}`
      : protocol === "websocket"
        ? `WS ${httpPath}`
        : protocol === "sse"
          ? `SSE ${httpMethod} ${httpPath}`
          : `${httpMethod} ${httpPath}`;
    els.responseView.innerHTML = `<div class="resp-empty">正在请求 ${esc(host || "(未配置)")} · ${esc(label)}</div>`;
    vscode.postMessage({ type: "invoke", payload });
  });

  function currentInvokeBase() {
    const rpc = state.selected;
    if (!rpc) return null;
    let body = {};
    try {
      body = normalizeBodyLongs(parseJsonPreserveLongs(els.messageEditor.value || "{}"), rpc.requestFields || []);
    } catch (error) {
      return { error: `Message 不是合法 JSON：${error.message}` };
    }
    const protocol = currentProtocol();
    return {
      protocol,
      httpMethod: $("httpMethodSelect")?.value || (protocol === "sse" ? "GET" : rpc.httpVerb || "POST"),
      httpPath: $("httpPath")?.value || rpc.httpPath || "/",
      host: els.address.value.trim() || activeEnv()?.host || "",
      package: rpc.package,
      service: rpc.service,
      method: rpc.name,
      file: rpc.file,
      body,
      metadata: requestMetadata(),
      tls: $("tlsCheck").checked,
    };
  }

  function setStressMode(mode) {
    state.stressMode = mode === "ghz" ? "ghz" : "light";
    for (const btn of document.querySelectorAll("[data-stress-mode]")) {
      btn.classList.toggle("active", btn.getAttribute("data-stress-mode") === state.stressMode);
    }
    $("stressLight").classList.toggle("hidden", state.stressMode !== "light");
    $("stressGhz").classList.toggle("hidden", state.stressMode !== "ghz");
    $("stressNote").textContent = state.stressMode === "light"
      ? "复用当前 Message / Auth / Metadata，在插件进程内有限并发调用（并发≤10，总数≤200）。"
      : "高并发请用本机 ghz。可复制命令，或尝试由插件 spawn（需 PATH 中有 ghz）。";
    if (state.stressMode === "ghz") refreshGhzCommand();
  }

  function refreshGhzCommand() {
    const area = $("ghzCommand");
    if (!area) return;
    area.value = buildGhzCommand();
  }

  function buildGhzArgs() {
    const base = currentInvokeBase();
    if (!base || base.error || base.protocol !== "grpc") return null;
    const rpc = state.selected;
    const concurrency = Math.max(1, Number($("ghzConcurrency").value || 20));
    const total = Math.max(1, Number($("ghzTotal").value || 200));
    const method = `${rpc.package}.${rpc.service}/${rpc.name}`;
    const args = [
      "--insecure",
      "-c", String(concurrency),
      "-n", String(total),
      "-d", JSON.stringify(base.body),
    ];
    for (const [name, value] of Object.entries(base.metadata || {})) {
      args.push("-m", `${name}: ${value}`);
    }
    if (rpc.path || rpc.file) {
      args.push("-proto", rpc.path || rpc.file);
      const importPath = (rpc.path || rpc.file).replace(/[\\/][^\\/]+$/, "") || ".";
      args.push("-i", importPath);
    }
    args.push(base.host || "127.0.0.1:50051", method);
    return args;
  }

  function ghzBinary() {
    return ($("ghzPath")?.value || "").trim() || "ghz";
  }

  function buildGhzCommand() {
    const args = buildGhzArgs();
    if (!args) return "# 请先选择接口并填写合法 Message JSON";
    return `${shellQuote(ghzBinary())} ${args.map((part) => shellQuote(part)).join(" ")}`;
  }

  function setStressRunning(running) {
    $("stressStartBtn").disabled = running;
    $("stressStopBtn").disabled = !running;
    $("runGhzBtn").disabled = running;
  }

  function showStressProgress(data) {
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    $("stressProgressBar").style.width = `${pct}%`;
    $("stressProgressText").textContent = `${data.done}/${data.total} · 成功 ${data.ok} · 失败 ${data.fail}`;
  }

  function showStressResult(data) {
    setStressRunning(false);
    if (data.error) {
      els.stressResult.innerHTML = `<div class="stress-empty stress-fail">${esc(data.error)}</div>`;
      return;
    }
    const stats = [
      ["总数", data.total],
      ["成功", data.ok],
      ["失败", data.fail],
      ["耗时", `${data.durationMs} ms`],
      ["RPS", data.rps],
      ["平均", `${data.avgMs} ms`],
      ["P50", `${data.p50Ms} ms`],
      ["P95", `${data.p95Ms} ms`],
      ["P99", `${data.p99Ms} ms`],
      ["最小", `${data.minMs} ms`],
      ["最大", `${data.maxMs} ms`],
    ].map(([label, value]) => `<div class="stress-stat"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`).join("");
    const rows = (data.samples || []).map((item) => `<tr>
      <td>#${item.index + 1}</td>
      <td class="${item.ok ? "stress-ok" : "stress-fail"}">${esc(item.status)}</td>
      <td>${item.ms} ms</td>
      <td>${esc(item.error || "")}</td>
    </tr>`).join("");
    els.stressResult.innerHTML = `
      <div class="stress-stats">${stats}</div>
      ${data.cancelled ? `<p class="stress-note">已停止，以下为已完成样本。</p>` : ""}
      <table class="stress-samples">
        <thead><tr><th>#</th><th>状态</th><th>延迟</th><th>错误</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">无样本</td></tr>`}</tbody>
      </table>
      <p class="stress-note" style="margin-top:8px">仅展示前 50 条样本明细。</p>
    `;
    setRespBadge(data.fail ? "err" : "ok", `压测完成 · RPS ${data.rps}`);
  }

  $("stressModes").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-stress-mode]");
    if (btn) setStressMode(btn.getAttribute("data-stress-mode"));
  });
  $("stressConcurrency").addEventListener("change", () => {
    const n = Math.min(10, Math.max(1, Number($("stressConcurrency").value || 1)));
    $("stressConcurrency").value = String(n);
  });
  $("stressTotal").addEventListener("change", () => {
    const n = Math.min(200, Math.max(1, Number($("stressTotal").value || 1)));
    $("stressTotal").value = String(n);
  });
  $("ghzConcurrency").addEventListener("change", refreshGhzCommand);
  $("ghzTotal").addEventListener("change", refreshGhzCommand);
  const GHZ_PATH_KEY = "protoview.client.ghzPath";
  try { $("ghzPath").value = localStorage.getItem(GHZ_PATH_KEY) || ""; } catch { /* ignore */ }
  function setGhzPath(value) {
    const path = String(value || "").trim();
    if ($("ghzPath")) $("ghzPath").value = path;
    try { localStorage.setItem(GHZ_PATH_KEY, path); } catch { /* ignore */ }
    refreshGhzCommand();
  }
  $("ghzPath")?.addEventListener("change", () => setGhzPath($("ghzPath").value));
  $("ghzPath")?.addEventListener("input", refreshGhzCommand);
  $("pickGhzPathBtn")?.addEventListener("click", () => {
    if (!vscode) return;
    if (isVsCodeWebview) vscode.postMessage({ type: "pickGhzBinary" });
    else void pickGhzViaBrowser();
  });
  $("stressStartBtn").addEventListener("click", () => {
    const base = currentInvokeBase();
    if (!base) return;
    if (base.error) {
      els.stressResult.innerHTML = `<div class="stress-empty stress-fail">${esc(base.error)}</div>`;
      return;
    }
    if (!vscode) {
      els.stressResult.innerHTML = `<div class="stress-empty stress-fail">请在 VS Code 中打开 ProtoView Client 进行压测。</div>`;
      return;
    }
    state.stressId = `stress-${Date.now()}`;
    setStressRunning(true);
    $("stressProgressBar").style.width = "0%";
    $("stressProgressText").textContent = "准备中…";
    els.stressResult.innerHTML = `<div class="stress-empty">压测进行中…</div>`;
    vscode.postMessage({
      type: "stress",
      payload: {
        ...base,
        id: state.stressId,
        concurrency: Number($("stressConcurrency").value || 1),
        total: Number($("stressTotal").value || 1),
      },
    });
  });
  $("stressStopBtn").addEventListener("click", () => {
    if (state.stressId && vscode) vscode.postMessage({ type: "stressCancel", id: state.stressId });
  });
  $("copyGhzBtn").addEventListener("click", async () => {
    refreshGhzCommand();
    const text = $("ghzCommand").value;
    try { await navigator.clipboard.writeText(text); }
    catch { $("ghzCommand").select(); document.execCommand("copy"); }
    setRespBadge("ok", "ghz 命令已复制");
  });
  $("runGhzBtn").addEventListener("click", () => {
    const args = buildGhzArgs();
    if (!args) {
      els.stressResult.innerHTML = `<div class="stress-empty stress-fail">请先选择接口并填写合法 Message</div>`;
      return;
    }
    if (!vscode) {
      els.stressResult.innerHTML = `<div class="stress-empty stress-fail">请在 VS Code 中运行 ghz。</div>`;
      return;
    }
    state.stressId = `ghz-${Date.now()}`;
    state.ghzLog = "";
    setStressRunning(true);
    els.stressResult.innerHTML = `<pre class="stress-log" id="ghzLogView"></pre>`;
    vscode.postMessage({ type: "runGhz", payload: { id: state.stressId, args, binary: ghzBinary() } });
  });

  function invokeOnce(partial) {
    return new Promise((resolve) => {
      if (!vscode) {
        resolve({ ok: false, status: "UNAVAILABLE", ms: 0, error: "需要 VS Code Client" });
        return;
      }
      const id = partial?.id || `flow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const host = partial?.host || els.address.value.trim() || activeEnv()?.host || "";
      // 链路里的每次调用也记进 History，运行完可以逐条回看
      pushFlowSend({
        id,
        host,
        protocol: partial?.protocol || "grpc",
        package: partial?.package || "",
        service: partial?.service || "",
        method: partial?.method || "",
        body: partial?.body,
        metadata: partial?.metadata,
        message: partial?.message || "",
        label: partial?.label || "",
      });
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "invokeResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
        recordHistoryResult(id, data);
        resolve(data);
      };
      window.addEventListener("message", handler);
      vscode.postMessage({
        type: "invoke",
        payload: {
          id,
          host,
          tls: $("tlsCheck").checked,
          ...partial,
        },
      });
    });
  }

  function streamOpen(partial) {
    return new Promise((resolve) => {
      if (!vscode) {
        resolve({ ok: false, status: "UNAVAILABLE", ms: 0, error: "需要 VS Code Client" });
        return;
      }
      const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const host = partial?.host || els.address.value.trim() || activeEnv()?.host || "";
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "streamOpenResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
        resolve(data);
      };
      window.addEventListener("message", handler);
      vscode.postMessage({
        type: "streamOpen",
        payload: {
          id,
          host,
          tls: $("tlsCheck").checked,
          ...partial,
        },
      });
    });
  }

  function streamWrite(streamId, body) {
    return new Promise((resolve) => {
      if (!vscode) {
        resolve({ ok: false, error: "需要 VS Code Client" });
        return;
      }
      const id = `sw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "streamWriteResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
        resolve(data);
      };
      window.addEventListener("message", handler);
      vscode.postMessage({ type: "streamWrite", payload: { id, streamId, body } });
    });
  }

  function streamClose(streamId) {
    return new Promise((resolve) => {
      if (!vscode) {
        resolve({ ok: false, error: "需要 VS Code Client" });
        return;
      }
      const id = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "streamCloseResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
        resolve(data);
      };
      window.addEventListener("message", handler);
      vscode.postMessage({ type: "streamClose", payload: { id, streamId } });
    });
  }

  function decodeBytes(partial) {
    return new Promise((resolve) => {
      if (!vscode) {
        resolve({ ok: false, error: "需要 VS Code Client" });
        return;
      }
      const id = `db-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "decodeBytesResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
        resolve(data);
      };
      window.addEventListener("message", handler);
      vscode.postMessage({
        type: "decodeBytes",
        payload: { id, ...partial },
      });
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "streamData" || data.type === "streamEnded") {
      try {
        window.ProtoViewFlow?.onHostStreamEvent?.(data);
      } catch { /* ignore */ }
    }
  });

  // 首页复用同一套全类型搜索
  window.ProtoViewSearch = {
    /** 返回与 Tab 搜索一致的条目（接口/枚举/函数/常量） */
    searchAll(query) {
      const q = String(query || "").trim();
      if (!q) return [];
      const prevTab = globalSearch.tab;
      globalSearch.tab = "all";
      let items = [];
      try {
        items = filterGlobalSearch(q);
      } finally {
        globalSearch.tab = prevTab;
      }
      return items.filter((item) => item.kind !== "excel").map((item) => ({
        kind: item.kind,
        title: item.title,
        sub: item.sub,
        file: item.file,
        line: item.line,
        id: item.id,
        fromEnum: item.fromEnum,
        hay: item.hay,
      }));
    },
    /** 首页点结果：与 Tab 搜索的 Enter 行为一致 */
    openItem(item) {
      if (!item) return;
      if (item.kind === "rpc") {
        selectRpc(item.id, { tab: "docs" });
        requestAnimationFrame(() => revealTreeTarget("data-rpc", item.id));
        return;
      }
      if (item.kind === "enum") {
        selectType(item.id);
        requestAnimationFrame(() => revealTreeTarget("data-type-id", item.id));
        return;
      }
      jumpToSource(item);
    },
    /** 让首页在打开时预热代码符号，避免首次搜索为空 */
    warmup() {
      ensureCodeSymbols();
    },
  };

  // home.js 复用同一套宿主通信
  window.ProtoViewHost = {
    post(type, payload) {
      if (!vscode) return false;
      vscode.postMessage({ type, ...(payload === undefined ? {} : { payload }) });
      return true;
    },
    isHost: () => Boolean(vscode),
  };

  window.ProtoViewClient = {
    rerenderTree: () => renderTree(),
    notify: (message) => { setRespBadge("", String(message || "")); },
    findRpc,
    discardClientSnapshot,
    healAfterFlow() {
      const restored = restoreClientSnapshot();
      if (!restored && state.selected && state.tab === "message" && !String(els.messageEditor.value || "").trim()) {
        const draft = state.drafts[state.selected.id];
        els.messageEditor.value = draft?.message || generateMessage(state.selected);
      }
      if (state.tab) setTab(state.tab);
    },
    showRpcDefinition(id) {
      if (!findRpc(id)) return false;
      selectRpc(id, { tab: "docs" });
      return true;
    },
    /** 链路双击节点：用节点自身 payload 打开 Client 面板 */
    loadFlowInspectDraft(payload = {}) {
      const rpcId = payload.rpcId;
      if (!rpcId || !findRpc(rpcId)) return false;
      if (!payload.keepClient) captureClientSnapshot();
      const nodeMessageEmpty = payload.message == null
        || (typeof payload.message === "string" && (!payload.message.trim() || payload.message.trim() === "{}"))
        || (typeof payload.message === "object" && !Object.keys(payload.message).length);
      let messageText = "";
      if (!nodeMessageEmpty) {
        try {
          messageText = typeof payload.message === "string"
            ? payload.message
            : JSON.stringify(payload.message, null, 2);
        } catch {
          messageText = "";
        }
      }
      if (!messageText && clientSnapshot?.rpcId === rpcId) messageText = clientSnapshot.message || "";
      if (!messageText) messageText = state.drafts[rpcId]?.message || "";
      const nodeMeta = Array.isArray(payload.metadata)
        ? payload.metadata.filter((row) => row && String(row.name || "").trim())
        : [];
      selectRpc(rpcId, {
        skipPersist: true,
        showLatest: Boolean(payload.showLatest),
        tab: payload.tab || "docs",
        draft: {
          message: messageText,
          metadata: nodeMeta.length
            ? payload.metadata
            : (state.drafts[rpcId]?.metadata || [{ name: "", value: "", description: "" }]),
          protocol: payload.protocol || "grpc",
          httpMethod: payload.httpMethod || "POST",
          httpPath: payload.httpPath || "",
        },
      });
      return true;
    },
    /** 读回 Client 面板内容，写回链路节点 */
    readFlowInspectDraft() {
      if (!state.selected) return null;
      persistCurrentDraft();
      let message = {};
      try {
        message = parseJsonPreserveLongs(els.messageEditor.value || "{}");
        message = normalizeBodyLongs(message, state.selected.requestFields || []);
      } catch {
        message = {};
      }
      return {
        rpcId: state.selected.id,
        message,
        metadata: Array.isArray(state.metadata) ? state.metadata.map((row) => ({ ...row })) : [],
        protocol: $("protocolSelect")?.value || "grpc",
        httpMethod: $("httpMethodSelect")?.value || "POST",
        httpPath: $("httpPath")?.value || "",
      };
    },
    displayResponseEnums,
    getType(typeId) {
      if (!typeId) return undefined;
      return state.catalog.types?.[typeId];
    },
    findType(name) {
      const raw = String(name || "").trim();
      if (!raw) return undefined;
      const types = state.catalog.types || {};
      if (types[raw]) return types[raw];
      const bare = raw.includes(".") ? raw.split(".").pop() : raw;
      let found;
      for (const item of Object.values(types)) {
        if (!item) continue;
        if (item.fullName === raw || item.name === raw) return item;
        if (item.name === bare) found = found || item;
        if (item.fullName?.endsWith(`.${bare}`)) found = found || item;
      }
      return found;
    },
    getAllTypes() {
      return state.catalog.types || {};
    },
    /** 供链路模板/压测按「包/服务/方法」重新定位接口 */
    listRpcs() {
      const out = [];
      for (const pkg of state.catalog.packages || []) {
        for (const service of pkg.services || []) {
          for (const rpc of service.rpcs || []) {
            out.push({
              id: rpc.id,
              name: rpc.name,
              package: pkg.name,
              service: service.name,
              file: rpc.file,
              requestStream: Boolean(rpc.requestStream),
              responseStream: Boolean(rpc.responseStream),
            });
          }
        }
      }
      return out;
    },
    sampleField(field) {
      try { return sampleValue(field); }
      catch { return ""; }
    },
    invokeOnce,
    streamOpen,
    streamWrite,
    streamClose,
    decodeBytes,
    postHost(type, payload, id) {
      if (!vscode) return false;
      vscode.postMessage({ type, ...(payload === undefined ? {} : { payload }), ...(id ? { id } : {}) });
      return true;
    },
    isVsCodeHost: () => isVsCodeWebview,
    getSelectedRpcId: () => state.selected?.id || "",
    getSelectedRpcLabel: () => state.selected?.name || "",
    /** 链路节点「预览」：打开函数调用链路图抽屉 */
    openCallGraph(info = {}) {
      const name = String(info.name || "");
      if (!name) return false;
      // 定义浮层开着时先收起，避免两个右侧面板打架
      try { window.ProtoViewFlow?.closeInspect?.(); } catch { /* ignore */ }
      showCallGraphPreview({ title: name, file: String(info.file || ""), line: Number(info.line) || 1 });
      return true;
    },
    /** 供链路节点右键「跳转源码」：直接拆出/复用 VS Code 右侧编辑器分组 */
    openSourceFile(file, line) {
      const target = String(file || "");
      if (!target) return false;
      if (!vscode) return false;
      vscode.postMessage({ type: "openSource", file: target, line: Math.max(1, Number(line) || 1) });
      return true;
    },
    listEnvs: () => state.envs.map((env) => ({ id: env.id, name: env.name, host: env.host || "" })),
    getActiveEnvId: () => state.activeEnvId,
    setActiveEnvId(id) {
      if (!state.envs.some((env) => env.id === id)) return;
      applyEnvId(id);
    },
    resolveHost(envId) {
      const env = state.envs.find((item) => item.id === envId) || activeEnv();
      return env?.host || "";
    },
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "bootstrap") {
      applyBootstrap(data);
      globalSearch.codeLoaded = false;
      globalSearch.codeItems = [];
    }
    // 扩展标题栏快速入口：切到指定视图并按文件定位
    if (data.type === "openClientView") {
      const view = String(data.payload?.view || "client");
      const target = String(data.payload?.target || "");
      window.ProtoViewHome?.openTargetView?.(view, target);
    }
    if (data.type === "codeSymbols") applyCodeSymbols(data);
    if (data.type === "callGraph") renderCallGraph(data.payload);
    if (data.type === "invokeResult") {
      if (state.pendingInvoke && data.id && data.id !== state.pendingInvoke) {
        // 别的请求（例如链路里另一个节点）只更新它自己的 History，不盖住当前接口的响应
        recordHistoryResult(data.id, data);
        const entry = state.history.find((item) => item.id === data.id);
        if (state.selected && entry && historyMatches(entry, state.selected)) {
          showHistoryEntry(state.history.indexOf(entry), { activate: false });
        }
        return;
      }
      recordHistoryResult(data.id, data);
      const entry = state.history.find((item) => item.id === data.id);
      if (state.selected && entry && !historyMatches(entry, state.selected)) return;
      showInvokeResult(data);
    }
    if (data.type === "stressProgress" && data.id === state.stressId) showStressProgress(data);
    if (data.type === "stressResult" && (!data.id || data.id === state.stressId)) showStressResult(data);
    if (data.type === "ghzProgress" && data.id === state.stressId) {
      state.ghzLog += data.text || "";
      const view = $("ghzLogView");
      if (view) {
        view.textContent = state.ghzLog;
        view.scrollTop = view.scrollHeight;
      }
    }
    if (data.type === "ghzResult" && data.id === state.stressId) {
      state.ghzLog += data.text || "";
      setStressRunning(false);
      els.stressResult.innerHTML = `<pre class="stress-log">${esc(state.ghzLog)}</pre>`;
      setRespBadge(data.ok ? "ok" : "err", data.ok ? "ghz 完成" : "ghz 失败/未安装");
    }
    if (data.type === "pickedProtoDir" && data.path) {
      // 只回填路径，等用户点「应用并刷新」
      if ($("sourceDirPath")) $("sourceDirPath").value = String(data.path);
      const dirMode = document.querySelector('input[name="sourceMode"][value="directory"]');
      if (dirMode) dirMode.checked = true;
      syncSourceModalUi();
      const dirHint = $("sourceDirHint");
      if (dirHint) {
        dirHint.textContent = data.label
          ? (data.count
            ? `已选择：${data.label}（${data.count} 个 .proto），请点「应用并刷新」`
            : `已选择：${data.label}，请点「应用并刷新」`)
          : `已选择：${data.path}，请点「应用并刷新」`;
      }
      openModal(els.sourceModal);
      setRespBadge("ok", data.count
        ? `已导入 ${data.count} 个 .proto，请点应用并刷新`
        : "已选择目录，请点应用并刷新");
    }
    if (data.type === "reopenSourceModal") {
      openSourceModal();
    }
    if (data.type === "sourceContent") {
      showSourceDrawer(data.file, data.line, data.content);
      setRespBadge("ok", `已打开 ${String(data.file || "").replace(/\\/g, "/").split("/").pop() || "源码"}`);
    }
    if (data.type === "pickedGhzBinary" && data.path) {
      setGhzPath(data.path);
      setRespBadge("ok", "已选择 ghz");
    }
    if (data.type === "toast" && data.text) {
      setRespBadge(data.level === "err" ? "err" : "ok", String(data.text));
    }
  });

  els.bulkModal.addEventListener("click", (event) => {
    if (event.target === els.bulkModal) closeModal(els.bulkModal);
  });
  els.envModal.addEventListener("click", (event) => {
    if (event.target === els.envModal) {
      commitEnvForm();
      persistEnvs();
      closeModal(els.envModal);
    }
  });

  const ai = { tiles: [], selected: -1, solved: false, target: ["山", "海", "平", "爱"] };

  function openAi() {
    const overlay = $("aiOverlay");
    if (overlay && overlay.parentElement !== document.body) document.body.appendChild(overlay);
    overlay.classList.add("show");
    const qr = $("aiQr");
    if (state.qr) {
      qr.src = state.qr;
      qr.hidden = false;
    }
    if (!ai.tiles.length || ai.solved) {
      ai.solved = false;
      ai.selected = -1;
      ai.tiles = shuffleTiles(ai.target.slice());
      $("aiReward").classList.add("hidden");
      $("aiGame").classList.remove("hidden");
    }
    renderAiBoard();
  }

  function closeAi() {
    $("aiOverlay").classList.remove("show");
  }

  function renderAiBoard() {
    const board = $("aiBoard");
    board.innerHTML = "";
    ai.tiles.forEach((label, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-tile" + (ai.solved ? " done" : "") + (ai.selected === index ? " selected" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (ai.solved) return;
        if (ai.selected < 0) ai.selected = index;
        else if (ai.selected === index) ai.selected = -1;
        else {
          const from = ai.selected;
          const tmp = ai.tiles[from];
          ai.tiles[from] = ai.tiles[index];
          ai.tiles[index] = tmp;
          ai.selected = -1;
          if (ai.tiles.join("") === ai.target.join("")) {
            ai.solved = true;
            $("aiReward").classList.remove("hidden");
          }
        }
        renderAiBoard();
      });
      board.appendChild(btn);
    });
  }

  function shuffleTiles(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    if (list.join("") === "山海平爱") return shuffleTiles(list);
    return list;
  }

  function loadSplitState() {
    try {
      return JSON.parse(localStorage.getItem(SPLIT_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveSplitState(next) {
    localStorage.setItem(SPLIT_KEY, JSON.stringify(next));
  }

  function initSplitLayout() {
    const workspace = $("workspace");
    const handle = $("splitHandle");
    const reqBtn = $("collapseReqBtn");
    const respBtn = $("collapseRespBtn");
    if (!workspace || !handle || !reqBtn || !respBtn) return;

    const saved = loadSplitState();
    // 左右宽度（Client 主区）
    let leftRatio = typeof saved.leftRatio === "number" ? saved.leftRatio : 0.4;
    let leftCollapsed = Boolean(saved.leftCollapsed);
    let rightCollapsed = Boolean(saved.rightCollapsed);
    // 右栏内 请求/响应 高度
    let ratio = typeof saved.ratio === "number" ? saved.ratio : 0.5;
    let reqCollapsed = Boolean(saved.reqCollapsed);
    let respCollapsed = Boolean(saved.respCollapsed);
    if (leftCollapsed && rightCollapsed) rightCollapsed = false;
    if (reqCollapsed && respCollapsed) respCollapsed = false;

    function persist() {
      saveSplitState({ leftRatio, leftCollapsed, rightCollapsed, ratio, reqCollapsed, respCollapsed });
    }

    function apply() {
      workspace.style.setProperty("--left-size", `${Math.round(leftRatio * 10000) / 100}%`);
      workspace.classList.toggle("left-collapsed", leftCollapsed);
      workspace.classList.toggle("right-collapsed", rightCollapsed);
      reqBtn.title = leftCollapsed ? "展开左侧" : "收起左侧";
      respBtn.title = rightCollapsed ? "展开右侧" : "收起右侧";
      const rightSplit = $("rightSplit");
      if (rightSplit) {
        rightSplit.style.setProperty("--right-req-size", `${Math.round(ratio * 10000) / 100}%`);
        rightSplit.classList.toggle("req-collapsed", reqCollapsed);
        rightSplit.classList.toggle("resp-collapsed", respCollapsed);
      }
      const areaReqBtn = $("collapseReqAreaBtn");
      const areaRespBtn = $("collapseRespAreaBtn");
      if (areaReqBtn) areaReqBtn.title = reqCollapsed ? "展开请求" : "收起请求";
      if (areaRespBtn) areaRespBtn.title = respCollapsed ? "展开响应" : "收起响应";
      persist();
    }

    reqBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      leftCollapsed = !leftCollapsed;
      if (leftCollapsed && rightCollapsed) rightCollapsed = false;
      apply();
    });
    respBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      rightCollapsed = !rightCollapsed;
      if (rightCollapsed && leftCollapsed) leftCollapsed = false;
      apply();
    });

    // 横向拖动：调整左右宽度
    let draggingX = false;
    const onMoveX = (event) => {
      if (!draggingX) return;
      const rect = workspace.getBoundingClientRect();
      if (!rect.width) return;
      leftRatio = Math.min(0.78, Math.max(0.16, (event.clientX - rect.left) / rect.width));
      if (leftCollapsed || rightCollapsed) {
        leftCollapsed = false;
        rightCollapsed = false;
      }
      apply();
    };
    const onUpX = () => {
      if (!draggingX) return;
      draggingX = false;
      workspace.classList.remove("splitting-x");
      window.removeEventListener("pointermove", onMoveX);
      window.removeEventListener("pointerup", onUpX);
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      draggingX = true;
      workspace.classList.add("splitting-x");
      window.addEventListener("pointermove", onMoveX);
      window.addEventListener("pointerup", onUpX);
    });
    $("splitBar").addEventListener("dblclick", () => {
      leftRatio = 0.4;
      leftCollapsed = false;
      rightCollapsed = false;
      apply();
    });

    // 右栏内 请求/响应 上下拖动
    const respHandle = $("respSplitHandle");
    let draggingY = false;
    const onMoveY = (event) => {
      if (!draggingY) return;
      const split = $("rightSplit");
      const rect = split?.getBoundingClientRect();
      if (!rect || !rect.height) return;
      ratio = Math.min(0.85, Math.max(0.15, (event.clientY - rect.top) / rect.height));
      if (reqCollapsed || respCollapsed) {
        reqCollapsed = false;
        respCollapsed = false;
      }
      apply();
    };
    const onUpY = () => {
      if (!draggingY) return;
      draggingY = false;
      $("rightSplit")?.classList.remove("splitting");
      window.removeEventListener("pointermove", onMoveY);
      window.removeEventListener("pointerup", onUpY);
    };
    respHandle?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      draggingY = true;
      $("rightSplit")?.classList.add("splitting");
      window.addEventListener("pointermove", onMoveY);
      window.addEventListener("pointerup", onUpY);
    });
    $("respSplitBar")?.addEventListener("dblclick", () => {
      ratio = 0.5;
      reqCollapsed = false;
      respCollapsed = false;
      apply();
    });
    $("collapseReqAreaBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      reqCollapsed = !reqCollapsed;
      if (reqCollapsed && respCollapsed) respCollapsed = false;
      apply();
    });
    $("collapseRespAreaBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      respCollapsed = !respCollapsed;
      if (respCollapsed && reqCollapsed) reqCollapsed = false;
      apply();
    });

    apply();
  }

  function collectProtoSearchItems() {
    const items = [];
    for (const pkg of state.catalog.packages || []) {
      for (const service of pkg.services || []) {
        for (const rpc of service.rpcs || []) {
          items.push({
            kind: "rpc",
            id: rpc.id,
            title: rpc.name,
            sub: `${pkg.name}.${service.name}`,
            file: rpc.path || "",
            line: Number(rpc.line || 1) || 1,
            hay: `${rpc.name} ${pkg.name} ${service.name} ${rpc.comment || ""} ${rpc.request || ""} ${rpc.response || ""}`.toLowerCase(),
          });
        }
      }
      for (const en of pkg.enums || []) {
        const values = en.values || [];
        const valueNames = values.map((v) => v.name).join(" ");
        const type = state.catalog.types?.[en.id];
        const protoFile = type?.path || "";
        const protoLine = Number(type?.line || 1) || 1;
        items.push({
          kind: "enum",
          id: en.id,
          title: en.name,
          sub: `${pkg.name} · enum`,
          file: protoFile,
          line: protoLine,
          hay: `${en.name} ${pkg.name} ${en.comment || ""} ${valueNames}`.toLowerCase(),
        });
        for (const value of values) {
          items.push({
            kind: "const",
            id: en.id,
            title: value.name,
            sub: `${pkg.name}.${en.name}`,
            file: protoFile,
            line: protoLine,
            hay: `${value.name} ${en.name} ${pkg.name} ${value.comment || ""}`.toLowerCase(),
            fromEnum: true,
          });
        }
      }
    }
    return items;
  }

  function ensureCodeSymbols() {
    if (globalSearch.codeLoaded || globalSearch.codeLoading || !vscode) return;
    globalSearch.codeLoading = true;
    vscode.postMessage({ type: "loadCodeSymbols" });
  }

  function applyCodeSymbols(data) {
    globalSearch.codeLoading = false;
    globalSearch.codeLoaded = true;
    const list = Array.isArray(data?.items) ? data.items : [];
    globalSearch.codeItems = list.map((item) => ({
      kind: item.kind === "const" ? "const" : "func",
      title: String(item.title || ""),
      sub: String(item.sub || ""),
      file: String(item.file || ""),
      line: Number(item.line || 1) || 1,
      hay: String(item.hay || `${item.title || ""} ${item.sub || ""}`).toLowerCase(),
    })).filter((item) => item.title);
    if (globalSearch.open) refreshGlobalSearchList();
  }

  function collectGlobalSearchItems() {
    const tab = globalSearch.tab || "all";
    const proto = collectProtoSearchItems();
    const code = globalSearch.codeItems || [];
    if (tab === "rpc") return proto.filter((item) => item.kind === "rpc");
    if (tab === "enum") return proto.filter((item) => item.kind === "enum");
    if (tab === "func") return code.filter((item) => item.kind === "func");
    if (tab === "excel") return globalSearch.excelHits || [];
    if (tab === "docs") return globalSearch.docsHits || [];
    if (tab === "db") return globalSearch.dbHits || [];
    if (tab === "const") {
      return [
        ...proto.filter((item) => item.kind === "const"),
        ...code.filter((item) => item.kind === "const"),
      ];
    }
    return [
      ...proto.filter((item) => item.kind === "rpc" || item.kind === "enum"),
      ...code,
      ...(globalSearch.excelHits || []),
      ...(globalSearch.docsHits || []),
      ...(globalSearch.dbHits || []),
    ];
  }

  function filterGlobalSearch(query) {
    const q = String(query || "").trim().toLowerCase();
    const all = collectGlobalSearchItems();
    if (!q) return all.slice(0, 80);
    const parts = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const item of all) {
      let score = 0;
      let ok = true;
      for (const part of parts) {
        const idx = item.hay.indexOf(part);
        if (idx < 0) { ok = false; break; }
        score += idx === 0 || item.title.toLowerCase().startsWith(part) ? 40 : 10;
        score += item.title.toLowerCase().includes(part) ? 20 : 0;
      }
      if (ok) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
    return scored.slice(0, 80).map((row) => row.item);
  }

  function refreshGlobalSearchList() {
    globalSearch.items = filterGlobalSearch($("globalSearchInput")?.value || "");
    if (globalSearch.active >= globalSearch.items.length) globalSearch.active = 0;
    renderGlobalSearchList();
  }

  function renderGlobalSearchTabs() {
    const tabs = $("globalSearchTabs");
    if (!tabs) return;
    for (const btn of tabs.querySelectorAll("[data-gs-tab]")) {
      const on = btn.getAttribute("data-gs-tab") === globalSearch.tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function setGlobalSearchTab(tab) {
    const next = GS_TABS.includes(tab) ? tab : "all";
    globalSearch.tab = next;
    if (next === "func" || next === "const" || next === "all") ensureCodeSymbols();
    if (next === "excel" || next === "all") refreshExcelHits();
    if (next === "docs" || next === "all") refreshDocsHits();
    if (next === "db" || next === "all") refreshDbHits();
    renderGlobalSearchTabs();
    globalSearch.active = 0;
    refreshGlobalSearchList();
  }

  /** Excel 分类：按当前关键词向宿主查询表/行 */
  function refreshExcelHits() {
    const query = String($("globalSearchInput")?.value || "").trim();
    if (!query) {
      globalSearch.excelHits = [];
      globalSearch.excelLoaded = false;
      return;
    }
    if (globalSearch.excelLoaded && globalSearch.excelQuery === query) return;
    globalSearch.excelQuery = query;
    window.ProtoViewHome?.searchExcel?.(query, (hits) => {
      globalSearch.excelLoaded = true;
      globalSearch.excelHits = (Array.isArray(hits) ? hits : []).map((hit) => {
        const count = Number(hit.count || 0);
        const fileName = hit.fileName || String(hit.relative || "").split(/[/\\]/).pop() || hit.sheet || "";
        return {
          kind: "excel",
          title: fileName,
          sub: `${hit.sheet || ""}${count ? ` · ${count} 处` : ""}${hit.row ? ` · 行 ${hit.row}` : ""}`,
          sheetId: hit.sheetId,
          row: Number(hit.row || 0),
          hay: `${fileName} ${hit.sheet || ""} ${hit.relative || ""} ${hit.preview || ""}`.toLowerCase(),
        };
      });
      if (globalSearch.tab === "excel" || globalSearch.tab === "all") refreshGlobalSearchList();
    });
  }

  function refreshDocsHits() {
    const query = String($("globalSearchInput")?.value || "").trim();
    if (!query) {
      globalSearch.docsHits = [];
      return;
    }
    if (globalSearch.docsQuery === query && globalSearch.docsHits.length) return;
    globalSearch.docsQuery = query;
    window.ProtoViewDocs?.search?.(query, (hits) => {
      globalSearch.docsHits = (Array.isArray(hits) ? hits : []).map((hit) => ({
        kind: "docs",
        title: hit.title || hit.fileName || "",
        sub: `${hit.relative || ""}${hit.count ? ` · ${hit.count} 处` : ""}`,
        docId: hit.id,
        line: Number(hit.line || 1),
        hay: `${hit.title || ""} ${hit.relative || ""} ${hit.preview || ""}`.toLowerCase(),
      }));
      if (globalSearch.tab === "docs" || globalSearch.tab === "all") refreshGlobalSearchList();
    });
  }

  function refreshDbHits() {
    const query = String($("globalSearchInput")?.value || "").trim();
    if (!query) {
      globalSearch.dbHits = [];
      return;
    }
    if (globalSearch.dbQuery === query && globalSearch.dbHits.length) return;
    globalSearch.dbQuery = query;
    window.ProtoViewDb?.search?.(query, (hits) => {
      globalSearch.dbHits = (Array.isArray(hits) ? hits : []).map((hit) => ({
        kind: "db",
        title: hit.table || "",
        sub: `${hit.fileName || hit.relative || ""}${hit.count ? ` · ${hit.count} 处` : ""}`,
        tableId: hit.id,
        hay: `${hit.table || ""} ${hit.fileName || ""} ${hit.relative || ""} ${hit.preview || ""}`.toLowerCase(),
      }));
      if (globalSearch.tab === "db" || globalSearch.tab === "all") refreshGlobalSearchList();
    });
  }
  function renderGlobalSearchList() {
    const list = $("globalSearchList");
    if (!list) return;
    if (!globalSearch.items.length) {
      const loading = (globalSearch.tab === "func" || globalSearch.tab === "const" || globalSearch.tab === "all")
        && globalSearch.codeLoading;
      list.innerHTML = `<div class="global-search-empty">${loading ? "正在扫描项目代码…" : "没有匹配结果"}</div>`;
      return;
    }
    list.innerHTML = globalSearch.items.map((item, index) => {
      const kind = GS_KIND_LABEL[item.kind] || item.kind;
      const actions = [];
      if (item.kind === "rpc") {
        actions.push(`<button class="gs-action primary" type="button" data-gs-add="${index}" title="添加到画布">添加节点</button>`);
      }
      if (item.kind === "func") {
        actions.push(`<button class="gs-action" type="button" data-gs-preview="${index}" title="查看调用链路图">预览</button>`);
      }
      if (item.kind === "excel") {
        actions.push(`<button class="gs-action primary" type="button" data-gs-sheet="${index}" title="在 ExcelView 打开该表">跳转表</button>`);
      }
      if (item.kind === "docs" || item.kind === "db") {
        actions.push(`<button class="gs-action primary" type="button" data-gs-jump="${index}" title="打开">打开</button>`);
      }
      if (item.file) {
        actions.push(`<button class="gs-action" type="button" data-gs-src="${index}" title="在右侧编辑器打开源码">跳转源码</button>`);
      }
      return `
      <div class="global-search-item${index === globalSearch.active ? " active" : ""}" role="option" data-gs-index="${index}">
        <span class="global-search-kind is-${esc(item.kind)}">${kind}</span>
        <span class="global-search-title">${esc(item.title)}</span>
        <span class="global-search-sub">${esc(item.sub)}</span>
        ${actions.length ? `<span class="global-search-actions">${actions.join("")}</span>` : ""}
      </div>`;
    }).join("");
    list.querySelector(".global-search-item.active")?.scrollIntoView({ block: "nearest" });
  }

  function openGlobalSearch() {
    const mask = $("globalSearchMask");
    const input = $("globalSearchInput");
    if (!mask || !input) return;
    globalSearch.open = true;
    globalSearch.active = 0;
    mask.classList.add("show");
    mask.setAttribute("aria-hidden", "false");
    input.value = "";
    renderGlobalSearchTabs();
    ensureCodeSymbols();
    refreshGlobalSearchList();
    requestAnimationFrame(() => input.focus());
  }

  function closeGlobalSearch() {
    const mask = $("globalSearchMask");
    if (!mask) return;
    globalSearch.open = false;
    mask.classList.remove("show");
    mask.setAttribute("aria-hidden", "true");
  }

  function revealTreeTarget(attr, value) {
    const el = [...(els.tree?.querySelectorAll(`[${attr}]`) || [])]
      .find((node) => node.getAttribute(attr) === value);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash-hit");
    window.setTimeout(() => el.classList.remove("flash-hit"), 1200);
  }

  /** 跳转源码：直接拆出/复用 VS Code 右侧编辑器分组（不走抽屉） */
  function jumpToSource(item) {
    const file = String(item?.file || "");
    const line = Math.max(1, Number(item?.line) || 1);
    if (!file) {
      setRespBadge("err", "未找到源码位置");
      return;
    }
    closeGlobalSearch();
    if (!vscode) {
      const loc = `${file}:${line}`;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(loc).then(
          () => setRespBadge("ok", `已复制路径 ${loc}`),
          () => setRespBadge("err", loc),
        );
      } else {
        setRespBadge("err", loc);
      }
      return;
    }
    vscode.postMessage({ type: "openSource", file, line });
    setRespBadge("ok", `已打开 ${file.replace(/\\/g, "/").split("/").pop()}:${line}`);
  }

  /** 调用图「查看 DB」：整条链路聚合出的读写表列表，每行可跳到 DbView 对应表 */
  function showCallGraphDb(name, file) {
    const graph = callGraphState.graph;
    const board = $("callGraphBoard");
    board?.querySelector(".call-graph-db-panel")?.remove();
    const seen = new Map();
    for (const node of graph?.nodes || []) {
      const isFocus = node.name === name && (!file || node.file === file);
      for (const hit of node.db || []) {
        const table = String(hit.table || "").trim();
        if (!table) continue;
        const key = table.toLowerCase();
        const prev = seen.get(key);
        const op = hit.op === "write" ? "write" : hit.op === "read" ? "read" : "unknown";
        if (!prev) {
          seen.set(key, { table, ops: new Set([op]), sources: isFocus ? [node.name] : [], focus: isFocus, line: hit.line, file: node.file });
        } else {
          prev.ops.add(op);
          if (isFocus) { prev.focus = true; prev.line = hit.line; prev.file = node.file; }
          if (isFocus && !prev.sources.includes(node.name)) prev.sources.push(node.name);
        }
      }
    }
    const rows = [...seen.values()].sort((a, b) => Number(b.focus) - Number(a.focus) || a.table.localeCompare(b.table));
    const opLabel = (ops) => {
      const read = ops.has("read");
      const write = ops.has("write");
      if (read && write) return { text: "读写", cls: "is-rw" };
      if (write) return { text: "写", cls: "is-write" };
      if (read) return { text: "读", cls: "is-read" };
      return { text: "未知", cls: "is-unknown" };
    };
    const body = rows.length
      ? rows.map((row) => {
        const op = opLabel(row.ops);
        return `<div class="call-graph-db-item">
          <span class="call-graph-db-tag ${op.cls}">${op.text}</span>
          <span class="call-graph-db-name" title="${esc(row.table)}">${esc(row.table)}</span>
          <button class="gs-action" type="button" data-cg-db-open="${esc(row.table)}" title="在 DbView 打开这张表">查看</button>
        </div>`;
      }).join("")
      : `<div class="call-graph-db-item call-graph-db-none">未识别到数据库表（可能通过 DAO 间接访问）</div>`;
    const panel = document.createElement("div");
    panel.className = "call-graph-db-panel";
    panel.innerHTML = `<div class="call-graph-db-panel-head">
        <strong>${esc(name || "调用链")} · 数据表</strong>
        <span class="call-graph-db-count">${rows.length} 张</span>
        <button class="icon-btn" type="button" data-cg-db-close title="关闭">✕</button>
      </div>
      <div class="call-graph-db-panel-body">${body}</div>`;
    (board || $("sourceDrawer"))?.appendChild(panel);
  }


  /** 调用图里点「查看」：切到 DbView 并定位到该表（库名自动匹配） */
  function openDbTableFromCallGraph(tableName) {
    const target = String(tableName || "").trim();
    if (!target) return;
    closeSourceDrawer();
    const db = window.ProtoViewDb;
    if (!db?.openTableByName) return;
    window.ProtoViewHome?.openTab?.("db", "DbView Client");
    window.ProtoViewHome?.setView?.("db");
    // 等视图切换后再定位，避免 setView 的 ensure 覆盖选中态
    requestAnimationFrame(() => db.openTableByName(target));
  }

  /** Excel 结果：切到 ExcelView 并定位到表/行 */
  function openExcelSheet(item) {
    const sheetId = String(item?.sheetId || "");
    if (!sheetId) return;
    closeGlobalSearch();
    window.ProtoViewHome?.openSheet?.(sheetId, Number(item.row) || 0);
  }

  function applyGlobalSearchItem(item) {
    if (!item) return;
    // Excel：跳到 ExcelView 对应表
    if (item.kind === "excel") {
      openExcelSheet(item);
      return;
    }
    if (item.kind === "docs") {
      closeGlobalSearch();
      window.ProtoViewDocs?.open?.(item.docId, item.line || 1);
      return;
    }
    if (item.kind === "db") {
      closeGlobalSearch();
      window.ProtoViewDb?.openTable?.(item.tableId);
      return;
    }
    // 接口 / 枚举：回车跳到左侧定义
    if (item.kind === "rpc") {
      closeGlobalSearch();
      selectRpc(item.id, { tab: "docs" });
      requestAnimationFrame(() => revealTreeTarget("data-rpc", item.id));
      return;
    }
    if (item.kind === "enum") {
      closeGlobalSearch();
      selectType(item.id);
      requestAnimationFrame(() => revealTreeTarget("data-type-id", item.id));
      return;
    }
    // 函数 / 常量：回车等同「跳转源码」
    jumpToSource(item);
  }

  function addGlobalSearchRpcToCanvas(item) {
    if (!item || item.kind !== "rpc") return;
    placeFlowRpc(item.id, item.title);
    closeGlobalSearch();
    setRespBadge("ok", `已添加 ${item.title} 到画布`);
  }

  function moveGlobalSearchActive(delta) {
    if (!globalSearch.items.length) return;
    const next = (globalSearch.active + delta + globalSearch.items.length) % globalSearch.items.length;
    globalSearch.active = next;
    renderGlobalSearchList();
  }

  $("globalSearchInput")?.addEventListener("input", () => {
    globalSearch.active = 0;
    globalSearch.excelLoaded = false;
    globalSearch.excelHits = [];
    globalSearch.docsHits = [];
    globalSearch.docsQuery = "";
    globalSearch.dbHits = [];
    globalSearch.dbQuery = "";
    refreshGlobalSearchList();
    if (globalSearch.tab === "excel" || globalSearch.tab === "all") refreshExcelHits();
    if (globalSearch.tab === "docs" || globalSearch.tab === "all") refreshDocsHits();
    if (globalSearch.tab === "db" || globalSearch.tab === "all") refreshDbHits();
  });
  $("globalSearchTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest?.("[data-gs-tab]");
    if (!tab) return;
    setGlobalSearchTab(tab.getAttribute("data-gs-tab"));
    $("globalSearchInput")?.focus();
  });
  $("globalSearchList")?.addEventListener("click", (event) => {
    const add = event.target.closest?.("[data-gs-add]");
    if (add) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(add.getAttribute("data-gs-add"));
      addGlobalSearchRpcToCanvas(globalSearch.items[index]);
      return;
    }
    const preview = event.target.closest?.("[data-gs-preview]");
    if (preview) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(preview.getAttribute("data-gs-preview"));
      const item = globalSearch.items[index];
      closeGlobalSearch();
      showCallGraphPreview(item);
      return;
    }
    const jump = event.target.closest?.("[data-gs-jump]");
    if (jump) {
      event.preventDefault();
      event.stopPropagation();
      applyGlobalSearchItem(globalSearch.items[Number(jump.getAttribute("data-gs-jump"))]);
      return;
    }
    const sheet = event.target.closest?.("[data-gs-sheet]");
    if (sheet) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(sheet.getAttribute("data-gs-sheet"));
      openExcelSheet(globalSearch.items[index]);
      return;
    }
    const src = event.target.closest?.("[data-gs-src]");
    if (src) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(src.getAttribute("data-gs-src"));
      jumpToSource(globalSearch.items[index]);
      return;
    }
    const row = event.target.closest?.("[data-gs-index]");
    if (!row) return;
    const index = Number(row.getAttribute("data-gs-index"));
    applyGlobalSearchItem(globalSearch.items[index]);
  });
  $("globalSearchMask")?.addEventListener("mousedown", (event) => {
    if (event.target === $("globalSearchMask")) closeGlobalSearch();
  });
  document.addEventListener("keydown", (event) => {
    if (globalSearch.open) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGlobalSearch();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveGlobalSearchActive(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveGlobalSearchActive(-1);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const order = GS_TABS;
        const idx = order.indexOf(globalSearch.tab);
        if (idx >= 0 && event.target === $("globalSearchInput")) {
          // keep arrows for text caret when input has selection intent; only cycle tabs with Alt
        }
        if (event.altKey) {
          event.preventDefault();
          const next = event.key === "ArrowRight"
            ? order[(idx + 1) % order.length]
            : order[(idx - 1 + order.length) % order.length];
          setGlobalSearchTab(next);
          return;
        }
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const current = globalSearch.items[globalSearch.active];
        if (event.shiftKey) {
          if (current?.kind === "rpc") addGlobalSearchRpcToCanvas(current);
          else if (current?.kind === "excel") openExcelSheet(current);
          else if (current?.file) jumpToSource(current);
          return;
        }
        applyGlobalSearchItem(current);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const order = GS_TABS;
        const idx = Math.max(0, order.indexOf(globalSearch.tab));
        const next = event.shiftKey
          ? order[(idx - 1 + order.length) % order.length]
          : order[(idx + 1) % order.length];
        setGlobalSearchTab(next);
        return;
      }
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    const tag = active?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
    if (typing) return;
    if (document.querySelector(".modal-mask.show")) return;
    event.preventDefault();
    openGlobalSearch();
  });

  setTab("message");
  renderMetadata();
  renderAuth();
  renderRpcInfo();
  initSplitLayout();
  setStressMode("light");

  if (!vscode) {
    loadLocalEnvs();
    if (window.__PROTOVIEW_BOOTSTRAP__) applyBootstrap(window.__PROTOVIEW_BOOTSTRAP__);
    else {
      renderEnvSelect();
      renderTree();
    }
  } else {
    vscode.postMessage({ type: "ready" });
  }
})();
