"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findAppDir(customArg = process.argv[2]) {
  if (customArg) return path.resolve(customArg);

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

function requiredLibFiles(mainJsPath = path.join(__dirname, "..", "main.js")) {
  const source = fs.readFileSync(mainJsPath, "utf8");
  const files = new Set();
  const pattern = /require\(\s*["']\.\/(lib\/[^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const rel = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
    files.add(rel);
  }
  if (files.size === 0) {
    throw new Error(`No ./lib/* requires found in ${mainJsPath}`);
  }
  return [...files];
}

function parseAsar(asarPath) {
  const buf = fs.readFileSync(asarPath);
  if (buf.length < 16) {
    throw new Error(`Invalid app.asar archive: ${asarPath}`);
  }
  const headerSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const jsonStart = 16;
  const jsonEnd = jsonStart + jsonLength;
  const dataOffset = 8 + headerSize;
  if (jsonEnd > buf.length || dataOffset > buf.length) {
    throw new Error(`Corrupt app.asar header: ${asarPath}`);
  }
  const header = JSON.parse(buf.subarray(jsonStart, jsonEnd).toString("utf8"));
  return { buf, header, dataOffset };
}

function extractAsarNode(parsed, node, destPath, unpackedRoot) {
  if (node && node.files && typeof node.files === "object") {
    fs.mkdirSync(destPath, { recursive: true });
    for (const [name, child] of Object.entries(node.files)) {
      extractAsarNode(parsed, child, path.join(destPath, name), unpackedRoot);
    }
    return;
  }
  if (!node || typeof node.size !== "number") return;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (node.unpacked) {
    const rel = path.relative(parsed.extractRoot, destPath);
    fs.copyFileSync(path.join(unpackedRoot, rel), destPath);
    return;
  }
  const start = parsed.dataOffset + Number(node.offset || 0);
  const end = start + node.size;
  if (start < parsed.dataOffset || end > parsed.buf.length) {
    throw new Error(`Corrupt app.asar entry out of bounds: ${destPath}`);
  }
  fs.writeFileSync(destPath, parsed.buf.subarray(start, end));
}

function extractAsar(asarPath, destDir) {
  const parsed = parseAsar(asarPath);
  parsed.extractRoot = destDir;
  extractAsarNode(parsed, parsed.header, destDir, `${asarPath}.unpacked`);
}

function verifyExtractedAppRoot(appRoot, archiveLabel, libFiles) {
  const mainPath = path.join(appRoot, "main.js");
  if (!fs.existsSync(mainPath) || fs.statSync(mainPath).size === 0) {
    throw new Error(`Missing packaged desktop main.js in ${archiveLabel}`);
  }
  for (const rel of libFiles) {
    const modPath = path.join(appRoot, ...rel.split("/"));
    if (!fs.existsSync(modPath)) {
      throw new Error(`Missing packaged desktop module ${rel} in ${archiveLabel}`);
    }
    if (fs.statSync(modPath).size === 0) {
      throw new Error(`Empty packaged desktop module ${rel} in ${archiveLabel}`);
    }
    delete require.cache[require.resolve(modPath)];
    require(modPath);
  }
}

function verifyAppArchive(appDir, libFiles) {
  const asarPath = path.join(appDir, "resources", "app.asar");
  const unpackedDir = path.join(appDir, "resources", "app");

  if (fs.existsSync(asarPath)) {
    if (fs.statSync(asarPath).size === 0) {
      throw new Error(`Packaged app.asar is empty: ${asarPath}`);
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-win-asar-"));
    try {
      extractAsar(asarPath, tempDir);
      verifyExtractedAppRoot(tempDir, asarPath, libFiles);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }

  if (fs.existsSync(unpackedDir) && fs.statSync(unpackedDir).isDirectory()) {
    verifyExtractedAppRoot(unpackedDir, unpackedDir, libFiles);
    return;
  }

  throw new Error(`Missing packaged app archive: ${asarPath}`);
}

function verifyWinUnpacked(targetDir = findAppDir()) {
  const appDir = path.resolve(targetDir);

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
  const bridgeSrcIndexPath = mustExist(
    path.join("resources", "bridge", "src", "index.js"),
    "bundled bridge src/index.js"
  );
  const bridgePkgPath = mustExist(
    path.join("resources", "bridge", "package.json"),
    "bundled bridge package.json"
  );
  const publicPath = mustExist(path.join("resources", "bridge", "public"), "bundled bridge public assets");

  const publicEntries = fs.readdirSync(publicPath);
  if (publicEntries.length === 0) {
    throw new Error(`Bundled bridge public assets directory is empty: ${publicPath}`);
  }

  const exeStat = fs.statSync(exePath);
  const serverStat = fs.statSync(serverPath);
  const bridgeSrcIndexStat = fs.statSync(bridgeSrcIndexPath);
  const bridgePkgStat = fs.statSync(bridgePkgPath);
  if (exeStat.size === 0) {
    throw new Error(`Windows app executable is empty: ${exePath}`);
  }
  if (serverStat.size === 0) {
    throw new Error(`Bundled bridge server.js is empty: ${serverPath}`);
  }
  if (bridgeSrcIndexStat.size === 0) {
    throw new Error(`Bundled bridge src/index.js is empty: ${bridgeSrcIndexPath}`);
  }
  if (bridgePkgStat.size === 0) {
    throw new Error(`Bundled bridge package.json is empty: ${bridgePkgPath}`);
  }

  verifyAppArchive(appDir, requiredLibFiles());
  return appDir;
}

if (require.main === module) {
  const verifiedDir = verifyWinUnpacked();
  console.log(`Windows unpacked app OK: ${verifiedDir}`);
}

module.exports = { findAppDir, requiredLibFiles, verifyWinUnpacked };
