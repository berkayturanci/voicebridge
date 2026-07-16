# Windows Desktop Host Setup

The Windows host app runs the VoiceBridge bridge without keeping a terminal
open. It starts the bridge, stores the pairing token, checks health, and shows a
QR code for the mobile app.

## Download

Download the current Windows x64 preview installer:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/voicebridge-0.2.0-x64-setup.exe

Verify it against the published SHA256 checksums:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/checksums.txt

Preview installers are unsigned, so Windows SmartScreen may warn on first
launch. Choose **More info** and **Run anyway** only if you trust the release
source.

## Requirements

- Windows 10 or Windows 11.
- Tailscale installed and signed in on the PC and phone.
- At least one supported agent CLI installed and authenticated on the PC:
  Claude Code, Codex, Antigravity, or Ollama.
- The project folder you want the agent to work in.

## First Run

1. Install and open **VoiceBridge**.
2. Choose the project folder. This is the only workspace the host app passes to
   the bridge.
3. Pick the agent mode.
4. Keep the default local host and port unless you already use `8787`.
5. Paste your Tailscale HTTPS URL if you already have one.
6. Click **Save & start bridge**.

The app generates an access token automatically and stores it with Electron
`safeStorage` when OS secure storage is available.

## Tailscale Serve

In the desktop app, open the **Network** panel and copy the suggested Tailscale
Serve command. It looks like this:

```powershell
tailscale serve --bg 8787
```

Then set the **Mobile/public URL** to your Tailscale HTTPS URL, for example:

```text
https://your-pc.your-tailnet.ts.net
```

Use **Verify public URL** to confirm that `/api/health` is reachable from that
URL.

## Pair the Mobile App

1. Open the native iOS or Android app.
2. Tap **Scan QR** on the connection screen.
3. Scan the QR code shown in the Windows host app's **Pairing** panel.
4. Tap **Connect to PC**.

If camera scanning is not available, use **Copy pairing payload** in the Windows
app and **Paste code** in the mobile app.

## Build Locally

Build the Windows preview installer on Windows:

```powershell
cd desktop
npm install
npm run dist:win:dir
npm run verify:win:dir
npm run dist:win:preview
```

The verifier checks the unpacked app executable and confirms that the bundled
bridge server and public assets are present before the installer build.

## Notes

- The desktop host runs the bridge, not the agent. Agent CLIs still need to be
  installed and logged in separately.
- The app does not run Tailscale commands automatically; it prepares the command
  and verifies the configured URL.
- The tray menu can start, stop, restart, and quit the bridge.
- Regenerating the token invalidates existing mobile pairing details.
