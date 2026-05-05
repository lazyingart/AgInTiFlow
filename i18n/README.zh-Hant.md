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

AgInTiFlow 是面向真實專案資料夾的本地 Web 與 CLI 智能體工作區。它結合低成本模型路由、可檢查的工具使用、可持久化會話、受保護的檔案/shell/瀏覽器操作、可選圖像生成，以及結構化的大型任務監督。

簡短理解：在專案目錄執行 `aginti`，交給它一個任務，檢查它的計畫，看見每一次工具呼叫，之後還能恢復會話，並把輸出保留在你的工作區裡。

**連結**

| 資源 | URL |
| --- | --- |
| 網站 | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| 完整歸檔 README 參考 | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## 為什麼存在

大多數智能體工具不是只有帶隱藏狀態的聊天框，就是昂貴的單模型迴圈。AgInTiFlow 採用另一種設計哲學：

| 原則 | 實際含義 |
| --- | --- |
| 便宜的智能會改變架構 | DeepSeek V4 Flash 和 Pro 讓路由、偵察、審查、恢復這些額外呼叫變得實際，而不是強迫一次昂貴呼叫完成所有事情。 |
| 可檢查勝過神秘 | 計畫、工具呼叫、檔案 diff、命令輸出、畫布產物和會話事件都會保存並可恢復。 |
| 基於角色的模型 | route、main、spare、wrapper、auxiliary image 是分開角色。你可以使用便宜路由模型、更強主模型、可選 OpenAI/Qwen/Venice 路線，以及 GRS AI/Venice 圖像工具。 |
| 大任務前先 scouts | 並行 scouts 可以低成本繪製架構、測試、風險、符號和整合點，再讓主執行器編輯檔案。 |
| SCS 用於高風險工作 | Student-Committee-Supervisor 模式增加類型化關卡：committee 起草，student 批准/監控，supervisor 執行。使用 `/scs` 或 `--scs auto`。 |
| AAPS 用於大型流程 | AAPS 描述自頂向下的智能體流水線腳本；AgInTiFlow 可作為互動式後端驗證、編譯與執行這些流程。 |
| 預設本地安全 | Docker workspace、路徑保護、密鑰脫敏、阻止 npm publish/token 命令、可見日誌，讓智能體實用但不黑箱。 |

## 快速開始

安裝並打開一個專案：

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

第一次互動式使用時，如果找不到主模型密鑰，AgInTiFlow 會開啟認證精靈。選擇 DeepSeek、OpenAI、Qwen 或 Venice，貼上密鑰，它會保存到被忽略的專案本地 `.aginti/.env` 檔案，並使用受限權限。你可以隨時重新執行設定：

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

從同一專案啟動 Web UI：

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

沒有真實模型憑據時也可以用本地 mock 做冒煙測試：

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

明確指定語言，或省略以跟隨系統 locale：

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## 日常命令

| 目標 | 命令 |
| --- | --- |
| 啟動互動式聊天 | `aginti` 或 `aginti chat` |
| 啟動本地 Web 應用 | `aginti web --port 3210` |
| 保存 provider 密鑰 | `aginti auth`, `/auth`, `/login` |
| 審查當前倉庫 | `/review [focus]` |
| 切換 SCS 品質關卡 | `/scs` |
| 只在複雜工作使用 SCS | `/scs auto` 或 `aginti --scs auto "task"` |
| 使用 AAPS 流程 | `aginti aaps status`, `/aaps validate` |
| 選擇模型 | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| 啟用 Venice 快捷模式 | `/venice` |
| 生成圖像 | `/auxiliary image`，然後描述圖像需求 |
| 恢復當前專案 | `aginti resume` |
| 瀏覽全部會話 | `aginti resume --all-sessions` |
| 向執行中會話排隊 | `aginti queue <session-id> "extra instruction"` |
| 清理空會話 | `aginti --remove-empty-sessions` |
| 檢查能力 | `aginti capabilities`, `aginti doctor --capabilities` |
| 同步已審查技能 | `aginti skillmesh status`, `aginti skillmesh sync` |
| 更新 CLI | `aginti update` |

