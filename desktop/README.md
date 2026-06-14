# voicebridge — desktop app (Electron)

A small **Mac / Windows / Linux** desktop app that runs the voicebridge Node
bridge for you — no terminal needed — with a control panel and a tray icon.

It's a thin shell: the bridge (`../server.js`) runs as a child process, and the
app gives it a UI to **start/stop**, set the **port / host / access token**,
**open the web UI** in your browser, watch the **live log** (the phone QR code
the bridge prints shows up there too), and see a small **dashboard** of the
agents (with availability) and the active sessions, refreshed live.

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
- Settings are stored in the OS user-data dir (`settings.json`).
- The agent CLIs (Claude Code, Codex, …) still need to be installed and
  authenticated on the machine — the desktop app runs the bridge, not the agents.
- For phone access over HTTPS, run `tailscale serve --bg <port>` and point the
  phone (PWA or the Flutter app) at the Tailscale URL.
