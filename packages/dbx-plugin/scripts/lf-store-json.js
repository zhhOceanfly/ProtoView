#!/usr/bin/env node
/**
 * Convert dbx-store PR template JSON under store/ to LF line endings.
 * Review note: CRLF does not fail validate, but finalize emits LF — keep templates LF.
 *
 * Usage (from packages/dbx-plugin): npm run store:lf
 * Or from repo root: npm run store:lf:dbx
 */
const fs = require("fs");
const path = require("path");

const storeDir = path.join(__dirname, "..", "store");
const files = fs
  .readdirSync(storeDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => path.join(storeDir, name));

let changed = 0;
for (const file of files) {
  const raw = fs.readFileSync(file);
  // Strip UTF-8 BOM if present, normalize CRLF/CR → LF
  let text = raw.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const next = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (next !== text || raw.includes(0x0d)) {
    fs.writeFileSync(file, next, "utf8");
    changed += 1;
    console.log(`[store:lf] LF ← ${path.relative(process.cwd(), file)}`);
  } else {
    console.log(`[store:lf] ok  ${path.relative(process.cwd(), file)}`);
  }
}

console.log(`[store:lf] done (${changed} rewritten, ${files.length} scanned)`);
