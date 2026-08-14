"use strict";

const test = require("node:test");
const assert = require("node:assert");
const srv = require("../server.js");
const { request } = require("./helpers");

test.afterEach(() => {
  srv.clearSessionApprovals();
});

test("approvals service: lifecycle create, list, resolve, clear", () => {
  let resolvedValue = null;
  const appr = srv.createApproval({
    sessionId: "sess-1",
    tool: "Bash",
    command: "rm -rf /tmp/test",
    description: "Remove temporary directory",
    resolve: (approved) => { resolvedValue = approved; },
  });

  assert.ok(appr.id.startsWith("appr_"));
  assert.strictEqual(appr.sessionId, "sess-1");
  assert.strictEqual(appr.tool, "Bash");
  assert.strictEqual(appr.command, "rm -rf /tmp/test");

  const listAll = srv.getPendingApprovals();
  assert.strictEqual(listAll.length, 1);
  assert.strictEqual(listAll[0].id, appr.id);

  const listOther = srv.getPendingApprovals("sess-other");
  assert.strictEqual(listOther.length, 0);

  const ok = srv.resolveApproval(appr.id, true);
  assert.strictEqual(ok, true);
  assert.strictEqual(resolvedValue, true);
  assert.strictEqual(srv.getPendingApprovals().length, 0);

  const okAgain = srv.resolveApproval(appr.id, false);
  assert.strictEqual(okAgain, false);
});

test("approvals API: GET /api/approvals and POST /api/approvals/:id", async () => {
  const boot = srv.createSession({ name: "appr-test", agent: "claude", projectDir: process.cwd() });
  srv.defaultSessionId = boot.id;
  const server = srv.buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    let resolvedWith = null;
    const appr = srv.createApproval({
      sessionId: boot.id,
      tool: "FileEdit",
      command: "package.json",
      description: "Edit dependencies in package.json",
      resolve: (val) => { resolvedWith = val; },
    });

    const getRes = await request(server, "GET", "/api/approvals?sessionId=" + boot.id);
    assert.strictEqual(getRes.status, 200);
    const getData = JSON.parse(getRes.data);
    assert.ok(Array.isArray(getData.approvals));
    assert.strictEqual(getData.approvals.length, 1);
    assert.strictEqual(getData.approvals[0].id, appr.id);
    assert.strictEqual(getData.approvals[0].tool, "FileEdit");

    const postRes = await request(server, "POST", "/api/approvals/" + appr.id, { approved: true });
    assert.strictEqual(postRes.status, 200);
    const postData = JSON.parse(postRes.data);
    assert.strictEqual(postData.ok, true);
    assert.strictEqual(postData.approved, true);
    assert.strictEqual(resolvedWith, true);

    const postAgain = await request(server, "POST", "/api/approvals/" + appr.id, { approved: true });
    assert.strictEqual(postAgain.status, 404);

    const postBad = await request(server, "POST", "/api/approvals/non-existent", { approved: true });
    assert.strictEqual(postBad.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseClaudeEvents: extracts approval_request events", () => {
  const line = JSON.stringify({
    type: "permission_request",
    tool: "Bash",
    input: { command: "npm test", description: "Run tests" },
  });
  const events = srv.parseClaudeEvents(line);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "approval_request");
  assert.strictEqual(events[0].tool, "Bash");
  assert.strictEqual(events[0].command, "npm test");
  assert.strictEqual(events[0].description, "Run tests");
});

test("approvals API: fail-closed rejection when approved is omitted or false", async () => {
  const boot = srv.createSession({ name: "appr-fail-closed", agent: "claude", projectDir: process.cwd() });
  srv.defaultSessionId = boot.id;
  const server = srv.buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    let resolvedWith = null;
    const appr = srv.createApproval({
      sessionId: boot.id,
      tool: "Bash",
      command: "rm file",
      resolve: (val) => { resolvedWith = val; },
    });

    const postRes = await request(server, "POST", "/api/approvals/" + appr.id, {});
    assert.strictEqual(postRes.status, 200);
    const data = JSON.parse(postRes.data);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.approved, false);
    assert.strictEqual(resolvedWith, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("approvals API: POST /api/reset clears pending approvals", async () => {
  const boot = srv.createSession({ name: "appr-reset", agent: "claude", projectDir: process.cwd() });
  srv.defaultSessionId = boot.id;
  const server = srv.buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    srv.createApproval({
      sessionId: boot.id,
      tool: "Bash",
      command: "echo 1",
      resolve: () => {},
    });

    assert.strictEqual(srv.getPendingApprovals(boot.id).length, 1);
    const resetRes = await request(server, "POST", "/api/reset", { sessionId: boot.id });
    assert.strictEqual(resetRes.status, 200);
    assert.strictEqual(srv.getPendingApprovals(boot.id).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
