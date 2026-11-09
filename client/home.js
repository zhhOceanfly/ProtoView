(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const vscode = window.__protoViewPost || (() => {
    // app.js 里已建立 bridge，这里复用它的 postMessage
    return null;
  })();
  void vscode;
  const state = {
    view: "client",
    /** 首页固定在 Client 标签里打开，不单独成页 */
    tabs: [{ id: "client", label: "ProtoView Client", closable: false }],
    sheets: [],
    sheetFilter: "",
    activeFile: "",
    activeSheetId: "",
    searchTimer: 0,
    searchSeq: 0,
    /** 首页搜索命中的 proto / 函数结果 */
    homeProtoHits: [],
  };

  // ===== 视图切换 =====
  const VIEW_IDS = { home: "homeView", excel: "excelView", client: "app" };

  /** 首页复用 Client 标签：只切内容，不新增标签 */
  function setView(view) {
    state.view = view;
    for (const [key, id] of Object.entries(VIEW_IDS)) {
      const el = $(id);
      if (!el) continue;
      el.classList.toggle("hidden", key !== view);
    }
    document.body.dataset.view = view;
    renderTabs();
    if (view === "excel") ensureExcelCatalog();
    if (view === "home") requestAnimationFrame(() => $("homeSearch")?.focus());
  }

  /** 入口：已打开就切过去，没有才新建标签 */
  function openTab(id, label) {
    if (id === "home") {
      // 首页永远在当前 Client 标签内显示
      setView("home");
      return;
    }
    if (!state.tabs.some((tab) => tab.id === id)) {
      state.tabs.push({ id, label, closable: true });
    }
    if (id === "excel") setView("excel");
    else setView("client");
    renderTabs();
  }

  function closeTab(id) {
    if (id === "client") return;
    state.tabs = state.tabs.filter((tab) => tab.id !== id);
    if (state.view === id) setView("client");
    renderTabs();
  }

  function renderTabs() {
    const list = $("viewTabList");
    if (!list) return;
    list.innerHTML = state.tabs.map((tab) => `
      <span class="view-tab${tab.id === state.view ? " active" : ""}" data-view-tab="${esc(tab.id)}">
        <button class="view-tab-name" type="button">${esc(tab.label)}</button>
        ${tab.closable ? `<button class="view-tab-close" type="button" data-tab-close="${esc(tab.id)}" title="关闭">✕</button>` : ""}
      </span>`).join("");
  }

  // ===== 宿主通信 =====
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
    if (data.type === "excelCatalog") applyExcelCatalog(data.payload);
    if (data.type === "excelPage") applyExcelPage(data.payload);
    if (data.type === "excelSearch") applyExcelSearch(data.payload);
    if (data.type === "excelUpdate") applyExcelUpdate(data.payload);
  });

  // ===== Excel =====
  let hasCatalog = false;

  function ensureExcelCatalog(force = false) {
    if (hasCatalog && !force) return;
    const list = $("excelList");
    if (list && !state.sheets.length) list.innerHTML = `<div class="excel-empty">扫描中…</div>`;
    if (!post("excelCatalog", { force })) {
      if (list) list.innerHTML = `<div class="excel-empty">独立模式需要连接宿主才能读取 Excel</div>`;
    }
  }

  function applyExcelCatalog(catalog) {
    hasCatalog = true;
    state.sheets = Array.isArray(catalog?.sheets) ? catalog.sheets : [];
    renderExcelList();
    if (catalog?.warnings?.length) {
      // 只在有问题时提示，不打断使用
      console.warn("[ProtoView] excel warnings:", catalog.warnings.slice(0, 5));
    }
  }

  function fileKey(sheet) {
    return sheet?.relative || sheet?.file || "";
  }

  function sheetsOfFile(relative) {
    return state.sheets.filter((sheet) => fileKey(sheet) === relative);
  }

  function renderExcelList() {
    const list = $("excelList");
    if (!list) return;
    const q = state.sheetFilter.trim().toLowerCase();
    const groups = new Map();
    for (const sheet of state.sheets) {
      const key = fileKey(sheet);
      const bucket = groups.get(key) || [];
      bucket.push(sheet);
      groups.set(key, bucket);
    }
    const files = [...groups.entries()].filter(([file, sheets]) => {
      if (!q) return true;
      const blob = `${file} ${sheets.map((sheet) => `${sheet.fileName} ${sheet.sheet}`).join(" ")}`.toLowerCase();
      return blob.includes(q);
    });
    if (!files.length) {
      list.innerHTML = `<div class="excel-empty">${state.sheets.length ? "没有匹配的表" : "未找到 Excel 文件"}</div>`;
      return;
    }
    list.innerHTML = files.map(([file, sheets]) => {
      const name = sheets[0]?.fileName || file.split("/").pop() || file;
      const rows = sheets.reduce((sum, sheet) => sum + Number(sheet.dataCount || 0), 0);
      return `
      <button class="excel-item${file === state.activeFile ? " active" : ""}" type="button" data-excel-file="${esc(file)}" title="${esc(file)}">
        <span class="excel-item-name">${esc(name)}</span>
        <span class="excel-item-meta">${sheets.length} 个 Sheet · ${rows} 行</span>
      </button>`;
    }).join("");
  }

  function renderSheetTabs() {
    const bar = $("excelSheets");
    if (!bar) return;
    const sheets = sheetsOfFile(state.activeFile);
    bar.innerHTML = sheets.map((sheet) => `
      <button class="excel-sheet-tab${sheet.id === state.activeSheetId ? " active" : ""}" type="button" data-sheet-id="${esc(encodeURIComponent(sheet.id))}" title="${esc(sheet.sheet)}">${esc(sheet.sheet)}</button>`).join("");
    bar.querySelector(".excel-sheet-tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function selectFile(relative) {
    if (!relative) return;
    const sheets = sheetsOfFile(relative);
    if (!sheets.length) return;
    const current = sheets.find((sheet) => sheet.id === state.activeSheetId);
    selectSheet((current || sheets[0]).id);
  }

  function selectSheet(id, focusRow = 0) {
    if (!id) return;
    const sheet = state.sheets.find((item) => item.id === id);
    if (!sheet) return;
    state.activeFile = fileKey(sheet);
    state.activeSheetId = id;
    renderExcelList();
    renderSheetTabs();
    const title = $("excelTitle");
    if (title) title.textContent = sheet.fileName || sheet.sheet;
    const meta = $("excelMeta");
    if (meta) meta.textContent = sheet.relative;
    post("excelPage", { id, focusRow });
  }

  function applyExcelPage(page) {
    const wrap = $("excelTableWrap");
    if (!wrap) return;
    if (!page) {
      wrap.innerHTML = `<div class="excel-empty">表读取失败或已被移动</div>`;
      return;
    }
    state.page = page;
    const head = `<tr><th class="excel-rowno">#</th>${page.columns
      .map((col) => `<th title="列 ${esc(col.letter)}">${esc(col.name)}</th>`)
      .join("")}</tr>`;
    const body = page.rows.map((row) => {
      const target = page.focusRow && row.row === page.focusRow ? " is-target" : "";
      return `<tr class="excel-row${target}"><td class="excel-rowno">${row.row}</td>${page.columns
        .map((_, index) => {
          const value = row.cells[index] ?? "";
          return `<td class="excel-cell" contenteditable="true" spellcheck="false"
            data-row="${row.row}" data-col="${index}">${esc(value)}</td>`;
        })
        .join("")}</tr>`;
    }).join("");
    wrap.innerHTML = `<table class="excel-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    const meta = $("excelMeta");
    if (meta) {
      const from = page.offset + 1;
      const to = page.offset + page.rows.length;
      meta.textContent = `${page.relative} · 第 ${from}-${to} 行 / 共 ${page.total} 行${page.truncated ? "（已截断）" : ""}`;
    }
    requestAnimationFrame(() => {
      wrap.querySelector(".excel-row.is-target")?.scrollIntoView({ block: "center" });
    });
  }

  /** 单元格编辑：失焦或回车时写回文件 */
  function commitExcelCell(cell) {
    const page = state.page;
    if (!cell || !page) return;
    const row = Number(cell.getAttribute("data-row"));
    const col = Number(cell.getAttribute("data-col"));
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const value = cell.textContent ?? "";
    const original = page.rows.find((item) => item.row === row)?.cells[col] ?? "";
    if (value === original) return;
    if (!post("excelUpdate", { id: page.id, row, col, value })) {
      setExcelStatus("独立模式无法保存修改", true);
      return;
    }
    setExcelStatus(`保存中 · 行 ${row} 列 ${col + 1}…`);
    // 本地先记住，避免重复提交同一值
    const target = page.rows.find((item) => item.row === row);
    if (target) target.cells[col] = value;
  }

  function setExcelStatus(text, isError = false) {
    const meta = $("excelMeta");
    if (!meta) return;
    meta.textContent = text;
    meta.classList.toggle("is-error", isError);
  }

  function applyExcelUpdate(result) {
    if (!result) return;
    if (!result.ok) {
      setExcelStatus(`保存失败：${result.error || "未知错误"}`, true);
      return;
    }
    if (result.page) {
      const keepFocus = document.activeElement;
      applyExcelPage(result.page);
      void keepFocus;
    }
    setExcelStatus("已保存");
  }

  function applyExcelSearch(hits) {
    const list = Array.isArray(hits) ? hits : [];
    // Tab 全局搜索：直接回调给它
    if (pendingSearch) {
      const cb = pendingSearch;
      pendingSearch = null;
      try { cb(list); } catch { /* ignore */ }
      return;
    }
    // 首页搜索
    if (pendingHomeExcel) {
      pendingHomeExcel = false;
      renderHomeHits(state.homeProtoHits, list);
    }
  }

  // ===== 首页搜索（复用 Tab 全局搜索的全类型数据源） =====
  const HOME_KIND_LABEL = { rpc: "接口", enum: "枚举", func: "函数", const: "常量", excel: "Excel" };

  /** 从 app.js 的全局搜索数据源取 proto / 代码符号，命中后转成首页条目 */
  function collectProtoAndCodeHits(query) {
    const api = window.ProtoViewSearch;
    if (!api) return [];
    let items = [];
    try {
      items = api.searchAll ? api.searchAll(query) : [];
    } catch {
      items = [];
    }
    return items;
  }

  function runHomeSearch() {
    const input = $("homeSearch");
    const query = String(input?.value || "").trim();
    const box = $("homeResults");
    if (!box) return;
    if (!query) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = `<div class="home-result-empty">搜索中…</div>`;

    const protoHits = collectProtoAndCodeHits(query);
    state.homeProtoHits = protoHits;
    // 先渲染本地命中的 proto / 函数，Excel 结果回来了再追加
    if (protoHits.length) renderHomeHits(protoHits);

    const seq = ++state.searchSeq;
    clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      if (seq !== state.searchSeq) return;
      pendingHomeExcel = true;
      if (!post("excelSearch", { query }) && state.homeProtoHits.length) {
        pendingHomeExcel = false;
      }
    }, 180);
  }

  function homeHitHtml(item, kindKey) {
    const kind = HOME_KIND_LABEL[item.kind] || "结果";
    const row = Number(item.row || 0);
    const meta = item.kind === "excel"
      ? `${esc(item.sub || "")}${row ? ` · 行 ${row}` : ""}`
      : esc(item.sub || "");
    return `<button class="home-result" type="button" data-home-hit="${kindKey}" data-home-idx="${Number(item._idx) || 0}">
      <span class="home-result-kind is-${esc(item.kind || "excel")}">${kind}</span>
      <span class="home-result-main">
        <strong>${esc(item.title || "")}</strong>
        <span>${meta}</span>
      </span>
      ${item.preview ? `<span class="home-result-sub">${esc(item.preview)}</span>` : ""}
    </button>`;
  }

  function renderHomeHits(protoHits, excelHits) {
    const box = $("homeResults");
    if (!box) return;
    const proto = Array.isArray(protoHits) ? protoHits : state.homeProtoHits;
    const excel = Array.isArray(excelHits) ? excelHits : [];
    if (!proto.length && !excel.length) {
      box.innerHTML = `<div class="home-result-empty">没有匹配的结果</div>`;
      box.classList.remove("hidden");
      return;
    }
    const protoHtml = proto
      .map((item, index) => homeHitHtml({ ...item, _idx: index }, "proto"))
      .join("");
    const excelHtml = excel.map((hit, index) => {
      const count = Number(hit.count || 0);
      const fileName = hit.fileName || String(hit.relative || "").split("/").pop() || hit.sheet;
      return homeHitHtml({
        kind: "excel",
        title: fileName,
        sub: `${hit.sheet || ""}${count ? ` · ${count} 处` : " · 打开表"}`,
        row: hit.row,
        preview: hit.preview,
        sheetId: hit.sheetId,
        _idx: index,
      }, "excel");
    }).join("");
    box.innerHTML = `${protoHtml}${excelHtml}`;
    box.classList.remove("hidden");
    state.homeExcelHits = excel;
  }

  /** 首页点击 proto 结果：接口/枚举定位左侧定义，函数/常量跳源码 */
  function openProtoHit(item) {
    setView("client");
    const api = window.ProtoViewSearch;
    try {
      api?.openItem?.(item);
    } catch {
      // 忽略：宿主不支持时保持静默
    }
  }

  /** 打开 Excel 表：已开则复用标签 */
  function openExcelSheet(sheetId, row = 0) {
    if (!sheetId) return;
    openTab("excel", "ExcelView");
    setView("excel");
    ensureExcelCatalog();
    const trySelect = (attempt = 0) => {
      if (state.sheets.some((item) => item.id === sheetId)) {
        selectSheet(sheetId, row);
        return;
      }
      if (attempt < 30) window.setTimeout(() => trySelect(attempt + 1), 100);
    };
    trySelect();
  }

  // ===== 事件绑定 =====
  function bind() {
    $("homeBtn")?.addEventListener("click", () => {
      // 首页不新开标签：在当前标签内切换
      if (state.view === "home") setView("client");
      else setView("home");
    });

    $("viewTabList")?.addEventListener("click", (event) => {
      const close = event.target.closest("[data-tab-close]");
      if (close) {
        event.stopPropagation();
        closeTab(close.getAttribute("data-tab-close"));
        return;
      }
      const tab = event.target.closest("[data-view-tab]");
      if (!tab) return;
      const id = tab.getAttribute("data-view-tab");
      if (id === "home") setView("home");
      else if (id === "excel") setView("excel");
      else setView("client");
    });

    $("homeGrid")?.addEventListener("click", (event) => {
      const card = event.target.closest("[data-home-entry]");
      if (!card) return;
      const entry = card.getAttribute("data-home-entry");
      if (entry === "client") setView("client");
      else if (entry === "excel") openTab("excel", "ExcelView");
      else if (entry === "db") {        // DbView 复用调用链路图的 DB 视角：提示去函数 Tab 预览
        const box = $("homeResults");
        if (box) {
          box.innerHTML = `<div class="home-result-empty">DbView：在 Tab 搜索里选「函数」→ 预览，即可查看该函数读写的表</div>`;
          box.classList.remove("hidden");
        }
      }
    });

    $("homeSearch")?.addEventListener("input", runHomeSearch);
    $("homeSearch")?.addEventListener("focus", () => {
      if (String($("homeSearch")?.value || "").trim()) runHomeSearch();
    });
    $("homeSearch")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const box = $("homeResults");
        box?.classList.add("hidden");
        $("homeSearch").value = "";
      }
    });
    document.addEventListener("pointerdown", (event) => {
      const box = $("homeResults");
      if (!box || box.classList.contains("hidden")) return;
      const target = event.target;
      if (target instanceof Node && ($("homeSearch")?.contains(target) || box.contains(target))) return;
      box.classList.add("hidden");
    });

    $("homeResults")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-home-hit]");
      if (!btn) return;
      const index = Number(btn.getAttribute("data-home-idx") || 0);
      const isExcel = btn.getAttribute("data-home-hit") === "excel";
      if (isExcel) {
        const hit = state.homeExcelHits[index] || null;
        if (!hit) return;
        openExcelSheet(hit.sheetId, Number(hit.row) || 0);
        return;
      }
      const item = state.homeProtoHits[index];
      if (!item) return;
      openProtoHit(item);
    });

    $("excelFilter")?.addEventListener("input", () => {
      state.sheetFilter = $("excelFilter").value || "";
      renderExcelList();
    });

    $("excelList")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-excel-file]");
      if (!item) return;
      selectFile(item.getAttribute("data-excel-file"));
    });
    $("excelSheets")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-sheet-id]");
      if (!item) return;
      const raw = item.getAttribute("data-sheet-id") || "";
      let id = raw;
      try { id = decodeURIComponent(raw); } catch { id = raw; }
      selectSheet(id);
    });

    // 单元格编辑：回车提交并下移，Esc 还原
    const tableWrap = $("excelTableWrap");
    tableWrap?.addEventListener("keydown", (event) => {
      const cell = event.target.closest?.(".excel-cell");
      if (!cell) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitExcelCell(cell);
        const next = cell.closest("tr")?.nextElementSibling?.querySelector(`[data-col="${cell.getAttribute("data-col")}"]`);
        if (next) next.focus();
        else cell.blur();
      }
      if (event.key === "Escape") {
        const page = state.page;
        const row = Number(cell.getAttribute("data-row"));
        const col = Number(cell.getAttribute("data-col"));
        const original = page?.rows.find((item) => item.row === row)?.cells[col] ?? "";
        cell.textContent = original;
        cell.blur();
      }
    });
    tableWrap?.addEventListener("focusout", (event) => {
      const cell = event.target.closest?.(".excel-cell");
      if (cell) commitExcelCell(cell);
    });

    $("excelReload")?.addEventListener("click", () => {
      hasCatalog = false;
      state.sheets = [];
      ensureExcelCatalog(true);
    });

    // Tab Tab 打开首页（输入框内不劫持）
    let lastTabAt = 0;
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) {
        if (event.key !== "Tab") lastTabAt = 0;
        return;
      }
      const active = document.activeElement;
      const tag = active?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
      if (typing) return;
      // 全局搜索开着时 Tab 用来切分类，让给搜索面板
      if (document.querySelector(".global-search-mask.show")) return;
      const now = Date.now();
      if (now - lastTabAt < 600) {
        event.preventDefault();
        lastTabAt = 0;
        setView("home");
        return;
      }
      lastTabAt = now;
    }, true);
  }

  window.ProtoViewHome = {
    /** 供 Tab 搜索的 Excel 分类使用 */
    searchExcel(query, onHits) {
      pendingSearch = typeof onHits === "function" ? onHits : null;
      post("excelSearch", { query });
      return pendingSearch !== null;
    },
    openSheet(id, row = 0) {
      openExcelSheet(id, row);
    },
    sheets() {
      return state.sheets.slice();
    },
    ensureCatalog: () => ensureExcelCatalog(),
    setView,
  };

  let pendingSearch = null;
  let pendingHomeExcel = false;
  state.homeExcelHits = [];
  state.page = null;

  bind();
  renderTabs();
  document.body.dataset.view = "client";
})();
