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

**وكلاء منخفضو التكلفة وواعون بالمشروع للمشكلات الواقعية.**

استخدم مساحة عمل الوكيل نفسها من Web أو CLI، مع توجيه DeepSeek/Venice/OpenAI، واستدعاءات أدوات مرئية، وجلسات دائمة، وscouts، وإشراف SCS، وسير عمل AAPS، وتنفيذ محلي محمي.

باختصار: شغّل `aginti` داخل مشروع، أعطه مهمة، افحص خطته، شاهد كل استدعاء أداة، استأنف لاحقاً، واحتفظ بالمخرجات داخل مساحة العمل.

**روابط**

| المورد | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| تموضع المنتج | [../references/agintiflow-product-positioning.md](../references/agintiflow-product-positioning.md) |
| مرجع README الكامل المؤرشف | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## لماذا يوجد

معظم أدوات الوكلاء إما صندوق دردشة بحالة مخفية أو حلقة نموذج واحد مكلفة. AgInTiFlow مبني على فلسفة مختلفة:

| المبدأ | معناه عملياً |
| --- | --- |
| الذكاء الرخيص يغير البنية | DeepSeek V4 Flash و Pro يجعلان من العملي إنفاق استدعاءات إضافية على routing و scouting و review و recovery بدلاً من إجبار استدعاء مكلف واحد على فعل كل شيء. |
| القابلية للفحص أفضل من الغموض | الخطط، استدعاءات الأدوات، file diffs، مخرجات الأوامر، canvas artifacts، وأحداث الجلسة تُحفظ ويمكن استئنافها. |
| نماذج حسب الأدوار | route و main و spare و wrapper و auxiliary image أدوار منفصلة. يمكنك جمع route models رخيصة، main models أقوى، مسارات OpenAI/Qwen/Venice اختيارية، وأدوات صور GRS AI/Venice. |
| Scouts قبل العمل الكبير | parallel scouts ترسم architecture و tests و risks و symbols و integration points بتكلفة قليلة قبل أن يعدّل المنفذ الرئيسي الملفات. |
| SCS للعمل عالي المخاطر | Student-Committee-Supervisor يضيف بوابة typed: committee يضع المسودة، student يوافق/يراقب، supervisor ينفذ. استخدم `/scs` أو `--scs auto`. |
| AAPS للـ workflows الكبيرة | AAPS يصف agentic pipeline scripts من الأعلى إلى الأسفل؛ ويمكن لـ AgInTiFlow أن يكون backend تفاعلياً للتحقق والترجمة والتنفيذ. |
| أمان محلي افتراضي | Docker workspace، path guardrails، secret redaction، حظر أوامر npm publish/token، وسجلات مرئية تجعل الوكيل عملياً وغير معتم. |

## بداية سريعة

ثبّت وافتح مشروعاً:

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

عند أول استخدام تفاعلي، يفتح AgInTiFlow معالج auth إذا لم يجد مفتاح main model. اختر DeepSeek أو OpenAI أو Qwen أو Venice، ألصق المفتاح، وسيُحفظ في ملف `.aginti/.env` المحلي للمشروع، وهو ignored من git وبصلاحيات مقيدة. يمكنك إعادة الإعداد في أي وقت:

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

شغّل Web UI من نفس المشروع:

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

شغّل smoke test من دون credentials لنموذج حي:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

حدد اللغة صراحة، أو اتركها لتتبع system locale:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## أوامر يومية

| الهدف | الأمر |
| --- | --- |
| بدء دردشة تفاعلية | `aginti` أو `aginti chat` |
| بدء تطبيق Web محلي | `aginti web --port 3210` |
| حفظ مفاتيح providers | `aginti auth`, `/auth`, `/login` |
| مراجعة repo الحالي | `/review [focus]` |
| تبديل SCS quality gate | `/scs` |
| استخدام SCS فقط للعمل المعقد | `/scs auto` أو `aginti --scs auto "task"` |
| العمل مع AAPS workflows | `aginti aaps status`, `/aaps validate` |
| اختيار النماذج | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| تفعيل shortcut لـ Venice | `/venice` |
| توليد الصور | `/auxiliary image` ثم اطلب الصورة |
| استئناف المشروع الحالي | `aginti resume` |
| تصفح كل الجلسات | `aginti resume --all-sessions` |
| إرسال queue إلى جلسة تعمل | `aginti queue <session-id> "extra instruction"` |
| تنظيف الجلسات الفارغة | `aginti --remove-empty-sessions` |
| فحص القدرات | `aginti capabilities`, `aginti doctor --capabilities` |
| مزامنة skills المراجعة | `aginti skillmesh status`, `aginti skillmesh sync` |
| تحديث CLI | `aginti update` |

