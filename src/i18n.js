export const SUPPORTED_LANGUAGES = [
  "en",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "fr",
  "es",
  "ar",
  "vi",
  "de",
  "ru",
];

export const LANGUAGE_LABELS = {
  en: "English",
  ja: "日本語",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ko: "한국어",
  fr: "Français",
  es: "Español",
  ar: "العربية",
  vi: "Tiếng Việt",
  de: "Deutsch",
  ru: "Русский",
};

const LANGUAGE_ALIASES = new Map(
  Object.entries({
    "": "",
    auto: "",
    system: "",
    default: "",
    en: "en",
    eng: "en",
    english: "en",
    ja: "ja",
    jp: "ja",
    jpn: "ja",
    japanese: "ja",
    "日本語": "ja",
    cn: "zh-Hans",
    zh: "zh-Hans",
    "cn-s": "zh-Hans",
    "cn_s": "zh-Hans",
    cns: "zh-Hans",
    "zh-s": "zh-Hans",
    "zh_s": "zh-Hans",
    zhs: "zh-Hans",
    simplified: "zh-Hans",
    simplifiedchinese: "zh-Hans",
    "zh-cn": "zh-Hans",
    "zh_cn": "zh-Hans",
    "zh-hans": "zh-Hans",
    "zh_hans": "zh-Hans",
    zhhans: "zh-Hans",
    "zh-sg": "zh-Hans",
    "zh_sg": "zh-Hans",
    "简体": "zh-Hans",
    "简体中文": "zh-Hans",
    "cn-t": "zh-Hant",
    "cn_t": "zh-Hant",
    cnt: "zh-Hant",
    "zh-t": "zh-Hant",
    "zh_t": "zh-Hant",
    zht: "zh-Hant",
    traditional: "zh-Hant",
    traditionalchinese: "zh-Hant",
    "zh-tw": "zh-Hant",
    "zh_tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh_hk": "zh-Hant",
    "zh-mo": "zh-Hant",
    "zh_mo": "zh-Hant",
    "zh-hant": "zh-Hant",
    "zh_hant": "zh-Hant",
    zhhant: "zh-Hant",
    "繁體": "zh-Hant",
    "繁體中文": "zh-Hant",
    ko: "ko",
    kr: "ko",
    kor: "ko",
    korean: "ko",
    "한국어": "ko",
    fr: "fr",
    fra: "fr",
    french: "fr",
    français: "fr",
    es: "es",
    spa: "es",
    spanish: "es",
    español: "es",
    ar: "ar",
    ara: "ar",
    arabic: "ar",
    "العربية": "ar",
    vi: "vi",
    vie: "vi",
    vietnamese: "vi",
    "tiếngviệt": "vi",
    de: "de",
    deu: "de",
    ger: "de",
    german: "de",
    deutsch: "de",
    ru: "ru",
    rus: "ru",
    russian: "ru",
    русский: "ru",
  })
);

