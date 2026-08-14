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