互動式聊天支援 slash 補全、Up/Down 選擇器、用 `Ctrl+J` 輸入多行、完整恢復歷史、Markdown 渲染、可見執行狀態、執行期間的 ASAP pipe 訊息，以及用 `Ctrl+C` 乾淨中斷/恢復。已安裝的互動命令也會檢查 npm 是否有新版 AgInTiFlow，並顯示更新/跳過選擇器；源碼 checkout 和非 TTY 自動化不會被打擾。

如果需要完全可控的一次性恢復，使用明確 session id，並主動選擇任務 profile。普通路由用 `auto`，Android/模擬器相關工作用 `android`：

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

## 真實截圖

| CLI 啟動 | Web 應用概覽 |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| 任務控制 | 執行輸出 |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| 對話歷史 | 沙箱狀態 |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| 行動端概覽 |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

舊版啟動截圖保留在源碼倉庫的 [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive)。

## 核心能力

| 能力 | AgInTiFlow 提供什麼 |
| --- | --- |
| CLI 智能體工作區 | 持久終端聊天，帶專案 cwd、會話恢復、可見模型/工具狀態和清晰命令提示。 |
| 本地 Web 工作區 | 瀏覽器 UI，包含會話、執行日誌、產物、模型設定、專案控制、畫布預覽和沙箱狀態。 |
| 檔案工具 | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`。 |
| Shell 工具 | 受保護的 host 或 Docker workspace shell 執行，帶套件安裝策略和命令安全檢查。 |
| 瀏覽器工具 | Playwright 瀏覽器操作，延遲啟動，並可配置 domain allowlist。 |
| 模型路由 | DeepSeek fast/pro 預設值，手動 OpenAI/Qwen/Venice/mock 路線，spare 模型、wrapper 模型和輔助圖像模型。 |
| Patch 工作流 | Codex 風格 patch envelope、統一 diff、精確替換、hash、緊湊 diff 和路徑保護。 |
| 並行 scouts | 可選 scout 呼叫，用於架構、實作、審查、測試、git 流程、研究、符號追蹤和依賴風險。 |
| SCS 模式 | 可選 Student-Committee-Supervisor 品質關卡，用於複雜或高風險任務。 |
| AAPS adapter | 可選 `@lazyingart/aaps` 整合，用於 `.aaps` 流程 init、validate、parse、compile、dry-run 和 run。 |
| 圖像生成 | 可選 GRS AI 和 Venice 圖像工具，帶保存的 manifest 和畫布產物預覽。 |
| 技能庫 | 內建 Markdown 技能，覆蓋程式碼、網站、Android/iOS、Python、Rust、Java、LaTeX、寫作、審查、GitHub、AAPS 等。 |
| Skill Mesh | 可選、嚴格的技能記錄/共享，用於經審查的可複用技能包。不使用時，AgInTiFlow 正常執行，不進行背景共享。 |
| 多語言 UI | CLI 與文件支援英語、日語、簡體/繁體中文、韓語、法語、西班牙語、阿拉伯語、越南語、德語和俄語。 |

## 模型與角色

AgInTiFlow 不把「模型」當成一個全域設定。它有多個角色：

| 角色 | 預設值 | 用途 |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | 低成本規劃、分流、短任務和路由決策。 |
| Main | `deepseek/deepseek-v4-pro` | 複雜編碼、除錯、寫作、研究和長任務。 |
| Spare | `openai/gpt-5.4` medium | 可選 fallback 或交叉檢查路線。 |
| Wrapper | `codex/gpt-5.5` medium | 可選外部 coding agent 顧問。 |
| Auxiliary | `grsai/nano-banana-2` | 圖像生成和其他非文字輔助工具。 |

常用選擇器：

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Venice 路線可用於可選的 uncensored 或限制較少的創意工作。DeepSeek 仍然是普通工程工作流的經濟預設值。見 [../docs/model-selection.md](../docs/model-selection.md) 和 [../references/venice-model-reference.md](../references/venice-model-reference.md)。

## AAPS 與大型流程

AAPS 是 pipeline-script 層；AgInTiFlow 是互動式智能體/工具後端。

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

聊天內：

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

當任務大於一次聊天時使用 AAPS：帶階段的應用開發、論文/書籍流程、驗證關卡、恢復步驟、產物生產，或自頂向下的智能體腳本。見 [../docs/aaps.md](../docs/aaps.md) 和 package [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps)。

## 本地 API 快速參考

Web 應用暴露本地 API，供 UI 和自動化使用。這些 endpoint 會報告狀態，但不會暴露原始 API key 或 npm token：

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

執行無憑據 API 冒煙測試：

```bash
npm run smoke:web-api
```

## 儲存、安全與恢復

AgInTiFlow 將 canonical session 集中儲存，只在專案本地保留指標：

| 位置 | 用途 |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | canonical 狀態、事件、瀏覽器狀態、產物、快照、畫布檔案。 |
| `<project>/.aginti-sessions/` | 專案本地會話指標和 Web UI 資料庫。被 git 忽略。 |
| `<project>/.aginti/.env` | 可選專案本地 API key，權限受限。被 git 忽略。 |
| `<project>/AGINTI.md` | 可編輯的專案說明和持久本地偏好。如果沒有密鑰，可安全提交。 |

預設安全策略：

- Docker workspace mode 是普通 CLI/Web 編碼與產物生成的預設模式。
- 檔案工具會阻止類似 secret 的路徑、`.env`、`.git`、`node_modules` 寫入、絕對路徑逃逸、大檔案和二進位編輯。
- Shell 命令會經過策略檢查；npm publish、npm token 命令、sudo、破壞性 git 和憑據讀取會被阻止。
- 檔案寫入會記錄 hash 和緊湊 diff。
- 工具呼叫和結果會記錄到結構化 session events。
- Web 與 CLI 使用同一個 session store，因此執行可以之後檢查和恢復。

詳細執行時說明見 [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md)、[../docs/patch-tools.md](../docs/patch-tools.md) 和 [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md)。

## 配置

常用環境變數：

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

專案本地密鑰：

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

更多細節：

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## 文件地圖

| 主題 | 連結 |
| --- | --- |
| AAPS adapter | [../docs/aaps.md](../docs/aaps.md) |
| 模型選擇與角色 | [../docs/model-selection.md](../docs/model-selection.md) |
| SCS 模式 | [../docs/student-committee-supervisor.md](../docs/student-committee-supervisor.md) |
| 大型程式碼庫工程 | [../docs/large-codebase-engineering.md](../docs/large-codebase-engineering.md) |
| 執行模式與自主性 | [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md) |
| 技能與工具 | [../docs/skills-and-tools.md](../docs/skills-and-tools.md) |
| Skill Mesh | [../docs/skillmesh.md](../docs/skillmesh.md) |
| Housekeeping 日誌 | [../docs/housekeeping.md](../docs/housekeeping.md) |
| npm 發布 | [../docs/npm-publishing.md](../docs/npm-publishing.md) |
| 產品路線圖 | [../docs/productive-agent-roadmap.md](../docs/productive-agent-roadmap.md) |
| 監督式能力課程 | [../docs/supervised-capability-curriculum.md](../docs/supervised-capability-curriculum.md) |
| 舊版完整 README 參考 | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## 開發

從源碼執行：

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

從源碼啟動本地 Web：

```bash
npm run web
# open http://127.0.0.1:3210
```

常用冒煙檢查：

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

除非明確標記為真實 provider 測試，smoke scripts 使用本地 mock provider。

## 發布說明

AgInTiFlow 以 `@lazyingart/agintiflow` 發布。推薦發布路徑是 GitHub Actions Trusted Publishing 與 npm provenance。本地 token 發布只適合 bootstrap fallback，絕不能提交 `.env`、`.npmrc`、npm token、OTP 或 debug logs。

完整發布流程見 [../docs/npm-publishing.md](../docs/npm-publishing.md)。

## 支持

如果這個專案對你有用，可以在這裡支持開發：

| 支持 | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow 由 AgInTi Lab, LazyingArt LLC 開發。
