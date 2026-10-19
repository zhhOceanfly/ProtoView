/**
 * 发布到 Open VSX（Cursor 扩展源）。
 *
 * 前置：
 * 1. https://open-vsx.org 登录 → Profile 签署 Publisher Agreement
 * 2. Access Tokens 创建 Token
 * 3. 环境变量 OVSX_PAT=你的 token（勿写入 package.json / 勿提交仓库）
 *
 * 用法：
 *   export OVSX_PAT=ovsxat_xxx          # bash
 *   # 或 PowerShell: $env:OVSX_PAT="ovsxat_xxx"
 *   npm run openvsx:namespace           # 首次创建命名空间 zoceanfly
 *   npm run publish:openvsx             # 打包并发布当前 version 的 vsix
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const token = (process.env.OVSX_PAT || "").trim();
const ns = process.env.OVSX_NAMESPACE || pkg.publisher || "zoceanfly";
const cmd = process.argv[2] || "publish";

if (!token) {
  console.error(`
[openvsx] 未设置 OVSX_PAT。

请先在本机设置（不要写进仓库）：
  bash:        export OVSX_PAT=ovsxat_你的token
  PowerShell:  $env:OVSX_PAT="ovsxat_你的token"
  cmd:         set OVSX_PAT=ovsxat_你的token

Token 来源：https://open-vsx.org/user-settings/tokens
（需先签署 Eclipse Open VSX Publisher Agreement）
`);
  process.exit(1);
}

function run(command) {
  console.log(`[openvsx] ${command.replace(token, "***")}`);
  execSync(command, { cwd: root, stdio: "inherit", env: process.env, shell: true });
}

if (cmd === "namespace") {
  // 命名空间只需创建一次；已存在时会报错，可忽略
  run(`npx ovsx create-namespace ${ns} -p "${token}"`);
  console.log(`[openvsx] 命名空间「${ns}」已请求创建（若已存在可忽略报错）。`);
  process.exit(0);
}

const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`[openvsx] 找不到 ${path.basename(vsix)}，请先执行：npm run package`);
  process.exit(1);
}

run(`npx ovsx publish "${vsix}" -p "${token}"`);
console.log(`[openvsx] 已发布 ${path.basename(vsix)} → Open VSX（Cursor 搜索可能需等待索引）。`);
console.log(`          https://open-vsx.org/extension/${ns}/${pkg.name}`);
