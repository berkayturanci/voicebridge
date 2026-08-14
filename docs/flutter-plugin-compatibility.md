# Flutter Plugin Compatibility

Flutter 3.44 release builds pass for VoiceBridge, but Flutter emits
future-compatibility warnings for a few mobile plugins. This document keeps the
warnings visible so store releases are not surprised by a future Flutter toolchain
change.

## Current Status

`flutter pub outdated` reports all direct dependencies as up-to-date. The
warnings are therefore not fixable by a normal dependency upgrade at this time.

Known warnings:

- Android release builds warn that `flutter_tts`, `mobile_scanner`,
  `speech_to_text`, and `wakelock_plus` apply the Kotlin Gradle Plugin
  directly. Flutter says this will become a build failure in a future release
  unless the plugins migrate to Built-in Kotlin.
- iOS release builds warn that `flutter_tts` does not support Swift Package
  Manager for iOS. Flutter says this will become a build failure in a future
  release unless the plugin adds support.

## Release Policy

- Keep the app on Flutter stable and rerun Android/iOS release builds before
  every store submission.
- Before upgrading Flutter, rerun:

  ```bash
  cd app
  flutter pub outdated
  flutter build appbundle --release
  flutter build ios --release --no-codesign
  ```

- If a future Flutter stable release turns either warning into a failure, first
  check for newer plugin releases. If none exist, hold the Flutter upgrade and
  track the upstream plugin migration.

## Verification Snapshot

Last checked during store-readiness work:

- `speech_to_text` direct dependency: up-to-date at `7.4.0`.
- `flutter_tts` direct dependency: up-to-date at `4.2.5`.
- `mobile_scanner` direct dependency: up-to-date at `7.2.0`.
- `wakelock_plus` direct dependency resolves to `1.6.1`, with the direct
  constraint `^1.2.5`, and is up-to-date under the current dependency graph.
