"use strict";

const test = require("node:test");
const assert = require("node:assert");

const srv = require("../server.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLiveProc(kills) {
  return {
    buf: "",
    busy: false,
    idleTimer: setTimeout(() => {}, 10000),
    child: {
      stdin: { end() { kills.stdin += 1; } },
      kill(signal) { kills.signals.push(signal); },
    },
  };
}

test.afterEach(() => {
  srv._internals.liveProcs.clear();
});

test("shutdown closes the server and SIGTERMs live children once", async () => {
  const closed = [];
  const exits = [];
  const kills = { stdin: 0, signals: [] };
  srv._internals.liveProcs.set("a", makeLiveProc(kills));
  srv._internals.liveProcs.set("b", makeLiveProc(kills));

  const server = {
    close(cb) { closed.push("close"); setImmediate(cb); },
    closeIdleConnections() { closed.push("idle"); },
    closeAllConnections() { closed.push("all"); },
  };
  const shutdown = srv._internals.createShutdownHandler(server, {
    exit(code) { exits.push(code); },
    graceMs: 100,
    logger: { log() {}, error() {} },
  });

  shutdown("SIGTERM");
  shutdown("SIGINT");
  await sleep(20);

  assert.deepStrictEqual(closed, ["close", "idle", "all"]);
  assert.deepStrictEqual(kills.signals, ["SIGTERM", "SIGTERM"]);
  assert.strictEqual(kills.stdin, 2);
  assert.strictEqual(srv._internals.liveProcs.size, 0);
  assert.deepStrictEqual(exits, [0]);
});

test("shutdown force-exits when server close does not finish", async () => {
  const exits = [];
  const shutdown = srv._internals.createShutdownHandler(
    { close() {} },
    {
      exit(code) { exits.push(code); },
      graceMs: 10,
      logger: { log() {}, error() {} },
    }
  );

  shutdown("SIGTERM");
  await sleep(30);

  assert.deepStrictEqual(exits, [1]);
});
