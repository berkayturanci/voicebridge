"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const srv = require("../server.js");

const fixtureDir = path.join(__dirname, "fixtures", "tmux");
function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

test("tmux capture extracts a Claude reply after the prompt echo", () => {
  const reply = srv._internals.extractTuiReply(fixture("claude-basic.txt"), "Summarize status");
  assert.strictEqual(reply, "Sure. Phase one is steady.\nSecond line kept.");
});

test("tmux capture strips ANSI without corrupting wrapped reply rows", () => {
  const reply = srv._internals.extractTuiReply(fixture("claude-ansi-wrapped.txt"), "Produce a long answer");
  assert.strictEqual(
    reply,
    "This is a very long answer that wraps\nacross pane rows without losing content.\nIt also keeps punctuation: [ok]."
  );
});

test("tmux malformed or partial capture has no silent reply", () => {
  const pane = fixture("malformed-partial.txt");
  assert.strictEqual(srv._internals.extractTuiReply(pane, "Produce a long answer"), "");
  assert.match(
    srv._internals.tmuxCaptureErrorMessage("pane did not contain a completed assistant reply"),
    /couldn't capture tmux reply/
  );
});

test("tmux generating detection covers Claude and best-effort Codex/Antigravity text", () => {
  assert.strictEqual(srv._internals.tmuxStillGenerating(fixture("generating-best-effort.txt")), true);
  assert.strictEqual(srv._internals.tmuxStillGenerating("Done.\n❯"), false);
});
