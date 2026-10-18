import {
  Catalog,
  EnumView,
  FieldView,
  LinkedType,
  MessageView,
  PackageView,
  RpcView,
  ServiceView,
  Usage,
} from "./catalog";

export function renderPage(catalog: Catalog, id: string, canBack: boolean): string {
  if (!id || id === "home") return renderHome(catalog, canBack);
  const item = catalog.byId.get(id);
  if (!item) return renderHome(catalog, canBack);
  if ("messages" in item && "services" in item) return renderPackage(item, canBack);
  if ("rpcs" in item) return renderService(item, catalog, canBack);
  if ("request" in item) return renderRpc(item, catalog, canBack);
  if ("fields" in item) return renderMessage(item, canBack);
  if ("values" in item) return renderEnum(item, canBack);
  return renderHome(catalog, canBack);
}

export const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.5;
}
button, input { font: inherit; color: inherit; }
#app { min-height: 100vh; }
.page { max-width: 1080px; margin: 0 auto; padding: 22px 28px 64px; }
.top {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  position: sticky; top: 0; z-index: 2;
  padding: 14px 0 12px;
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
  backdrop-filter: blur(8px);
}
.crumbs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); }
.crumb, .link {
  border: 0; background: transparent; padding: 0; cursor: pointer;
  color: var(--vscode-textLink-foreground); text-align: left;
}
.crumb:hover, .link:hover { text-decoration: underline; }
.sep { opacity: .45; }
h1 { font-size: 26px; font-weight: 650; margin: 6px 0 4px; letter-spacing: -0.03em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 .btn { font-size: 12px; font-weight: 550; }
.def-wrap { position: relative; }
.def-pop {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  width: min(680px, 72vw);
  max-height: 440px;
  overflow: auto;
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--vscode-panel-border, transparent);
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
  box-shadow: 0 12px 40px color-mix(in srgb, #000 35%, transparent);
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  white-space: pre;
  text-align: left;
}
.def-wrap:hover .def-pop, .def-wrap:focus-within .def-pop { display: block; }
.lead { margin: 0; color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
.actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn {
  border: 1px solid var(--vscode-panel-border, transparent);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 8px; padding: 5px 10px; cursor: pointer;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip {
  border-radius: 999px; padding: 2px 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  font-size: 12px;
}
.chip.http { background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 22%, var(--vscode-editor-background)); }
.chip.warn { background: color-mix(in srgb, var(--vscode-charts-orange, #d29922) 28%, var(--vscode-editor-background)); }
.meta { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.search {
  width: min(420px, 100%); margin: 18px 0 8px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--vscode-input-border, transparent);
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  outline: none;
}
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-top: 14px; }
.card, .block {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--vscode-foreground)) 65%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground));
  border-radius: 14px;
}
.card { padding: 14px 14px 12px; cursor: pointer; text-align: left; width: 100%; }
.card:hover { border-color: var(--vscode-focusBorder); }
.card b, .section-title { display: block; font-size: 14px; }
.card span, .muted { color: var(--vscode-descriptionForeground); }
.mark {
  width: 10px; height: 10px; border-radius: 99px; display: inline-block; margin-right: 8px;
}
.section { margin-top: 26px; }
.section-title { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.list { display: flex; flex-direction: column; gap: 4px; }
.row {
  display: grid; grid-template-columns: minmax(140px, 220px) 1fr auto; gap: 10px;
  align-items: baseline; padding: 7px 10px; border-radius: 8px; width: 100%;
  border: 0; background: transparent; cursor: pointer; text-align: left;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
table { width: 100%; border-collapse: collapse; overflow: hidden; }
.block { overflow: hidden; }
th, td { padding: 8px 12px; text-align: left; vertical-align: top; border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--vscode-foreground)) 55%, transparent); }
th { font-weight: 600; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); border-top: 0; }
tr:hover td { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, transparent); }
.num, code, .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
.num { color: var(--vscode-descriptionForeground); }
.type { color: var(--vscode-symbolIcon-typeForeground, var(--vscode-textLink-foreground)); }
.rpc-list { display: flex; flex-direction: column; gap: 8px; }
.rpc {
  padding: 12px 14px; border-radius: 12px; width: 100%; text-align: left; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--vscode-foreground)) 65%, transparent);
  background: transparent;
}
.rpc:hover { background: var(--vscode-list-hoverBackground); }
.rpc .name { font-family: var(--vscode-editor-font-family); font-size: 13px; }
.sig { margin-top: 4px; color: var(--vscode-descriptionForeground); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 860px) { .pair { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr; } }
.empty { padding: 28px 8px; color: var(--vscode-descriptionForeground); }
`;

function renderHome(catalog: Catalog, canBack: boolean): string {
  const pkgs = catalog.packages.filter((pkg) => !pkg.wellKnown);
  const cards = pkgs.map((pkg) => {
    const hue = hashHue(pkg.name);
    return `<button class="card" data-nav="${esc(pkg.id)}" data-filter="${esc(pkg.name.toLowerCase())}">
      <b><i class="mark" style="background:hsl(${hue} 62% 52%)"></i>${esc(pkg.name)}</b>
      <span>${pkg.services.length} 个 service · ${pkg.messages.length} 个 message · ${pkg.enums.length} 个 enum</span>
    </button>`;
  }).join("");
  const err = catalog.errors.length
    ? `<p class="meta">${catalog.errors.length} 个文件解析失败：${esc(catalog.errors.map((e) => e.file).join("、"))}</p>`
    : "";
  return shell({
    canBack,
    crumbs: `<span>全部 package</span>`,
    title: "ProtoView",
    lead: "按 package 浏览 service、接口、message 和 enum。类型名称可以点进去，再从引用处跳回来。",
    extra: err,
    body: `<div class="section"><input class="search" placeholder="筛选 package" />
      <div class="grid">${cards || `<div class="empty">工作区里没有 .proto 文件</div>`}</div></div>`,
  });
}

function renderPackage(pkg: PackageView, canBack: boolean): string {
  const services = pkg.services.map((service) => `<button class="card" data-nav="${esc(service.id)}" data-filter="${esc(`${service.name} ${service.relPath}`.toLowerCase())}">
      <b>${esc(service.name)}</b>
      <span>${esc(service.relPath)} · ${service.rpcs.length} 个接口</span>
    </button>`).join("");
  return shell({
    canBack,
    crumbs: `<span>${esc(pkg.name)}</span>`,
    title: pkg.name,
    lead: pkg.files.map((file) => file.relPath).join("\n"),
    source: pkg.files[0] ? { file: pkg.files[0].path, line: 1 } : undefined,
    body: `
      <div class="section"><div class="section-title">Service</div><div class="grid">${services || `<div class="empty">这个 package 没有 service</div>`}</div></div>
      ${linkSection("Message", pkg.messages.map((item) => linkRow(item.id, item.fullName, item.comment || item.relPath)))}
      ${linkSection("Enum", pkg.enums.map((item) => linkRow(item.id, item.fullName, item.comment || `${item.values.length} 项`)))}`,
  });
}

function renderService(service: ServiceView, catalog: Catalog, canBack: boolean): string {
  const rpcs = service.rpcs.map((rpc) => {
    const http = rpc.httpVerb ? `<span class="chip http">${esc(rpc.httpVerb)} ${esc(rpc.httpPath ?? "")}</span>` : "";
    return `<button class="rpc" data-nav="${esc(rpc.id)}" data-filter="${esc(`${rpc.name} ${rpc.request.text} ${rpc.response.text}`.toLowerCase())}">
      <div class="name">${esc(rpc.name)}</div>
      <div class="sig">${esc(typeText(rpc.requestStream, rpc.request.text))} → ${esc(typeText(rpc.responseStream, rpc.response.text))}</div>
      ${rpc.comment ? `<div class="meta">${esc(rpc.comment)}</div>` : ""}
      ${http ? `<div class="chips">${http}</div>` : ""}
    </button>`;
  }).join("");
  return shell({
    canBack,
    crumbs: crumb(catalog, `pkg:${service.package}`, service.package) + sep() + `<span>${esc(service.name)}</span>`,
    title: service.name,
    lead: service.comment,
    source: { file: service.file, line: service.line },
    extra: `<p class="meta">${esc(service.relPath)} · ${service.rpcs.length} 个接口</p>`,
    body: `<div class="section"><input class="search" placeholder="筛选接口" /><div class="rpc-list">${rpcs}</div></div>`,
  });
}

function renderRpc(rpc: RpcView, catalog: Catalog, canBack: boolean): string {
  const chips = [
    rpc.httpVerb ? `<span class="chip http">${esc(rpc.httpVerb)} ${esc(rpc.httpPath ?? "")}</span>` : "",
    rpc.httpBody ? `<span class="chip">body ${esc(rpc.httpBody)}</span>` : "",
    ...rpc.badges.map((badge) => `<span class="chip${badge.warn ? " warn" : ""}">${esc(badge.text)}</span>`),
  ].filter(Boolean).join("");
  const req = catalog.byId.get(rpc.request.navId ?? "");
  const resp = catalog.byId.get(rpc.response.navId ?? "");
  return shell({
    canBack,
    crumbs: crumb(catalog, `pkg:${rpc.package}`, rpc.package) + sep()
      + crumb(catalog, rpc.serviceId, rpc.service) + sep()
      + `<span>${esc(rpc.name)}</span>`,
    title: rpc.name,
    titleExtra: definitionButton(rpc.source),
    lead: rpc.comment,
    source: { file: rpc.file, line: rpc.line },
    extra: chips ? `<div class="chips">${chips}</div>` : "",
    body: `<div class="pair">
      ${messageCard("请求", rpc.request, rpc.requestStream, req && "fields" in req ? req : undefined)}
      ${messageCard("响应", rpc.response, rpc.responseStream, resp && "fields" in resp ? resp : undefined)}
    </div>`,
  });
}

function renderMessage(message: MessageView, canBack: boolean): string {
  const nested = message.nested.filter((item) => item.id).map((item) => linkRow(item.id, item.name, item.comment || item.kind));
  return shell({
    canBack,
    crumbs: crumb(undefined, `pkg:${message.package}`, message.package) + sep() + `<span>${esc(message.fullName)}</span>`,
    title: message.fullName,
    lead: message.comment,
    source: { file: message.file, line: message.line },
    extra: `<p class="meta">${esc(message.relPath)}</p>`,
    body: `${fieldTable(message.fields)}
      ${nested.length ? linkSection("嵌套定义", nested) : ""}
      ${usageSection(message.usages)}`,
  });
}

function renderEnum(item: EnumView, canBack: boolean): string {
  const rows = item.values.map((value) => `<tr>
    <td class="num">${value.number}</td>
    <td class="mono">${esc(value.name)}</td>
    <td class="muted">${esc(value.comment)}</td>
    <td><button class="link" data-src="${encodeURIComponent(item.file)}" data-line="${value.line}">源码</button></td>
  </tr>`).join("");
  return shell({
    canBack,
    crumbs: crumb(undefined, `pkg:${item.package}`, item.package) + sep() + `<span>${esc(item.fullName)}</span>`,
    title: item.fullName,
    lead: item.comment,
    source: { file: item.file, line: item.line },
    extra: `<p class="meta">${esc(item.relPath)}</p>`,
    body: `<div class="block"><table>
      <thead><tr><th>#</th><th>名称</th><th>说明</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">无枚举项</td></tr>`}</tbody>
    </table></div>
    ${usageSection(item.usages)}`,
  });
}

function messageCard(title: string, type: LinkedType, stream: boolean, message?: MessageView): string {
  const heading = type.navId
    ? `<button class="link" data-nav="${esc(type.navId)}">${esc(typeText(stream, type.text))}</button>`
    : `<b>${esc(typeText(stream, type.text))}</b>`;
  return `<div>
    <div class="section-title">${esc(title)}</div>
    <div class="block">
      <div style="padding:12px 14px 4px"><b>${heading}</b>
        ${message?.comment ? `<div class="meta">${esc(message.comment)}</div>` : ""}
      </div>
      ${message ? fieldTable(message.fields, true) : `<div class="empty">未解析到 message 定义</div>`}
    </div>
  </div>`;
}

function fieldTable(fields: FieldView[], embedded = false): string {
  if (!fields.length) return `<div class="empty">无字段</div>`;
  const rows = fields.map((field) => `<tr data-filter="${esc(`${field.name} ${field.value.text} ${field.comment}`.toLowerCase())}">
    <td class="num">${field.number}</td>
    <td>${field.oneof ? `<span class="chip">oneof ${esc(field.oneof)}</span> ` : ""}${renderType(field)}</td>
    <td class="mono">${esc(field.name)}</td>
    <td class="muted">${esc(field.comment)}</td>
    <td><button class="link" data-src="${encodeURIComponent(field.file)}" data-line="${field.line}">源码</button></td>
  </tr>`).join("");
  const table = `<table>
    <thead><tr><th>#</th><th>类型</th><th>字段</th><th>说明</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  return embedded ? table : `<div class="block">${table}</div>`;
}

