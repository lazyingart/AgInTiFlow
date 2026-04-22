[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow es el agente de AgInTi para controlar sitios web y herramientas locales con seguridad: automatización de navegador, conversaciones persistentes, ejecuciones reanudables y comandos protegidos.

## Resumen

| Área | Dirección |
| --- | --- |
| Bucle central | Planificar -> usar herramientas -> registrar eventos -> finalizar o reanudar |
| Navegador | Playwright, arranque bajo demanda, allowlist de dominios |
| Modelos | Tool calling compatible con OpenAI, con presets para OpenAI y DeepSeek |
| Herramientas locales | Shell opcional con guardrails y sandbox Docker |
| Memoria | Estado de sesión, configuración persistente y continuación de chat |

## Inicio rápido

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Abre `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## Seguridad

- Las contraseñas y acciones destructivas están bloqueadas salvo activación explícita.
- El shell es opcional y puede ejecutarse dentro de Docker sin red.
- Cada solicitud de herramienta y resultado queda registrado en `.sessions/`.

## Desarrollo

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
