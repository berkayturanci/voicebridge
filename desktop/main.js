"use strict";
/*
 * voicebridge desktop — an Electron shell that runs the Node bridge as a child
 * process and gives it a small control panel (start/stop, port, token, QR,
 * live log) plus a tray icon. Packaged with electron-builder into a Mac .dmg /
 * Windows installer / Linux AppImage. The bridge (../server.js) is unchanged.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require("electron");
const { fork } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { classifyBridgeFatal, fetchFailureMessage, healthOk } = require("./lib/bridge-health");
const { loadSettings, saveSettings, webUrl: buildWebUrl } = require("./lib/settings");

const isPackaged = app.isPackaged;
const bridgeEntry = isPackaged
  ? path.join(process.resourcesPath, "bridge", "server.js")
  : path.join(__dirname, "..", "server.js");
const settingsFile = path.join(app.getPath("userData"), "settings.json");
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

let settings = loadSettings(settingsFile);

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
    settings,
    logs,
    url: webUrl(),
  };
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

async function startBridge({ resetRestartBudget = true } = {}) {
  if (processRunning()) return bridgeStatus();
  if (resetRestartBudget) autoRestarts = 0;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(settings.port || 8787),
    HOST: settings.host || "127.0.0.1",
    ACCESS_TOKEN: settings.token || "",
  };
  intentionalStop = false;
  healthFailures = 0;
  healthySince = 0;
  lastFatalError = "";
  setBridgeState("starting", { healthy: false, error: "", health: null });
  pushLog(`▶ starting bridge on http://${env.HOST}:${env.PORT}`);
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
    pushLog(`■ bridge stopped (code ${code})`);
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
  pushLog(`↻ bridge health failed; auto-restart ${autoRestarts}/${MAX_AUTO_RESTARTS}: ${reason}`);
  restartBridge({ resetRestartBudget: false });
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
    { label: status.running ? "● Running" : status.status === "starting" ? "◌ Starting" : "○ Stopped", enabled: false },
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

// Query the local bridge (main process has no CSP) for the dashboard.
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

// ---- IPC ----
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
  settings = { ...settings, ...partial };
  try { saveSettings(settingsFile, settings); } catch (_) {}
  return settings;
});
ipcMain.handle("bridge:status", () => ({
  ...bridgeStatus(),
}));
ipcMain.handle("bridge:start", () => startBridge());
ipcMain.handle("bridge:stop", () => stopBridge());
ipcMain.handle("bridge:restart", () => restartBridge());
ipcMain.handle("bridge:openWeb", () => { shell.openExternal(webUrl()); });
ipcMain.handle("token:generate", () => crypto.randomBytes(16).toString("hex"));

app.whenReady().then(() => {
  createTray();
  createWindow();
  startBridge(); // auto-start on launch
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { /* keep running in tray */ });
app.on("before-quit", stopBridge);
