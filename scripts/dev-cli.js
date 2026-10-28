/**
 * CLI 开发模式：tsc watch + 同步 core + 直连仓库 client/，Node --watch 重启服务。
 *
 *   npm run dev:cli
 *   npm run dev:cli -- --proto ./api --port 3920
 *
 * 改 client/*.js|css|html → 浏览器刷新即可
 * 改 src/*.ts 或 packages/cli/src → 自动编译并重启服务
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cliRoot = path.join(root, "packages", "cli");
const outDir = path.join(root, "out");
const coreDest = path.join(cliRoot, "dist", "core");
const clientDir = path.join(root, "client");
const mediaQr = path.join(root, "media", "donate-wechat.png");

const CORE_FILES = [
  "hostCore.js",
  "catalog.js",
  "parser.js",
  "clientModel.js",
  "sourceCore.js",
  "openEditor.js",
  "grpcInvoke.js",
  "decodeBytes.js",
  "httpInvoke.js",
  "sseInvoke.js",
  "wsInvoke.js",
  "invokeDispatch.js",
  "grpcStress.js",
  "meta.js",
];

const children = [];
let syncTimer = null;

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function syncCore() {
  fs.mkdirSync(coreDest, { recursive: true });
  let n = 0;
  for (const file of CORE_FILES) {
    const src = path.join(outDir, file);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(coreDest, file));
    const map = `${src}.map`;
    if (fs.existsSync(map)) copyFile(map, path.join(coreDest, `${file}.map`));
    n += 1;
  }
  // 可选二维码放到 client 旁，开发时从 media 挂一份到 client（不污染 git）
  if (fs.existsSync(mediaQr)) {
    copyFile(mediaQr, path.join(clientDir, "donate-wechat.png"));
  }
  // 触碰 cli.js，让 node --watch 稳定重启（core 变更时）
  const cliJs = path.join(cliRoot, "dist", "cli.js");
  if (fs.existsSync(cliJs)) {
    const t = Date.now();
    fs.utimesSync(cliJs, new Date(t), new Date(t));
  }
  console.log(`[dev-cli] synced ${n} core modules → dist/core`);
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    try { syncCore(); } catch (error) {
      console.warn("[dev-cli] sync failed:", error.message || error);
    }
  }, 200);
}

function run(cmd, args, opts = {}) {
  const { shell = false, ...rest } = opts;
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell,
    ...rest,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.warn(`[dev-cli] ${cmd} ${args.join(" ")} exited ${code}`);
    }
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[dev-cli] initial compile…");
// packages/cli 是独立包，根目录 npm ci 不会装它的依赖
(() => {
  const required = ["ws", "@types/ws", "@grpc/grpc-js", "@grpc/proto-loader", "protobufjs"];
  const missing = required.filter((name) => !fs.existsSync(path.join(cliRoot, "node_modules", ...name.split("/"))));
  if (!missing.length) return;
  console.error(`[dev-cli] packages/cli 缺少依赖：${missing.join(", ")}`);
  console.error("[dev-cli] 请先执行：npm ci --prefix packages/cli");
  process.exit(1);
})();
execSync("npx tsc -p ./", { cwd: root, stdio: "inherit" });
execSync("npx tsc -p ./", { cwd: cliRoot, stdio: "inherit" });
syncCore();

console.log("[dev-cli] watching TypeScript…");
run("npx", ["tsc", "-w", "-p", "./", "--preserveWatchOutput"], { cwd: root, shell: true });
run("npx", ["tsc", "-w", "-p", "./", "--preserveWatchOutput"], { cwd: cliRoot, shell: true });

try {
  fs.watch(outDir, { recursive: true }, () => scheduleSync());
} catch {
  // Windows 部分环境 recursive watch 不稳定，退化为轮询目录
  setInterval(() => scheduleSync(), 1500);
}

let passthrough = process.argv.slice(2);
if (passthrough[0] === "--") passthrough = passthrough.slice(1);
const serverArgs = passthrough.length
  ? passthrough
  : ["--proto", process.cwd(), "--port", "3920"];

// 开发模式默认不自动开浏览器（node --watch 每次重启都会再弹一个标签）
if (!serverArgs.includes("--open") && !serverArgs.includes("--no-open")) {
  serverArgs.push("--no-open");
}

const portArg = serverArgs.findIndex((a) => a === "--port");
const port = portArg >= 0 ? serverArgs[portArg + 1] : "3920";
console.log("[dev-cli] serving frontend from", clientDir);
console.log("[dev-cli] 改 client/ 后浏览器刷新即可；改 .ts 会自动编译并重启服务");
console.log(`[dev-cli] 请手动打开 http://127.0.0.1:${port}/ （默认不自动弹浏览器；需要时加 --open）`);
console.log("[dev-cli] starting:", "protoview", serverArgs.join(" "));

run(
  "node",
  [
    "--watch-path", path.join(cliRoot, "dist"),
    path.join(cliRoot, "dist", "cli.js"),
    ...serverArgs,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PROTOVIEW_PUBLIC_DIR: clientDir,
      PROTOVIEW_DEV: "1",
    },
  },
);
