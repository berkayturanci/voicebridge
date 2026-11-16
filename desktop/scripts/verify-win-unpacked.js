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

function lookupAsarEntry(header, relPath) {
  const parts = relPath.split("/").filter(Boolean);
  let cursor = header;
  for (const part of parts) {
    if (
      !cursor ||
      typeof cursor.files !== "object" ||
      cursor.files === null ||
      !Object.prototype.hasOwnProperty.call(cursor.files, part)
    ) {
      return null;
    }
    cursor = cursor.files[part];
  }
  if (!cursor || typeof cursor.size !== "number") {
    return null;
  }
  return cursor;
}

function readAsarFileBytes(parsed, asarPath, relPath, missingMessage, emptyMessage) {
  const node = lookupAsarEntry(parsed.header, relPath);
  if (!node) {
    throw new Error(missingMessage);
  }
  if (node.size === 0) {
    throw new Error(emptyMessage);
  }
  if (node.unpacked) {
    const unpackedPath = path.join(`${asarPath}.unpacked`, ...relPath.split("/").filter(Boolean));
    if (!fs.statSync(unpackedPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(missingMessage);
    }
    const buf = fs.readFileSync(unpackedPath);
    if (buf.length === 0) {
      throw new Error(emptyMessage);
    }
    return buf;
  }
  const offset = Number(node.offset || 0);
  const start = parsed.dataOffset + offset;
  const end = start + node.size;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(node.size) ||
    node.size <= 0 ||
    end > parsed.buf.length
  ) {
    throw new Error(`Corrupt app.asar entry out of bounds: ${relPath} in ${asarPath}`);
  }
  return parsed.buf.subarray(start, end);
}

function assertValidAsarEntryName(name, asarPath) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`Corrupt app.asar entry name: ${name} in ${asarPath}`);
  }
}

function materializeAsarLibSubtree(parsed, asarPath, tempDir, dirNode, relParts = ["lib"]) {
  if (!dirNode || typeof dirNode.files !== "object" || dirNode.files === null) {
    return;
  }
  for (const [name, entry] of Object.entries(dirNode.files)) {
    assertValidAsarEntryName(name, asarPath);
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "link")) {
      continue;
    }
    const nextParts = [...relParts, name];
    if (typeof entry.files === "object" && entry.files !== null) {
      materializeAsarLibSubtree(parsed, asarPath, tempDir, entry, nextParts);
      continue;
    }
    const rel = nextParts.join("/");
    const missingMsg = `Missing packaged desktop module ${rel} in ${asarPath}`;
    const emptyMsg = `Empty packaged desktop module ${rel} in ${asarPath}`;
    const modBytes = readAsarFileBytes(parsed, asarPath, rel, missingMsg, emptyMsg);
    const destPath = path.join(tempDir, ...nextParts);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, modBytes);
  }
}

function verifyAsarArchive(asarPath, libFiles) {
  const parsed = parseAsar(asarPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-win-asar-"));
  try {
    const mainMissingMsg = `Missing packaged desktop main.js in ${asarPath}`;
    const mainBytes = readAsarFileBytes(parsed, asarPath, "main.js", mainMissingMsg, mainMissingMsg);
    fs.writeFileSync(path.join(tempDir, "main.js"), mainBytes);

    const rootFiles =
      parsed.header && typeof parsed.header.files === "object" && parsed.header.files !== null
        ? parsed.header.files
        : null;
    if (rootFiles && Object.prototype.hasOwnProperty.call(rootFiles, "lib")) {
      materializeAsarLibSubtree(parsed, asarPath, tempDir, rootFiles.lib, ["lib"]);
    }

    const resolvedPaths = [];
    for (const rel of libFiles) {
      const missingMsg = `Missing packaged desktop module ${rel} in ${asarPath}`;
      const emptyMsg = `Empty packaged desktop module ${rel} in ${asarPath}`;
      const modBytes = readAsarFileBytes(parsed, asarPath, rel, missingMsg, emptyMsg);
      const destPath = path.join(tempDir, ...rel.split("/").filter(Boolean));
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, modBytes);
      }
      resolvedPaths.push(destPath);
    }

    for (const destPath of resolvedPaths) {
      delete require.cache[require.resolve(destPath)];
      require(destPath);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    verifyAsarArchive(asarPath, libFiles);
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
