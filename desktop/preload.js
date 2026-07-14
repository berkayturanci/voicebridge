"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit bridge between the control UI and the main process.
contextBridge.exposeInMainWorld("vb", {
  getStatus: () => ipcRenderer.invoke("bridge:status"),
  info: () => ipcRenderer.invoke("bridge:info"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),
  chooseProject: () => ipcRenderer.invoke("settings:chooseProject"),
  start: () => ipcRenderer.invoke("bridge:start"),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  restart: () => ipcRenderer.invoke("bridge:restart"),
  openWeb: () => ipcRenderer.invoke("bridge:openWeb"),
  networkStatus: () => ipcRenderer.invoke("network:status"),
  copyServeCommand: () => ipcRenderer.invoke("network:copyServeCommand"),
  verifyPublicUrl: () => ipcRenderer.invoke("network:verifyPublicUrl"),
  copyPairing: () => ipcRenderer.invoke("pairing:copy"),
  copyMobileUrl: () => ipcRenderer.invoke("pairing:copyMobileUrl"),
  generateToken: () => ipcRenderer.invoke("token:generate"),
  onLog: (cb) => ipcRenderer.on("bridge:log", (_e, line) => cb(line)),
  onStatus: (cb) => ipcRenderer.on("bridge:status", (_e, running) => cb(running)),
});
