# AgInTiFlow Website

This folder is the static marketing site for AgInTiFlow. It is separate from the product web app in `public/`.

Public site: `https://flow.lazying.art`.

## Preview

From the repository root:

```bash
python3 -m http.server 4310 --directory website
```

Open `http://127.0.0.1:4310/`.

## Regenerate Screenshots

The screenshots are captured from the live AgInTiFlow app, usually the `agintiflow` tmux session at `http://127.0.0.1:3210/`.

```bash
node scripts/capture-website-screenshots.js
```

Set `AGINTIFLOW_APP_URL` if the app is running elsewhere:

```bash
AGINTIFLOW_APP_URL=http://127.0.0.1:3210/ node scripts/capture-website-screenshots.js
```

The script creates a safe mock-mode run and writes optimized JPEG assets to `website/assets/screenshots/`.

## Files

- `index.html`: landing page content and carousel markup.
- `styles.css`: bright static-site styling and responsive 3D carousel layout.
- `app.js`: copy-to-clipboard behavior and carousel controls.
- `CNAME`: GitHub Pages custom domain for `flow.lazying.art`.
- `assets/screenshots/`: real app screenshots used by the carousel.
- `assets/brand/logo.png`: cropped transparent website logo.
- `assets/brand/logo-source.png`: original copied logo source used to regenerate the transparent asset.
