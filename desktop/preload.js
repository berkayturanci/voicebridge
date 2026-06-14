"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit bridge between the control UI and the main process.
contextBridge.exposeInMainWorld("vb", {
  getStatus: () => ipcRenderer.invoke("bridge:status"),
  info: () => ipcRenderer.invoke("bridge:info"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),
  start: () => ipcRenderer.invoke("bridge:start"),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  restart: () => ipcRenderer.invoke("bridge:restart"),
  openWeb: () => ipcRenderer.invoke("bridge:openWeb"),
  generateToken: () => ipcRenderer.invoke("token:generate"),
  onLog: (cb) => ipcRenderer.on("bridge:log", (_e, line) => cb(line)),
  onStatus: (cb) => ipcRenderer.on("bridge:status", (_e, running) => cb(running)),
});
