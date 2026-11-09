(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const state = {
    tables: [],
    filter: "",
    collapsed: new Set(),
    activeId: "",
    envs: [],
    activeEnvId: "",
    databases: [],
    page: null,
    draft: null,
    tab: "query",
    envEditing: "",
    limits: [],
    sqlRatio: 0.46,
    sqlCollapsed: false,
    resultCollapsed: false,
    rowOffset: 0,
    rowLimit: 50,
    rowTotal: 0,
    definition: null,
    diffOnly: false,
    mode: "read",
    stackRatio: 0.5,
  };
  const MANUAL_DB_KEY = "protoview.db.lastManualDatabase";
  let searchWaiters = [];

  function post(type, payload) {
    const send = window.ProtoViewHost?.post;
    if (typeof send === "function") {
      send(type, payload);
      return true;
    }
    return false;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "sqlCatalog") {
      state.tables = Array.isArray(data.payload?.tables) ? data.payload.tables : [];
      renderTree();
    }
    if (data.type === "sqlSearch") {
      const waiters = searchWaiters;
      searchWaiters = [];
      const hits = Array.isArray(data.payload) ? data.payload : [];
      waiters.forEach((cb) => { try { cb(hits); } catch { /* ignore */ } });
    }
    if (data.type === "dbEnvs") applyEnvs(data.payload);
    if (data.type === "dbTest") applyTest(data.payload);
    if (data.type === "dbDatabases") applyDatabases(data.payload);
    if (data.type === "dbTable") renderTable(data.payload);
    if (data.type === "dbDefinition") renderDefinition(data.payload);
    if (data.type === "dbMutate") {
      const result = data.payload || {};
      setTableMeta(result.ok ? `已更新 ${result.affected || 0} 行` : `失败：${result.error || "未知错误"}`, !result.ok);
      if (result.ok && state.activeId) loadTable();
    }
    if (data.type === "dbQuery") renderQuery(data.payload);
  });

  // ===== 环境 =====
  function applyEnvs(file) {
    state.envs = Array.isArray(file?.envs) ? file.envs : [];
    const known = state.envs.some((env) => env.id === state.activeEnvId);
    // 默认选中第一个环境
    if (!known) state.activeEnvId = state.envs[0]?.id || "";
    const select = $("dbEnvSelect");
    if (select) {
      select.innerHTML = state.envs.map((env) => `<option value="${esc(env.id)}">${esc(env.name)}</option>`).join("");
      select.value = state.activeEnvId;
    }
    updateEnvMeta();
    refreshDatabases();
    renderEnvList();
    fillEnvForm();
  }

  function currentEnv() {
    return state.envs.find((env) => env.id === state.activeEnvId) || state.envs[0];
  }

  function updateEnvMeta() {
    const env = currentEnv();
    const meta = $("dbEnvMeta");
    if (!meta || !env) return;
    const db = $("dbDatabaseSelect")?.value || env.database || "";
    meta.textContent = `${env.user}@${env.host}:${env.port}${db ? `/${db}` : ""}`;
    meta.classList.remove("is-error");
  }

  function refreshDatabases() {
    const env = currentEnv();
    if (!env) return;
    post("dbDatabases", { envId: env.id });
  }

  function fileStem(table) {
    return String(table?.fileName || "").replace(/\.[^.]+$/, "").toLowerCase();
  }

  function lastManualDatabase() {
    try { return localStorage.getItem(MANUAL_DB_KEY) || ""; } catch { return ""; }
  }

  function rememberManual(name) {
    if (!name) return;
    try { localStorage.setItem(MANUAL_DB_KEY, name); } catch { /* ignore */ }
  }

  /** 库名与 SQL 文件名（去后缀、小写）完全一致才自动选中。 */
  function resolveDatabase(table) {
    const stem = fileStem(table);
    const matched = stem ? state.databases.find((name) => name.toLowerCase() === stem) : "";
    if (matched) return matched;
    const manual = lastManualDatabase();
    if (manual && state.databases.includes(manual)) return manual;
    return "";
  }

  function applyDatabases(payload) {
    state.databases = Array.isArray(payload?.databases) ? payload.databases : [];
    const select = $("dbDatabaseSelect");
    if (!select) return;
    const table = state.tables.find((item) => item.id === state.activeId);
    const chosen = table ? resolveDatabase(table) : "";
    select.innerHTML = `<option value="">选择数据库</option>${state.databases.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
    select.value = state.databases.includes(chosen) ? chosen : "";
    if (!state.databases.length && payload?.error) {
      const meta = $("dbEnvMeta");
      if (meta) {
        meta.textContent = payload.error;
        meta.classList.add("is-error");
      }
    }
    updateEnvMeta();
    if (table) syncDatabaseForTable(table, payload?.error || "");
  }

  function pickDatabase(name) {
    const env = currentEnv();
    if (!env) return;
    const select = $("dbDatabaseSelect");
    if (select) select.value = state.databases.includes(name) ? name : "";
    if (env.database === name) {
      updateEnvMeta();
      if (name && state.activeId) loadTable();
      return;
    }
    const envs = state.envs.map((item) => item.id === env.id ? { ...item, database: name } : item);
    post("dbEnvSave", { envs });
    state.envs = envs;
    updateEnvMeta();
    if (!name || !state.activeId) return;
    switchTab("query");
    loadTable();
    const table = state.tables.find((item) => item.id === state.activeId);
    if (table && $("dbSql")) $("dbSql").value = `SELECT * FROM \`${table.name}\` LIMIT ${state.rowLimit}`;
  }

  function syncDatabaseForTable(table, error) {
    if (!table) return;
    paintTableHead(table);
    if (!state.databases.length) {
      const wrap = $("dbTableWrap");
      if (wrap) wrap.innerHTML = `<div class="excel-empty">${esc(error || "正在读取数据库列表…")}</div>`;
      return;
    }
    const name = resolveDatabase(table);
    const select = $("dbDatabaseSelect");
    if (select) select.value = name;
    if (!name) {
      const wrap = $("dbTableWrap");
      if (wrap) wrap.innerHTML = `<div class="excel-empty">没有和「${esc(fileStem(table))}」同名的库，请在上方手选。下次仍匹配不到时会沿用这次的选择。</div>`;
      setTableMeta("未选择数据库", true);
      renderRowPager(0, 0, 0);
      return;
    }
    pickDatabase(name);
  }

  function applyTest(payload) {
    const node = $("dbTestResult");
    if (!payload?.ok) {
      if (node) node.textContent = `连接失败：${payload?.error || "未知错误"}`;
      setEnvMeta(`连接失败：${payload?.error || ""}`, true);
      return;
    }
    if (node) node.textContent = `${payload.message}，MySQL ${payload.version || ""}`;
    setEnvMeta(`已连接 MySQL ${payload.version || ""}`, false);
    refreshDatabases();
  }

  function setEnvMeta(text, isError) {
    const meta = $("dbEnvMeta");
    if (!meta) return;
    meta.textContent = text;
    meta.classList.toggle("is-error", Boolean(isError));
  }

  function renderEnvList() {
    const list = $("dbEnvList");
    if (!list) return;
    list.innerHTML = state.envs.map((env, index) => `
      <div class="env-item${env.id === state.envEditing ? " active" : ""}" data-db-env="${esc(env.id)}">
        <div>
          <strong>${esc(env.name)}</strong>
          <span>${esc(env.user)}@${esc(env.host)}:${esc(env.port)}</span>
        </div>
        <div class="env-actions">
          <button class="icon-btn" type="button" data-db-env-up="${esc(env.id)}" title="上移" ${index ? "" : "disabled"}>↑</button>
          <button class="icon-btn" type="button" data-db-env-down="${esc(env.id)}" title="下移" ${index < state.envs.length - 1 ? "" : "disabled"}>↓</button>
          <button class="icon-btn" type="button" data-db-env-del="${esc(env.id)}" title="删除">✕</button>
        </div>
      </div>`).join("");
  }

  function persistEnvOrder() {
    post("dbEnvSave", { envs: state.envs });
    const select = $("dbEnvSelect");
    if (select) {
      select.innerHTML = state.envs.map((env) => `<option value="${esc(env.id)}">${esc(env.name)}</option>`).join("");
      select.value = state.activeEnvId;
    }
    renderEnvList();
  }

  function fillEnvForm() {
    const env = state.envs.find((item) => item.id === state.envEditing) || currentEnv();
    state.envEditing = env?.id || "";
    if (!env) return;
    $("dbEnvName").value = env.name || "";
    $("dbEnvHost").value = env.host || "";
    $("dbEnvPort").value = env.port || 3306;
    $("dbEnvUser").value = env.user || "";
    $("dbEnvPassword").value = env.password || "";
    const node = $("dbTestResult");
    if (node) node.textContent = "";
    renderEnvList();
  }

  function readEnvForm() {
    const base = state.envs.find((item) => item.id === state.envEditing) || currentEnv() || { id: "local" };
    return {
      id: base.id,
      name: $("dbEnvName").value.trim() || base.name || "local",
      host: $("dbEnvHost").value.trim() || "127.0.0.1",
      port: Number($("dbEnvPort").value || 3306),
      user: $("dbEnvUser").value,
      password: $("dbEnvPassword").value,
      database: base.database || "",
    };
  }

  // ===== 表树 =====
  function renderTree() {
    const tree = $("dbTree");
    if (!tree) return;
    const q = state.filter.trim().toLowerCase();
    const groups = new Map();
    for (const table of state.tables) {
      const columns = (table.columns || []).map((col) => `${col.name} ${col.type || ""} ${col.comment || ""}`).join(" ");
      const blob = `${table.fileName} ${table.relative} ${table.name} ${table.comment} ${columns} ${table.definition || ""}`.toLowerCase();
      if (q && !blob.includes(q)) continue;
      const bucket = groups.get(table.relative) || [];
      bucket.push(table);
      groups.set(table.relative, bucket);
    }
    if (!groups.size) {
      tree.innerHTML = `<div class="excel-empty">${state.tables.length ? "没有匹配的表" : "未找到 SQL 文件"}</div>`;
      return;
    }
    const allOpen = [...groups.keys()].some((file) => !state.collapsed.has(file));
    tree.innerHTML = [...groups.entries()].map(([file, tables]) => {
      const open = !state.collapsed.has(file);
      const name = tables[0]?.fileName || file.split("/").pop();
      return `
        <div class="node">
          <button class="node-row" type="button" data-sql-file="${esc(file)}">
            <span class="caret">${open ? "▾" : "▸"}</span>
            <span class="label">${esc(name)}</span>
            <span class="count">${tables.length}</span>
          </button>
          ${open ? `<div class="children">${tables.map((table) => `
            <button class="node-row db-table-row${table.id === state.activeId ? " active" : ""}" type="button" data-sql-table="${esc(encodeURIComponent(table.id))}">
              <span class="caret"></span>
              <span class="label">${esc(table.name)}</span>
              <span class="count">${esc(table.comment || "")}</span>
            </button>`).join("")}</div>` : ""}
        </div>`;
    }).join("");
    const toggle = $("dbTreeToggle");
    if (toggle) toggle.textContent = allOpen ? "▸" : "▾";
  }

  function toggleAllFiles() {
    const files = new Set(state.tables.map((table) => table.relative));
    const anyOpen = [...files].some((file) => !state.collapsed.has(file));
    files.forEach((file) => {
      if (anyOpen) state.collapsed.add(file);
      else state.collapsed.delete(file);
    });
    renderTree();
  }

  function switchTab(tab) {
    state.tab = tab === "ddl" ? "ddl" : "query";
    for (const btn of document.querySelectorAll("[data-db-tab]")) {
      btn.classList.toggle("active", btn.getAttribute("data-db-tab") === state.tab);
    }
    $("dbQueryView")?.classList.toggle("active", state.tab === "query");
    $("dbDdlView")?.classList.toggle("active", state.tab === "ddl");
    if (state.tab === "ddl" && state.activeId) loadDefinition();
  }

  function paintTableHead(table) {
    const title = $("dbTitle");
    if (title) title.textContent = table ? table.name : "选择左侧的表";
    const path = $("dbPath");
    if (path) path.textContent = table?.relative || "";
    const sql = $("dbSql");
    if (sql && table && !String(sql.value || "").trim()) sql.value = `SELECT * FROM \`${table.name}\` LIMIT ${state.rowLimit}`;
  }

  function paintDbMode() {
    for (const btn of document.querySelectorAll("[data-db-mode]")) {
      btn.classList.toggle("active", btn.getAttribute("data-db-mode") === state.mode);
    }
    $("dbAddRow")?.toggleAttribute("disabled", state.mode !== "edit");
  }

  function openTable(id) {
    if (!id) return;
    ensureTab();
    state.activeId = id;
    state.draft = null;
    state.rowOffset = 0;
    const table = state.tables.find((item) => item.id === id);
    if (table) state.collapsed.delete(table.relative);
    renderTree();
    paintTableHead(table);
    const sql = $("dbSql");
    if (sql && table) sql.value = `SELECT * FROM \`${table.name}\` LIMIT ${state.rowLimit}`;
    switchTab("query");
    if (table) syncDatabaseForTable(table);
  }

  function loadTable(offset = state.rowOffset) {
    if (!state.activeId) return;
    state.rowOffset = offset;
    post("dbTable", {
      envId: state.activeEnvId,
      tableId: state.activeId,
      limit: state.rowLimit,
      offset,
    });
  }

  function loadDefinition() {
    if (!state.activeId) return;
    post("dbDefinition", { envId: state.activeEnvId, tableId: state.activeId });
  }

  function renderTable(payload) {
    const wrap = $("dbTableWrap");
    if (!wrap) return;
    if (!payload?.ok) {
      wrap.innerHTML = `<div class="excel-empty">${esc(payload?.error || "读取失败")}</div>`;
      setTableMeta(payload?.error || "读取失败", true);
      renderRowPager(0, 0, 0);
      return;
    }
    state.page = payload;
    state.rowTotal = Number(payload.total || 0);
    state.rowOffset = Number(payload.offset || 0);
    const columns = payload.columns || [];
    const pk = payload.table?.primaryKey || [];
    const editing = state.mode === "edit" && pk.length > 0;
    const count = (payload.rows || []).length;
    const offset = Number(payload.offset || 0);
    const head = `<tr><th class="excel-rowno"></th>${columns.map((name) => `<th>${esc(name)}</th>`).join("")}</tr>`;
    const rows = (payload.rows || []).map((row, index) => {
      const key = JSON.stringify(pk.map((name) => row[name]));
      return `<tr data-db-index="${index}">
        <td class="excel-rowno">${editing ? `<button class="icon-btn db-del" type="button" data-db-del="${index}" title="删除">✕</button>` : ""}</td>
        ${columns.map((name) => {
          const editable = editing ? ` contenteditable="true" data-db-col="${esc(name)}" data-db-key="${esc(key)}"` : "";
          return `<td class="excel-cell"${editable}>${esc(formatCell(row[name]))}</td>`;
        }).join("")}
      </tr>`;
    }).join("");
    const draft = state.draft && editing
      ? `<tr class="db-draft"><td class="excel-rowno"></td>${columns.map((name) => `<td contenteditable="true" data-draft-col="${esc(name)}"></td>`).join("")}</tr>`
      : "";
    wrap.innerHTML = `<table class="excel-table"><thead>${head}</thead><tbody>${rows}${draft}</tbody></table>`;
    const from = count ? offset + 1 : 0;
    const to = count ? offset + count : 0;
    const modeNote = state.mode === "edit" ? "" : " · 阅读";
    setTableMeta(`${from}-${to} / ${payload.total} 行 · 每页 ${state.rowLimit}${pk.length ? modeNote : " · 无主键，只读"}`, false);
    renderRowPager(from, to, Number(payload.total || 0));
  }

  function renderRowPager(from, to, total) {
    const pager = $("dbRowPager");
    if (!pager) return;
    const pages = Math.max(1, Math.ceil(total / state.rowLimit));
    const current = Math.floor(state.rowOffset / state.rowLimit) + 1;
    const hasPrev = state.rowOffset > 0;
    const hasNext = to < total;
    const sizes = [20, 50, 100, 200];
    if (!sizes.includes(state.rowLimit)) sizes.push(state.rowLimit);
    pager.innerHTML = `
      <button class="btn" type="button" data-row-page="first" ${hasPrev ? "" : "disabled"} title="首页">«</button>
      <button class="btn" type="button" data-row-page="-1" ${hasPrev ? "" : "disabled"} title="上一页">上一页</button>
      <span class="pager-info">${total ? `${from}-${to} / ${total}` : "0 行"} · ${current}/${pages}</span>
      <button class="btn" type="button" data-row-page="1" ${hasNext ? "" : "disabled"} title="下一页">下一页</button>
      <button class="btn" type="button" data-row-page="last" ${hasNext ? "" : "disabled"} title="末页">»</button>
      <select class="pill pager-size" id="dbPageSize" title="每页行数">
        ${sizes.map((size) => `<option value="${size}"${size === state.rowLimit ? " selected" : ""}>${size}</option>`).join("")}
      </select>`;
  }

  function renderDefinition(payload) {
    state.definition = payload;
    const wrap = $("dbDdlWrap");
    const meta = $("dbDdlMeta");
    if (!wrap) return;
    const local = String(payload?.local || "");
    const remote = String(payload?.ddl || "");
    if (meta) {
      meta.textContent = payload?.error
        ? `${payload?.table || ""} · ${payload.error}`
        : `${payload?.table || ""}${payload?.relative ? ` · ${payload.relative}` : ""}`;
      meta.classList.toggle("is-error", Boolean(payload?.error));
    }
    state.diffOnly = Boolean($("dbDiffOnly")?.checked);
    const diff = diffLines(local, remote);
    const localRows = diff.filter((row) => !state.diffOnly || row.type !== "same");
    wrap.innerHTML = `
      <div class="db-diff-col">
        <div class="db-diff-head">项目 SQL 文件${payload?.relative ? ` · ${esc(payload.relative)}` : ""}</div>
        <div class="db-diff-body">${localRows.map((row) => `
          <div class="db-diff-row is-${row.type}-left">${esc(row.left)}</div>`).join("") || `<div class="excel-empty">文件里没有这张表的定义</div>`}</div>
      </div>
      <div class="db-diff-col">
        <div class="db-diff-head">数据库表定义</div>
        <div class="db-diff-body">${localRows.map((row) => `
          <div class="db-diff-row is-${row.type}-right">${esc(row.right)}</div>`).join("") || `<div class="excel-empty">${esc(payload?.error || "库里没有这张表")}</div>`}</div>
      </div>`;
  }

  /** 逐行对比：返回同一行号上的左右内容与差异类型 */
  function diffLines(leftText, rightText) {
    const left = String(leftText || "").replace(/\r\n/g, "\n").split("\n");
    const right = String(rightText || "").replace(/\r\n/g, "\n").split("\n");
    const norm = (line) => line.trim().replace(/\s+/g, " ").replace(/`/g, "").toUpperCase();
    const rows = [];
    const max = Math.max(left.length, right.length);
    let li = 0;
    let ri = 0;
    while (li < left.length || ri < right.length) {
      const l = left[li];
      const r = right[ri];
      if (l === undefined) {
        rows.push({ type: "add", left: "", right: r });
        ri += 1;
        continue;
      }
      if (r === undefined) {
        rows.push({ type: "del", left: l, right: "" });
        li += 1;
        continue;
      }
      if (norm(l) === norm(r)) {
        rows.push({ type: "same", left: l, right: r });
        li += 1;
        ri += 1;
        continue;
      }
      // 在窗口内找对齐，避免整体错位
      const la = left.findIndex((line, i) => i > li && i < li + 6 && norm(line) === norm(r));
      const ra = right.findIndex((line, i) => i > ri && i < ri + 6 && norm(line) === norm(l));
      if (ra >= 0 && (la < 0 || ra - ri <= la - li)) {
        for (let i = ri; i < ra && i < right.length; i++) rows.push({ type: "add", left: "", right: right[i] });
        ri = ra;
        continue;
      }
      if (la >= 0) {
        for (let i = li; i < la && i < left.length; i++) rows.push({ type: "del", left: left[i], right: "" });
        li = la;
        continue;
      }
      rows.push({ type: "change", left: l, right: r });
      li += 1;
      ri += 1;
    }
    void max;
    return rows;
  }

  function formatCell(value) {
    if (value == null) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function setTableMeta(text, isError) {
    const meta = $("dbTableMeta");
    if (!meta) return;
    meta.textContent = text;
    meta.classList.toggle("is-error", Boolean(isError));
  }

  function commitCell(cell) {
    const page = state.page;
    if (state.mode !== "edit" || !cell || !page?.ok) return;
    const col = cell.getAttribute("data-db-col");
    const index = Number(cell.closest("tr")?.getAttribute("data-db-index"));
    const row = page.rows?.[index];
    if (!col || !row) return;
    const value = cell.textContent ?? "";
    if (value === formatCell(row[col])) return;
    const pk = {};
    for (const name of page.table?.primaryKey || []) pk[name] = row[name];
    post("dbUpdate", { envId: state.activeEnvId, tableId: state.activeId, column: col, value, pk });
  }

  function renderQuery(payload) {
    const wrap = $("dbResultWrap");
    const meta = $("dbQueryMeta");
    if (!wrap) return;
    if (!payload?.ok) {
      wrap.innerHTML = `<div class="excel-empty">${esc(payload?.error || "执行失败")}</div>`;
      if (meta) meta.textContent = "";
      return;
    }
    const blocks = payload.results || [];
    if (meta) {
      const last = blocks[blocks.length - 1];
      meta.textContent = last?.rows ? `${last.rows.length} 行` : `影响 ${last?.affected || 0} 行`;
    }
    wrap.innerHTML = blocks.map((block) => {
      if (!block.rows) return `<div class="excel-empty">${esc(block.sql)} · 影响 ${block.affected || 0} 行</div>`;
      const cols = block.columns || [];
      return `<table class="excel-table"><thead><tr>${cols.map((name) => `<th>${esc(name)}</th>`).join("")}</tr></thead><tbody>${
        block.rows.map((row) => `<tr>${cols.map((name) => `<td>${esc(formatCell(row[name]))}</td>`).join("")}</tr>`).join("")
      }</tbody></table>`;
    }).join("");
  }

  function ensureTab() {
    window.ProtoViewHome?.openTab?.("db", "DbView Client");
    window.ProtoViewHome?.setView?.("db");
  }

  function ensure(force = false) {
    const tree = $("dbTree");
    if (tree && !state.tables.length) tree.innerHTML = `<div class="excel-empty">扫描中…</div>`;
    post("sqlCatalog", { force });
    post("dbEnvLoad", {});
  }

  function bindSplit() {
    const workspace = $("dbQueryWorkspace");
    const apply = () => {
      workspace?.style.setProperty("--req-size", `${Math.round(state.sqlRatio * 1000) / 10}%`);
      workspace?.classList.toggle("req-collapsed", state.sqlCollapsed);
      workspace?.classList.toggle("resp-collapsed", state.resultCollapsed);
    };
    $("dbSplitBar")?.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      workspace?.classList.add("splitting");
      const move = (ev) => {
        const rect = workspace.getBoundingClientRect();
        if (!rect.height) return;
        state.sqlRatio = Math.min(0.82, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
        state.sqlCollapsed = false;
        state.resultCollapsed = false;
        apply();
      };
      const up = () => {
        workspace?.classList.remove("splitting");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    const stack = $("dbStack");
    const applyStack = () => {
      stack?.style.setProperty("--db-stack-size", `${Math.round(state.stackRatio * 1000) / 10}%`);
    };
    $("dbStackBar")?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const move = (ev) => {
        const rect = stack.getBoundingClientRect();
        if (!rect.height) return;
        state.stackRatio = Math.min(0.78, Math.max(0.22, (ev.clientY - rect.top) / rect.height));
        applyStack();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    applyStack();
    $("dbCollapseSql")?.addEventListener("click", () => {
      state.sqlCollapsed = !state.sqlCollapsed;
      if (state.sqlCollapsed && state.resultCollapsed) state.resultCollapsed = false;
      apply();
    });
    $("dbCollapseResult")?.addEventListener("click", () => {
      state.resultCollapsed = !state.resultCollapsed;
      if (state.sqlCollapsed && state.resultCollapsed) state.sqlCollapsed = false;
      apply();
    });
    $("dbSplitBar")?.addEventListener("dblclick", () => {
      state.sqlRatio = 0.46;
      state.sqlCollapsed = false;
      state.resultCollapsed = false;
      apply();
    });
    apply();
    paintDbMode();
  }

  $("dbFilter")?.addEventListener("input", () => {
    state.filter = $("dbFilter").value || "";
    renderTree();
  });
  $("dbTree")?.addEventListener("click", (event) => {
    const table = event.target.closest("[data-sql-table]");
    if (table) {
      let id = table.getAttribute("data-sql-table") || "";
      try { id = decodeURIComponent(id); } catch { /* keep */ }
      openTable(id);
      return;
    }
    const file = event.target.closest("[data-sql-file]");
    if (!file) return;
    const key = file.getAttribute("data-sql-file");
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    renderTree();
  });
  $("dbReload")?.addEventListener("click", () => ensure(true));
  $("dbRefreshRows")?.addEventListener("click", () => loadTable());
  $("dbEnvSelect")?.addEventListener("change", () => {
    state.activeEnvId = $("dbEnvSelect").value;
    updateEnvMeta();
    refreshDatabases();
  });
  $("dbDatabaseSelect")?.addEventListener("change", () => {
    const name = $("dbDatabaseSelect").value;
    if (name) rememberManual(name);
    pickDatabase(name);
  });
  $("dbMode")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-db-mode]");
    if (!btn) return;
    state.mode = btn.getAttribute("data-db-mode") === "edit" ? "edit" : "read";
    if (state.mode !== "edit") state.draft = null;
    paintDbMode();
    if (state.page) renderTable(state.page);
  });
  $("dbJump")?.addEventListener("click", () => {
    const table = state.tables.find((item) => item.id === state.activeId);
    if (!table?.file) return;
    window.ProtoViewClient?.openSourceFile?.(table.file, 1);
  });
  $("dbEnvBtn")?.addEventListener("click", () => {
    state.envEditing = currentEnv()?.id || "";
    fillEnvForm();
    $("dbEnvModal")?.classList.add("show");
  });
  $("dbEnvClose")?.addEventListener("click", () => $("dbEnvModal")?.classList.remove("show"));
  $("dbEnvModal")?.addEventListener("click", (event) => {
    if (event.target === $("dbEnvModal")) $("dbEnvModal").classList.remove("show");
  });
  $("dbEnvList")?.addEventListener("click", (event) => {
    const up = event.target.closest("[data-db-env-up]");
    const down = event.target.closest("[data-db-env-down]");
    const del = event.target.closest("[data-db-env-del]");
    if (up || down || del) {
      const id = (up || down || del).getAttribute(up ? "data-db-env-up" : down ? "data-db-env-down" : "data-db-env-del");
      const index = state.envs.findIndex((env) => env.id === id);
      if (index < 0) return;
      if (del) {
        if (!window.confirm(`删除环境「${state.envs[index].name}」？`)) return;
        state.envs.splice(index, 1);
        if (state.envEditing === id) state.envEditing = state.envs[0]?.id || "";
        if (state.activeEnvId === id) state.activeEnvId = state.envs[0]?.id || "";
        persistEnvOrder();
        refreshDatabases();
        fillEnvForm();
        return;
      }
      const next = index + (up ? -1 : 1);
      if (next < 0 || next >= state.envs.length) return;
      const [item] = state.envs.splice(index, 1);
      state.envs.splice(next, 0, item);
      persistEnvOrder();
      return;
    }
    const item = event.target.closest("[data-db-env]");
    if (!item) return;
    state.envs = state.envs.map((env) => env.id === state.envEditing ? { ...env, ...readEnvForm(), id: env.id } : env);
    state.envEditing = item.getAttribute("data-db-env");
    fillEnvForm();
  });
  $("dbEnvTest")?.addEventListener("click", () => {
    const node = $("dbTestResult");
    if (node) node.textContent = "连接中…";
    post("dbTest", { env: readEnvForm() });
  });
  $("dbEnvSave")?.addEventListener("click", () => {
    const edited = readEnvForm();
    state.envs = state.envs.map((env) => env.id === edited.id ? edited : env);
    if (!state.envs.some((env) => env.id === edited.id)) state.envs.push(edited);
    state.activeEnvId = edited.id;
    post("dbEnvSave", { envs: state.envs });
    $("dbEnvModal")?.classList.remove("show");
  });
  $("dbEnvAdd")?.addEventListener("click", () => {
    const id = `env-${Date.now()}`;
    const next = {
      id,
      name: "新环境",
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "",
      database: "",
    };
    state.envs = state.envs.concat([next]);
    state.envEditing = id;
    state.activeEnvId = id;
    fillEnvForm();
  });
  $("dbRunSql")?.addEventListener("click", () => {
    post("dbQuery", { envId: state.activeEnvId, sql: $("dbSql")?.value || "" });
  });
  $("dbSql")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      post("dbQuery", { envId: state.activeEnvId, sql: $("dbSql")?.value || "" });
    }
  });
  $("dbTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-db-tab]");
    if (!tab) return;
    switchTab(tab.getAttribute("data-db-tab"));
  });
  $("dbRowPager")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-row-page]");
    if (!btn || btn.disabled) return;
    const dir = btn.getAttribute("data-row-page");
    const pages = Math.max(1, Math.ceil(state.rowTotal / state.rowLimit));
    let next = state.rowOffset;
    if (dir === "first") next = 0;
    else if (dir === "last") next = (pages - 1) * state.rowLimit;
    else next = state.rowOffset + Number(dir) * state.rowLimit;
    loadTable(Math.max(0, Math.min(next, (pages - 1) * state.rowLimit)));
  });
  $("dbRowPager")?.addEventListener("change", (event) => {
    if (event.target.id !== "dbPageSize") return;
    state.rowLimit = Number(event.target.value) || 50;
    loadTable(0);
  });
  $("dbDiffOnly")?.addEventListener("change", () => {
    if (state.definition) renderDefinition(state.definition);
  });
  $("dbAddRow")?.addEventListener("click", () => {
    if (state.mode !== "edit" || !state.page?.ok) return;
    state.draft = {};
    renderTable(state.page);
    const row = $("dbTableWrap")?.querySelector(".db-draft");
    row?.querySelector("[data-draft-col]")?.focus();
  });
  $("dbTableWrap")?.addEventListener("focusout", (event) => {
    const draftCell = event.target.closest?.("[data-draft-col]");
    if (draftCell) {
      const row = draftCell.closest("tr");
      if (row?.contains(event.relatedTarget)) return;
      const values = {};
      row.querySelectorAll("[data-draft-col]").forEach((cell) => {
        values[cell.getAttribute("data-draft-col")] = cell.textContent ?? "";
      });
      state.draft = null;
      if (!Object.values(values).some((value) => String(value).trim())) {
        renderTable(state.page);
        return;
      }
      post("dbInsert", { envId: state.activeEnvId, tableId: state.activeId, values });
      return;
    }
    const cell = event.target.closest?.("[data-db-col]");
    if (cell) commitCell(cell);
  });
  $("dbTableWrap")?.addEventListener("keydown", (event) => {
    const cell = event.target.closest?.(".excel-cell, [data-draft-col]");
    if (!cell) return;
    if (event.key === "Enter") {
      event.preventDefault();
      cell.blur();
    }
  });
  $("dbTableWrap")?.addEventListener("click", (event) => {
    const del = event.target.closest("[data-db-del]");
    if (!del || !state.page?.ok) return;
    const row = state.page.rows[Number(del.getAttribute("data-db-del"))];
    if (!row) return;
    const pk = {};
    for (const name of state.page.table?.primaryKey || []) pk[name] = row[name];
    post("dbDelete", { envId: state.activeEnvId, tableId: state.activeId, pk });
  });

  bindSplit();
  $("dbTreeToggle")?.addEventListener("click", () => toggleAllFiles());

  window.ProtoViewDb = {
    ensure: () => ensure(false),
    search(query, onHits) {
      if (typeof onHits === "function") searchWaiters.push(onHits);
      post("sqlSearch", { query });
    },
    openTable,
    toggleAll: () => toggleAllFiles(),
    isTreeOpen: () => [...new Set(state.tables.map((table) => table.relative))].some((file) => !state.collapsed.has(file)),
  };
})();
