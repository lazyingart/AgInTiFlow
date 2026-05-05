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

**Недорогие, проектно-ориентированные агенты для реальных задач.**

Используйте одно и то же агентное рабочее пространство из Web или CLI: маршрутизация DeepSeek/Venice/OpenAI, видимые вызовы инструментов, долговечные сессии, scouts, SCS-супервизия, AAPS-workflows и защищенное локальное выполнение.

Коротко: запустите `aginti` внутри проекта, дайте задачу, проверьте план, увидьте каждый tool call, возобновите работу позже и сохраняйте результаты в рабочей папке.

**Ссылки**

| Ресурс | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| Позиционирование продукта | [../references/agintiflow-product-positioning.md](../references/agintiflow-product-positioning.md) |
| Полный архив README | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## Зачем это нужно

Большинство агентных инструментов — это либо чат с скрытым состоянием, либо дорогой цикл вокруг одной модели. AgInTiFlow строится на другой философии:

| Принцип | Практический смысл |
| --- | --- |
| Дешевый интеллект меняет архитектуру | DeepSeek V4 Flash и Pro делают практичными дополнительные вызовы для routing, scouting, review и recovery, вместо попытки сделать всё одним дорогим вызовом. |
| Проверяемость лучше загадочности | Планы, tool calls, file diffs, вывод команд, canvas artifacts и session events сохраняются и могут быть возобновлены. |
| Модели по ролям | Route, main, spare, wrapper и auxiliary image — отдельные роли. Можно сочетать дешевые route-модели, более сильные main-модели, optional OpenAI/Qwen/Venice routes и GRS AI/Venice image tools. |
| Scouts перед большой работой | Параллельные scouts дешево картируют архитектуру, тесты, риски, символы и точки интеграции до того, как main executor начнет редактировать файлы. |
| SCS для рискованных задач | Student-Committee-Supervisor добавляет typed gate: committee пишет черновик, student утверждает/мониторит, supervisor исполняет. Используйте `/scs` или `--scs auto`. |
| AAPS для больших workflow | AAPS описывает top-down agentic pipeline scripts; AgInTiFlow может быть интерактивным backend для validation, compilation и execution. |
| Локальная безопасность по умолчанию | Docker workspace, path guardrails, secret redaction, блокировка npm publish/token commands и видимые logs делают агента практичным, но не непрозрачным. |

## Быстрый старт

Установите и откройте проект:

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

При первом интерактивном запуске AgInTiFlow открывает auth wizard, если не найден key для main model. Выберите DeepSeek, OpenAI, Qwen или Venice, вставьте key, и он будет сохранен в игнорируемый git файл проекта `.aginti/.env` с ограниченными правами. Настройку можно повторить в любое время:

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

Запустите Web UI из того же проекта:

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

Smoke test без реальных модельных credentials:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

Задайте язык явно или опустите параметр, чтобы использовать system locale:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## Ежедневные команды

| Цель | Команда |
| --- | --- |
| Запустить интерактивный чат | `aginti` или `aginti chat` |
| Запустить локальное Web-приложение | `aginti web --port 3210` |
| Сохранить provider keys | `aginti auth`, `/auth`, `/login` |
| Сделать review текущего repo | `/review [focus]` |
| Переключить SCS quality gate | `/scs` |
| Использовать SCS только для сложной работы | `/scs auto` или `aginti --scs auto "task"` |
| Работать с AAPS workflows | `aginti aaps status`, `/aaps validate` |
| Выбрать модели | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| Включить Venice shortcut | `/venice` |
| Генерировать изображения | `/auxiliary image`, затем попросите изображение |
| Возобновить текущий проект | `aginti resume` |
| Просмотреть все sessions | `aginti resume --all-sessions` |
| Поставить сообщение в running session | `aginti queue <session-id> "extra instruction"` |
| Удалить пустые sessions | `aginti --remove-empty-sessions` |
| Проверить capabilities | `aginti capabilities`, `aginti doctor --capabilities` |
| Синхронизировать проверенные skills | `aginti skillmesh status`, `aginti skillmesh sync` |
| Обновить CLI | `aginti update` |

Интерактивный чат поддерживает slash completion, Up/Down selectors, multiline input через `Ctrl+J`, полную resume history, Markdown rendering, видимый run status, ASAP pipe messages во время выполнения и чистое interrupt/resume через `Ctrl+C`. Установленные interactive commands также проверяют npm на новую версию AgInTiFlow и показывают selector update/skip; source checkouts и non-TTY automation не затрагиваются.

Для полностью контролируемого one-shot resume используйте явный session id и осознанно выберите task profile. `auto` подходит для обычного routing, `android` — для Android/emulator работы:

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

## Реальные скриншоты

| CLI launch | Web app overview |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| Task controls | Runtime output |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| Conversation history | Sandbox status |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| Mobile overview |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

