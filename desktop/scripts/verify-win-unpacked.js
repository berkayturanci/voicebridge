"use strict";

const fs = require("node:fs");
const path = require("node:path");

function findAppDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);

  const distDir = path.resolve("dist");
  const preferred = path.join(distDir, "win-unpacked");
  if (fs.existsSync(preferred)) return preferred;
  if (!fs.existsSync(distDir)) return preferred;

  const matches = fs
    .readdirSync(distDir)
    .filter((entry) => /^win.*-unpacked$/.test(entry))
    .map((entry) => path.join(distDir, entry))
    .filter((entry) => fs.existsSync(path.join(entry, "voicebridge.exe")));

  return matches[0] || preferred;
}

const appDir = findAppDir();

function mustExist(relativePath, description) {
  const fullPath = path.join(appDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing ${description}: ${fullPath}`);
  }
  return fullPath;
}

if (!fs.existsSync(appDir)) {
  throw new Error(`Windows unpacked app directory not found: ${appDir}`);
}

const exePath = mustExist("voicebridge.exe", "Windows app executable");
const serverPath = mustExist(path.join("resources", "bridge", "server.js"), "bundled bridge server.js");
const publicPath = mustExist(path.join("resources", "bridge", "public"), "bundled bridge public assets");

const publicEntries = fs.readdirSync(publicPath);
if (publicEntries.length === 0) {
  throw new Error(`Bundled bridge public assets directory is empty: ${publicPath}`);
}

const exeStat = fs.statSync(exePath);
const serverStat = fs.statSync(serverPath);
if (exeStat.size === 0) {
  throw new Error(`Windows app executable is empty: ${exePath}`);
}
if (serverStat.size === 0) {
  throw new Error(`Bundled bridge server.js is empty: ${serverPath}`);
}

console.log(`Windows unpacked app OK: ${appDir}`);
