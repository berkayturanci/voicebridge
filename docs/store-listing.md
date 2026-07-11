# Store Listing And Beta Checklist

This document is the working store-copy and beta-readiness source for the
native VoiceBridge app. Re-check store-console character limits and screenshot
device requirements immediately before submission.

Store app name: `berkayturanci`

## Product Positioning

VoiceBridge is a private voice remote for coding agents. It lets a developer
talk or type from a phone, send the request to a VoiceBridge server running on
their own computer, and hear the coding agent's reply aloud.

Primary audience:

- developers who already use Claude Code, Codex, Antigravity, or Ollama;
- users who want a private Tailscale/local bridge instead of a hosted voice
  service;
- users who want mobile voice control while walking, cooking, debugging, or
  stepping away from the desk.

## App Store Subtitle Draft

Voice remote for your own PC

(30-char limit; previous draft, "Private voice for coding agents", read as a
general voice-assistant pitch with no hint that a PC bridge is required —
see #214. This draft trades a little punch for setting that expectation in
the ~30 characters most browsers actually read before tapping install.)

## App Store Promotional Text Draft

Talk to your coding agent from your phone. Requires a VoiceBridge server
running on your own PC, connected over Tailscale HTTPS.

(170-char limit; the previous draft was 171 characters — over the limit —
and, like the subtitle, didn't mention the PC/Tailscale requirement.)

## App Store Description Draft

VoiceBridge turns your phone into a private voice remote for coding agents.
Run the VoiceBridge server on your Mac or Linux machine, expose it securely over
Tailscale HTTPS, then connect the native app to talk or type to your agent.

What you can do:

- start and resume coding-agent sessions from your phone;
- use push-to-talk or hands-free talking mode;
- read streamed replies in chat and hear them aloud;
- switch between local sessions and supported agents;
- keep your bridge URL and access token stored on your own device.

VoiceBridge is local-first. The app does not run a hosted account system and
does not send prompts, tokens, transcripts, or audio to a VoiceBridge-operated
cloud. Your configured agent CLI may still contact its own provider, and your
operating system may process native speech recognition depending on platform
settings.

Requirements:

- a running VoiceBridge server;
- HTTPS access to that server, ideally through Tailscale;
- a supported coding agent installed and authenticated on your computer.

VoiceBridge is free and source-available under the PolyForm Noncommercial
1.0.0 license — no ads, no in-app purchases, no subscription.

## Google Play Short Description Draft

Talk to your own PC coding agent. Requires the PC bridge running.

(80-char limit; makes the PC-bridge requirement explicit in the text most
Play Store browsers actually read — see #214.)

## Google Play Full Description Draft

VoiceBridge is a private voice remote for coding agents.

Run the VoiceBridge server on your own computer, connect through Tailscale
HTTPS, and use the native app to talk or type to Claude Code, Codex,
Antigravity, Ollama, or another supported agent.

Features:

- native mobile voice input and text-to-speech;
- push-to-talk and hands-free talking mode;
- streamed chat replies;
- multiple sessions;
- optional access token for your bridge;
- local-first architecture with no VoiceBridge-hosted account.

VoiceBridge is built for developers who want to step away from the keyboard
without handing voice traffic to another app service. Your bridge URL and token
stay on your device. Prompts and replies go to the bridge you configure.

VoiceBridge is free and source-available (PolyForm Noncommercial 1.0.0) — no
ads, no in-app purchases, no subscription.

## Screenshot Set

Capture fresh screenshots from the final release build. Use real app screens,
not mockups.

Recommended sequence:

1. First-run PC connection screen.
2. Session list with multiple agents.
3. Chat screen with streamed code-aware reply.
4. Talking mode / voice screen.
5. Settings screen showing privacy/support links.

iOS notes:

- App Store Connect requires one to ten screenshots per supported display size.
- Use current App Store Connect screenshot specifications before export.

Google Play notes:

- Prepare phone screenshots for the main listing.
- Prepare a feature graphic if Play Console requires it for the selected release
  path or promotion surfaces.
- Avoid implying endorsement by Claude, OpenAI, Google, or other agent vendors.

## Beta Test Checklist

Before TestFlight or Google Play internal testing:

- Privacy policy URL is live:
  <https://berkayturanci.github.io/voicebridge/privacy.html>
- Store privacy disclosures match the submitted binary.
- Bridge connection works over Tailscale HTTPS.
- Access-token success and failure paths are tested.
- Microphone permission prompt appears with the expected native copy.
- Speech recognition works on at least one physical iPhone and one physical
  Android phone.
- Talking mode can be stopped and resumed.
- App handles bridge offline / token invalid / server busy states without a
  crash.
- App can be uninstalled/reinstalled without leaving required server-side state.
- Screenshots match the current UI and do not reveal private repository paths,
  tokens, or user data.

## Review Notes Draft

VoiceBridge is a companion client for a user-operated local bridge. Reviewers
can run the bridge from the public repository, configure the app with the bridge
URL, and test typed prompts without needing a hosted VoiceBridge account. Voice
features require microphone permission and platform speech recognition.

## Official References

- Apple screenshot specifications:
  <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>
- Apple product page guidance:
  <https://developer.apple.com/app-store/product-page/>
- Google Play store listing:
  <https://play.google.com/console/about/storelistings/>
- Google Play store listing best practices:
  <https://support.google.com/googleplay/android-developer/answer/13393723>
