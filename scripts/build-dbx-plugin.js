/**
 * Build ProtoView DBX plugin under packages/dbx-plugin:
 * 1) compile shared TS core
 * 2) copy client/ → ui/
 * 3) copy core + upload helper → runtime/ (Node JSON-RPC worker)
 * 4) install runtime deps
 *
 * Go launcher lives in backend/; `dbx-plugin package` compiles it.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkgRoot = path.join(root, "packages", "dbx-plugin");
const outDir = path.join(root, "out");
const uiDest = path.join(pkgRoot, "ui");
const runtimeDest = path.join(pkgRoot, "runtime");
const coreDest = path.join(runtimeDest, "core");

const args = new Set(process.argv.slice(2));
const uiOnly = args.has("--ui-only");
const watch = args.has("--watch");

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
    if (entry.name === "donate-wechat.png") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function compileCore() {
  console.log("[build-dbx] tsc …");
  execSync("npx tsc -p ./", { cwd: root, stdio: "inherit" });
}

function buildUi() {
  console.log("[build-dbx] copy client → ui …");
  rmrf(uiDest);
  copyDir(path.join(root, "client"), uiDest);
  console.log("DBX_UI_BUILD_SUCCESS");
}

function ensureSidecarSource() {
  const sidecarSrc = path.join(pkgRoot, "runtime", "sidecar.js");
  const template = path.join(pkgRoot, "runtime", "sidecar.js");
  // sidecar.js is committed under packages/dbx-plugin/runtime/sidecar.js
  // (kept as source). If missing, fall back to repo copy written by earlier scaffold.
  if (!fs.existsSync(template)) {
    throw new Error(`missing ${sidecarSrc}`);
  }
}

function buildRuntime() {
  ensureSidecarSource();
  console.log("[build-dbx] copy core → runtime/core …");
  fs.mkdirSync(coreDest, { recursive: true });
  for (const name of CORE_FILES) {
    const src = path.join(outDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`missing ${src}; run compile first`);
    }
    copyFile(src, path.join(coreDest, name));
  }

  // Only need uploadProtoDir (no ws / server.ts). Prefer existing dist, else
  // compile that single file so CI without packages/cli/node_modules still works.
  const uploadDest = path.join(runtimeDest, "uploadProtoDir.js");
  const uploadSrcCandidates = [
    path.join(root, "packages", "cli", "dist", "uploadProtoDir.js"),
    path.join(root, "out", "uploadProtoDir.js"),
  ];
  const uploadSrc = uploadSrcCandidates.find((p) => fs.existsSync(p));
  if (uploadSrc) {
    copyFile(uploadSrc, uploadDest);
  } else {
    const uploadTs = path.join(root, "packages", "cli", "src", "uploadProtoDir.ts");
    if (!fs.existsSync(uploadTs)) {
      throw new Error(`missing ${uploadTs}`);
    }
    console.log("[build-dbx] compile uploadProtoDir.ts only …");
    const tmpOut = path.join(pkgRoot, ".tmp-upload");
    rmrf(tmpOut);
    execSync(
      [
        "npx tsc",
        JSON.stringify(uploadTs),
        "--outDir", JSON.stringify(tmpOut),
        "--rootDir", JSON.stringify(path.dirname(uploadTs)),
        "--module commonjs",
        "--target ES2022",
        "--esModuleInterop",
        "--skipLibCheck",
        "--strict",
      ].join(" "),
      { cwd: root, stdio: "inherit", shell: true },
    );
    const compiled = path.join(tmpOut, "uploadProtoDir.js");
    if (!fs.existsSync(compiled)) {
      throw new Error("uploadProtoDir.js not found after single-file compile");
    }
    copyFile(compiled, uploadDest);
    rmrf(tmpOut);
  }

  const runtimePkg = {
    name: "protoview-dbx-runtime",
    private: true,
    version: "0.1.0",
    main: "sidecar.js",
    dependencies: {
      "@grpc/grpc-js": "^1.14.6",
      "@grpc/proto-loader": "^0.8.1",
      protobufjs: "^7.5.4",
    },
  };
  fs.writeFileSync(path.join(runtimeDest, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

  console.log("[build-dbx] npm install runtime deps …");
  execSync("npm install --omit=dev", { cwd: runtimeDest, stdio: "inherit" });
}

function watchUi() {
  const clientDir = path.join(root, "client");
  console.log(`[build-dbx] watching ${clientDir}`);
  buildUi();
  fs.watch(clientDir, { recursive: true }, () => {
    try {
      buildUi();
    } catch (error) {
      console.error("[build-dbx] ui rebuild failed:", error.message || error);
    }
  });
}

function main() {
  if (watch) {
    watchUi();
    return;
  }
  if (uiOnly) {
    buildUi();
    return;
  }
  compileCore();
  buildUi();
  buildRuntime();
  console.log("[build-dbx] done → packages/dbx-plugin (run: npx @dbx-app/plugin-cli package .)");
}

main();
