[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow — агент AgInTi для управляемой работы с браузером и локальными инструментами: веб-автоматизация, постоянный чат, возобновляемые запуски и защищенные локальные команды.

## Обзор

| Область | Направление |
| --- | --- |
| Основной цикл | План -> инструменты -> журнал событий -> завершение или возобновление |
| Браузер | Playwright, ленивый запуск, allowlist доменов |
| Модели | OpenAI-совместимый tool calling, пресеты OpenAI и DeepSeek |
| Локальные инструменты | Опциональный shell, guardrails, Docker sandbox |
| Память | Состояние сессии, сохраненные настройки, продолжение чата |

## Быстрый старт

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Откройте `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## Безопасность

- Пароли и разрушительные действия заблокированы без явного включения.
- Shell опционален и может выполняться в Docker без сети.
- Каждый запрос инструмента и результат пишется в `.sessions/`.

## Разработка

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
