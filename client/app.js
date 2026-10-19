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
    metaBody: $("metaBody"),
    docsView: $("docsView"),
    historyView: $("historyView"),
    responseView: $("responseView"),
    sendBtn: $("sendBtn"),
    toolbar: $("toolbar"),
    toolbarHint: $("toolbarHint"),
    themeBtn: $("themeBtn"),
    envName: $("envName"),
    envHost: $("envHost"),
    envNote: $("envNote"),
    envList: $("envList"),
    envModal: $("envModal"),
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

  function renderEnvSelect() {
    els.envSelect.innerHTML = state.envs
      .map((env) => `<option value="${esc(env.id)}"${env.id === state.activeEnvId ? " selected" : ""}>${esc(env.name)}</option>`)
      .join("");
    const env = activeEnv();
    if (env && document.activeElement !== els.address) els.address.value = env.host || "";
    fillEnvForm();
    renderEnvList();
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
            <button class="node-row${active}" type="button" data-rpc="${esc(rpc.id)}">
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
    } else {
      els.messageEditor.value = generateMessage(rpc);
      state.metadata = [{ name: "", value: "", description: "" }];
      state.auth = defaultAuth();
    }
    state.messageDirty = false;
    state.docsNav = [];
    renderMetadata();
    renderAuth();
    paintDocs();
    renderTree();
    setTab(state.tab);
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
      ? "根据请求 message 字段生成 / 格式化 JSON"
      : tab === "metadata"
        ? "表格编辑 metadata，支持 Bulk Edit"
        : tab === "auth"
          ? "鉴权写入 Metadata；与表格同名键时以 Auth 为准"
          : "";
    if (tab === "auth") renderAuth();
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
  $("aiMusicBtn").addEventListener("click", toggleAiMusic);
  $("refreshBtn").addEventListener("click", () => {
    if (vscode) vscode.postMessage({ type: "refresh" });
    else location.reload();
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
  els.envSelect.addEventListener("change", () => {
    state.activeEnvId = els.envSelect.value;
    const env = activeEnv();
    els.address.value = env?.host || "";
    fillEnvForm();
    persistEnvs();
  });
  els.address.addEventListener("change", () => {
    const env = activeEnv();
    if (!env) return;
    env.host = els.address.value.trim();
    fillEnvForm();
    persistEnvs();
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
      const file = src.getAttribute("data-src");
      const line = Number(src.getAttribute("data-line") || 1);
      if (vscode) vscode.postMessage({ type: "openSource", file, line });
      else setRespBadge("err", "独立浏览器模式无法打开 VS Code 源码");
      return;
    }
    const link = event.target.closest("[data-type]");
    if (link) openType(link.getAttribute("data-type"));
  });
  els.tree.addEventListener("click", (event) => {
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
    const payload = {
      id: String(Date.now()),
      time: new Date().toLocaleString(),
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
    els.responseView.innerHTML = `<div class="resp-empty">正在请求 ${esc(host || "(未配置)")} · ${esc(rpc.package)}.${esc(rpc.service)}/${esc(rpc.name)}</div>`;
    vscode.postMessage({ type: "invoke", payload });
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "bootstrap") applyBootstrap(data);
    if (data.type === "invokeResult") {
      if (state.pendingInvoke && data.id && data.id !== state.pendingInvoke) return;
      showInvokeResult(data);
    }
  });

  els.bulkModal.addEventListener("click", (event) => {
    if (event.target === els.bulkModal) closeModal(els.bulkModal);
  });
  els.envModal.addEventListener("click", (event) => {
    if (event.target === els.envModal) closeModal(els.envModal);
  });

  const ai = { tiles: [], selected: -1, solved: false, target: ["山", "海", "平", "爱"], music: null };

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
    if (!ai.music) startAiMusic();
  }

  function closeAi() {
    $("aiOverlay").classList.remove("show");
    stopAiMusic();
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

  function toggleAiMusic() {
    if (ai.music?.playing) stopAiMusic();
    else startAiMusic();
  }

  function startAiMusic() {
    stopAiMusic();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 0.08;
    master.connect(ctx.destination);
    const styles = [playPad, playPluck];
    const style = styles[Math.floor(Math.random() * styles.length)];
    let timer = null;
    let playing = true;
    function tone(freq, when, dur, type, gain) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(gain, when + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(when);
      osc.stop(when + dur + 0.02);
    }
    function playPad() {
      const roots = [196, 233, 262, 311];
      const root = roots[Math.floor(Math.random() * roots.length)];
      const now = ctx.currentTime;
      [0, 4, 7, 12].forEach((semi, i) => tone(root * Math.pow(2, semi / 12), now + i * 0.08, 2.4, "sine", 0.05));
    }
    function playPluck() {
      const scale = [262, 294, 330, 349, 392, 440];
      const now = ctx.currentTime;
      for (let i = 0; i < 4; i++) tone(scale[(i * 2 + Math.floor(Math.random() * 2)) % scale.length], now + i * 0.28, 0.45, "triangle", 0.06);
    }
    if (ctx.state === "suspended") ctx.resume();
    style();
    timer = setInterval(style, 2200);
    $("aiMusicBtn").textContent = "音乐开";
    ai.music = {
      get playing() { return playing; },
      stop() {
        playing = false;
        if (timer) clearInterval(timer);
        try { ctx.close(); } catch { /* ignore */ }
      },
    };
  }

  function stopAiMusic() {
    if (ai.music) ai.music.stop();
    ai.music = null;
    const btn = $("aiMusicBtn");
    if (btn) btn.textContent = "音乐";
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
  initSplitLayout();

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
