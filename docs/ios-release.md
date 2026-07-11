# iOS Release

Use this path to prepare TestFlight and App Store builds for VoiceBridge. The
iOS bundle ID is `com.berkayturanci.voicebridge`.

## Release Strategy

Start with Xcode and App Store Connect instead of adding Fastlane now. The
repository has a small release surface, and native Xcode tooling keeps signing,
archive validation, and TestFlight upload close to Apple's documented flow. Add
Fastlane later only if repeated manual archive/upload steps become a bottleneck.

## One-Time App Store Connect Setup

1. Create or verify the App Store Connect app record:
   - Bundle ID: `com.berkayturanci.voicebridge`.
   - SKU: `voicebridge`.
   - Platform: iOS.
2. In Apple Developer, enable the bundle ID for the capabilities the app needs.
   VoiceBridge currently needs microphone and speech recognition permission
   strings only; it does not require push, iCloud, or background modes.
3. In Xcode, open `app/ios/Runner.xcworkspace`, select the Runner target, and
   set the signing team for Release builds.
4. Keep `DEVELOPMENT_TEAM` empty in git unless the repository intentionally
   standardizes on one Apple team. Local Xcode settings can supply the team.
5. Complete App Privacy details in App Store Connect using
   [store-privacy-disclosures.md](store-privacy-disclosures.md).

## CI Build Verification

The `iOS Release` GitHub Actions workflow runs on macOS and executes:

```bash
cd app
flutter pub get
flutter build ios --release --no-codesign
```

This proves the committed iOS project, CocoaPods setup, Flutter sources, and
release configuration build on a clean macOS runner without requiring signing
certificates in pull requests.

## Local TestFlight Archive

Use a Mac with Xcode and an Apple Developer account:

```bash
cd app
flutter pub get
flutter build ios --release --no-codesign
open ios/Runner.xcworkspace
```

In Xcode:

1. Select a generic iOS device or "Any iOS Device".
2. Select `Product > Archive`.
3. In Organizer, validate the archive.
4. Distribute to App Store Connect and choose TestFlight first.

After App Store Connect finishes processing, add internal testers, run a
TestFlight smoke pass, then promote the same build to external beta or App Store
review.

## Command-Line Archive Option

After local signing is configured in Xcode, the archive can also be produced with
`xcodebuild`:

```bash
cd app/ios
xcodebuild archive \
  -workspace Runner.xcworkspace \
  -scheme Runner \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath ../build/ios/archive/VoiceBridge.xcarchive \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID \
  -allowProvisioningUpdates
```

Export an App Store Connect IPA with an `ExportOptions.plist` that uses
`method=app-store-connect`, then upload with Xcode Organizer, Transporter, or
Apple's command-line upload tooling.

## TestFlight Checklist

- Build number is higher than the previous App Store Connect upload.
- Bridge URL entry, token save, session list, chat streaming, push-to-talk, and
  talking mode are smoke-tested on a physical iPhone.
- Microphone and speech recognition permission prompts match the app behavior.
- Privacy policy URL and App Privacy answers are present in App Store Connect.
- Store screenshots and listing copy are attached before external beta review.

Official references:

- App Store Connect build upload:
  <https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/>
- App Store privacy details:
  <https://developer.apple.com/app-store/app-privacy-details/>
- App Store Review Guidelines:
  <https://developer.apple.com/app-store/review/guidelines/>
