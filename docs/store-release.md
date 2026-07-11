# Store Release Readiness

VoiceBridge can become a native App Store / Google Play app, but the repository
is not yet store-submission ready. The committed Flutter app is source-first:
`app/tool/setup.sh` generates the iOS and Android projects locally, then injects
microphone and speech permissions. Store releases need those platform projects,
signing, privacy metadata, and repeatable build jobs.

## Current Status

- Web/PWA and Node bridge releases are production-shaped.
- Flutter client source is present in `app/lib/` and has CI-backed unit coverage.
- Native platform scaffolds (`app/ios/`, `app/android/`) are generated locally,
  not committed.
- No App Store Connect or Play Console metadata, screenshots, signing setup, or
  release build workflow is committed yet.

## Required Before App Store

1. Decide whether to commit generated `app/ios/` and `app/android/`.
   Store builds are easier to audit and reproduce when native project files are
   versioned.
2. Choose final identifiers:
   - iOS bundle ID, for example `com.berkayturanci.voicebridge`.
   - Android application ID, for example `com.berkayturanci.voicebridge`.
3. Add native permission strings:
   - iOS: microphone and speech recognition usage descriptions.
   - Android: `RECORD_AUDIO` plus any platform-specific network settings needed
     for HTTPS-only bridge URLs.
4. Prepare privacy disclosures:
   - Apple App Privacy answers in App Store Connect.
   - Google Play Data safety form.
   - Public privacy policy URL.
5. Prepare store assets:
   - app icon from `branding/` / `app/assets/icon/`.
   - iPhone/iPad screenshots.
   - Android phone screenshots.
   - short and long descriptions.
6. Add release build workflows:
   - Android AAB build with signing injected from CI secrets.
   - iOS archive/export path, or documented local Fastlane/Xcode release steps.
7. Run beta tracks before production:
   - TestFlight for iOS.
   - Internal testing / closed testing for Google Play.

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

1. Commit generated Flutter iOS/Android platform projects with stable app IDs.
2. Add store privacy policy and in-app privacy/about screen links.
3. Add Android signed AAB release workflow.
4. Add iOS release/archive documentation or Fastlane workflow.
5. Add screenshot capture guide and store listing copy.
6. Run TestFlight and Google Play internal testing.

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
```
