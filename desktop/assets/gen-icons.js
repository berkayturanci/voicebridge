#!/usr/bin/env node
"use strict";
/*
 * Generate the desktop app/tray icons as PNGs (no external tooling needed).
 * Draws a rounded square in the brand green with a white "voice" glyph.
 * Run: node desktop/assets/gen-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, draw) {
  const w = size, h = size;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Rounded square, brand green, with a simple white mic bar glyph.
function draw(size) {
  const r = size * 0.22; // corner radius
  const inside = (x, y) => {
    const nx = Math.min(x, size - 1 - x);
    const ny = Math.min(y, size - 1 - y);
    if (nx >= r || ny >= r) return true;
    const dx = r - nx, dy = r - ny;
    return dx * dx + dy * dy <= r * r;
  };
  const cx = size / 2;
  return (x, y) => {
    if (!inside(x, y)) return [0, 0, 0, 0];
    // mic body: vertical rounded bar in the center
    const inMic =
      Math.abs(x - cx) <= size * 0.13 &&
      y >= size * 0.24 &&
      y <= size * 0.58;
    // stand
    const inStand =
      Math.abs(x - cx) <= size * 0.02 && y > size * 0.58 && y <= size * 0.72;
    const inBase =
      Math.abs(x - cx) <= size * 0.18 &&
      y >= size * 0.72 &&
      y <= size * 0.76;
    if (inMic || inStand || inBase) return [255, 255, 255, 255];
    return [0x3f, 0xb9, 0x50, 255];
  };
}

const out = __dirname;
for (const size of [32, 256, 512]) {
  const name = size === 32 ? "tray.png" : size === 256 ? "icon.png" : "icon@512.png";
  fs.writeFileSync(path.join(out, name), png(size, draw(size)));
  console.log("wrote", name, size + "x" + size);
}
