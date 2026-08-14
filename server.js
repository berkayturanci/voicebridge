#!/usr/bin/env node
/*
 * voicebridge — talk to a coding agent from a phone browser and hear it talk back.
 * Modular entrypoint re-exporting from ./src.
 */
"use strict";

const path = require("path");
const srcDir = path.join(__dirname, "src");

for (const key of Object.keys(require.cache)) {
  if (key.startsWith(srcDir)) {
    delete require.cache[key];
  }
}

const src = require("./src");

if (require.main === module) {
  src.start();
}

module.exports = src;
