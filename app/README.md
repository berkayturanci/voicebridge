# voicebridge — native app (Flutter)

A native **iOS / Android** client for voicebridge. The Node bridge (`../server.js`)
is the backend; this app is just a native front-end that talks to its HTTP API,
so **native microphone speech recognition and TTS work even as an installed app**
(unlike the PWA, where iOS blocks the mic outside a Safari tab).

First-stage features:

- **Session list** — your conversations, with agent · mode · runner; tap to open,
  swipe to delete, ＋ to create.
- **Streaming chat** — replies stream in token-by-token; tool use shows as a
  subtle activity line (same NDJSON protocol as the web UI).
- **Voice** — 🎤 push-to-talk (native `speech_to_text`) and a **talking mode**
  (📞): it listens, auto-sends on a pause, reads the reply aloud
  (`flutter_tts`), then listens again.
- **Bridge settings** — point it at your machine's URL (a Tailscale HTTPS URL is
  ideal) and an optional access token, stored on the device.

> The PWA still works too — install the web app from Safari for a zero-extra-step
> option. This native app is the path when you want reliable voice as an
> installed app.

## Prerequisites

- A running voicebridge bridge reachable from the phone — ideally over HTTPS via
  Tailscale: on the computer, `tailscale serve --bg 8787`.
- [Flutter](https://docs.flutter.dev/get-started/install) (stable). For iOS you
  also need **macOS + Xcode** and (for a real device / the App Store) an Apple
  Developer account.

## Build & run

This folder ships the Dart sources (`lib/`), `pubspec.yaml`, and the committed
iOS/Android platform projects used for store builds. Refresh native permissions
and fetch packages, then run:

```bash
cd app
bash tool/setup.sh                # refreshes ios/android permissions + pub get
dart run flutter_launcher_icons   # apply the voicebridge app icon (from assets/icon/)
flutter run                       # on a connected device/simulator
flutter run -d macos        # …or a desktop target: macos | windows | linux
```

`tool/setup.sh` runs `flutter create .` only if `ios/` or `android/` is missing,
then adds the native permission keys for you, idempotently. Prefer doing it by
hand? The manual equivalents are below.

The same codebase is a **desktop client** too (macOS / Windows / Linux) — a
"connect-from" app for your laptop. Chat + streaming work everywhere; voice
support depends on the platform plugins (see Desktop notes below).

### iOS permissions (required for voice)

After `flutter create .`, add these keys to `ios/Runner/Info.plist` so the OS
allows the mic and speech recognition:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>The microphone is used to give voice commands.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Used to transcribe what you say.</string>
```

Minimum iOS deployment target **12.0+** (set in `ios/Podfile` /
`ios/Runner.xcodeproj`).

### Android permissions

`flutter create .` adds internet access by default. For the mic, add to
`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

### Desktop (macOS / Windows / Linux)

The app runs on the desktop from the same code. Caveats:

- **macOS networking** — the macOS app is sandboxed, so it **can't reach the
  bridge** until you add the network-client entitlement. In
  `macos/Runner/DebugProfile.entitlements` **and** `Release.entitlements` add:

  ```xml
  <key>com.apple.security.network.client</key>
  <true/>
  ```

  For the mic, also add `com.apple.security.device.audio-input` and an
  `NSMicrophoneUsageDescription` to `macos/Runner/Info.plist`.
- **Voice support** — `flutter_tts` (read replies aloud) works on macOS, Windows
  and Linux. Native speech-to-text (`speech_to_text`) is solid on macOS but
  **limited/absent on Windows & Linux**; there the app degrades to a text client
  (the mic button just shows a "not available" toast). Talking mode is best on
  mobile + macOS.

## First launch

1. Enter the **bridge URL** (e.g. `https://mac.tail-xxxx.ts.net`) and token.
2. "Test & Save" verifies it can reach `/api/config`.
3. You land on the session list — open one and talk.

## Notes

- **Transcripts persist** on-device per session (`shared_preferences`), restored
  when you reopen a chat.
- **Command palette** (⚡ in the chat app bar) lists the project's
  `.claude/commands` + npm scripts and prefills the composer.
- **Folder browser** — the new-session sheet has a "Project folder" picker backed
  by `/api/browse`.
- CI runs `flutter analyze` and `flutter test` against the Dart client. Store
  builds still need final store metadata and iOS release automation; Android
  signed AAB release steps are documented in
  [../docs/android-release.md](../docs/android-release.md). See also
  [../docs/store-release.md](../docs/store-release.md) and
  [../docs/store-listing.md](../docs/store-listing.md).
