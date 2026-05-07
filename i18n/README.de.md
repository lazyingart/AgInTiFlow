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

**Günstige, projektbewusste Agenten für reale Probleme.**

AgInTiFlow ist ein project-aware Agent-Workspace für hybride Wet-Dry-R&D, hardware-aware Intelligence, Software-Automatisierung und industrielle Workflows. Von Laborplanung zu Datenanalyse, von Hardwaresteuerung zu Produktionsskripten und von Mikroskopie, Drohnen und Robotern zu Berichten hilft es Agenten, über API, Web oder CLI mit SCS-Supervision, AAPS-Workflows, geschützter Ausführung und dauerhafter Evidenz zu arbeiten.

Kurz gesagt: Führe `aginti` in einem Projekt aus, gib eine Aufgabe vor, prüfe den Plan, sieh jeden Tool-Call, setze später fort und behalte die Ergebnisse im Workspace.

**Links**

| Ressource | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| Produktpositionierung | [../references/agintiflow-product-positioning.md](../references/agintiflow-product-positioning.md) |
| Vollständig archivierte README | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## Warum es existiert

Die meisten Agenten-Tools sind entweder Chatboxen mit verborgenem Zustand oder teure Ein-Modell-Schleifen. AgInTiFlow folgt einer anderen Philosophie:

| Prinzip | Praktische Bedeutung |
| --- | --- |
| Günstige Intelligenz verändert die Architektur | DeepSeek V4 Flash und Pro machen zusätzliche Calls für Routing, Scouts, Review und Recovery praktisch, statt alles in einen teuren Call zu pressen. |
| Prüfbarkeit statt Geheimnis | Pläne, Tool-Calls, Datei-Diffs, Kommandoausgaben, Canvas-Artefakte und Session-Events werden gespeichert und sind fortsetzbar. |
| Rollenbasierte Modelle | Route, main, spare, wrapper und auxiliary image sind getrennte Rollen. Günstige Route-Modelle, stärkere Main-Modelle, optionale OpenAI/Qwen/Venice-Routen und GRS AI/Venice-Bildtools können kombiniert werden. |
| Scouts vor großer Arbeit | Parallele Scouts kartieren Architektur, Tests, Risiken, Symbole und Integrationspunkte, bevor der Hauptexecutor Dateien ändert. |
| SCS für riskante Arbeit | Student-Committee-Supervisor fügt ein typisiertes Gate hinzu: committee entwirft, student genehmigt/überwacht, supervisor führt aus. Nutze `/scs` oder `--scs auto`. |
| AAPS für große Workflows | AAPS beschreibt top-down agentic pipeline scripts; AgInTiFlow kann das interaktive Backend zum Validieren, Kompilieren und Ausführen sein. |
| Lokale Sicherheit als Standard | Docker workspace, Pfad-Guardrails, Secret-Redaction, Blockieren von npm publish/token-Kommandos und sichtbare Logs halten den Agenten praktisch und transparent. |

## Schnellstart

Installieren und Projekt öffnen:

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

Beim ersten interaktiven Start öffnet AgInTiFlow einen Auth-Wizard, wenn kein Main-Model-Key gefunden wird. Wähle DeepSeek, OpenAI, Qwen oder Venice, füge den Key ein, und er wird in der git-ignorierten projektlokalen Datei `.aginti/.env` mit eingeschränkten Rechten gespeichert. Setup kann jederzeit erneut laufen:

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

Web UI aus demselben Projekt starten:

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

Smoke-Test ohne echte Modell-Credentials:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

Sprache explizit wählen oder weglassen, um der System-Locale zu folgen:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## Tägliche Kommandos

| Ziel | Kommando |
| --- | --- |
| Interaktiven Chat starten | `aginti` oder `aginti chat` |
| Lokale Web-App starten | `aginti web --port 3210` |
| Provider-Keys speichern | `aginti auth`, `/auth`, `/login` |
| Aktuelles Repo reviewen | `/review [focus]` |
| SCS-Quality-Gate umschalten | `/scs` |
| SCS nur für komplexe Arbeit nutzen | `/scs auto` oder `aginti --scs auto "task"` |
| Mit AAPS-Workflows arbeiten | `aginti aaps status`, `/aaps validate` |
| Modelle wählen | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| Venice-Shortcut aktivieren | `/venice` |
| Bilder erzeugen | `/auxiliary image`, danach Bild beschreiben |
| Aktuelles Projekt fortsetzen | `aginti resume` |
| Alle Sessions durchsuchen | `aginti resume --all-sessions` |
| In laufende Session einreihen | `aginti queue <session-id> "extra instruction"` |
| Leere Sessions bereinigen | `aginti --remove-empty-sessions` |
| Capabilities prüfen | `aginti capabilities`, `aginti doctor --capabilities` |
| Geprüfte Skills synchronisieren | `aginti skillmesh status`, `aginti skillmesh sync` |
| CLI aktualisieren | `aginti update` |

