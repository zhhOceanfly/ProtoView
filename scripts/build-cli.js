/**
 * Build @zhhoceanfly/protoview CLI package:
 * 1) compile root TypeScript (shared core)
 * 2) compile packages/cli
 * 3) copy out/*.js → packages/cli/dist/core
 * 4) copy client/ → packages/cli/public
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cliRoot = path.join(root, "packages", "cli");
const outDir = path.join(root, "out");
const coreDest = path.join(cliRoot, "dist", "core");
const publicDest = path.join(cliRoot, "public");

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

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

console.log("[build-cli] compile extension src…");
execSync("npx tsc -p ./", { cwd: root, stdio: "inherit" });

console.log("[build-cli] compile packages/cli…");
rmrf(path.join(cliRoot, "dist"));
execSync("npx tsc -p ./", { cwd: cliRoot, stdio: "inherit" });

console.log("[build-cli] copy core modules…");
rmrf(coreDest);
fs.mkdirSync(coreDest, { recursive: true });
for (const file of CORE_FILES) {
  const src = path.join(outDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`[build-cli] skip missing ${file}`);
    continue;
  }
  copyFile(src, path.join(coreDest, file));
  const map = `${src}.map`;
  if (fs.existsSync(map)) copyFile(map, path.join(coreDest, `${file}.map`));
}

console.log("[build-cli] copy client public…");
rmrf(publicDest);
copyDir(path.join(root, "client"), publicDest);

// Donate image optional for AI page
const mediaQr = path.join(root, "media", "donate-wechat.png");
if (fs.existsSync(mediaQr)) {
  copyFile(mediaQr, path.join(publicDest, "donate-wechat.png"));
}

console.log("[build-cli] done →", cliRoot);
