---
id: browser-automation
label: Browser Automation
description: Control existing browser sessions, Chrome/CDP pages, web composers, upload dialogs, asset pickers, model selectors, forms, and submit/publish workflows with inspect-set-verify discipline.
triggers:
  - browser
  - chrome
  - cdp
  - chromedriver
  - playwright
  - selenium
  - web ui
  - website
  - upload
  - attach
  - asset library
  - submit
  - publish
  - model selector
  - prompt composer
  - 小云雀
  - 浏览器
  - 网页
  - 上传
  - 资产库
  - 提交
tools:
  - open_url
  - click
  - type
  - press
  - wait
  - run_command
  - read_image
  - read_file
  - search_files
---
# Browser Automation

Treat browser work as state reconciliation, not passive inspection.

Workflow:

1. Identify the active page and the target final state: page/workspace, mode, model, duration, attachments, prompt text, and submit state.
2. Inspect the current state from the latest snapshot, project helper scripts, screenshots, or read-only CDP/Playwright queries.
3. If a required control is absent or unknown, set it with the smallest scoped action, then wait and verify. Do not stop just because the first state dump lacks a field.
4. Prefer scoped selectors inside the relevant composer, toolbar, modal, asset picker, or form. Broad text clicks over the whole page are unreliable.
5. If a helper reports `ok: true` but returns whole-page text, history/sidebar/nav text, unrelated examples, or an unscoped match, treat it as a wrong target and retry with scoped JS, coordinates from a screenshot, or a narrower selector.
6. For uploads or asset-library selection, verify visible chips, thumbnails, filenames, counters, or previews before submitting.
7. For model/duration/mode controls, distinguish selected state from ads, recommendations, and history labels.
8. For model selectors, honor the exact requested tier. If the user asked for a non-VIP model and the toolbar says VIP, open the selector and choose a non-VIP option; if none exists, stop with that evidence instead of assuming account membership changes the selected model.
9. Before irreversible or externally visible actions such as submit, publish, purchase, or account changes, verify all requested state. If verification remains impossible after a bounded set attempt, stop with the exact blocker and evidence.
10. If the user requested submit/publish/generation, do not finish merely because time or steps are running low while assets, reference media, model choice, or the final submit remain skipped. Continue with a narrower action or stop only for an external blocker such as login, credits, captcha, server/internal error, missing account permission, or a user confirmation dialog.

For logged-in browser sessions, preserve the user’s state. Do not open new tabs, navigate to home/history, or close pages unless the current composer is unusable and the user allowed it.
