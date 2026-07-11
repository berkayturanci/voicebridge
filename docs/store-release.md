# Store Release Readiness

VoiceBridge can become a native App Store / Google Play app, but the repository
is not yet store-submission ready. The committed Flutter app now includes the
iOS and Android platform projects. Store releases still need signing, final
privacy metadata, and repeatable release build jobs.

## Current Status

- Web/PWA and Node bridge releases are production-shaped.
- Flutter client source is present in `app/lib/` and has CI-backed unit coverage.
- Native mobile platform scaffolds (`app/ios/`, `app/android/`) are committed
  with stable app identifiers.
- Android signed AAB release automation is documented and available through the
  manual `Android Release` workflow.
- iOS no-codesign release builds are verified on macOS, and the TestFlight
  archive path is documented in [ios-release.md](ios-release.md).
- Flutter plugin release-compatibility warnings are documented in
  [flutter-plugin-compatibility.md](flutter-plugin-compatibility.md). Direct
  dependencies are currently up-to-date, so the remaining warnings are upstream
  migration items to recheck before Flutter upgrades.
- No App Store Connect metadata or submitted store screenshots are committed
  yet.

## Required Before App Store

1. Verify final identifiers:
   - iOS bundle ID: `com.berkayturanci.voicebridge`.
   - Android application ID: `com.berkayturanci.voicebridge`.
2. Add native permission strings:
   - iOS: microphone and speech recognition usage descriptions.
   - Android: `RECORD_AUDIO` plus any platform-specific network settings needed
     for HTTPS-only bridge URLs.
3. Prepare privacy disclosures:
   - Apple App Privacy answers in App Store Connect.
   - Google Play Data safety form.
   - Public privacy policy URL.
   - Draft answers live in [store-privacy-disclosures.md](store-privacy-disclosures.md).
4. Prepare store assets:
   - app icon from `branding/` / `app/assets/icon/`.
   - iPhone/iPad screenshots.
   - Android phone screenshots.
   - short and long descriptions.
   - Draft copy and beta checklist live in [store-listing.md](store-listing.md).
5. Add release build workflows:
   - Android AAB build with signing injected from CI secrets; see
     [android-release.md](android-release.md).
   - iOS no-codesign CI plus documented Xcode archive/export steps; see
     [ios-release.md](ios-release.md).
6. Run beta tracks before production:
   - TestFlight for iOS.
   - Internal testing / closed testing for Google Play.
7. Recheck plugin compatibility warnings before changing Flutter stable versions;
   see [flutter-plugin-compatibility.md](flutter-plugin-compatibility.md).

## Policy Notes To Keep Current

- Apple requires privacy details so users can understand what data the app and
  third-party partners collect. Even non-advertising collection has to be
  declared in App Store Connect.
- Apple requires a privacy policy URL for iOS and macOS apps in App Store
  Connect.
- Google Play requires the Data safety form for apps, including whether data is
  collected, shared, and protected.
- Google Play requires new apps and updates to target Android 15 / API level 35
  or higher for standard Android phone apps.

Official references:

- Apple App Review Guidelines:
  <https://developer.apple.com/app-store/review/guidelines/>
- Apple App Privacy Details:
  <https://developer.apple.com/app-store/app-privacy-details/>
- Apple App Store Connect privacy policy URL requirement:
  <https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>
- Google Play target API level requirement:
  <https://developer.android.com/google/play/requirements/target-sdk>
- Google Play Data safety section:
  <https://support.google.com/googleplay/android-developer/answer/10787469>

## Suggested First Store Milestone

Create a new milestone: `Store readiness`.

Recommended issue order:

1. Add Android signed AAB release workflow.
2. Add iOS release/archive documentation or Fastlane workflow.
3. Run TestFlight and Google Play internal testing.

## Testing Gate For Store Work

Every store-readiness PR should pass:

```bash
npm ci
npm run lint
npm test
npm run smoke

cd app
flutter pub get
flutter analyze --no-fatal-infos --no-fatal-warnings
flutter test
flutter build appbundle --release
flutter build ios --release --no-codesign # macOS/Xcode only
flutter pub outdated
```
