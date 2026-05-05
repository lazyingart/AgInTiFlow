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

AgInTiFlow là không gian làm việc agent cục bộ trên Web và CLI cho các thư mục dự án thật. Nó kết hợp định tuyến mô hình chi phí thấp, thao tác công cụ có thể kiểm tra, phiên bền vững, hành động file/shell/browser có bảo vệ, tạo ảnh tùy chọn và giám sát có cấu trúc cho tác vụ lớn.

Nói ngắn gọn: chạy `aginti` trong một dự án, giao nhiệm vụ, xem kế hoạch, kiểm tra từng tool call, tiếp tục lại sau, và giữ kết quả trong workspace.

**Liên kết**

| Tài nguyên | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| README đầy đủ đã lưu trữ | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## Vì sao tồn tại

Phần lớn công cụ agent hoặc là một hộp chat với trạng thái ẩn, hoặc là một vòng lặp một mô hình rất đắt. AgInTiFlow theo một triết lý khác:

| Nguyên tắc | Ý nghĩa thực tế |
| --- | --- |
| Trí tuệ rẻ thay đổi kiến trúc | DeepSeek V4 Flash và Pro khiến việc dùng thêm call cho routing, scouting, review và recovery trở nên thực tế, thay vì ép một call đắt tiền làm tất cả. |
| Có thể kiểm tra tốt hơn bí ẩn | Plan, tool call, file diff, command output, canvas artifact và session event đều được lưu và có thể resume. |
| Mô hình theo vai trò | route, main, spare, wrapper và auxiliary image là các vai trò riêng. Bạn có thể dùng route model rẻ, main model mạnh hơn, route OpenAI/Qwen/Venice tùy chọn, và image tools GRS AI/Venice. |
| Scouts trước việc lớn | Parallel scouts có thể lập bản đồ architecture, tests, risks, symbols và integration points với chi phí thấp trước khi executor chính sửa file. |
| SCS cho việc rủi ro cao | Student-Committee-Supervisor mode thêm typed gate: committee phác thảo, student phê duyệt/giám sát, supervisor thực thi. Dùng `/scs` hoặc `--scs auto`. |
| AAPS cho workflow lớn | AAPS mô tả agentic pipeline script từ trên xuống; AgInTiFlow có thể là backend tương tác để validate, compile và execute các workflow đó. |
| An toàn cục bộ mặc định | Docker workspace, path guardrail, secret redaction, chặn npm publish/token commands và log hiển thị giúp agent hữu dụng nhưng không mờ đục. |

## Bắt đầu nhanh

Cài đặt và mở một dự án:

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

Ở lần dùng tương tác đầu tiên, nếu không tìm thấy key cho main model, AgInTiFlow mở auth wizard. Chọn DeepSeek, OpenAI, Qwen hoặc Venice, dán key, và key sẽ được lưu vào file `.aginti/.env` cục bộ của dự án với quyền hạn chế và bị git ignore. Bạn có thể chạy lại bất cứ lúc nào:

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

Chạy Web UI từ cùng dự án:

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

Chạy smoke test không cần credentials mô hình thật:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

Chọn ngôn ngữ rõ ràng, hoặc bỏ qua để dùng system locale:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## Lệnh hằng ngày

| Mục tiêu | Lệnh |
| --- | --- |
| Bắt đầu chat tương tác | `aginti` hoặc `aginti chat` |
| Bắt đầu web app cục bộ | `aginti web --port 3210` |
| Lưu provider keys | `aginti auth`, `/auth`, `/login` |
| Review repo hiện tại | `/review [focus]` |
| Bật/tắt SCS quality gate | `/scs` |
| Chỉ dùng SCS cho việc phức tạp | `/scs auto` hoặc `aginti --scs auto "task"` |
| Làm việc với AAPS workflows | `aginti aaps status`, `/aaps validate` |
| Chọn models | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| Bật shortcut Venice | `/venice` |
| Tạo ảnh | `/auxiliary image`, rồi mô tả ảnh |
| Resume dự án hiện tại | `aginti resume` |
| Xem mọi session | `aginti resume --all-sessions` |
| Queue vào session đang chạy | `aginti queue <session-id> "extra instruction"` |
| Dọn session trống | `aginti --remove-empty-sessions` |
| Kiểm tra capabilities | `aginti capabilities`, `aginti doctor --capabilities` |
| Sync skills đã review | `aginti skillmesh status`, `aginti skillmesh sync` |
| Cập nhật CLI | `aginti update` |

Interactive chat hỗ trợ slash completion, selector Up/Down, multiline input bằng `Ctrl+J`, full resume history, Markdown rendering, run status hiển thị, ASAP pipe message trong lúc chạy, và interrupt/resume sạch bằng `Ctrl+C`. Các command tương tác đã cài cũng kiểm tra npm để tìm bản AgInTiFlow mới và hiển thị selector update/skip; source checkout và non-TTY automation không bị ảnh hưởng.

Để one-shot resume với kiểm soát đầy đủ, dùng session id rõ ràng và chọn task profile có chủ đích. Dùng `auto` cho routing bình thường hoặc `android` cho việc Android/emulator:

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

## Ảnh chụp thật

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

