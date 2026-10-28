#!/usr/bin/env node
/**
 * Stable entry for dbx-plugin.toml ui_build / ui_watch.
 * Avoids `npm.cmd` + UNC cwd (`\\?\C:\...`) which CMD rejects on Windows.
 */
"use strict";
const path = require("path");
require(path.join(__dirname, "..", "..", "scripts", "build-dbx-plugin.js"));
