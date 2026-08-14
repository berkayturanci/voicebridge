"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

function scanCommandsDir(commandsDir) {
  const out = [];
  const walk = (d, prefix, depth) => {
    if (out.length > 200 || depth > 6) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length > 200) break;
      if (e.isDirectory()) walk(path.join(d, e.name), prefix.concat(e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const name = prefix.concat(e.name.slice(0, -3)).join(":");
        out.push({ label: "/" + name, value: "/" + name + " " });
      }
    }
  };
  walk(commandsDir, [], 0);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function listSlashCommands(baseDir) {
  return scanCommandsDir(path.join(baseDir, ".claude", "commands"));
}

function listGlobalCommands() {
  return scanCommandsDir(path.join(os.homedir(), ".claude", "commands"));
}

function listPluginCommandGroups() {
  const groups = [];
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8"));
  } catch (_) { return groups; }
  const seen = new Set();
  for (const [key, records] of Object.entries(cfg.plugins || {})) {
    const name = String(key).split("@")[0];
    for (const rec of (records || [])) {
      const ip = rec && rec.installPath;
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      const items = scanCommandsDir(path.join(ip, "commands"));
      if (items.length) groups.push({ label: "Plugin: " + name, items });
    }
  }
  return groups;
}

function listNpmScripts(baseDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf8"));
    return Object.keys(pkg.scripts || {}).map((k) => ({ label: "npm run " + k, value: "npm run " + k }));
  } catch (_) { return []; }
}

function commandGroupsForAgent(agentId, projectDir) {
  const groups = [];
  if (agentId === "claude") {
    const proj = listSlashCommands(projectDir);
    if (proj.length) groups.push({ label: "Project commands", items: proj });
    const glob = listGlobalCommands();
    if (glob.length) groups.push({ label: "Global commands", items: glob });
    for (const g of listPluginCommandGroups()) groups.push(g);
  } else if (agentId === "codex") {
    const cx = scanCommandsDir(path.join(os.homedir(), ".codex", "prompts"));
    if (cx.length) groups.push({ label: "Codex prompts", items: cx });
  }
  const npm = listNpmScripts(projectDir);
  if (npm.length) groups.push({ label: "npm scripts", items: npm });
  return groups;
}

module.exports = {
  scanCommandsDir,
  listSlashCommands,
  listGlobalCommands,
  listPluginCommandGroups,
  listNpmScripts,
  commandGroupsForAgent,
};
