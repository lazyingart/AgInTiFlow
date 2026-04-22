[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow ist AgInTis Agent für kontrollierte Browser- und Tool-Nutzung: Web-Automatisierung, persistente Chats, fortsetzbare Läufe und geschützte lokale Befehle.

## Überblick

| Bereich | Richtung |
| --- | --- |
| Kernschleife | Planen -> Tools nutzen -> Ereignisse loggen -> beenden oder fortsetzen |
| Browser | Playwright, Lazy-Start, Domain-Allowlist |
| Modelle | OpenAI-kompatibles Tool Calling mit OpenAI- und DeepSeek-Presets |
| Lokale Tools | Optionaler Shell-Zugriff mit Guardrails und Docker-Sandbox |
| Speicher | Sitzungsstatus, persistente Einstellungen, Chat-Fortsetzung |

## Schnellstart

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Öffne `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## Sicherheit

- Passwörter und destruktive Aktionen sind standardmäßig blockiert.
- Die Shell ist optional und kann in Docker ohne Netzwerk laufen.
- Jede Tool-Anfrage und jedes Ergebnis wird unter `.sessions/` protokolliert.

## Entwicklung

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
