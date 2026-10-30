#!/usr/bin/env node
/**
 * Ensure each .dbxp's checksums.json uses {"algorithm":"sha256",...}
 * (not legacy {"hash":"sha256",...} which makes store signing report
 * "unsupported checksum algorithm").
 *
 * Rewrites the zip entry in place when needed, then refreshes sibling
 * *.artifact.json sha256/size to match the new bytes.
 *
 * Usage:
 *   node scripts/normalize-dbxp-checksums.js [distDir]
 *   npm run package:normalize
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const distDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));

function listDbxp(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".dbxp")).map((n) => path.join(dir, n));
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function normalizeOne(dbxpPath) {
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dbxp-ck-"));
  const extractDir = path.join(tmpDir, "out");
  fs.mkdirSync(extractDir);

  // Prefer Python zipfile (available in CI/local); fall back to PowerShell Expand-Archive on Windows.
  try {
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c",
        "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        dbxpPath,
        extractDir,
      ],
      { stdio: "pipe" },
    );
  } catch {
    const zipCopy = path.join(tmpDir, "pkg.zip");
    fs.copyFileSync(dbxpPath, zipCopy);
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipCopy.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`],
      { stdio: "pipe" },
    );
  }

  const checksumPath = path.join(extractDir, "checksums.json");
  if (!fs.existsSync(checksumPath)) {
    throw new Error(`${path.basename(dbxpPath)}: missing checksums.json`);
  }
  const data = JSON.parse(fs.readFileSync(checksumPath, "utf8"));
  let changed = false;
  if (data.hash && !data.algorithm) {
    data.algorithm = data.hash;
    delete data.hash;
    changed = true;
  }
  if (!data.algorithm) {
    throw new Error(`${path.basename(dbxpPath)}: checksums.json missing algorithm/hash`);
  }
  if (data.algorithm !== "sha256") {
    throw new Error(`${path.basename(dbxpPath)}: unsupported algorithm ${data.algorithm}`);
  }
  if (changed) {
    fs.writeFileSync(checksumPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  if (!changed) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { file: path.basename(dbxpPath), changed: false, sha256: sha256File(dbxpPath), size: fs.statSync(dbxpPath).size };
  }

  const outZip = path.join(tmpDir, "repacked.dbxp");
  execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-c",
      "import zipfile,sys,os\n"
      + "src,dst=sys.argv[1],sys.argv[2]\n"
      + "with zipfile.ZipFile(dst,'w',compression=zipfile.ZIP_DEFLATED) as z:\n"
      + "  for root,dirs,files in os.walk(src):\n"
      + "    for f in files:\n"
      + "      p=os.path.join(root,f)\n"
      + "      z.write(p, os.path.relpath(p, src).replace('\\\\\\\\','/'))\n",
      extractDir,
      outZip,
    ],
    { stdio: "pipe" },
  );
  fs.copyFileSync(outZip, dbxpPath);
  const digest = sha256File(dbxpPath);
  const size = fs.statSync(dbxpPath).size;

  const artPath = dbxpPath.replace(/\.dbxp$/i, ".artifact.json");
  if (fs.existsSync(artPath)) {
    const art = JSON.parse(fs.readFileSync(artPath, "utf8"));
    art.sha256 = digest;
    art.size = size;
    fs.writeFileSync(artPath, `${JSON.stringify(art, null, 2)}\n`, "utf8");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { file: path.basename(dbxpPath), changed: true, sha256: digest, size };
}

function main() {
  const files = listDbxp(distDir);
  if (!files.length) {
    console.error(`[normalize-dbxp] no .dbxp under ${distDir}`);
    process.exit(1);
  }
  let rewritten = 0;
  for (const file of files) {
    const result = normalizeOne(file);
    console.log(
      `[normalize-dbxp] ${result.changed ? "fixed" : "ok   "} ${result.file}  sha256=${result.sha256.slice(0, 12)}… size=${result.size}`,
    );
    if (result.changed) rewritten += 1;
  }
  console.log(`[normalize-dbxp] done (${rewritten} rewritten, ${files.length} scanned)`);
}

main();
