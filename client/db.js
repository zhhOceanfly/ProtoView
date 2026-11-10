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
    database: "",
    tab: "query",
    envEditing: "",
    limits: [],
    sqlRatio: 0.46,
    sqlCollapsed: false,
    resultCollapsed: false,
    rowLimit: 50,
    definition: null,
    diffOnly: false,
    query: null,
    lastSyncKey: "",
    resultBlocks: [],
    resultPage: 0,
    resultPageSize: 100,
    pendingTableName: "",
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
      if (state.pendingTableName) {
        const name = state.pendingTableName;
        state.pendingTableName = "";
        openTableByName(name);
      }
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
    if (data.type === "dbDefinition") renderDefinition(data.payload);
    if (data.type === "dbMutate") {
      const result = data.payload || {};
      const meta = $("dbQueryMeta");
      if (meta) {
        meta.textContent = result.ok ? `已更新 ${result.affected || 0} 行` : `失败：${result.error || "未知错误"}`;
        meta.classList.toggle("is-error", !result.ok);
      }
      if (result.ok) renderQueryPage();
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

  /** 归一化：去掉下划线、横线等分隔符并转小写，便于 GamePlayerStorage ≈ game_player_storage */
  function normalizeName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function databaseCandidates(table) {
    const out = [];
    const push = (value) => {
      const text = String(value || "").trim();
      if (text && !out.includes(text)) out.push(text);
    };
    push(fileStem(table));
    push(table?.name);
    const base = String(table?.relative || "").split("/").pop() || "";
    push(base.replace(/\.[^.]+$/, ""));
    return out.map((item) => ({ raw: item, key: item.toLowerCase(), norm: normalizeName(item) }))
      .filter((item) => item.key && item.norm.length >= 3);
  }

  // ===== 环境 =====
  /**
   * 库名与 SQL 文件名 / 表名匹配：忽略大小写与分隔符，
   * 并接受「库名里包含文件名」这类前缀后缀（zyyg_game_player_storage ≈ GamePlayerStorage.sql）。
   * 匹配不到返回空，交由用户手选。
   */
  function matchDatabase(table) {
    const candidates = databaseCandidates(table);
    if (!candidates.length) return "";
    const lower = state.databases.map((name) => ({ name, key: name.toLowerCase(), norm: normalizeName(name) }));
    for (const candidate of candidates) {
      const exact = lower.find((item) => item.key === candidate.key);
      if (exact) return exact.name;
    }
    for (const candidate of candidates) {
      const normed = lower.find((item) => item.norm && item.norm === candidate.norm);
      if (normed) return normed.name;
    }
    // 库名以文件名 / 表名开头或结尾（长候选优先，避免 game 抢走 game_player）
    const sorted = [...candidates].sort((a, b) => b.norm.length - a.norm.length);
    for (const candidate of sorted) {
      const prefixed = lower.filter((item) => item.key.startsWith(candidate.key) || item.norm.startsWith(candidate.norm));
      if (prefixed.length) {
        prefixed.sort((a, b) => a.key.length - b.key.length);
        return prefixed[0].name;
      }
    }
    for (const candidate of sorted) {
      const suffixed = lower.filter((item) => item.key.endsWith(candidate.key) || item.norm.endsWith(candidate.norm));
      if (suffixed.length) {
        suffixed.sort((a, b) => a.key.length - b.key.length);
        return suffixed[0].name;
      }
    }
    // 最后：库名中间包含文件名 / 表名（zyyg_game_player_storage）
    for (const candidate of sorted) {
      if (candidate.norm.length < 4) continue;
      const contained = lower
        .filter((item) => item.norm.includes(candidate.norm) || item.key.includes(candidate.key))
        .sort((a, b) => a.key.length - b.key.length);
      if (contained.length) return contained[0].name;
    }
    // 反向：文件名里包含库名（GamePlayerStorage2024.sql）
    for (const candidate of sorted) {
      const holders = lower
        .filter((item) => item.norm.length >= 3 && candidate.norm.includes(item.norm))
        .sort((a, b) => b.key.length - a.key.length);
      if (holders.length) return holders[0].name;
    }
    return "";
  }

  function resolveDatabase(table) {
    const matched = matchDatabase(table);
    if (matched) return matched;
    const manual = lastManualDatabase();
    if (manual && state.databases.includes(manual)) return manual;
    return "";
  }

  function paintDatabaseSelect() {
    const select = $("dbDatabaseSelect");
    if (!select) return "";
    select.innerHTML = `<option value="">选择数据库</option>${state.databases.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
    const table = state.tables.find((item) => item.id === state.activeId);
    const desired = table ? resolveDatabase(table) : (currentEnv()?.database || "");
    select.value = state.databases.includes(desired) ? desired : "";
    return select.value;
  }

  function applyDatabases(payload) {
    state.databases = Array.isArray(payload?.databases) ? payload.databases : [];
    const chosen = paintDatabaseSelect();
    if (!state.databases.length && payload?.error) {
      const meta = $("dbEnvMeta");
      if (meta) {
        meta.textContent = payload.error;
        meta.classList.add("is-error");
      }
    }
    updateEnvMeta();
    const table = state.tables.find((item) => item.id === state.activeId);
    if (table && chosen) syncDatabase(table, chosen);
    else if (table) hintNoDatabase(table);
  }

  function hintNoDatabase(table) {
    const meta = $("dbEnvMeta");
    if (!meta || !state.databases.length) return;
    meta.textContent = `没有和「${fileStem(table)}」同名的库，请在上方手选`;
    meta.classList.add("is-error");
  }

  /** 把库写到当前环境上（服务端池按它连库），再按当前标签页刷新。 */
  function syncDatabase(table, name) {
    const env = currentEnv();
    if (!env || !name) return;
    const key = `${state.activeId}|${name}`;
    const changed = env.database !== name;
    if (changed) {
      const envs = state.envs.map((item) => item.id === env.id ? { ...item, database: name } : item);
      state.envs = envs;
      post("dbEnvSave", { envs });
      const select = $("dbEnvSelect");
      if (select) select.value = state.activeEnvId;
    }
    state.database = name;
    updateEnvMeta();
    const node = $("dbDatabaseSelect");
    if (node) node.value = name;
    // 库变化会触发一次 dbEnvs/dbDatabases 回包；查询本身也带 database，避免二次刷新
    if (state.lastSyncKey === key && !changed) return;
    state.lastSyncKey = key;
    if (state.tab === "ddl") loadDefinition();
    else runSql();
  }

  function pickDatabase(name) {
    const select = $("dbDatabaseSelect");
    if (select) select.value = state.databases.includes(name) ? name : "";
    if (name) rememberManual(name);
    const table = state.tables.find((item) => item.id === state.activeId);
    if (!table) {
      const env = currentEnv();
      if (env && env.database !== name) {
        state.envs = state.envs.map((item) => item.id === env.id ? { ...item, database: name } : item);
        post("dbEnvSave", { envs: state.envs });
      }
      updateEnvMeta();
      return;
    }
    syncDatabase(table, name);
  }

  function syncDatabaseForTable(table) {
    if (!table) return;
    paintTableHead(table);
    if (!state.databases.length) {
      refreshDatabases();
      return;
    }
    const name = paintDatabaseSelect();
    if (!name) {
      hintNoDatabase(table);
      if (state.tab === "ddl") loadDefinition();
      else {
        const wrap = $("dbResultWrap");
        if (wrap) {
          wrap.innerHTML = `<div class="excel-empty">没有和「${esc(fileStem(table))} / ${esc(table.name)}」匹配的库，请在上方手选。下次仍匹配不到时会沿用这次的选择。</div>`;
        }
      }
      return;
    }
    syncDatabase(table, name);
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
    list.innerHTML = state.envs.map((env) => `
      <div class="env-item${env.id === state.envEditing ? " active" : ""}" data-db-env="${esc(env.id)}">
        <div>
          <strong>${esc(env.name)}</strong>
          <span>${esc(env.user)}@${esc(env.host)}:${esc(env.port)}</span>
        </div>
        <div class="env-actions">
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
    const sql = $("dbSql");
    if (sql) sql.readOnly = false;
  }
  void paintDbMode;

  function openTable(id) {
    if (!id) return;
    ensureTab();
    state.activeId = id;
    state.lastSyncKey = "";
    const table = state.tables.find((item) => item.id === id);
    if (table) state.collapsed.delete(table.relative);
    renderTree();
    paintTableHead(table);
    const sql = $("dbSql");
    if (sql && table) sql.value = `SELECT * FROM \`${table.name}\` LIMIT ${state.rowLimit}`;
    if (table) syncDatabaseForTable(table);
  }

  /** 按表名找表并打开（链路「查看 DB」跳转用），表还没扫描到时记下来等目录回包 */
  function findTableByName(name) {
    const raw = String(name || "").trim();
    if (!raw) return null;
    const key = normalizeName(raw);
    const bare = raw.includes(".") ? raw.split(".").pop() : raw;
    const bareKey = normalizeName(bare);
    return state.tables.find((table) => table.name.toLowerCase() === raw.toLowerCase())
      || state.tables.find((table) => table.name.toLowerCase() === bare.toLowerCase())
      || state.tables.find((table) => normalizeName(table.name) === bareKey)
      || state.tables.find((table) => normalizeName(table.name).endsWith(bareKey) || bareKey.endsWith(normalizeName(table.name)))
      || null;
  }

  function openTableByName(name) {
    const table = findTableByName(name);
    if (table) {
      openTable(table.id);
      switchTab("query");
      return true;
    }
    state.pendingTableName = String(name || "");
    ensureTab();
    ensure(true);
    return false;
  }

  function loadDefinition() {
    if (!state.activeId) return;
    post("dbDefinition", { envId: state.activeEnvId, tableId: state.activeId, database: currentDatabase() });
  }

  function runSql() {
    const sql = $("dbSql")?.value || "";
    if (!sql.trim()) {
      const wrap = $("dbResultWrap");
      if (wrap) wrap.innerHTML = `<div class="excel-empty">先写一条 SQL</div>`;
      return;
    }
    const meta = $("dbResultMeta");
    if (meta) meta.textContent = "执行中…";
    post("dbQuery", { envId: state.activeEnvId, sql, database: currentDatabase() });
  }

  /** 当前要连的库：下拉框优先，其次环境里存的 */
  function currentDatabase() {
    return $("dbDatabaseSelect")?.value || currentEnv()?.database || "";
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

  function renderQuery(payload) {
    const wrap = $("dbResultWrap");
    const meta = $("dbQueryMeta");
    if (!wrap) return;
    if (!payload?.ok) {
      wrap.innerHTML = `<div class="excel-empty">${esc(payload?.error || "执行失败")}</div>`;
      if (meta) meta.textContent = "";
      state.resultBlocks = [];
      renderResultPager();
      return;
    }
    state.resultBlocks = payload.results || [];
    state.resultPage = 0;
    renderQueryPage();
  }

  function resultRowBlock() {
    return (state.resultBlocks || []).find((block) => Array.isArray(block.rows) && block.rows.length) || null;
  }

  function renderQueryPage() {
    const wrap = $("dbResultWrap");
    const meta = $("dbQueryMeta");
    if (!wrap) return;
    const blocks = state.resultBlocks || [];
    if (!blocks.length) {
      wrap.innerHTML = `<div class="excel-empty">执行 SQL 后在这里看结果</div>`;
      renderResultPager();
      return;
    }
    const size = state.resultPageSize || 100;
    const target = resultRowBlock();
    const total = target ? target.rows.length : 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(0, state.resultPage), pages - 1);
    state.resultPage = page;
    const from = page * size;
    const slice = target ? target.rows.slice(from, from + size) : [];
    if (meta) {
      if (target) {
        meta.textContent = total > size
          ? `${from + 1}-${from + slice.length} / ${target.rows.length} 行`
          : `${target.rows.length} 行`;
      } else {
        const last = blocks[blocks.length - 1];
        meta.textContent = `影响 ${last?.affected || 0} 行`;
      }
    }
    wrap.innerHTML = blocks.map((block) => {
      if (!block.rows) return `<div class="excel-empty">${esc(block.sql)} · 影响 ${block.affected || 0} 行</div>`;
      if (block !== target) {
        const cols = block.columns || [];
        return `<table class="excel-table"><thead><tr>${cols.map((name) => `<th>${esc(name)}</th>`).join("")}</tr></thead><tbody>${
          block.rows.slice(0, 50).map((row) => `<tr>${cols.map((name) => `<td>${esc(formatCell(row[name]))}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`;
      }
      const cols = block.columns || [];
      const table = state.tables.find((item) => item.id === state.activeId);
      const pk = table?.primaryKey || [];
      const editable = canEditQueryResult(block);
      return `<table class="excel-table db-result-table"><thead><tr><th class="excel-rowno"></th>${cols.map((name) => `<th>${esc(name)}</th>`).join("")}</tr></thead><tbody>${
        slice.map((row, index) => {
          const key = JSON.stringify(pk.map((name) => row[name]));
          return `<tr data-result-row="${from + index}"><td class="excel-rowno">${from + index + 1}</td>${cols.map((name) => {
            const attr = editable ? ` data-result-col="${esc(name)}" data-result-key="${esc(key)}" title="双击修改"` : "";
            return `<td class="excel-cell"${attr}>${esc(formatCell(row[name]))}</td>`;
          }).join("")}</tr>`;
        }).join("")
      }</tbody></table>`;
    }).join("");
    renderResultPager(from, from + slice.length, total, pages, page);
  }

  /** 只有当前表（含主键）的结果集才能就地改数据 */
  function canEditQueryResult(block) {
    const table = state.tables.find((item) => item.id === state.activeId);
    if (!table || !(table.primaryKey || []).length) return false;
    const cols = block.columns || [];
    return table.primaryKey.every((name) => cols.includes(name));
  }

  function renderResultPager(from, to, total, pages, page) {
    const pager = $("dbResultPager");
    if (!pager) return;
    if (!total) {
      pager.innerHTML = "";
      return;
    }
    const sizes = [50, 100, 200, 500];
    pager.innerHTML = `
      <button class="btn" type="button" data-result-page="-1" ${page <= 0 ? "disabled" : ""}>上一页</button>
      <span class="pager-info">${from + 1}-${to} / ${total} · ${page + 1}/${pages}</span>
      <button class="btn" type="button" data-result-page="1" ${page >= pages - 1 ? "disabled" : ""}>下一页</button>
      <select class="pill pager-size" id="dbResultPageSize" title="每页行数">
        ${sizes.map((size) => `<option value="${size}"${size === (state.resultPageSize || 100) ? " selected" : ""}>${size}</option>`).join("")}
      </select>`;
  }

  /** 查询结果双击改单元格：写库后只改动当前行，避免整表重查 */
  function beginEditResultCell(cell) {
    if (!cell || cell.getAttribute("contenteditable") === "true") return;
    const col = cell.getAttribute("data-result-col");
    const block = resultRowBlock();
    if (!col || !block) return;
    cell.setAttribute("contenteditable", "true");
    cell.dataset.original = cell.textContent ?? "";
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function commitResultCell(cell) {
    if (!cell || cell.getAttribute("contenteditable") !== "true") return;
    cell.removeAttribute("contenteditable");
    const col = cell.getAttribute("data-result-col");
    const value = cell.textContent ?? "";
    const original = cell.dataset.original ?? "";
    delete cell.dataset.original;
    if (!col || value === original) {
      cell.textContent = original;
      return;
    }
    const block = resultRowBlock();
    const rowIndex = Number(cell.closest("tr")?.getAttribute("data-result-row"));
    const row = block?.rows?.[rowIndex];
    const table = state.tables.find((item) => item.id === state.activeId);
    if (!row || !table) return;
    const pk = {};
    for (const name of table.primaryKey || []) pk[name] = row[name];
    post("dbUpdate", { envId: state.activeEnvId, tableId: table.id, column: col, value, pk, database: currentDatabase() });
    row[col] = value;
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
  $("dbEnvSelect")?.addEventListener("change", () => {
    state.activeEnvId = $("dbEnvSelect").value;
    state.lastSyncKey = "";
    updateEnvMeta();
    refreshDatabases();
  });
  $("dbDatabaseSelect")?.addEventListener("change", () => {
    const name = $("dbDatabaseSelect").value;
    if (name) rememberManual(name);
    pickDatabase(name);
  });
  $("dbResultPager")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-result-page]");
    if (!btn || btn.disabled) return;
    state.resultPage = Math.max(0, state.resultPage + Number(btn.getAttribute("data-result-page")));
    renderQueryPage();
  });
  $("dbResultPager")?.addEventListener("change", (event) => {
    if (event.target.id !== "dbResultPageSize") return;
    state.resultPageSize = Number(event.target.value) || 100;
    state.resultPage = 0;
    renderQueryPage();
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
    const del = event.target.closest("[data-db-env-del]");
    if (del) {
      const id = del.getAttribute("data-db-env-del");
      const index = state.envs.findIndex((env) => env.id === id);
      if (index < 0) return;
      if (!window.confirm(`删除环境「${state.envs[index].name}」？`)) return;
      state.envs.splice(index, 1);
      if (state.envEditing === id) state.envEditing = state.envs[0]?.id || "";
      if (state.activeEnvId === id) state.activeEnvId = state.envs[0]?.id || "";
      persistEnvOrder();
      refreshDatabases();
      fillEnvForm();
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
    refreshDatabases();
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
  $("dbRunSql")?.addEventListener("click", () => runSql());
  $("dbSql")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runSql();
    }
  });
  $("dbTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-db-tab]");
    if (!tab) return;
    switchTab(tab.getAttribute("data-db-tab"));
  });
  $("dbDiffOnly")?.addEventListener("change", () => {
    if (state.definition) renderDefinition(state.definition);
  });
  $("dbTreeToggle")?.addEventListener("click", () => toggleAllFiles());
  $("dbResultWrap")?.addEventListener("dblclick", (event) => {
    const cell = event.target.closest?.(".excel-cell");
    if (cell) beginEditResultCell(cell);
  });
  $("dbResultWrap")?.addEventListener("keydown", (event) => {
    const cell = event.target.closest?.(".excel-cell");
    if (!cell) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitResultCell(cell);
    }
    if (event.key === "Escape") {
      cell.textContent = cell.dataset.original ?? cell.textContent;
      delete cell.dataset.original;
      cell.removeAttribute("contenteditable");
    }
  });
  $("dbResultWrap")?.addEventListener("focusout", (event) => {
    const cell = event.target.closest?.(".excel-cell");
    if (cell) commitResultCell(cell);
  });
  bindSplit();

  window.ProtoViewDb = {
    ensure: () => ensure(false),
    search(query, onHits) {
      if (typeof onHits === "function") searchWaiters.push(onHits);
      post("sqlSearch", { query });
    },
    openTable,
    openTableByName,
    matchDatabase,
    toggleAll: () => toggleAllFiles(),
    isTreeOpen: () => [...new Set(state.tables.map((table) => table.relative))].some((file) => !state.collapsed.has(file)),
  };
})();