const TRANSLATIONS = {
  en: {
    launchSubtitle: "web-first agent workspace",
    launchCredit: "Developed by AgInTi Lab, LazyingArt LLC",
    launchTagline: "browser + shell + files + docker + web search + scouts",
    interactiveIntro: "Interactive agent chat. Type /help for commands, /exit to quit.",
    promptEmpty: "type a request, /help, Enter to send, Ctrl+J for newline",
    helpTitle: "Commands:",
    helpHelp: "Show this help.",
    helpStatus: "Show active route, workspace, sandbox, and session.",
    helpLogin: "Pick, paste, and save project-local API keys.",
    helpInstructions: "Show AGINTI.md project instructions status.",
    helpModels: "Show route/main/spare/wrapper/auxiliary model roles.",
    helpVenice: "Pick Venice route/main models, or restore DeepSeek defaults.",
    helpRoute: "Open route selector, or set routing/fast route model.",
    helpModel: "Open main-model selector, or set the active/main model.",
    helpSpare: "Open spare selector, or set e.g. /spare openai/gpt-5.4 medium.",
    helpWrapper: "Configure optional external wrapper.",
    helpAuxiliary: "Manage optional auxiliary skills, including image generation.",
    helpNew: "Start a fresh session on the next message.",
    helpResume: "Continue a saved session.",
    helpSessions: "List recent sessions in this project.",
    helpSkills: "List Markdown skills selected for a topic.",
    helpSkillMesh: "Manage strict reviewed skill sharing.",
    helpProfile: "Set task profile, e.g. code, website, latex, maintenance.",
    helpWebSearch: "Enable or disable the web_search tool.",
    helpScouts: "Enable parallel DeepSeek scouts and set scout count.",
    helpRouting: "Set routing: smart, fast, complex, manual.",
    helpProvider: "Open provider selector, or set deepseek/openai/qwen/venice/mock.",
    helpDockerOn: "Use docker-workspace with approved package installs.",
    helpDockerOff: "Use host shell policy.",
    helpLatex: "Use the LaTeX/PDF profile in Docker with a larger step budget.",
    helpInstalls: "Set package install policy.",
    helpCwd: "Change command workspace.",
    helpLanguage: "Set CLI language, or use system locale with /language auto.",
    helpExit: "Quit.",
    helpNormalRequest: "Type a normal request to run the agent. Example: write a Python CLI app with tests",
    helpAutocomplete: "Type / then Tab to autocomplete commands.",
    helpQueue: "While a run is active, Enter pipes a message into the current run (→), Tab queues it after finish (↳).",
    helpEditQueue: "Alt+Up edits the last piped message; Shift+Left edits the last queued message.",
    helpEsc: "Esc is ignored while idle. During a run, Esc waits for pending → pipe messages or stops if none; Ctrl+C always stops.",
    languageSet: "language={language} ({label})",
    languageUsage: "Usage: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Project",
    statusNew: "new",
    statusIdle: "idle",
    systemLanguage: "system",
  },
  ja: {
    launchSubtitle: "Web ファーストのエージェント作業環境",
    launchTagline: "ブラウザ + シェル + ファイル + Docker + Web 検索 + スカウト",
    interactiveIntro: "対話型エージェントチャットです。/help でコマンド、/exit で終了します。",
    promptEmpty: "依頼を入力。/help、Enter で送信、Ctrl+J で改行",
    helpTitle: "コマンド:",
    helpHelp: "このヘルプを表示します。",
    helpStatus: "現在のルート、作業場所、サンドボックス、セッションを表示します。",
    helpLogin: "プロジェクトローカルの API キーを選択・貼り付け・保存します。",
    helpInstructions: "AGINTI.md のプロジェクト指示状態を表示します。",
    helpModels: "route/main/spare/wrapper/auxiliary のモデル役割を表示します。",
    helpVenice: "Venice の route/main モデルを選択、または DeepSeek 既定値に戻します。",
    helpRoute: "ルート選択を開くか、ルーティング/高速ルートモデルを設定します。",
    helpModel: "メインモデル選択を開くか、active/main モデルを設定します。",
    helpSpare: "スペア選択を開くか、例: /spare openai/gpt-5.4 medium を設定します。",
    helpWrapper: "任意の外部ラッパーを設定します。",
    helpAuxiliary: "画像生成を含む補助スキルを管理します。",
    helpNew: "次のメッセージで新しいセッションを開始します。",
    helpResume: "保存済みセッションを続行します。",
    helpSessions: "このプロジェクトの最近のセッションを一覧します。",
    helpSkills: "トピックに合う Markdown スキルを一覧します。",
    helpProfile: "code、website、latex、maintenance などのタスクプロファイルを設定します。",
    helpWebSearch: "web_search ツールを有効/無効にします。",
    helpScouts: "並列 DeepSeek スカウトを有効化し数を設定します。",
    helpRouting: "routing を smart、fast、complex、manual に設定します。",
    helpProvider: "プロバイダ選択を開くか deepseek/openai/qwen/venice/mock を設定します。",
    helpDockerOn: "承認済みパッケージインストール付き docker-workspace を使います。",
    helpDockerOff: "ホストシェルポリシーを使います。",
    helpLatex: "Docker で LaTeX/PDF プロファイルと大きめのステップ数を使います。",
    helpInstalls: "パッケージインストールポリシーを設定します。",
    helpCwd: "コマンド作業場所を変更します。",
    helpLanguage: "CLI 言語を設定、または /language auto でシステムロケールを使います。",
    helpExit: "終了します。",
    helpNormalRequest: "通常の依頼を入力するとエージェントが実行します。例: write a Python CLI app with tests",
    helpAutocomplete: "/ を入力して Tab でコマンド補完します。",
    helpQueue: "実行中は Enter で現在の実行へパイプ (→)、Tab で完了後キュー (↳)。",
    helpEditQueue: "Alt+Up で最後のパイプ、Shift+Left で最後のキューを編集します。",
    helpEsc: "アイドル中の Esc は無視。実行中は保留中の → を待つか停止します。Ctrl+C は常に停止します。",
    languageSet: "language={language} ({label})",
    languageUsage: "使用法: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "プロジェクト",
    statusNew: "new",
    statusIdle: "idle",
    systemLanguage: "システム",
  },
  "zh-Hans": {
    launchSubtitle: "网页优先的智能体工作区",
    launchTagline: "浏览器 + Shell + 文件 + Docker + 网页搜索 + Scouts",
    interactiveIntro: "交互式智能体聊天。输入 /help 查看命令，/exit 退出。",
    promptEmpty: "输入任务，/help 查看帮助，Enter 发送，Ctrl+J 换行",
    helpTitle: "命令:",
    helpHelp: "显示帮助。",
    helpStatus: "显示当前路由、工作区、沙盒和会话。",
    helpLogin: "选择、粘贴并保存项目本地 API Key。",
    helpInstructions: "显示 AGINTI.md 项目指令状态。",
    helpModels: "显示 route/main/spare/wrapper/auxiliary 模型角色。",
    helpVenice: "选择 Venice route/main 模型，或恢复 DeepSeek 默认值。",
    helpRoute: "打开路由选择器，或设置 routing/快速路由模型。",
    helpModel: "打开主模型选择器，或设置 active/main 模型。",
    helpSpare: "打开备用模型选择器，或设置例如 /spare openai/gpt-5.4 medium。",
    helpWrapper: "配置可选外部 wrapper。",
    helpAuxiliary: "管理可选辅助技能，包括图像生成。",
    helpNew: "下一条消息开始新会话。",
    helpResume: "继续已保存会话。",
    helpSessions: "列出本项目最近会话。",
    helpSkills: "列出为主题选择的 Markdown 技能。",
    helpProfile: "设置任务 profile，例如 code、website、latex、maintenance。",
    helpWebSearch: "启用或禁用 web_search 工具。",
    helpScouts: "启用并设置并行 DeepSeek scouts 数量。",
    helpRouting: "设置 routing: smart、fast、complex、manual。",
    helpProvider: "打开 provider 选择器，或设置 deepseek/openai/qwen/venice/mock。",
    helpDockerOn: "使用允许安装包的 docker-workspace。",
    helpDockerOff: "使用主机 shell 策略。",
    helpLatex: "在 Docker 中使用 LaTeX/PDF profile 和更大步骤数。",
    helpInstalls: "设置包安装策略。",
    helpCwd: "修改命令工作区。",
    helpLanguage: "设置 CLI 语言，或用 /language auto 跟随系统语言。",
    helpExit: "退出。",
    helpNormalRequest: "输入普通任务即可运行智能体。例如: write a Python CLI app with tests",
    helpAutocomplete: "输入 / 后按 Tab 自动补全命令。",
    helpQueue: "运行中 Enter 会把消息立即传入当前任务 (→)，Tab 会排到结束后执行 (↳)。",
    helpEditQueue: "Alt+Up 编辑上一条立即消息；Shift+Left 编辑上一条排队消息。",
    helpEsc: "空闲时 Esc 不操作。运行中 Esc 等待待处理 → 消息或停止；Ctrl+C 始终停止。",
    languageSet: "language={language} ({label})",
    languageUsage: "用法: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "项目",
    statusNew: "new",
    statusIdle: "idle",
    systemLanguage: "系统",
  },
  "zh-Hant": {
    launchSubtitle: "網頁優先的智能體工作區",
    launchTagline: "瀏覽器 + Shell + 檔案 + Docker + 網頁搜尋 + Scouts",
    interactiveIntro: "互動式智能體聊天。輸入 /help 查看命令，/exit 離開。",
    promptEmpty: "輸入任務，/help 查看說明，Enter 送出，Ctrl+J 換行",
    helpTitle: "命令:",
    helpHelp: "顯示說明。",
    helpStatus: "顯示目前路由、工作區、沙盒與會話。",
    helpLogin: "選擇、貼上並儲存專案本地 API Key。",
    helpInstructions: "顯示 AGINTI.md 專案指令狀態。",
    helpModels: "顯示 route/main/spare/wrapper/auxiliary 模型角色。",
    helpVenice: "選擇 Venice route/main 模型，或恢復 DeepSeek 預設值。",
    helpRoute: "開啟路由選擇器，或設定 routing/快速路由模型。",
    helpModel: "開啟主模型選擇器，或設定 active/main 模型。",
    helpSpare: "開啟備用模型選擇器，或設定例如 /spare openai/gpt-5.4 medium。",
    helpWrapper: "設定可選外部 wrapper。",
    helpAuxiliary: "管理可選輔助技能，包括圖像生成。",
    helpNew: "下一則訊息開始新會話。",
    helpResume: "繼續已儲存會話。",
    helpSessions: "列出本專案最近會話。",
    helpSkills: "列出為主題選擇的 Markdown 技能。",
    helpProfile: "設定任務 profile，例如 code、website、latex、maintenance。",
    helpWebSearch: "啟用或停用 web_search 工具。",
    helpScouts: "啟用並設定並行 DeepSeek scouts 數量。",
    helpRouting: "設定 routing: smart、fast、complex、manual。",
    helpProvider: "開啟 provider 選擇器，或設定 deepseek/openai/qwen/venice/mock。",
    helpDockerOn: "使用允許安裝套件的 docker-workspace。",
    helpDockerOff: "使用主機 shell 策略。",
    helpLatex: "在 Docker 中使用 LaTeX/PDF profile 和較大步數。",
    helpInstalls: "設定套件安裝策略。",
    helpCwd: "修改命令工作區。",
    helpLanguage: "設定 CLI 語言，或用 /language auto 跟隨系統語言。",
    helpExit: "離開。",
    helpNormalRequest: "輸入普通任務即可執行智能體。例如: write a Python CLI app with tests",
    helpAutocomplete: "輸入 / 後按 Tab 自動補全命令。",
    helpQueue: "執行中 Enter 會把訊息立即傳入目前任務 (→)，Tab 會排到結束後執行 (↳)。",
    helpEditQueue: "Alt+Up 編輯上一條立即訊息；Shift+Left 編輯上一條排隊訊息。",
    helpEsc: "空閒時 Esc 不操作。執行中 Esc 等待待處理 → 訊息或停止；Ctrl+C 始終停止。",
    languageSet: "language={language} ({label})",
    languageUsage: "用法: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "專案",
    statusNew: "new",
    statusIdle: "idle",
    systemLanguage: "系統",
  },
};

