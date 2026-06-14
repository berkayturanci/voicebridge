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
// eslint-disable-next-line no-new-func
new Function("document", "navigator", "setTimeout",
  grab("appendInline") + grab("appendBlocks") + grab("looksLikeDiff") + grab("buildPre") +
  "\nthis.appendInline=appendInline;this.appendBlocks=appendBlocks;this.looksLikeDiff=looksLikeDiff;this.buildPre=buildPre;"
).call(sandbox, sandbox.document, sandbox.navigator, sandbox.setTimeout);

const txt = (el) => el instanceof TextNode ? el.text : (el._text || el.children.map(txt).join(""));
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
