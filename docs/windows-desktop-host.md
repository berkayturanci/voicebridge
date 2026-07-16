# Windows Desktop Host Setup

The Windows host app runs the VoiceBridge bridge without keeping a terminal
open. It starts the bridge, stores the pairing token, checks health, and shows a
QR code for the mobile app.

## Download

Download the current Windows x64 preview installer:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/voicebridge-0.2.0-x64-setup.exe

Verify it against the published SHA256 checksums:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/checksums.txt

In PowerShell, run:

```powershell
Get-FileHash .\voicebridge-0.2.0-x64-setup.exe -Algorithm SHA256
```

Compare the `Hash` value with the `voicebridge-0.2.0-x64-setup.exe` line in
`checksums.txt`.

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
tailscale.exe serve --bg http://127.0.0.1:8787
```

Then set the **Mobile/public URL** to your Tailscale HTTPS URL, for example:

```text
https://your-pc.your-tailnet.ts.net
```

Use **Verify public URL** to confirm that the public `/api/health` endpoint is
reachable and that the token-protected mobile endpoint accepts the generated
access token. The Network panel reports missing Tailscale CLI, logged-out
Tailscale, missing public URL, DNS/network failures, HTTP status, timeouts, and
token mismatch separately.

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

## Troubleshooting

### Windows SmartScreen Blocks the Installer

The preview installer is not code-signed yet. SmartScreen can show a warning
even when the file matches the release checksum.

1. Download the installer only from the GitHub release link above.
2. Verify the SHA256 hash with `Get-FileHash`.
3. If the hash matches, click **More info** and **Run anyway**.

Do not run the installer if the hash differs from `checksums.txt`.

### Agent CLI Is Not Found

VoiceBridge starts the bridge, but the agent CLI still has to be installed,
authenticated, and visible on the Windows `PATH`.

Check the selected agent in PowerShell:

```powershell
where.exe claude
where.exe codex
where.exe agy
ollama --version
```

If a command is missing, install or repair that agent CLI, then fully quit
VoiceBridge from the tray and reopen it so the app sees the updated `PATH`.

### Tailscale Is Not Connected

The PC and phone must be signed in to the same tailnet. On the PC, check:

```powershell
tailscale status
```

If the command is missing, install Tailscale for Windows. If it shows that the
machine is not logged in, open the Tailscale app and sign in before verifying
the public URL in VoiceBridge.

### Public URL Verification Fails

Confirm that the bridge is running locally, then copy the command from the
desktop app's **Network** panel again. The default command is:

```powershell
tailscale.exe serve --bg http://127.0.0.1:8787
```

Then open the Tailscale HTTPS URL in the PC browser and confirm `/api/health`
responds:

```powershell
Invoke-WebRequest https://your-pc.your-tailnet.ts.net/api/health
```

If the phone cannot load the same URL, open the Tailscale app on the phone and
confirm it is connected to the same account.

### Windows Defender or Firewall Prompts

VoiceBridge is expected to listen on the local host and be reached through
Tailscale Serve. If Windows asks about network access, allow private-network
access only if you trust the local machine and tailnet. Do not expose the bridge
directly to the public internet.

### Port 8787 Is Already in Use

If the bridge cannot start because `8787` is busy, either close the process
using that port or choose a different port in VoiceBridge setup.

To inspect the port in PowerShell:

```powershell
netstat -ano | findstr :8787
```

If you change the port in VoiceBridge, copy the updated Tailscale Serve command
from the **Network** panel so Tailscale proxies to the same port.

### The App Keeps Running After Closing the Window

Closing the VoiceBridge window keeps the tray app alive so the bridge can keep
running. To stop it, open the tray menu and choose **Quit**. Quitting from the
tray also stops the bridge process.

## Notes

- The desktop host runs the bridge, not the agent. Agent CLIs still need to be
  installed and logged in separately.
- The app does not run Tailscale commands automatically; it prepares the command
  and verifies the configured URL.
- The tray menu can start, stop, restart, and quit the bridge.
- Regenerating the token invalidates existing mobile pairing details.
