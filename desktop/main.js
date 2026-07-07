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
const logs = [];
const LOG_MAX = 500;

let settings = loadSettings(settingsFile);

function pushLog(line) {
  const text = String(line).replace(/\n$/, "");
  if (!text) return;
  logs.push(text);
  if (logs.length > LOG_MAX) logs.shift();
  if (win && !win.isDestroyed()) win.webContents.send("bridge:log", text);
}
function broadcastStatus() {
  if (win && !win.isDestroyed()) win.webContents.send("bridge:status", running());
  if (tray) updateTrayMenu();
}
function running() {
  return !!child && !child.killed;
}

function startBridge() {
  if (running()) return;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(settings.port || 8787),
    HOST: settings.host || "127.0.0.1",
    ACCESS_TOKEN: settings.token || "",
  };
  pushLog(`▶ starting bridge on http://${env.HOST}:${env.PORT}`);
  child = fork(bridgeEntry, [], { env, silent: true });
  child.stdout && child.stdout.on("data", (d) => d.toString().split("\n").forEach(pushLog));
  child.stderr && child.stderr.on("data", (d) => d.toString().split("\n").forEach(pushLog));
  child.on("exit", (code) => {
    pushLog(`■ bridge stopped (code ${code})`);
    child = null;
    broadcastStatus();
  });
  broadcastStatus();
}
function stopBridge() {
  if (!running()) return;
  try { child.kill(); } catch (_) {}
  child = null;
  broadcastStatus();
}
function restartBridge() {
  stopBridge();
  setTimeout(startBridge, 300);
}
function webUrl() {
  return buildWebUrl(settings);
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running() ? "● Running" : "○ Stopped", enabled: false },
    { type: "separator" },
    { label: "Control panel", click: createWindow },
    { label: "Open in browser", enabled: running(), click: () => shell.openExternal(webUrl()) },
    { type: "separator" },
    { label: running() ? "Stop" : "Start", click: () => (running() ? stopBridge() : startBridge()) },
    { label: "Restart", enabled: running(), click: restartBridge },
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
  } catch (e) {
    // Tray is optional; the control window still works.
  }
}

// Query the local bridge (main process has no CSP) for the dashboard.
function fetchJson(p) {
  return new Promise((resolve) => {
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
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

// ---- IPC ----
ipcMain.handle("settings:get", () => settings);
ipcMain.handle("bridge:info", async () => {
  if (!running()) return { agents: [], sessions: [] };
  const cfg = await fetchJson("/api/config");
  const ses = await fetchJson("/api/sessions");
  return { agents: (cfg && cfg.agents) || [], sessions: (ses && ses.sessions) || [] };
});
ipcMain.handle("settings:save", (_e, partial) => {
  settings = { ...settings, ...partial };
  try { saveSettings(settingsFile, settings); } catch (_) {}
  return settings;
});
ipcMain.handle("bridge:status", () => ({
  running: running(),
  settings,
  logs,
  url: webUrl(),
}));
ipcMain.handle("bridge:start", () => { startBridge(); return running(); });
ipcMain.handle("bridge:stop", () => { stopBridge(); return running(); });
ipcMain.handle("bridge:restart", () => { restartBridge(); return true; });
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
