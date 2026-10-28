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
    edgeMenuId: null,
    /** 选中的连线 id（点击选中，右键删除） */
    selectedEdgeId: null,
    /** 正在从 out 端口拉出的连线：{ from, x, y } 世界坐标 */
    link: null,
    editNodeId: null,
    historyNodeId: null,
    historySelectedId: null,
    historyFollowLive: true,
    sendNodeId: null,
    /** 收发消息弹窗里选中的发送任务 */
    sendTaskId: null,
    /** 最近一次发送使用的任务（收到的回包按它的解析/变量配置处理） */
    activeTaskId: null,
    sendMessage: null,
    recvDecodedCache: null,
    /** 点击发送后捕获的回包：{ nodeId, items[], frozen }，满 3 条后不再更新 */
    recvCapture: null,
    /** 全量「运行链路」进行中 */
    flowRunning: false,
    /** 正在单步/链路执行的起始步骤 id → true */
    stepRunning: Object.create(null),
    /** 跨步骤共享变量（提取结果累积，便于步骤二单独跑时用步骤一的 token） */
    sharedVars: {},
    /** 变量查看弹窗对应的起始步骤 id */
    varsStepId: null,
    /** 当前正在执行的起始步骤 id（用于把提取到的变量归到该步骤） */
    varOwnerStepId: null,
    /** 撤销/恢复栈（快照 JSON） */
    undo: [],
    redo: [],
    /** 步骤压测 */
    stressStepId: null,
    stressMode: "light",
    ghzId: "",
    ghzLog: "",
    stressAbort: false,
  };
  const HISTORY_LIMIT = 80;
  const FLOAT_TOOLS_KEY = "protoview.client.flow.tools";
  const UNDO_LIMIT = 40;
  /** 上一次提交后的画布快照（用于撤销对比） */
  let lastSnapshot = "";

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(FLOW_KEY) || "{}");
      flow.nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node) => normalizeNode(node)).filter(Boolean);
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

  // ===== 撤销 / 恢复 =====

  /** 只对比「节点 + 连线」，画布平移缩放不算一次编辑 */
  function flowEditSnapshot() {
    return JSON.stringify({
      nodes: flow.nodes.map((node) => serializeNode(node)),
      edges: flow.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })),
    });
  }

  function updateUndoButtons() {
    const undoBtn = $("flowUndoBtn");
    const redoBtn = $("flowRedoBtn");
    if (undoBtn) undoBtn.disabled = !flow.undo.length;
    if (redoBtn) redoBtn.disabled = !flow.redo.length;
  }

  function resetUndo() {
    flow.undo = [];
    flow.redo = [];
    lastSnapshot = flowEditSnapshot();
    updateUndoButtons();
  }

  /** 编辑提交：内容有变化才压栈，再持久化 */
  function commit() {
    const snap = flowEditSnapshot();
    if (lastSnapshot && snap !== lastSnapshot) {
      flow.undo.push(lastSnapshot);
      if (flow.undo.length > UNDO_LIMIT) flow.undo.shift();
      flow.redo = [];
    }
    lastSnapshot = snap;
    save();
    updateUndoButtons();
  }

  function applyEditSnapshot(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    flow.nodes = (raw.nodes || []).map((node) => normalizeNode(node)).filter(Boolean);
    flow.edges = Array.isArray(raw.edges) ? raw.edges : [];
    flow.selectedEdgeId = null;
    flow.link = null;
    flow.stepRunning = Object.create(null);
    flow.varsStepId = flow.nodes.some((n) => n.id === flow.varsStepId) ? flow.varsStepId : null;
    hideMenu();
    hideEdgeMenu();
    render();
  }

  function undoStep() {
    if (!flow.undo.length) return;
    const current = flowEditSnapshot();
    const prev = flow.undo.pop();
    flow.redo.push(current);
    applyEditSnapshot(prev);
    lastSnapshot = prev;
    updateUndoButtons();
  }

  function redoStep() {
    if (!flow.redo.length) return;
    const current = flowEditSnapshot();
    const next = flow.redo.pop();
    flow.undo.push(current);
    applyEditSnapshot(next);
    lastSnapshot = next;
    updateUndoButtons();
  }

  function flowSnapshot() {
    return {
      version: 1,
      kind: "protoview.flow",
      exportedAt: new Date().toISOString(),
      nodes: flow.nodes.map((node) => serializeNode(node)),
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
    flow.sharedVars = {};
    flow.stepRunning = Object.create(null);
    flow.flowRunning = false;
    flow.scale = parsed.scale;
    flow.panX = parsed.panX;
    flow.panY = parsed.panY;
    flow.menuNodeId = null;
    flow.selectedEdgeId = null;
    flow.link = null;
    flow.editNodeId = null;
    flow.historyNodeId = null;
    flow.historySelectedId = null;
    hideMenu();
    hideEdgeMenu();
    commit();
    resetUndo();
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
      const node = normalizeNode(item);
      if (!node) continue;
      node.history = [];
      nodeIds.add(node.id);
      nodes.push(node);
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

  function isStartNode(node) {
    return node && (node.kind === "start" || node.kind === "Start");
  }

  /** 起始步骤默认启用；显式 false 才跳过 */
  function isStartEnabled(node) {
    return !node || node.enabled !== false;
  }

  function streamKindLabel(rpc) {
    const req = Boolean(rpc?.requestStream);
    const res = Boolean(rpc?.responseStream);
    if (req && res) return "Bidi";
    if (req) return "Client stream";
    if (res) return "Server stream";
    return "Unary";
  }

  function streamCssClass(rpc) {
    const req = Boolean(rpc?.requestStream);
    const res = Boolean(rpc?.responseStream);
    if (req && res) return "bidi";
    if (req) return "client";
    if (res) return "server";
    return "unary";
  }

  /** 流发送计划：建流后不发初始包，只按间隔定时发心跳 */
  function normalizeStreamPlan(raw) {
    const plan = raw && typeof raw === "object" ? raw : {};
    const interval = plan.heartbeatIntervalSec;
    const count = plan.heartbeatCount;
    return {
      heartbeatIntervalSec: interval == null || interval === "" ? "" : Number(interval),
      heartbeatCount: count == null || count === "" ? "" : Number(count),
    };
  }

  function serializeNode(node) {
    if (isStartNode(node)) {
      return {
        id: node.id,
        kind: "start",
        name: node.name || "步骤",
        runs: Math.max(1, Math.floor(Number(node.runs) || 1)),
        intervalSec: Number.isFinite(Number(node.intervalSec)) && Number(node.intervalSec) >= 0
          ? Number(node.intervalSec)
          : 1,
        enabled: node.enabled !== false,
        x: node.x,
        y: node.y,
        vars: node.vars && typeof node.vars === "object" ? node.vars : {},
        varsAt: Number(node.varsAt) || 0,
      };
    }
    return {
      id: node.id,
      kind: "rpc",
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
      streamPlan: normalizeStreamPlan(node.streamPlan),
      heartbeatMessage: node.heartbeatMessage && typeof node.heartbeatMessage === "object" ? node.heartbeatMessage : {},
      bytesDecode: node.bytesDecode && typeof node.bytesDecode === "object" ? { ...node.bytesDecode } : {},
      decodeExtra: Array.isArray(node.decodeExtra)
        ? node.decodeExtra.map((row) => ({
          id: String(row?.id || uid("dec")),
          path: String(row?.path || ""),
          typeName: String(row?.typeName || ""),
        }))
        : [],
      sendHistory: Array.isArray(node.sendHistory)
        ? node.sendHistory.slice(0, 8).map((item) => ({
          id: String(item?.id || uid("sh")),
          at: Number(item?.at) || Date.now(),
          body: item?.body && typeof item.body === "object" ? item.body : {},
        }))
        : [],
      sendTasks: normalizeSendTasks(node.sendTasks),
    };
  }

  /** 发送任务：建流后按延迟自动发；也可只做接收解析（recvOnly） */
  function normalizeSendTasks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((task) => task && typeof task === "object").map((task, index) => {
      const legacyDecode = task.bytesDecode && typeof task.bytesDecode === "object" ? task.bytesDecode : {};
      const legacyPath = Object.keys(legacyDecode)[0] || "";
      return {
        id: String(task.id || "").trim() || uid("task"),
        name: String(task.name || `任务${index + 1}`),
        delaySec: task.delaySec == null || task.delaySec === "" ? "" : Number(task.delaySec),
        recvOnly: task.recvOnly === true,
        routePath: String(task.routePath || ""),
        routeValue: task.routeValue == null || task.routeValue === ""
          ? String(task.matchEventType || "")
          : String(task.routeValue),
        payloadPath: String(task.payloadPath || legacyPath || ""),
        payloadType: String(task.payloadType || (legacyPath ? legacyDecode[legacyPath] : "") || ""),
        message: task.message && typeof task.message === "object" ? task.message : {},
        bytesDecode: { ...legacyDecode },
        decodeExtra: Array.isArray(task.decodeExtra)
          ? task.decodeExtra.map((row) => ({
            id: String(row?.id || uid("dec")),
            path: String(row?.path || ""),
            typeName: String(row?.typeName || ""),
          }))
          : [],
        extracts: task.extracts && typeof task.extracts === "object" ? { ...task.extracts } : {},
      };
    });
  }

  /** 把响应 message 展开成字段路径列表（看结构 + 选路由/Payload 字段） */
  function flattenFieldPaths(fields, prefix = [], depth = 0, out = []) {
    if (!fields?.length || depth > 6) return out;
    for (const field of fields) {
      const path = [...prefix, field.name];
      const key = path.join(".");
      const isBytes = isBytesField(field);
      const typeDef = !field.repeated && !field.key && !isBytes ? fieldTypeDef(field) : null;
      out.push({
        key,
        name: field.name,
        type: field.type,
        repeated: Boolean(field.repeated),
        isBytes,
        isMessage: typeDef?.kind === "message",
        comment: field.comment || "",
      });
      if (typeDef?.kind === "message") flattenFieldPaths(typeDef.fields, path, depth + 1, out);
    }
    return out;
  }

  /** 自动猜「路由字段」和「Payload 字段」：EventType 一类 + bytes Payload */
  function guessRouteFields(hit) {
    const paths = flattenFieldPaths(hit?.rpc?.responseFields || []);
    const route = paths.find((f) => /(^|\.)event_?type$/i.test(f.key))
      || paths.find((f) => /(^|\.)route(type|id)?$/i.test(f.key))
      || paths.find((f) => !f.isMessage && !f.isBytes && /type$/i.test(f.name));
    const payload = paths.find((f) => f.isBytes && /payload/i.test(f.name))
      || paths.find((f) => f.isBytes);
    return { routePath: route?.key || "", payloadPath: payload?.key || "" };
  }

  function normalizeNode(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim() || uid("n");
    if (item.kind === "start" || item.kind === "Start") {
      return {
        id,
        kind: "start",
        name: String(item.name || "步骤"),
        runs: Math.max(1, Math.floor(Number(item.runs) || 1)),
        intervalSec: Number.isFinite(Number(item.intervalSec)) && Number(item.intervalSec) >= 0
          ? Number(item.intervalSec)
          : 1,
        enabled: item.enabled !== false,
        x: Number.isFinite(Number(item.x)) ? Number(item.x) : 40,
        y: Number.isFinite(Number(item.y)) ? Number(item.y) : 40,
        vars: item.vars && typeof item.vars === "object" ? { ...item.vars } : {},
        varsAt: Number(item.varsAt) || 0,
        result: null,
        history: Array.isArray(item.history) ? item.history : [],
      };
    }
    const rpcId = String(item.rpcId || "").trim();
    if (!rpcId) return null;
    return {
      id,
      kind: "rpc",
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
      history: Array.isArray(item.history) ? item.history : [],
      protocol: normalizeNodeProtocol(item.protocol),
      httpMethod: String(item.httpMethod || (item.protocol === "sse" ? "GET" : "POST")),
      httpPath: String(item.httpPath || "/"),
      envId: String(item.envId || ""),
      streamPlan: normalizeStreamPlan(item.streamPlan),
      heartbeatMessage: item.heartbeatMessage && typeof item.heartbeatMessage === "object" ? item.heartbeatMessage : {},
      bytesDecode: item.bytesDecode && typeof item.bytesDecode === "object" ? { ...item.bytesDecode } : {},
      decodeExtra: Array.isArray(item.decodeExtra)
        ? item.decodeExtra.map((row) => ({
          id: String(row?.id || uid("dec")),
          path: String(row?.path || ""),
          typeName: String(row?.typeName || ""),
        }))
        : [],
      sendHistory: Array.isArray(item.sendHistory)
        ? item.sendHistory.slice(0, 8).map((row) => ({
          id: String(row?.id || uid("sh")),
          at: Number(row?.at) || Date.now(),
          body: row?.body && typeof row.body === "object" ? row.body : {},
        }))
        : [],
      sendTasks: normalizeSendTasks(item.sendTasks),
      streamId: null,
      streamMessages: [],
      result: null,
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
    hideEdgeMenu();
    flow.link = null;
    // next frame so layout has non-zero size before placing nodes
    requestAnimationFrame(() => render());
  }

  function closeFlow() {
    flow.stressAbort = true;
    const flowMain = $("mainFlow");
    flowMain?.classList.add("hidden");
    if (flowMain) flowMain.style.display = "none";
    const client = $("mainClient");
    client?.classList.remove("hidden");
    if (client) client.style.display = "";
    document.getElementById("app")?.classList.remove("flow-mode");
    $("flowStage")?.classList.remove("flow-connecting");
    hideMenu();
    hideEdgeMenu();
    flow.link = null;
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
      if (isStartNode(node)) {
        const busy = Boolean(flow.stepRunning[node.id]);
        const status = busy ? "ok" : node.result?.ok === true ? "ok" : node.result?.ok === false ? "fail" : "";
        const runs = Math.max(1, Math.floor(Number(node.runs) || 1));
        const intervalSec = Number.isFinite(Number(node.intervalSec)) && Number(node.intervalSec) >= 0
          ? Number(node.intervalSec)
          : 1;
        const enabled = node.enabled !== false;
        const badge = busy
          ? `<div class="flow-node-result live">运行中</div>`
          : node.result
            ? `<div class="flow-node-result ${status}">${esc(node.result.status || "")}</div>`
            : `<div class="flow-node-result idle">${enabled ? "起始步骤" : "已禁用"}</div>`;
        const varCount = Object.keys(node.vars || {}).length;
        return `<div class="flow-node flow-node-start ${status}${enabled ? "" : " disabled"}${busy ? " running" : ""}" data-node="${esc(node.id)}" style="left:${node.x}px;top:${node.y}px">
          <div class="flow-node-head" data-drag="${esc(node.id)}">
            <div class="flow-node-icon start">▶</div>
            <div class="flow-node-text">
              <strong>${esc(node.name || "起始步骤")}</strong>
              <span>运行 ${runs} 次${runs > 1 ? ` · 间隔 ${intervalSec}s` : ""}</span>
            </div>
          </div>
          <div class="flow-start-actions">
            <label class="flow-start-switch" title="全量运行时是否执行本步骤">
              <input type="checkbox" data-start-toggle="${esc(node.id)}"${enabled ? " checked" : ""} />
              <span>${enabled ? "启用" : "禁用"}</span>
            </label>
            <button type="button" class="flow-start-run-btn" data-start-run="${esc(node.id)}" title="只运行本步骤（不依赖顺序）"${busy ? " disabled" : ""}>${busy ? "运行中" : "运行"}</button>
            <button type="button" class="flow-start-var-btn" data-start-vars="${esc(node.id)}" title="查看本步骤提取到的变量">变量${varCount ? ` ${varCount}` : ""}</button>
          </div>
          ${badge}
          <div class="flow-port in" data-port-in="${esc(node.id)}" title="连入"></div>
          <div class="flow-port out" data-port-out="${esc(node.id)}" title="连出"></div>
        </div>`;
      }
      const hit = api()?.findRpc?.(node.rpcId);
      const title = hit ? hit.rpc.name : (node.name || node.rpcId || "未知接口");
      const proto = protocolLabel(node);
      const streamTag = normalizeNodeProtocol(node.protocol) === "grpc" ? streamKindLabel(hit?.rpc) : "";
      const sub = streamTag
        ? `${proto} · ${streamTag} · ${hit ? `${hit.pkg.name}.${hit.service.name}` : (node.package || "")}`
        : `${proto} · ${hit ? `${hit.pkg.name}.${hit.service.name}` : (node.package || "")}`;
      const closed = Boolean(node.result?.streamClosed);
      const live = !closed && (Boolean(node.streamId) || node.result?.streaming);
      const status = live ? "ok" : closed || node.result?.ok === false ? "fail" : node.result?.ok === true ? "ok" : "";
      const streamClass = normalizeNodeProtocol(node.protocol) === "grpc" ? `stream-${streamCssClass(hit?.rpc)}` : "";
      const badgeClass = live ? "live" : closed ? "fail" : status;
      const badgeText = closed
        ? (node.result.status || "stream close")
        : `${node.result?.status || ""}${node.result?.ms != null ? ` · ${node.result.ms}ms` : ""}`;
      const badge = node.result
        ? `<div class="flow-node-result ${badgeClass}">${esc(badgeText)}</div>`
        : `<div class="flow-node-result idle">未运行</div>`;
      return `<div class="flow-node ${status} ${streamClass}" data-node="${esc(node.id)}" style="left:${node.x}px;top:${node.y}px">
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
      const d = edgePathD(edgeFromPoint(from), edgeToPoint(to));
      const cls = edge.status === "ok" ? "ok" : edge.status === "fail" ? "fail" : "";
      // 透明粗线负责命中（易选中），细线负责显示
      return `<g class="flow-edge-group" data-edge-group="${esc(edge.id)}">
        <path class="flow-edge-hit" data-edge="${esc(edge.id)}" d="${d}" />
        <path class="flow-edge ${cls}" data-edge="${esc(edge.id)}" d="${d}" />
      </g>`;
    }).join("");
    // 末尾保留一条预览线：从端口拖出时立即跟随指针
    svg.innerHTML = `${lines}<path class="flow-edge preview" id="flowEdgePreview" d="" />`;
    paintEdgeSelection();
    paintLinkPreview();
    svg.setAttribute("width", "4000");
    svg.setAttribute("height", "3000");
    applyTransform();
    updateVarsBadge();
    save();
  }

  const EDGE_NODE_W = 200;
  const EDGE_PORT_Y = 36;

  function edgeFromPoint(node) {
    return { x: node.x + EDGE_NODE_W, y: node.y + EDGE_PORT_Y };
  }

  function edgeToPoint(node) {
    return { x: node.x, y: node.y + EDGE_PORT_Y };
  }

  function edgePathD(a, b) {
    return `M ${a.x} ${a.y} C ${a.x + 60} ${a.y}, ${b.x - 60} ${b.y}, ${b.x} ${b.y}`;
  }

  function paintEdgeSelection() {
    const svg = $("flowEdges");
    if (!svg) return;
    for (const el of svg.querySelectorAll(".flow-edge[data-edge]")) {
      el.classList.toggle("selected", el.getAttribute("data-edge") === flow.selectedEdgeId);
    }
  }

  function selectEdge(edgeId) {
    flow.selectedEdgeId = edgeId || null;
    const svg = $("flowEdges");
    if (!svg) return;
    for (const el of svg.querySelectorAll(".flow-edge[data-edge]")) {
      el.classList.toggle("selected", Boolean(edgeId) && el.getAttribute("data-edge") === edgeId);
    }
  }

  /** 拖拽中实时画预览线（世界坐标） */
  function paintLinkPreview() {
    const path = $("flowEdgePreview");
    if (!path) return;
    const link = flow.link;
    const from = link ? flow.nodes.find((n) => n.id === link.from) : null;
    if (!link || !from) {
      path.classList.remove("show");
      path.setAttribute("d", "");
      return;
    }
    path.setAttribute("d", edgePathD(edgeFromPoint(from), { x: link.x, y: link.y }));
    path.classList.add("show");
  }

  /** 指针落在哪个节点/入端口上 */
  function linkTargetAt(clientX, clientY, fromId) {
    const hit = document.elementFromPoint(clientX, clientY);
    const inPort = hit?.closest?.("[data-port-in]");
    if (inPort) return inPort.getAttribute("data-port-in") || "";
    const nodeEl = hit?.closest?.("[data-node]");
    const nodeId = nodeEl?.getAttribute("data-node") || "";
    return nodeId && nodeId !== fromId ? nodeId : "";
  }

  function connectNodes(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return false;
    if (flow.edges.some((edge) => edge.from === fromId && edge.to === toId)) return false;
    const edge = { id: uid("e"), from: fromId, to: toId, status: "idle" };
    flow.edges.push(edge);
    flow.selectedEdgeId = edge.id;
    commit();
    render();
    return true;
  }

  function deleteEdge(edgeId) {
    if (!edgeId) return;
    const before = flow.edges.length;
    flow.edges = flow.edges.filter((edge) => edge.id !== edgeId);
    if (flow.edges.length === before) return;
    if (flow.selectedEdgeId === edgeId) flow.selectedEdgeId = null;
    hideEdgeMenu();
    commit();
    render();
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

  function addStartNode(x, y) {
    try {
      if (!isFlowOpen()) openFlow();
      const place = () => {
        const center = canvasCenter();
        const index = flow.nodes.filter(isStartNode).length + 1;
        flow.nodes.push({
          id: uid("s"),
          kind: "start",
          name: `步骤${index}`,
          runs: 1,
          intervalSec: 1,
          enabled: true,
          x: Number.isFinite(x) ? x : Math.max(40, center.x - 40),
          y: Number.isFinite(y) ? y : Math.max(40, center.y - 80 + index * 24),
          vars: {},
          varsAt: 0,
          result: null,
          history: [],
        });
        commit();
        render();
      };
      requestAnimationFrame(place);
      return true;
    } catch (error) {
      console.error("addStartNode failed", error);
      return false;
    }
  }

  function addNode(rpcId, x, y, label) {
    if (!rpcId) return false;
    try {
      if (!isFlowOpen()) openFlow();
      const hit = api()?.findRpc?.(rpcId);
      const message = {};
      if (hit) {
        for (const group of groupFieldsByOneof(hit.rpc.requestFields || [])) {
          const field = group.kind === "oneof" ? group.fields[0] : group.field;
          if (!field) continue;
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
          kind: "rpc",
          rpcId,
          name: hit?.rpc.name || label || rpcId,
          package: hit ? `${hit.pkg.name}.${hit.service.name}` : "",
          x: nodeX,
          y: nodeY,
          message,
          heartbeatMessage: {},
          metadata: [{ name: "", value: "" }],
          extracts: {},
          history: [],
          protocol: "grpc",
          httpMethod: hit?.rpc.httpVerb || "POST",
          httpPath: hit?.rpc.httpPath || "/",
          envId: api()?.getActiveEnvId?.() || "",
          streamPlan: normalizeStreamPlan({}),
          bytesDecode: {},
          decodeExtra: [],
          sendHistory: [],
          sendTasks: [],
          streamId: null,
          streamMessages: [],
          result: null,
        });
        commit();
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

  /** 连线右键菜单（动态创建，无需改 webview HTML） */
  function edgeMenuEl() {
    let menu = $("flowEdgeMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "flowEdgeMenu";
      menu.className = "flow-menu hidden";
      menu.style.display = "none";
      menu.innerHTML = `<button type="button" data-edge-act="delete">删除连线</button>
        <button type="button" data-edge-act="deselect">取消选中</button>`;
      document.body.appendChild(menu);
      menu.addEventListener("click", (event) => {
        const act = event.target.closest("[data-edge-act]")?.getAttribute("data-edge-act");
        const id = flow.edgeMenuId;
        hideEdgeMenu();
        if (!id) return;
        if (act === "delete") deleteEdge(id);
        if (act === "deselect") selectEdge(null);
      });
    }
    return menu;
  }

  function showEdgeMenu(x, y, edgeId) {
    const menu = edgeMenuEl();
    flow.edgeMenuId = edgeId;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
    menu.classList.remove("hidden");
  }

  function hideEdgeMenu() {
    const menu = $("flowEdgeMenu");
    flow.edgeMenuId = null;
    if (!menu) return;
    menu.classList.add("hidden");
    menu.style.display = "none";
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
    void askConfirm("清空链路画布？此操作不可撤销。").then(async (ok) => {
      if (!ok) return;
      await closeAllStreams();
      flow.nodes = [];
      flow.edges = [];
      flow.sharedVars = {};
      flow.stepRunning = Object.create(null);
      flow.flowRunning = false;
      flow.selectedEdgeId = null;
      flow.link = null;
      hideMenu();
      hideEdgeMenu();
      commit();
      render();
    });
  }

  function showMenu(x, y, nodeId) {
    const menu = $("flowMenu");
    if (!menu) return;
    flow.menuNodeId = nodeId;
    const node = flow.nodes.find((n) => n.id === nodeId);
    const hit = node && !isStartNode(node) ? api()?.findRpc?.(node.rpcId) : null;
    const isStart = Boolean(node && isStartNode(node));
    const isGrpc = normalizeNodeProtocol(node?.protocol) === "grpc";
    // 客户端流 / 双向流可手动续发；已建连的节点也始终露出入口
    const canSendMsg = isGrpc && (
      Boolean(hit?.rpc?.requestStream)
      || Boolean(node?.streamId)
      || Boolean(node?.lastStreamId)
      || Boolean(node?.result?.streaming)
    );
    const hasLive = Boolean(node?.streamId);
    for (const btn of menu.querySelectorAll("[data-flow-act]")) {
      const act = btn.getAttribute("data-flow-act");
      let show = true;
      if (act === "view-resp") show = !isStart;
      if (act === "send-msg") show = canSendMsg;
      if (act === "close-stream") show = canSendMsg && hasLive;
      btn.classList.toggle("hidden", !show);
    }
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
    if (!field) return undefined;
    if (field.typeId) {
      const byId = getType(field.typeId);
      if (byId) return byId;
    }
    const typeName = String(field.type || "").trim();
    if (!typeName) return undefined;
    return api()?.findType?.(typeName);
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
    let base = field.key ? `${prefix}<${field.key}, ${field.type}>` : `${prefix}${field.type || ""}`;
    if (field.jstype === "JS_STRING") base += " · string";
    else if (field.jstype === "JS_NUMBER") base += " · number";
    else if (!field.key && /^(int64|uint64|sint64|fixed64|sfixed64)$/i.test(String(field.type || ""))) {
      base += " · string";
    }
    return base;
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
    if (typeDef?.kind === "enum" && Array.isArray(typeDef.values) && typeDef.values.length) {
      const hit = typeDef.values.find((item) => String(item.number) === shown || item.name === shown);
      if (opts.readonly) {
        const label = hit ? `${hit.name} = ${hit.number}` : shown;
        return `<div class="flow-msg-row"><input value="${esc(label)}" readonly /></div>`;
      }
      const options = [`<option value="">请选择枚举</option>`];
      for (const item of typeDef.values) {
        const selected = String(item.number) === shown || item.name === shown ? " selected" : "";
        options.push(`<option value="${esc(String(item.number))}"${selected}>${esc(item.name)} = ${item.number}</option>`);
      }
      // 当前是 {{变量}} 或未匹配的自定义值时保留可选
      if (shown && !hit) {
        options.push(`<option value="${esc(shown)}" selected>${esc(shown)}</option>`);
      }
      return `<div class="flow-msg-row">
        <select class="flow-msg-enum-select"${pathKey}>${options.join("")}</select>
      </div>`;
    }
    return `<div class="flow-msg-row">
      <input${pathKey} value="${esc(shown)}" placeholder="${opts.readonly ? "" : "值或 {{变量}}"}"${ro} />
    </div>`;
  }

  function groupFieldsByOneof(fields) {
    const groups = [];
    const oneofIndex = new Map();
    for (const field of fields || []) {
      if (field.oneof) {
        let idx = oneofIndex.get(field.oneof);
        if (idx === undefined) {
          idx = groups.length;
          oneofIndex.set(field.oneof, idx);
          groups.push({ kind: "oneof", name: field.oneof, fields: [] });
        }
        groups[idx].fields.push(field);
      } else {
        groups.push({ kind: "field", field });
      }
    }
    return groups;
  }

  function valueLooksSet(value) {
    if (value === undefined || value === null || value === "") return false;
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return false;
    if (Array.isArray(value) && !value.length) return false;
    return true;
  }

  function detectOneofMember(fields, value, preferHeartbeat = false) {
    for (const field of fields || []) {
      if (valueLooksSet(value?.[field.name])) return field.name;
    }
    if (preferHeartbeat) {
      const preferred = (fields || []).find((f) => /heartbeat/i.test(f.name || "") || /heartbeat/i.test(f.type || ""));
      if (preferred) return preferred.name;
    }
    return fields?.[0]?.name || "";
  }

  function renderOneofGroup(group, value, path, depth, opts = {}) {
    const selected = opts.oneofPick?.[group.name]
      || detectOneofMember(group.fields, value, Boolean(opts.preferHeartbeat))
      || group.fields[0]?.name
      || "";
    const active = group.fields.find((f) => f.name === selected) || group.fields[0];
    const options = group.fields.map((field) => {
      const sel = field.name === active?.name ? " selected" : "";
      const tip = field.type ? ` (${field.type})` : "";
      return `<option value="${esc(field.name)}"${sel}>${esc(field.name)}${esc(tip)}</option>`;
    }).join("");
    const selectAttr = opts.readonly
      ? " disabled"
      : ` data-flow-oneof-select="${esc(group.name)}" data-flow-oneof-path="${pathAttr(path)}" data-flow-oneof-members="${pathAttr(group.fields.map((f) => f.name))}"`;
    return `<div class="flow-msg-oneof" data-flow-oneof="${esc(group.name)}">
      <div class="flow-msg-head">
        <span class="flow-msg-name">oneof ${esc(group.name)}</span>
        <span class="flow-msg-type">选择发送成员</span>
        <select class="flow-msg-oneof-select"${selectAttr}>${options}</select>
      </div>
      ${active ? renderField(active, value?.[active.name], [...path, active.name], depth, opts) : `<div class="flow-msg-empty">无成员</div>`}
    </div>`;
  }

  function renderFields(fields, value, path = [], depth = 0, opts = {}) {
    if (!fields?.length) return `<div class="flow-msg-empty">无字段</div>`;
    if (depth > 8) return `<div class="flow-msg-empty">嵌套过深，已截断</div>`;
    return groupFieldsByOneof(fields).map((group) => {
      if (group.kind === "oneof") return renderOneofGroup(group, value, path, depth, opts);
      return renderField(group.field, value?.[group.field.name], [...path, group.field.name], depth, opts);
    }).join("");
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
    // 流式回包为数组时取最后一条
    let root = body;
    if (Array.isArray(root)) {
      if (!root.length) return undefined;
      root = root[root.length - 1];
    }
    if (typeof root !== "object" || root == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(root, pathKey)) return root[pathKey];
    const parts = String(pathKey).split(".");
    let cursor = root;
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

  /** 心跳间隔（毫秒）：默认 2s，最小 200ms */
  function heartbeatIntervalMs(node) {
    const plan = normalizeStreamPlan(node?.streamPlan);
    const sec = Number(plan.heartbeatIntervalSec);
    const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 2000;
    return Math.max(200, Math.round(ms));
  }

  /** 心跳总次数：0 = 一直发到关流 */
  function heartbeatTotal(node) {
    const count = Math.floor(Number(normalizeStreamPlan(node?.streamPlan).heartbeatCount));
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function stopNodeHeartbeat(node) {
    if (!node) return;
    if (node.heartbeatTimer) clearTimeout(node.heartbeatTimer);
    node.heartbeatTimer = null;
    node.heartbeatSent = 0;
  }

  /**
   * 建流成功后按间隔定时写入心跳消息，不阻塞链路执行。
   * 次数留空 = 一直发；关流 / 写失败 / 节点删除时自动停。
   */
  function startNodeHeartbeat(node, heartbeatBody) {
    stopNodeHeartbeat(node);
    const client = api();
    if (!node?.streamId || !client?.streamWrite) return;
    const total = heartbeatTotal(node);
    const tick = async () => {
      if (!node.streamId) return;
      if (total > 0 && (node.heartbeatSent || 0) >= total) return;
      let body = {};
      try {
        body = JSON.parse(JSON.stringify(heartbeatBody ?? {}));
      } catch {
        body = heartbeatBody ?? {};
      }
      node.heartbeatSent = (node.heartbeatSent || 0) + 1;
      const wr = await client.streamWrite(node.streamId, body);
      if (!wr?.ok) {
        stopNodeHeartbeat(node);
        return;
      }
      if (total > 0 && node.heartbeatSent >= total) return;
      if (!node.streamId) return;
      node.heartbeatTimer = setTimeout(tick, heartbeatIntervalMs(node));
    };
    node.heartbeatTimer = setTimeout(tick, heartbeatIntervalMs(node));
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

  function collectMessageFromDom(rootEl, fields) {
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
    for (const btn of rootEl.querySelectorAll("[data-flow-rep-add]")) {
      const path = parsePath(btn.getAttribute("data-flow-rep-add"));
      if (!path) continue;
      if (getByPath(message, path) === undefined) setByPath(message, path, []);
    }
    pruneOneofsInMessage(fields, message, rootEl);
    return message;
  }

  function pruneOneofsInMessage(fields, message, rootEl) {
    if (!fields?.length || !message || typeof message !== "object") return;
    const picks = {};
    if (rootEl) {
      for (const sel of rootEl.querySelectorAll("[data-flow-oneof-select]")) {
        const name = sel.getAttribute("data-flow-oneof-select");
        if (name) picks[name] = sel.value;
      }
    }
    applyOneofPicks(fields, message, picks, "");
  }

  function applyOneofPicks(fields, message, picks, prefix) {
    const groups = groupFieldsByOneof(fields || []);
    for (const group of groups) {
      if (group.kind !== "oneof") {
        const field = group.field;
        if (isMessageField(field) && message[field.name] && typeof message[field.name] === "object") {
          const typeDef = fieldTypeDef(field);
          applyOneofPicks(typeDef?.fields || [], message[field.name], picks, prefix ? `${prefix}.${field.name}` : field.name);
        }
        continue;
      }
      const selected = picks[group.name] || detectOneofMember(group.fields, message);
      for (const field of group.fields) {
        if (field.name === selected) {
          if (isMessageField(field) && message[field.name] && typeof message[field.name] === "object") {
            const typeDef = fieldTypeDef(field);
            applyOneofPicks(typeDef?.fields || [], message[field.name], picks, prefix ? `${prefix}.${field.name}` : field.name);
          }
          continue;
        }
        delete message[field.name];
      }
    }
  }

  function oneofPicksFromDom(rootEl) {
    const picks = {};
    if (!rootEl) return picks;
    for (const sel of rootEl.querySelectorAll("[data-flow-oneof-select]")) {
      const name = sel.getAttribute("data-flow-oneof-select");
      if (name) picks[name] = sel.value;
    }
    return picks;
  }

  function syncEditMessage() {
    const node = flow.nodes.find((n) => n.id === flow.editNodeId);
    if (!node || isStartNode(node)) return node || null;
    const hit = api()?.findRpc?.(node.rpcId);
    const fields = hit?.rpc?.requestFields || [];
    // 流式节点的编辑里已隐藏 Message（发送内容在「收发消息」的任务里配）
    if (!$("flowMsgSection")?.classList.contains("hidden")) {
      node.message = collectMessageFromDom($("flowMsgBody"), fields);
    }
    if ($("flowHbMsgBody") && !$("flowStreamPlanFields")?.classList.contains("hidden")) {
      node.heartbeatMessage = collectMessageFromDom($("flowHbMsgBody"), fields);
    }
    return node;
  }

  function preferHeartbeatPicks(fields) {
    const picks = {};
    for (const group of groupFieldsByOneof(fields || [])) {
      if (group.kind !== "oneof") continue;
      const hb = group.fields.find((f) => /heartbeat/i.test(f.name || "") || /heartbeat/i.test(f.type || ""));
      if (hb) picks[group.name] = hb.name;
    }
    return picks;
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

  function renderHeartbeatMessage(node, hit) {
    const el = $("flowHbMsgBody");
    if (!el) return;
    const fields = hit?.rpc?.requestFields || [];
    if (!fields.length) {
      el.innerHTML = `<div class="flow-msg-empty">无请求字段</div>`;
      return;
    }
    if (!node.heartbeatMessage || typeof node.heartbeatMessage !== "object" || Array.isArray(node.heartbeatMessage)) {
      node.heartbeatMessage = {};
    }
    el.innerHTML = renderFields(fields, node.heartbeatMessage, [], 0, {
      oneofPick: preferHeartbeatPicks(fields),
      preferHeartbeat: true,
    });
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
    const node = flow.nodes.find((n) => n.id === flow.editNodeId);
    const hit = node && !isStartNode(node) ? api()?.findRpc?.(node.rpcId) : null;
    const showStreamPlan = protocol === "grpc" && Boolean(hit?.rpc?.requestStream);
    $("flowStreamPlanFields")?.classList.toggle("hidden", !showStreamPlan);
    // 流式节点的发送内容改到「收发消息」的任务里，编辑里不再放 Message
    $("flowMsgSection")?.classList.toggle("hidden", showStreamPlan);
    const hint = $("flowStreamTypeHint");
    if (hint) {
      hint.textContent = protocol === "grpc" && hit?.rpc
        ? `gRPC 类型（来自 proto）：${streamKindLabel(hit.rpc)}`
        : "";
    }
  }

  function openEdit(nodeId) {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    flow.editNodeId = nodeId;
    const startFields = $("flowStartEditFields");
    const rpcFields = $("flowRpcEditFields");
    if (isStartNode(node)) {
      $("flowEditTitle").textContent = `编辑 · ${node.name || "起始步骤"}`;
      startFields?.classList.remove("hidden");
      rpcFields?.classList.add("hidden");
      if ($("flowStartName")) $("flowStartName").value = node.name || "";
      if ($("flowStartRuns")) $("flowStartRuns").value = String(Math.max(1, Number(node.runs) || 1));
      if ($("flowStartInterval")) {
        const intervalSec = Number.isFinite(Number(node.intervalSec)) && Number(node.intervalSec) >= 0
          ? Number(node.intervalSec)
          : 1;
        $("flowStartInterval").value = String(intervalSec);
      }
      if ($("flowStartEnabled")) $("flowStartEnabled").checked = node.enabled !== false;
      $("flowEditModal").classList.add("show");
      return;
    }
    const hit = api()?.findRpc?.(node.rpcId);
    if (!hit) return;
    startFields?.classList.add("hidden");
    rpcFields?.classList.remove("hidden");
    $("flowEditTitle").textContent = `编辑 · ${hit.rpc.name}`;
    renderNodeTransport(node, hit);
    const hint = $("flowStreamTypeHint");
    if (hint) {
      const kind = streamKindLabel(hit.rpc);
      hint.textContent = normalizeNodeProtocol(node.protocol) === "grpc"
        ? `gRPC 类型（来自 proto）：${kind}`
        : "";
    }
    const planFields = $("flowStreamPlanFields");
    const isClientStream = Boolean(hit.rpc.requestStream) && normalizeNodeProtocol(node.protocol) === "grpc";
    planFields?.classList.toggle("hidden", !isClientStream);
    $("flowMsgSection")?.classList.toggle("hidden", isClientStream);
    if (isClientStream) {
      const plan = normalizeStreamPlan(node.streamPlan);
      if ($("flowStreamHbInterval")) {
        $("flowStreamHbInterval").value = plan.heartbeatIntervalSec === "" || plan.heartbeatIntervalSec == null
          ? ""
          : String(plan.heartbeatIntervalSec);
      }
      if ($("flowStreamHbCount")) {
        $("flowStreamHbCount").value = plan.heartbeatCount === "" || plan.heartbeatCount == null
          ? ""
          : String(plan.heartbeatCount);
      }
      renderHeartbeatMessage(node, hit);
    }
    renderFlowMessage(node, hit);
    renderFlowMeta(node);
    renderFlowExtract(node, hit);
    $("flowEditModal").classList.add("show");
  }

  function openHistory(nodeId) {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    flow.historyNodeId = nodeId;
    flow.historyFollowLive = true;
    const items = buildHistoryItems(node);
    const newestRecv = items.find((item) => item.kind === "recv" && item.body != null);
    flow.historySelectedId = newestRecv?.id || items[0]?.id || null;
    $("flowHistoryTitle").textContent = `响应历史 · ${node.name || "节点"}`;
    void renderHistoryModal();
    $("flowHistoryModal")?.classList.add("show");
  }

  function collectReceivedMessages(node) {
    if (!node) return [];
    if (Array.isArray(node.streamMessages) && node.streamMessages.length) {
      return node.streamMessages;
    }
    const body = node.result?.body;
    if (Array.isArray(body)) return body;
    if (body != null) return [body];
    return [];
  }

  /** 接收消息的稳定 id：新增消息时同步压入，选中项不会因为下标变化而错位 */
  function recvMessageIds(node) {
    if (!node) return [];
    if (!Array.isArray(node.streamMessages)) node.streamMessages = [];
    if (!Array.isArray(node.streamMessageIds)) node.streamMessageIds = [];
    if (node.streamMessageIds.length > node.streamMessages.length) {
      node.streamMessageIds.length = node.streamMessages.length;
    }
    while (node.streamMessageIds.length < node.streamMessages.length) {
      node.streamMessageIds.push(uid("recv"));
    }
    return node.streamMessageIds;
  }

  function pushRecvMessage(node, message) {
    if (!node) return;
    if (!Array.isArray(node.streamMessages)) node.streamMessages = [];
    node.streamMessages.push(message);
    if (!Array.isArray(node.streamMessageIds)) node.streamMessageIds = [];
    node.streamMessageIds.push(uid("recv"));
  }

  function recvPreview(body) {
    if (body == null) return "";
    try {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    } catch {
      return "";
    }
  }

  function buildHistoryItems(node) {
    const history = Array.isArray(node?.history) ? node.history : [];
    const hit = node && !isStartNode(node) ? api()?.findRpc?.(node.rpcId) : null;
    const isStreamRpc = Boolean(hit?.rpc?.requestStream || hit?.rpc?.responseStream)
      || Boolean(node?.streamId)
      || Boolean(node?.result?.streaming)
      || Boolean(node?.result?.streamClosed);
    const received = collectReceivedMessages(node);
    const recvIds = recvMessageIds(node);
    const items = [];
    // 每条接收消息单独占一项；最新的排在最上面
    for (let index = received.length - 1; index >= 0; index -= 1) {
      const msg = received[index];
      items.push({
        id: `__recv_${recvIds[index] || index}__`,
        at: Date.now(),
        ok: true,
        status: `接收 #${index + 1}`,
        kind: "recv",
        ms: node.result?.ms ?? 0,
        body: msg,
        recvIndex: index,
        preview: recvPreview(msg),
      });
    }
    if (isStreamRpc && !received.length) {
      items.push({
        id: "__recv_empty__",
        at: Date.now(),
        ok: true,
        status: node.streamId ? "等待接收…" : "暂无接收",
        kind: "recv",
        ms: node.result?.ms ?? 0,
        body: null,
      });
    }
    for (const item of history) {
      // 旧的整包接收记录不再重复塞进左侧（已拆成逐条）
      if (item.kind === "recv" && Array.isArray(item.body)) continue;
      items.push(item);
    }
    return items;
  }

  function historyKindLabel(kind) {
    if (kind === "stress") return "压测";
    if (kind === "send") return "发送";
    if (kind === "recv") return "接收";
    return "运行";
  }

  async function renderHistoryModal() {
    const node = flow.nodes.find((n) => n.id === flow.historyNodeId);
    const list = $("flowHistoryList");
    const detail = $("flowHistoryDetail");
    if (!list || !detail) return;
    const items = buildHistoryItems(node);
    if (!items.length) {
      list.innerHTML = `<div class="flow-msg-empty" style="padding:12px">暂无运行/压测记录</div>`;
      detail.textContent = "运行链路或压测后，可在此查看该节点的响应历史。";
      return;
    }
    if (!flow.historySelectedId || !items.some((item) => item.id === flow.historySelectedId)) {
      if (flow.historyFollowLive) {
        const newestRecv = items.find((item) => item.kind === "recv" && item.body != null);
        flow.historySelectedId = newestRecv?.id || items[0].id;
      } else {
        flow.historySelectedId = items[0].id;
      }
    }
    // 重渲染时保住滚动位置，避免新消息进来把列表顶回顶部
    const prevScroll = list.scrollTop;
    list.innerHTML = items.map((item) => {
      const okClass = item.ok ? "ok" : "fail";
      const kind = historyKindLabel(item.kind);
      const meta = item.kind === "recv" && item.preview
        ? item.preview
        : `${kind} · ${formatHistoryTime(item.at)}`;
      return `<button type="button" class="flow-history-item${item.id === flow.historySelectedId ? " active" : ""}" data-history-id="${esc(item.id)}">
        <div class="h-top ${okClass}"><span>${esc(item.status || (item.ok ? "OK" : "FAIL"))}</span><span>${item.ms ?? "-"}ms</span></div>
        <div class="h-meta">${esc(meta)}</div>
      </button>`;
    }).join("");
    list.scrollTop = prevScroll;
    const selected = items.find((item) => item.id === flow.historySelectedId) || items[0];
    let body = selected.body ?? null;
    if (selected.kind === "recv" && body != null && node) {
      body = await decodeMessageBytes(node, body, protoFileOf(node));
    }
    const payload = selected.kind === "recv"
      ? {
        index: selected.recvIndex != null ? selected.recvIndex + 1 : undefined,
        status: selected.status,
        pinned: !flow.historyFollowLive,
        body,
      }
      : {
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
    const node = flow.nodes.find((n) => n.id === flow.editNodeId);
    if (!node) return;
    if (isStartNode(node)) {
      node.name = ($("flowStartName")?.value || "").trim() || node.name || "步骤";
      node.runs = Math.max(1, Math.floor(Number($("flowStartRuns")?.value) || 1));
      const intervalRaw = Number($("flowStartInterval")?.value);
      node.intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : 1;
      node.enabled = $("flowStartEnabled") ? Boolean($("flowStartEnabled").checked) : node.enabled !== false;
      $("flowEditModal").classList.remove("show");
      flow.editNodeId = null;
      commit();
      render();
      return;
    }
    const synced = syncEditMessage();
    if (!synced) return;
    const metadata = [];
    for (const input of document.querySelectorAll("[data-flow-meta-name]")) {
      const index = Number(input.getAttribute("data-flow-meta-name"));
      const value = document.querySelector(`[data-flow-meta-value="${index}"]`)?.value || "";
      metadata.push({ name: input.value, value });
    }
    node.metadata = metadata.length ? metadata : [{ name: "", value: "" }];
    const extracts = {};
    // 只取编辑弹窗自己的提取区（收发消息里任务的提取用同样的 data 属性）
    const extractRoot = $("flowExtractBody") || document;
    for (const input of extractRoot.querySelectorAll("[data-flow-extract-path]")) {
      const key = input.getAttribute("data-flow-extract-path");
      const val = input.value.trim();
      if (key && val) extracts[key] = val;
    }
    node.extracts = extracts;
    node.protocol = normalizeNodeProtocol($("flowNodeProtocol")?.value);
    node.httpMethod = $("flowNodeHttpMethod")?.value || (node.protocol === "sse" ? "GET" : "POST");
    node.httpPath = $("flowNodeHttpPath")?.value || "/";
    node.envId = $("flowNodeEnv")?.value || node.envId || "";
    const hit = api()?.findRpc?.(node.rpcId);
    if (hit?.rpc?.requestStream && node.protocol === "grpc") {
      const intervalRaw = $("flowStreamHbInterval")?.value;
      const countRaw = $("flowStreamHbCount")?.value;
      node.streamPlan = normalizeStreamPlan({
        heartbeatIntervalSec: intervalRaw === "" || intervalRaw == null ? "" : Number(intervalRaw),
        heartbeatCount: countRaw === "" || countRaw == null ? "" : Number(countRaw),
      });
    }
    $("flowEditModal").classList.remove("show");
    flow.editNodeId = null;
    commit();
    render();
  }

  function msgTargetKey(rootEl) {
    if (rootEl?.id === "flowHbMsgBody") return "heartbeatMessage";
    if (rootEl?.id === "flowSendMsgBody") return "send";
    return "message";
  }

  function getMsgBag(node, key) {
    if (key === "heartbeatMessage") {
      if (!node.heartbeatMessage || typeof node.heartbeatMessage !== "object") node.heartbeatMessage = {};
      return node.heartbeatMessage;
    }
    if (key === "send") {
      // 「收发消息」的 Message 现在挂在选中的发送任务上
      const task = currentSendTask();
      if (task) {
        if (!task.message || typeof task.message !== "object") task.message = {};
        return task.message;
      }
      if (!flow.sendMessage || typeof flow.sendMessage !== "object") flow.sendMessage = {};
      return flow.sendMessage;
    }
    if (!node.message || typeof node.message !== "object") node.message = {};
    return node.message;
  }

  function rerenderMsgTree(node, hit, key, picks) {
    const fields = hit?.rpc?.requestFields || [];
    if (key === "heartbeatMessage") {
      $("flowHbMsgBody").innerHTML = renderFields(fields, node.heartbeatMessage || {}, [], 0, {
        oneofPick: picks || preferHeartbeatPicks(fields),
        preferHeartbeat: true,
      });
      return;
    }
    if (key === "send") {
      $("flowSendMsgBody").innerHTML = renderFields(fields, getMsgBag(node, key), [], 0, {
        oneofPick: picks,
      });
      return;
    }
    $("flowMsgBody").innerHTML = renderFields(fields, node.message || {}, [], 0, { oneofPick: picks });
  }

  function handleMsgTreeClick(event) {
    const addBtn = event.target.closest("[data-flow-rep-add]");
    const delBtn = event.target.closest("[data-flow-rep-del]");
    if (!addBtn && !delBtn) return;
    const rootEl = event.currentTarget;
    const key = msgTargetKey(rootEl);
    if (key !== "send") syncEditMessage();
    const node = key === "send"
      ? flow.nodes.find((n) => n.id === flow.sendNodeId)
      : flow.nodes.find((n) => n.id === flow.editNodeId);
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    const fields = hit.rpc.requestFields || [];
    if (key === "send") {
      // 先同步 DOM，再重新取 bag，避免拿到旧对象
      const task = currentSendTask();
      if (task) task.message = collectMessageFromDom(rootEl, fields);
      else flow.sendMessage = collectMessageFromDom(rootEl, fields);
    }
    const bag = getMsgBag(node, key);

    if (addBtn) {
      const path = parsePath(addBtn.getAttribute("data-flow-rep-add"));
      if (!path) return;
      const field = fieldAtPath(fields, path);
      let list = getByPath(bag, path);
      if (!Array.isArray(list)) {
        list = [];
        setByPath(bag, path, list);
      }
      list.push(field ? sampleItem(field) : "");
      rerenderMsgTree(node, hit, key, oneofPicksFromDom(rootEl));
      return;
    }

    if (delBtn) {
      const path = parsePath(delBtn.getAttribute("data-flow-rep-del"));
      const index = Number(delBtn.getAttribute("data-flow-rep-index"));
      if (!path || !Number.isFinite(index)) return;
      const list = getByPath(bag, path);
      if (!Array.isArray(list)) return;
      list.splice(index, 1);
      rerenderMsgTree(node, hit, key, oneofPicksFromDom(rootEl));
    }
  }

  function handleOneofChange(event) {
    const sel = event.target.closest("[data-flow-oneof-select]");
    if (!sel) return;
    const rootEl = event.currentTarget;
    const key = msgTargetKey(rootEl);
    if (key !== "send") syncEditMessage();
    else {
      const node = flow.nodes.find((n) => n.id === flow.sendNodeId);
      const hit = node ? api()?.findRpc?.(node.rpcId) : null;
      if (hit) {
        const task = currentSendTask();
        const collected = collectMessageFromDom(rootEl, hit.rpc.requestFields || []);
        if (task) task.message = collected;
        else flow.sendMessage = collected;
      }
    }
    const node = key === "send"
      ? flow.nodes.find((n) => n.id === flow.sendNodeId)
      : flow.nodes.find((n) => n.id === flow.editNodeId);
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    const picks = oneofPicksFromDom(rootEl);
    picks[sel.getAttribute("data-flow-oneof-select")] = sel.value;
    const bag = getMsgBag(node, key);
    const parentPath = parsePath(sel.getAttribute("data-flow-oneof-path")) || [];
    const members = parsePath(sel.getAttribute("data-flow-oneof-members")) || [];
    const parent = parentPath.length ? getByPath(bag, parentPath) : bag;
    if (parent && typeof parent === "object") {
      for (const name of members) {
        if (name !== sel.value) delete parent[name];
      }
    }
    rerenderMsgTree(node, hit, key, picks);
  }

  function isBytesField(field) {
    return String(field?.type || "").toLowerCase() === "bytes" && !field?.key;
  }

  function collectBytesFieldPaths(fields, path = [], out = []) {
    for (const group of groupFieldsByOneof(fields || [])) {
      const list = group.kind === "oneof" ? group.fields : [group.field];
      for (const field of list) {
        if (!field) continue;
        const next = [...path, field.name];
        if (isBytesField(field) && !field.repeated) {
          out.push({ key: next.join("."), path: next, field });
        }
        if (!field.repeated && !field.key && isMessageField(field)) {
          collectBytesFieldPaths(fieldTypeDef(field)?.fields || [], next, out);
        }
      }
    }
    return out;
  }

  function syncBytesDecodeFromDom(node) {
    if (!node) return;
    if (!node.bytesDecode || typeof node.bytesDecode !== "object") node.bytesDecode = {};
    if (!Array.isArray(node.decodeExtra)) node.decodeExtra = [];
    const root = $("flowRecvDecodeBody") || document;
    for (const input of root.querySelectorAll("[data-bytes-decode-key]")) {
      const key = input.getAttribute("data-bytes-decode-key");
      if (!key) continue;
      const val = String(input.value || "").trim();
      if (val) node.bytesDecode[key] = val;
      else delete node.bytesDecode[key];
    }
    const nextExtra = [];
    for (const row of root.querySelectorAll("[data-decode-extra-id]")) {
      const id = row.getAttribute("data-decode-extra-id") || uid("dec");
      const path = String(row.querySelector("[data-decode-extra-path]")?.value || "").trim();
      const typeName = String(row.querySelector("[data-decode-extra-type]")?.value || "").trim();
      nextExtra.push({ id, path, typeName });
      if (path && typeName) node.bytesDecode[path] = typeName;
    }
    // 清掉已删除的手动路径（保留自动 bytes 字段）
    const autoKeys = new Set(
      [...root.querySelectorAll("[data-bytes-decode-key]")].map((el) => el.getAttribute("data-bytes-decode-key")),
    );
    const extraPaths = new Set(nextExtra.map((r) => r.path).filter(Boolean));
    for (const key of Object.keys(node.bytesDecode)) {
      if (autoKeys.has(key) || extraPaths.has(key)) continue;
      delete node.bytesDecode[key];
    }
    node.decodeExtra = nextExtra;
  }

  function syncRecvExtractsFromDom(node) {
    if (!node) return;
    if (!node.extracts || typeof node.extracts !== "object") node.extracts = {};
    const root = $("flowRecvExtractBody");
    if (!root) return;
    for (const input of root.querySelectorAll("[data-flow-extract-path]")) {
      const key = input.getAttribute("data-flow-extract-path");
      if (!key) continue;
      const val = String(input.value || "").trim();
      if (val) node.extracts[key] = val;
      else delete node.extracts[key];
    }
  }

  function listMessageTypeNames() {
    const names = new Set();
    for (const item of Object.values(api()?.getAllTypes?.() || {})) {
      if (item?.kind !== "message") continue;
      if (item.name) names.add(item.name);
      if (item.fullName) names.add(item.fullName);
    }
    return [...names].sort();
  }

  function bindMsgTypeCombos(root) {
    if (!root) return;
    const names = listMessageTypeNames();
    for (const input of root.querySelectorAll("[data-bytes-decode-key], [data-decode-extra-type]")) {
      const combo = input.closest(".flow-msg-type-combo");
      const menu = combo?.querySelector(".flow-msg-type-menu");
      if (!combo || !menu || input.dataset.comboBound === "1") continue;
      input.dataset.comboBound = "1";
      input.removeAttribute("list");
      input.setAttribute("autocomplete", "off");

      const hideMenu = () => { menu.hidden = true; };
      const renderMenu = (filter) => {
        const q = String(filter || "").trim().toLowerCase();
        const matched = q
          ? names.filter((n) => n.toLowerCase().includes(q))
          : names;
        if (!matched.length) {
          menu.innerHTML = `<div class="flow-msg-type-empty">无匹配类型</div>`;
        } else {
          menu.innerHTML = matched.map((n) => (
            `<button type="button" class="flow-msg-type-opt" data-value="${esc(n)}">${esc(n)}</button>`
          )).join("");
        }
        menu.hidden = false;
      };

      input.addEventListener("focus", () => renderMenu(input.value));
      input.addEventListener("input", () => renderMenu(input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideMenu();
      });
      input.addEventListener("blur", () => {
        setTimeout(hideMenu, 120);
      });
      menu.addEventListener("mousedown", (event) => {
        const btn = event.target.closest?.("[data-value]");
        if (!btn) return;
        event.preventDefault();
        input.value = btn.getAttribute("data-value") || "";
        hideMenu();
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  function resolvedDecodeMap(cfg) {
    const map = { ...(cfg?.bytesDecode || {}) };
    for (const row of cfg?.decodeExtra || []) {
      const path = String(row?.path || "").trim();
      const typeName = String(row?.typeName || "").trim();
      if (path && typeName) map[path] = typeName;
    }
    const payloadPath = String(cfg?.payloadPath || "").trim();
    const payloadType = String(cfg?.payloadType || "").trim();
    if (payloadPath && payloadType) map[payloadPath] = payloadType;
    return map;
  }

  /** 接收结构体字段一览：点标量填路由字段、点 bytes 填 Payload 字段 */
  function renderRecvDecodeConfig(cfg, hit) {
    const el = $("flowRecvDecodeBody");
    const options = $("flowRoutePathOptions");
    const paths = flattenFieldPaths(hit?.rpc?.responseFields || []);
    if (options) {
      options.innerHTML = paths
        .filter((f) => !f.isMessage)
        .map((f) => `<option value="${esc(f.key)}">${esc(f.type || "")}</option>`)
        .join("");
    }
    if (el) {
      if (!paths.length) {
        el.innerHTML = `<div class="flow-msg-empty">该接口没有响应字段</div>`;
      } else {
        const routePath = String(cfg?.routePath || "").trim();
        const payloadPath = String(cfg?.payloadPath || "").trim();
        el.innerHTML = paths.map((f) => {
          const kind = f.isBytes ? "bytes" : (f.isMessage ? "message" : "scalar");
          const tags = [];
          if (f.key === routePath) tags.push("路由");
          if (f.key === payloadPath) tags.push("Payload");
          if (f.isBytes) tags.push("bytes");
          if (f.isMessage) tags.push("message");
          const active = f.key === routePath || f.key === payloadPath ? " active" : "";
          const clickable = kind === "scalar" || kind === "bytes";
          return `<button type="button" class="flow-struct-row${active}" data-struct-path="${esc(f.key)}" data-struct-kind="${kind}"${clickable ? "" : " disabled"} title="${esc(f.comment || (clickable ? "点击填入路由/Payload 字段" : ""))}">
            <span class="flow-struct-path">${esc(f.key)}</span>
            <span class="flow-struct-type">${esc(f.type || "")}${f.repeated ? " []" : ""}${tags.length ? ` · ${esc(tags.join(" / "))}` : ""}</span>
          </button>`;
        }).join("");
      }
    }
    renderRecvExtractConfig(cfg);
  }

  function renderRecvExtractConfig(cfg) {
    const el = $("flowRecvExtractBody");
    if (!el) return;
    if (!cfg || typeof cfg !== "object") return;
    if (!cfg.extracts || typeof cfg.extracts !== "object") cfg.extracts = {};
    // 新方式：路由任务只解一个 Payload —— 字段树直接从 Payload 类型展开
    const payloadPath = String(cfg.payloadPath || "").trim();
    const payloadType = String(cfg.payloadType || "").trim();
    if (payloadPath && payloadType) {
      const typeDef = api()?.findType?.(payloadType);
      if (!typeDef || typeDef.kind !== "message" || !typeDef.fields?.length) {
        el.innerHTML = `<div class="flow-msg-empty">找不到 Payload 类型 ${esc(payloadType)}</div>`;
        return;
      }
      const basePath = payloadPath.split(".").filter(Boolean);
      el.innerHTML = `<div class="flow-extract-msg">
        <div class="flow-extract-msg-head">
          <strong>${esc(payloadPath)}</strong>
          <span>→ ${esc(typeDef.name || payloadType)}</span>
        </div>
        <div class="flow-extract-children">${renderExtractFields(typeDef.fields, cfg.extracts, basePath, 0)}</div>
      </div>`;
      return;
    }
    // 兼容旧配置：按 bytesDecode 里的多个类型展开
    const entries = Object.entries(resolvedDecodeMap(cfg)).filter(([, typeName]) => String(typeName || "").trim());
    if (!entries.length) {
      el.innerHTML = `<div class="flow-msg-empty">先填 Payload 类型，再展开提取变量</div>`;
      return;
    }
    el.innerHTML = entries.map(([bytesKey, typeName]) => {
      const typeDef = api()?.findType?.(String(typeName).trim());
      if (!typeDef || typeDef.kind !== "message" || !typeDef.fields?.length) {
        return `<div class="flow-extract-msg">
          <div class="flow-extract-msg-head"><strong>${esc(bytesKey)}</strong><span>找不到类型 ${esc(typeName)}</span></div>
        </div>`;
      }
      const basePath = String(bytesKey).split(".").filter(Boolean);
      return `<div class="flow-extract-msg">
        <div class="flow-extract-msg-head">
          <strong>${esc(bytesKey)}</strong>
          <span>→ ${esc(typeDef.name || typeName)}</span>
        </div>
        <div class="flow-extract-children">${renderExtractFields(typeDef.fields, cfg.extracts, basePath, 0)}</div>
      </div>`;
    }).join("");
  }

  /** bytes 值的字节长度（Buffer 对象 / base64 串 / 数组都算） */
  function byteLengthOf(value) {
    if (value == null) return 0;
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value.data)) return value.data.length;
    return 0;
  }

  function bytesPreviewOf(value) {
    const len = byteLengthOf(value);
    let b64 = "";
    try {
      if (typeof value === "string") b64 = value;
      else {
        const bytes = Array.isArray(value) ? value : (Array.isArray(value?.data) ? value.data : null);
        if (bytes) {
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
          }
          b64 = btoa(binary);
        }
      }
    } catch { /* ignore */ }
    const short = b64.length > 96 ? `${b64.slice(0, 96)}…` : b64;
    return `<bytes ${len}> ${short}`;
  }

  function protoFileOf(node) {
    if (!node?.rpcId) return "";
    return api()?.findRpc?.(node.rpcId)?.rpc?.file || "";
  }

  async function decodeMessageBytes(cfg, message, file = "") {
    const map = resolvedDecodeMap(cfg);
    const entries = Object.entries(map)
      .filter(([, typeName]) => String(typeName || "").trim())
      .sort((a, b) => a[0].split(".").length - b[0].split(".").length);
    if (!entries.length) return message;
    const client = api();
    if (!client?.decodeBytes || !message || typeof message !== "object") return message;
    let out;
    try {
      out = JSON.parse(JSON.stringify(message));
    } catch {
      out = message;
    }
    for (const [key, typeName] of entries) {
      const parts = String(key).split(".").filter(Boolean);
      if (!parts.length) continue;
      let cursor = out;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (cursor == null || typeof cursor !== "object") {
          cursor = null;
          break;
        }
        // 大小写不敏感匹配路径段
        if (Object.prototype.hasOwnProperty.call(cursor, parts[i])) {
          cursor = cursor[parts[i]];
        } else {
          const hit = Object.keys(cursor).find((k) => k.toLowerCase() === parts[i].toLowerCase());
          if (hit === undefined) { cursor = null; break; }
          cursor = cursor[hit];
        }
      }
      if (!cursor || typeof cursor !== "object") continue;
      const leafKey = Object.prototype.hasOwnProperty.call(cursor, parts[parts.length - 1])
        ? parts[parts.length - 1]
        : Object.keys(cursor).find((k) => k.toLowerCase() === parts[parts.length - 1].toLowerCase());
      if (leafKey == null || cursor[leafKey] == null) continue;
      const data = cursor[leafKey];
      const decoded = await client.decodeBytes({ typeName, data, file: file || undefined });
      if (decoded?.ok) {
        cursor[leafKey] = decoded.body;
      } else if (decoded?.error) {
        cursor[`${leafKey}__decodeError`] = `${decoded.error}（type=${decoded.typeName || typeName}, bytes ${byteLengthOf(data)}）`;
        // 解析失败时别再把这串数字全铺出来，给个 bytes 预览
        cursor[leafKey] = bytesPreviewOf(data);
      }
    }
    return out;
  }

  const SEND_HISTORY_LIMIT = 8;

  function beginRecvCapture(nodeId) {
    flow.recvCapture = {
      nodeId,
      items: [],
      frozen: false,
    };
  }

  function pushRecvCapture(nodeId, message) {
    const cap = flow.recvCapture;
    if (!cap || cap.nodeId !== nodeId || cap.frozen) return false;
    cap.items.push(message);
    if (cap.items.length >= 3) cap.frozen = true;
    return true;
  }

  function pushSendHistory(node, body, taskName) {
    if (!node) return;
    if (!Array.isArray(node.sendHistory)) node.sendHistory = [];
    let clone = {};
    try { clone = JSON.parse(JSON.stringify(body ?? {})); }
    catch { clone = body && typeof body === "object" ? { ...body } : {}; }
    node.sendHistory.unshift({
      id: uid("sh"),
      at: Date.now(),
      task: String(taskName || ""),
      body: clone,
    });
    if (node.sendHistory.length > SEND_HISTORY_LIMIT) {
      node.sendHistory.length = SEND_HISTORY_LIMIT;
    }
  }

  function formatHistoryTimeShort(ts) {
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return "";
    }
  }

  function refreshSendHistoryPanel() {
    const node = flow.nodes.find((n) => n.id === flow.sendNodeId);
    const el = $("flowSendHistoryBody");
    const hint = $("flowSendHistoryHint");
    if (!el) return;
    const list = Array.isArray(node?.sendHistory) ? node.sendHistory : [];
    if (!list.length) {
      el.textContent = "发送后会出现在这里，可点「应用到当前任务」复用";
      if (hint) hint.textContent = "";
      return;
    }
    if (hint) hint.textContent = `${list.length} 条`;
    el.innerHTML = list.map((item, index) => {
      const preview = (() => {
        try {
          const text = JSON.stringify(item.body ?? {}, null, 2);
          return text.length > 400 ? `${text.slice(0, 400)}…` : text;
        } catch {
          return "";
        }
      })();
      return `<article class="flow-recv-live-item">
        <div class="h">
          <span>#${index + 1}${item.task ? ` · ${esc(item.task)}` : ""} · ${esc(formatHistoryTimeShort(item.at))}</span>
          <button type="button" data-apply-send="${esc(item.id)}">应用到当前任务</button>
        </div>
        <pre>${esc(preview)}</pre>
      </article>`;
    }).join("");
  }

  // ===== 发送任务：建流后按延迟自动发；每个任务各自带解析与变量赋值 =====

  function currentSendNode() {
    return flow.nodes.find((n) => n.id === flow.sendNodeId) || null;
  }

  function ensureSendTasks(node) {
    if (!node) return [];
    node.sendTasks = normalizeSendTasks(node.sendTasks);
    return node.sendTasks;
  }

  function currentSendTask() {
    const node = currentSendNode();
    if (!node) return null;
    return ensureSendTasks(node).find((task) => task.id === flow.sendTaskId) || null;
  }

  function activeSendTask(node) {
    if (!node) return null;
    return ensureSendTasks(node).find((task) => task.id === flow.activeTaskId) || null;
  }

  /** 回包解析/取值用哪个配置：先按 EventType 匹配到任务，其次本次发送的任务，最后节点级 */
  function recvConfigFor(node, message) {
    const candidates = message != null ? recvTaskCandidates(node, message) : [];
    return candidates[0] || activeSendTask(node) || node || null;
  }

  /** 从一个对象上取事件类型字段（EventType / Type / event_type …） */
  function pickEventType(obj) {
    if (!obj || typeof obj !== "object") return "";
    const wanted = ["EventType", "EventName", "eventtype", "event_type", "Type", "Event"];
    const keys = Object.keys(obj);
    for (const want of wanted) {
      const hit = keys.find((key) => key.toLowerCase() === want.toLowerCase());
      if (!hit) continue;
      const value = obj[hit];
      if (value == null) continue;
      if (typeof value === "object") {
        // 枚举常以 { name } / { value } 形式出现
        const nested = value.name ?? value.Name ?? value.value ?? value.Value;
        if (nested != null && String(nested).trim()) return String(nested).trim();
        continue;
      }
      const text = String(value).trim();
      if (text) return text;
    }
    return "";
  }

  /** 取这条消息的事件类型：先看顶层，再往里找一层（如 EventData.EventType） */
  function messageEventType(message) {
    const top = pickEventType(message);
    if (top) return top;
    if (!message || typeof message !== "object") return "";
    for (const key of Object.keys(message)) {
      const value = message[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const nested = pickEventType(value);
      if (nested) return nested;
    }
    return "";
  }

  /** 读任务的路由值：优先按配置的字段路径取，没配/取不到就按字段名启发式 */
  function taskRouteValue(task, message) {
    const path = String(task?.routePath || "").trim();
    if (!path) return messageEventType(message);
    const value = valueAtDotted(message, path);
    if (value == null) return messageEventType(message);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  /** 候选任务：先按路由值命中的，再没填路由值的，最后其它配了 Payload 类型的 */
  function recvTaskCandidates(node, message) {
    if (!node) return [];
    const matched = [];
    const loose = [];
    const rest = [];
    for (const task of ensureSendTasks(node)) {
      if (!String(task.payloadType || "").trim()) continue;
      const want = String(task.routeValue || "").trim();
      const got = String(taskRouteValue(task, message)).trim();
      if (want && got && want.toLowerCase() === got.toLowerCase()) matched.push(task);
      else if (!want) loose.push(task);
      else rest.push(task);
    }
    return [...matched, ...loose, ...rest];
  }

  /** 全部候选都失败时，把其它类型也失败的信息并进第一条错误，便于定位 */
  function annotateDecodeErrors(decoded, notes) {
    if (!decoded || typeof decoded !== "object" || !notes.length) return;
    const walk = (obj, depth) => {
      if (!obj || typeof obj !== "object" || depth > 5) return false;
      for (const [key, value] of Object.entries(obj)) {
        if (key.endsWith("__decodeError")) {
          obj[key] = `${value}；其它尝试也失败：${notes.join(" / ")}`;
          return true;
        }
        if (value && typeof value === "object" && walk(value, depth + 1)) return true;
      }
      return false;
    };
    walk(decoded, 0);
  }

  /** 按候选顺序解析：第一个能解出结构的类型才算命中，避免“第一个任务兜底”吃错类型 */
  async function decodeRecvMessage(node, message) {
    const candidates = recvTaskCandidates(node, message);
    if (!candidates.length) {
      return { cfg: node, decoded: await decodeMessageBytes(node, message, protoFileOf(node)) };
    }
    let first = null;
    const tried = [];
    for (const task of candidates) {
      const decoded = await decodeMessageBytes(task, message, protoFileOf(node));
      const errors = collectDecodeErrors(decoded);
      if (!first) first = { cfg: task, decoded };
      if (!errors.length) return { cfg: task, decoded };
      tried.push(`${task.name || "任务"}=${task.payloadType}：${errors[0]}`);
    }
    if (first) annotateDecodeErrors(first.decoded, tried);
    return first;
  }

  function syncCurrentSendTaskFromDom() {
    const node = currentSendNode();
    const task = currentSendTask();
    if (!node || !task) return null;
    // 弹窗没开时 DOM 是空的，别用它覆盖已存配置
    if (!$("flowSendModal")?.classList.contains("show")) return task;
    if ($("flowSendTaskEditor")?.classList.contains("hidden")) return task;
    const hit = api()?.findRpc?.(node.rpcId);
    const name = ($("flowSendTaskName")?.value || "").trim();
    if (name) task.name = name;
    const delayRaw = $("flowSendTaskDelay")?.value;
    task.delaySec = delayRaw === "" || delayRaw == null ? "" : Number(delayRaw);
    task.recvOnly = Boolean($("flowSendTaskRecvOnly")?.checked);
    task.routePath = $("flowSendTaskRoutePath")?.value || "";
    task.routeValue = $("flowSendTaskRouteValue")?.value || "";
    task.payloadPath = $("flowSendTaskPayloadPath")?.value || "";
    task.payloadType = $("flowSendTaskPayloadType")?.value || "";
    if (!task.recvOnly) {
      task.message = collectMessageFromDom($("flowSendMsgBody"), hit?.rpc?.requestFields || []);
    }
    syncRecvExtractsFromDom(task);
    return task;
  }

  function renderSendTaskList(node) {
    const el = $("flowSendTaskList");
    if (!el) return;
    const tasks = ensureSendTasks(node);
    const hint = $("flowSendTaskHint");
    if (hint) hint.textContent = tasks.length ? `${tasks.length} 个` : "";
    if (!tasks.length) {
      el.innerHTML = `<div class="flow-msg-empty">还没有任务</div>`;
      return;
    }
    el.innerHTML = tasks.map((task) => {
      const delay = task.delaySec === "" || task.delaySec == null ? "" : `${task.delaySec}s`;
      const cls = task.id === flow.sendTaskId ? " active" : "";
      const badge = task.recvOnly ? "仅解析" : (delay || "手动");
      const routeHint = task.routeValue ? ` · 路由 ${task.routeValue}` : "";
      return `<div class="flow-task-item${cls}${task.recvOnly || !delay ? " manual" : ""}" data-send-task="${esc(task.id)}" title="${esc((task.name || "任务") + routeHint)}">
        <span class="flow-task-name" title="${esc(task.name || "")}">${esc(task.name || "任务")}</span>
        <span class="flow-task-delay">${esc(task.recvOnly && task.routeValue ? `路由 ${task.routeValue}` : badge)}</span>
        <button type="button" class="link danger" data-send-task-del="${esc(task.id)}" title="删除任务">✕</button>
      </div>`;
    }).join("");
  }

  /** 勾了「只做接收解析」时隐藏发送区与发送按钮 */
  function syncTaskSendVisibility(task) {
    const recvOnly = Boolean(task?.recvOnly);
    $("flowSendTaskSendSection")?.classList.toggle("hidden", recvOnly);
    $("flowSendTaskSendBtn")?.classList.toggle("hidden", recvOnly);
  }

  function renderSendTaskEditor(node, hit) {
    const task = currentSendTask();
    const editor = $("flowSendTaskEditor");
    const empty = $("flowSendTaskEmpty");
    const msgBody = $("flowSendMsgBody");
    const decodeBody = $("flowRecvDecodeBody");
    const extractBody = $("flowRecvExtractBody");
    if (!task) {
      editor?.classList.add("hidden");
      empty?.classList.remove("hidden");
      if (msgBody) msgBody.innerHTML = "";
      if (decodeBody) decodeBody.innerHTML = "";
      if (extractBody) extractBody.innerHTML = "";
      return;
    }
    editor?.classList.remove("hidden");
    empty?.classList.add("hidden");
    if ($("flowSendTaskName")) $("flowSendTaskName").value = task.name || "";
    if ($("flowSendTaskDelay")) {
      $("flowSendTaskDelay").value = task.delaySec === "" || task.delaySec == null ? "" : String(task.delaySec);
    }
    if ($("flowSendTaskRecvOnly")) $("flowSendTaskRecvOnly").checked = Boolean(task.recvOnly);
    // 路由 / Payload 字段留空时按响应结构自动猜一次
    const guessed = guessRouteFields(hit);
    if (!task.routePath) task.routePath = guessed.routePath;
    if (!task.payloadPath) task.payloadPath = guessed.payloadPath;
    if ($("flowSendTaskRoutePath")) $("flowSendTaskRoutePath").value = task.routePath || "";
    if ($("flowSendTaskRouteValue")) $("flowSendTaskRouteValue").value = task.routeValue || "";
    if ($("flowSendTaskPayloadPath")) $("flowSendTaskPayloadPath").value = task.payloadPath || "";
    if ($("flowSendTaskPayloadType")) $("flowSendTaskPayloadType").value = task.payloadType || "";
    syncTaskSendVisibility(task);
    if (msgBody) msgBody.innerHTML = renderFields(hit?.rpc?.requestFields || [], task.message || {});
    renderRecvDecodeConfig(task, hit);
  }

  function selectSendTask(taskId) {
    const node = currentSendNode();
    if (!node) return;
    syncCurrentSendTaskFromDom();
    flow.sendTaskId = taskId;
    const hit = api()?.findRpc?.(node.rpcId);
    renderSendTaskList(node);
    renderSendTaskEditor(node, hit);
    commit();
    void refreshRecvLivePanel();
  }

  function addSendTask() {
    const node = currentSendNode();
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    syncCurrentSendTaskFromDom();
    const tasks = ensureSendTasks(node);
    const message = {};
    for (const group of groupFieldsByOneof(hit.rpc.requestFields || [])) {
      const field = group.kind === "oneof" ? group.fields[0] : group.field;
      if (!field) continue;
      try { message[field.name] = api()?.sampleField?.(field) ?? ""; }
      catch { message[field.name] = ""; }
    }
    const guessed = guessRouteFields(hit);
    const task = {
      id: uid("task"),
      name: `任务${tasks.length + 1}`,
      delaySec: "",
      recvOnly: tasks.length > 0,
      routePath: guessed.routePath,
      routeValue: "",
      payloadPath: guessed.payloadPath,
      payloadType: "",
      message,
      bytesDecode: {},
      decodeExtra: [],
      extracts: {},
    };
    tasks.push(task);
    flow.sendTaskId = task.id;
    renderSendTaskList(node);
    renderSendTaskEditor(node, hit);
    commit();
  }

  function deleteSendTask(taskId) {
    const node = currentSendNode();
    if (!node) return;
    node.sendTasks = ensureSendTasks(node).filter((task) => task.id !== taskId);
    if (flow.sendTaskId === taskId) flow.sendTaskId = node.sendTasks[0]?.id || null;
    if (flow.activeTaskId === taskId) flow.activeTaskId = null;
    const hit = api()?.findRpc?.(node.rpcId);
    renderSendTaskList(node);
    renderSendTaskEditor(node, hit);
    commit();
  }

  async function ensureNodeStream(node, hit, openBody) {
    const client = api();
    if (!client?.streamOpen) return null;
    if (node.streamId) return node.streamId;
    const metadata = {};
    for (const row of node.metadata || []) {
      const name = (row.name || "").trim();
      if (!name) continue;
      metadata[name] = row.value || "";
    }
    node.result = { ok: true, status: "连接中", ms: 0, streaming: true };
    render();
    const opened = await client.streamOpen({
      protocol: "grpc",
      host: client.resolveHost?.(node.envId) || "",
      package: hit.pkg.name,
      service: hit.service.name,
      method: hit.rpc.name,
      file: hit.rpc.file,
      body: openBody || {},
      metadata,
    });
    if (!opened.ok || !opened.streamId) {
      node.result = { ok: false, status: opened.status || "ERROR", ms: opened.ms, error: opened.error };
      render();
      return null;
    }
    node.streamId = opened.streamId;
    node.lastStreamId = opened.streamId;
    node.streamMessages = node.streamMessages || [];
    node.result = {
      ok: true,
      status: "CONNECTED",
      ms: opened.ms,
      body: node.streamMessages,
      streaming: true,
      streamClosed: false,
    };
    const hbBody = buildBody(
      node.heartbeatMessage && Object.keys(node.heartbeatMessage).length ? node.heartbeatMessage : (openBody || {}),
      {},
      hit.rpc.requestFields || [],
    );
    startNodeHeartbeat(node, hbBody);
    render();
    return node.streamId;
  }

  async function harvestExtractsFromMessage(node, message) {
    if (!node || message == null) return;
    const { cfg, decoded } = await decodeRecvMessage(node, message);
    const vars = { ...(flow.sharedVars || {}) };
    const applied = applyExtracts(cfg || node, decoded, vars);
    flow.sharedVars = vars;
    recordStepVars(ownerStepIdFor(node), applied);
    updateVarsBadge();
  }

  /** 收集解析失败标记（decoded 里 xxx__decodeError） */
  function collectDecodeErrors(decoded) {
    const out = [];
    const walk = (obj, depth) => {
      if (!obj || typeof obj !== "object" || depth > 5) return;
      for (const [key, value] of Object.entries(obj)) {
        if (key.endsWith("__decodeError")) {
          out.push(`${key.slice(0, -"__decodeError".length)} → ${value}`);
        } else if (value && typeof value === "object") {
          walk(value, depth + 1);
        }
      }
    };
    walk(decoded, 0);
    return out;
  }

  async function refreshRecvLivePanel() {
    const node = currentSendNode();
    const live = $("flowRecvLiveBody");
    const hint = $("flowRecvLiveHint");
    if (!live) return;
    if (!node) {
      live.textContent = "暂无接收数据";
      if (hint) hint.textContent = "";
      return;
    }
    if ($("flowSendModal")?.classList.contains("show")) syncCurrentSendTaskFromDom();
    const cap = flow.recvCapture && flow.recvCapture.nodeId === node.id ? flow.recvCapture : null;
    const all = Array.isArray(node.streamMessages) ? node.streamMessages : [];
    // 没有「本次发送」的捕获时（例如只做接收解析的任务），也把最近收到的显示出来
    const raw = cap ? cap.items : all.slice(-3);
    const base = cap ? 0 : Math.max(0, all.length - raw.length);
    // 与「响应历史」一致：最新的在最上面
    const list = raw.length > 1 ? [...raw].reverse() : raw;
    if (!list.length) {
      live.textContent = cap
        ? (cap.frozen ? "本次发送暂无回包" : "已发送，等待接收…")
        : "还没收到消息：任务里配好「接收路由」后，收到匹配的消息会在这里解析";
      if (hint) hint.textContent = "";
      return;
    }
    const cards = [];
    let lastCfg = null;
    for (let i = 0; i < list.length; i += 1) {
      const { cfg, decoded } = await decodeRecvMessage(node, list[i]);
      lastCfg = cfg;
      // 用最新一条回包（倒序后的第一条）刷新共享变量（含 Payload 内字段）
      if (i === 0) {
        const vars = { ...(flow.sharedVars || {}) };
        const applied = applyExtracts(cfg || node, decoded, vars);
        flow.sharedVars = vars;
        recordStepVars(ownerStepIdFor(node), applied);
        updateVarsBadge();
      }
      const seq = base + raw.length - i;
      const routeWant = cfg !== node ? String(cfg.routeValue || "").trim() : "";
      const routeGot = cfg !== node ? String(taskRouteValue(cfg, list[i])).trim() : "";
      const byFallback = Boolean(routeWant) && routeWant.toLowerCase() !== routeGot.toLowerCase();
      const typeTag = cfg !== node
        ? `<span>${esc(cfg.name || "任务")}${String(cfg.payloadType || "").trim() ? ` → ${esc(cfg.payloadType)}` : ""}${byFallback ? " · 兜底" : ""}</span>`
        : `<span>未命中任务</span>`;
      const errors = collectDecodeErrors(decoded);
      const errLine = errors.length
        ? `<div class="flow-recv-err">解析失败：${esc(errors.join("；"))}</div>`
        : "";
      cards.push(`<article class="flow-recv-live-item">
        <div class="h"><span>接收 #${seq}${i === 0 ? " · 最新" : ""}</span>${typeTag}<span>${cap?.frozen && i === list.length - 1 ? "已固定" : ""}</span></div>
        ${errLine}
        <pre>${esc(JSON.stringify(decoded, null, 2))}</pre>
      </article>`);
    }
    if (hint) {
      const taskName = lastCfg && lastCfg !== node ? `${lastCfg.name} · ` : "";
      hint.textContent = `${taskName}${list.length} 条${cap ? (cap.frozen ? " · 已固定" : " · 接收中") : " · 最近接收"}`;
    }
    live.innerHTML = cards.join("");
  }

  function applySendHistoryToForm(historyId) {
    const node = currentSendNode();
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    const item = (node.sendHistory || []).find((row) => row.id === historyId);
    if (!item) return;
    const task = currentSendTask();
    if (!task) return;
    try {
      task.message = JSON.parse(JSON.stringify(item.body ?? {}));
    } catch {
      task.message = item.body && typeof item.body === "object" ? { ...item.body } : {};
    }
    $("flowSendMsgBody").innerHTML = renderFields(hit.rpc.requestFields || [], task.message);
    commit();
  }

  function openSendModal(nodeId) {
    const node = flow.nodes.find((n) => n.id === nodeId);
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    if (!node || !hit) return;
    flow.sendNodeId = nodeId;
    const tasks = ensureSendTasks(node);
    if (!flow.sendTaskId || !tasks.some((task) => task.id === flow.sendTaskId)) {
      flow.sendTaskId = tasks[0]?.id || null;
    }
    $("flowSendTitle").textContent = `收发消息 · ${node.name || hit.rpc.name}`;
    renderSendTaskList(node);
    renderSendTaskEditor(node, hit);
    // 打开弹窗不沿用上一次捕获；等发送后再开始收
    if (!flow.recvCapture || flow.recvCapture.nodeId !== nodeId) {
      flow.recvCapture = null;
    }
    refreshSendHistoryPanel();
    void refreshRecvLivePanel();
    $("flowSendModal")?.classList.add("show");
  }

  function scheduleNodeSendTasks(node, vars) {
    if (!node) return;
    stopNodeSendTasks(node);
    const hit = api()?.findRpc?.(node.rpcId);
    const fields = hit?.rpc?.requestFields || [];
    for (const task of ensureSendTasks(node)) {
      if (task.recvOnly) continue;
      if (task.delaySec === "" || task.delaySec == null) continue;
      const delay = Number(task.delaySec);
      if (!Number.isFinite(delay) || delay < 0) continue;
      const timer = setTimeout(async () => {
        const client = api();
        if (!node.streamId || !client?.streamWrite) return;
        flow.activeTaskId = task.id;
        beginRecvCapture(node.id);
        try {
          const body = buildBody(task.message || {}, vars || {}, fields);
          const wr = await client.streamWrite(node.streamId, body);
          if (!wr?.ok) return;
          pushSendHistory(node, body, task.name);
          render();
          if (flow.sendNodeId === node.id && $("flowSendModal")?.classList.contains("show")) {
            refreshSendHistoryPanel();
          }
        } catch { /* ignore */ }
      }, Math.round(delay * 1000));
      node.sendTimers.push(timer);
    }
  }

  function stopNodeSendTasks(node) {
    if (!node) return;
    for (const timer of Array.isArray(node.sendTimers) ? node.sendTimers : []) {
      clearTimeout(timer);
    }
    node.sendTimers = [];
  }

  function clearSendHistory() {
    const node = currentSendNode();
    if (!node) return;
    node.sendHistory = [];
    save();
    refreshSendHistoryPanel();
  }

  function clearRecvCapture() {
    const node = currentSendNode();
    if (!node) return;
    flow.recvCapture = null;
    node.streamMessages = [];
    node.streamMessageIds = [];
    node.result = { ...(node.result || {}), body: [] };
    save();
    render();
    void refreshRecvLivePanel();
  }

  /** 清空该节点的接收记录 + 运行历史（响应历史弹窗用） */
  function clearFlowHistory() {
    const node = flow.nodes.find((n) => n.id === flow.historyNodeId);
    if (!node) return;
    node.history = [];
    node.streamMessages = [];
    node.streamMessageIds = [];
    if (flow.recvCapture && flow.recvCapture.nodeId === node.id) flow.recvCapture = null;
    if (node.result && typeof node.result === "object") {
      node.result = { ...node.result, body: [] };
    }
    flow.historySelectedId = null;
    save();
    render();
    void renderHistoryModal();
    if (flow.sendNodeId === node.id) void refreshRecvLivePanel();
  }

  // ===== 链路变量查看（按起始步骤） =====

  /** 顶栏角标已移除；保留空实现，避免其它调用点报错 */
  function updateVarsBadge() { /* no-op */ }

  function varsStep() {
    if (!flow.varsStepId) return null;
    return flow.nodes.find((n) => n.id === flow.varsStepId && isStartNode(n)) || null;
  }

  function renderVarsModal() {
    const el = $("flowVarsBody");
    if (!el) return;
    const step = varsStep();
    const vars = step ? (step.vars || {}) : {};
    const keys = Object.keys(vars).sort((a, b) => a.localeCompare(b));
    const title = $("flowVarsTitle");
    if (title) {
      const name = step ? (step.name || "起始步骤") : "变量";
      title.textContent = `${name} · 变量（${keys.length}）`;
    }
    if (!keys.length) {
      el.innerHTML = `<div class="flow-msg-empty">这个步骤还没有变量：在任务的「解析后变量赋值」里填变量名，运行/收到对应消息后就会写到这里</div>`;
      return;
    }
    el.innerHTML = keys.map((key) => {
      let text;
      try {
        text = typeof vars[key] === "string" ? vars[key] : JSON.stringify(vars[key], null, 2);
      } catch {
        text = String(vars[key]);
      }
      return `<div class="flow-var-row">
        <div class="flow-var-key">${esc(key)}</div>
        <pre class="flow-var-value">${esc(text ?? "")}</pre>
      </div>`;
    }).join("");
  }

  function openVarsModal(stepId) {
    const step = flow.nodes.find((n) => n.id === stepId && isStartNode(n));
    if (!step) {
      void notify("请从起始步骤节点上的「变量」按钮打开");
      return;
    }
    flow.varsStepId = step.id;
    renderVarsModal();
    $("flowVarsModal")?.classList.add("show");
  }

  function clearVars() {
    const step = varsStep();
    if (!step) return;
    step.vars = {};
    step.varsAt = 0;
    for (const key of Object.keys(flow.sharedVars || {})) {
      // 只清掉该步骤产出且没有别的步骤在用的变量
      const usedElsewhere = flow.nodes.some((n) => (
        n.id !== step.id && isStartNode(n) && n.vars && Object.prototype.hasOwnProperty.call(n.vars, key)
      ));
      if (!usedElsewhere) delete flow.sharedVars[key];
    }
    save();
    render();
    renderVarsModal();
  }

  // ===== 步骤压测 =====

  function rpcNodesOfStep(stepId) {
    const ids = flow.edges.filter((e) => e.from === stepId).map((e) => e.to);
    const out = [];
    const seen = new Set();
    const queue = [...ids];
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = flow.nodes.find((n) => n.id === id);
      if (!node) continue;
      if (!isStartNode(node)) out.push(node);
      for (const edge of flow.edges.filter((e) => e.from === id)) queue.push(edge.to);
    }
    return out;
  }

  function nodeInvokePayload(node, hit) {
    const metadata = {};
    for (const row of node.metadata || []) {
      const name = (row.name || "").trim();
      if (!name) continue;
      metadata[name] = row.value || "";
    }
    const protocol = normalizeNodeProtocol(node.protocol);
    return {
      protocol,
      httpMethod: node.httpMethod || (protocol === "sse" ? "GET" : "POST"),
      httpPath: node.httpPath || "/",
      host: api()?.resolveHost?.(node.envId) || "",
      package: hit.pkg.name,
      service: hit.service.name,
      method: hit.rpc.name,
      file: hit.rpc.file,
      body: buildBody(node.message || {}, {}, hit.rpc.requestFields || []),
      metadata,
      tls: false,
    };
  }

  function flowStressNodeEntry() {
    const sel = $("flowStressNode");
    const nodeId = sel?.value || "";
    const node = flow.nodes.find((n) => n.id === nodeId);
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    return node && hit ? { node, hit } : null;
  }

  function syncFlowStressGhzUi() {
    const entry = flowStressNodeEntry();
    const protocol = entry ? normalizeNodeProtocol(entry.node.protocol) : "grpc";
    const ghzBtn = document.querySelector('#flowStressModes [data-flow-stress-mode="ghz"]');
    if (ghzBtn) ghzBtn.classList.toggle("hidden", protocol !== "grpc");
    if (protocol !== "grpc" && flow.stressMode === "ghz") setFlowStressMode("light");
    const area = $("flowStressGhzCommand");
    if (area) area.value = buildFlowGhzCommand();
    $("flowStressLight")?.classList.toggle("hidden", flow.stressMode !== "light");
    $("flowStressGhz")?.classList.toggle("hidden", flow.stressMode !== "ghz");
    for (const btn of document.querySelectorAll("[data-flow-stress-mode]")) {
      btn.classList.toggle("active", btn.getAttribute("data-flow-stress-mode") === flow.stressMode);
    }
  }

  function setFlowStressMode(mode) {
    flow.stressMode = mode === "ghz" ? "ghz" : "light";
    syncFlowStressGhzUi();
  }

  function buildFlowGhzArgs() {
    const entry = flowStressNodeEntry();
    if (!entry || normalizeNodeProtocol(entry.node.protocol) !== "grpc") return null;
    const payload = nodeInvokePayload(entry.node, entry.hit);
    const concurrency = Math.max(1, Number($("flowStressGhzConcurrency")?.value || 20));
    const total = Math.max(1, Number($("flowStressGhzTotal")?.value || 200));
    const args = ["--insecure", "-c", String(concurrency), "-n", String(total), "-d", JSON.stringify(payload.body)];
    for (const [name, value] of Object.entries(payload.metadata || {})) {
      args.push("-m", `${name}: ${value}`);
    }
    const protoFile = entry.hit.rpc.file || "";
    if (protoFile) {
      args.push("-proto", protoFile);
      args.push("-i", protoFile.replace(/[\\/][^\\/]+$/, "") || ".");
    }
    args.push(payload.host || "127.0.0.1:50051", `${entry.hit.pkg.name}.${entry.hit.service.name}/${entry.hit.rpc.name}`);
    return args;
  }

  function buildFlowGhzCommand() {
    const args = buildFlowGhzArgs();
    if (!args) return "# 仅 gRPC 支持 ghz";
    const binary = ($("flowStressGhzPath")?.value || "").trim() || "ghz";
    const quote = (text) => (/[\s"]/g.test(text) ? `"${String(text).replace(/"/g, '\\"')}"` : text);
    return [binary, ...args].map(quote).join(" ");
  }

  function openFlowStress(stepId) {
    const step = flow.nodes.find((n) => n.id === stepId && isStartNode(n));
    if (!step) return;
    const nodes = rpcNodesOfStep(stepId);
    if (!nodes.length) {
      void notify("这个步骤还没有连接口，先拖一个接口进来");
      return;
    }
    flow.stressStepId = stepId;
    flow.stressMode = "light";
    flow.stressAbort = false;
    const sel = $("flowStressNode");
    if (sel) {
      sel.innerHTML = nodes.map((node) => {
        const hit = api()?.findRpc?.(node.rpcId);
        const label = hit ? `${hit.rpc.name}（${hit.pkg.name}.${hit.service.name}）` : (node.name || node.rpcId);
        return `<option value="${esc(node.id)}">${esc(label)}</option>`;
      }).join("");
    }
    if ($("flowStressTitle")) $("flowStressTitle").textContent = `压测 · ${step.name || "步骤"}`;
    if ($("flowStressResult")) $("flowStressResult").innerHTML = "";
    $("flowStressProgressWrap")?.classList.add("hidden");
    try { if ($("flowStressGhzPath")) $("flowStressGhzPath").value = localStorage.getItem("protoview.client.ghzPath") || ""; } catch { /* ignore */ }
    syncFlowStressGhzUi();
    $("flowStressModal")?.classList.add("show");
  }

  function flowStressStat(label, value) {
    return `<div class="stress-stat"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`;
  }

  function setFlowStressRunning(running) {
    if ($("flowStressStart")) $("flowStressStart").disabled = running;
    if ($("flowStressStop")) $("flowStressStop").disabled = !running || flow.stressMode === "ghz";
  }

  async function runFlowLightStress() {
    const entry = flowStressNodeEntry();
    const client = api();
    if (!entry || !client?.invokeOnce) return;
    const concurrency = Math.min(10, Math.max(1, Number($("flowStressConcurrency")?.value || 1)));
    const total = Math.min(200, Math.max(1, Number($("flowStressTotal")?.value || 1)));
    const payload = nodeInvokePayload(entry.node, entry.hit);
    const resultBox = $("flowStressResult");
    const wrap = $("flowStressProgressWrap");
    wrap?.classList.remove("hidden");
    if (resultBox) resultBox.innerHTML = "";
    flow.stressAbort = false;
    setFlowStressRunning(true);
    const startedAt = Date.now();
    const samples = [];
    let next = 0;
    let ok = 0;
    let fail = 0;
    const tick = () => {
      const done = samples.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      if ($("flowStressProgressBar")) $("flowStressProgressBar").style.width = `${pct}%`;
      if ($("flowStressProgressText")) $("flowStressProgressText").textContent = `${done}/${total} · 成功 ${ok} · 失败 ${fail}`;
    };
    const worker = async () => {
      while (!flow.stressAbort) {
        const index = next;
        if (index >= total) return;
        next += 1;
        const t0 = performance.now();
        let res;
        try {
          res = await client.invokeOnce(payload);
        } catch (error) {
          res = { ok: false, status: "ERROR", error: error?.message || String(error) };
        }
        const ms = res?.ms ?? Math.round(performance.now() - t0);
        if (res?.ok) ok += 1;
        else fail += 1;
        samples.push({
          index,
          ok: Boolean(res?.ok),
          status: res?.status || (res?.ok ? "OK" : "ERROR"),
          ms: Number(ms) || 0,
          error: res?.error || "",
        });
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    const durationMs = Math.max(1, Date.now() - startedAt);
    const latencies = samples.map((item) => item.ms).sort((a, b) => a - b);
    const pick = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);
    const summary = {
      total: samples.length,
      ok,
      fail,
      durationMs,
      rps: Math.round((samples.length / durationMs) * 1000 * 10) / 10,
      avgMs: latencies.length ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : 0,
      p50Ms: pick(50),
      p95Ms: pick(95),
      p99Ms: pick(99),
      minMs: latencies[0] || 0,
      maxMs: latencies[latencies.length - 1] || 0,
    };
    setFlowStressRunning(false);
    if (!resultBox) return;
    const stats = [
      flowStressStat("总数", summary.total),
      flowStressStat("成功", summary.ok),
      flowStressStat("失败", summary.fail),
      flowStressStat("耗时", `${summary.durationMs} ms`),
      flowStressStat("RPS", summary.rps),
      flowStressStat("平均", `${summary.avgMs} ms`),
      flowStressStat("P50", `${summary.p50Ms} ms`),
      flowStressStat("P95", `${summary.p95Ms} ms`),
      flowStressStat("P99", `${summary.p99Ms} ms`),
      flowStressStat("最小", `${summary.minMs} ms`),
      flowStressStat("最大", `${summary.maxMs} ms`),
    ].join("");
    const rows = samples.slice(0, 50).map((item) => `<tr>
      <td>#${item.index + 1}</td>
      <td class="${item.ok ? "stress-ok" : "stress-fail"}">${esc(item.status)}</td>
      <td>${item.ms} ms</td>
      <td>${esc(item.error || "")}</td>
    </tr>`).join("");
    resultBox.innerHTML = `
      <div class="stress-stats">${stats}</div>
      ${flow.stressAbort ? `<p class="stress-note">已停止，以下为已完成样本。</p>` : ""}
      <table class="stress-samples">
        <thead><tr><th>#</th><th>状态</th><th>延迟</th><th>错误</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">无样本</td></tr>`}</tbody>
      </table>`;
  }

  function runFlowGhz() {
    const args = buildFlowGhzArgs();
    if (!args) {
      void notify("ghz 仅支持 gRPC 接口");
      return;
    }
    const id = `flowghz-${Date.now()}`;
    flow.ghzId = id;
    flow.ghzLog = "";
    const box = $("flowStressResult");
    if (box) box.innerHTML = `<pre class="stress-log" id="flowGhzLog">启动 ghz…\n</pre>`;
    setFlowStressRunning(true);
    const binary = ($("flowStressGhzPath")?.value || "").trim() || "ghz";
    try { localStorage.setItem("protoview.client.ghzPath", binary); } catch { /* ignore */ }
    if (!api()?.postHost?.("runGhz", { id, args, binary })) {
      if (box) box.innerHTML = `<div class="stress-empty stress-fail">需要在 VS Code Client 里运行 ghz</div>`;
      setFlowStressRunning(false);
    }
  }

  // ===== 画布模板 =====

  const TPL_KEY = "protoview.client.flow.templates";

  function loadUserTemplates() {
    try {
      const raw = JSON.parse(localStorage.getItem(TPL_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveUserTemplates(list) {
    try {
      localStorage.setItem(TPL_KEY, JSON.stringify(list.slice(0, 30)));
    } catch { /* ignore */ }
  }

  /** 模板里的接口按「包.服务/方法」重新映射到当前工程的 rpcId */
  function remapTemplateRpcs(nodes) {
    const rpcs = api()?.listRpcs?.() || [];
    if (!rpcs.length) return nodes;
    const byFull = new Map();
    const byName = new Map();
    for (const item of rpcs) {
      byFull.set(`${item.package}.${item.service}/${item.name}`.toLowerCase(), item);
      if (!byName.has(item.name)) byName.set(item.name, item);
    }
    for (const node of nodes) {
      if (!node || node.kind !== "rpc") continue;
      if (api()?.findRpc?.(node.rpcId)) continue;
      const fullKey = `${node.package || ""}/${node.name || ""}`.toLowerCase();
      const target = byFull.get(fullKey) || byName.get(node.name) || null;
      if (target) {
        node.rpcId = target.id;
        node.package = `${target.package}.${target.service}`;
        if (target.file) node.file = target.file;
      }
    }
    return nodes;
  }

  function renderFlowTplList() {
    const el = $("flowTplList");
    if (!el) return;
    const builtins = (Array.isArray(window.ProtoViewFlowTemplates) ? window.ProtoViewFlowTemplates : [])
      .filter((tpl) => {
        if (!tpl?.requiresRpc) return true;
        const rpcs = api()?.listRpcs?.() || [];
        return rpcs.some((item) => item.name === tpl.requiresRpc);
      });
    const users = loadUserTemplates();
    const items = [
      ...builtins.map((tpl) => ({ ...tpl, builtin: true })),
      ...users.map((tpl) => ({ ...tpl, builtin: false })),
    ];
    if (!items.length) {
      el.innerHTML = `<div class="flow-msg-empty">还没有模板，可以先把当前画布存成模板</div>`;
      return;
    }
    el.innerHTML = items.map((tpl) => {
      const nodeCount = Array.isArray(tpl.data?.nodes) ? tpl.data.nodes.length : 0;
      const edgeCount = Array.isArray(tpl.data?.edges) ? tpl.data.edges.length : 0;
      return `<div class="flow-tpl-row">
        <div class="flow-tpl-info">
          <strong>${esc(tpl.name || "未命名模板")}</strong>
          <span>${tpl.builtin ? "内置" : "我的"} · ${nodeCount} 节点 / ${edgeCount} 连线</span>
        </div>
        <div class="flow-tpl-actions">
          <button class="btn" type="button" data-tpl-load="${esc(tpl.id)}">载入</button>
          ${tpl.builtin ? "" : `<button class="link danger" type="button" data-tpl-del="${esc(tpl.id)}" title="删除模板">删除</button>`}
        </div>
      </div>`;
    }).join("");
    el.dataset.builtins = "1";
  }

  function currentTemplateById(id) {
    const builtins = Array.isArray(window.ProtoViewFlowTemplates) ? window.ProtoViewFlowTemplates : [];
    return builtins.find((tpl) => tpl.id === id) || loadUserTemplates().find((tpl) => tpl.id === id) || null;
  }

  async function loadFlowTemplate(id) {
    const tpl = currentTemplateById(id);
    if (!tpl?.data) return;
    const data = JSON.parse(JSON.stringify(tpl.data));
    remapTemplateRpcs(data.nodes || []);
    $("flowTplModal")?.classList.remove("show");
    // importData → applyImport 会再确认一次是否替换画布
    importData(data);
  }

  function saveCurrentAsTemplate() {
    const name = ($("flowTplName")?.value || "").trim() || `模板 ${new Date().toLocaleString()}`;
    const list = loadUserTemplates();
    list.unshift({
      id: uid("tpl"),
      name,
      at: Date.now(),
      data: flowSnapshot(),
    });
    saveUserTemplates(list);
    if ($("flowTplName")) $("flowTplName").value = "";
    renderFlowTplList();
    void notify(`已保存模板「${name}」`);
  }

  function deleteFlowTemplate(id) {
    saveUserTemplates(loadUserTemplates().filter((tpl) => tpl.id !== id));
    renderFlowTplList();
  }

  function openFlowTemplates() {
    renderFlowTplList();
    $("flowTplModal")?.classList.add("show");
  }

  async function submitSendTask() {
    const node = currentSendNode();
    const hit = node ? api()?.findRpc?.(node.rpcId) : null;
    const client = api();
    if (!node || !hit || !client?.streamWrite) return;
    const task = syncCurrentSendTaskFromDom();
    if (!task) return;
    // 「只做接收解析」的任务不发送
    if (task.recvOnly) return;
    const fields = hit.rpc.requestFields || [];
    const body = buildBody(task.message || {}, {}, fields);
    const streamId = await ensureNodeStream(node, hit, body);
    if (!streamId) return;
    // 本次回包按这个任务的解析/变量配置处理
    flow.activeTaskId = task.id;
    beginRecvCapture(node.id);
    const wr = await client.streamWrite(streamId, body);
    if (!wr?.ok) {
      flow.recvCapture = null;
      node.result = {
        ok: false,
        status: "WRITE_FAIL",
        error: wr?.error || "写入失败",
        streaming: Boolean(node.streamId),
        body: node.streamMessages,
        ms: node.result?.ms,
      };
      render();
      return;
    }
    node.result = {
      ok: true,
      status: "CONNECTED",
      streaming: true,
      streamClosed: false,
      body: node.streamMessages || [],
      ms: node.result?.ms ?? 0,
    };
    pushHistory(node, {
      kind: "send",
      ok: true,
      status: "SENT",
      ms: 0,
      body,
    });
    pushSendHistory(node, body, task.name);
    save();
    render();
    refreshSendHistoryPanel();
    void refreshRecvLivePanel();
  }

  function markStreamClosed(node, extra = {}) {
    if (!node) return;
    stopNodeHeartbeat(node);
    stopNodeSendTasks(node);
    node.streamId = null;
    node.result = {
      ok: false,
      status: "stream close",
      streamClosed: true,
      streaming: false,
      error: extra.error,
      body: extra.body ?? node.streamMessages ?? [],
      ms: node.result?.ms ?? 0,
    };
  }

  function onHostStreamEvent(data) {
    if (!data) return;
    const node = flow.nodes.find((n) => (
      (n.streamId && n.streamId === data.streamId)
      || (n.lastStreamId && n.lastStreamId === data.streamId)
    ));
    if (!node) return;
    if (data.type === "streamData") {
      pushRecvMessage(node, data.message);
      node.result = {
        ok: true,
        status: "CONNECTED",
        streaming: true,
        streamClosed: false,
        body: node.streamMessages,
        ms: node.result?.ms ?? 0,
      };
      const captured = pushRecvCapture(node.id, data.message);
      // 有候选解析任务（配了 Payload 类型）时，每条消息都跑解析+变量赋值（不受 3 条捕获限制）
      const hasCandidates = recvTaskCandidates(node, data.message).length > 0;
      if (captured || hasCandidates) void harvestExtractsFromMessage(node, data.message);
      render();
      if ((captured || hasCandidates) && flow.sendNodeId === node.id && $("flowSendModal")?.classList.contains("show")) {
        void refreshRecvLivePanel();
      }
      if (flow.historyNodeId === node.id && $("flowHistoryModal")?.classList.contains("show")) {
        if (flow.historyFollowLive) {
          const ids = recvMessageIds(node);
          const idx = (node.streamMessages?.length || 1) - 1;
          if (ids[idx]) flow.historySelectedId = `__recv_${ids[idx]}__`;
        }
        void renderHistoryModal();
      }
      return;
    }
    if (data.type === "streamEnded") {
      // 对端/链路断开：只改节点外状态为红色 stream close，不弹窗
      const body = data.messages || node.streamMessages || [];
      markStreamClosed(node, {
        error: data.error,
        body,
      });
      pushHistory(node, {
        kind: "recv",
        ok: !data.error,
        status: "stream close",
        ms: node.result?.ms ?? 0,
        error: data.error,
        body,
      });
      render();
      if (flow.sendNodeId === node.id && $("flowSendModal")?.classList.contains("show")) {
        void refreshRecvLivePanel();
      }
      if (flow.historyNodeId === node.id && $("flowHistoryModal")?.classList.contains("show")) {
        void renderHistoryModal();
      }
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

  function isLongIntType(type) {
    return /^(int64|uint64|sint64|fixed64|sfixed64)$/i.test(String(type || ""));
  }

  function isIntType(type) {
    return /^(int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64)$/i.test(String(type || ""));
  }

  /** jstype=JS_STRING，或未指定时的 64 位整型：保持字符串，避免 JS Number 精度丢失 */
  function preferIntAsString(field) {
    if (!field) return false;
    if (field.jstype === "JS_STRING") return true;
    if (field.jstype === "JS_NUMBER") return false;
    return isLongIntType(field.type);
  }

  function canBeSafeNumber(digitStr) {
    if (!/^-?\d+$/.test(digitStr)) return false;
    const n = Number(digitStr);
    return Number.isSafeInteger(n) && String(n) === digitStr;
  }

  function coerceScalar(filled, field) {
    const text = String(filled ?? "");
    if (text.includes("{{")) return text;
    if (text === "true" || text === "false") {
      if (!field || String(field.type || "").toLowerCase() === "bool" || field.type == null) {
        return text === "true";
      }
    }
    const type = String(field?.type || "").toLowerCase();
    if (type === "bool") return text === "true" || text === "1";

    if (/^-?\d+$/.test(text)) {
      if (preferIntAsString(field)) return text;
      if (field && isIntType(field.type)) {
        return canBeSafeNumber(text) ? Number(text) : text;
      }
      // 无字段上下文：超出安全整数则保留字符串
      return canBeSafeNumber(text) ? Number(text) : text;
    }
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(text) || /^-?\d+[eE][+-]?\d+$/.test(text)) {
      if (!field || type === "float" || type === "double" || !type) return Number(text);
    }
    return text;
  }

  function buildBody(value, vars, fields) {
    if (fields?.length && value && typeof value === "object" && !Array.isArray(value)) {
      return buildBodyByFields(value, vars, fields);
    }
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

  function buildBodyByFields(message, vars, fields) {
    const out = {};
    if (!message || typeof message !== "object") return out;
    for (const group of groupFieldsByOneof(fields || [])) {
      const list = group.kind === "oneof" ? group.fields : [group.field];
      for (const field of list) {
        if (!field || !Object.prototype.hasOwnProperty.call(message, field.name)) continue;
        const raw = message[field.name];
        if (raw === undefined) continue;
        out[field.name] = buildBodyFieldValue(raw, vars, field);
      }
    }
    // 保留 schema 未覆盖的键（兼容旧数据）
    for (const [key, child] of Object.entries(message)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = buildBody(child, vars);
    }
    return out;
  }

  function buildBodyFieldValue(raw, vars, field) {
    if (field.repeated) {
      const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
      const itemField = { ...field, repeated: false };
      return list.map((item) => buildBodyFieldValue(item, vars, itemField));
    }
    if (field.key) {
      if (typeof raw === "string") {
        const filled = interpolate(raw, vars);
        if (filled.includes("{{")) return filled;
        try { return JSON.parse(filled); }
        catch { return filled; }
      }
      return buildBody(raw, vars);
    }
    if (isMessageField(field) && raw && typeof raw === "object" && !Array.isArray(raw)) {
      return buildBodyByFields(raw, vars, fieldTypeDef(field)?.fields || []);
    }
    if (typeof raw === "string") return coerceScalar(interpolate(raw, vars), field);
    if (typeof raw === "number" && preferIntAsString(field)) return String(raw);
    return buildBody(raw, vars);
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

  function collectStepSegments(order, byId) {
    const starts = order.filter((id) => isStartNode(byId.get(id)));
    const outs = new Map(flow.nodes.map((n) => [n.id, []]));
    for (const edge of flow.edges) {
      if (!outs.has(edge.from) || !outs.has(edge.to)) continue;
      outs.get(edge.from).push(edge.to);
    }
    const startSet = new Set(starts);
    const segments = [];
    for (const startId of starts) {
      const rpcIds = [];
      const queue = [...(outs.get(startId) || [])];
      const seen = new Set();
      while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const node = byId.get(id);
        if (!node) continue;
        if (isStartNode(node) || startSet.has(id)) continue;
        if (node.kind === "rpc" || node.rpcId) rpcIds.push(id);
        for (const next of outs.get(id) || []) queue.push(next);
      }
      const ordered = order.filter((id) => rpcIds.includes(id));
      segments.push({ start: byId.get(startId), rpcIds: ordered });
    }
    return segments;
  }

  function validateFlowGraph(order, byId, { onlyStartId = null } = {}) {
    if (!order) return "存在环路，请先去掉循环连线";
    if (!flow.nodes.some(isStartNode)) return "请先添加「起始步骤」节点，再连接口";
    const segments = collectStepSegments(order, byId);

    // 单步运行：只校验该起始步骤自身与其下游
    if (onlyStartId) {
      const seg = segments.find((s) => s.start?.id === onlyStartId);
      if (!seg?.start) return "找不到该起始步骤";
      if (!seg.rpcIds.length) return `步骤「${seg.start.name || "起始"}」下没有连接的接口`;
      return "";
    }

    const indeg = new Map(flow.nodes.map((n) => [n.id, 0]));
    for (const edge of flow.edges) {
      if (!indeg.has(edge.to)) continue;
      indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
    }
    for (const node of flow.nodes) {
      if ((indeg.get(node.id) || 0) === 0 && !isStartNode(node)) {
        return `节点「${node.name || node.rpcId}」没有连到起始步骤，请从起始步骤连出`;
      }
    }
    const covered = new Set();
    for (const seg of segments) for (const id of seg.rpcIds) covered.add(id);
    for (const node of flow.nodes) {
      if (isStartNode(node)) continue;
      if (!covered.has(node.id)) {
        return `接口「${node.name || node.rpcId}」未归属任何起始步骤（请从起始步骤连到该节点）`;
      }
    }
    return "";
  }

  async function closeSegmentStreams(rpcIds, byId) {
    for (const id of rpcIds || []) {
      const node = byId.get(id);
      if (node?.streamId) await closeNodeStream(node);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function closeNodeStream(node) {
    if (!node?.streamId) return;
    const client = api();
    const streamId = node.streamId;
    node.lastStreamId = streamId;
    node.streamId = null;
    try {
      await client?.streamClose?.(streamId);
    } catch { /* ignore */ }
    markStreamClosed(node, { body: node.streamMessages || [] });
  }

  async function closeAllStreams() {
    for (const node of flow.nodes) {
      if (node.streamId) await closeNodeStream(node);
    }
  }

  function applyExtracts(node, body, vars) {
    const applied = {};
    if (body == null) return applied;
    for (const [pathKey, varName] of Object.entries(node.extracts || {})) {
      if (!varName) continue;
      const val = valueAtDotted(body, pathKey);
      if (val !== undefined) {
        vars[varName] = val;
        applied[varName] = val;
      }
    }
    return applied;
  }

  /** 变量归到哪个起始步骤：节点所属步骤优先，其次当前正在跑的步骤 */
  function ownerStepIdFor(node) {
    return (node && node.ownerStepId) || flow.varOwnerStepId || "";
  }

  /** 把本次提取到的变量记到对应步骤节点上（步骤卡片里的「变量」按钮看的就是它） */
  function recordStepVars(stepId, applied) {
    if (!stepId || !applied) return;
    const keys = Object.keys(applied);
    if (!keys.length) return;
    const step = flow.nodes.find((n) => n.id === stepId && isStartNode(n));
    if (!step) return;
    if (!step.vars || typeof step.vars !== "object") step.vars = {};
    for (const key of keys) step.vars[key] = applied[key];
    step.varsAt = Date.now();
  }

  async function applyExtractsDecoded(node, body, vars) {
    if (body == null) return {};
    let root = body;
    if (Array.isArray(body)) {
      if (!body.length) return {};
      root = body[body.length - 1];
    }
    const decoded = await decodeMessageBytes(node, root, protoFileOf(node));
    const applied = applyExtracts(node, decoded, vars);
    recordStepVars(ownerStepIdFor(node), applied);
    return applied;
  }

  async function invokeRpcNode(client, node, hit, vars, kind) {
    const metadata = {};
    for (const row of node.metadata || []) {
      const name = (row.name || "").trim();
      if (!name) continue;
      metadata[name] = interpolate(row.value, vars);
    }
    const protocol = normalizeNodeProtocol(node.protocol);
    const body = buildBody(node.message, vars, hit.rpc.requestFields || []);
    const payload = {
      protocol,
      httpMethod: node.httpMethod || (protocol === "sse" ? "GET" : hit.rpc.httpVerb || "POST"),
      httpPath: interpolate(node.httpPath || hit.rpc.httpPath || "/", vars),
      host: client.resolveHost?.(node.envId) || "",
      package: hit.pkg.name,
      service: hit.service.name,
      method: hit.rpc.name,
      file: hit.rpc.file,
      body,
      metadata,
      tls: false,
    };

    // 客户端流 / 双向流：保持连接，节点显示 CONNECTED，可供右键续发
    if (protocol === "grpc" && hit.rpc.requestStream && client.streamOpen && client.streamWrite) {
      await closeNodeStream(node);
      node.streamMessages = [];
      node.result = { ok: true, status: "连接中", ms: 0, streaming: true };
      render();
      const opened = await client.streamOpen(payload);
      if (!opened.ok || !opened.streamId) {
        node.result = {
          ok: false,
          status: opened.status || "ERROR",
          ms: opened.ms,
          error: opened.error,
          body: null,
        };
        pushHistory(node, {
          kind,
          ok: false,
          status: node.result.status,
          ms: node.result.ms,
          error: node.result.error,
          body: null,
        });
        return opened;
      }
      node.streamId = opened.streamId;
      node.lastStreamId = opened.streamId;
      node.result = {
        ok: true,
        status: "CONNECTED",
        ms: opened.ms,
        body: [],
        streaming: true,
        streamClosed: false,
      };
      render();

      // 建流后不发初始包，只按间隔定时发心跳（默认 2s；次数留空=一直发到关流）
      const hbBody = buildBody(
        node.heartbeatMessage && Object.keys(node.heartbeatMessage).length
          ? node.heartbeatMessage
          : body,
        vars,
        hit.rpc.requestFields || [],
      );
      startNodeHeartbeat(node, hbBody);
      // 建流后按各任务的延迟自动发送（没配延迟的任务只能手动发）
      scheduleNodeSendTasks(node, vars);
      await sleep(400);
      const messages = node.streamMessages || [];
      node.result = {
        ok: true,
        status: "CONNECTED",
        ms: opened.ms,
        body: messages,
        streaming: true,
        streamClosed: false,
      };
      pushHistory(node, {
        kind,
        ok: true,
        status: "CONNECTED",
        ms: opened.ms,
        body: messages,
      });
      await applyExtractsDecoded(node, messages, vars);
      return { ok: true, status: "CONNECTED", ms: opened.ms, body: messages, streamId: node.streamId };
    }

    if (protocol === "grpc" && hit.rpc.responseStream && !hit.rpc.requestStream) {
      node.result = { ok: true, status: "运行中", ms: 0 };
      render();
    }

    const result = await client.invokeOnce(payload);
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
    if (result.ok) await applyExtractsDecoded(node, result.body, vars);
    return result;
  }

  async function executeFlowOnce({ quiet = false, kind = "run", onlyStartId = null } = {}) {
    const client = api();
    if (!client?.invokeOnce) {
      return { ok: false, ms: 0, error: "请在 VS Code ProtoView Client 中运行" };
    }
    if (!flow.nodes.length) {
      return { ok: false, ms: 0, error: "画布为空，请先添加起始步骤与接口" };
    }
    const order = topoSort();
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const err = validateFlowGraph(order, byId, { onlyStartId });
    if (err) return { ok: false, ms: 0, error: err };

    const segments = collectStepSegments(order, byId);
    const targetSeg = onlyStartId
      ? segments.find((s) => s.start?.id === onlyStartId)
      : null;

    if (!quiet) {
      // 单步：只关掉本步骤下游的流，保留其它步骤已建的连接
      if (onlyStartId && targetSeg) {
        await closeSegmentStreams(targetSeg.rpcIds, byId);
      } else if (!onlyStartId) {
        await closeAllStreams();
      }
      for (const edge of flow.edges) {
        if (onlyStartId && targetSeg) {
          const touch = edge.from === onlyStartId
            || targetSeg.rpcIds.includes(edge.from)
            || targetSeg.rpcIds.includes(edge.to);
          if (!touch) continue;
        }
        edge.status = "idle";
      }
      const clearIds = new Set();
      if (onlyStartId && targetSeg) {
        clearIds.add(onlyStartId);
        for (const id of targetSeg.rpcIds) clearIds.add(id);
      } else {
        for (const node of flow.nodes) clearIds.add(node.id);
      }
      for (const node of flow.nodes) {
        if (!clearIds.has(node.id)) continue;
        node.result = null;
        if (!onlyStartId || !node.streamId) node.streamMessages = [];
      }
      render();
    }

    const started = performance.now();
    const vars = { ...(flow.sharedVars || {}) };

    for (const seg of segments) {
      if (onlyStartId && seg.start?.id !== onlyStartId) continue;
      // 全量运行只跑勾选启用的步骤；单步「运行」不受开关限制
      if (!onlyStartId && seg.start && seg.start.enabled === false) {
        seg.start.result = { ok: true, status: "跳过", ms: 0 };
        if (!quiet) render();
        continue;
      }
      const startId = seg.start?.id;
      if (startId) flow.varOwnerStepId = startId;
      if (startId && !onlyStartId) {
        flow.stepRunning[startId] = true;
        if (!quiet) render();
      }
      try {
        const runs = Math.max(1, Math.floor(Number(seg.start.runs) || 1));
        const intervalRaw = Number(seg.start?.intervalSec);
        const intervalMs = (Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : 1) * 1000;
        for (let r = 0; r < runs; r++) {
          if (flow.stressAbort) {
            return { ok: false, ms: Math.round(performance.now() - started), error: "已停止", cancelled: true };
          }
          // 每次重复之间等待「间隔」秒（第一轮不等）
          if (r > 0 && intervalMs > 0) {
            if (!quiet) render();
            await sleep(intervalMs);
          }
          for (const nodeId of seg.rpcIds) {
            if (flow.stressAbort) {
              return { ok: false, ms: Math.round(performance.now() - started), error: "已停止", cancelled: true };
            }
            const node = byId.get(nodeId);
            const hit = client.findRpc(node.rpcId);
            if (!hit) continue;
            if (startId) node.ownerStepId = startId;
            const incoming = flow.edges.filter((e) => e.to === nodeId);
            const result = await invokeRpcNode(client, node, hit, vars, kind);
            for (const edge of incoming) edge.status = result.ok ? "ok" : "fail";
            // 写回共享变量，供其它步骤单独运行时使用
            flow.sharedVars = { ...flow.sharedVars, ...vars };
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
        }
        if (seg.start) seg.start.result = { ok: true, status: `×${runs}`, ms: 0 };
      } finally {
        if (startId && !onlyStartId) {
          delete flow.stepRunning[startId];
          if (!quiet) render();
        }
        if (flow.varOwnerStepId === startId) flow.varOwnerStepId = null;
      }
    }
    return { ok: true, ms: Math.round(performance.now() - started) };
  }

  async function runFlow() {
    if (flow.flowRunning) return;
    const client = api();
    if (!client?.invokeOnce) {
      void notify("请在 VS Code ProtoView Client 中运行链路调试");
      return;
    }
    const enabledStarts = flow.nodes.filter((n) => isStartNode(n) && isStartEnabled(n));
    if (!enabledStarts.length) {
      void notify("没有启用的起始步骤，请先勾选要跑的步骤");
      return;
    }
    flow.flowRunning = true;
    flow.stressAbort = false;
    $("flowRunBtn").disabled = true;
    render();
    try {
      const summary = await executeFlowOnce({ quiet: false });
      if (!summary.ok && summary.error) {
        void notify(summary.failNode ? `${summary.failNode}: ${summary.error}` : summary.error);
      }
    } finally {
      flow.flowRunning = false;
      for (const s of enabledStarts) delete flow.stepRunning[s.id];
      $("flowRunBtn").disabled = false;
      save();
      render();
    }
  }

  async function runStartStep(startId) {
    // 同一步骤正在跑则忽略；其它步骤可并行点运行
    if (flow.stepRunning[startId]) return;
    const start = flow.nodes.find((n) => n.id === startId && isStartNode(n));
    if (!start) return;
    const client = api();
    if (!client?.invokeOnce) {
      void notify("请在 VS Code ProtoView Client 中运行链路调试");
      return;
    }
    flow.stepRunning[startId] = true;
    flow.stressAbort = false;
    render();
    try {
      const summary = await executeFlowOnce({ quiet: false, onlyStartId: startId });
      if (!summary.ok && summary.error) {
        void notify(summary.failNode ? `${summary.failNode}: ${summary.error}` : summary.error);
      }
    } finally {
      delete flow.stepRunning[startId];
      save();
      render();
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
  window.ProtoViewFlow = {
    addNode,
    addStartNode,
    addSelected,
    openFlow,
    isFlowOpen,
    addAtScreen,
    render,
    importData,
    onHostStreamEvent,
  };

  function bind() {
    load();
    resetUndo();
    hideMenu();
    $("flowBtn")?.addEventListener("click", openFlow);
    $("flowCloseBtn")?.addEventListener("click", closeFlow);
    $("flowAddStartBtn")?.addEventListener("click", () => addStartNode());
    $("flowAddSelectedBtn")?.addEventListener("click", addSelected);
    $("flowClearBtn")?.addEventListener("click", clearCanvas);
    $("flowRunBtn")?.addEventListener("click", () => void runFlow());
    $("flowUndoBtn")?.addEventListener("click", undoStep);
    $("flowRedoBtn")?.addEventListener("click", redoStep);
    // 浮动工具栏展开/收起（状态记在 localStorage）
    const floatTools = $("flowFloatTools");
    if (floatTools) {
      const collapsed = localStorage.getItem(FLOAT_TOOLS_KEY) === "1";
      floatTools.classList.toggle("collapsed", collapsed);
      $("flowFloatToggle")?.addEventListener("click", () => {
        const next = !floatTools.classList.contains("collapsed");
        floatTools.classList.toggle("collapsed", next);
        try { localStorage.setItem(FLOAT_TOOLS_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      });
    }
    $("flowVarsModal")?.addEventListener("click", (event) => {
      if (event.target === $("flowVarsModal")) $("flowVarsModal")?.classList.remove("show");
    });
    $("closeFlowVars")?.addEventListener("click", () => $("flowVarsModal")?.classList.remove("show"));
    $("closeFlowVarsFoot")?.addEventListener("click", () => $("flowVarsModal")?.classList.remove("show"));
    $("clearFlowVarsBtn")?.addEventListener("click", clearVars);
    $("flowExportBtn")?.addEventListener("click", exportFlow);
    $("flowImportBtn")?.addEventListener("click", requestImportFlow);
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
    $("flowMsgBody")?.addEventListener("change", handleOneofChange);
    $("flowHbMsgBody")?.addEventListener("click", handleMsgTreeClick);
    $("flowHbMsgBody")?.addEventListener("change", handleOneofChange);
    $("flowSendMsgBody")?.addEventListener("click", handleMsgTreeClick);
    $("flowSendMsgBody")?.addEventListener("change", handleOneofChange);
    const closeSendModal = () => {
      syncCurrentSendTaskFromDom();
      save();
      $("flowSendModal")?.classList.remove("show");
      flow.sendNodeId = null;
      flow.recvCapture = null;
    };
    $("closeFlowSend")?.addEventListener("click", closeSendModal);
    $("closeFlowSendFoot")?.addEventListener("click", closeSendModal);
    $("flowAddSendTaskBtn")?.addEventListener("click", addSendTask);
    $("flowSendTaskSendBtn")?.addEventListener("click", () => void submitSendTask());
    $("flowSendTaskList")?.addEventListener("click", (event) => {
      const del = event.target.closest?.("[data-send-task-del]");
      if (del) {
        event.stopPropagation();
        deleteSendTask(del.getAttribute("data-send-task-del"));
        return;
      }
      const item = event.target.closest?.("[data-send-task]");
      if (!item) return;
      selectSendTask(item.getAttribute("data-send-task"));
    });
    for (const id of [
      "flowSendTaskName",
      "flowSendTaskDelay",
      "flowSendTaskRoutePath",
      "flowSendTaskRouteValue",
      "flowSendTaskPayloadPath",
      "flowSendTaskPayloadType",
    ]) {
      $(id)?.addEventListener("change", () => {
        const task = syncCurrentSendTaskFromDom();
        const node = currentSendNode();
        if (!task || !node) return;
        renderSendTaskList(node);
        renderRecvDecodeConfig(task, api()?.findRpc?.(node.rpcId));
        commit();
      });
    }
    $("flowSendTaskRecvOnly")?.addEventListener("change", () => {
      const task = syncCurrentSendTaskFromDom();
      const node = currentSendNode();
      if (!task || !node) return;
      syncTaskSendVisibility(task);
      renderSendTaskList(node);
      commit();
    });
    $("clearRecvLiveBtn")?.addEventListener("click", clearRecvCapture);
    // ===== 步骤压测弹窗 =====
    $("closeFlowStress")?.addEventListener("click", () => $("flowStressModal")?.classList.remove("show"));
    $("flowStressNode")?.addEventListener("change", syncFlowStressGhzUi);
    $("flowStressModes")?.addEventListener("click", (event) => {
      const btn = event.target.closest?.("[data-flow-stress-mode]");
      if (btn) setFlowStressMode(btn.getAttribute("data-flow-stress-mode"));
    });
    for (const id of ["flowStressGhzConcurrency", "flowStressGhzTotal", "flowStressGhzPath"]) {
      $(id)?.addEventListener("input", () => {
        if ($("flowStressGhzCommand")) $("flowStressGhzCommand").value = buildFlowGhzCommand();
      });
      $(id)?.addEventListener("change", () => {
        if ($("flowStressGhzCommand")) $("flowStressGhzCommand").value = buildFlowGhzCommand();
      });
    }
    $("flowStressStart")?.addEventListener("click", () => {
      if (flow.stressMode === "ghz") runFlowGhz();
      else void runFlowLightStress();
    });
    $("flowStressStop")?.addEventListener("click", () => {
      flow.stressAbort = true;
      setFlowStressRunning(false);
    });
    $("flowStressCopyGhz")?.addEventListener("click", async () => {
      const text = $("flowStressGhzCommand")?.value || buildFlowGhzCommand();
      try {
        await navigator.clipboard.writeText(text);
        void notify("ghz 命令已复制");
      } catch {
        void notify(text);
      }
    });
    // ===== 画布模板 =====
    $("flowTplBtn")?.addEventListener("click", openFlowTemplates);
    $("closeFlowTpl")?.addEventListener("click", () => $("flowTplModal")?.classList.remove("show"));
    $("closeFlowTplFoot")?.addEventListener("click", () => $("flowTplModal")?.classList.remove("show"));
    $("saveFlowTplBtn")?.addEventListener("click", saveCurrentAsTemplate);
    $("flowTplList")?.addEventListener("click", (event) => {
      const loadBtn = event.target.closest?.("[data-tpl-load]");
      if (loadBtn) {
        void loadFlowTemplate(loadBtn.getAttribute("data-tpl-load"));
        return;
      }
      const delBtn = event.target.closest?.("[data-tpl-del]");
      if (delBtn) deleteFlowTemplate(delBtn.getAttribute("data-tpl-del"));
    });
    // 点结构体字段：标量 → 路由字段，bytes → Payload 字段
    $("flowRecvDecodeBody")?.addEventListener("click", (event) => {
      const row = event.target.closest?.("[data-struct-path]");
      if (!row || row.disabled) return;
      const path = row.getAttribute("data-struct-path");
      const kind = row.getAttribute("data-struct-kind");
      if (!path) return;
      if (kind === "bytes" && $("flowSendTaskPayloadPath")) {
        $("flowSendTaskPayloadPath").value = path;
      } else if (kind === "scalar" && $("flowSendTaskRoutePath")) {
        $("flowSendTaskRoutePath").value = path;
      } else {
        return;
      }
      const task = syncCurrentSendTaskFromDom();
      const node = currentSendNode();
      if (!task || !node) return;
      renderRecvDecodeConfig(task, api()?.findRpc?.(node.rpcId));
      save();
    });
    $("flowSendHistoryBody")?.addEventListener("click", (event) => {
      const btn = event.target.closest?.("[data-apply-send]");
      if (!btn) return;
      applySendHistoryToForm(btn.getAttribute("data-apply-send"));
    });
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
      if (act === "view-resp") {
        const n = flow.nodes.find((item) => item.id === nodeId);
        if (n && !isStartNode(n)) openHistory(nodeId);
      }
      if (act === "send-msg") openSendModal(nodeId);
      if (act === "close-stream") {
        const n = flow.nodes.find((item) => item.id === nodeId);
        if (n) {
          void closeNodeStream(n).then(() => render());
        }
      }
      if (act === "delete") {
        const n = flow.nodes.find((item) => item.id === nodeId);
        if (n?.streamId) void closeNodeStream(n);
        flow.nodes = flow.nodes.filter((item) => item.id !== nodeId);
        flow.edges = flow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
        if (!flow.edges.some((e) => e.id === flow.selectedEdgeId)) flow.selectedEdgeId = null;
        if (flow.varsStepId === nodeId) flow.varsStepId = null;
        commit();
        render();
      }
    });
    $("closeFlowHistory")?.addEventListener("click", () => {
      $("flowHistoryModal")?.classList.remove("show");
      flow.historyNodeId = null;
      flow.historySelectedId = null;
      flow.historyFollowLive = true;
    });
    $("clearFlowHistoryBtn")?.addEventListener("click", clearFlowHistory);
    $("flowHistoryList")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-history-id]");
      if (!btn) return;
      // 手动点选后固定该条，不再自动跳到最新接收
      flow.historyFollowLive = false;
      flow.historySelectedId = btn.getAttribute("data-history-id");
      void renderHistoryModal();
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
      if (onBlank) {
        // 点空白处取消连线选中
        if (flow.selectedEdgeId) selectEdge(null);
        hideEdgeMenu();
      }
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

    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const out = event.target.closest?.("[data-port-out]");
      if (out) {
        const fromId = out.getAttribute("data-port-out");
        const pos = screenToWorld(event.clientX, event.clientY);
        flow.link = { from: fromId, x: pos.x, y: pos.y };
        // 指针捕获：拖出画布也能继续画线，松开时能正确收尾
        try { out.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        stage.classList.add("flow-connecting");
        hideMenu();
        hideEdgeMenu();
        paintLinkPreview();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const head = event.target.closest?.("[data-drag]");
      if (head) {
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
      if (flow.link) {
        const pos = screenToWorld(event.clientX, event.clientY);
        flow.link.x = pos.x;
        flow.link.y = pos.y;
        paintLinkPreview();
        return;
      }
      if (dragNode && dragOffset) {
        const pos = screenToWorld(event.clientX, event.clientY);
        dragNode.x = pos.x - dragOffset.x;
        dragNode.y = pos.y - dragOffset.y;
        render();
      }
    });
    stage.addEventListener("pointerup", (event) => {
      if (flow.link) {
        const fromId = flow.link.from;
        flow.link = null;
        stage.classList.remove("flow-connecting");
        paintLinkPreview();
        const toId = linkTargetAt(event.clientX, event.clientY, fromId);
        if (toId) connectNodes(fromId, toId);
      }
      if (dragNode) {
        dragNode = null;
        dragOffset = null;
        commit();
      }
    });
    stage.addEventListener("pointercancel", () => {
      if (!flow.link) return;
      flow.link = null;
      stage.classList.remove("flow-connecting");
      paintLinkPreview();
    });

    stage.addEventListener("change", (event) => {
      const toggle = event.target.closest?.("[data-start-toggle]");
      if (!toggle) return;
      const id = toggle.getAttribute("data-start-toggle");
      const node = flow.nodes.find((n) => n.id === id && isStartNode(n));
      if (!node) return;
      node.enabled = Boolean(toggle.checked);
      commit();
      render();
    });
    stage.addEventListener("click", (event) => {
      const runBtn = event.target.closest?.("[data-start-run]");
      if (runBtn) {
        event.preventDefault();
        event.stopPropagation();
        void runStartStep(runBtn.getAttribute("data-start-run"));
        return;
      }
      const varsBtn = event.target.closest?.("[data-start-vars]");
      if (varsBtn) {
        event.preventDefault();
        event.stopPropagation();
        openVarsModal(varsBtn.getAttribute("data-start-vars"));
      }
    });

    // 单击连线：选中
    stage.addEventListener("click", (event) => {
      const edgeEl = event.target.closest?.("[data-edge]");
      if (!edgeEl) return;
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
      hideEdgeMenu();
      selectEdge(edgeEl.getAttribute("data-edge"));
    });

    stage.addEventListener("contextmenu", (event) => {
      const edgeEl = event.target.closest?.("[data-edge]");
      if (edgeEl) {
        event.preventDefault();
        event.stopPropagation();
        hideMenu();
        const edgeId = edgeEl.getAttribute("data-edge");
        selectEdge(edgeId);
        showEdgeMenu(event.clientX, event.clientY, edgeId);
        return;
      }
      const nodeEl = event.target.closest("[data-node]");
      if (!nodeEl) {
        hideMenu();
        hideEdgeMenu();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      hideEdgeMenu();
      showMenu(event.clientX, event.clientY, nodeEl.getAttribute("data-node"));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#flowMenu")) hideMenu();
      if (!event.target.closest("#flowEdgeMenu")) hideEdgeMenu();
    });
    document.addEventListener("keydown", (event) => {
      const active = document.activeElement;
      const tag = active?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
      // 撤销 / 恢复
      if (isFlowOpen() && !typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoStep();
        else undoStep();
        return;
      }
      if (isFlowOpen() && !typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoStep();
        return;
      }
      if (!flow.selectedEdgeId || !isFlowOpen()) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (typing) return;
      event.preventDefault();
      deleteEdge(flow.selectedEdgeId);
    });
    window.addEventListener("resize", hideEdgeMenu);

    hideMenu();
    hideEdgeMenu();
    render();
    window.ProtoViewFlow = {
      addNode,
      addStartNode,
      addSelected,
      openFlow,
      isFlowOpen,
      addAtScreen,
      render,
      importData,
      onHostStreamEvent,
    };
  }

  window.ProtoViewFlow = {
    ...(window.ProtoViewFlow || {}),
    onHostStreamEvent,
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "flowImportData") importData(data.payload);
    // 步骤压测的 ghz 输出
    if (data?.type === "ghzProgress" && flow.ghzId && data.id === flow.ghzId) {
      flow.ghzLog += data.text || "";
      const view = document.getElementById("flowGhzLog");
      if (view) {
        view.textContent = flow.ghzLog;
        view.scrollTop = view.scrollHeight;
      }
    }
    if (data?.type === "ghzResult" && flow.ghzId && data.id === flow.ghzId) {
      flow.ghzLog += data.text || "";
      setFlowStressRunning(false);
      const box = document.getElementById("flowStressResult");
      if (box) box.innerHTML = `<pre class="stress-log">${String(flow.ghzLog).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
      flow.ghzId = "";
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
