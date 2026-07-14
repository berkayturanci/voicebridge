# voicebridge — desktop app (Electron)

A small **Mac / Windows / Linux** desktop app that runs the voicebridge Node
bridge for you — no terminal needed — with a control panel and a tray icon.

It's a thin shell: the bridge (`../server.js`) runs as a child process, and the
app gives it a first-run setup flow to choose the **project folder**, **agent
mode**, generated **access token**, **port / host**, and optional public/mobile
URL. After setup, the control panel can **start/stop**, **open the web UI** in
your browser, show a scannable QR for the mobile URL, copy a versioned pairing
payload, see the phone's last-seen status, watch the **live log**, and see a
small **dashboard** of the agents (with availability) and the active sessions,
refreshed live.

The network panel detects basic Tailscale status, prepares a copyable
`tailscale serve --bg <port>` command, and verifies the configured public URL's
`/api/health` endpoint. It does not run Tailscale commands automatically.

Startup is preflighted before the bridge process launches: the app validates the
project folder, selected agent CLI, and port availability, then waits for
`/api/health` so failures show as actionable diagnostics instead of a silent
stopped state.

## Download the Mac build

The current unsigned Apple Silicon DMG is attached to the `v0.8.0` release:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/voicebridge-0.2.0-arm64.dmg

macOS may warn because this build is not signed or notarized yet. Open it from
Finder with **Right click → Open** the first time. For the step-by-step setup,
see [docs/mac-desktop-host.md](../docs/mac-desktop-host.md).

## Run in development

```bash
cd desktop
npm install
npm start            # launches Electron, auto-starts the bridge
```

The bridge is loaded from `../server.js`, so it uses the exact code in this repo.

## Build installers

```bash
cd desktop
npm install
npm run icons        # (re)generate app icons from the brand glyph
npm run dist         # current OS
npm run dist:mac     # .dmg   (build on macOS)
npm run dist:win     # .exe   (NSIS installer; build on Windows)
npm run dist:linux   # AppImage
```

Output lands in `desktop/dist/`. `electron-builder` bundles `server.js` and
`public/` into the app's resources (`resources/bridge/`), so the installed app
is self-contained — it does **not** need Node installed on the target machine
(it runs the bridge via Electron's bundled Node, `ELECTRON_RUN_AS_NODE=1`).

> Cross-compiling has limits: build the `.dmg` on macOS and the Windows
> installer on Windows for signed, working results.

## Notes

- The app keeps running in the tray when you close the window; quit from the
  tray menu (which also stops the bridge).
- Non-secret settings are stored in the OS user-data dir (`settings.json`). The
  desktop app generates an access token automatically and stores it with
  Electron `safeStorage` (`macOS Keychain` on Mac). If OS secure storage is not
  available, it falls back to `settings.json` so development builds still work.
- The agent CLIs (Claude Code, Codex, …) still need to be installed and
  authenticated on the machine — the desktop app runs the bridge, not the agents.
- For phone access over HTTPS, run `tailscale serve --bg <port>` and point the
  phone (PWA or the Flutter app) at the Tailscale URL.