const FALLBACKS = {
  ko: {
    launchSubtitle: "웹 우선 에이전트 작업공간",
    launchTagline: "브라우저 + 셸 + 파일 + Docker + 웹 검색 + 스카우트",
    interactiveIntro: "대화형 에이전트 채팅입니다. /help 명령, /exit 종료.",
    promptEmpty: "요청을 입력하세요. /help, Enter 전송, Ctrl+J 줄바꿈",
    helpTitle: "명령:",
    languageSet: "language={language} ({label})",
    languageUsage: "사용법: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "프로젝트",
    systemLanguage: "시스템",
  },
  fr: {
    launchSubtitle: "espace agent web-first",
    launchTagline: "navigateur + shell + fichiers + Docker + recherche web + scouts",
    interactiveIntro: "Chat agent interactif. Tapez /help pour les commandes, /exit pour quitter.",
    promptEmpty: "tapez une demande, /help, Entrée pour envoyer, Ctrl+J pour une nouvelle ligne",
    helpTitle: "Commandes:",
    languageSet: "language={language} ({label})",
    languageUsage: "Usage: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Projet",
    systemLanguage: "système",
  },
  es: {
    launchSubtitle: "espacio de agente centrado en web",
    launchTagline: "navegador + shell + archivos + Docker + búsqueda web + scouts",
    interactiveIntro: "Chat interactivo del agente. Escribe /help para comandos, /exit para salir.",
    promptEmpty: "escribe una solicitud, /help, Enter para enviar, Ctrl+J para nueva línea",
    helpTitle: "Comandos:",
    languageSet: "language={language} ({label})",
    languageUsage: "Uso: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Proyecto",
    systemLanguage: "sistema",
  },
  ar: {
    launchSubtitle: "مساحة عمل وكيل تعتمد الويب أولاً",
    launchTagline: "متصفح + صدفة + ملفات + Docker + بحث ويب + كشافة",
    interactiveIntro: "محادثة وكيل تفاعلية. اكتب /help للأوامر و /exit للخروج.",
    promptEmpty: "اكتب طلباً، /help، Enter للإرسال، Ctrl+J لسطر جديد",
    helpTitle: "الأوامر:",
    languageSet: "language={language} ({label})",
    languageUsage: "الاستخدام: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "المشروع",
    systemLanguage: "النظام",
  },
  vi: {
    launchSubtitle: "không gian agent ưu tiên web",
    launchTagline: "trình duyệt + shell + tệp + Docker + tìm kiếm web + scouts",
    interactiveIntro: "Chat agent tương tác. Gõ /help để xem lệnh, /exit để thoát.",
    promptEmpty: "nhập yêu cầu, /help, Enter để gửi, Ctrl+J xuống dòng",
    helpTitle: "Lệnh:",
    languageSet: "language={language} ({label})",
    languageUsage: "Cách dùng: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Dự án",
    systemLanguage: "hệ thống",
  },
  de: {
    launchSubtitle: "web-first Agent-Arbeitsbereich",
    launchTagline: "Browser + Shell + Dateien + Docker + Websuche + Scouts",
    interactiveIntro: "Interaktiver Agent-Chat. /help für Befehle, /exit zum Beenden.",
    promptEmpty: "Anfrage eingeben, /help, Enter zum Senden, Ctrl+J für neue Zeile",
    helpTitle: "Befehle:",
    languageSet: "language={language} ({label})",
    languageUsage: "Nutzung: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Projekt",
    systemLanguage: "System",
  },
  ru: {
    launchSubtitle: "web-first рабочая область агента",
    launchTagline: "браузер + shell + файлы + Docker + веб-поиск + scouts",
    interactiveIntro: "Интерактивный чат агента. /help для команд, /exit для выхода.",
    promptEmpty: "введите запрос, /help, Enter отправить, Ctrl+J новая строка",
    helpTitle: "Команды:",
    languageSet: "language={language} ({label})",
    languageUsage: "Использование: /language auto|en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru",
    project: "Проект",
    systemLanguage: "система",
  },
};

