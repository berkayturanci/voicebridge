"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dmgPath = process.argv[2] || path.join("dist", "voicebridge-0.2.0-arm64.dmg");
const resolvedDmg = path.resolve(dmgPath);

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...opts });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function must(command, args, message) {
  const result = run(command, args);
  if (result.status !== 0) {
    throw new Error(`${message}\n${result.stdout}${result.stderr}`.trim());
  }
  return result.stdout.trim();
}

function plistValue(plist, key) {
  return must("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], `Missing ${key} in ${plist}`);
}

function detach(mountDir) {
  run("hdiutil", ["detach", mountDir]);
}

if (process.platform !== "darwin") {
  throw new Error("macOS is required to verify a Mac DMG.");
}
if (!fs.existsSync(resolvedDmg)) {
  throw new Error(`DMG not found: ${resolvedDmg}`);
}

must("hdiutil", ["verify", resolvedDmg], "DMG checksum verification failed.");

const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebridge-dmg."));
try {
  must("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDir, resolvedDmg], "DMG attach failed.");
  const appPath = path.join(mountDir, "voicebridge.app");
  if (!fs.existsSync(path.join(appPath, "Contents"))) {
    throw new Error("DMG does not contain top-level voicebridge.app.");
  }

  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executable = plistValue(infoPlist, "CFBundleExecutable");
  const version = plistValue(infoPlist, "CFBundleShortVersionString");
  const executablePath = path.join(appPath, "Contents", "MacOS", executable);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Missing app executable: ${executablePath}`);
  }
  if (!fs.existsSync(path.join(appPath, "Contents", "Resources", "bridge", "server.js"))) {
    throw new Error("Bundled bridge server.js is missing.");
  }
  if (!fs.existsSync(path.join(appPath, "Contents", "Resources", "bridge", "public"))) {
    throw new Error("Bundled bridge public/ assets are missing.");
  }

  must("codesign", ["--verify", "--deep", "--strict", appPath], "App codesign verification failed.");
  must("spctl", ["--assess", "--type", "execute", "--verbose", appPath], "Gatekeeper app assessment failed.");
  must("spctl", ["--assess", "--type", "open", "--verbose", resolvedDmg], "Gatekeeper DMG assessment failed.");
  must("xcrun", ["stapler", "validate", appPath], "App notarization stapler validation failed.");
  must("xcrun", ["stapler", "validate", resolvedDmg], "DMG notarization stapler validation failed.");

  console.log(`Mac release artifact OK: voicebridge.app ${version}`);
} finally {
  detach(mountDir);
  try {
    fs.rmdirSync(mountDir);
  } catch (_) {}
}