Старые launch screenshots сохранены в source repository в [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## Основные возможности

| Возможность | Что дает AgInTiFlow |
| --- | --- |
| CLI agent workspace | Persistent terminal chat с project cwd, session resume, видимым model/tool state и понятными command hints. |
| Local web workspace | Browser UI для sessions, runtime logs, artifacts, model settings, project controls, canvas previews и sandbox status. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | Защищенное выполнение shell на host или Docker workspace с package-install policy и command safety checks. |
| Browser tools | Playwright browser actions с lazy startup и optional domain allowlists. |
| Model routing | DeepSeek fast/pro defaults, manual OpenAI/Qwen/Venice/mock routes, spare models, wrapper models и auxiliary image models. |
| Patch workflow | Codex-style patch envelopes, unified diffs, exact replacements, hashes, compact diffs и path guardrails. |
| Parallel scouts | Optional scout calls для architecture, implementation, review, tests, git flow, research, symbol tracing и dependency risk. |
| SCS mode | Optional Student-Committee-Supervisor quality gate для сложных или рискованных задач. |
| AAPS adapter | Optional `@lazyingart/aaps` integration для `.aaps` workflow init, validate, parse, compile, dry-run и run. |
| Image generation | Optional GRS AI и Venice image tools с сохраненными manifests и canvas artifact previews. |
| Skill library | Built-in Markdown skills для code, websites, Android/iOS, Python, Rust, Java, LaTeX, writing, reviews, GitHub, AAPS и другого. |
| Skill Mesh | Optional strict skill recording/sharing для проверенных reusable skill packs. Если не используется, AgInTiFlow работает нормально без background sharing. |
| Multilingual UI | CLI и docs поддерживают English, Japanese, Simplified/Traditional Chinese, Korean, French, Spanish, Arabic, Vietnamese, German и Russian. |

## Модели и роли

AgInTiFlow не считает “модель” единственной глобальной настройкой. Есть роли:

| Роль | Default | Назначение |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | Дешевый planner, triage, short tasks, routing decisions. |
| Main | `deepseek/deepseek-v4-pro` | Complex coding, debugging, writing, research, long tasks. |
| Spare | `openai/gpt-5.4` medium | Optional fallback или cross-check route. |
| Wrapper | `codex/gpt-5.5` medium | Optional external coding-agent advisor. |
| Auxiliary | `grsai/nano-banana-2` | Image generation и другие non-text helper tools. |

Полезные selectors:

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Venice routes можно использовать для optional uncensored или менее ограниченной creative work. DeepSeek остается экономическим default для обычных engineering workflows. См. [../docs/model-selection.md](../docs/model-selection.md) и [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS и большие workflow

AAPS — слой pipeline-script; AgInTiFlow — интерактивный agent/tool backend.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

В чате:

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

Используйте AAPS, когда задача больше одного чата: app development со stages, paper/book workflows, validation gates, recovery steps, artifact production или top-down agentic scripts. См. [../docs/aaps.md](../docs/aaps.md) и package [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## Краткая справка по локальному API

Web app предоставляет локальные APIs для UI и automation. Эти endpoints возвращают состояние, не раскрывая raw API keys или npm tokens:

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

Запустить credential-free API smoke test:

```bash
npm run smoke:web-api
```

## Хранение, безопасность и resume

AgInTiFlow хранит canonical sessions централизованно и оставляет только project-local pointers:

| Location | Purpose |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | Canonical state, events, browser state, artifacts, snapshots, canvas files. |
| `<project>/.aginti-sessions/` | Project-local session pointers и Web UI database. Git ignored. |
| `<project>/.aginti/.env` | Optional project-local API keys с restricted permissions. Git ignored. |
| `<project>/AGINTI.md` | Editable project instructions и durable local preferences. Safe to commit, если нет secrets. |

Safety defaults:

- Docker workspace mode — обычный default CLI/Web для practical coding и artifact generation.
- File tools блокируют secret-like paths, `.env`, `.git`, `node_modules` writes, absolute escapes, huge files и binary edits.
- Shell commands проходят policy check; npm publish, npm token commands, sudo, destructive git и credential reads блокируются.
- File writes записывают hashes и compact diffs.
- Tool calls и results логируются в structured session events.
- Web и CLI используют один session store, поэтому run можно позже inspect/resume.

Подробности runtime: [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md), [../docs/patch-tools.md](../docs/patch-tools.md), [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## Конфигурация

Частые переменные окружения:

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

Project-local keys:

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

Подробнее:

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## Карта документации

| Тема | Ссылка |
| --- | --- |
| AAPS adapter | [../docs/aaps.md](../docs/aaps.md) |
| Model selection and roles | [../docs/model-selection.md](../docs/model-selection.md) |
| SCS mode | [../docs/student-committee-supervisor.md](../docs/student-committee-supervisor.md) |
| Large-codebase engineering | [../docs/large-codebase-engineering.md](../docs/large-codebase-engineering.md) |
| Runtime modes and autonomy | [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md) |
| Skills and tools | [../docs/skills-and-tools.md](../docs/skills-and-tools.md) |
| Skill Mesh | [../docs/skillmesh.md](../docs/skillmesh.md) |
| Housekeeping logs | [../docs/housekeeping.md](../docs/housekeeping.md) |
| npm publishing | [../docs/npm-publishing.md](../docs/npm-publishing.md) |
| Product roadmap | [../docs/productive-agent-roadmap.md](../docs/productive-agent-roadmap.md) |
| Supervised capability curriculum | [../docs/supervised-capability-curriculum.md](../docs/supervised-capability-curriculum.md) |
| Полная старая README | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## Разработка

Запуск из исходников:

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

Запуск local web из исходников:

```bash
npm run web
# open http://127.0.0.1:3210
```

Полезные smoke checks:

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

Smoke scripts используют local mock provider, если явно не отмечены как real-provider tests.

## Release Notes

AgInTiFlow публикуется как `@lazyingart/agintiflow`. Предпочтительный release path — GitHub Actions Trusted Publishing с npm provenance. Local token publishing — только fallback для bootstrap; нельзя commit `.env`, `.npmrc`, npm tokens, OTPs или debug logs.

Полный release workflow: [../docs/npm-publishing.md](../docs/npm-publishing.md).

## Поддержка

Если проект полезен, можно поддержать разработку здесь:

| Support | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow разработан AgInTi Lab, LazyingArt LLC.