function renderType(field: FieldView): string {
  const prefix = field.prefix ? `<span class="muted">${esc(field.prefix)} </span>` : "";
  if (field.key) {
    return `${prefix}<span class="muted">map&lt;</span>${typeLink(field.key)}<span class="muted">, </span>${typeLink(field.value)}<span class="muted">&gt;</span>`;
  }
  return prefix + typeLink(field.value);
}

function typeLink(type: LinkedType): string {
  if (!type.navId) return `<span class="mono">${esc(type.text)}</span>`;
  return `<button class="link mono type" data-nav="${esc(type.navId)}">${esc(type.text)}</button>`;
}

function usageSection(usages: Usage[]): string {
  if (!usages.length) return "";
  const shown = usages.slice(0, 80);
  const more = usages.length > shown.length ? `<p class="meta">还有 ${usages.length - shown.length} 处引用</p>` : "";
  return linkSection("被引用", shown.map((usage) => linkRow(usage.navId, usage.label, usage.detail))) + more;
}

function linkSection(title: string, rows: string[]): string {
  if (!rows.length) return `<div class="section"><div class="section-title">${esc(title)}</div><div class="empty">无</div></div>`;
  return `<div class="section"><div class="section-title">${esc(title)}</div>
    <input class="search" placeholder="筛选${esc(title)}" />
    <div class="list">${rows.join("")}</div></div>`;
}

