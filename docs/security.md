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

Set `ACCESS_TOKEN` to require `Authorization: Bearer <token>` on every `/api/*`
route except the public `/api/config`:

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
- **Full-auto** modes (`--dangerously-skip-permissions`, `--full-auto`,
  `--dangerously-bypass-approvals-and-sandbox`, `--yolo`) let the agent edit
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

## Reporting

Found a vulnerability? Please open a private report via the repository's
**Security** tab (Report a vulnerability) rather than a public issue.
