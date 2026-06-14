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
const path = require("path");
const fs = require("fs");

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

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (_) {
    return { port: 8787, host: "127.0.0.1", token: "" };
  }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  } catch (_) {}
}
let settings = loadSettings();

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
  const host = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host || "127.0.0.1";
  return `http://${host}:${settings.port || 8787}/${settings.token ? "?token=" + encodeURIComponent(settings.token) : ""}`;
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
    { label: running() ? "● Çalışıyor" : "○ Durdu", enabled: false },
    { type: "separator" },
    { label: "Kontrol paneli", click: createWindow },
    { label: "Tarayıcıda aç", enabled: running(), click: () => shell.openExternal(webUrl()) },
    { type: "separator" },
    { label: running() ? "Durdur" : "Başlat", click: () => (running() ? stopBridge() : startBridge()) },
    { label: "Yeniden başlat", enabled: running(), click: restartBridge },
    { type: "separator" },
    { label: "Çıkış", click: () => { stopBridge(); app.quit(); } },
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

// ---- IPC ----
ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:save", (_e, partial) => {
  settings = { ...settings, ...partial };
  saveSettings(settings);
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
