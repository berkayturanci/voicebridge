"use strict";
// Regression tests for the chat renderer in public/index.html. The functions
// live inline in the page, so we extract them by brace-matching and run them
// against a minimal DOM shim — covering markdown blocks, link safety, and the
// diff coloring without needing a browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// ---- tiny DOM shim ----
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this._text = ""; this.attrs = {}; this.className = ""; }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this._text = v; this.children = []; } get textContent() { return this._text; }
  set href(v) { this.attrs.href = v; } get href() { return this.attrs.href; }
  set target(v) { this.attrs.target = v; } set rel(v) { this.attrs.rel = v; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
}
class TextNode { constructor(t) { this.text = t; this.nodeType = 3; } }

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
function grab(name) {
  const i = html.indexOf("function " + name + "(");
  let d = 0, j = i;
  for (; j < html.length; j++) { if (html[j] === "{") d++; else if (html[j] === "}") { d--; if (d === 0) { j++; break; } } }
  return html.slice(i, j);
}
const sandbox = {
  document: { createElement: (t) => new El(t), createTextNode: (t) => new TextNode(t) },
  navigator: {}, setTimeout: () => {},
};
new Function("document", "navigator", "setTimeout",
  grab("appendInline") + grab("appendBlocks") + grab("looksLikeDiff") + grab("buildPre") + grab("escapeHtml") + grab("calculateRmsAndZcr") + grab("parseSttStreamMessage") +
  "\nthis.appendInline=appendInline;this.appendBlocks=appendBlocks;this.looksLikeDiff=looksLikeDiff;this.buildPre=buildPre;this.escapeHtml=escapeHtml;this.calculateRmsAndZcr=calculateRmsAndZcr;this.parseSttStreamMessage=parseSttStreamMessage;"
).call(sandbox, sandbox.document, sandbox.navigator, sandbox.setTimeout);

const tags = (el) => { const out = []; (function w(e) { if (e.tagName) out.push(e.tagName); (e.children || []).forEach(w); })(el); return out; };

test("links: http(s) becomes <a>, other schemes are inert text", () => {
  const e = new El("div");
  sandbox.appendInline(e, "[ok](https://x.io) and [bad](javascript:alert(1))");
  const anchors = e.children.filter((c) => c.tagName === "A");
  assert.strictEqual(anchors.length, 1, "only the http link is an anchor");
  assert.strictEqual(anchors[0].attrs.href, "https://x.io");
  assert.strictEqual(anchors[0].attrs.rel, "noopener noreferrer");
  assert.ok(!tags(e).includes("A") || anchors.length === 1);
});

test("inline: code and bold", () => {
  const e = new El("div");
  sandbox.appendInline(e, "a `b` **c**");
  assert.deepStrictEqual(tags(e).filter((t) => t === "CODE" || t === "STRONG"), ["CODE", "STRONG"]);
});

test("blocks: headings, bullet and numbered lists, paragraph", () => {
  let e = new El("div");
  sandbox.appendBlocks(e, "# H\n- a\n- b\nplain");
  let t = tags(e);
  assert.ok(t.includes("H3"));
  assert.ok(t.includes("UL") && t.filter((x) => x === "LI").length === 2);
  assert.ok(t.includes("DIV"));

  e = new El("div");
  sandbox.appendBlocks(e, "1. a\n2) b");
  assert.ok(tags(e).includes("OL") && tags(e).filter((x) => x === "LI").length === 2);
});

test("diff: detection + per-line classes", () => {
  assert.ok(sandbox.looksLikeDiff("-old\n+new"));
  assert.ok(!sandbox.looksLikeDiff("just text\nno markers"));
  const pre = sandbox.buildPre("@@ -1 +1 @@\n-old\n+new", "diff");
  const cls = pre.children.map((c) => c.className);
  assert.ok(cls.includes("hunk") && cls.includes("del") && cls.includes("add"));
});

test("plain code is a <code> element, not diff-colored", () => {
  const pre = sandbox.buildPre("const x = 1;", "js");
  assert.strictEqual(pre.children[0].tagName, "CODE");
});

test("diff auto-detect only fires on untagged blocks", () => {
  // Untagged but diff-shaped → colored spans.
  const auto = sandbox.buildPre("-a\n+b", "");
  assert.ok(auto.children.map((c) => c.className).includes("add"));
  // Tagged as a language → left plain even if it has +/- lines (no false positive).
  const tagged = sandbox.buildPre("-a\n+b", "bash");
  assert.strictEqual(tagged.children[0].tagName, "CODE");
});

