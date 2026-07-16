# Mac Desktop Host Setup

The Mac host app is the easiest way to run VoiceBridge without keeping a
terminal open. It starts the bridge, stores the pairing token, checks basic
health, and shows a QR code for the mobile app.

## Download

Download the current Apple Silicon DMG:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/voicebridge-0.2.0-arm64.dmg

If the release notes mark the build as unsigned or development-signed, macOS may
block the first launch. Open it from Finder with **Right click → Open**, then
confirm. Public releases should use a Developer ID signed and notarized DMG.

## Requirements

- macOS on Apple Silicon.
- Tailscale installed and signed in on the Mac and phone.
- At least one supported agent CLI installed and authenticated on the Mac:
  Claude Code, Codex, Antigravity, or Ollama.
- The project folder you want the agent to work in.

## First Run

1. Open **VoiceBridge** from the DMG.
2. Choose the project folder. This is the only workspace the host app passes to
   the bridge.
3. Pick the agent mode.
4. Keep the default local host and port unless you already use `8787`.
5. Paste your Tailscale HTTPS URL if you already have one.
6. Click **Save & start bridge**.

The app generates an access token automatically. On macOS it stores that token
with Electron `safeStorage`, backed by Keychain when available.

## Tailscale Serve

In the desktop app, open the **Network** panel and copy the suggested Tailscale
Serve command. It looks like this:

```bash
tailscale serve --bg 8787
```

Then set the **Mobile/public URL** to your Tailscale HTTPS URL, for example:

```text
https://your-mac.your-tailnet.ts.net
```

Use **Verify public URL** to confirm that `/api/health` is reachable from that
URL.

## Pair the Mobile App

1. Open the native iOS or Android app.
2. Tap **Scan QR** on the connection screen.
3. Scan the QR code shown in the Mac host app's **Pairing** panel.
4. Tap **Connect to PC**.

If camera scanning is not available, use **Copy pairing payload** in the Mac app
and **Paste code** in the mobile app.

## Notes

- The desktop host runs the bridge, not the agent. Agent CLIs still need to be
  installed and logged in separately.
- The app does not run Tailscale commands automatically; it prepares the command
  and verifies the configured URL.
- The tray menu can start, stop, restart, and quit the bridge.
- Regenerating the token invalidates existing mobile pairing details.

## Release Signing

For internal testing before Developer ID signing is available, build an ad-hoc
signed preview DMG:

```bash
cd desktop
npm run dist:mac:preview
```

The preview build mounts and checks the generated DMG, verifies the app's
ad-hoc code signature, and confirms that the bundled bridge files are present.
It is not notarized, so macOS may still require **Right click → Open**.

Release DMGs should be signed with a **Developer ID Application** certificate
and notarized by Apple. The repository has a guarded release path:

```bash
cd desktop
npm run dist:mac:signed
npm run verify:mac:release
```

`dist:mac:signed` fails early unless the Mac has a Developer ID Application
identity and one notarization credential profile:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or
- `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`.

`verify:mac:release` mounts the DMG and checks the bundle resources, code
signature, Gatekeeper assessment, and stapled notarization ticket.
