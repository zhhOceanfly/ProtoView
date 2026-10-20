(() => {
  const FLOW_KEY = "protoview.client.flow";
  const api = () => window.ProtoViewClient;
  const $ = (id) => document.getElementById(id);

  const flow = {
    nodes: [],
    edges: [],
    scale: 1,
    panX: 40,
    panY: 40,
    menuNodeId: null,
    editNodeId: null,
    historyNodeId: null,
    historySelectedId: null,
    running: false,
    stressing: false,
    stressAbort: false,
  };
  const HISTORY_LIMIT = 80;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(FLOW_KEY) || "{}");
      flow.nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node) => ({
        ...node,
        extracts: node.extracts && typeof node.extracts === "object" ? node.extracts : {},
        history: Array.isArray(node.history) ? node.history : [],
      }));
      flow.edges = Array.isArray(raw.edges) ? raw.edges : [];
      flow.scale = typeof raw.scale === "number" ? raw.scale : 1;
      flow.panX = typeof raw.panX === "number" ? raw.panX : 40;
      flow.panY = typeof raw.panY === "number" ? raw.panY : 40;
    } catch { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(FLOW_KEY, JSON.stringify({
        nodes: flow.nodes,
        edges: flow.edges,
        scale: flow.scale,
        panX: flow.panX,
        panY: flow.panY,
      }));
    } catch (error) {
      console.warn("flow save failed", error);
    }
  }

  function flowSnapshot() {
    return {
      version: 1,
      kind: "protoview.flow",
      exportedAt: new Date().toISOString(),
      nodes: flow.nodes.map((node) => ({
        id: node.id,
        rpcId: node.rpcId,
        name: node.name,
        package: node.package,
        x: node.x,
        y: node.y,
        message: node.message,
        metadata: Array.isArray(node.metadata) ? node.metadata : [{ name: "", value: "" }],
        extracts: node.extracts && typeof node.extracts === "object" ? node.extracts : {},
        protocol: node.protocol || "grpc",
        httpMethod: node.httpMethod || "POST",
        httpPath: node.httpPath || "/",
        envId: node.envId || "",
      })),
      edges: flow.edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
      })),
      scale: flow.scale,
      panX: flow.panX,
      panY: flow.panY,
    };
  }

  function exportFlow() {
    const snapshot = flowSnapshot();
    if (!snapshot.nodes.length) {
      void notify("画布为空，没有可导出的节点");
      return;
    }
    // VS Code webview：交给扩展保存对话框；CLI / 浏览器：直接下载 JSON
    if (api()?.isVsCodeHost?.() && api()?.postHost?.("exportFlow", snapshot)) return;
    downloadJson(snapshot, `protoview-flow-${flowStamp()}.json`);
    void notify("已导出链路配置");
  }

  function requestImportFlow() {
    if (api()?.isVsCodeHost?.() && api()?.postHost?.("importFlow")) return;
    pickJsonFile().then((data) => {
      if (data) importData(data);
    }).catch((error) => {
      void notify(`导入失败：${error.message || error}`);
    });
  }

  function downloadJson(data, filename) {
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickJsonFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(String(reader.result || "")));
          } catch (error) {
            reject(error);
          }
        };
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsText(file, "utf-8");
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function flowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function importData(raw) {
    void applyImport(raw);
  }

  async function applyImport(raw) {
    const parsed = normalizeImport(raw);
    if (!parsed.ok) {
      void notify(parsed.error);
      return;
    }
    if (flow.nodes.length) {
      const ok = await askConfirm(`导入将替换当前画布（${flow.nodes.length} 个节点）。继续？`);
      if (!ok) return;
    }
    flow.nodes = parsed.nodes;
    flow.edges = parsed.edges;
    flow.scale = parsed.scale;
    flow.panX = parsed.panX;
    flow.panY = parsed.panY;
    flow.menuNodeId = null;
    flow.editNodeId = null;
    flow.historyNodeId = null;
    flow.historySelectedId = null;
    hideMenu();
    save();
    render();
    applyTransform();
    void notify(`已导入 ${flow.nodes.length} 个节点、${flow.edges.length} 条连线`);
  }

  function normalizeImport(raw) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "导入失败：文件内容无效" };
    }
    if (raw.kind && raw.kind !== "protoview.flow") {
      return { ok: false, error: "导入失败：不是 ProtoView 链路配置文件" };
    }
    const nodesIn = Array.isArray(raw.nodes) ? raw.nodes : null;
    const edgesIn = Array.isArray(raw.edges) ? raw.edges : null;
    if (!nodesIn || !edgesIn) {
      return { ok: false, error: "导入失败：缺少 nodes / edges" };
    }
    const nodeIds = new Set();
    const nodes = [];
    for (const item of nodesIn) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "").trim() || uid("n");
      const rpcId = String(item.rpcId || "").trim();
      if (!rpcId) continue;
      nodeIds.add(id);
      nodes.push({
        id,
        rpcId,
        name: String(item.name || rpcId),
        package: String(item.package || ""),
        x: Number.isFinite(Number(item.x)) ? Number(item.x) : 40,
        y: Number.isFinite(Number(item.y)) ? Number(item.y) : 40,
        message: item.message && typeof item.message === "object" ? item.message : {},
        metadata: Array.isArray(item.metadata) && item.metadata.length
          ? item.metadata.map((row) => ({
            name: String(row?.name || ""),
            value: String(row?.value || ""),
          }))
          : [{ name: "", value: "" }],
        extracts: item.extracts && typeof item.extracts === "object" ? { ...item.extracts } : {},
        history: [],
        protocol: normalizeNodeProtocol(item.protocol),
        httpMethod: String(item.httpMethod || (item.protocol === "sse" ? "GET" : "POST")),
        httpPath: String(item.httpPath || "/"),
        envId: String(item.envId || ""),
        result: null,
      });
    }
    const edges = [];
    for (const item of edgesIn) {
      if (!item || typeof item !== "object") continue;
      const from = String(item.from || "");
      const to = String(item.to || "");
      if (!from || !to || from === to) continue;
      if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
      edges.push({
        id: String(item.id || "").trim() || uid("e"),
        from,
        to,
      });
    }
    return {
      ok: true,
      nodes,
      edges,
      scale: Number.isFinite(Number(raw.scale)) ? Math.min(2.5, Math.max(0.35, Number(raw.scale))) : 1,
      panX: Number.isFinite(Number(raw.panX)) ? Number(raw.panX) : 40,
      panY: Number.isFinite(Number(raw.panY)) ? Number(raw.panY) : 40,
    };
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isFlowOpen() {
    const main = $("mainFlow");
    return Boolean(main && !main.classList.contains("hidden"));
  }

  function openFlow() {
    const client = $("mainClient");
    const flowMain = $("mainFlow");
    client?.classList.add("hidden");
    flowMain?.classList.remove("hidden");
    if (flowMain) {
      flowMain.style.display = "flex";
      flowMain.style.flexDirection = "column";
      flowMain.style.height = "100%";
      flowMain.style.minHeight = "0";
    }
    const stage = $("flowStage");
    if (stage) {
      stage.style.flex = "1 1 auto";
      stage.style.minHeight = "240px";
      stage.style.position = "relative";
    }
    document.getElementById("app")?.classList.add("flow-mode");
    hideMenu();
    // next frame so layout has non-zero size before placing nodes
    requestAnimationFrame(() => render());
  }

  function closeFlow() {
    flow.stressAbort = true;
    closeStressDrawer();
    const flowMain = $("mainFlow");
    flowMain?.classList.add("hidden");
    if (flowMain) flowMain.style.display = "none";
    const client = $("mainClient");
    client?.classList.remove("hidden");
    if (client) client.style.display = "";
    document.getElementById("app")?.classList.remove("flow-mode");
    hideMenu();
  }

  function applyTransform() {
    const world = $("flowWorld");
    const edges = $("flowEdges");
    if (!world || !edges) return;
    const t = `translate(${flow.panX}px, ${flow.panY}px) scale(${flow.scale})`;
    world.style.transform = t;
    edges.style.transform = t;
  }

  function render() {
    const world = $("flowWorld");
    const svg = $("flowEdges");
    if (!world || !svg) return;
    const empty = $("flowEmpty");
    if (empty) empty.classList.toggle("hidden", flow.nodes.length > 0);
    world.innerHTML = flow.nodes.map((node) => {
      const hit = api()?.findRpc?.(node.rpcId);
      const title = hit ? hit.rpc.name : (node.name || node.rpcId || "未知接口");
      const proto = protocolLabel(node);
      const sub = `${proto} · ${hit ? `${hit.pkg.name}.${hit.service.name}` : (node.package || "")}`;
      const status = node.result?.ok === true ? "ok" : node.result?.ok === false ? "fail" : "";
      const badge = node.result
        ? `<div class="flow-node-result ${status}">${esc(node.result.status || "")} · ${node.result.ms ?? "-"}ms</div>`
        : `<div class="flow-node-result idle">未运行</div>`;
      return `<div class="flow-node ${status}" data-node="${esc(node.id)}" style="left:${node.x}px;top:${node.y}px">
        <div class="flow-node-head" data-drag="${esc(node.id)}">
          <div class="flow-node-icon">⇢</div>
          <div class="flow-node-text">
            <strong>${esc(title)}</strong>
            <span>${esc(sub)}</span>
          </div>
        </div>
        ${badge}
        <div class="flow-port in" data-port-in="${esc(node.id)}" title="连入"></div>
        <div class="flow-port out" data-port-out="${esc(node.id)}" title="连出"></div>
      </div>`;
    }).join("");

    const lines = flow.edges.map((edge) => {
      const from = flow.nodes.find((n) => n.id === edge.from);
      const to = flow.nodes.find((n) => n.id === edge.to);
      if (!from || !to) return "";
      const x1 = from.x + 200;
      const y1 = from.y + 36;
      const x2 = to.x;
      const y2 = to.y + 36;
      const cls = edge.status === "ok" ? "ok" : edge.status === "fail" ? "fail" : "";
      return `<path class="flow-edge ${cls}" data-edge="${esc(edge.id)}" d="M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}" />`;
    }).join("");
    svg.innerHTML = lines;
    svg.setAttribute("width", "4000");
    svg.setAttribute("height", "3000");
    applyTransform();
    save();
  }

  function canvasCenter() {
    const stage = $("flowStage");
    if (!stage) return { x: 120 + flow.nodes.length * 24, y: 100 + flow.nodes.length * 16 };
    const rect = stage.getBoundingClientRect();
    const midX = rect.left + rect.width * 0.35;
    const midY = rect.top + rect.height * 0.35;
    const pos = screenToWorld(midX, midY);
    return {
      x: pos.x - 100 + flow.nodes.length * 28,
      y: pos.y - 30 + flow.nodes.length * 20,
    };
  }

  function addNode(rpcId, x, y, label) {
    if (!rpcId) return false;
    try {
      if (!isFlowOpen()) openFlow();
      const hit = api()?.findRpc?.(rpcId);
      const message = {};
      if (hit) {
        for (const field of hit.rpc.requestFields || []) {
          try { message[field.name] = api()?.sampleField?.(field) ?? ""; }
          catch { message[field.name] = ""; }
        }
      }
      const place = () => {
        const center = canvasCenter();
        const nodeX = Number.isFinite(x) ? x : Math.max(40, center.x);
        const nodeY = Number.isFinite(y) ? y : Math.max(40, center.y);
        flow.nodes.push({
          id: uid("n"),
          rpcId,
          name: hit?.rpc.name || label || rpcId,
          package: hit ? `${hit.pkg.name}.${hit.service.name}` : "",
          x: nodeX,
          y: nodeY,
          message,
          metadata: [{ name: "", value: "" }],
          extracts: {},
          history: [],
          protocol: "grpc",
          httpMethod: hit?.rpc.httpVerb || "POST",
          httpPath: hit?.rpc.httpPath || "/",
          envId: api()?.getActiveEnvId?.() || "",
          result: null,
        });
        save();
        render();
      };
      // After openFlow, wait for layout so canvasCenter / stage size are valid
      requestAnimationFrame(place);
      return true;
    } catch (error) {
      console.error("addNode failed", error);
      void notify(`添加接口失败：${error.message || error}`);
      return false;
    }
  }

  function addSelected() {
    const id = api()?.getSelectedRpcId?.();
    const label = api()?.getSelectedRpcLabel?.() || id;
    if (!id) {
      void notify("请先在左侧选中一个接口");
      return;
    }
    addNode(id, undefined, undefined, label);
  }

  function hideMenu() {
    const menu = $("flowMenu");
    if (!menu) return;
    menu.classList.add("hidden");
    menu.style.display = "none";
    flow.menuNodeId = null;
  }

  /** VS Code webview 中 window.confirm / alert 常被禁用，需自建对话框 */
  function showDialog(message, { confirm = false } = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask show flow-confirm-mask";
      mask.innerHTML = `<div class="modal flow-confirm-modal">
        <div class="modal-head"><span>${confirm ? "确认" : "提示"}</span></div>
        <div class="modal-body"><p style="margin:0">${esc(message)}</p></div>
        <div class="modal-foot">
          ${confirm ? '<button class="btn" type="button" data-act="cancel">取消</button>' : ""}
          <button class="btn primary" type="button" data-act="ok">确定</button>
        </div>
      </div>`;
      const finish = (ok) => {
        mask.remove();
        resolve(ok);
      };
      mask.addEventListener("click", (event) => {
        if (event.target === mask) finish(false);
        const act = event.target.closest?.("[data-act]")?.getAttribute("data-act");
        if (act === "ok") finish(true);
        if (act === "cancel") finish(false);
      });
      document.body.appendChild(mask);
      mask.querySelector('[data-act="ok"]')?.focus();
    });
  }
  const askConfirm = (message) => showDialog(message, { confirm: true });
  const notify = (message) => showDialog(message, { confirm: false });

  function clearCanvas() {
    void askConfirm("清空链路画布？此操作不可撤销。").then((ok) => {
      if (!ok) return;
      flow.nodes = [];
      flow.edges = [];
      hideMenu();
      save();
      render();
    });
  }

  function showMenu(x, y, nodeId) {
    const menu = $("flowMenu");
    if (!menu) return;
    flow.menuNodeId = nodeId;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
    menu.classList.remove("hidden");
  }

  function getType(typeId) {
    return api()?.getType?.(typeId);
  }

  function pathAttr(path) {
    return esc(JSON.stringify(path));
  }

  function parsePath(raw) {
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  function setByPath(root, path, value) {
    if (!path?.length) return;
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i];
      const next = path[i + 1];
      if (typeof next === "number") {
        if (!Array.isArray(cursor[key])) cursor[key] = [];
      } else if (cursor[key] == null || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
  }

  function getByPath(root, path) {
    let cursor = root;
    for (const key of path) {
      if (cursor == null) return undefined;
      cursor = cursor[key];
    }
    return cursor;
  }

  function fieldTypeDef(field) {
    return field?.typeId ? getType(field.typeId) : undefined;
  }

  function isMessageField(field) {
    return fieldTypeDef(field)?.kind === "message";
  }

  function displayScalar(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function sampleItem(field) {
    try {
      return api()?.sampleField?.({ ...field, repeated: false }) ?? (isMessageField(field) ? {} : "");
    } catch {
      return isMessageField(field) ? {} : "";
    }
  }

  function typeLabel(field) {
    const prefix = field.repeated ? "repeated " : field.key ? "map " : "";
    if (field.key) return `${prefix}<${field.key}, ${field.type}>`;
    return `${prefix}${field.type || ""}`;
  }

  function renderFieldHead(field, extra = "") {
    const repClass = field.repeated ? " rep" : "";
    return `<div class="flow-msg-head">
      <span class="flow-msg-name">${esc(field.name)}</span>
      <span class="flow-msg-type${repClass}">${esc(typeLabel(field))}</span>
      ${field.comment ? `<span class="flow-msg-comment">${esc(field.comment)}</span>` : ""}
      ${extra}
    </div>`;
  }

  function renderScalarInput(field, value, path, opts = {}) {
    const typeDef = fieldTypeDef(field);
    const shown = displayScalar(value);
    const ro = opts.readonly ? " readonly" : "";
    const pathKey = opts.readonly ? "" : ` data-flow-msg-path="${pathAttr(path)}"`;
    const listId = `flow-enum-${opts.readonly ? "r-" : ""}${esc(path.join("-"))}`;
    if (typeDef?.kind === "enum" && Array.isArray(typeDef.values) && !opts.readonly) {
      const options = typeDef.values.map((item) => {
        const selected = String(item.number) === shown || item.name === shown ? " selected" : "";
        return `<option value="${esc(String(item.number))}"${selected}>${esc(item.name)} = ${item.number}</option>`;
      }).join("");
      return `<div class="flow-msg-row">
        <input list="${listId}"${pathKey} value="${esc(shown)}" placeholder="枚举值或 {{变量}}" />
        <datalist id="${listId}">${options}</datalist>
      </div>`;
    }
    return `<div class="flow-msg-row">
      <input${pathKey} value="${esc(shown)}" placeholder="${opts.readonly ? "" : "值或 {{变量}}"}"${ro} />
    </div>`;
  }

  function renderFields(fields, value, path = [], depth = 0, opts = {}) {
    if (!fields?.length) return `<div class="flow-msg-empty">无字段</div>`;
    if (depth > 8) return `<div class="flow-msg-empty">嵌套过深，已截断</div>`;
    return fields.map((field) => renderField(field, value?.[field.name], [...path, field.name], depth, opts)).join("");
  }

  function renderField(field, value, path, depth, opts = {}) {
    // map<K,V> → JSON 编辑
    if (field.key) {
      const text = value && typeof value === "object" && !Array.isArray(value)
        ? JSON.stringify(value, null, 2)
        : (typeof value === "string" ? value : "{}");
      const mapAttr = opts.readonly ? "" : ` data-flow-msg-map="${pathAttr(path)}"`;
      const ro = opts.readonly ? " readonly" : "";
      return `<div class="flow-msg-field">
        ${renderFieldHead(field)}
        <div class="flow-msg-row">
          <textarea${mapAttr} placeholder='{"key":"value"} 或使用 {{变量}}'${ro}>${esc(text)}</textarea>
        </div>
      </div>`;
    }

    if (field.repeated) {
      const items = Array.isArray(value) ? value : [];
      const itemField = { ...field, repeated: false };
      const rows = items.map((item, index) => {
        const itemPath = [...path, index];
        const body = isMessageField(itemField)
          ? `<div class="flow-msg-children">${renderFields(fieldTypeDef(itemField)?.fields || [], item && typeof item === "object" ? item : {}, itemPath, depth + 1, opts)}</div>`
          : renderScalarInput(itemField, item, itemPath, opts);
        return `<div class="flow-msg-rep-item">
          <div class="flow-msg-rep-bar">
            <strong>#${index + 1}</strong>
            ${opts.readonly ? "" : `<button class="link danger" type="button" data-flow-rep-del="${pathAttr(path)}" data-flow-rep-index="${index}">删除</button>`}
          </div>
          ${body}
        </div>`;
      }).join("");
      return `<div class="flow-msg-field flow-msg-repeated">
        ${renderFieldHead(field)}
        ${rows || `<div class="flow-msg-empty">${opts.readonly ? "无数据" : "暂无元素"}</div>`}
        ${opts.readonly ? "" : `<div class="flow-msg-actions">
          <button class="btn" type="button" data-flow-rep-add="${pathAttr(path)}">添加一项</button>
        </div>`}
      </div>`;
    }

    if (isMessageField(field)) {
      const typeDef = fieldTypeDef(field);
      const obj = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      return `<div class="flow-msg-field flow-msg-message">
        ${renderFieldHead(field)}
        <div class="flow-msg-children">${renderFields(typeDef?.fields || [], obj, path, depth + 1, opts)}</div>
      </div>`;
    }

    return `<div class="flow-msg-field">
      ${renderFieldHead(field)}
      ${renderScalarInput(field, value, path, opts)}
    </div>`;
  }

  function dottedPath(path) {
    return (path || []).join(".");
  }

  function valueAtDotted(body, pathKey) {
    if (!pathKey || body == null) return undefined;
    if (typeof body !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(body, pathKey)) return body[pathKey];
    const parts = String(pathKey).split(".");
    let cursor = body;
    for (const part of parts) {
      if (cursor == null || typeof cursor !== "object") return undefined;
      if (Object.prototype.hasOwnProperty.call(cursor, part)) {
        cursor = cursor[part];
        continue;
      }
      const hit = Object.keys(cursor).find((key) => key.toLowerCase() === part.toLowerCase());
      if (hit === undefined) return undefined;
      cursor = cursor[hit];
    }
    return cursor;
  }

  function pushHistory(node, entry) {
    if (!node) return;
    if (!Array.isArray(node.history)) node.history = [];
    node.history.unshift({
      id: uid("h"),
      at: Date.now(),
      ...entry,
    });
    if (node.history.length > HISTORY_LIMIT) node.history.length = HISTORY_LIMIT;
  }

  function formatHistoryTime(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts || "");
    }
  }

  function collectMessageFromDom(rootEl) {
    const message = {};
    if (!rootEl) return message;
    for (const input of rootEl.querySelectorAll("[data-flow-msg-path]")) {
      const path = parsePath(input.getAttribute("data-flow-msg-path"));
      if (!path) continue;
      setByPath(message, path, input.value);
    }
    for (const area of rootEl.querySelectorAll("[data-flow-msg-map]")) {
      const path = parsePath(area.getAttribute("data-flow-msg-map"));
      if (!path) continue;
      const raw = area.value.trim();
      if (!raw) {
        setByPath(message, path, {});
        continue;
      }
      if (raw.includes("{{")) {
        setByPath(message, path, raw);
        continue;
      }
      try { setByPath(message, path, JSON.parse(raw)); }
      catch { setByPath(message, path, raw); }
    }
    // Ensure repeated paths that only have structural items keep array shape
    for (const btn of rootEl.querySelectorAll("[data-flow-rep-add]")) {
      const path = parsePath(btn.getAttribute("data-flow-rep-add"));
      if (!path) continue;
      if (getByPath(message, path) === undefined) setByPath(message, path, []);
    }
    return message;
  }

  function syncEditMessage() {
    const node = flow.nodes.find((n) => n.id === flow.editNodeId);
    if (!node) return null;
    node.message = collectMessageFromDom($("flowMsgBody"));
    return node;
  }

  function renderFlowMessage(node, hit) {
    const el = $("flowMsgBody");
    if (!el) return;
    const fields = hit?.rpc?.requestFields || [];
    if (!fields.length) {
      el.innerHTML = `<div class="flow-msg-empty">无请求字段</div>`;
      return;
    }
    if (!node.message || typeof node.message !== "object" || Array.isArray(node.message)) {
      node.message = {};
    }
    el.innerHTML = renderFields(fields, node.message);
  }

  function renderExtractFields(fields, extracts, path = [], depth = 0) {
    if (!fields?.length) return `<div class="flow-msg-empty">无响应字段</div>`;
    if (depth > 8) return `<div class="flow-msg-empty">嵌套过深，已截断</div>`;
    return fields.map((field) => {
      const nextPath = [...path, field.name];
      const key = dottedPath(nextPath);
      const typeText = typeLabel(field);

      // message（非 repeated）→ 展开子字段，便于填 TokenInfo.AccessToken
      if (!field.repeated && !field.key && isMessageField(field)) {
        const typeDef = fieldTypeDef(field);
        return `<div class="flow-extract-msg">
          <div class="flow-extract-msg-head">
            <strong>${esc(field.name)}</strong>
            <span>${esc(typeText)}</span>
            ${field.comment ? `<span class="flow-msg-comment">${esc(field.comment)}</span>` : ""}
          </div>
          <div class="flow-extract-children">${renderExtractFields(typeDef?.fields || [], extracts, nextPath, depth + 1)}</div>
        </div>`;
      }

      return `<div class="flow-extract-row">
        <div>
          <div class="flow-extract-path">${esc(key)}</div>
          <span class="flow-extract-type">${esc(typeText)}${field.comment ? ` · ${esc(field.comment)}` : ""}</span>
        </div>
        <input data-flow-extract-path="${esc(key)}" value="${esc(extracts?.[key] || "")}" placeholder="变量名，如 token" />
      </div>`;
    }).join("");
  }

  function renderFlowExtract(node, hit) {
    const el = $("flowExtractBody");
    if (!el) return;
    if (!node.extracts || typeof node.extracts !== "object") node.extracts = {};
    const fields = hit?.rpc?.responseFields || [];
    el.innerHTML = fields.length
      ? renderExtractFields(fields, node.extracts)
      : `<div class="flow-msg-empty">无响应字段</div>`;
  }

  function normalizeNodeProtocol(value) {
    const p = (value || "grpc").toLowerCase();
    if (p === "http" || p === "sse" || p === "websocket") return p;
    return "grpc";
  }

  function protocolLabel(node) {
    const p = normalizeNodeProtocol(node.protocol);
    if (p === "http") return `HTTP ${node.httpMethod || "POST"}`;
    if (p === "sse") return `SSE ${node.httpMethod || "GET"}`;
    if (p === "websocket") return "WebSocket";
    return "gRPC";
  }

  function renderNodeTransport(node, hit) {
    const protocol = normalizeNodeProtocol(node.protocol);
    const protoEl = $("flowNodeProtocol");
    const methodEl = $("flowNodeHttpMethod");
    const pathEl = $("flowNodeHttpPath");
    const envEl = $("flowNodeEnv");
    if (protoEl) protoEl.value = protocol;
    if (methodEl) {
      methodEl.value = node.httpMethod
        || (protocol === "sse" ? "GET" : hit?.rpc.httpVerb || "POST");
    }
    if (pathEl) pathEl.value = node.httpPath || hit?.rpc.httpPath || "/";
    if (envEl) {
      const envs = api()?.listEnvs?.() || [];
      const selected = node.envId || api()?.getActiveEnvId?.() || "";
      envEl.innerHTML = envs.map((env) => `<option value="${esc(env.id)}"${env.id === selected ? " selected" : ""}>${esc(env.name)}</option>`).join("")
        || `<option value="">未配置环境</option>`;
      if (selected) envEl.value = selected;
    }
    syncNodeTransportUi();
  }

  function syncNodeTransportUi() {
    const protocol = normalizeNodeProtocol($("flowNodeProtocol")?.value);
    const needsMethod = protocol === "http" || protocol === "sse";
    const needsPath = protocol === "http" || protocol === "sse" || protocol === "websocket";
    $("flowNodeMethodWrap")?.classList.toggle("hidden", !needsMethod);
    $("flowNodePathWrap")?.classList.toggle("hidden", !needsPath);
  }

  function openEdit(nodeId) {
    const node = flow.nodes.find((n) => n.id === nodeId);
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    flow.editNodeId = nodeId;
    $("flowEditTitle").textContent = `编辑 · ${hit.rpc.name}`;
    renderNodeTransport(node, hit);
    renderFlowMessage(node, hit);
    renderFlowMeta(node);
    renderFlowExtract(node, hit);
    $("flowEditModal").classList.add("show");
  }

  function openHistory(nodeId) {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    flow.historyNodeId = nodeId;
    flow.historySelectedId = node.history?.[0]?.id || null;
    $("flowHistoryTitle").textContent = `响应历史 · ${node.name || "节点"}`;
    renderHistoryModal();
    $("flowHistoryModal")?.classList.add("show");
  }

  function renderHistoryModal() {
    const node = flow.nodes.find((n) => n.id === flow.historyNodeId);
    const list = $("flowHistoryList");
    const detail = $("flowHistoryDetail");
    if (!list || !detail) return;
    const items = Array.isArray(node?.history) ? node.history : [];
    if (!items.length) {
      list.innerHTML = `<div class="flow-msg-empty" style="padding:12px">暂无运行/压测记录</div>`;
      detail.textContent = "运行链路或压测后，可在此查看该节点的响应历史。";
      return;
    }
    if (!flow.historySelectedId || !items.some((item) => item.id === flow.historySelectedId)) {
      flow.historySelectedId = items[0].id;
    }
    list.innerHTML = items.map((item) => {
      const okClass = item.ok ? "ok" : "fail";
      const kind = item.kind === "stress" ? "压测" : "运行";
      return `<button type="button" class="flow-history-item${item.id === flow.historySelectedId ? " active" : ""}" data-history-id="${esc(item.id)}">
        <div class="h-top ${okClass}"><span>${esc(item.status || (item.ok ? "OK" : "FAIL"))}</span><span>${item.ms ?? "-"}ms</span></div>
        <div class="h-meta">${esc(kind)} · ${esc(formatHistoryTime(item.at))}</div>
      </button>`;
    }).join("");
    const selected = items.find((item) => item.id === flow.historySelectedId) || items[0];
    const payload = {
      ok: selected.ok,
      status: selected.status,
      ms: selected.ms,
      error: selected.error || undefined,
      kind: selected.kind,
      at: formatHistoryTime(selected.at),
      body: selected.body ?? null,
    };
    detail.textContent = JSON.stringify(payload, null, 2);
  }

  function renderFlowMeta(node) {
    if (!node.metadata?.length) node.metadata = [{ name: "", value: "" }];
    $("flowMetaBody").innerHTML = node.metadata.map((row, index) => `<tr>
      <td><input data-flow-meta-name="${index}" value="${esc(row.name)}" placeholder="authorization" /></td>
      <td><input data-flow-meta-value="${index}" value="${esc(row.value)}" placeholder="Bearer {{token}}" /></td>
      <td><button class="link danger" type="button" data-flow-meta-del="${index}">删除</button></td>
    </tr>`).join("");
  }

  function saveEdit() {
    const node = syncEditMessage();
    if (!node) return;
    const metadata = [];
    for (const input of document.querySelectorAll("[data-flow-meta-name]")) {
      const index = Number(input.getAttribute("data-flow-meta-name"));
      const value = document.querySelector(`[data-flow-meta-value="${index}"]`)?.value || "";
      metadata.push({ name: input.value, value });
    }
    node.metadata = metadata.length ? metadata : [{ name: "", value: "" }];
    const extracts = {};
    for (const input of document.querySelectorAll("[data-flow-extract-path]")) {
      const key = input.getAttribute("data-flow-extract-path");
      const val = input.value.trim();
      if (key && val) extracts[key] = val;
    }
    node.extracts = extracts;
    node.protocol = normalizeNodeProtocol($("flowNodeProtocol")?.value);
    node.httpMethod = $("flowNodeHttpMethod")?.value || (node.protocol === "sse" ? "GET" : "POST");
    node.httpPath = $("flowNodeHttpPath")?.value || "/";
    node.envId = $("flowNodeEnv")?.value || node.envId || "";
    $("flowEditModal").classList.remove("show");
    flow.editNodeId = null;
    save();
    render();
  }

  function handleMsgTreeClick(event) {
    const addBtn = event.target.closest("[data-flow-rep-add]");
    const delBtn = event.target.closest("[data-flow-rep-del]");
    if (!addBtn && !delBtn) return;
    const node = syncEditMessage();
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;

    if (addBtn) {
      const path = parsePath(addBtn.getAttribute("data-flow-rep-add"));
      if (!path) return;
      const field = fieldAtPath(hit.rpc.requestFields || [], path);
      let list = getByPath(node.message, path);
      if (!Array.isArray(list)) {
        list = [];
        setByPath(node.message, path, list);
      }
      list.push(field ? sampleItem(field) : "");
      renderFlowMessage(node, hit);
      return;
    }

    if (delBtn) {
      const path = parsePath(delBtn.getAttribute("data-flow-rep-del"));
      const index = Number(delBtn.getAttribute("data-flow-rep-index"));
      if (!path || !Number.isFinite(index)) return;
      const list = getByPath(node.message, path);
      if (!Array.isArray(list)) return;
      list.splice(index, 1);
      renderFlowMessage(node, hit);
    }
  }

  /** path points to a repeated/map field (ends with field name, not index) */
  function fieldAtPath(fields, path) {
    let currentFields = fields;
    let field = null;
    for (let i = 0; i < path.length; i += 1) {
      const key = path[i];
      if (typeof key === "number") {
        const typeDef = field ? fieldTypeDef(field) : null;
        currentFields = typeDef?.kind === "message" ? (typeDef.fields || []) : [];
        continue;
      }
      field = (currentFields || []).find((f) => f.name === key) || null;
      if (!field) return null;
      if (i < path.length - 1 && typeof path[i + 1] === "string") {
        const typeDef = fieldTypeDef(field);
        currentFields = typeDef?.kind === "message" ? (typeDef.fields || []) : [];
      }
    }
    return field;
  }

  function interpolate(text, vars) {
    return String(text ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
      const value = vars[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function coerceScalar(filled) {
    if (filled.includes("{{")) return filled;
    if (/^-?\d+(\.\d+)?$/.test(filled)) return Number(filled);
    if (filled === "true" || filled === "false") return filled === "true";
    return filled;
  }

  function buildBody(value, vars) {
    if (typeof value === "string") return coerceScalar(interpolate(value, vars));
    if (Array.isArray(value)) return value.map((item) => buildBody(item, vars));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = buildBody(child, vars);
      }
      return out;
    }
    return value;
  }

  function topoSort() {
    const indeg = new Map(flow.nodes.map((n) => [n.id, 0]));
    const outs = new Map(flow.nodes.map((n) => [n.id, []]));
    for (const edge of flow.edges) {
      if (!indeg.has(edge.from) || !indeg.has(edge.to)) continue;
      indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
      outs.get(edge.from).push(edge.to);
    }
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of outs.get(id) || []) {
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== flow.nodes.length) return null;
    return order;
  }

  async function executeFlowOnce({ quiet = false, kind = "run" } = {}) {
    const client = api();
    if (!client?.invokeOnce) {
      return { ok: false, ms: 0, error: "请在 VS Code ProtoView Client 中运行" };
    }
    if (!flow.nodes.length) {
      return { ok: false, ms: 0, error: "画布为空，请先添加接口" };
    }
    const order = topoSort();
    if (!order) {
      return { ok: false, ms: 0, error: "存在环路，请先去掉循环连线" };
    }

    if (!quiet) {
      for (const edge of flow.edges) edge.status = "idle";
      for (const node of flow.nodes) node.result = null;
      render();
    }

    const started = performance.now();
    const vars = {};
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const nodeId of order) {
      if (flow.stressAbort) {
        return { ok: false, ms: Math.round(performance.now() - started), error: "已停止", cancelled: true };
      }
      const node = byId.get(nodeId);
      const hit = client.findRpc(node.rpcId);
      if (!hit) continue;
      const incoming = flow.edges.filter((e) => e.to === nodeId);
      const metadata = {};
      for (const row of node.metadata || []) {
        const name = (row.name || "").trim();
        if (!name) continue;
        metadata[name] = interpolate(row.value, vars);
      }
      const protocol = normalizeNodeProtocol(node.protocol);
      const result = await client.invokeOnce({
        protocol,
        httpMethod: node.httpMethod || (protocol === "sse" ? "GET" : hit.rpc.httpVerb || "POST"),
        httpPath: interpolate(node.httpPath || hit.rpc.httpPath || "/", vars),
        host: client.resolveHost?.(node.envId) || "",
        package: hit.pkg.name,
        service: hit.service.name,
        method: hit.rpc.name,
        file: hit.rpc.file,
        body: buildBody(node.message, vars),
        metadata,
        tls: false,
      });
      node.result = {
        ok: result.ok,
        status: result.status,
        ms: result.ms,
        error: result.error,
        body: result.body,
      };
      pushHistory(node, {
        kind,
        ok: result.ok,
        status: result.status,
        ms: result.ms,
        error: result.error,
        body: result.body ?? null,
      });
      for (const edge of incoming) edge.status = result.ok ? "ok" : "fail";
      if (result.ok && result.body && typeof result.body === "object") {
        for (const [pathKey, varName] of Object.entries(node.extracts || {})) {
          if (!varName) continue;
          const val = valueAtDotted(result.body, pathKey);
          if (val !== undefined) vars[varName] = val;
        }
      }
      if (!quiet) render();
      if (!result.ok) {
        if (!quiet) {
          for (const edge of flow.edges.filter((e) => e.from === nodeId)) edge.status = "fail";
          render();
        }
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          error: result.error || result.status || "调用失败",
          failNode: node.name || hit.rpc.name,
        };
      }
    }
    return { ok: true, ms: Math.round(performance.now() - started) };
  }

  async function runFlow() {
    if (flow.running || flow.stressing) return;
    const client = api();
    if (!client?.invokeOnce) {
      void notify("请在 VS Code ProtoView Client 中运行链路调试");
      return;
    }
    flow.running = true;
    flow.stressAbort = false;
    $("flowRunBtn").disabled = true;
    $("flowStressBtn").disabled = true;
    const summary = await executeFlowOnce({ quiet: false });
    if (!summary.ok && summary.error && !summary.failNode) void notify(summary.error);
    flow.running = false;
    $("flowRunBtn").disabled = false;
    $("flowStressBtn").disabled = false;
    save();
  }

  function openStressDrawer() {
    const mask = $("flowStressDrawer");
    if (!mask) return;
    mask.classList.add("show");
  }

  function closeStressDrawer() {
    const mask = $("flowStressDrawer");
    if (!mask) return;
    mask.classList.remove("show");
  }

  function setStressUiRunning(running) {
    flow.stressing = running;
    $("flowStressStartBtn") && ($("flowStressStartBtn").disabled = running);
    $("flowStressStopBtn") && ($("flowStressStopBtn").disabled = !running);
    $("flowRunBtn") && ($("flowRunBtn").disabled = running);
    $("flowStressBtn") && ($("flowStressBtn").disabled = running);
  }

  function updateStressProgress(done, total, ok, fail) {
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar = $("flowStressProgressBar");
    if (bar) bar.style.width = `${pct}%`;
    const text = $("flowStressProgressText");
    if (text) text.textContent = `${done}/${total} · 成功 ${ok} · 失败 ${fail}`;
  }

  async function runFlowStress() {
    if (flow.running || flow.stressing) return;
    if (!flow.nodes.length) {
      void notify("画布为空，请先添加接口");
      return;
    }
    if (!topoSort()) {
      void notify("存在环路，请先去掉循环连线");
      return;
    }
    const concurrency = Math.min(5, Math.max(1, Number($("flowStressConcurrency")?.value || 1)));
    const total = Math.min(100, Math.max(1, Number($("flowStressTotal")?.value || 1)));
    if ($("flowStressConcurrency")) $("flowStressConcurrency").value = String(concurrency);
    if ($("flowStressTotal")) $("flowStressTotal").value = String(total);

    flow.stressAbort = false;
    setStressUiRunning(true);
    updateStressProgress(0, total, 0, 0);
    const resultEl = $("flowStressResult");
    if (resultEl) resultEl.innerHTML = `<div class="stress-empty">压测进行中…</div>`;

    let next = 0;
    let done = 0;
    let ok = 0;
    let fail = 0;
    const samples = [];
    const started = Date.now();

    async function worker() {
      while (!flow.stressAbort) {
        const index = next;
        next += 1;
        if (index >= total) break;
        const one = await executeFlowOnce({ quiet: true, kind: "stress" });
        done += 1;
        if (one.ok) ok += 1;
        else fail += 1;
        if (samples.length < 50) {
          samples.push({
            i: index + 1,
            ok: one.ok,
            ms: one.ms,
            status: one.ok ? "OK" : (one.error || "FAIL"),
          });
        }
        updateStressProgress(done, total, ok, fail);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    render();
    save();

    const elapsed = Math.max(1, Date.now() - started);
    const rps = (done / (elapsed / 1000)).toFixed(2);
    const cancelled = flow.stressAbort;
    setStressUiRunning(false);
    flow.stressAbort = false;

    if (resultEl) {
      const stats = [
        ["完成", done],
        ["成功", ok],
        ["失败", fail],
        ["RPS", rps],
        ["耗时", `${elapsed}ms`],
      ].map(([label, value]) => `<div class="stress-stat"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`).join("");
      const rows = samples.map((item) => `<tr>
        <td>#${item.i}</td>
        <td class="${item.ok ? "stress-ok" : "stress-fail"}">${esc(item.status)}</td>
        <td>${item.ms}ms</td>
      </tr>`).join("");
      resultEl.innerHTML = `
        <div class="stress-stats">${stats}</div>
        ${cancelled ? `<p class="stress-note">已停止，以下为已完成样本。</p>` : ""}
        <table class="stress-samples">
          <thead><tr><th>序号</th><th>状态</th><th>耗时</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="3">无样本</td></tr>`}</tbody>
        </table>
      `;
    }
  }

  function screenToWorld(clientX, clientY) {
    const el = $("flowStage");
    if (!el) return { x: 80, y: 80 };
    const stage = el.getBoundingClientRect();
    return {
      x: (clientX - stage.left - flow.panX) / flow.scale,
      y: (clientY - stage.top - flow.panY) / flow.scale,
    };
  }

  function addAtScreen(rpcId, clientX, clientY, label) {
    if (!rpcId) return false;
    if (!isFlowOpen()) openFlow();
    // Defer so #flowStage has real size after openFlow layout
    requestAnimationFrame(() => {
      const pos = screenToWorld(clientX, clientY);
      addNode(rpcId, pos.x - 100, pos.y - 36, label);
    });
    return true;
  }

  // Expose early so app.js drag-drop can call even if later bind steps fail
  window.ProtoViewFlow = { addNode, addSelected, openFlow, isFlowOpen, addAtScreen, render, importData };

  function bind() {
    load();
    hideMenu();
    $("flowBtn")?.addEventListener("click", openFlow);
    $("flowCloseBtn")?.addEventListener("click", closeFlow);
    $("flowAddSelectedBtn")?.addEventListener("click", addSelected);
    $("flowClearBtn")?.addEventListener("click", clearCanvas);
    $("flowRunBtn")?.addEventListener("click", () => void runFlow());
    $("flowStressBtn")?.addEventListener("click", openStressDrawer);
    $("flowExportBtn")?.addEventListener("click", exportFlow);
    $("flowImportBtn")?.addEventListener("click", requestImportFlow);
    $("flowStressClose")?.addEventListener("click", closeStressDrawer);
    $("flowStressDrawer")?.addEventListener("click", (event) => {
      if (event.target === $("flowStressDrawer")) closeStressDrawer();
    });
    $("flowStressStartBtn")?.addEventListener("click", () => void runFlowStress());
    $("flowStressStopBtn")?.addEventListener("click", () => { flow.stressAbort = true; });
    $("flowStressConcurrency")?.addEventListener("change", () => {
      const n = Math.min(5, Math.max(1, Number($("flowStressConcurrency").value || 1)));
      $("flowStressConcurrency").value = String(n);
    });
    $("flowStressTotal")?.addEventListener("change", () => {
      const n = Math.min(100, Math.max(1, Number($("flowStressTotal").value || 1)));
      $("flowStressTotal").value = String(n);
    });
    window.addEventListener("protoview-flow-add", (event) => {
      const { rpcId, label, clientX, clientY } = event.detail || {};
      if (!rpcId) return;
      if (!isFlowOpen()) openFlow();
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        addAtScreen(rpcId, clientX, clientY, label);
      } else {
        addNode(rpcId, undefined, undefined, label);
      }
    });
    $("closeFlowEdit")?.addEventListener("click", () => $("flowEditModal").classList.remove("show"));
    $("saveFlowEditBtn")?.addEventListener("click", saveEdit);
    $("flowNodeProtocol")?.addEventListener("change", syncNodeTransportUi);
    $("flowMsgBody")?.addEventListener("click", handleMsgTreeClick);
    $("flowAddMetaBtn")?.addEventListener("click", () => {
      const node = flow.nodes.find((n) => n.id === flow.editNodeId);
      if (!node) return;
      node.metadata = node.metadata || [];
      node.metadata.push({ name: "", value: "" });
      renderFlowMeta(node);
    });
    $("flowMetaBody")?.addEventListener("click", (event) => {
      const del = event.target.closest("[data-flow-meta-del]");
      if (!del) return;
      const node = flow.nodes.find((n) => n.id === flow.editNodeId);
      if (!node) return;
      node.metadata.splice(Number(del.getAttribute("data-flow-meta-del")), 1);
      renderFlowMeta(node);
    });

    $("flowMenu")?.addEventListener("click", (event) => {
      const act = event.target.closest("[data-flow-act]")?.getAttribute("data-flow-act");
      const nodeId = flow.menuNodeId;
      hideMenu();
      if (!nodeId || !act) return;
      if (act === "edit") openEdit(nodeId);
      if (act === "view-resp") openHistory(nodeId);
      if (act === "delete") {
        flow.nodes = flow.nodes.filter((n) => n.id !== nodeId);
        flow.edges = flow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
        save();
        render();
      }
    });
    $("closeFlowHistory")?.addEventListener("click", () => {
      $("flowHistoryModal")?.classList.remove("show");
      flow.historyNodeId = null;
      flow.historySelectedId = null;
    });
    $("flowHistoryList")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-history-id]");
      if (!btn) return;
      flow.historySelectedId = btn.getAttribute("data-history-id");
      renderHistoryModal();
    });

    const stage = $("flowStage");
    if (!stage) {
      console.warn("ProtoView flow: #flowStage not found");
      return;
    }

    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const delta = event.deltaY > 0 ? 0.9 : 1.1;
      const next = Math.min(2.2, Math.max(0.35, flow.scale * delta));
      const rect = stage.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      flow.panX = mx - ((mx - flow.panX) / flow.scale) * next;
      flow.panY = my - ((my - flow.panY) / flow.scale) * next;
      flow.scale = next;
      applyTransform();
      save();
    }, { passive: false });

    let panning = false;
    let panOrigin = null;
    stage.addEventListener("pointerdown", (event) => {
      const onBlank = event.target === stage || event.target.id === "flowEdges" || event.target.classList?.contains("flow-edges");
      if (event.button === 1 || event.altKey || onBlank) {
        panning = true;
        panOrigin = { x: event.clientX - flow.panX, y: event.clientY - flow.panY };
        stage.setPointerCapture(event.pointerId);
      }
    });
    stage.addEventListener("pointermove", (event) => {
      if (!panning || !panOrigin) return;
      flow.panX = event.clientX - panOrigin.x;
      flow.panY = event.clientY - panOrigin.y;
      applyTransform();
    });
    stage.addEventListener("pointerup", () => {
      if (panning) save();
      panning = false;
      panOrigin = null;
    });

    stage.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    stage.addEventListener("drop", (event) => {
      event.preventDefault();
      let rpcId = event.dataTransfer.getData("text/plain");
      let label = "";
      try {
        const packed = JSON.parse(event.dataTransfer.getData("application/x-protoview-rpc") || "null");
        if (packed?.id) {
          rpcId = packed.id;
          label = packed.label || "";
        }
      } catch { /* ignore */ }
      if (!rpcId) return;
      const pos = screenToWorld(event.clientX, event.clientY);
      addNode(rpcId, pos.x - 100, pos.y - 30, label);
    });

    let dragNode = null;
    let dragOffset = null;
    let linkFrom = null;

    stage.addEventListener("pointerdown", (event) => {
      const out = event.target.closest("[data-port-out]");
      if (out) {
        linkFrom = out.getAttribute("data-port-out");
        event.stopPropagation();
        return;
      }
      const head = event.target.closest("[data-drag]");
      if (head && event.button === 0) {
        const id = head.getAttribute("data-drag");
        const node = flow.nodes.find((n) => n.id === id);
        if (!node) return;
        dragNode = node;
        const pos = screenToWorld(event.clientX, event.clientY);
        dragOffset = { x: pos.x - node.x, y: pos.y - node.y };
        stage.setPointerCapture(event.pointerId);
        event.stopPropagation();
      }
    });
    stage.addEventListener("pointermove", (event) => {
      if (dragNode && dragOffset) {
        const pos = screenToWorld(event.clientX, event.clientY);
        dragNode.x = pos.x - dragOffset.x;
        dragNode.y = pos.y - dragOffset.y;
        render();
      }
    });
    stage.addEventListener("pointerup", (event) => {
      if (linkFrom) {
        const inn = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-port-in]");
        const to = inn?.getAttribute("data-port-in");
        if (to && to !== linkFrom && !flow.edges.some((e) => e.from === linkFrom && e.to === to)) {
          flow.edges.push({ id: uid("e"), from: linkFrom, to, status: "idle" });
          render();
        }
        linkFrom = null;
      }
      if (dragNode) {
        dragNode = null;
        dragOffset = null;
        save();
      }
    });

    stage.addEventListener("contextmenu", (event) => {
      const nodeEl = event.target.closest("[data-node]");
      if (!nodeEl) {
        hideMenu();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, nodeEl.getAttribute("data-node"));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#flowMenu")) hideMenu();
    });

    hideMenu();
    render();
    window.ProtoViewFlow = { addNode, addSelected, openFlow, isFlowOpen, addAtScreen, render, importData };
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "flowImportData") importData(data.payload);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
