(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const state = {
    docs: [],
    filter: "",
    activeId: "",
    focusLine: 0,
    page: 0,
    pageSize: 60,
    mode: "preview",
    pageData: null,
    dirty: false,
    source: "",
    findAt: 0,
  };
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
    if (data.type === "docCatalog") {
      state.docs = Array.isArray(data.payload?.docs) ? data.payload.docs : [];
      state.source = String(data.payload?.source || "");
      renderList();
    }
    if (data.type === "docPage") {
      state.pageData = data.payload || null;
      state.dirty = false;
      renderPage();
    }
    if (data.type === "docSaved") {
      const payload = data.payload || {};
      if (!payload.ok) {
        setMeta(`保存失败：${payload.error || "未知错误"}`, true);
        return;
      }
      state.dirty = false;
      syncSaveButton();
      setMeta("已保存", false);
      if (state.pageData) state.pageData.text = $("docsInput")?.value ?? state.pageData.text;
      renderPreview();
    }
    if (data.type === "docSearch") {
      const waiters = searchWaiters;
      searchWaiters = [];
      const hits = Array.isArray(data.payload) ? data.payload : [];
      waiters.forEach((cb) => { try { cb(hits); } catch { /* ignore */ } });
    }
  });

  // ===== 列表 =====
  function renderList() {
    const list = $("docsList");
    if (!list) return;
    const q = state.filter.trim().toLowerCase();
    const items = state.docs.filter((doc) => !q || `${doc.title} ${doc.relative} ${doc.fileName}`.toLowerCase().includes(q));
    if (!items.length) {
      const where = state.source ? `（${esc(state.source)}）` : "";
      list.innerHTML = `<div class="excel-empty">${state.docs.length ? "没有匹配的文档" : `未找到 Markdown / docs ${where}`}</div>`;
      window.ProtoViewPager?.renderPager?.($("docsPager"), { page: 0, pages: 1, total: 0 }, () => {});
      return;
    }
    const pager = window.ProtoViewPager;
    const result = pager ? pager.paginate(items, state.page, state.pageSize) : { slice: items, page: 0, pages: 1, total: items.length };
    state.page = result.page;
    const groups = new Map();
    for (const doc of result.slice) {
      const folder = doc.relative.includes("/") ? doc.relative.slice(0, doc.relative.lastIndexOf("/")) : "";
      const bucket = groups.get(folder) || [];
      bucket.push(doc);
      groups.set(folder, bucket);
    }
    list.innerHTML = [...groups.entries()].map(([folder, docs]) => `
      <div class="excel-group">
        ${folder ? `<div class="excel-group-head" title="${esc(folder)}">${esc(folder)}</div>` : ""}
        ${docs.map((doc) => `
          <button class="excel-item${doc.id === state.activeId ? " active" : ""}" type="button" data-doc-id="${esc(doc.id)}">
            <span class="excel-item-name">${esc(doc.title || doc.fileName)}</span>
            <span class="excel-item-meta">${esc(doc.fileName)}</span>
          </button>`).join("")}
      </div>`).join("");
    pager?.renderPager?.($("docsPager"), result, (page) => {
      state.page = page;
      renderList();
    });
  }

  // ===== 页面 =====
  function renderPage() {
    const page = state.pageData;
    const body = $("docsBody");
    const editor = $("docsEditor");
    const input = $("docsInput");
    if (!page) {
      if (body) body.innerHTML = `<div class="excel-empty">文档读取失败</div>`;
      return;
    }
    if ($("docsTitle")) $("docsTitle").textContent = page.title || page.relative;
    refreshTabs();
    if (input) input.value = page.text || "";
    state.mode = page.editable ? state.mode : "preview";
    const markdown = /^\.(md|markdown|mdx)$/i.test(page.ext || "");
    $("docsToolbar")?.classList.toggle("is-plain", !markdown);
    applyMode();
    paintGutter();
    renderPreview();
    setMeta(`${page.relative}${page.editable ? "" : " · 只读"}`, false);
    void body;
    void editor;
  }

  function applyMode() {
    const body = $("docsBody");
    const editor = $("docsEditor");
    const page = state.pageData;
    const editable = Boolean(page?.editable);
    const mode = editable ? state.mode : "preview";
    body?.classList.toggle("hidden", mode !== "preview" && editable);
    editor?.classList.toggle("hidden", mode === "preview" || !editable);
    editor?.classList.toggle("is-split", mode === "split");
    editor?.classList.toggle("is-edit", mode === "edit");
    $("docsPreview")?.classList.toggle("hidden", mode === "edit");
    for (const btn of document.querySelectorAll("[data-docs-mode]")) {
      btn.classList.toggle("active", btn.getAttribute("data-docs-mode") === mode);
      btn.disabled = !editable && btn.getAttribute("data-docs-mode") !== "preview";
    }
    syncSaveButton();
  }

  function refreshTabs() {
    const modes = { preview: "阅读", edit: "编辑", split: "分栏" };
    for (const btn of document.querySelectorAll("[data-docs-mode]")) {
      btn.textContent = modes[btn.getAttribute("data-docs-mode")] || btn.textContent;
    }
  }

  function syncSaveButton() {
    const btn = $("docsSave");
    if (!btn) return;
    const editable = Boolean(state.pageData?.editable);
    btn.classList.toggle("hidden", !editable || state.mode === "preview");
    btn.disabled = !state.dirty;
    btn.textContent = state.dirty ? "保存 *" : "保存";
  }

  function setMeta(text, isError) {
    const meta = $("docsMeta");
    if (!meta) return;
    meta.textContent = text;
    meta.classList.toggle("is-error", Boolean(isError));
  }

  // ===== Markdown 渲染 =====
  function renderPreview() {
    const preview = $("docsPreview");
    const body = $("docsBody");
    const page = state.pageData;
    if (!page) return;
    const text = state.mode === "preview" ? String(page.text || "") : String($("docsInput")?.value ?? page.text ?? "");
    const isMarkdown = /^\.(md|markdown|mdx)$/i.test(page.ext || "");
    const html = isMarkdown ? markdownToHtml(text, state.focusLine) : plainToHtml(text, state.focusLine);
    if (preview) preview.innerHTML = `<article class="docs-article">${html}</article>`;
    if (body && state.mode === "preview") {
      body.innerHTML = `<article class="docs-article">${html}</article>`;
      requestAnimationFrame(() => body.querySelector(".docs-hit")?.scrollIntoView({ block: "center" }));
    }
  }

  /** 轻量 Markdown 渲染：标题、列表、代码块、引用、表格、行内样式 */
  function markdownToHtml(text, focusLine) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false;
    let codeLang = "";
    let codeBuf = [];
    let listType = "";
    let tableBuf = [];
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = "";
      }
    };
    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf.filter((row) => !/^\s*\|?\s*:?-{2,}/.test(row));
      const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
      if (rows.length) {
        const head = cells(rows[0]);
        out.push(`<table class="docs-table"><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>`);
        for (const row of rows.slice(1)) {
          out.push(`<tr>${cells(row).map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`);
        }
        out.push("</tbody></table>");
      }
      tableBuf = [];
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const no = index + 1;
      const mark = focusLine && no === focusLine ? " docs-hit" : "";
      if (/^\s*```/.test(line)) {
        if (!inCode) {
          closeList();
          flushTable();
          inCode = true;
          codeLang = line.replace(/^\s*```/, "").trim();
          codeBuf = [];
        } else {
          out.push(`<pre class="docs-code" data-lang="${esc(codeLang)}"><code>${esc(codeBuf.join("\n"))}</code></pre>`);
          inCode = false;
          codeBuf = [];
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }
      if (/^\s*\|/.test(line)) {
        closeList();
        tableBuf.push(line);
        continue;
      }
      flushTable();
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level} id="doc-l${no}" class="${mark.trim()}">${inline(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = /^\s*([-*+])\s+(.*)$/.exec(line);
      if (bullet) {
        if (listType !== "ul") {
          closeList();
          out.push(`<ul>`);
          listType = "ul";
        }
        out.push(`<li class="${mark.trim()}">${inline(bullet[2])}</li>`);
        continue;
      }
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        if (listType !== "ol") {
          closeList();
          out.push(`<ol>`);
          listType = "ol";
        }
        out.push(`<li class="${mark.trim()}">${inline(ordered[2])}</li>`);
        continue;
      }
      closeList();
      if (/^\s*>\s?/.test(line)) {
        out.push(`<blockquote class="${mark.trim()}">${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        out.push(`<hr />`);
        continue;
      }
      if (!line.trim()) {
        out.push(`<p class="docs-gap ${mark.trim()}"></p>`);
        continue;
      }
      out.push(`<p class="${mark.trim()}">${inline(line)}</p>`);
    }
    closeList();
    flushTable();
    if (inCode) out.push(`<pre class="docs-code"><code>${esc(codeBuf.join("\n"))}</code></pre>`);
    return out.join("");
  }

  function plainToHtml(text, focusLine) {
    return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line, index) => {
      const no = index + 1;
      const mark = focusLine && no === focusLine ? " docs-hit" : "";
      return `<p class="${mark.trim()}">${esc(line) || "&nbsp;"}</p>`;
    }).join("");
  }

  function inline(text) {
    let out = esc(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, `<img alt="$1" src="$2" />`);
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);
    return out;
  }

  // ===== 打开 / 保存 =====
  function open(id, line = 0) {
    if (!id) return;
    ensureTab();
    state.activeId = id;
    state.focusLine = Number(line) || 0;
    renderList();
    post("docPage", { id });
  }

  function ensureTab() {
    window.ProtoViewHome?.openTab?.("docs", "DocsView Client");
    window.ProtoViewHome?.setView?.("docs");
  }

  function ensure(force = false) {
    const list = $("docsList");
    if (list && !state.docs.length) list.innerHTML = `<div class="excel-empty">扫描中…</div>`;
    post("docCatalog", { force });
  }

  $("docsFilter")?.addEventListener("input", () => {
    state.filter = $("docsFilter").value || "";
    state.page = 0;
    renderList();
  });
  $("docsList")?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-doc-id]");
    if (!item) return;
    if (state.dirty && !window.confirm("还有未保存的修改，切换文档会丢弃，继续？")) return;
    state.focusLine = 0;
    open(item.getAttribute("data-doc-id"));
  });
  $("docsReload")?.addEventListener("click", () => {
    state.docs = [];
    ensure(true);
  });
  $("docsMode")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-docs-mode]");
    if (!btn || btn.disabled) return;
    state.mode = btn.getAttribute("data-docs-mode");
    applyMode();
    renderPreview();
  });
  function paintGutter() {
    const input = $("docsInput");
    const gutter = $("docsGutter");
    if (!input || !gutter) return;
    const count = Math.max(1, input.value.split("\n").length);
    const lines = [];
    for (let i = 1; i <= count; i += 1) lines.push(String(i));
    gutter.textContent = lines.join("\n");
    gutter.scrollTop = input.scrollTop;
  }

  function replaceSelection(next, selectFrom, selectTo) {
    const input = $("docsInput");
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(next, start, end, "end");
    input.selectionStart = start + selectFrom;
    input.selectionEnd = start + selectTo;
    input.focus();
    state.dirty = true;
    syncSaveButton();
    paintGutter();
    if (state.mode === "split") renderPreview();
  }

  function prefixLines(prefix) {
    const input = $("docsInput");
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = input.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", end);
    const blockEnd = lineEnd < 0 ? value.length : lineEnd;
    const block = value.slice(lineStart, blockEnd).split("\n").map((line) => `${prefix}${line}`).join("\n");
    input.setRangeText(block, lineStart, blockEnd, "end");
    input.focus();
    state.dirty = true;
    syncSaveButton();
    paintGutter();
    if (state.mode === "split") renderPreview();
  }

  function applyMarkdown(kind) {
    const input = $("docsInput");
    if (!input) return;
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    if (kind === "h1" || kind === "h2" || kind === "h3") {
      prefixLines("#".repeat(Number(kind.slice(1))) + " ");
      return;
    }
    if (kind === "ul") { prefixLines("- "); return; }
    if (kind === "ol") { prefixLines("1. "); return; }
    if (kind === "quote") { prefixLines("> "); return; }
    if (kind === "bold") { const text = selected || "粗体"; replaceSelection(`**${text}**`, 2, 2 + text.length); return; }
    if (kind === "italic") { const text = selected || "斜体"; replaceSelection(`*${text}*`, 1, 1 + text.length); return; }
    if (kind === "strike") { const text = selected || "删除"; replaceSelection(`~~${text}~~`, 2, 2 + text.length); return; }
    if (kind === "code") { const text = selected || "code"; replaceSelection("`" + text + "`", 1, 1 + text.length); return; }
    if (kind === "link") { const text = selected || "链接文字"; replaceSelection(`[${text}](https://)`, 1, 1 + text.length); return; }
    if (kind === "fence") {
      const text = selected || "";
      replaceSelection("```\n" + text + "\n```", 4, 4 + text.length);
      return;
    }
    if (kind === "table") {
      const text = "| 列 | 列 |\n| --- | --- |\n|  |  |";
      replaceSelection(text, 0, text.length);
      return;
    }
    if (kind === "hr") replaceSelection("\n\n---\n\n", 2, 5);
  }

  function findInDoc(dir) {
    const input = $("docsInput");
    const query = $("docsFind")?.value || "";
    const count = $("docsFindCount");
    if (!input || !query) {
      if (count) count.textContent = "";
      return;
    }
    const hay = input.value.toLowerCase();
    const needle = query.toLowerCase();
    const hits = [];
    let at = hay.indexOf(needle);
    while (at >= 0) {
      hits.push(at);
      at = hay.indexOf(needle, at + needle.length);
    }
    if (count) count.textContent = hits.length ? `${hits.length} 处` : "无";
    if (!hits.length || !dir) return;
    const cursor = dir < 0 ? input.selectionStart - 1 : (dir > 0 ? input.selectionEnd : input.selectionStart);
    let pick = hits.find((pos) => pos >= cursor);
    if (dir < 0) pick = [...hits].reverse().find((pos) => pos < input.selectionStart);
    if (pick == null) pick = dir < 0 ? hits[hits.length - 1] : hits[0];
    input.focus();
    input.selectionStart = pick;
    input.selectionEnd = pick + needle.length;
    const before = input.value.slice(0, pick);
    const line = before.split("\n").length;
    const lineHeight = 22;
    input.scrollTop = Math.max(0, (line - 3) * lineHeight);
    paintGutter();
  }

  $("docsInput")?.addEventListener("input", () => {
    state.dirty = true;
    syncSaveButton();
    paintGutter();
    if (state.mode === "split") renderPreview();
  });
  $("docsInput")?.addEventListener("scroll", paintGutter);
  $("docsToolbar")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-md]");
    if (!btn) return;
    applyMarkdown(btn.getAttribute("data-md"));
  });
  $("docsFind")?.addEventListener("input", () => findInDoc(0));
  $("docsFind")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      findInDoc(event.shiftKey ? -1 : 1);
    }
  });
  $("docsFindNext")?.addEventListener("click", () => findInDoc(1));
  $("docsFindPrev")?.addEventListener("click", () => findInDoc(-1));
  $("docsJump")?.addEventListener("click", () => {
    const file = state.pageData?.file;
    if (!file) return;
    window.ProtoViewClient?.openSourceFile?.(file, state.focusLine || 1);
  });
  $("docsInput")?.addEventListener("keydown", (event) => {
    const input = $("docsInput");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      $("docsFind")?.focus();
      $("docsFind")?.select();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.setRangeText("  ", start, end, "end");
      state.dirty = true;
      syncSaveButton();
      paintGutter();
    }
  });
  $("docsSave")?.addEventListener("click", save);

  function save() {
    if (!state.pageData?.editable) return;
    const text = $("docsInput")?.value ?? state.pageData.text ?? "";
    post("docSave", { id: state.pageData.id, text });
  }

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
  });

  window.ProtoViewDocs = {
    ensure: () => ensure(false),
    search(query, onHits) {
      if (typeof onHits === "function") searchWaiters.push(onHits);
      post("docSearch", { query });
    },
    open,
  };
})();