Ảnh launch cũ được giữ trong source repository tại [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## Năng lực chính

| Năng lực | AgInTiFlow cung cấp |
| --- | --- |
| CLI agent workspace | Terminal chat bền vững với project cwd, session resume, model/tool state hiển thị và command hints rõ ràng. |
| Local web workspace | Browser UI cho sessions, runtime logs, artifacts, model settings, project controls, canvas previews và sandbox status. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | Host hoặc Docker workspace shell execution có guard, package-install policy và command safety checks. |
| Browser tools | Playwright browser actions với lazy startup và optional domain allowlists. |
| Model routing | Default DeepSeek fast/pro, manual OpenAI/Qwen/Venice/mock routes, spare models, wrapper models và auxiliary image models. |
| Patch workflow | Codex-style patch envelopes, unified diffs, exact replacements, hashes, compact diffs và path guardrails. |
| Parallel scouts | Optional scout calls cho architecture, implementation, review, tests, git flow, research, symbol tracing và dependency risk. |
| SCS mode | Optional Student-Committee-Supervisor quality gate cho tác vụ phức tạp hoặc rủi ro. |
| AAPS adapter | Optional `@lazyingart/aaps` integration cho `.aaps` workflow init, validate, parse, compile, dry-run và run. |
| Image generation | Optional GRS AI và Venice image tools với manifests đã lưu và canvas artifact previews. |
| Skill library | Built-in Markdown skills cho code, websites, Android/iOS, Python, Rust, Java, LaTeX, writing, reviews, GitHub, AAPS và nhiều hơn. |
| Skill Mesh | Optional strict skill recording/sharing cho reusable skill packs đã review. Nếu không dùng, AgInTiFlow chạy bình thường không background sharing. |
| Multilingual UI | CLI và docs hỗ trợ English, Japanese, Simplified/Traditional Chinese, Korean, French, Spanish, Arabic, Vietnamese, German và Russian. |

## Models và roles

AgInTiFlow không xem “the model” là một global setting duy nhất. Nó có các role:

| Role | Default | Mục đích |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | Planner rẻ, triage, short tasks, routing decisions. |
| Main | `deepseek/deepseek-v4-pro` | Coding phức tạp, debugging, writing, research, long tasks. |
| Spare | `openai/gpt-5.4` medium | Optional fallback hoặc cross-check route. |
| Wrapper | `codex/gpt-5.5` medium | Optional external coding-agent advisor. |
| Auxiliary | `grsai/nano-banana-2` | Image generation và helper tools không phải text. |

Selectors hữu ích:

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Venice routes có thể dùng cho optional uncensored hoặc creative work ít hạn chế hơn. DeepSeek vẫn là default kinh tế cho workflow engineering bình thường. Xem [../docs/model-selection.md](../docs/model-selection.md) và [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS và workflow lớn

AAPS là tầng pipeline-script; AgInTiFlow là backend agent/tool tương tác.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

Trong chat:

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

Dùng AAPS khi task lớn hơn một lần chat: app development có stages, paper/book workflows, validation gates, recovery steps, artifact production hoặc top-down agentic scripts. Xem [../docs/aaps.md](../docs/aaps.md) và package [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## Local API quick reference

Web app cung cấp local APIs cho UI và automation. Các endpoint này báo cáo trạng thái nhưng không lộ raw API keys hoặc npm tokens:

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

Chạy API smoke test không cần credentials:

```bash
npm run smoke:web-api
```

## Storage, safety và resume

AgInTiFlow lưu canonical sessions tập trung và chỉ giữ project-local pointers:

| Location | Purpose |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | Canonical state, events, browser state, artifacts, snapshots, canvas files. |
| `<project>/.aginti-sessions/` | Project-local session pointers và Web UI database. Git ignored. |
| `<project>/.aginti/.env` | Optional project-local API keys với restricted permissions. Git ignored. |
| `<project>/AGINTI.md` | Editable project instructions và durable local preferences. Safe to commit nếu không chứa secrets. |

Safety defaults:

- Docker workspace mode là default CLI/Web bình thường cho coding và artifact generation.
- File tools chặn secret-like paths, `.env`, `.git`, `node_modules` writes, absolute escapes, huge files và binary edits.
- Shell commands được policy check; npm publish, npm token commands, sudo, destructive git và credential reads bị chặn.
- File writes ghi hashes và compact diffs.
- Tool calls và results được log vào structured session events.
- Web và CLI dùng cùng session store, nên run có thể inspect và resume sau.

Runtime notes chi tiết ở [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md), [../docs/patch-tools.md](../docs/patch-tools.md) và [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## Cấu hình

Biến môi trường thường dùng:

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

Chi tiết thêm:

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## Bản đồ tài liệu

| Chủ đề | Liên kết |
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
| Full older README reference | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## Phát triển

Chạy từ source:

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

Khởi động local web từ source:

```bash
npm run web
# open http://127.0.0.1:3210
```

Smoke checks hữu ích:

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

Smoke scripts dùng local mock provider trừ khi được đánh dấu rõ là real-provider tests.

## Ghi chú phát hành

AgInTiFlow được phát hành dưới tên `@lazyingart/agintiflow`. Đường phát hành ưu tiên là GitHub Actions Trusted Publishing với npm provenance. Local token publishing chỉ là fallback cho bootstrapping và không bao giờ được commit `.env`, `.npmrc`, npm tokens, OTPs hoặc debug logs.

Xem workflow phát hành đầy đủ tại [../docs/npm-publishing.md](../docs/npm-publishing.md).

## Hỗ trợ

Nếu dự án này hữu ích, bạn có thể hỗ trợ phát triển tại đây:

| Support | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow được phát triển bởi AgInTi Lab, LazyingArt LLC.
