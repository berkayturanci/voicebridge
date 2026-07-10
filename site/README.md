# Landing site

A single-page, dependency-free marketing site for voicebridge. Everything is in
[`index.html`](index.html) (inline CSS + a few lines of JS); the assets
(`icon.svg`, `demo.svg`, `hero.svg`) are copied from the app/`docs/`.

## Preview locally

```bash
# any static server works, e.g.:
python3 -m http.server -d site 4000     # → http://localhost:4000
# or just open the file:
open site/index.html
```

## Hosting (when you want it live)

This repo is private, so GitHub Pages on the free plan won't serve it. Pick one:

- **GitHub Pages** — make the repo public (or use GitHub Pro), then point Pages at
  this folder, or add a workflow that uploads `site/` as the Pages artifact.
- **Netlify / Cloudflare Pages / Vercel** — set the publish directory to `site`,
  no build command. Works on private repos.
- **Any static host / S3 bucket** — upload the four files in `site/`.

After deploying, set the repo's **About → Website** to the live URL
(`gh repo edit berkayturanci/voicebridge --homepage https://…`).

## Keeping assets in sync

`icon.svg`, `demo.svg`, and `hero.svg` are copies. If you change the originals
(`public/icon.svg`, `docs/demo.svg`, `docs/hero.svg`), re-copy them:

```bash
cp public/icon.svg site/icon.svg
cp docs/demo.svg   site/demo.svg
cp docs/hero.svg   site/hero.svg
```
