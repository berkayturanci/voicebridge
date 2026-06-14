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

This folder ships the Dart sources (`lib/`) and `pubspec.yaml`. Generate the
platform projects, fetch packages, then run:

```bash
cd app
flutter create .            # generates ios/ and android/ (keeps lib/ + pubspec)
flutter pub get
flutter run                 # on a connected device/simulator
```

### iOS permissions (required for voice)

After `flutter create .`, add these keys to `ios/Runner/Info.plist` so the OS
allows the mic and speech recognition:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Sesli komut vermek için mikrofon kullanılır.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Konuştuklarınızı metne çevirmek için kullanılır.</string>
```

Minimum iOS deployment target **12.0+** (set in `ios/Podfile` /
`ios/Runner.xcodeproj`).

### Android permissions

`flutter create .` adds internet access by default. For the mic, add to
`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

## First launch

1. Enter the **bridge URL** (e.g. `https://mac.tail-xxxx.ts.net`) and token.
2. "Test et & Kaydet" verifies it can reach `/api/config`.
3. You land on the session list — open one and talk.

## Notes / not yet in stage 1

- Transcripts aren't persisted on-device yet (the list and live chat are; history
  across app restarts is a stage-2 item).
- Folder browser / command palette from the web UI aren't ported yet.
- Code is written against the bridge API but **hasn't been compiled in this
  repo's CI** (no Flutter toolchain here) — run `flutter analyze` locally.
