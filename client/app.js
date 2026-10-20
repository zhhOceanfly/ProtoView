(() => {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  const THEME_KEY = "protoview.client.theme";
  const DRAFT_KEY = "protoview.client.drafts";
  const SPLIT_KEY = "protoview.client.split";

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
    history: [],
    drafts: loadDrafts(),
    messageDirty: false,
    stressMode: "light",
    stressId: "",
    ghzLog: "",
    source: {
      mode: "workspace",
      gitUrl: "",
      gitBranch: "main",
      localPath: "",
      lastError: "",
    },
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
    if (!state.selected) return;
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

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    } catch {
      return {};
    }
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
    els.themeBtn.textContent = saved === "light" ? "☾" : "◐";
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    els.themeBtn.textContent = next === "light" ? "☾" : "◐";
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
      <div class="env-item">
        <div>
          <strong>${esc(env.name)}</strong>
          <span>${esc(env.host || "(未配置地址)")}</span>
        </div>
        <button class="btn" type="button" data-pick-env="${esc(env.id)}">编辑</button>
      </div>
    `).join("");
  }

  function renderTree() {
    const query = (els.filter.value || "").trim().toLowerCase();
    const packs = state.catalog.packages || [];
    if (!packs.length) {
      els.tree.innerHTML = `<div class="empty-side">还没有接口数据。点击刷新，或确认 Proto 来源已解析成功。</div>`;
      return;
    }
    ensureExpandedDefaults();
    let html = "";
    for (const pkg of packs) {
      const services = (pkg.services || []).filter((service) => matchService(pkg, service, query));
      if (!services.length) continue;
      const pkgKey = `pkg:${pkg.name}`;
      const pkgOpen = state.expanded.has(pkgKey);
      const rpcCount = services.reduce((n, s) => n + (s.rpcs || []).length, 0);
      html += `<div class="node">
        <button class="node-row" type="button" data-toggle="${esc(pkgKey)}">
          <span class="caret">${pkgOpen ? "▼" : "▶"}</span>
          <span class="kind">📦</span>
          <span class="label">${esc(pkg.name)}</span>
          <span class="count">${rpcCount}</span>
        </button>
        <div class="children${pkgOpen ? "" : " collapsed"}">`;
      for (const service of services) {
        const svcKey = `svc:${service.id}`;
        const svcOpen = state.expanded.has(svcKey);
        const rpcs = (service.rpcs || []).filter((rpc) => matchRpc(pkg, service, rpc, query));
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
          html += `<div>
            <button class="node-row${active}" type="button" data-rpc="${esc(rpc.id)}" title="在链路调试中按住拖到画布">
              <span class="caret"></span>
              <span class="kind">⇢</span>
              <span class="label">${esc(rpc.name)}</span>
            </button>
            <div class="rpc-desc">${esc(rpc.comment || `${rpc.request} → ${rpc.response}`)}</div>
          </div>`;
        }
        html += `</div></div>`;
      }
      html += `</div></div>`;
    }
    els.tree.innerHTML = html || `<div class="empty-side">没有匹配的接口</div>`;
    syncTreeToggle();
  }

  function matchService(pkg, service, query) {
    if (!query) return true;
    if (pkg.name.toLowerCase().includes(query) || service.name.toLowerCase().includes(query)) return true;
    return (service.rpcs || []).some((rpc) => matchRpc(pkg, service, rpc, query));
  }

  function matchRpc(pkg, service, rpc, query) {
    if (!query) return true;
    const hay = `${pkg.name} ${service.name} ${rpc.name} ${rpc.comment || ""} ${rpc.request} ${rpc.response}`.toLowerCase();
    return hay.includes(query);
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

  function selectRpc(id, opts = {}) {
    const hit = findRpc(id);
    if (!hit) return;
    if (state.selected && state.messageDirty) persistCurrentDraft();
    const { pkg, service, rpc } = hit;
    state.expanded.add(`pkg:${pkg.name}`);
    state.expanded.add(`svc:${service.id}`);
    state.selected = { ...rpc, package: pkg.name, service: service.name, serviceId: service.id };
    els.methodLabel.textContent = `${pkg.name}.${service.name}/${rpc.name}`;
    els.sendBtn.disabled = false;

    const draft = state.drafts[rpc.id];
    if (draft && !opts.forceGenerate) {
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
    setTab(state.tab);
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
      ? `<details class="rpc-info-def" open><summary>接口定义</summary><pre>${esc(rpc.source)}</pre></details>`
      : "";
    el.innerHTML = `
      <h3 class="rpc-info-title">${esc(rpc.name)}</h3>
      <p class="rpc-info-lead">${esc(rpc.comment || "无注释")}</p>
      <p class="rpc-info-meta">${esc(rpc.package)}.${esc(rpc.service)} · ${esc(rpc.file || "")}${rpc.line ? `:${rpc.line}` : ""}</p>
      ${chips.length ? `<div class="rpc-info-chips">${chips.join("")}</div>` : ""}
      <div class="rpc-info-row"><span>请求</span><code>${esc(rpc.request)}</code></div>
      <div class="rpc-info-row"><span>响应</span><code>${esc(rpc.response)}</code></div>
      <div class="rpc-info-row"><span>字段</span><code>${(rpc.requestFields || []).length} 个请求字段</code></div>
      ${source}
      ${rpc.path ? `<button class="btn" type="button" style="margin-top:10px" data-src="${esc(rpc.path)}" data-line="${rpc.line || 1}">跳转到源码</button>` : ""}
    `;
  }

  function sampleValue(field, depth = 0, seen = new Set()) {
    if (field.repeated) {
      if (depth >= 2) return [];
      return [sampleValue({ ...field, repeated: false }, depth + 1, seen)];
    }
    if (field.key) {
      if (depth >= 2) return {};
      const keySample = sampleScalar(field.key, `${field.name}Key`);
      return { [String(keySample)]: sampleValue({ ...field, key: undefined }, depth + 1, seen) };
    }

    const type = (field.type || "").replace(/^\./, "");
    const typeDef = field.typeId ? state.catalog.types?.[field.typeId] : undefined;
    if (typeDef?.kind === "enum") return sampleEnum(typeDef);
    if (typeDef?.kind === "message") return sampleMessage(typeDef, depth, seen);
    return sampleScalar(type, field.name);
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

  function sampleScalar(type, fieldName) {
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
      return sampleNumber(name, lower, hint, type.includes("64"));
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
      const obj = JSON.parse(els.messageEditor.value || "{}");
      els.messageEditor.value = JSON.stringify(obj, null, 2);
      state.messageDirty = true;
      setRespBadge("ok", "Message 已格式化");
    } catch (error) {
      setRespBadge("err", `JSON 无法格式化：${error.message}`);
    }
  }

  function paintDocs() {
    const hit = state.selected ? findRpc(state.selected.id) : null;
    if (!hit) {
      els.docsView.innerHTML = `<div class="doc-empty">选择左侧接口后显示注释与请求/响应字段。</div>`;
      return;
    }
    const typeId = state.docsNav[state.docsNav.length - 1];
    if (typeId && state.catalog.types?.[typeId]) renderTypeDoc(hit, typeId);
    else renderDocs(hit.pkg, hit.service, hit.rpc);
  }

  function openType(id) {
    if (!id || !state.catalog.types?.[id]) return;
    state.docsNav.push(id);
    setTab("docs");
    paintDocs();
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
    const back = `<button class="btn" type="button" data-doc-back="1">返回</button>`;
    const crumbs = state.docsNav.map((item) => {
      const node = state.catalog.types[item];
      return node ? esc(node.fullName || node.name) : esc(item);
    }).join(`<span>/</span>`);
    const body = type.kind === "enum" ? enumTable(type) : `<div class="doc-card"><table>
      <thead><tr><th>#</th><th>类型</th><th>字段</th><th>说明</th></tr></thead>
      <tbody>${fieldRows(type.fields)}</tbody>
    </table></div>${nestedList(type)}`;
    els.docsView.innerHTML = `<div class="doc-page">
      <div class="doc-toolbar">${back}${sourceButton(type.path || type.file, type.line)}</div>
      <div class="doc-crumbs"><span>${esc(hit.pkg.name)}</span><span>/</span><span>${esc(hit.service.name)}</span><span>/</span><span>${esc(hit.rpc.name)}</span><span>/</span>${crumbs}</div>
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
    try { body = JSON.stringify(JSON.parse(body)); } catch { /* keep raw */ }
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
    for (const node of document.querySelectorAll(".view")) {
      node.classList.toggle("active", node.id === `view-${tab}`);
    }
    const messageTools = tab === "message";
    $("genMsgBtn").hidden = !messageTools;
    $("formatMsgBtn").hidden = !messageTools;
    $("clearMsgBtn").hidden = !messageTools;
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

  function persistEnvs() {
    const payload = { activeEnvId: state.activeEnvId, envs: state.envs };
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
        state.activeEnvId = data.activeEnvId || data.envs[0].id;
      }
    } catch {
      // ignore
    }
  }

  function applyBootstrap(data) {
    const prevSelected = state.selected?.id;
    if (data.catalog) state.catalog = data.catalog;
    if (data.envs && Array.isArray(data.envs.envs) && data.envs.envs.length) {
      state.envs = data.envs.envs;
      state.activeEnvId = data.envs.activeEnvId || state.envs[0].id;
    }
    if (data.source && typeof data.source === "object") {
      state.source = {
        mode: data.source.mode === "git" ? "git" : "workspace",
        gitUrl: data.source.gitUrl || "",
        gitBranch: data.source.gitBranch || "main",
        localPath: data.source.localPath || "",
        lastError: data.source.lastError || "",
      };
    }
    els.sourceMeta.textContent = state.catalog.sourceLabel || "ProtoView Client";
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
    const mode = document.querySelector('input[name="sourceMode"]:checked')?.value || "workspace";
    $("sourceGitFields")?.classList.toggle("hidden", mode !== "git");
  }

  function fillSourceModal() {
    const mode = state.source.mode === "git" ? "git" : "workspace";
    for (const input of document.querySelectorAll('input[name="sourceMode"]')) {
      input.checked = input.value === mode;
    }
    if ($("sourceGitUrl")) $("sourceGitUrl").value = state.source.gitUrl || "";
    if ($("sourceGitBranch")) $("sourceGitBranch").value = state.source.gitBranch || "main";
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
    const mode = document.querySelector('input[name="sourceMode"]:checked')?.value === "git" ? "git" : "workspace";
    const gitUrl = ($("sourceGitUrl")?.value || "").trim();
    const gitBranch = ($("sourceGitBranch")?.value || "main").trim() || "main";
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
    state.source = { ...state.source, mode, gitUrl, gitBranch, lastError: "" };
    closeModal(els.sourceModal);
    if (!vscode) {
      els.sourceMeta.textContent = mode === "git"
        ? `Git · ${gitBranch} · ${gitUrl}`
        : "工作区自动识别";
      setRespBadge("wait", "独立模式仅更新显示；请在扩展内打开 Client 才会真正拉取");
      return;
    }
    setRespBadge("wait", mode === "git" ? "正在应用 Git 来源…" : "正在切换到工作区…");
    vscode.postMessage({
      type: "setSource",
      payload: { mode, gitUrl, gitBranch },
    });
  }

  function openModal(el) { el.classList.add("show"); }
  function closeModal(el) { el.classList.remove("show"); }

  function pushHistory(entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, 30);
    els.historyView.textContent = state.history.map((item, i) =>
      `${i + 1}. ${item.time}  ${item.package ? `${item.package}.${item.service}/` : ""}${item.method}\n   ${item.host}\n`).join("\n") || "暂无历史";
  }

  // events
  initTheme();
  els.themeBtn.addEventListener("click", toggleTheme);
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
    if (vscode) vscode.postMessage({ type: "openSource", file, line });
    else setRespBadge("err", "独立浏览器模式无法打开 VS Code 源码");
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
    if (toggle) {
      const key = toggle.getAttribute("data-toggle");
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderTree();
      return;
    }
    const rpc = event.target.closest("[data-rpc]");
    if (rpc) selectRpc(rpc.getAttribute("data-rpc"));
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
  });
  $("formatMsgBtn").addEventListener("click", formatMessage);
  $("clearMsgBtn").addEventListener("click", () => {
    els.messageEditor.value = "{}";
    state.messageDirty = true;
  });
  els.messageEditor.addEventListener("input", () => { state.messageDirty = true; });
  $("clearRespBtn").addEventListener("click", () => {
    setRespBadge("", "");
    els.responseView.innerHTML = `<div class="resp-empty">选择接口，配置地址后发送。</div>`;
  });

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
  $("closeEnvModal").addEventListener("click", () => closeModal(els.envModal));
  els.envList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pick-env]");
    if (!btn) return;
    state.activeEnvId = btn.getAttribute("data-pick-env");
    renderEnvSelect();
  });
  $("addEnvBtn").addEventListener("click", () => {
    const id = `env_${Date.now().toString(36)}`;
    state.envs.push({ id, name: `env-${state.envs.length + 1}`, host: "", note: "" });
    state.activeEnvId = id;
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

  function showInvokeResult(data) {
    const kind = data.ok ? "ok" : "err";
    const timing = typeof data.ms === "number" ? ` · ${data.ms} ms` : "";
    setRespBadge(kind, `${data.status || (data.ok ? "OK" : "ERROR")}${timing}`);
    const parts = [`<div class="resp-line">${esc(data.method || "")}${data.host ? ` · ${esc(data.host)}` : ""}</div>`];
    if (data.error) parts.push(`<pre class="resp-error">${esc(data.error)}</pre>`);
    if (data.body !== undefined) parts.push(`<pre class="resp-json">${highlightJson(data.body)}</pre>`);
    els.responseView.innerHTML = `<div class="resp-block">${parts.join("")}</div>`;
  }

  els.sendBtn.addEventListener("click", () => {
    const rpc = state.selected;
    if (!rpc) return;
    const env = activeEnv();
    const host = els.address.value.trim() || env?.host || "";
    let body = {};
    try {
      body = JSON.parse(els.messageEditor.value || "{}");
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
    try { body = JSON.parse(els.messageEditor.value || "{}"); }
    catch (error) {
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
  $("ghzPath").addEventListener("change", () => {
    localStorage.setItem(GHZ_PATH_KEY, $("ghzPath").value.trim());
    refreshGhzCommand();
  });
  $("ghzPath").addEventListener("input", refreshGhzCommand);
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
      const id = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const host = partial?.host || els.address.value.trim() || activeEnv()?.host || "";
      const handler = (event) => {
        const data = event.data;
        if (!data || data.type !== "invokeResult" || data.id !== id) return;
        window.removeEventListener("message", handler);
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

  window.ProtoViewClient = {
    findRpc,
    getType(typeId) {
      if (!typeId) return undefined;
      return state.catalog.types?.[typeId];
    },
    sampleField(field) {
      try { return sampleValue(field); }
      catch { return ""; }
    },
    invokeOnce,
    postHost(type, payload) {
      if (!vscode) return false;
      vscode.postMessage(payload === undefined ? { type } : { type, payload });
      return true;
    },
    getSelectedRpcId: () => state.selected?.id || "",
    getSelectedRpcLabel: () => state.selected?.name || "",
    listEnvs: () => state.envs.map((env) => ({ id: env.id, name: env.name, host: env.host || "" })),
    getActiveEnvId: () => state.activeEnvId,
    resolveHost(envId) {
      const env = state.envs.find((item) => item.id === envId) || activeEnv();
      return env?.host || "";
    },
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "bootstrap") applyBootstrap(data);
    if (data.type === "invokeResult") {
      if (state.pendingInvoke && data.id && data.id !== state.pendingInvoke) return;
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
  });

  els.bulkModal.addEventListener("click", (event) => {
    if (event.target === els.bulkModal) closeModal(els.bulkModal);
  });
  els.envModal.addEventListener("click", (event) => {
    if (event.target === els.envModal) closeModal(els.envModal);
  });

  const ai = { tiles: [], selected: -1, solved: false, target: ["山", "海", "平", "爱"] };

  function openAi() {
    const overlay = $("aiOverlay");
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
    let ratio = typeof saved.ratio === "number" ? saved.ratio : 0.62;
    let reqCollapsed = Boolean(saved.reqCollapsed);
    let respCollapsed = Boolean(saved.respCollapsed);
    if (reqCollapsed && respCollapsed) respCollapsed = false;

    function persist() {
      saveSplitState({ ratio, reqCollapsed, respCollapsed });
    }

    function apply() {
      workspace.style.setProperty("--req-size", `${Math.round(ratio * 10000) / 100}%`);
      workspace.classList.toggle("req-collapsed", reqCollapsed);
      workspace.classList.toggle("resp-collapsed", respCollapsed);
      reqBtn.title = reqCollapsed ? "展开请求区" : "收起请求区";
      respBtn.title = respCollapsed ? "展开响应区" : "收起响应区";
      persist();
    }

    reqBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (reqCollapsed) {
        reqCollapsed = false;
      } else {
        reqCollapsed = true;
        if (respCollapsed) respCollapsed = false;
      }
      apply();
    });
    respBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (respCollapsed) {
        respCollapsed = false;
      } else {
        respCollapsed = true;
        if (reqCollapsed) reqCollapsed = false;
      }
      apply();
    });

    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      const rect = workspace.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const next = y / rect.height;
      ratio = Math.min(0.85, Math.max(0.18, next));
      if (reqCollapsed || respCollapsed) {
        reqCollapsed = false;
        respCollapsed = false;
      }
      apply();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      workspace.classList.remove("splitting");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      workspace.classList.add("splitting");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    $("splitBar").addEventListener("dblclick", () => {
      ratio = 0.62;
      reqCollapsed = false;
      respCollapsed = false;
      apply();
    });

    apply();
  }

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
