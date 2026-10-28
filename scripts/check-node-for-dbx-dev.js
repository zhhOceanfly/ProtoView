#!/usr/bin/env node
/** dbx-plugin dev requires Node.js 22+. */
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 22) {
  console.error(
    `[dev:dbx] dbx-plugin dev requires Node.js 22+ (current: ${process.version}).\n` +
      `  nvm use 22.10.0\n` +
      `  # or: nvm install 22 && nvm use 22`,
  );
  process.exit(1);
}
