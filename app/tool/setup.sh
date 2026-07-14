#!/usr/bin/env bash
# One-command setup for the voicebridge Flutter app.
#
# `flutter create` generates the ios/ and android/ projects (which aren't
# committed — they're version-specific platform scaffolding), so the native
# permission keys can't live in the repo. This script generates them and then
# injects the mic/speech/camera permissions idempotently, so a fresh clone is ready to
# `flutter run` without hand-editing Info.plist / AndroidManifest.xml.
#
# Usage:  cd app && bash tool/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # -> app/

echo "▶ Generating platform projects (ios/ android/ …) if missing…"
if [ ! -d ios ] || [ ! -d android ]; then
  flutter create .
fi
flutter pub get
dart run flutter_launcher_icons

# --- iOS: microphone + speech recognition + camera usage descriptions ---
PLIST="ios/Runner/Info.plist"
if [ -f "$PLIST" ]; then
  if ! grep -q "NSMicrophoneUsageDescription" "$PLIST"; then
    /usr/libexec/PlistBuddy -c \
      "Add :NSMicrophoneUsageDescription string The microphone is used for voice commands." "$PLIST"
    /usr/libexec/PlistBuddy -c \
      "Add :NSSpeechRecognitionUsageDescription string Used to transcribe what you say." "$PLIST"
    echo "✓ iOS: added NSMicrophoneUsageDescription + NSSpeechRecognitionUsageDescription"
  else
    echo "• iOS: mic/speech permissions already present"
  fi
  if ! grep -q "NSCameraUsageDescription" "$PLIST"; then
    /usr/libexec/PlistBuddy -c \
      "Add :NSCameraUsageDescription string The camera is used to scan VoiceBridge pairing QR codes." "$PLIST"
    echo "✓ iOS: added NSCameraUsageDescription"
  else
    echo "• iOS: camera permission already present"
  fi
fi

# --- Android: RECORD_AUDIO + CAMERA ---
MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  if ! grep -q "android.permission.RECORD_AUDIO" "$MANIFEST"; then
    perl -0pi -e \
      's/(<manifest\b[^>]*>)/$1\n    <uses-permission android:name="android.permission.RECORD_AUDIO" \/>/' \
      "$MANIFEST"
    echo "✓ Android: added RECORD_AUDIO permission"
  else
    echo "• Android: RECORD_AUDIO already present"
  fi
  if ! grep -q "android.permission.CAMERA" "$MANIFEST"; then
    perl -0pi -e \
      's/(<manifest\b[^>]*>)/$1\n    <uses-permission android:name="android.permission.CAMERA" \/>\n    <uses-feature android:name="android.hardware.camera" android:required="false" \/>/' \
      "$MANIFEST"
    echo "✓ Android: added CAMERA permission"
  else
    echo "• Android: CAMERA already present"
  fi
fi

echo
echo "✅ Setup complete. Connect a device and run:  flutter run"
