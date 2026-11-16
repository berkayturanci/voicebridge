"use strict";

// Speech filter: turns an agent's markdown reply into text that sounds right
// when read aloud. Fenced code blocks, tables' separators, URLs, markdown
// markers and HTML are dropped; links keep their label; long file paths shrink
// to their basename. The chat UI still shows the full, untouched text — this
// only shapes what goes to text-to-speech.
//
// Two entry points:
//   toSpeakable(text)        one-shot, for complete text (e.g. /api/tts)
//   createSpeechStream()     incremental, fed with streamed deltas; it emits
//                            speakable text as soon as a sentence or line is
//                            complete and never speaks the inside of a code
//                            fence, even when the fence spans many deltas.

const FENCE_RE = /^\s*(```|~~~)/;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s)>\]]+/gi;
const WWW_RE = /\bwww\.[^\s)>\]]+/gi;
// A path-looking token: at least one slash between non-space segments, or ~/…
const PATH_RE = /(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?|\b[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?/g;

function basename(p) {
  const parts = String(p).replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function cleanInline(s) {
  let t = String(s);
  // Images: keep alt text only. Links: keep the label.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Autolinks <https://…> and HTML tags.
  t = t.replace(/<(?:https?|mailto):[^>]*>/gi, "");
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // Inline code: speak short identifiers, shrink paths, drop long snippets.
  t = t.replace(/`+([^`]*)`+/g, (_, code) => {
    const c = code.trim();
    if (!c) return "";
    if (/^[\w.@+~-]*\/[\w./@+~-]*$/.test(c)) return basename(c);
    if (c.length > 40 || /[{};=<>]|=>|\(\)/.test(c)) return "";
    return c;
  });
  t = t.replace(URL_RE, "").replace(WWW_RE, "");
  t = t.replace(PATH_RE, (m) => basename(m));
  // Emphasis / strikethrough markers (leave snake_case identifiers alone).
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, "$2");
  t = t.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  t = t.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;]|$)/g, "$1$2");
  t = t.replace(/[*`]/g, "");
  // Empty brackets left behind by removed links, then tidy spacing.
  t = t.replace(/\(\s*\)|\[\s*\]/g, "");
  t = t.replace(/\s+([.,!?:;])/g, "$1");
  t = t.replace(/[ \t]{2,}/g, " ");
  return t.trim();
}

function cleanLine(line) {
  let l = String(line);
  if (!l.trim()) return "";
  // Horizontal rules and table separator rows carry nothing to say.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return "";
  if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)) return "";
  // Table rows → comma-separated cells.
  if (/^\s*\|.*\|\s*$/.test(l)) {
    l = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
  }
  l = l.replace(/^\s{0,3}#{1,6}\s+/, ""); // headings
  l = l.replace(/^\s*(>\s*)+/, ""); // blockquotes
  l = l.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?/, ""); // list items / task boxes
  l = cleanInline(l);
  // Headings and list items usually have no closing punctuation; add a pause
  // so consecutive items don't run together when spoken.
  if (l && !/[.!?:;,…]$/.test(l)) l += ".";
  return l;
}

function joinSpoken(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
}

function toSpeakable(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    out.push(cleanLine(line));
  }
  return joinSpoken(out);
}

// True when the partial line has no unbalanced inline construct, so cutting it
// at a sentence boundary won't split a link or a code span.
function balanced(s) {
  const ticks = (s.match(/`/g) || []).length;
  if (ticks % 2) return false;
  const open = (s.match(/\[/g) || []).length;
  const close = (s.match(/\]/g) || []).length;
  if (open !== close) return false;
  const po = (s.match(/\]\(/g) || []).length;
  if (po) {
    // every "](" must be followed by a ")"
    const tail = s.slice(s.lastIndexOf("]("));
    if (!tail.includes(")")) return false;
  }
  return true;
}

function createSpeechStream() {
  let buf = "";
  let inFence = false;

  function processLine(line) {
    if (FENCE_RE.test(line)) { inFence = !inFence; return ""; }
    if (inFence) return "";
    return cleanLine(line);
  }

  function push(delta) {
    if (!delta) return "";
    buf += String(delta);
    const out = [];
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      out.push(processLine(line));
    }
    // Speak finished sentences of the current line without waiting for "\n",
    // unless we are inside a fence or the line could still become one.
    if (!inFence && buf && !/^\s*(`{1,3}|~{1,3})$/.test(buf) && !FENCE_RE.test(buf) && !/^\s*\|/.test(buf)) {
      const re = /[.!?…](?=\s)/g;
      let cut = -1, m;
      while ((m = re.exec(buf))) {
        const head = buf.slice(0, m.index + 1);
        if (balanced(head)) cut = m.index + 1;
      }
      if (cut > 0) {
        const head = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\s+/, "");
        out.push(cleanInline(head.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*(>\s*)+/, "").replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")));
      }
    }
    return joinSpoken(out);
  }

  function flush() {
    const rest = buf;
    buf = "";
    if (inFence) { inFence = false; return ""; }
    return rest ? processLine(rest) : "";
  }

  return { push, flush };
}

// Case- and accent-insensitive key for matching spoken commands and names
// ("API" = "api", "cevabı" = "cevabi", "İptal" = "iptal"), independent of locale.
function foldText(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

module.exports = { toSpeakable, createSpeechStream, cleanInline, cleanLine, foldText };