الدردشة التفاعلية تدعم slash completion، selectors بأسهم Up/Down، إدخال متعدد الأسطر بـ `Ctrl+J`، سجل resume كامل، Markdown rendering، run status مرئي، رسائل ASAP pipe أثناء التشغيل، و interrupt/resume نظيف بـ `Ctrl+C`. الأوامر التفاعلية المثبتة تفحص npm أيضاً لوجود إصدار أحدث من AgInTiFlow وتعرض selector للتحديث/التخطي؛ أما source checkouts و non-TTY automation فلا تتأثر.

لـ one-shot resume مضبوط بالكامل، استخدم session id صريحاً واختر task profile بوضوح. استخدم `auto` للـ routing العادي أو `android` لأعمال Android/emulator:

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

## لقطات حقيقية

| تشغيل CLI | نظرة عامة على Web app |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| عناصر التحكم بالمهمة | مخرجات runtime |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| سجل المحادثة | حالة sandbox |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| نظرة mobile |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

لقطات التشغيل الأقدم محفوظة في source repository تحت [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## القدرات الأساسية

| القدرة | ما يقدمه AgInTiFlow |
| --- | --- |
| CLI agent workspace | دردشة terminal دائمة مع project cwd، session resume، حالة model/tool مرئية، وتلميحات أوامر واضحة. |
| Local web workspace | Browser UI للجلسات، runtime logs، artifacts، model settings، project controls، canvas previews، وحالة sandbox. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | تنفيذ shell محمي على host أو Docker workspace مع package-install policy و command safety checks. |
| Browser tools | Playwright browser actions مع lazy startup و optional domain allowlists. |
| Model routing | DeepSeek fast/pro defaults، مسارات OpenAI/Qwen/Venice/mock يدوية، spare models، wrapper models، و auxiliary image models. |
| Patch workflow | Codex-style patch envelopes، unified diffs، exact replacements، hashes، compact diffs، و path guardrails. |
| Parallel scouts | استدعاءات scout اختيارية لـ architecture و implementation و review و tests و git flow و research و symbol tracing و dependency risk. |
| SCS mode | Student-Committee-Supervisor quality gate اختياري للمهام المعقدة أو عالية المخاطر. |
| AAPS adapter | تكامل اختياري مع `@lazyingart/aaps` لـ `.aaps` workflow init و validate و parse و compile و dry-run و run. |
| Image generation | أدوات GRS AI و Venice اختيارية للصور مع manifests محفوظة و canvas artifact previews. |
| Skill library | Markdown skills مدمجة للبرمجة، المواقع، Android/iOS، Python، Rust، Java، LaTeX، الكتابة، reviews، GitHub، AAPS والمزيد. |
| Skill Mesh | تسجيل/مشاركة صارمة اختيارية لـ reusable skill packs تمت مراجعتها. إذا لم تستخدمها، يعمل AgInTiFlow طبيعياً دون background sharing. |
| Multilingual UI | CLI والوثائق تدعم English و Japanese و Simplified/Traditional Chinese و Korean و French و Spanish و Arabic و Vietnamese و German و Russian. |

## النماذج والأدوار

AgInTiFlow لا يتعامل مع “النموذج” كإعداد عالمي واحد. لديه أدوار:

| الدور | الافتراضي | الغرض |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | تخطيط رخيص، triage، مهام قصيرة، و routing decisions. |
| Main | `deepseek/deepseek-v4-pro` | coding معقد، debugging، writing، research، ومهام طويلة. |
| Spare | `openai/gpt-5.4` medium | fallback اختياري أو route للـ cross-check. |
| Wrapper | `codex/gpt-5.5` medium | مستشار coding-agent خارجي اختياري. |
| Auxiliary | `grsai/nano-banana-2` | توليد صور وأدوات مساعدة غير نصية. |

Selectors مفيدة:

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

يمكن استخدام Venice routes للأعمال الإبداعية الاختيارية uncensored أو الأقل تقييداً. يبقى DeepSeek هو default الاقتصادي لـ engineering workflows العادية. راجع [../docs/model-selection.md](../docs/model-selection.md) و [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS و workflows الكبيرة

AAPS هو طبقة pipeline-script؛ و AgInTiFlow هو backend تفاعلي للوكيل/الأدوات.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

داخل الدردشة:

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

استخدم AAPS عندما تكون المهمة أكبر من دردشة واحدة: تطوير تطبيقات بمراحل، workflows للأبحاث/الكتب، validation gates، recovery steps، artifact production، أو top-down agentic scripts. راجع [../docs/aaps.md](../docs/aaps.md) والحزمة [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## مرجع سريع للـ Local API

يعرض Web app APIs محلية للواجهة والأتمتة. هذه endpoints تعرض الحالة دون كشف API keys خام أو npm tokens:

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

شغّل API smoke test بلا credentials:

```bash
npm run smoke:web-api
```

## التخزين والأمان والاستئناف

يخزن AgInTiFlow canonical sessions مركزياً ويحتفظ فقط بمؤشرات project-local:

| الموقع | الغرض |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | canonical state، events، browser state، artifacts، snapshots، canvas files. |
| `<project>/.aginti-sessions/` | project-local session pointers و Web UI database. Ignored من git. |
| `<project>/.aginti/.env` | API keys اختيارية للمشروع بصلاحيات مقيدة. Ignored من git. |
| `<project>/AGINTI.md` | تعليمات مشروع قابلة للتحرير وتفضيلات محلية دائمة. آمن للـ commit إذا لم يحتوي أسراراً. |

إعدادات الأمان الافتراضية:

- Docker workspace mode هو default العادي للـ CLI/Web في coding عملي و artifact generation.
- File tools تحظر secret-like paths و `.env` و `.git` و `node_modules` writes و absolute escapes و huge files و binary edits.
- Shell commands تمر عبر policy checks؛ npm publish و npm token commands و sudo و destructive git و credential reads محظورة.
- File writes تسجل hashes و compact diffs.
- Tool calls والنتائج تُسجل في structured session events.
- Web و CLI يستخدمان نفس session store، لذلك يمكن inspect/resume لأي run لاحقاً.

ملاحظات runtime التفصيلية في [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md)، [../docs/patch-tools.md](../docs/patch-tools.md)، و [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## الإعداد

متغيرات البيئة الشائعة:

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

مفاتيح محلية للمشروع:

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

تفاصيل إضافية:

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## خريطة الوثائق

| الموضوع | الرابط |
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
| مرجع README الكامل السابق | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## التطوير

التشغيل من المصدر:

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

تشغيل local web من المصدر:

```bash
npm run web
# open http://127.0.0.1:3210
```

Smoke checks مفيدة:

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

تستخدم smoke scripts الـ local mock provider ما لم تكن معلّمة صراحة كاختبارات real-provider.

## ملاحظات الإصدار

ينشر AgInTiFlow باسم `@lazyingart/agintiflow`. المسار المفضل للإصدار هو GitHub Actions Trusted Publishing مع npm provenance. النشر المحلي بالتوكن هو fallback للـ bootstrap فقط، ولا يجب أبداً commit ملفات `.env` أو `.npmrc` أو npm tokens أو OTPs أو debug logs.

راجع [../docs/npm-publishing.md](../docs/npm-publishing.md) للـ release workflow الكامل.

## الدعم

إذا كان هذا المشروع مفيداً، يمكنك دعم التطوير هنا:

| الدعم | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

تم تطوير AgInTiFlow بواسطة AgInTi Lab, LazyingArt LLC.
