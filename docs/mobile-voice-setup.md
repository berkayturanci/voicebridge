# Mobile voice setup (HTTPS over Tailscale)

This is the end-to-end recipe for getting the **microphone / "speak" button to
work on your phone**. If the mic button is greyed out on mobile, you are in the
right place — read [Why HTTPS is required](#why-https-is-required) first, then
follow the steps.

> TL;DR — the browser only exposes the Web Speech API on a **secure origin**
> (HTTPS, or `localhost`). Over plain `http://<lan-ip>:8787` the phone's browser
> silently disables speech recognition, so voicebridge disables the mic button.
> The fix is to reach the bridge over **HTTPS**, which Tailscale provides for
> free with a real certificate.

---

## Why HTTPS is required

The mic uses the browser's **Web Speech API** (`SpeechRecognition` /
`webkitSpeechRecognition`). Browsers only make that API available in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):

| Origin | Secure context? | Mic button |
|--------|-----------------|------------|
| `http://localhost:8787` (desktop, same machine) | ✅ yes (localhost is exempt) | works |
| `http://192.168.1.x:8787` (phone over LAN) | ❌ no | **disabled** |
| `https://<machine>.<tailnet>.ts.net` (Tailscale) | ✅ yes (real cert) | works |

So voicebridge works out of the box on your desktop at `localhost`, but a phone
reaching it by LAN IP gets no microphone. voicebridge detects the missing API
and disables the button on purpose (see the check in
[`public/index.html`](../public/index.html) — `CONFIG.sttMode === "browser" && !SR`),
showing the status *"This browser doesn't support voice input."*

The cleanest fix is a real HTTPS URL, and the cheapest way to get one for a
machine on your desk is **Tailscale Serve**.

```
[ iPhone / Safari ]                         [ your Mac ]
  mic ─Web Speech STT─▶ text ──HTTPS (Tailscale)──▶ voicebridge ──▶ claude / codex / agy
  speaker ◀─speechSynthesis── reply  ◀──────────────  reply  ◀────  (coding agent CLI)
```

---

## Prerequisites

- **Tailscale** installed and logged in on **both** the computer and the phone,
  on the **same account** (App Store / Play Store app on the phone). Free.
- The voicebridge server installed (`npm install`) and able to start
  (`npm start`). See the [README](../README.md#setup).
- A coding-agent CLI on the computer (e.g. `claude`, logged in).

---

## Step 1 — Start the bridge with an access token

Because the bridge will be reachable by anything on your tailnet, protect it with
a token. Keep the bind address local (`127.0.0.1`); Tailscale Serve proxies to it.

```bash
export ACCESS_TOKEN="$(openssl rand -hex 16)"
echo "$ACCESS_TOKEN"                 # you'll add this to the phone URL below
PROJECT_DIR="$HOME/code/my-project" npm start
```

The server prints a QR code on startup. We'll regenerate a better one (with the
HTTPS URL) after Tailscale is wired up, so you can ignore the first QR for now.

> Binding to `0.0.0.0` (all interfaces) **without** a token makes anyone on your
> Wi-Fi able to drive an agent on your machine — the bridge prints a warning if
> you do this. Prefer `127.0.0.1` + Tailscale + `ACCESS_TOKEN`.

## Step 2 — Bring Tailscale up

```bash
tailscale up
```

If your machine is also a **subnet router / exit node**, `tailscale up` will
refuse unless you repeat your existing flags — restate them so you don't wipe
your config. For example:

```bash
tailscale up --accept-routes --advertise-routes=192.168.1.0/24
```

Check it's connected and note your machine's tailnet name:

```bash
tailscale status
tailscale status --json | grep -m1 DNSName     # e.g. your-machine.tailXXXX.ts.net
```

## Step 3 — Enable "Serve" on your tailnet (one-time)

The first time you use `tailscale serve`, the feature may be disabled for your
tailnet. You'll see:

```
Serve is not enabled on your tailnet.
To enable, visit: https://login.tailscale.com/f/serve?node=...
```

