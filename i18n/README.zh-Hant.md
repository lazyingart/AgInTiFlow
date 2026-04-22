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
![Express](https://img.shields.io/badge/Web-Express-111827)
![Models](https://img.shields.io/badge/Models-OpenAI%20%2B%20DeepSeek-0ea5e9)
![Sandbox](https://img.shields.io/badge/Shell-Docker%20Sandbox-f97316)
![Status](https://img.shields.io/badge/Status-Prototype-7c3aed)

AgInTiFlow 是 AgInTi 的瀏覽器與工具使用智能體，用於可控網站自動化、持久對話、可恢復執行，以及受防護的本地指令。

它適合需要 AI 代理執行工作的場景，但每個工具動作、日誌與會話狀態都必須可檢查、可追蹤、可恢復。

## 產品快照

| 領域 | 方向 |
| --- | --- |
| 核心循環 | Plan -> use tools -> log events -> finish or resume |
| 瀏覽器控制 | Playwright、延遲啟動瀏覽器、網域 allowlist |
| 模型層 | OpenAI 相容 tool calling，內建 OpenAI 與 DeepSeek 預設 |
| 本地工具 | 可選受防護 shell 指令，支援 Docker sandbox |
| 記憶 | 會話狀態、Web 設定保存、對話延續 |
| 操作者介面 | Provider 選擇、執行輸出、對話歷史 |

## 快速開始

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

開啟 `http://127.0.0.1:3210`。

執行 CLI 任務：

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder and summarize what each project is for"
```

從指定網站開始：

```bash
npm start -- --start-url https://news.ycombinator.com "Summarize this page"
```

恢復舊會話：

```bash
npm start -- --resume your-session-id
```

## Web UI

Web 介面包含：

- OpenAI / DeepSeek provider 下拉選單。
- 可編輯模型欄位，DeepSeek 可作為方便預設。
- Goal、start URL、allowed domains、working directory、max steps。
- Shell tool、Docker sandbox、headless browser、password typing、destructive actions 開關。
- 即時執行日誌，以及可延續的對話面板。

`Start URL` 只是建議值。只有當模型選擇瀏覽器工具時，瀏覽器才會啟動。

## 安全模型

AgInTiFlow 預設保守：

- 未明確啟用時禁止輸入密碼。
- 未明確啟用時禁止破壞性瀏覽器動作。
- 未啟用 shell tool 時禁止本地命令。
- Guarded shell mode 只允許少量常見檢查命令。
- Docker sandbox 會在無網路本地容器中執行 shell 命令。
- 所有工具請求與結果都會寫入結構化日誌。

## 設定

```bash
AGENT_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
OPENAI_API_KEY=...
DEEPSEEK_API_KEY=...
MAX_STEPS=15
HEADLESS=true
ALLOWED_DOMAINS=news.ycombinator.com,github.com
ALLOW_SHELL_TOOL=false
USE_DOCKER_SANDBOX=false
DOCKER_SANDBOX_IMAGE=agintiflow-sandbox:latest
COMMAND_CWD=/home/lachlan/ProjectsLFS/Agent
```

預設值：

| Provider | API key | Base URL | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-5.4-mini` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |

## Docker Bootstrap

Ubuntu helper：

```bash
./scripts/install-docker-ubuntu.sh
```

如果以 `root` 執行，並要讓一般使用者可不透過 `sudo` 使用 Docker：

```bash
DOCKER_TARGET_USER=lachlan ./scripts/install-docker-ubuntu.sh
```

完成後請開啟新的 login shell，或執行 `newgrp docker`，再測試非 root Docker 權限。

## 執行產物

每次 run 會在 `.sessions/<session-id>/` 保存狀態：

| File | Purpose |
| --- | --- |
| `state.json` | 可恢復的模型與工具狀態 |
| `plan.md` | 執行計畫 |
| `events.jsonl` | 結構化事件日誌 |
| `storage-state.json` | 瀏覽器 session 保存 |
| `artifacts/step-XXX.png` | 截圖 |
| `artifacts/step-XXX.snapshot.json` | DOM snapshot |

## 專案結構

```text
AgInTiFlow/
├── public/                 # Web UI
├── src/                    # Agent runtime, tools, guardrails, storage
├── docker/                 # Shell sandbox image
├── scripts/                # Docker bootstrap helper
├── logos/                  # Brand assets and crop notes
├── references/             # Design philosophy and research notes
├── tools/                  # Reusable project documentation helpers
├── run.js                  # CLI entrypoint
└── web.js                  # Express web server
```

## 開發

```bash
npm run check
```

此檢查會驗證 CLI、Web server 與 runtime modules 的 JavaScript 語法。

## README Prompt Tool

本 repo 包含一個小型 prompt helper，讓 README 潤色流程可重複：

```bash
node tools/readme_prompt_tool.js agintiflow
node tools/readme_prompt_tool.js aginti-landing
```

它描述本文件使用的風格：簡潔 overview、完整語言連結、產品訊號、快速開始、安全說明，以及多語 README 目標。
