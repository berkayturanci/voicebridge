"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const srv = require("../server.js");
const { request } = require("./helpers");
const { sanitizePath } = require("../src/services/git");

test("git service: sanitizePath prevents path traversal and flag injection", () => {
  const base = process.cwd();
  const baseName = path.basename(base);
  assert.strictEqual(sanitizePath(base, "package.json"), "package.json");
  assert.strictEqual(sanitizePath(base, "src/index.js"), "src/index.js");
  assert.strictEqual(sanitizePath(base, "../secret.txt"), null);
  assert.strictEqual(sanitizePath(base, "/etc/passwd"), null);
  assert.strictEqual(sanitizePath(base, "--help"), null);
  assert.strictEqual(sanitizePath(base, "-v"), null);
  assert.strictEqual(sanitizePath(base, ""), null);
  // Sibling prefix traversal (e.g. /path/to/project-other)
  assert.strictEqual(sanitizePath(base, `../${baseName}-sibling/secret.txt`), null);
});

test("git service: getRepoStatus and getFileDiff on local repository", async () => {
  const status = await srv.getRepoStatus(process.cwd());
  assert.strictEqual(status.ok, true);
  assert.ok(typeof status.branch === "string" && status.branch.length > 0);
  assert.ok(Array.isArray(status.files));

  const diff = await srv.getFileDiff(process.cwd(), "package.json");
  assert.strictEqual(diff.ok, true);
  assert.strictEqual(diff.path, "package.json");
  assert.ok(typeof diff.diff === "string");
});

test("git service: non-git directory returns clean failure", async () => {
  const tmp = require("os").tmpdir();
  const status = await srv.getRepoStatus(tmp);
  assert.strictEqual(status.ok, false);
  assert.ok(status.error.length > 0);
});

test("git API: GET /api/git/status and GET /api/git/diff", async () => {
  const boot = srv.createSession({ name: "git-test", agent: "claude", projectDir: process.cwd() });
  srv.defaultSessionId = boot.id;
  const server = srv.buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const statusRes = await request(server, "GET", "/api/git/status?sessionId=" + boot.id);
    assert.strictEqual(statusRes.status, 200);
    const statusData = JSON.parse(statusRes.data);
    assert.strictEqual(statusData.ok, true);
    assert.ok(typeof statusData.branch === "string");
    assert.ok(Array.isArray(statusData.files));

    const diffRes = await request(server, "GET", "/api/git/diff?sessionId=" + boot.id + "&file=package.json");
    assert.strictEqual(diffRes.status, 200);
    const diffData = JSON.parse(diffRes.data);
    assert.strictEqual(diffData.ok, true);
    assert.strictEqual(diffData.path, "package.json");

    const missingFileRes = await request(server, "GET", "/api/git/diff?sessionId=" + boot.id);
    assert.strictEqual(missingFileRes.status, 400);

    const badFileRes = await request(server, "GET", "/api/git/diff?sessionId=" + boot.id + "&file=../etc/passwd");
    assert.strictEqual(badFileRes.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