Open that link (it's printed with your own node id) and toggle the feature on in
the Tailscale admin console. This also enables HTTPS certificate provisioning.
You only do this once per tailnet.

## Step 4 — Publish the bridge over HTTPS

```bash
tailscale serve --bg --https=443 localhost:8787
tailscale serve status
```

`tailscale serve status` prints the public-on-your-tailnet URL:

```
https://your-machine.tailXXXX.ts.net (tailnet only)
|-- / proxy http://localhost:8787
```

The first request may take a few seconds while Tailscale provisions the TLS
certificate.

## Step 5 — Build the phone URL (with the token) and a QR

The page reads the token from a `?token=` query parameter and stores it, so you
can bake it straight into the URL:

```bash
URL="https://your-machine.tailXXXX.ts.net/?token=$ACCESS_TOKEN"
echo "$URL"

# Print a scannable QR in the terminal (uses the bundled dependency):
node -e 'require("qrcode-terminal").generate(process.argv[1])' "$URL"

# …or save a PNG you can text to yourself:
npx --yes qrcode "$URL" -o /tmp/voicebridge-qr.png
```

## Step 6 — On your phone

1. Make sure the **Tailscale app is connected** (same account).
2. Scan the QR, or open the `https://…ts.net/?token=…` URL.
   On **iOS use the Safari tab** — do *not* "Add to Home Screen", because
   installed PWAs can't use the microphone on iOS.
3. Tap the 🎤 button → **allow** the microphone → speak.
4. Toggle **Eller serbest / Hands-free** for a continuous back-and-forth.

---

## Verify the whole chain

From the computer (which is on the tailnet too), confirm HTTPS + the token gate:

```bash
# No token → 401:
curl -s -o /dev/null -w '%{http_code}\n' https://your-machine.tailXXXX.ts.net/api/sessions
# With token → 200:
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://your-machine.tailXXXX.ts.net/api/sessions
```

`401` then `200` means the HTTPS proxy and the auth gate both work; the phone
will behave the same.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| Mic button is **greyed out / disabled** on the phone | You're on a non-HTTPS origin (e.g. `http://<lan-ip>`). Open the `https://…ts.net` URL instead. |
| `Serve is not enabled on your tailnet` | One-time admin toggle — open the printed `login.tailscale.com/f/serve?node=…` link and enable Serve (Step 3). |
| `tailscale serve status` says **No serve config** | The `serve` command didn't apply (often because Serve isn't enabled yet). Re-run Step 4 after Step 3. |
| Phone can't load the `.ts.net` URL | Tailscale isn't connected on the phone, or it's signed into a different account. Open the Tailscale app and connect. |
| First load hangs for a few seconds | Tailscale is issuing the TLS cert on first request. It's cached after that. |
| `401` / the page keeps asking for a token | `ACCESS_TOKEN` is set; open the URL **with** `?token=…`, or paste the token once when prompted. |
| `tailscale up` errors about flags | Your machine has non-default Tailscale settings (subnet router/exit node). Restate them, e.g. `--accept-routes --advertise-routes=…` (Step 2). |
| Mic works but replies don't speak | Tap the screen once (browsers need a user gesture to start audio), and check the voice/rate options in the footer. |

---

## Restarting later

Both pieces stop when the Mac sleeps or reboots. To bring it back:

```bash
ACCESS_TOKEN=… PROJECT_DIR=… npm start          # terminal 1 (the bridge)
tailscale serve --bg --https=443 localhost:8787  # once per boot (config is remembered)
```

`tailscale serve` configuration persists across reboots, so usually you only
need to restart `npm start` and re-open the URL.

To tear the HTTPS proxy down entirely:

```bash
tailscale serve --https=443 off
```

---

## Alternatives to Tailscale

- **Type instead of speak (no setup):** over plain LAN HTTP the text box still
  works — you just don't get the mic. Open `http://<lan-ip>:8787` and type.
- **Self-signed certificate on the LAN:** works without Tailscale but the phone
  must manually trust the cert (painful on iOS). Tools like
  [`mkcert`](https://github.com/FiloSottile/mkcert) generate a local CA.
- **A tunnel** such as `cloudflared` or `ngrok` gives a public HTTPS URL, but it
  exposes the bridge to the internet — set `ACCESS_TOKEN` and prefer Tailscale's
  private tailnet.
- **Fully-local STT (Whisper):** removes the browser-speech dependency for
  transcription; see [configuration.md](configuration.md). Batch `whisper` mode
  records then transcribes, while `whisper-stream` streams mic chunks through the
  bridge to a local WebSocket transcriber and supports hands-free talking mode.
  You still want HTTPS for a good mobile experience, because both modes use
  `getUserMedia`, which is also gated on a secure context.

See also: [security.md](security.md) for the threat model and the access-token
design.