Der interaktive Chat unterstützt Slash-Completion, Up/Down-Selectoren, mehrzeilige Eingabe mit `Ctrl+J`, vollständige Resume-History, Markdown-Rendering, sichtbaren Run-Status, ASAP-Pipe-Nachrichten während eines Runs und saubere Unterbrechung/Fortsetzung mit `Ctrl+C`. Installierte interaktive Kommandos prüfen außerdem npm auf neue AgInTiFlow-Versionen und zeigen einen Update/Skip-Selector; Source-Checkouts und Non-TTY-Automation bleiben ungestört.

Für eine vollständig kontrollierte One-Shot-Fortsetzung nutze eine explizite session id und wähle das Task-Profil bewusst. `auto` ist für normales Routing, `android` für Android/Emulator-Arbeit:

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

## Echte Screenshots

| CLI-Start | Web-App-Überblick |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| Task-Steuerung | Runtime-Ausgabe |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| Gesprächsverlauf | Sandbox-Status |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| Mobile Übersicht |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

Ältere Launch-Screenshots liegen im Source-Repository unter [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## Kernfähigkeiten

| Fähigkeit | Was AgInTiFlow bietet |
| --- | --- |
| CLI-Agenten-Workspace | Persistenter Terminal-Chat mit Projekt-cwd, Session-Resume, sichtbarem Modell/Tool-Status und klaren Command-Hints. |
| Lokaler Web-Workspace | Browser-UI für Sessions, Runtime-Logs, Artefakte, Modellsettings, Projektkontrollen, Canvas-Previews und Sandbox-Status. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | Geschützte Host- oder Docker-workspace-Shell mit Package-Install-Policy und Command-Safety-Checks. |
| Browser tools | Playwright-Aktionen mit Lazy Startup und optionalen Domain-Allowlists. |
| Model routing | DeepSeek fast/pro Defaults, manuelle OpenAI/Qwen/Venice/mock Routen, spare models, wrapper models und auxiliary image models. |
| Patch workflow | Codex-style Patch-Envelopes, unified diffs, exakte Ersetzungen, Hashes, kompakte Diffs und Pfad-Guardrails. |
| Parallel scouts | Optionale Scout-Calls für Architektur, Implementierung, Review, Tests, Git-Flow, Research, Symbol-Tracing und Dependency-Risiken. |
| SCS mode | Optionales Student-Committee-Supervisor Quality Gate für komplizierte oder riskante Aufgaben. |
| AAPS adapter | Optionale `@lazyingart/aaps` Integration für `.aaps` workflow init, validate, parse, compile, dry-run und run. |
| Image generation | Optionale GRS AI und Venice Image Tools mit gespeicherten Manifests und Canvas-Previews. |
| Skill library | Eingebaute Markdown-Skills für Code, Websites, Android/iOS, Python, Rust, Java, LaTeX, Writing, Reviews, GitHub, AAPS und mehr. |
| Skill Mesh | Optionales striktes Recording/Sharing geprüfter wiederverwendbarer Skill-Packs. Ohne Nutzung läuft AgInTiFlow normal ohne Hintergrund-Sharing. |
| Mehrsprachige UI | CLI und Docs für Englisch, Japanisch, vereinfachtes/traditionelles Chinesisch, Koreanisch, Französisch, Spanisch, Arabisch, Vietnamesisch, Deutsch und Russisch. |

## Modelle und Rollen

AgInTiFlow behandelt “das Modell” nicht als eine globale Einstellung. Es gibt Rollen:

| Rolle | Default | Zweck |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | Günstiger Planner, Triage, kurze Tasks, Routing-Entscheidungen. |
| Main | `deepseek/deepseek-v4-pro` | Komplexes Coding, Debugging, Writing, Research, lange Tasks. |
| Spare | `openai/gpt-5.4` medium | Optionales Fallback oder Cross-Check-Route. |
| Wrapper | `codex/gpt-5.5` medium | Optionaler externer Coding-Agent-Berater. |
| Auxiliary | `grsai/nano-banana-2` | Bilderzeugung und weitere Non-Text-Hilfstools. |

Nützliche Selector-Kommandos:

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Venice-Routen können für optionale uncensored oder weniger eingeschränkte kreative Arbeit genutzt werden. DeepSeek bleibt der wirtschaftliche Standard für normale Engineering-Workflows. Siehe [../docs/model-selection.md](../docs/model-selection.md) und [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS und große Workflows

AAPS ist die Pipeline-Script-Schicht; AgInTiFlow ist das interaktive Agent/Tool-Backend.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

Im Chat:

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

Nutze AAPS, wenn die Aufgabe größer als ein einzelner Chat ist: App-Entwicklung mit Stages, Paper/Book-Workflows, Validation Gates, Recovery Steps, Artifact-Produktion oder top-down agentic scripts. Siehe [../docs/aaps.md](../docs/aaps.md) und das Paket [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## Lokale API-Kurzreferenz

Die Web-App stellt lokale APIs für UI und Automation bereit. Diese Endpoints melden Status, ohne rohe API-Keys oder npm tokens offenzulegen:

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

Credential-freien API-Smoke-Test ausführen:

```bash
npm run smoke:web-api
```

## Storage, Sicherheit und Resume

AgInTiFlow speichert kanonische Sessions zentral und hält projektlokal nur Pointer:

| Ort | Zweck |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | Kanonischer Zustand, Events, Browser-State, Artefakte, Snapshots, Canvas-Dateien. |
| `<project>/.aginti-sessions/` | Projektlokale Session-Pointer und Web-UI-Datenbank. Git-ignored. |
| `<project>/.aginti/.env` | Optionale projektlokale API-Keys mit eingeschränkten Rechten. Git-ignored. |
| `<project>/AGINTI.md` | Editierbare Projektinstruktionen und dauerhafte lokale Präferenzen. Commit-sicher, wenn keine Secrets enthalten sind. |

Sicherheitsdefaults:

- Docker workspace mode ist der normale CLI/Web-Default für praktisches Coding und Artifact-Erzeugung.
- File tools blockieren secret-artige Pfade, `.env`, `.git`, `node_modules` writes, absolute escapes, riesige Dateien und Binary Edits.
- Shell-Kommandos werden policy-geprüft; npm publish, npm token commands, sudo, destruktives git und Credential Reads werden blockiert.
- Dateiänderungen protokollieren Hashes und kompakte Diffs.
- Tool-Calls und Ergebnisse werden in strukturierten Session-Events geloggt.
- Web und CLI nutzen denselben Session Store, sodass Runs später geprüft und fortgesetzt werden können.

Details: [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md), [../docs/patch-tools.md](../docs/patch-tools.md), [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## Konfiguration

Häufige Umgebungsvariablen:

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

Projektlokale Keys:

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

Mehr Details:

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## Dokumentationskarte

| Thema | Link |
| --- | --- |
| AAPS adapter | [../docs/aaps.md](../docs/aaps.md) |
| Modellwahl und Rollen | [../docs/model-selection.md](../docs/model-selection.md) |
| SCS mode | [../docs/student-committee-supervisor.md](../docs/student-committee-supervisor.md) |
| Large-codebase engineering | [../docs/large-codebase-engineering.md](../docs/large-codebase-engineering.md) |
| Runtime modes and autonomy | [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md) |
| Skills and tools | [../docs/skills-and-tools.md](../docs/skills-and-tools.md) |
| Skill Mesh | [../docs/skillmesh.md](../docs/skillmesh.md) |
| Housekeeping logs | [../docs/housekeeping.md](../docs/housekeeping.md) |
| npm publishing | [../docs/npm-publishing.md](../docs/npm-publishing.md) |
| Product roadmap | [../docs/productive-agent-roadmap.md](../docs/productive-agent-roadmap.md) |
| Supervised capability curriculum | [../docs/supervised-capability-curriculum.md](../docs/supervised-capability-curriculum.md) |
| Vollständige ältere README | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## Entwicklung

Aus dem Source ausführen:

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

Lokales Web aus dem Source starten:

```bash
npm run web
# open http://127.0.0.1:3210
```

Nützliche Smoke-Checks:

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

Smoke-Skripte nutzen den lokalen Mock-Provider, sofern sie nicht explizit als Real-Provider-Tests markiert sind.

## Release Notes

AgInTiFlow wird als `@lazyingart/agintiflow` veröffentlicht. Bevorzugt ist GitHub Actions Trusted Publishing mit npm provenance. Lokales Token-Publishing ist nur Bootstrap-Fallback und darf niemals `.env`, `.npmrc`, npm tokens, OTPs oder debug logs committen.

Siehe [../docs/npm-publishing.md](../docs/npm-publishing.md) für den vollständigen Release-Workflow.

## Support

Wenn dieses Projekt nützlich ist, kannst du die Entwicklung hier unterstützen:

| Support | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow wird von AgInTi Lab, LazyingArt LLC entwickelt.
