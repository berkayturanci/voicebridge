"use strict";

const { execFileSync } = require("node:child_process");

function env(name) {
  return process.env[name] && process.env[name].trim();
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `${err.stdout || ""}${err.stderr || ""}`;
  }
}

function hasDeveloperIdApplicationIdentity() {
  const output = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  return /Developer ID Application:/.test(output);
}

function hasNotaryTool() {
  try {
    execFileSync("xcrun", ["--find", "notarytool"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function notarizationProfile() {
  if (env("APPLE_API_KEY") && env("APPLE_API_KEY_ID") && env("APPLE_API_ISSUER")) {
    return "App Store Connect API key";
  }
  if (env("APPLE_ID") && env("APPLE_APP_SPECIFIC_PASSWORD") && env("APPLE_TEAM_ID")) {
    return "Apple ID app-specific password";
  }
  if (env("APPLE_KEYCHAIN") && env("APPLE_KEYCHAIN_PROFILE")) {
    return "notarytool keychain profile";
  }
  return "";
}

const errors = [];
if (process.platform !== "darwin") {
  errors.push("macOS is required to build a signed/notarized DMG.");
}
if (!hasDeveloperIdApplicationIdentity()) {
  errors.push("Missing a valid 'Developer ID Application' codesigning identity in Keychain.");
}
if (!hasNotaryTool()) {
  errors.push("Missing xcrun notarytool. Install Xcode 13+ or Command Line Tools.");
}
const profile = notarizationProfile();
if (!profile) {
  errors.push(
    "Missing notarization credentials. Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, " +
      "or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, " +
      "or APPLE_KEYCHAIN/APPLE_KEYCHAIN_PROFILE."
  );
}

if (errors.length) {
  console.error("Mac release signing is not ready:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Mac release signing prerequisites OK (${profile}).`);
