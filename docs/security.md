# Security

voicebridge lets a phone drive a coding agent on your computer. That is powerful,
so understand the trust boundaries before exposing it.

## Threat model

- **Network**: the bridge binds to `127.0.0.1` by default and is meant to be
  reached only through your **Tailscale** tailnet, which provides the private
  route and the HTTPS certificate. It is never meant to face the public internet.
- **Who can drive it**: anyone who can reach the URL *and* satisfy the access
  token (if set) can run the agent in a session's project directory — and can
  create new sessions pointing at **other** directories on the machine. Treat
  access to the bridge as access to a shell in those directories.
- **The agent**: the agent edits files and can run commands subject to its
  **mode** (see below). voicebridge does not sandbox the agent itself.

## Access token

Set `ACCESS_TOKEN` to require `Authorization: Bearer <token>` on protected
`/api/*` routes. `/api/health`, `/api/push/key`, and the public bootstrap
subset of `/api/config` remain available before authentication:

```bash
export ACCESS_TOKEN="$(openssl rand -hex 16)"
```

- The check is constant-time (`crypto.timingSafeEqual`).
- The web client stores the token in `localStorage` and prompts for it once.
- When `PUBLIC_URL`/`ACCESS_TOKEN` are set, the startup QR encodes `?token=…`;
  scanning it authorizes the phone, and the client immediately scrubs the token
  from the address bar. Anyone who can see that QR (or the URL) gets in — treat
  it like a password.

## Autonomy modes

Modes map to the agent's own approval/sandbox flags:

- **Read-only / ask** modes keep the agent from making changes without
  confirmation. Prefer these on unfamiliar or important repositories.
- **Full-auto** modes (`--dangerously-skip-permissions`,
  `-s workspace-write -c approval_policy="never"`,
  `--dangerously-bypass-approvals-and-sandbox`) let the agent edit
  files and run commands **without prompting**. Convenient when you are away
  from the keyboard, dangerous everywhere else. Use them only on trusted
  projects, over your private tailnet, ideally with a token.

## Speech privacy

- iOS speech **recognition** sends audio to Apple for transcription (free, not
  local). For fully-local transcription use `STT_MODE=whisper` with your own
  Whisper command — audio then never leaves your machine.
- Speech **synthesis** (the spoken replies) is entirely on-device.

## Injection safety

Prompts are passed to Claude as a separate argv element (no shell) and to Codex
and Antigravity on stdin — never interpolated into a shell command. The whisper
`STT_CMD` is operator-provided and runs via `/bin/sh`; only configure it with
commands you trust.

## Built-in limits & hardening

- **Security headers** on every response: a same-origin `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`.
- **Exposure warning**: starting on a non-loopback address without `ACCESS_TOKEN`
  prints a prominent warning.
- **Resource caps**: `MAX_SESSIONS` (default 200), a cap on stored push
  subscriptions, and `MAX_INFLIGHT` (default 8) concurrent agent turns — past
  which `/api/ask` returns `429` — so an authenticated client can't exhaust the
  host.
- **Robust parsing**: request bodies are size-limited; malformed URLs and JSON
  return `4xx` (never crash); every handler is wrapped so a synchronous error
  can't take the process down.
- **Injection-safe**: prompts go to agents as a separate argv element (Claude) or
  on stdin (Codex/Antigravity/Ollama) — never through a shell.
- **Push**: only `https` subscription endpoints are accepted.
- **Static files**: requests are confined to `public/` — the resolved path must
  sit under it (separator-aware, so a sibling like `public-x` can't be reached),
  and traversal attempts return `403`/`404` without leaking source.
- **Token comparison** is constant-time (`crypto.timingSafeEqual`).

## Public Endpoints

When `ACCESS_TOKEN` is set, these `/api/*` endpoints are intentionally public:

- `GET /api/health`: liveness/readiness only (`ok`, version, uptime, session
  count).
- `GET /api/push/key`: whether Web Push is enabled and the VAPID public key.
- `GET /api/config`: public client bootstrap data only: STT mode, whether auth
  is required, available agents/modes, and runner types.

Authenticated `GET /api/config` additionally returns convenience fields that may
contain host-local paths or session ids: `defaultProjectDir`,
`defaultSessionId`, and `favorites`. These are intentionally omitted from the
unauthenticated response.

## Audit notes (trust model)

- `/api/*` (except the public endpoints listed above) require the access token
  when `ACCESS_TOKEN` is set; **set a token whenever the bridge is reachable
  beyond loopback.** A holder of the token is trusted — they can drive the agent,
  and `/api/browse` lists directory **names** anywhere readable by the server
  process (a folder picker; it does not read file contents).
- The page ships inline scripts, so the CSP allows `script-src 'unsafe-inline'`.
  This is low-risk here because replies are rendered as DOM nodes (never
  `innerHTML` with model/user text) and `connect-src` is `'self'`, so an injected
  string has no HTML sink and nowhere to exfiltrate to.
- Whisper STT runs the operator-provided `STT_CMD` via a shell with a
  server-generated temp path — the template and path are operator/server
  controlled, not client input.

## Reporting

Found a vulnerability? Please open a private report via the repository's
**Security** tab (Report a vulnerability) rather than a public issue.
