"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const testDir = path.resolve("test");
const testFiles = fs
  .readdirSync(testDir)
  .filter((entry) => entry.endsWith(".test.js"))
  .sort()
  .map((entry) => path.join("test", entry));

if (testFiles.length === 0) {
  throw new Error(`No desktop test files found in ${testDir}`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
