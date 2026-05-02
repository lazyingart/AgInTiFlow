# AgInTiFlow Website

This folder is the static marketing site for AgInTiFlow. It is separate from the product web app in `public/`.

Public site: `https://flow.lazying.art`.

## Preview

From the repository root:

```bash
python3 -m http.server 4310 --directory website
```

Open `http://127.0.0.1:4310/`.

## Multilingual Content

The landing page supports the same languages as the project README set:

- English: `README.md`
- العربية: `README.ar.md`
- Deutsch: `README.de.md`
- Español: `README.es.md`
- Français: `README.fr.md`
- 日本語: `README.ja.md`
- 한국어: `README.ko.md`
- Русский: `README.ru.md`
- Tiếng Việt: `README.vi.md`
- 简体中文: `README.zh-Hans.md`
- 繁體中文: `README.zh-Hant.md`

Translations live in `app.js` and are applied through `data-i18n`, `data-i18n-aria`, and `data-i18n-alt` attributes in `index.html`. The language dropdown is in the top-right header and stores the user preference in `localStorage`.

## Documentation Section

The landing page includes a docs section linking to the maintained source-of-truth Markdown files in `docs/`, especially:

- `docs/runtime-modes-and-autonomy.md`: Docker, host access, tmux, package persistence, and long-running autonomy.
- `docs/self-development-supervision.md`: protocol for supervised AgInTiFlow-on-AgInTiFlow development.
- `docs/agent-runtime-pipe.md`: CLI/web shared sessions, inbox messages, queues, and stop/resume behavior.
- `docs/large-codebase-engineering.md`: codebase maps, scout blackboards, patch loops, and verification.

When runtime behavior changes, update the Markdown doc first, then keep the website section as a concise entry point.

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
- `styles.css`: bright static-site styling, language dropdown, and responsive 3D carousel layout.
- `app.js`: multilingual copy, copy-to-clipboard behavior, and carousel controls.
- `CNAME`: GitHub Pages custom domain for `flow.lazying.art`.
- `assets/screenshots/`: real app screenshots used by the carousel.
- `assets/brand/logo.png`: cropped transparent website logo.
- `assets/brand/logo-source.png`: original copied logo source used to regenerate the transparent asset.
