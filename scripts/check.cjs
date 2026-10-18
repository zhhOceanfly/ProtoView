const fs = require("fs");
const path = require("path");
const { parseProto } = require("../out/parser");
const { buildCatalog } = require("../out/catalog");

const root = path.join(__dirname, "..", "Proto");
const files = [];
const errors = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".proto")) {
      const rel = path.relative(path.join(__dirname, ".."), full);
      try {
        files.push(parseProto(fs.readFileSync(full, "utf8"), full, rel));
      } catch (error) {
        errors.push(`${rel}: ${error.message}`);
      }
    }
  }
}

walk(root);
const catalog = buildCatalog(files, errors.map((message) => ({ file: message, message })));
const pkgs = catalog.packages.filter((pkg) => !pkg.wellKnown);
const services = pkgs.reduce((sum, pkg) => sum + pkg.services.length, 0);
const rpcs = pkgs.reduce((sum, pkg) => sum + pkg.services.reduce((n, service) => n + service.rpcs.length, 0), 0);
const messages = pkgs.reduce((sum, pkg) => sum + pkg.messages.length, 0);
const enums = pkgs.reduce((sum, pkg) => sum + pkg.enums.length, 0);

const unresolved = new Map();
for (const pkg of catalog.packages) {
  for (const message of pkg.messages) {
    for (const field of message.fields) {
      for (const type of [field.value, field.key]) {
        if (!type || type.navId) continue;
        const name = type.text;
        if (["double","float","int32","int64","uint32","uint64","sint32","sint64","fixed32","fixed64","sfixed32","sfixed64","bool","string","bytes"].includes(name)) continue;
        const key = `${pkg.name}.${name}`;
        unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
      }
    }
  }
  for (const service of pkg.services) {
    for (const rpc of service.rpcs) {
      for (const type of [rpc.request, rpc.response]) {
        if (!type.navId) unresolved.set(`rpc ${pkg.name}.${type.text}`, (unresolved.get(`rpc ${pkg.name}.${type.text}`) ?? 0) + 1);
      }
    }
  }
}

const player = catalog.packages.find((pkg) => pkg.name === "Player");
const login = player?.services.flatMap((service) => service.rpcs).find((rpc) => rpc.name === "ReqBaseWebsiteAccountLogin");
const clientRole = player?.messages.flatMap((message) => message.fields).find((field) => field.value.text === "MetaInf.ClientRole");
const listReq = player?.messages.find((message) => message.fullName === "PlayerListReq");
const pay = catalog.packages.find((pkg) => pkg.name === "Pay");
const notify = pay?.services.flatMap((service) => service.rpcs).find((rpc) => rpc.name === "ReqBaseNotify");
const session = catalog.packages.find((pkg) => pkg.name === "MetaInf")?.messages.find((message) => message.fullName === "SessionConfig");
const quota = catalog.packages.find((pkg) => pkg.name === "google.rpc")?.messages.find((message) => message.fullName === "QuotaFailure");
const businessUnresolved = [...unresolved.keys()].filter((key) => !key.startsWith("google."));
if (errors.length || businessUnresolved.length || !login?.request.navId || !clientRole?.value.navId) {
  console.error("catalog check failed");
  process.exitCode = 1;
}
if (listReq?.comment !== "获取玩家列表请求体" || listReq.fields[0]?.comment !== "玩家id列表") {
  console.error("comment check failed", listReq?.comment, listReq?.fields[0]);
  process.exitCode = 1;
}
if (notify?.httpVerb !== "POST" || notify.httpPath !== "/pay/base/notify") {
  console.error("http check failed", notify);
  process.exitCode = 1;
}
if (!session?.fields.some((field) => field.oneof === "config" && field.value.navId)) {
  console.error("oneof check failed", session?.fields);
  process.exitCode = 1;
}
if (quota?.fields[0]?.value.navId !== "msg:google.rpc:QuotaFailure.Violation") {
  console.error("nested check failed", quota?.fields[0]);
  process.exitCode = 1;
}
const clientEvent = catalog.packages.find((pkg) => pkg.name === "Push")?.messages.find((message) => message.fullName === "ClientEventData");
const eventFields = clientEvent?.fields.map((field) => field.name).join(",");
if (eventFields !== "EventId,EventType,HeartbeatData,ConfirmLoginData,ConfirmLeaveServerData,ConfirmReadyData") {
  console.error("field order failed", eventFields);
  process.exitCode = 1;
}
const storage = catalog.packages.find((pkg) => pkg.name === "Backpack")?.services
  .flatMap((service) => service.rpcs)
  .find((rpc) => rpc.name === "ReqPlayerStorageList");
const badgeText = (storage?.badges || []).map((badge) => badge.text).join(" | ");
if (!storage?.source.includes("玩家获取仓库列表") || !storage.source.includes("UserMod: {}") || !storage.source.includes("PodConsistCheck: true")) {
  console.error("source snippet failed", storage?.source);
  process.exitCode = 1;
}
for (const expected of ["timeout 15s", "JWT_AUTH", "JwtSources JS_PLAYER", "Tags AU_GAME", "JtiCheck 10s", "ClientRoles CR_Default", "Session UserMod", "PodConsistCheck", "UserMethodLimit 1s/3 ban 2s"]) {
  if (!badgeText.includes(expected)) {
    console.error("badge missing", expected, badgeText);
    process.exitCode = 1;
  }
}
const { renderPage } = require("../out/render");
const storageHtml = renderPage(catalog, storage.id, true);
if (!storageHtml.includes("定义") || !storageHtml.includes("Session UserMod") || !storageHtml.includes("def-pop")) {
  console.error("storage render failed");
  process.exitCode = 1;
}
if (!storageHtml.includes("玩家获取仓库列表") || !storageHtml.includes("UserMod: {}")) {
  console.error("popover source missing");
  process.exitCode = 1;
}
const notSigna = catalog.packages.find((pkg) => pkg.name === "Tracking")?.services
  .flatMap((service) => service.rpcs)
  .find((rpc) => rpc.badges.some((badge) => badge.text === "NotSigna" && badge.warn));
const roles = catalog.packages.find((pkg) => pkg.name === "Manager")?.services
  .flatMap((service) => service.rpcs)
  .find((rpc) => rpc.badges.some((badge) => badge.text === "ManagerRoles MR_Default, MR_SuperAdmin, MR_GameOperator"));
if (!notSigna || !roles) {
  console.error("interceptor badge failed", Boolean(notSigna), Boolean(roles));
  process.exitCode = 1;
}
const html = renderPage(catalog, login.id, true);
if (!html.includes("WebsiteAccountLoginReq") || !html.includes("官网手机或邮箱账号登录")) {
  console.error("render failed");
  process.exitCode = 1;
}

console.log(JSON.stringify({
  files: files.length,
  errors,
  packages: pkgs.map((pkg) => pkg.name),
  services,
  rpcs,
  messages,
  enums,
  unresolved: [...unresolved.entries()].slice(0, 40),
  login: login && {
    request: login.request,
    response: login.response,
    http: login.httpPath,
    comment: login.comment,
  },
  clientRole: clientRole && { name: clientRole.name, nav: clientRole.value.navId, comment: clientRole.comment },
}, null, 2));