for (const [language, values] of Object.entries(FALLBACKS)) {
  TRANSLATIONS[language] = { ...TRANSLATIONS.en, ...values };
}

function cleanLanguage(value = "") {
  return String(value || "")
    .trim()
    .replace(/\.(utf-?8|utf8)$/i, "")
    .replace(/@.*$/, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function normalizeLanguage(value = "", fallback = "en") {
  const direct = String(value || "").trim();
  if (SUPPORTED_LANGUAGES.includes(direct)) return direct;
  const cleaned = cleanLanguage(value);
  if (LANGUAGE_ALIASES.has(cleaned)) return LANGUAGE_ALIASES.get(cleaned) || fallback;
  const dash = cleaned.replace(/_/g, "-");
  if (LANGUAGE_ALIASES.has(dash)) return LANGUAGE_ALIASES.get(dash) || fallback;
  if (dash.startsWith("zh-tw") || dash.startsWith("zh-hk") || dash.startsWith("zh-mo")) return "zh-Hant";
  if (dash.startsWith("zh")) return "zh-Hans";
  if (dash.startsWith("ja")) return "ja";
  if (dash.startsWith("ko")) return "ko";
  if (dash.startsWith("fr")) return "fr";
  if (dash.startsWith("es")) return "es";
  if (dash.startsWith("ar")) return "ar";
  if (dash.startsWith("vi")) return "vi";
  if (dash.startsWith("de")) return "de";
  if (dash.startsWith("ru")) return "ru";
  if (dash.startsWith("en")) return "en";
  return SUPPORTED_LANGUAGES.includes(fallback) ? fallback : "en";
}

export function detectSystemLanguage(env = process.env) {
  return normalizeLanguage(env.AGINTI_LANGUAGE || env.LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || "en", "en");
}

export function resolveLanguage(value = "", env = process.env) {
  const cleaned = cleanLanguage(value);
  if (!cleaned || ["auto", "system", "default"].includes(cleaned)) return detectSystemLanguage(env);
  return normalizeLanguage(value, detectSystemLanguage(env));
}

export function languageLabel(language = "en") {
  return LANGUAGE_LABELS[normalizeLanguage(language)] || LANGUAGE_LABELS.en;
}

export function t(key, language = "en", values = {}) {
  const normalized = normalizeLanguage(language);
  const text = TRANSLATIONS[normalized]?.[key] || TRANSLATIONS.en[key] || key;
  return Object.entries(values).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, String(value)), text);
}

export function languageInstruction(language = "en") {
  const normalized = normalizeLanguage(language);
  if (normalized === "en") return "User interface language: English. Reply in the user's requested language; otherwise English is acceptable.";
  return `User interface language: ${languageLabel(normalized)} (${normalized}). Prefer replying in this language unless the user explicitly requests another language.`;
}
