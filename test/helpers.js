"use strict";
// Shared test helpers: stub agent binaries + a tiny HTTP client.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// Write executable Node stub "agents" into a temp dir and point the *_BIN env
// vars at them, so the server spawns these instead of the real CLIs.
function installStubAgents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-stubs-"));

  // claude stub: emit stream-json NDJSON like the real --output-format stream-json.
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"system",subtype:"init"})+"\\n");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Hello "}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"world."}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"ok"})+"\\n");
`);

  // plain-text stub (codex / agy): echo whatever arrives on stdin.
  const echo = `#!/usr/bin/env node
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.stdout.write("echo:"+d.trim());});
`;
  const codex = path.join(dir, "codex");
  const agy = path.join(dir, "agy");
  fs.writeFileSync(codex, echo);
  fs.writeFileSync(agy, echo);

  for (const f of [claude, codex, agy]) fs.chmodSync(f, 0o755);

  process.env.CLAUDE_BIN = claude;
  process.env.CODEX_BIN = codex;
  process.env.AGY_BIN = agy;
  return dir;
}

function request(server, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const h = Object.assign({}, headers || {});
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      h["Content-Type"] = h["Content-Type"] || "application/json";
    }
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, method, path: p, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function ndjson(data) {
  return data.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

module.exports = { installStubAgents, request, ndjson };
