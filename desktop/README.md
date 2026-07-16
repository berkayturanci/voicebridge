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

The current Apple Silicon DMG is attached to the `v0.8.0` release:

https://github.com/berkayturanci/voicebridge/releases/download/v0.8.0/voicebridge-0.2.0-arm64.dmg

macOS may warn if a release is unsigned or development-signed. Open it from
Finder with **Right click → Open** the first time. Public release DMGs should be
Developer ID signed and notarized. For the step-by-step setup, see
[docs/mac-desktop-host.md](../docs/mac-desktop-host.md).

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
npm run dist:mac:preview   # ad-hoc signed preview .dmg for manual testing
npm run dist:mac:unsigned  # alias for dist:mac:preview
npm run dist:mac:signed    # Developer ID signed + notarized .dmg
npm run verify:mac:release # Gatekeeper + stapler verification
npm run dist:win     # .exe   (NSIS installer; build on Windows)
npm run dist:linux   # AppImage
```

Output lands in `desktop/dist/`. `electron-builder` bundles `server.js` and
`public/` into the app's resources (`resources/bridge/`), so the installed app
is self-contained — it does **not** need Node installed on the target machine
(it runs the bridge via Electron's bundled Node, `ELECTRON_RUN_AS_NODE=1`).

> Cross-compiling has limits: build the `.dmg` on macOS and the Windows
> installer on Windows for signed, working results.

## Mac preview builds

Use `npm run dist:mac:preview` when a Developer ID certificate is not available
yet. It builds the unpacked Apple Silicon app, applies an ad-hoc signature,
regenerates the DMG from that signed app, then mounts the DMG and verifies the
bundle layout, embedded bridge resources, DMG checksum, and code signature.

Preview DMGs are still not notarized, so macOS may require **Right click →
Open** on first launch. They are useful for internal testing, not final public
distribution.

## Mac release signing

`npm run dist:mac:signed` requires a **Developer ID Application** certificate in
Keychain and notarization credentials. It accepts any one of these credential
sets:

- App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`
- Apple ID app-specific password: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`
- Stored notarytool profile: `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`

The verification command mounts the generated DMG, checks the bundle resources,
verifies code signing, runs Gatekeeper assessment, and validates the stapled
notarization ticket for both the app and DMG.

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
