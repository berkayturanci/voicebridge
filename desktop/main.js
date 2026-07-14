"use strict";
/*
 * voicebridge desktop - an Electron shell that runs the Node bridge as a child
 * process and gives it a small control panel (start/stop, port, token, QR,
 * live log) plus a tray icon. Packaged with electron-builder into a Mac .dmg /
 * Windows installer / Linux AppImage. The bridge (../server.js) is unchanged.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, clipboard, safeStorage } = require("electron");
const { execFile, fork } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { classifyBridgeFatal, fetchFailureMessage, healthOk } = require("./lib/bridge-health");
const { AGENT_OPTIONS, loadSettings, normalizeSettings, saveSettings, webUrl: buildWebUrl } = require("./lib/settings");

let QRCode = null;
try { QRCode = require("qrcode"); } catch (_) {}

const isPackaged = app.isPackaged;
const bridgeEntry = isPackaged
  ? path.join(process.resourcesPath, "bridge", "server.js")
  : path.join(__dirname, "..", "server.js");
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const tokenFile = path.join(app.getPath("userData"), "token.enc.json");
const trayIcon = path.join(__dirname, "assets", "tray.png");
const appIcon = path.join(__dirname, "assets", "icon.png");

let win = null;
let tray = null;
let child = null;
let healthTimer = null;
let intentionalStop = false;
let healthFailures = 0;
let autoRestarts = 0;
let lastFatalError = "";
let healthySince = 0;
const logs = [];
const LOG_MAX = 500;
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_RETRIES = 10;
const STARTUP_RETRY_MS = 300;
const MAX_AUTO_RESTARTS = 3;
const RESTART_BUDGET_RESET_MS = 60000;

const bridgeState = {
  status: "stopped",
  healthy: false,
  error: "",
  health: null,
};

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function canUseSecureStorage() {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function loadSecureToken() {
  if (!canUseSecureStorage()) return "";
  try {
    const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    if (!stored || stored.version !== 1 || !stored.value) return "";
    return safeStorage.decryptString(Buffer.from(stored.value, "base64"));
  } catch (_) {
    return "";
  }
}

function saveSecureToken(token) {
  if (!token || !canUseSecureStorage()) return false;
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(tokenFile, JSON.stringify({
      version: 1,
      encoding: "base64",
      value: encrypted.toString("base64"),
    }, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function tokenStorageState() {
  const secure = canUseSecureStorage();
  return {
    secure,
    backend: secure
      ? (process.platform === "darwin" ? "macOS Keychain" : "OS secure storage")
      : "settings.json fallback",
  };
}

function loadDesktopSettings() {
  return loadSettings(settingsFile, { secureToken: loadSecureToken(), generateToken });
}

function saveDesktopSettings(next) {
  saveSettings(settingsFile, next, { saveSecureToken });
}

let settings = loadDesktopSettings();

function pushLog(line) {
  const text = String(line).replace(/\n$/, "");
  if (!text) return;
  logs.push(text);
  if (logs.length > LOG_MAX) logs.shift();
  if (win && !win.isDestroyed()) win.webContents.send("bridge:log", text);
}

function broadcastStatus() {
  if (win && !win.isDestroyed()) win.webContents.send("bridge:status", bridgeStatus());
  if (tray) updateTrayMenu();
}

function processRunning() {
  return !!child && !child.killed;
}

function running() {
  return processRunning() && bridgeState.healthy;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function binExists(bin) {
  if (!bin) return false;
  if (bin.includes(path.sep)) {
    try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch (_) { return false; }
  }
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch (_) {}
  }
  return false;
}

function agentStatus() {
  return AGENT_OPTIONS.map((agent) => ({
    ...agent,
    available: agent.id === "ollama" ? true : binExists(agent.bin),
  }));
}

function selectedAgentAvailable() {
  const agent = AGENT_OPTIONS.find((a) => a.id === settings.agent);
  if (!agent || agent.id === "ollama") return true;
  return binExists(agent.bin);
}

function setupState() {
  const projectValid = !!settings.projectDir && isDir(settings.projectDir);
  const agentKnown = AGENT_OPTIONS.some((a) => a.id === settings.agent);
  return {
    complete: !!settings.setupComplete && projectValid && agentKnown && !!settings.token,
    projectValid,
    agentKnown,
    tokenReady: !!settings.token,
  };
}

function bridgeStatus() {
  return {
    running: running(),
    processRunning: processRunning(),
    status: bridgeState.status,
    healthy: bridgeState.healthy,
    error: bridgeState.error,
    health: bridgeState.health,
    healthFailures,
    autoRestarts,
    bridgeState: {
      phase: bridgeState.status,
      message: bridgeMessage(),
      error: bridgeState.error,
    },
    settings,
    tokenStorage: tokenStorageState(),
    setup: setupState(),
    agents: agentStatus(),
    logs,
    url: webUrl(),
    mobileUrl: mobileUrl(),
    pairingPayload: pairingPayload(),
  };
}

function bridgeMessage() {
  if (bridgeState.error) return bridgeState.error;
  if (bridgeState.status === "starting") return "Starting bridge and waiting for /api/health.";
  if (bridgeState.status === "running") return "Bridge is running and healthy.";
  if (bridgeState.status === "error") return "Bridge is not healthy. Check recent logs.";
  return "Bridge is stopped.";
}

function setBridgeState(status, extra = {}) {
  Object.assign(bridgeState, { status }, extra);
  broadcastStatus();
}

function clearHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function startHealthLoop() {
  clearHealthLoop();
  healthTimer = setInterval(() => { checkBridgeHealth({ autoRestart: true }); }, HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markHealthy(health) {
  if (!bridgeState.healthy) healthySince = Date.now();
  if (autoRestarts > 0 && Date.now() - healthySince >= RESTART_BUDGET_RESET_MS) {
    autoRestarts = 0;
  }
  healthFailures = 0;
  setBridgeState("running", { healthy: true, error: "", health });
}

function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => resolve({ ok: false, code: err.code || "ERROR", message: err.message }));
    server.once("listening", () => {
      server.close(() => resolve({ ok: true }));
    });
    server.listen(port, host);
  });
}

async function startBridge({ resetRestartBudget = true } = {}) {
  if (processRunning()) return bridgeStatus();
  const setup = setupState();
  if (!setup.projectValid) {
    const msg = "Choose an existing project folder before starting the bridge.";
    pushLog("Cannot start bridge: " + msg);
    setBridgeState("error", { healthy: false, error: msg, health: null });
    return bridgeStatus();
  }
  if (!selectedAgentAvailable()) {
    const agent = AGENT_OPTIONS.find((a) => a.id === settings.agent);
    const msg = `${agent ? agent.label : settings.agent} CLI is not available on PATH.`;
    pushLog("Cannot start bridge: " + msg);
    setBridgeState("error", { healthy: false, error: msg, health: null });
    return bridgeStatus();
  }
  const port = settings.port || 8787;
  const host = settings.host || "127.0.0.1";
  const portCheck = await checkPortAvailable(host, port);
  if (!portCheck.ok) {
    const msg = portCheck.code === "EADDRINUSE"
      ? `Port ${port} is already in use. Choose another port or stop the other process.`
      : `Cannot bind ${host}:${port}: ${portCheck.message}`;
    pushLog("Cannot start bridge: " + msg);
    setBridgeState("error", { healthy: false, error: msg, health: null });
    return bridgeStatus();
  }
  if (resetRestartBudget) autoRestarts = 0;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOST: host,
    ACCESS_TOKEN: settings.token || "",
    PROJECT_DIR: settings.projectDir,
    AGENT: settings.agent || "claude",
    PUBLIC_URL: settings.publicUrl || "",
  };
  intentionalStop = false;
  healthFailures = 0;
  healthySince = 0;
  lastFatalError = "";
  setBridgeState("starting", { healthy: false, error: "", health: null });
  pushLog(`starting bridge on http://${env.HOST}:${env.PORT}`);
  const proc = fork(bridgeEntry, [], { env, silent: true });
  child = proc;
  proc.stdout && proc.stdout.on("data", (d) => d.toString().split("\n").forEach(pushLog));
  proc.stderr && proc.stderr.on("data", (d) => {
    d.toString().split("\n").forEach((line) => {
      const fatal = classifyBridgeFatal(line, env.PORT);
      if (fatal) lastFatalError = fatal;
      pushLog(line);
    });
  });
  proc.on("exit", (code) => {
    pushLog(`bridge stopped (code ${code})`);
    if (child !== proc) return;
    child = null;
    bridgeState.healthy = false;
    bridgeState.health = null;
    clearHealthLoop();
    if (intentionalStop) {
      setBridgeState("stopped", { error: "" });
      return;
    }
    const error = lastFatalError || `Bridge stopped unexpectedly (code ${code}).`;
    setBridgeState("error", { error });
    maybeAutoRestart(error);
  });
  await waitForBridgeReady();
  return bridgeStatus();
}

function stopBridge() {
  intentionalStop = true;
  clearHealthLoop();
  if (!processRunning()) {
    child = null;
    setBridgeState("stopped", { healthy: false, error: "", health: null });
    return bridgeStatus();
  }
  const proc = child;
  child = null;
  try { proc.kill(); } catch (_) {}
  setBridgeState("stopped", { healthy: false, error: "", health: null });
  return bridgeStatus();
}

async function restartBridge(opts = {}) {
  stopBridge();
  await sleep(300);
  return startBridge(opts);
}

function webUrl() {
  return buildWebUrl(settings);
}

async function waitForBridgeReady() {
  for (let i = 0; i < STARTUP_RETRIES; i++) {
    if (!processRunning()) break;
    const result = await fetchJson("/api/health", { timeoutMs: HEALTH_TIMEOUT_MS });
    if (result.ok && healthOk(result.data)) {
      markHealthy(result.data);
      startHealthLoop();
      return true;
    }
    await sleep(STARTUP_RETRY_MS);
  }
  if (processRunning()) {
    const error = lastFatalError || "Bridge started but did not answer /api/health.";
    setBridgeState("error", { healthy: false, error, health: null });
    startHealthLoop();
  }
  return false;
}

async function checkBridgeHealth({ autoRestart = false } = {}) {
  if (!processRunning()) {
    if (bridgeState.status !== "stopped" && bridgeState.status !== "error") {
      setBridgeState("error", { healthy: false, error: "Bridge process is not running.", health: null });
    }
    return false;
  }
  const result = await fetchJson("/api/health", { timeoutMs: HEALTH_TIMEOUT_MS });
  if (result.ok && healthOk(result.data)) {
    markHealthy(result.data);
    return true;
  }
  healthFailures += 1;
  const error = lastFatalError || fetchFailureMessage(result);
  setBridgeState("error", { healthy: false, error, health: null });
  if (autoRestart) maybeAutoRestart(error);
  return false;
}

function maybeAutoRestart(reason) {
  if (intentionalStop || autoRestarts >= MAX_AUTO_RESTARTS) return;
  autoRestarts += 1;
  pushLog(`bridge health failed; auto-restart ${autoRestarts}/${MAX_AUTO_RESTARTS}: ${reason}`);
  restartBridge({ resetRestartBudget: false });
}

function withToken(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("token", token);
    return u.toString();
  } catch (_) {
    return url;
  }
}

function mobileUrl() {
  return settings.publicUrl ? withToken(settings.publicUrl, settings.token) : webUrl();
}

function serveCommand() {
  return `tailscale serve --bg ${settings.port || 8787}`;
}

function pairingPayload() {
  return {
    schema: "voicebridge.pairing",
    version: 1,
    bridgeUrl: mobileUrl(),
    token: settings.token || "",
    deviceName: os.hostname(),
    projectLabel: settings.projectDir ? path.basename(settings.projectDir) : "",
    agent: settings.agent || "claude",
  };
}

async function pairingQrDataUrl() {
  if (!QRCode) return "";
  try {
    return await QRCode.toDataURL(mobileUrl(), {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
      color: { dark: "#0d1114", light: "#ffffff" },
    });
  } catch (_) {
    return "";
  }
}

function execFileJson(file, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.code === "ENOENT" ? "not_installed" : err.message });
      try { resolve({ ok: true, data: JSON.parse(stdout) }); } catch (_) { resolve({ ok: false, error: "invalid_json" }); }
    });
  });
}

async function tailscaleStatus() {
  const result = await execFileJson("tailscale", ["status", "--json"]);
  if (!result.ok) return { installed: result.error !== "not_installed", running: false, error: result.error };
  const self = result.data && result.data.Self;
  return {
    installed: true,
    running: !!(self && self.Online),
    dnsName: (self && self.DNSName) || "",
    tailscaleIps: (self && self.TailscaleIPs) || [],
  };
}

function publicHealthCheck() {
  return new Promise((resolve) => {
    if (!settings.publicUrl) return resolve({ configured: false, ok: false, status: 0, error: "missing_public_url" });
    let url;
    try {
      url = new URL(settings.publicUrl);
      url.pathname = "/api/health";
      url.search = "";
      url.hash = "";
    } catch (_) {
      return resolve({ configured: true, ok: false, status: 0, error: "invalid_public_url" });
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: 4000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ configured: true, ok: res.statusCode === 200, status: res.statusCode || 0, url: url.toString() }));
    });
    req.on("error", (err) => resolve({ configured: true, ok: false, status: 0, error: err.message, url: url.toString() }));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve({ configured: true, ok: false, status: 0, error: "timeout", url: url.toString() });
    });
  });
}

async function networkStatus() {
  const [tailscale, health] = await Promise.all([tailscaleStatus(), publicHealthCheck()]);
  return {
    tailscale,
    health,
    serveCommand: serveCommand(),
    publicUrl: settings.publicUrl || "",
  };
}

function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 560,
    height: 680,
    title: "voicebridge",
    icon: appIcon,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer", "control.html"));
  win.on("closed", () => (win = null));
}

function updateTrayMenu() {
  if (!tray) return;
  const status = bridgeStatus();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.running ? "Running" : status.status === "starting" ? "Starting" : "Stopped", enabled: false },
    { type: "separator" },
    { label: "Control panel", click: createWindow },
    { label: "Open in browser", enabled: status.running, click: () => shell.openExternal(webUrl()) },
    { type: "separator" },
    { label: status.processRunning ? "Stop" : "Start", click: () => (status.processRunning ? stopBridge() : startBridge()) },
    { label: "Restart", enabled: status.processRunning, click: restartBridge },
    { type: "separator" },
    { label: "Quit", click: () => { stopBridge(); app.quit(); } },
  ]));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(trayIcon);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip("voicebridge");
    tray.on("click", createWindow);
    updateTrayMenu();
  } catch (_e) {
    // Tray is optional; the control window still works.
  }
}

function fetchJson(p, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.get(
      {
        host: "127.0.0.1",
        port: settings.port || 8787,
        path: p,
        headers: settings.token ? { Authorization: "Bearer " + settings.token } : {},
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let data = null;
          try { data = d ? JSON.parse(d) : null; } catch (_e) {
            finish({ ok: false, statusCode: res.statusCode, error: "bad-json", body: d });
            return;
          }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data });
        });
      }
    );
    req.on("error", (e) => finish({ ok: false, error: e.code || e.message || "network-error" }));
    req.setTimeout(opts.timeoutMs || 2000, () => {
      req.destroy();
      finish({ ok: false, error: "timeout" });
    });
  });
}

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("bridge:info", async () => {
  if (!running()) return { agents: [], sessions: [] };
  const cfg = await fetchJson("/api/config");
  const ses = await fetchJson("/api/sessions");
  return {
    agents: (cfg.ok && cfg.data && cfg.data.agents) || [],
    sessions: (ses.ok && ses.data && ses.data.sessions) || [],
    error: (!cfg.ok && cfg.error) || (!ses.ok && ses.error) || "",
  };
});
ipcMain.handle("settings:save", (_e, partial) => {
  settings = normalizeSettings({ ...settings, ...partial }, { secureToken: loadSecureToken(), generateToken });
  saveDesktopSettings(settings);
  return settings;
});
ipcMain.handle("settings:chooseProject", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Choose VoiceBridge project folder",
    defaultPath: settings.projectDir || os.homedir(),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return settings.projectDir || "";
  settings = normalizeSettings({ ...settings, projectDir: result.filePaths[0] }, { secureToken: loadSecureToken(), generateToken });
  saveDesktopSettings(settings);
  return settings.projectDir;
});
ipcMain.handle("bridge:status", async () => ({
  ...bridgeStatus(),
  mobileState: running() ? (await fetchJson("/api/mobile-state")).data : null,
  pairingQrDataUrl: await pairingQrDataUrl(),
}));
ipcMain.handle("bridge:start", () => startBridge());
ipcMain.handle("bridge:stop", () => stopBridge());
ipcMain.handle("bridge:restart", () => restartBridge());
ipcMain.handle("bridge:openWeb", () => { shell.openExternal(webUrl()); });
ipcMain.handle("network:status", () => networkStatus());
ipcMain.handle("network:copyServeCommand", () => {
  clipboard.writeText(serveCommand());
  return true;
});
ipcMain.handle("network:verifyPublicUrl", () => publicHealthCheck());
ipcMain.handle("pairing:copy", () => {
  clipboard.writeText(JSON.stringify(pairingPayload(), null, 2));
  return true;
});
ipcMain.handle("pairing:copyMobileUrl", () => {
  clipboard.writeText(mobileUrl());
  return true;
});
ipcMain.handle("token:generate", () => generateToken());

app.whenReady().then(() => {
  settings = loadDesktopSettings();
  saveDesktopSettings(settings);
  createTray();
  createWindow();
  if (setupState().complete) startBridge();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { /* keep running in tray */ });
app.on("before-quit", stopBridge);
