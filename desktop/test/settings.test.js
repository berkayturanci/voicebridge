"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSettings, saveSettings, webUrl } = require("../lib/settings");

test("desktop settings load defaults when the file is missing or malformed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-desktop-"));
  const file = path.join(dir, "settings.json");
  assert.deepStrictEqual(loadSettings(file), { port: 8787, host: "127.0.0.1", token: "" });
  fs.writeFileSync(file, "{ nope");
  assert.deepStrictEqual(loadSettings(file), { port: 8787, host: "127.0.0.1", token: "" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("desktop settings save and webUrl normalize local host/token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-desktop-"));
  const file = path.join(dir, "settings.json");
  saveSettings(file, { port: 9999, host: "0.0.0.0", token: "a b" });
  assert.deepStrictEqual(loadSettings(file), { port: 9999, host: "0.0.0.0", token: "a b" });
  assert.strictEqual(webUrl(loadSettings(file)), "http://127.0.0.1:9999/?token=a%20b");
  fs.rmSync(dir, { recursive: true, force: true });
});
