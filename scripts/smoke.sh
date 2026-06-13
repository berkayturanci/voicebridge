#!/usr/bin/env bash
# End-to-end smoke test for voicebridge using a stub agent (no real CLI needed).
# Starts the bridge with a fake `claude` that emits stream-json (a tool_use plus
# text), then exercises the main HTTP flows and asserts the results.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got: $2, want: $3)"; fi; }

# A stub agent that mimics `claude --output-format stream-json`.
cat > "$TMP/claude" <<'EOF'
#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Edit",input:{file_path:"/r/app.js"}}]}})+"\n");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"All done. Shall I push?"}]}})+"\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success"})+"\n");
EOF
chmod +x "$TMP/claude"

CLAUDE_BIN="$TMP/claude" PORT="$PORT" HOST=127.0.0.1 node server.js >"$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -rf "$TMP"' EXIT

# Wait for readiness.
for _ in $(seq 1 30); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.2; done

echo "voicebridge e2e smoke ($BASE)"

# Health
check "health.ok" "$(curl -fsS "$BASE/api/health" | node -pe 'JSON.parse(require("fs").readFileSync(0)).ok')" "true"

# Config advertises agents, runners, push state
cfg="$(curl -fsS "$BASE/api/config")"
check "config.agents" "$(node -pe 'JSON.parse(process.argv[1]).agents.map(a=>a.id).sort().join(",")' "$cfg")" "antigravity,claude,codex,ollama"
check "config.runners" "$(node -pe 'JSON.parse(process.argv[1]).runners.join(",")' "$cfg")" "local"

# Push key disabled without VAPID
check "push.disabled" "$(curl -fsS "$BASE/api/push/key" | node -pe 'JSON.parse(require("fs").readFileSync(0)).enabled')" "false"

# Default session id
SID="$(curl -fsS "$BASE/api/sessions" | node -pe 'JSON.parse(require("fs").readFileSync(0)).defaultSessionId')"
[ -n "$SID" ] && ok "sessions.default ($SID)" || bad "sessions.default"

# Ask: expect activity + delta + done
ask="$(curl -fsS -N -X POST "$BASE/api/ask" -H 'Content-Type: application/json' -d "{\"text\":\"hi\",\"sessionId\":\"$SID\"}")"
echo "$ask" | grep -q '"type":"activity"' && ok "ask.activity" || bad "ask.activity"
echo "$ask" | grep -q 'Shall I push' && ok "ask.delta" || bad "ask.delta"
echo "$ask" | tail -1 | grep -q '"type":"done"' && ok "ask.done" || bad "ask.done"

# Create a codex session in full mode
new="$(curl -fsS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d "{\"agent\":\"codex\",\"mode\":\"full\",\"projectDir\":\"$PWD\"}")"
NID="$(node -pe 'JSON.parse(process.argv[1]).session.id' "$new")"
check "session.create.mode" "$(node -pe 'JSON.parse(process.argv[1]).session.mode' "$new")" "full"

# Rename it
ren="$(curl -fsS -X POST "$BASE/api/sessions/$NID" -H 'Content-Type: application/json' -d '{"name":"renamed"}')"
check "session.rename" "$(node -pe 'JSON.parse(process.argv[1]).session.name' "$ren")" "renamed"

# Delete it
check "session.delete" "$(curl -fsS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/sessions/$NID")" "200"
# Default is protected (expect 400, so don't use -f which treats 4xx as an error)
check "session.delete.default" "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/sessions/$SID")" "400"

# Reset
check "reset" "$(curl -fsS -X POST "$BASE/api/reset" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).ok')" "true"

# Static assets + content types
check "static.index" "$(curl -fsS -o /dev/null -w '%{http_code}' "$BASE/")" "200"
check "static.manifest" "$(curl -fsS -o /dev/null -w '%{content_type}' "$BASE/manifest.webmanifest")" "application/manifest+json; charset=utf-8"
check "static.sw" "$(curl -fsS -o /dev/null -w '%{http_code}' "$BASE/sw.js")" "200"
check "static.icon" "$(curl -fsS -o /dev/null -w '%{content_type}' "$BASE/icon.svg")" "image/svg+xml"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
