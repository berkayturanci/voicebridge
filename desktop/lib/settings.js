"use strict";

const fs = require("fs");
const path = require("path");

const defaults = { port: 8787, host: "127.0.0.1", token: "" };

function loadSettings(file) {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) {
    return { ...defaults };
  }
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function webUrl(settings) {
  const host = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host || defaults.host;
  const port = settings.port || defaults.port;
  return `http://${host}:${port}/${settings.token ? "?token=" + encodeURIComponent(settings.token) : ""}`;
}

module.exports = { defaults, loadSettings, saveSettings, webUrl };
