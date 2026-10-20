"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyBridgeFatal, fetchFailureMessage, healthOk } = require("../lib/bridge-health");
const { loadSettings, saveSettings, webUrl } = require("../lib/settings");
const {
  describePublicProbe,
  describeTailscaleStatus,
  publicProbeUrl,
  serveCommand,
} = require("../lib/tailscale-diagnostics");
const { requiredLibFiles, verifyWinUnpacked } = require("../scripts/verify-win-unpacked");

const DEFAULT_SETTINGS = {
  port: 8787,
  host: "127.0.0.1",
  token: "",
  projectDir: "",
  agent: "claude",
  publicUrl: "",
  setupComplete: false,
};

test("desktop settings load defaults when the file is missing or malformed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-desktop-"));
  const file = path.join(dir, "settings.json");
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.writeFileSync(file, "{ nope");
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("desktop settings save and webUrl normalize local host/token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-desktop-"));
  const file = path.join(dir, "settings.json");
  saveSettings(file, { port: 9999, host: "0.0.0.0", token: "a b" });
  assert.deepStrictEqual(loadSettings(file), {
    ...DEFAULT_SETTINGS,
    port: 9999,
    host: "0.0.0.0",
    token: "a b",
  });
  assert.strictEqual(webUrl(loadSettings(file)), "http://127.0.0.1:9999/?token=a%20b");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("desktop bridge health helpers classify common startup and liveness failures", () => {
  assert.match(classifyBridgeFatal("listen EADDRINUSE: address already in use", 8787), /8787 is already in use/);
  assert.match(classifyBridgeFatal("listen EACCES: permission denied", 80), /80 is not allowed/);
  assert.strictEqual(classifyBridgeFatal("ordinary log line", 8787), "");
  assert.strictEqual(healthOk({ ok: true }), true);
  assert.strictEqual(healthOk({ ok: false }), false);
  assert.strictEqual(fetchFailureMessage({ error: "timeout" }), "Bridge health check timed out.");
  assert.strictEqual(fetchFailureMessage({ statusCode: 503 }), "Bridge health check failed (503).");
});

test("tailscale diagnostics classify CLI, login, and online states", () => {
  assert.deepStrictEqual(describeTailscaleStatus({ ok: false, error: "not_installed" }), {
    installed: false,
    running: false,
    authenticated: false,
    state: "cli_missing",
    error: "not_installed",
    message: "Tailscale CLI not found. Install Tailscale, then refresh.",
    suggestedPublicUrls: [],
  });

  const loggedOut = describeTailscaleStatus({ ok: true, data: { BackendState: "NeedsLogin" } });
  assert.strictEqual(loggedOut.installed, true);
  assert.strictEqual(loggedOut.authenticated, false);
  assert.strictEqual(loggedOut.state, "logged_out");
  assert.match(loggedOut.message, /not logged in/);

  const online = describeTailscaleStatus({
    ok: true,
    data: {
      BackendState: "Running",
      Self: { ID: "node-id", Online: true, DNSName: "mac.tailnet.ts.net.", TailscaleIPs: ["100.64.0.1"] },
    },
  });
  assert.strictEqual(online.running, true);
  assert.strictEqual(online.dnsName, "mac.tailnet.ts.net");
  assert.deepStrictEqual(online.suggestedPublicUrls, ["https://mac.tailnet.ts.net"]);
});

test("tailscale serve command is platform-aware and points at the bridge port", () => {
  assert.strictEqual(serveCommand({ port: 9999 }, "darwin"), "tailscale serve --bg http://127.0.0.1:9999");
  assert.strictEqual(serveCommand({ port: 9999 }, "win32"), "tailscale.exe serve --bg http://127.0.0.1:9999");
});

test("public URL diagnostics classify missing, invalid, network, auth, and HTTP failures", () => {
  assert.strictEqual(publicProbeUrl("https://mac.tailnet.ts.net/foo?x=1", "/api/health").url.toString(), "https://mac.tailnet.ts.net/api/health");
  assert.strictEqual(publicProbeUrl("not a url", "/api/health").error, "invalid_public_url");

  assert.strictEqual(describePublicProbe({ configured: false }).category, "missing_url");
  assert.strictEqual(describePublicProbe({ configured: true, error: "ENOTFOUND" }).category, "dns");
  assert.strictEqual(describePublicProbe({ configured: true, error: "timeout" }).category, "timeout");
  assert.strictEqual(describePublicProbe({ configured: true, status: 401 }).category, "auth");
  assert.strictEqual(describePublicProbe({ configured: true, status: 503 }).category, "server");
  assert.strictEqual(describePublicProbe({ configured: true, status: 200 }, { probe: "auth" }).ok, true);
});

