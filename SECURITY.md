# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for security vulnerabilities.**

If you find a security issue in voicebridge, report it privately:

- Use GitHub's [private vulnerability reporting](https://github.com/berkayturanci/voicebridge/security/advisories/new) — *Security → Report a vulnerability*, or
- Email the maintainer at **berkayturanci@gmail.com**.

Please include steps to reproduce, the affected version or commit, and the
impact. You'll get an acknowledgement within a few days, and a fix or mitigation
plan once the report is confirmed.

## Supported versions

voicebridge is an evolving project. Fixes land on `main` and the latest release,
so please run a recent version.

## Trust model

voicebridge lets a phone drive a coding agent on your computer — that's powerful.
Before exposing it, read [docs/security.md](docs/security.md) for the threat
model, the access token, the Tailscale boundary, and the risks of full-auto
modes.
