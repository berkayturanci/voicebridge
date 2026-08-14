#!/usr/bin/env node
/*
 * voicebridge — talk to a coding agent from a phone browser and hear it talk back.
 * Modular entrypoint re-exporting from ./src.
 */
"use strict";

const src = require("./src");

if (require.main === module) {
  src.start();
}

module.exports = src;
