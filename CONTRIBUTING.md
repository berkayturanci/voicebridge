# Contributing

Thanks for helping improve voicebridge! It is intentionally small and
(almost) dependency-free — please keep it that way.

## Dev setup

```bash
git clone <your-fork-url> voicebridge
cd voicebridge
npm install        # qrcode-terminal, the only dependency
npm start          # run the bridge on http://127.0.0.1:8787
```

You can develop without a real agent: point a `*_BIN` env var at a stub script
(see `test/helpers.js` for examples) and exercise the endpoints with `curl`.

## Tests

The suite uses Node's built-in test runner — no test framework dependency.

```bash
npm test
```

It covers the agent adapters, the Claude stream-json parser, the session
registry, request streaming, modes, and auth, using stub "agents" so no real
CLI is needed. Please add or update tests with any change to `server.js`.

The keel build gate runs `node --check server.js && npm test`, so keep both
green.

## Project layout

```
server.js            # the bridge: agents, sessions, HTTP, streaming
public/index.html    # the single-page web UI (no build step)
test/                # node:test suites + shared stubs (helpers.js)
docs/                # architecture, configuration, security
```

## Adding an agent

1. Add an entry to the `AGENTS` map in `server.js` with `label`, `bin`,
   `supportsContinue`, `stream` (`"ndjson"` or `"text"`), `defaultMode`,
   `modes`, a `command(prompt, { cont, modeArgs })` function, and — for ndjson
   agents — a `parseLine(line)` function. See
   [docs/architecture.md](docs/architecture.md#agent-adapters).
2. Add unit tests for the new `command` output and (if ndjson) its parser.
3. Document the agent and its modes in
   [docs/configuration.md](docs/configuration.md).

## Style

- Plain Node standard library on the server; plain DOM in the browser. No build
  step, no framework.
- Match the surrounding code: small functions, early returns, terse comments
  that explain *why*.
- New runtime dependencies need a strong justification.

## Pull requests

Keep PRs focused, describe the change and how you verified it, and make sure
`npm test` passes. By contributing you agree your work is licensed under the
project's [PolyForm Noncommercial License 1.0.0](LICENSE).
