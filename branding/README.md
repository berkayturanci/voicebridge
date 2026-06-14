# Brand assets

The voicebridge mark — a speech bubble with a voice waveform — and ready-to-use
exports. Source of truth is [`icon.svg`](icon.svg); the PNGs are rendered from it.

## Files

| File | Size | Use |
|------|------|-----|
| `icon.svg` | vector | Source of truth (rounded, transparent corners) |
| `icon-1024.png` | 1024² | Master with rounded corners + transparent background (web, general) |
| `icon-square-1024.png` | 1024² | Full-bleed square (no transparency) — **iOS app icon / Flutter `image_path`** |
| `icon-foreground-1024.png` | 1024² | Mark only on transparent — **Android adaptive `adaptive_icon_foreground`** |

The web/PWA exports live next to the app instead of here:
`../public/` has `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`
(180²), `icon-192.png`, `icon-512.png`, and the `*-maskable.png` variants wired
into `../public/manifest.webmanifest`.

## Colors

| Token | Hex | Where |
|-------|-----|-------|
| Background (deep) | `#0d1117` | Icon backdrop, app bg, **adaptive icon background** |
| Background (top of gradient) | `#1c2533` | Icon backdrop gradient top |
| Mark gradient (light → dark) | `#56d364` → `#2ea043` | The bubble |
| Accent green | `#3fb950` | Glow, highlights |
| Brand blue (secondary) | `#1f6feb` | Links, user message bubbles |
| Text / muted | `#e6edf3` / `#8b949e` | Foreground / secondary text |

GitHub-dark palette throughout. Mark gradient runs vertically (top-light).

## Flutter — `flutter_launcher_icons`

Copy `icon-square-1024.png` and `icon-foreground-1024.png` into the Flutter
project (e.g. `assets/icon/`) and use:

```yaml
# pubspec.yaml
dev_dependencies:
  flutter_launcher_icons: ^0.14.1

flutter_launcher_icons:
  image_path: "assets/icon/icon-square-1024.png"   # iOS + legacy Android
  android: true
  ios: true
  remove_alpha_ios: true                            # iOS icons must be opaque
  # Android adaptive icon:
  adaptive_icon_background: "#0d1117"
  adaptive_icon_foreground: "assets/icon/icon-foreground-1024.png"
  web:
    generate: true
    background_color: "#0d1117"
    theme_color: "#0d1117"
```

Then: `dart run flutter_launcher_icons`.

> The mark is designed to sit inside the maskable / adaptive safe zone, so the
> bubble and its tail won't be clipped by Android's circle/squircle masks or
> iOS's rounded-rect. If you want more breathing room on Android, add
> `adaptive_icon_foreground_inset` (0.14+) or pad the foreground PNG.

## Regenerating

The PNGs are rendered from `icon.svg` (and a square / foreground variant) with a
headless browser. If you change the mark, re-export the sizes and re-run
`flutter_launcher_icons` in the app project.
