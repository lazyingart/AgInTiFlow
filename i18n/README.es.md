[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![Playwright](https://img.shields.io/badge/Browser-Playwright-2EAD33?logo=playwright&logoColor=white)
![CLI + Web](https://img.shields.io/badge/Interface-CLI%20%2B%20Web-0ea5e9)
![Text Models](https://img.shields.io/badge/Text-DeepSeek%20%2B%20Venice%20%2B%20OpenAI%20%2B%20Qwen-2563eb)
![Aux Image](https://img.shields.io/badge/Aux%20Image-GRS%20AI%20%2B%20Venice-ec4899)
![Sandbox](https://img.shields.io/badge/Shell-Docker%20Sandbox-f97316)
![Status](https://img.shields.io/badge/Status-Prototype-7c3aed)

**Agentes de bajo costo y conscientes del proyecto para problemas reales.**

Usa el mismo workspace de agente desde Web o CLI, con routing DeepSeek/Venice/OpenAI, llamadas de herramientas visibles, sesiones durables, scouts, supervisión SCS, workflows AAPS y ejecución local protegida.

La idea breve: ejecuta `aginti` dentro de un proyecto, dale una tarea, revisa el plan, ve cada llamada de herramienta, reanuda más tarde y conserva las salidas dentro de tu workspace.

**Enlaces**

| Recurso | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| Posicionamiento del producto | [../references/agintiflow-product-positioning.md](../references/agintiflow-product-positioning.md) |
| README completo archivado | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## Por qué existe

La mayoría de herramientas de agentes son una caja de chat con estado oculto o un bucle caro de un solo modelo. AgInTiFlow se basa en otra filosofía:

| Principio | Qué significa en la práctica |
| --- | --- |
| La inteligencia barata cambia la arquitectura | DeepSeek V4 Flash y Pro hacen práctico gastar más llamadas en routing, scouts, revisión y recuperación, en lugar de exigir que una llamada cara haga todo. |
| Inspeccionable vence a misterioso | Planes, llamadas de herramientas, diffs de archivos, salida de comandos, artifacts de canvas y eventos de sesión se guardan y pueden reanudarse. |
| Modelos por roles | Route, main, spare, wrapper y auxiliary image son roles separados. Puedes combinar modelos de ruta baratos, modelos principales más fuertes, rutas OpenAI/Qwen/Venice opcionales y herramientas de imagen GRS AI/Venice. |
| Scouts antes del trabajo grande | Scouts paralelos pueden mapear arquitectura, pruebas, riesgos, símbolos y puntos de integración antes de que el ejecutor principal edite archivos. |
| SCS para trabajo de alto riesgo | Student-Committee-Supervisor añade una compuerta tipada: committee redacta, student aprueba/supervisa y supervisor ejecuta. Usa `/scs` o `--scs auto`. |
| AAPS para workflows grandes | AAPS describe scripts de pipelines agentic de arriba abajo; AgInTiFlow puede actuar como backend interactivo que valida, compila y ejecuta esos workflows. |
| Seguridad local por defecto | Docker workspace, guardrails de rutas, redacción de secretos, bloqueo de comandos npm publish/token y logs visibles hacen que el agente sea práctico sin volverse opaco. |

## Inicio rápido

Instala y abre un proyecto:

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

En el primer uso interactivo, AgInTiFlow abre un asistente de autenticación si no encuentra una clave de modelo principal. Elige DeepSeek, OpenAI, Qwen o Venice, pega la clave y se guardará en `.aginti/.env`, ignorado por git, con permisos restringidos. Puedes repetirlo cuando quieras:

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

Inicia la UI web desde el mismo proyecto:

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

Ejecuta pruebas smoke sin credenciales reales:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

Fija un idioma explícitamente, u omítelo para usar el locale del sistema:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## Comandos diarios

| Objetivo | Comando |
| --- | --- |
| Iniciar chat interactivo | `aginti` o `aginti chat` |
| Iniciar app web local | `aginti web --port 3210` |
| Guardar claves de provider | `aginti auth`, `/auth`, `/login` |
| Revisar el repo actual | `/review [focus]` |
| Activar/desactivar compuerta SCS | `/scs` |
| Usar SCS solo para trabajo complejo | `/scs auto` o `aginti --scs auto "task"` |
| Trabajar con workflows AAPS | `aginti aaps status`, `/aaps validate` |
| Elegir modelos | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| Atajo Venice | `/venice` |
| Generar imágenes | `/auxiliary image`, luego pide la imagen |
| Reanudar proyecto actual | `aginti resume` |
| Ver todas las sesiones | `aginti resume --all-sessions` |
| Encolar en una sesión activa | `aginti queue <session-id> "extra instruction"` |
| Limpiar sesiones vacías | `aginti --remove-empty-sessions` |
| Comprobar capacidades | `aginti capabilities`, `aginti doctor --capabilities` |
| Sincronizar skills revisadas | `aginti skillmesh status`, `aginti skillmesh sync` |
| Actualizar CLI | `aginti update` |

El chat interactivo soporta completado slash, selectores Up/Down, entrada multilínea con `Ctrl+J`, historial completo al reanudar, renderizado Markdown, estado visible de ejecución, mensajes ASAP pipe durante una ejecución e interrupción/reanudación limpia con `Ctrl+C`. Los comandos interactivos instalados también consultan npm por una versión nueva de AgInTiFlow y muestran un selector de actualizar/saltar; los checkouts fuente y la automatización non-TTY no se alteran.

Para una reanudación one-shot totalmente controlada, usa un session id explícito y elige deliberadamente el task profile. Usa `auto` para routing normal o `android` para trabajo Android/emulador:

```bash
PROFILE=android  # or auto
aginti --resume <session-id> \
  --profile "$PROFILE" \
  --sandbox-mode host \
  --package-install-policy allow \
  --approve-package-installs \
  --allow-shell \
  --allow-file-tools \
  --allow-destructive \
  "Take a fresh screenshot of the running app in the emulator, save it with a durable filename in this project, and keep git status clean."
```

## Capturas reales

| Arranque CLI | Vista general web |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| Controles de tarea | Salida de ejecución |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| Historial de conversación | Estado de sandbox |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| Vista móvil |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

Las capturas antiguas de arranque se conservan en el repositorio fuente bajo [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## Capacidades principales

| Capacidad | Qué aporta AgInTiFlow |
| --- | --- |
| Workspace CLI de agente | Chat de terminal persistente con cwd del proyecto, reanudación de sesión, estado visible de modelo/herramientas e indicaciones claras. |
| Workspace web local | UI en navegador para sesiones, logs de runtime, artifacts, ajustes de modelos, controles de proyecto, previews de canvas y estado de sandbox. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | Ejecución shell protegida en host o Docker workspace con política de instalación de paquetes y checks de seguridad. |
| Browser tools | Acciones Playwright con arranque perezoso y allowlists de dominio opcionales. |
| Model routing | Defaults DeepSeek fast/pro, rutas manuales OpenAI/Qwen/Venice/mock, spare models, wrapper models y auxiliary image models. |
| Patch workflow | Patch envelopes estilo Codex, unified diffs, reemplazos exactos, hashes, diffs compactos y guardrails de rutas. |
| Parallel scouts | Llamadas scout opcionales para arquitectura, implementación, review, tests, git flow, investigación, symbol tracing y riesgo de dependencias. |
| SCS mode | Compuerta opcional Student-Committee-Supervisor para tareas complicadas o arriesgadas. |
| AAPS adapter | Integración opcional con `@lazyingart/aaps` para init, validate, parse, compile, dry-run y run de workflows `.aaps`. |
| Image generation | Herramientas opcionales GRS AI y Venice con manifests guardados y previews de canvas. |
| Skill library | Skills Markdown integradas para código, sitios web, Android/iOS, Python, Rust, Java, LaTeX, escritura, reviews, GitHub, AAPS y más. |
| Skill Mesh | Registro/compartición estricta opcional de packs de skills reutilizables y revisadas. Si no se usa, AgInTiFlow funciona normalmente sin sharing en segundo plano. |
| UI multilingüe | CLI y docs en inglés, japonés, chino simplificado/tradicional, coreano, francés, español, árabe, vietnamita, alemán y ruso. |

## Modelos y roles

AgInTiFlow no trata “el modelo” como un ajuste global único. Tiene roles:

| Rol | Default | Propósito |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | Planificación barata, triage, tareas cortas y decisiones de routing. |
| Main | `deepseek/deepseek-v4-pro` | Coding complejo, debugging, escritura, research y tareas largas. |
| Spare | `openai/gpt-5.4` medium | Fallback opcional o ruta de cross-check. |
| Wrapper | `codex/gpt-5.5` medium | Asesor externo opcional de coding-agent. |
| Auxiliary | `grsai/nano-banana-2` | Generación de imágenes y otras herramientas no textuales. |

Selectores útiles:

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Las rutas Venice pueden usarse para trabajo creativo opcional uncensored o menos restringido. DeepSeek sigue siendo el default económico para workflows normales de ingeniería. Ver [../docs/model-selection.md](../docs/model-selection.md) y [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS y workflows grandes

AAPS es la capa de pipeline-script; AgInTiFlow es el backend interactivo de agente/herramientas.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

Dentro del chat:

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

Usa AAPS cuando la tarea supera un chat único: desarrollo de apps por etapas, workflows de paper/libro, compuertas de validación, pasos de recuperación, producción de artifacts o scripts agentic top-down. Ver [../docs/aaps.md](../docs/aaps.md) y el paquete [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## Referencia rápida de API local

La app web expone APIs locales para UI y automatización. Estos endpoints informan estado sin exponer API keys crudas ni npm tokens:

```bash
curl http://127.0.0.1:3210/api/config
curl http://127.0.0.1:3210/api/capabilities
curl http://127.0.0.1:3210/api/sandbox/status
curl -X POST http://127.0.0.1:3210/api/sandbox/preflight \
  -H 'Content-Type: application/json' \
  -d '{"sandboxMode":"docker-workspace","buildImage":true}'
curl http://127.0.0.1:3210/api/workspace/changes
curl "http://127.0.0.1:3210/api/sessions/<session-id>/artifacts"
curl "http://127.0.0.1:3210/api/sessions/<session-id>/inbox"
```

Ejecuta la prueba smoke de API sin credenciales:

```bash
npm run smoke:web-api
```

## Almacenamiento, seguridad y reanudación

AgInTiFlow guarda las sesiones canónicas de forma centralizada y deja solo punteros locales en el proyecto:

| Ubicación | Propósito |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | Estado canónico, eventos, estado del navegador, artifacts, snapshots, archivos de canvas. |
| `<project>/.aginti-sessions/` | Punteros locales de sesión y base de datos de la Web UI. Ignorado por git. |
| `<project>/.aginti/.env` | API keys opcionales del proyecto con permisos restringidos. Ignorado por git. |
| `<project>/AGINTI.md` | Instrucciones editables del proyecto y preferencias locales durables. Seguro para commit si no contiene secretos. |

Defaults de seguridad:

- Docker workspace mode es el default normal para CLI/Web en coding práctico y generación de artifacts.
- File tools bloquean rutas tipo secreto, `.env`, `.git`, escrituras en `node_modules`, escapes absolutos, archivos enormes y edición binaria.
- Los shell commands pasan por policy checks; npm publish, npm token commands, sudo, git destructivo y lecturas de credenciales se bloquean.
- Las escrituras de archivos registran hashes y diffs compactos.
- Tool calls y resultados se registran en eventos estructurados de sesión.
- Web y CLI usan el mismo session store, por lo que un run puede inspeccionarse y reanudarse después.

Notas detalladas de runtime: [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md), [../docs/patch-tools.md](../docs/patch-tools.md), [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## Configuración

Variables de entorno comunes:

```bash
DEEPSEEK_API_KEY=...
OPENAI_API_KEY=...
QWEN_API_KEY=...
VENICE_API_KEY=...
GRSAI_API_KEY=...
AGENT_PROVIDER=deepseek
AGENT_ROUTING_MODE=smart
AGINTI_TASK_PROFILE=auto
AGINTI_LANGUAGE=en
SANDBOX_MODE=docker-workspace
PACKAGE_INSTALL_POLICY=allow
COMMAND_CWD=/path/to/project
```

Claves locales del proyecto:

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

Más detalle:

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## Mapa de documentación

| Tema | Enlace |
| --- | --- |
| AAPS adapter | [../docs/aaps.md](../docs/aaps.md) |
| Selección de modelos y roles | [../docs/model-selection.md](../docs/model-selection.md) |
| SCS mode | [../docs/student-committee-supervisor.md](../docs/student-committee-supervisor.md) |
| Ingeniería de codebases grandes | [../docs/large-codebase-engineering.md](../docs/large-codebase-engineering.md) |
| Runtime modes y autonomía | [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md) |
| Skills y herramientas | [../docs/skills-and-tools.md](../docs/skills-and-tools.md) |
| Skill Mesh | [../docs/skillmesh.md](../docs/skillmesh.md) |
| Housekeeping logs | [../docs/housekeeping.md](../docs/housekeeping.md) |
| Publicación npm | [../docs/npm-publishing.md](../docs/npm-publishing.md) |
| Roadmap de producto | [../docs/productive-agent-roadmap.md](../docs/productive-agent-roadmap.md) |
| Currículo de capacidades supervisadas | [../docs/supervised-capability-curriculum.md](../docs/supervised-capability-curriculum.md) |
| README completo anterior | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## Desarrollo

Ejecutar desde código fuente:

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

Iniciar web local desde código fuente:

```bash
npm run web
# open http://127.0.0.1:3210
```

Smoke checks útiles:

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

Los smoke scripts usan el provider mock local salvo que estén marcados explícitamente como pruebas de provider real.

## Notas de release

AgInTiFlow se publica como `@lazyingart/agintiflow`. La ruta preferida es GitHub Actions Trusted Publishing con npm provenance. Publicar con token local solo debe ser fallback de bootstrap y nunca debe commitear `.env`, `.npmrc`, npm tokens, OTPs ni debug logs.

Ver [../docs/npm-publishing.md](../docs/npm-publishing.md) para el workflow completo de release.

## Soporte

Si este proyecto te resulta útil, puedes apoyar el desarrollo aquí:

| Soporte | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow es desarrollado por AgInTi Lab, LazyingArt LLC.
