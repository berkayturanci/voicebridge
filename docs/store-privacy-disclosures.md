# Store Privacy Disclosures

Use this as the starting point for App Store Connect App Privacy and Google Play
Data safety answers. Re-check the final app binary and store-console wording
before submission.

## Product Model

- VoiceBridge does not operate a hosted user account system.
- The native app connects to a bridge URL configured by the user.
- Bridge URL and optional access token are stored on the user's device.
- Prompts, transcripts, audio-derived text, and agent replies are sent to the
  configured bridge, not to a VoiceBridge-operated service.
- Claude Code, Codex, Antigravity, or other agent CLIs may contact their own
  vendor services outside the native app. Ollama and local Whisper can run
  locally.

## Apple App Privacy Draft

Suggested high-level answer:

- Data collected by this app developer: No.
- Tracking: No.
- Data linked to user: No, unless future analytics/account features are added.
- Data not linked to user: No, unless future diagnostics/analytics are added.

Notes for reviewer:

- The app stores bridge configuration locally so it can connect to the user's
  own VoiceBridge server.
- The app uses microphone and speech recognition permissions for voice commands.
- The app has no VoiceBridge account creation flow; in-app account deletion is
  not applicable unless a hosted account feature is later added.

## Google Play Data Safety Draft

Suggested high-level answer:

- Does the app collect or share user data with the developer? No.
- Is all data encrypted in transit? The app should be used with HTTPS bridge
  URLs; the UI and docs recommend Tailscale HTTPS.
- Can users request data deletion? No hosted developer-side data is collected.
  Users can remove local data by clearing app storage/uninstalling and by
  deleting their own bridge session files.

Data types to review carefully before submission:

- Audio: used for voice commands through platform speech recognition, not
  collected by the app developer.
- App activity / messages: sent to the user-configured bridge endpoint.
- Device or other IDs: not intentionally collected by VoiceBridge.

## Privacy Policy URL

Use:

<https://berkayturanci.github.io/voicebridge/privacy.html>

## Review Before Submission

- Confirm no analytics SDK was added to the native app.
- Confirm no crash reporter or telemetry package was added.
- Confirm final Android and iOS permission lists match the policy answers.
- Confirm the public privacy page matches the exact submitted binary.
