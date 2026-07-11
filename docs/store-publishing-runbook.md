# Store Publishing Runbook

This is the operational path from a green `main` branch to TestFlight, Google
Play internal testing, and the first production submission. Keep this document
as the release checklist; platform-specific build details live in
[android-release.md](android-release.md) and [ios-release.md](ios-release.md).

## Release Owners

- Release captain: decides the version, creates the store release, and owns the
  final go/no-go.
- Apple operator: has App Store Connect access with Account Holder, Admin, or
  App Manager permissions.
- Google Play operator: has Play Console access with release and app-content
  permissions.
- Tester lead: coordinates physical-device smoke testing before production.

## Release Preconditions

1. `main` is green in CI.
2. No open release-blocking issues or PRs.
3. Public privacy policy URL is live.
4. Store listing copy and screenshots are ready; see
   [store-listing.md](store-listing.md).
5. Privacy answers match the app behavior; see
   [store-privacy-disclosures.md](store-privacy-disclosures.md).
6. Plugin compatibility warnings are reviewed before Flutter upgrades; see
   [flutter-plugin-compatibility.md](flutter-plugin-compatibility.md).

## Versioning Rule

- Public version: use semantic versions, for example `0.6.1`.
- Android `version_code`: monotonically increases for every Play upload.
- iOS build number: monotonically increases for every App Store Connect upload.
- Tag after both beta tracks accept the build, not before:

```bash
git tag v0.6.1
git push origin v0.6.1
```

## Google Play One-Time Setup

1. Create or verify the Play Console developer account.
2. Create the app in Play Console:
   - App name: `VoiceBridge`.
   - Default language: match the first store listing language.
   - App type: app.
   - Free or paid: choose before production, because this is hard to reverse.
3. Confirm package name: `com.berkayturanci.voicebridge`.
4. Enable Play App Signing and keep the upload key outside the repository.
   Follow [android-release.md](android-release.md) for key generation and
   GitHub secrets.
5. Complete App content before production review:
   - Privacy policy URL.
   - Data safety form.
   - Ads declaration.
   - App access instructions, if testers/reviewers need a token or setup.
   - Content rating.
   - Target audience.
6. Turn on managed publishing before the first review if you want manual control
   over when an approved release goes live.

New personal Play developer accounts created after November 13, 2023 may need
to satisfy Google's testing requirements before production access is available.
Plan for closed testing if the Play Console account falls into that category.

## Android Release Flow

1. Set or verify GitHub Actions secrets:
   - `ANDROID_UPLOAD_KEYSTORE_BASE64`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
   - `ANDROID_STORE_PASSWORD`
2. Run the manual `Android Release` workflow.
3. Use a fresh `version_name` and increasing `version_code`.
4. Download the `app-release.aab` workflow artifact.
5. In Play Console, create an Internal testing release and upload the AAB.
6. Add release notes and publish to internal testers.
7. Smoke-test on physical Android devices:
   - First launch and bridge URL entry.
   - Token save/load.
   - Session list.
   - Text chat streaming.
   - Push-to-talk.
   - Hands-free / talking mode.
   - Local Whisper streaming mode if available in the release environment.
8. Promote to closed testing or production only after smoke testing passes.
9. For production, prefer a staged rollout first, then expand after crash,
   review, and support checks are clean.

## Apple One-Time Setup

1. Ensure the Apple Developer Program membership is active.
2. Create or verify the App Store Connect app record:
   - Name: `VoiceBridge`.
   - Bundle ID: `com.berkayturanci.voicebridge`.
   - SKU: `voicebridge`.
   - Platform: iOS.
3. Accept pending Apple agreements and complete tax/banking only if required for
   the chosen distribution or monetization path.
4. In Xcode, set the signing team for the Runner target locally. Do not commit a
   personal `DEVELOPMENT_TEAM` unless the project intentionally standardizes on
   one team.
5. Add privacy policy URL and App Privacy answers in App Store Connect.
6. Add TestFlight beta app information, review notes, and contact details.

## iOS Release Flow

1. Verify the `iOS Release` workflow is green on `main`.
2. On a Mac with Xcode, run:

```bash
cd app
flutter pub get
flutter build ios --release --no-codesign
open ios/Runner.xcworkspace
```

3. In Xcode, select `Any iOS Device`, archive the Runner target, validate the
   archive, and distribute it to App Store Connect.
4. Wait for App Store Connect processing to finish.
5. Add the build to TestFlight internal testing.
6. Smoke-test on physical iPhone and iPad where possible:
   - First launch and bridge URL entry.
   - Token save/load.
   - Session list.
   - Text chat streaming.
   - Push-to-talk.
   - Hands-free / talking mode.
   - Microphone and speech recognition permission prompts.
7. Submit the build for external TestFlight review if broader beta testing is
   needed.
8. For App Store review, choose the processed build on the app version page,
   confirm metadata, screenshots, app privacy, age rating, and review notes, then
   submit for review.
9. Use manual release for the first version so approval and launch timing stay
   separate.

## Reviewer Notes Template

Use this when a store reviewer needs to understand the app:

```text
VoiceBridge connects a phone to a developer's own local bridge over HTTPS. The
review build can be tested by entering a reviewer-provided bridge URL and access
token, or by using the demo bridge details supplied in App Review notes.

Core flow:
1. Open the app.
2. Enter the bridge URL.
3. Enter the access token if prompted.
4. Start a session.
5. Send text or use the microphone to dictate a prompt.

The app does not provide a public hosted agent service. Users run their own
bridge and agent tooling.
```

## Go / No-Go Checklist

- CI is green after the release commit.
- Android internal testing passed.
- TestFlight internal testing passed.
- Store privacy disclosures match runtime behavior.
- Review notes include bridge setup or demo credentials.
- Screenshots match the shipped UI.
- Support/contact email is monitored.
- Release notes mention only user-visible changes.
- Known non-blockers are documented in the release issue.

## Rejection Handling

1. Do not immediately resubmit the same binary.
2. Copy the rejection reason into a GitHub issue.
3. Decide whether the fix is metadata-only, store configuration, or code.
4. For code fixes, open a PR and rerun the full release gate.
5. For metadata-only fixes, update App Store Connect or Play Console and record
   the change in the release issue.

## Official References

- Google Play: create and set up an app:
  <https://support.google.com/googleplay/android-developer/answer/9859152>
- Google Play: Play App Signing:
  <https://support.google.com/googleplay/android-developer/answer/9842756>
- Google Play: internal testing:
  <https://support.google.com/googleplay/android-developer/answer/9845334>
- Google Play: prepare and roll out a release:
  <https://support.google.com/googleplay/android-developer/answer/9859348>
- Google Play: Data safety:
  <https://support.google.com/googleplay/android-developer/answer/10787469>
- Google Play: app testing requirements for new personal accounts:
  <https://support.google.com/googleplay/android-developer/answer/14151465>
- Apple: TestFlight overview:
  <https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/>
- Apple: App Privacy details:
  <https://developer.apple.com/app-store/app-privacy-details/>
- Apple: manage app privacy:
  <https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>
- Apple: submit an app:
  <https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/>