function buildTestAsar(files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [relPath, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const parts = relPath.split("/").filter(Boolean);
    let cursor = header;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!cursor.files[part]) cursor.files[part] = { files: {} };
      cursor = cursor.files[part];
    }
    cursor.files[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), "utf8");
  const alignedJsonLen = Math.ceil(jsonBuf.length / 4) * 4;
  const headerPayloadSize = 4 + alignedJsonLen;
  const headerSize = 4 + headerPayloadSize;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerPayloadSize, 8);
  prefix.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(prefix, 16);

  return Buffer.concat([prefix, ...chunks]);
}

function makeFakeWinUnpacked({ omitLib = null, omitBridgeSrc = false, omitBridgePkg = false } = {}) {
  const desktopRoot = path.resolve(__dirname, "..");
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-win-unpacked-"));
  fs.writeFileSync(path.join(appDir, "voicebridge.exe"), "MZ-fake-exe");

  const bridgeDir = path.join(appDir, "resources", "bridge");
  fs.mkdirSync(path.join(bridgeDir, "public"), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "server.js"), "module.exports = require('./src');\n");
  fs.writeFileSync(path.join(bridgeDir, "public", "index.html"), "<!doctype html><title>vb</title>");

  if (!omitBridgeSrc) {
    fs.mkdirSync(path.join(bridgeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "src", "index.js"), "module.exports = { ok: true };\n");
  }
  if (!omitBridgePkg) {
    fs.writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({ name: "voicebridge", version: "0.8.1" }));
  }

  const asarFiles = {
    "main.js": fs.readFileSync(path.join(desktopRoot, "main.js")),
  };
  for (const rel of requiredLibFiles()) {
    if (rel === omitLib) continue;
    asarFiles[rel] = fs.readFileSync(path.join(desktopRoot, ...rel.split("/")));
  }
  fs.writeFileSync(path.join(appDir, "resources", "app.asar"), buildTestAsar(asarFiles));

  return appDir;
}

test("desktop package.json bundles lib/** and bridge src + package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.build?.files), "build.files must be an array");
  assert.ok(pkg.build.files.includes("lib/**"), "build.files must include lib/**");

  const extra = pkg.build?.extraResources || [];
  assert.ok(
    extra.some((entry) => entry.from === "../src" && entry.to === "bridge/src"),
    "build.extraResources must copy ../src to bridge/src"
  );
  assert.ok(
    extra.some((entry) => entry.from === "../package.json" && entry.to === "bridge/package.json"),
    "build.extraResources must copy ../package.json to bridge/package.json"
  );

  assert.deepStrictEqual(requiredLibFiles().sort(), [
    "lib/bridge-health.js",
    "lib/settings.js",
    "lib/tailscale-diagnostics.js",
  ]);
});

test("verify-win-unpacked checks packaged desktop lib modules and bridge src/package.json", () => {
  const validDir = makeFakeWinUnpacked();
  try {
    assert.strictEqual(verifyWinUnpacked(validDir), validDir);
  } finally {
    fs.rmSync(validDir, { recursive: true, force: true });
  }

  for (const libFile of requiredLibFiles()) {
    const missingLibDir = makeFakeWinUnpacked({ omitLib: libFile });
    try {
      assert.throws(
        () => verifyWinUnpacked(missingLibDir),
        new RegExp(`Missing packaged desktop module ${libFile.replace("/", "\\/")}`)
      );
    } finally {
      fs.rmSync(missingLibDir, { recursive: true, force: true });
    }
  }

  const missingSrcDir = makeFakeWinUnpacked({ omitBridgeSrc: true });
  try {
    assert.throws(() => verifyWinUnpacked(missingSrcDir), /Missing bundled bridge src[\\/]index\.js/);
  } finally {
    fs.rmSync(missingSrcDir, { recursive: true, force: true });
  }

  const missingPkgDir = makeFakeWinUnpacked({ omitBridgePkg: true });
  try {
    assert.throws(() => verifyWinUnpacked(missingPkgDir), /Missing bundled bridge package\.json/);
  } finally {
    fs.rmSync(missingPkgDir, { recursive: true, force: true });
  }
});