test("index.html contains MediaSession API and transcript export handlers", () => {
  assert.ok(html.includes("navigator.mediaSession"), "includes MediaSession integration");
  assert.ok(html.includes("exportTranscript"), "includes exportTranscript function");
  assert.ok(html.includes("exportMd"), "includes exportMd button");
  assert.ok(html.includes("exportJson"), "includes exportJson button");
});

test("index.html contains interactive tool approval card rendering", () => {
  assert.ok(html.includes("approval-card"), "includes approval-card class");
  assert.ok(html.includes("approval-btn-approve"), "includes approval-btn-approve button class");
  assert.ok(html.includes("approval-btn-reject"), "includes approval-btn-reject button class");
  assert.ok(html.includes("renderApprovalCard"), "includes renderApprovalCard function");
  assert.ok(html.includes("/api/approvals/"), "includes /api/approvals endpoint calls");
  assert.strictEqual(sandbox.escapeHtml('<script>alert("xss")</script> & "test"'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;test&quot;');
});

test("index.html contains VAD engine and calculateRmsAndZcr", () => {
  assert.ok(html.includes("calculateRmsAndZcr"), "includes calculateRmsAndZcr function");
  assert.ok(html.includes("startVad"), "includes startVad function");
  assert.ok(html.includes("stopVad"), "includes stopVad function");
  assert.ok(html.includes("talkSilence"), "includes talkSilence setting");

  // Empty buffer
  const emptyRes = sandbox.calculateRmsAndZcr(new Float32Array(0));
  assert.strictEqual(emptyRes.rms, 0);
  assert.strictEqual(emptyRes.zcrRate, 0);

  // Silence buffer
  const silenceBuf = new Float32Array(512);
  const silenceRes = sandbox.calculateRmsAndZcr(silenceBuf);
  assert.strictEqual(silenceRes.rms, 0);
  assert.strictEqual(silenceRes.zcrRate, 0);

  // Pure sine wave
  const sineBuf = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    sineBuf[i] = Math.sin((i * 2 * Math.PI) / 32);
  }
  const sineRes = sandbox.calculateRmsAndZcr(sineBuf);
  assert.ok(sineRes.rms > 0.6, "rms of unit sine should be ~0.707");
  assert.ok(sineRes.zcrRate > 0.05, "zcr of oscillating wave is non-zero");

  // Sine wave with DC bias (+0.5)
  const dcBuf = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    dcBuf[i] = 0.5 + Math.sin((i * 2 * Math.PI) / 32);
  }
  const dcRes = sandbox.calculateRmsAndZcr(dcBuf);
  assert.ok(dcRes.rms > 0.6, "rms after mean removal matches AC component");
  assert.ok(dcRes.zcrRate > 0.05, "zcr detects crossings even with DC bias");
});

test("index.html contains Git changes drawer and diff viewer", () => {
  assert.ok(html.includes("gitBtn"), "includes gitBtn in header");
  assert.ok(html.includes("gitModal"), "includes gitModal container");
  assert.ok(html.includes("gitFileList"), "includes gitFileList container");
  assert.ok(html.includes("gitDiffContainer"), "includes gitDiffContainer");
  assert.ok(html.includes("openGitDrawer"), "includes openGitDrawer function");
  assert.ok(html.includes("/api/git/status"), "includes /api/git/status endpoint call");
  assert.ok(html.includes("/api/git/diff"), "includes /api/git/diff endpoint call");
});

test("index.html contains streaming STT engine and parseSttStreamMessage", () => {
  assert.ok(html.includes("startStreamSTT"), "includes startStreamSTT");
  assert.ok(html.includes("stopStreamSTT"), "includes stopStreamSTT");
  assert.ok(html.includes("/api/stt-stream"), "includes /api/stt-stream WebSocket URL");

  const delta = sandbox.parseSttStreamMessage(JSON.stringify({ type: "delta", text: "testing audio" }));
  assert.strictEqual(delta.text, "testing audio");
  assert.strictEqual(delta.done, false);

  const deltaProp = sandbox.parseSttStreamMessage(JSON.stringify({ delta: "progressive words" }));
  assert.strictEqual(deltaProp.text, "progressive words");
  assert.strictEqual(deltaProp.done, false);

  const finalMsg = sandbox.parseSttStreamMessage(JSON.stringify({ type: "final", text: "full sentence" }));
  assert.strictEqual(finalMsg.text, "full sentence");
  assert.strictEqual(finalMsg.done, true);
});

test("index.html contains full-duplex WebSocket live sync", () => {
  assert.ok(html.includes("initSyncSocket"), "includes initSyncSocket");
  assert.ok(html.includes("syncSubscribe"), "includes syncSubscribe");
  assert.ok(html.includes("handleSyncMessage"), "includes handleSyncMessage");
  assert.ok(html.includes('"/ws"'), "includes /ws endpoint");
});

