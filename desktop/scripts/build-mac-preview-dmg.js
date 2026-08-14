"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pkg = require("../package.json");
const appPath = path.resolve("dist", "mac-arm64", "voicebridge.app");
const dmgPath = path.resolve("dist", `voicebridge-${pkg.version}-arm64.dmg`);

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
    ...options,
  });
}

function capture(command, args, message) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${message}\n${result.stdout || ""}${result.stderr || ""}`.trim());
  }
  return (result.stdout || "").trim();
}

function plistValue(plist, key) {
  return capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], `Missing ${key} in ${plist}`);
}

function detach(mountDir) {
  spawnSync("hdiutil", ["detach", mountDir], { stdio: "ignore" });
}

function verifyDmg() {
  capture("hdiutil", ["verify", dmgPath], "DMG checksum verification failed.");

  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebridge-preview-dmg."));
  try {
    capture("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDir, dmgPath], "DMG attach failed.");

    const mountedApp = path.join(mountDir, "voicebridge.app");
    if (!fs.existsSync(path.join(mountedApp, "Contents"))) {
      throw new Error("DMG does not contain top-level voicebridge.app.");
    }

    const infoPlist = path.join(mountedApp, "Contents", "Info.plist");
    const executable = plistValue(infoPlist, "CFBundleExecutable");
    const version = plistValue(infoPlist, "CFBundleShortVersionString");
    const executablePath = path.join(mountedApp, "Contents", "MacOS", executable);
    if (!fs.existsSync(executablePath)) {
      throw new Error(`Missing app executable: ${executablePath}`);
    }
    if (!fs.existsSync(path.join(mountedApp, "Contents", "Resources", "bridge", "server.js"))) {
      throw new Error("Bundled bridge server.js is missing.");
    }
    if (!fs.existsSync(path.join(mountedApp, "Contents", "Resources", "bridge", "public"))) {
      throw new Error("Bundled bridge public/ assets are missing.");
    }

    capture("codesign", ["--verify", "--deep", "--strict", mountedApp], "App ad-hoc codesign verification failed.");
    console.log(`Mac preview artifact OK: voicebridge.app ${version}`);
  } finally {
    detach(mountDir);
    try {
      fs.rmdirSync(mountDir);
    } catch (_) {}
  }
}

if (process.platform !== "darwin") {
  throw new Error("macOS is required to build the Mac preview DMG.");
}

fs.rmSync(dmgPath, { force: true });

run("npx", ["--no-install", "electron-builder", "--mac", "dir", "--arm64"]);

if (!fs.existsSync(appPath)) {
  throw new Error(`Missing app bundle: ${appPath}`);
}

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("codesign", ["--verify", "--deep", "--strict", appPath]);
run("npx", ["--no-install", "electron-builder", "--mac", "dmg", "--arm64", "--prepackaged", appPath]);

verifyDmg();
