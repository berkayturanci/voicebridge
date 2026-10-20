"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requiredLibFiles, verifyWinUnpacked } = require("../scripts/verify-win-unpacked");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildTestAsar(files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [relPath, entry] of Object.entries(files)) {
    const isDescriptor = entry !== null && typeof entry === "object" && !Buffer.isBuffer(entry);
    const isUnpackedObj = isDescriptor && entry.unpacked === true;

    const parts = relPath.split("/").filter(Boolean);
    let cursor = header;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!cursor.files[part]) cursor.files[part] = { files: {} };
      cursor = cursor.files[part];
    }

    if (isUnpackedObj) {
      const size =
        typeof entry.size === "number"
          ? entry.size
          : entry.content !== undefined
            ? Buffer.byteLength(entry.content)
            : 1;
      const node = { size, unpacked: true };
      if (entry.archiveContent !== undefined) {
        const archiveBuf = Buffer.isBuffer(entry.archiveContent)
          ? entry.archiveContent
          : Buffer.from(String(entry.archiveContent), "utf8");
        node.offset = String(offset);
        chunks.push(archiveBuf);
        offset += archiveBuf.length;
      }
      cursor.files[parts[parts.length - 1]] = node;
    } else if (isDescriptor) {
      const buf = Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(String(entry.content ?? ""), "utf8");
      const entrySize = entry.size !== undefined ? entry.size : buf.length;
      const entryOffset = entry.offset !== undefined ? entry.offset : String(offset);
      cursor.files[parts[parts.length - 1]] = { size: entrySize, offset: entryOffset };
      chunks.push(buf);
      offset += buf.length;
    } else {
      const buf = Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8");
      cursor.files[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
      chunks.push(buf);
      offset += buf.length;
    }
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), "utf8");
  const alignedJsonLen = Math.ceil(jsonBuf.length / 4) * 4;
  const headerPayloadSize = 4 + alignedJsonLen;
  const headerSize = 4 + headerPayloadSize;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerPayloadSize, 8);
  prefix.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(prefix, 16);

  return Buffer.concat([prefix, ...chunks]);
}

function makeFakeWinUnpacked({
  omitLib = null,
  unpackedLib = null,
  omitUnpackedFile = false,
  omitBridgeSrc = false,
  omitBridgePkg = false,
  asarOverrides = {},
} = {}) {
  const desktopRoot = path.resolve(__dirname, "..");
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-win-unpacked-"));
  try {
    fs.writeFileSync(path.join(appDir, "voicebridge.exe"), "MZ-fake-exe");

    const bridgeDir = path.join(appDir, "resources", "bridge");
    fs.mkdirSync(path.join(bridgeDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "server.js"), "module.exports = require('./src');\n");
    fs.writeFileSync(path.join(bridgeDir, "public", "index.html"), "<!doctype html><title>vb</title>");

    if (!omitBridgeSrc) {
      fs.mkdirSync(path.join(bridgeDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(bridgeDir, "src", "index.js"), "module.exports = { ok: true };\n");
    }
    if (!omitBridgePkg) {
      fs.writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({ name: "voicebridge", version: "0.8.1" }));
    }

    const asarFiles = {
      "main.js": fs.readFileSync(path.join(desktopRoot, "main.js")),
    };
    for (const rel of requiredLibFiles()) {
      if (rel === omitLib) continue;
      const sourceBytes = fs.readFileSync(path.join(desktopRoot, ...rel.split("/")));
      if (rel === unpackedLib) {
        const unpackedBytes = Buffer.concat([
          sourceBytes,
          Buffer.from(
            "\nmodule.exports.__fromUnpacked = true;\nglobalThis.__vbUnpackedMarker = module.exports.__fromUnpacked;\n",
            "utf8"
          ),
        ]);
        asarFiles[rel] = {
          size: unpackedBytes.length,
          unpacked: true,
          archiveContent: "{{{ invalid js in archive",
        };
        if (!omitUnpackedFile) {
          const unpackedDest = path.join(appDir, "resources", "app.asar.unpacked", ...rel.split("/"));
          fs.mkdirSync(path.dirname(unpackedDest), { recursive: true });
          fs.writeFileSync(unpackedDest, unpackedBytes);
        }
      } else {
        asarFiles[rel] = sourceBytes;
      }
    }
    Object.assign(asarFiles, asarOverrides);
    fs.writeFileSync(path.join(appDir, "resources", "app.asar"), buildTestAsar(asarFiles));

    return appDir;
  } catch (err) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw err;
  }
}

