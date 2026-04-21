[English](README.md) · [العربية](i18n/README.ar.md) · [Español](i18n/README.es.md) · [Français](i18n/README.fr.md) · [日本語](i18n/README.ja.md) · [한국어](i18n/README.ko.md) · [Tiếng Việt](i18n/README.vi.md) · [中文 (简体)](i18n/README.zh-Hans.md) · [中文（繁體）](i18n/README.zh-Hant.md) · [Deutsch](i18n/README.de.md) · [Русский](i18n/README.ru.md)

[![LazyingArt banner](https://github.com/lachlanchen/lachlanchen/raw/main/figs/banner.png)](https://github.com/lachlanchen/lachlanchen/blob/main/figs/banner.png)

# 🐼 LazyingArtBot (LAB)

[![License: MIT](https://img.shields.io/badge/license-MIT-1f6feb.svg?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Node >= 22.12.0](https://img.shields.io/badge/node-%3E%3D22.12.0-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm workspace](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)](pnpm-workspace.yaml)
[![Upstream: openclaw/openclaw](https://img.shields.io/badge/upstream-openclaw%2Fopenclaw-111827?logo=github)](https://github.com/openclaw/openclaw)
[![Gateway](https://img.shields.io/badge/gateway-127.0.0.1%3A18789-0ea5e9)](#quick-start)
[![Version](https://img.shields.io/badge/version-2026.2.10-16a34a)](package.json)
[![skills/](https://img.shields.io/badge/skills-55_local-22c55e)](#skills-and-orchestration-surfaces)
[![.agents/skills](https://img.shields.io/badge/.agents%2Fskills-4_workflows-0284c7)](#skills-and-orchestration-surfaces)
[![orchestral/prompt_tools](https://img.shields.io/badge/orchestral%2Fprompt__tools-10_groups-f59e0b)](#skills-and-orchestration-surfaces)
[![Git submodules](https://img.shields.io/badge/submodules-11_recursive-8b5cf6)](#git-submodules)
[![i18n README](https://img.shields.io/badge/i18n-10_languages-0ea5e9)](i18n)
[![Docs](https://img.shields.io/badge/docs-Mintlify-06b6d4)](docs)
[![GitHub stars](https://img.shields.io/github/stars/lachlanchen/LazyingArtBot?logo=github)](https://github.com/lachlanchen/LazyingArtBot/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/lachlanchen/LazyingArtBot?logo=github)](https://github.com/lachlanchen/LazyingArtBot/issues)

> 🌍 **i18n status:** `i18n/` exists and currently includes localized README files for Arabic, German, Spanish, French, Japanese, Korean, Russian, Vietnamese, Simplified Chinese, and Traditional Chinese. This English README is the canonical source for incremental updates.

**LazyingArtBot** is my personal AI assistant stack for **lazying.art**, built on top of OpenClaw and adapted for daily workflows: multi-channel chat, local-first control, and email -> calendar/reminder/notes automation.

| 🔗 Link          | URL                                          | Focus                               |
| ---------------- | -------------------------------------------- | ----------------------------------- |
| 🌐 Website       | https://lazying.art                          | Primary domain and status dashboard |
| 🤖 Bot domain    | https://lab.lazying.art                      | Chat and assistant entrypoint       |
| 🧱 Upstream base | https://github.com/openclaw/openclaw         | OpenClaw platform foundation        |
| 📦 This repo     | https://github.com/lachlanchen/LazyingArtBot | LAB-specific adaptations            |

---

## Table of contents

- [Overview](#overview)
- [At a glance](#at-a-glance)
- [Features](#features)
- [Core capabilities](#core-capabilities)
- [Repository topology (Mermaid)](#repository-topology-mermaid)
- [Project structure](#project-structure)
- [Skills and orchestration surfaces](#skills-and-orchestration-surfaces)
- [Git submodules](#git-submodules)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Deployment modes](#deployment-modes)
- [LazyingArt workflow focus](#lazyingart-workflow-focus)
- [Orchestral philosophy](#orchestral-philosophy)
- [Prompt tools in LAB](#prompt-tools-in-lab)
- [Examples](#examples)
- [Development notes](#development-notes)
- [Troubleshooting](#troubleshooting)
- [LAB ecosystem integrations](#lab-ecosystem-integrations)
- [Install from source (quick reference)](#install-from-source-quick-reference)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [❤️ Support](#-support)
- [Contact](#contact)
- [License](#license)

---

## Overview

LAB focuses on practical personal productivity:

- ✅ Run one assistant across chat channels you already use.
- 🔐 Keep data and control on your own machine/server.
- 📬 Convert incoming email into structured actions (Calendar, Reminders, Notes).
- 🛡️ Add guardrails so automation is useful but still safe.

In short: less busywork, better execution.

---

## At a glance

| Area                            | Current baseline in this repo                             |
| ------------------------------- | --------------------------------------------------------- |
| Runtime                         | Node.js `>=22.12.0`                                       |
| Package manager                 | `pnpm@10.23.0`                                            |
| Core CLI                        | `openclaw`                                                |
| Default local gateway           | `127.0.0.1:18789`                                         |
| Default bridge port             | `127.0.0.1:18790`                                         |
| Primary docs                    | `docs/` (Mintlify)                                        |
| Primary LAB orchestration       | `orchestral/` + `orchestral/prompt_tools/`                |
| Skill surfaces                  | `skills/` (55 local skills) + `.agents/skills/` workflows |
| README i18n location            | `i18n/README.*.md`                                        |
| Git submodules (recursive view) | 11 entries (top-level + nested)                           |

---

## Features

- 🌐 Multi-channel assistant runtime with a local gateway.
- 🖥️ Browser dashboard/chat surface for local operations.
- 🧰 Tool-enabled automation pipeline (scripts + prompt-tools).
- 📨 Email triage and conversion into Notes, Reminders, and Calendar actions.
- 🧩 Plugin/extension ecosystem (`extensions/*`) for channels/providers/integrations.
- 📱 Multi-platform surfaces in-repo (`apps/macos`, `apps/ios`, `apps/android`, `ui`).
- 🧠 Layered skill system:
  - user-facing local skill catalog in `skills/`
  - maintainer workflow skills in `.agents/skills/`

---

## Core capabilities

| Capability                      | What it means in practice                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Multi-channel assistant runtime | Gateway + agent sessions across channels you enable                                                   |
| Web dashboard / chat            | Browser-based control surface for local operations                                                    |
| Tool-enabled workflows          | Shell + file + automation script execution chains                                                     |
| Email automation pipeline       | Parse mail, classify action type, route to Notes/Reminders/Calendar, log actions for review/debugging |

Pipeline steps preserved from current workflow:

- parse inbound mail
- classify action type
- save to Notes / Reminders / Calendar
- log every action for review and debugging

---

## Repository topology (Mermaid)

This section is the fast system map for operators. It explicitly highlights `skills/`, `.agents/skills/`, `orchestral/prompt_tools/`, and git submodules (including nested submodules visible in this checkout).

### System map

```mermaid
flowchart TD
  REPO["LazyingArtBot Repository"]

  REPO --> CORE["src/ + extensions/ + ui/ + apps/ + docs/"]
  REPO --> SKILLS["skills/\n(local skill catalog)"]
  REPO --> AGSKILLS[".agents/skills/\n(maintainer workflows)"]
  REPO --> ORCH["orchestral/"]
  REPO --> SUBS["git submodules (recursive)"]

  ORCH --> ORCH_PIPE["pipelines/ + pipelines.yml"]
  ORCH --> ORCH_PROMPTS["prompt_tools/"]
  ORCH --> ORCH_ACTORS["actors/ + scripts/ + config/ + references/"]

  ORCH_PROMPTS --> PT_RUNTIME["runtime/"]
  ORCH_PROMPTS --> PT_COMPANY["company/"]
  ORCH_PROMPTS --> PT_WEB["websearch/"]
  ORCH_PROMPTS --> PT_EMAIL["email/"]
  ORCH_PROMPTS --> PT_NOTES["notes/"]
  ORCH_PROMPTS --> PT_CAL["calendar/"]
  ORCH_PROMPTS --> PT_REM["reminders/"]
  ORCH_PROMPTS --> PT_MIG["migration/"]
  ORCH_PROMPTS --> PT_GIT["git/"]
  ORCH_PROMPTS --> PT_DOCS["docs/"]

  SUBS --> SUB_AGINTI["AgInTi/"]
  SUBS --> SUB_COOKBOOK["vendor/openai-cookbook"]
  SUBS --> SUB_STWS["vendor/SillyTavern-WebSearch-Selenium"]

  SUB_AGINTI --> SA_APPDEV["AutoAppDev"]
  SUB_AGINTI --> SA_NOVEL["AutoNovelWriter"]
  SUB_AGINTI --> SA_ORG["OrganoidAgent"]
  SUB_AGINTI --> SA_PAPER["PaperAgent"]
  SUB_AGINTI --> SA_LRE["LifeReverseEngineering"]

  SA_LRE --> SA_LEARN["learn (LazyLearn)"]
  SA_LRE --> SA_EARN["earn (LazyEarn)"]
  SA_LRE --> SA_IDEAS["IDEAS"]

  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0C4A6E;
  classDef orchestral fill:#FEF3C7,stroke:#D97706,color:#78350F;
  classDef skills fill:#DCFCE7,stroke:#16A34A,color:#14532D;
  classDef submodule fill:#F3E8FF,stroke:#7C3AED,color:#4C1D95;

  class REPO,CORE core;
  class ORCH,ORCH_PIPE,ORCH_PROMPTS,ORCH_ACTORS,PT_RUNTIME,PT_COMPANY,PT_WEB,PT_EMAIL,PT_NOTES,PT_CAL,PT_REM,PT_MIG,PT_GIT,PT_DOCS orchestral;
  class SKILLS,AGSKILLS skills;
  class SUBS,SUB_AGINTI,SUB_COOKBOOK,SUB_STWS,SA_APPDEV,SA_NOVEL,SA_ORG,SA_PAPER,SA_LRE,SA_LEARN,SA_EARN,SA_IDEAS submodule;
```

### Operator navigation map

```mermaid
flowchart LR
  START["Need to edit behavior?"] --> CHOICE{"What kind of change?"}

  CHOICE -->|Skill behavior| S1["skills/"]
  CHOICE -->|Maintainer workflow| S2[".agents/skills/"]
  CHOICE -->|Prompt-tool chain| S3["orchestral/prompt_tools/"]
  CHOICE -->|Runtime pipeline| S4["orchestral/pipelines/ or orchestral/actors/"]
  CHOICE -->|Dependency source| S5["git submodules\n(git submodule status --recursive)"]

  S1 --> S1A["Open SKILL.md + local scripts/references"]
  S2 --> S2A["review-pr -> prepare-pr -> merge-pr"]
  S3 --> S3A["Pick group: email/notes/calendar/reminders/websearch/company/git/docs/runtime"]
  S4 --> S4A["Check pipeline shell entrypoints + run artifacts"]
  S5 --> S5A["Inspect AgInTi + vendor/* nested repos"]
```

Assumption notes (from current local snapshot):

- `AgInTi/AutoNovelWriter`, `AgInTi/OrganoidAgent`, and `AgInTi/PaperAgent` are declared nested submodules but currently uninitialized.
- `AgInTi/LifeReverseEngineering` is initialized and present, but checked out at a commit that differs from the parent-recorded commit.
- `vendor/a2ui` exists as a vendored directory, not a declared git submodule in `.gitmodules`.

---

## Project structure

High-level repository layout:

```text
.
├─ src/                     # core runtime, gateway, channels, CLI, infra
├─ extensions/              # optional channel/provider/auth plugins
├─ skills/                  # local skill catalog (55 skill directories)
├─ .agents/skills/          # maintainer workflow skills + PR_WORKFLOW.md
├─ orchestral/              # LAB orchestration pipelines + prompt tools
├─ scripts/                 # build/dev/test/release/helpers
├─ ui/                      # web dashboard UI package
├─ apps/                    # macOS / iOS / Android apps
├─ docs/                    # Mintlify documentation
├─ references/              # LAB references and operating notes
├─ test/                    # test suites
├─ i18n/                    # localized README files
├─ vendor/                  # vendored and submodule-backed dependencies
├─ AgInTi/                  # ecosystem submodule tree
├─ .env.example             # environment template
├─ docker-compose.yml       # gateway + CLI containers
├─ README_OPENCLAW.md       # larger upstream-style reference README
└─ README.md                # this LAB-focused README
```

Notes:

- `orchestral/prompt_tools` is the canonical location for LAB Codex prompt-tooling.
- Root `i18n/` contains localized README variants.
- `.github/workflows.disabled/` is present in this snapshot; active CI behavior should be verified before relying on workflow assumptions.

---

## Skills and orchestration surfaces

### Quick navigation table

| Surface                    | Path                       | What to open first                                      | Typical reason                                     |
| -------------------------- | -------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Local skill catalog        | `skills/`                  | `skills/<skill-name>/SKILL.md`                          | User-facing skill behavior and local automations   |
| Maintainer workflow skills | `.agents/skills/`          | `.agents/skills/PR_WORKFLOW.md`                         | PR triage/review/prepare/merge flow                |
| Orchestral pipelines       | `orchestral/pipelines/`    | shell entrypoint for the pipeline                       | Scheduled and deterministic runs                   |
| Prompt-tool groups         | `orchestral/prompt_tools/` | target group folder (`email`, `notes`, `runtime`, etc.) | Tool contracts and chain composition               |
| Submodule roots            | `AgInTi/`, `vendor/*`      | `.gitmodules` + `git submodule status --recursive`      | Cross-repo dependency and upstream source tracking |

### `skills/` (local skill catalog)

