# Reference cloud runner

A tiny, zero-dependency example of a **cloud runner** for voicebridge. It runs the
agent CLI on its own host and streams the same NDJSON protocol the bridge expects,
so a bridge with `CLOUD_RUNNER_URL` set can serve `cloud` sessions through it.

See [../../docs/configuration.md](../../docs/configuration.md#runners-local-vs-cloud)
for the runner model.

## Run it

On the host that has the agent CLIs installed and authenticated:

```bash
# optionally protect it
export CLOUD_RUNNER_TOKEN="$(openssl rand -hex 16)"
node examples/cloud-runner/server.js     # listens on 0.0.0.0:8910
```

## Point the bridge at it

On the machine running voicebridge:

```bash
export CLOUD_RUNNER_URL="http://<runner-host>:8910/"
export CLOUD_RUNNER_TOKEN="<same token>"   # if you set one
npm start
```

Now the new-session dialog offers a **☁️ Bulut** runner; turns for those sessions
are executed on the runner host, and the **folder picker** browses the runner
host (the bridge proxies it).

## Protocol

The runner also answers `GET /browse?path=<dir>` (same Bearer auth) with
`{ "path", "parent", "dirs": [...] }`, so the bridge's folder picker can list the
**remote** host's directories for cloud sessions.



The bridge POSTs JSON:

```json
{ "text": "...", "agent": "claude", "mode": "full", "projectDir": "/path",
  "sessionId": "s1", "continue": true, "voice": false }
```

and the runner responds with newline-delimited JSON events:

```
{"type":"delta","text":"..."}
{"type":"done"}
```

(or `{"type":"error","error":"..."}`). This example reuses voicebridge's agent
adapters; you can replace the body with any backend that speaks the same protocol.