test("desktop package.json bundles lib/** and bridge src + package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.build?.files), "build.files must be an array");
  assert.ok(pkg.build.files.includes("lib/**"), "build.files must include lib/**");

  const extra = pkg.build?.extraResources || [];
  assert.ok(
    extra.some((entry) => entry.from === "../src" && entry.to === "bridge/src"),
    "build.extraResources must copy ../src to bridge/src"
  );
  assert.ok(
    extra.some((entry) => entry.from === "../package.json" && entry.to === "bridge/package.json"),
    "build.extraResources must copy ../package.json to bridge/package.json"
  );

  assert.deepStrictEqual(requiredLibFiles().sort(), [
    "lib/bridge-health.js",
    "lib/settings.js",
    "lib/tailscale-diagnostics.js",
  ]);
});

test("verify-win-unpacked checks packaged desktop lib modules and bridge src/package.json", () => {
  const validDir = makeFakeWinUnpacked();
  try {
    assert.strictEqual(verifyWinUnpacked(validDir), validDir);
  } finally {
    fs.rmSync(validDir, { recursive: true, force: true });
  }

  for (const libFile of requiredLibFiles()) {
    const missingLibDir = makeFakeWinUnpacked({ omitLib: libFile });
    try {
      assert.throws(
        () => verifyWinUnpacked(missingLibDir),
        new RegExp(`Missing packaged desktop module ${escapeRegExp(libFile)}`)
      );
    } finally {
      fs.rmSync(missingLibDir, { recursive: true, force: true });
    }
  }

  const unpackedTarget = requiredLibFiles()[0];
  const missingUnpackedDir = makeFakeWinUnpacked({
    unpackedLib: unpackedTarget,
    omitUnpackedFile: true,
  });
  try {
    assert.throws(
      () => verifyWinUnpacked(missingUnpackedDir),
      new RegExp(`Missing packaged desktop module ${escapeRegExp(unpackedTarget)}`)
    );
  } finally {
    fs.rmSync(missingUnpackedDir, { recursive: true, force: true });
  }

  delete globalThis.__vbUnpackedMarker;
  const presentUnpackedDir = makeFakeWinUnpacked({
    unpackedLib: unpackedTarget,
    omitUnpackedFile: false,
  });
  try {
    assert.strictEqual(verifyWinUnpacked(presentUnpackedDir), presentUnpackedDir);
    assert.strictEqual(globalThis.__vbUnpackedMarker, true);
  } finally {
    delete globalThis.__vbUnpackedMarker;
    fs.rmSync(presentUnpackedDir, { recursive: true, force: true });
  }

  const corruptOffsetDir = makeFakeWinUnpacked({
    asarOverrides: {
      [unpackedTarget]: { content: "module.exports = {};\n", offset: "abc" },
    },
  });
  try {
    assert.throws(
      () => verifyWinUnpacked(corruptOffsetDir),
      /Corrupt app\.asar entry out of bounds/
    );
  } finally {
    fs.rmSync(corruptOffsetDir, { recursive: true, force: true });
  }

  const siblingRequireDir = makeFakeWinUnpacked({
    asarOverrides: {
      "lib/helper-only.js": "module.exports = { helperLoaded: true };\n",
      [unpackedTarget]:
        "const helper = require('./helper-only');\nif (!helper || helper.helperLoaded !== true) throw new Error('sibling helper not loaded');\nmodule.exports = helper;\n",
    },
  });
  try {
    assert.strictEqual(verifyWinUnpacked(siblingRequireDir), siblingRequireDir);
  } finally {
    fs.rmSync(siblingRequireDir, { recursive: true, force: true });
  }

  const missingSrcDir = makeFakeWinUnpacked({ omitBridgeSrc: true });
  try {
    assert.throws(() => verifyWinUnpacked(missingSrcDir), /Missing bundled bridge src[\\/]index\.js/);
  } finally {
    fs.rmSync(missingSrcDir, { recursive: true, force: true });
  }

  const missingPkgDir = makeFakeWinUnpacked({ omitBridgePkg: true });
  try {
    assert.throws(() => verifyWinUnpacked(missingPkgDir), /Missing bundled bridge package\.json/);
  } finally {
    fs.rmSync(missingPkgDir, { recursive: true, force: true });
  }
});