function linkRow(id: string, name: string, detail: string): string {
  return `<button class="row" data-nav="${esc(id)}" data-filter="${esc(`${name} ${detail}`.toLowerCase())}">
    <span class="mono">${esc(name)}</span><span class="muted">${esc(detail)}</span><span class="sep">↗</span>
  </button>`;
}

function shell(opts: {
  canBack: boolean;
  crumbs: string;
  title: string;
  titleExtra?: string;
  lead?: string;
  source?: { file: string; line: number };
  extra?: string;
  body: string;
}): string {
  const back = opts.canBack ? `<button class="btn" data-back="1">返回</button>` : "";
  const source = opts.source
    ? `<button class="btn" data-src="${encodeURIComponent(opts.source.file)}" data-line="${opts.source.line}">跳转到源码</button>`
    : "";
  return `<div class="page">
    <div class="top">
      <div>
        <div class="crumbs">${opts.crumbs}</div>
        <h1>${esc(opts.title)}${opts.titleExtra ?? ""}</h1>
        ${opts.lead ? `<p class="lead">${esc(opts.lead)}</p>` : ""}
        ${opts.extra ?? ""}
      </div>
      <div class="actions">${back}${source}</div>
    </div>
    ${opts.body}
  </div>`;
}

function definitionButton(source: string): string {
  if (!source) return "";
  return `<span class="def-wrap"><button class="btn def-btn" type="button">定义</button><pre class="def-pop">${esc(source)}</pre></span>`;
}

function crumb(_catalog: Catalog | undefined, id: string, label: string): string {
  return `<button class="crumb" data-nav="${esc(id)}">${esc(label)}</button>`;
}

function sep(): string {
  return `<span class="sep">/</span>`;
}

function typeText(stream: boolean, name: string): string {
  return stream ? `stream ${name}` : name;
}

function hashHue(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
