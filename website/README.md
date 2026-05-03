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

## Documentation Site

The public website now ships a dedicated documentation app at:

```text
https://flow.lazying.art/docs/
```

Local preview:

```bash
python3 -m http.server 4310 --directory website
open http://127.0.0.1:4310/docs/
```

Docs app files:

- `docs/index.html`: documentation shell.
- `docs/styles.css`: docs-specific layout, sidebar, table of contents, and Markdown styles.
- `docs/app.js`: file explorer, search, Markdown rendering, table of contents, and pager behavior.
- `docs/i18n.js`: docs language packs, translated navigation, translated page content, and RTL metadata.
- `docs/docs/*.md`: website-facing documentation pages.

Keep these pages concise enough for the website, but detailed enough to be useful without leaving `flow.lazying.art`.

The docs app supports the same 11 languages as the landing page: English, العربية, Deutsch, Español, Français, 日本語, 한국어, Русский, Tiếng Việt, 简体中文, and 繁體中文. The dropdown in the top-right header persists the selected language in `localStorage`; English Markdown remains the source fallback, while translated docs content is maintained in `docs/i18n.js`.

## Landing Documentation Section

The landing page includes a concise docs section that routes visitors into the dedicated docs app:

- `/docs/#/runtime-modes`: Docker, host access, tmux, package persistence, and long-running autonomy.
- `/docs/#/self-development`: protocol for supervised AgInTiFlow-on-AgInTiFlow development.
- `/docs/#/artifacts-and-sessions`: CLI/web shared sessions, inbox messages, queues, and artifacts.
- `/docs/#/coding-tools`: codebase maps, patch loops, file tools, and verification.

When runtime behavior changes, update the repository Markdown doc first, then update the website docs page if the behavior is user-facing.

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
- `docs/`: static documentation app served at `/docs/`.
- `CNAME`: GitHub Pages custom domain for `flow.lazying.art`.
- `assets/screenshots/`: real app screenshots used by the carousel.
- `assets/screenshots/cli-launch.jpg`: optimized hero preview of the terminal-first CLI.
- `assets/screenshots/archive/`: previous hero CLI screenshots kept before replacing the active preview.
- `assets/brand/logo.png`: cropped transparent website logo.
- `assets/brand/logo-source.png`: original copied logo source used to regenerate the transparent asset.
