const supportedLanguages = [
  "en",
  "ar",
  "es",
  "fr",
  "ja",
  "ko",
  "vi",
  "zh-Hans",
  "zh-Hant",
  "de",
  "ru",
];

const translations = {
  en: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Language",
    intro:
      "Project-aware, low-cost agent for real problems",
    projectStatusTitle: "Project folder",
    setupTitle: "Provider setup",
    setupHelp:
      "DeepSeek/OpenAI/Qwen/Venice keys are missing. Use mock mode, export an env var, or save a project-local model key.",
    setupEnvHelp:
      "Env vars: DEEPSEEK_API_KEY, OPENAI_API_KEY, QWEN_API_KEY, VENICE_API_KEY, LLM_API_KEY, and optional GRSAI for image generation. Mock mode remains available for local tests.",
    setupKeyLinksLabel: "Get keys:",
    deepseekKeyLink: "DeepSeek API keys",
    openaiKeyLink: "OpenAI API keys",
    setupProviderLabel: "Provider",
    setupKeyLabel: "API key",
    saveKeyButton: "Save local key",
    keySavedStatus: "Local key saved. Raw values are never returned by the API.",
    keySaveFailed: "Failed to save local key.",
    taskProfileLabel: "Task profile",
    routingModeLabel: "Routing policy",
    routingSmartOption: "Smart: flash/pro/wrappers",
    routingFastOption: "DeepSeek v4 flash",
    routingComplexOption: "DeepSeek v4 pro",
    routingManualOption: "Manual provider/model",
    routingHintSmart:
      "Smart routing uses DeepSeek v4 flash for short work, DeepSeek v4 pro for complex tasks, and the selected wrapper only when wrapper tools are enabled.",
    routingHintFast: "Fast route: DeepSeek v4 flash for normal browser, shell, and short coding tasks.",
    routingHintComplex: "Complex route: DeepSeek v4 pro for deeper implementation, debugging, and design work.",
    routingHintManual: "Manual route uses the provider and model fields exactly as entered.",
    modelRouteStatus: "Active route",
    providerLabel: "Provider",
    mockProviderOption: "Mock local",
    modelLabel: "Model",
    goalLabel: "Goal",
    goalPlaceholder: "Open a site and summarize it, or use run_command for simple terminal inspection.",
    startUrlLabel: "Start URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Allowed domains",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Working directory",
    maxStepsLabel: "Max steps",
    sandboxModeLabel: "Sandbox mode",
    permissionModeLabel: "Permission shortcut",
    permissionSafeOption: "Safe: ask before writes/setup",
    permissionNormalOption: "Normal: project writes + Docker setup",
    permissionDangerOption: "Danger: trusted host/full access",
    permissionHintSafe: "Safe mode asks before workspace writes and package/setup actions.",
    permissionHintNormal: "Normal mode allows current-project writes and package setup inside Docker; outside-project and host-system changes still stop for approval.",
    permissionHintDanger: "Danger mode enables trusted host access, destructive commands, password typing, and outside-workspace file paths. Use only for tasks you trust.",
    permissionApprovalTitle: "Permission approval",
    permissionApprovalNo: "No",
    permissionApprovalOnce: "Yes this time",
    permissionApprovalAlways: "Yes and always",
    permissionApprovalFailed: "Permission approval failed.",
    sandboxHostOption: "Host read-only",
    sandboxDockerReadonlyOption: "Docker read-only",
    sandboxDockerWorkspaceOption: "Docker workspace-write",
    packagePolicyLabel: "Package installs",
    packageBlockOption: "Blocked",
    packagePromptOption: "Require approval",
    packageAllowOption: "Approved in Docker",
    packageWarningBlock: "Package, conda, venv, and npm setup commands are blocked.",
    packageWarningPrompt: "Package or environment setup will stop for approval before it can run.",
    packageWarningAllow: "Package setup is approved only in Docker workspace-write mode.",
    packageWarningHostAllow: "Host mode cannot run approved package setup; switch to Docker workspace-write.",
    headlessLabel: "Headless browser",
    shellToolLabel: "Enable shell tool",
    fileToolLabel: "Enable file tools",
    auxiliaryToolLabel: "Enable auxiliary skills",
    webSearchLabel: "Enable web search",
    parallelScoutsLabel: "Parallel DeepSeek scouts",
    parallelScoutCountLabel: "Scout count",
    wrapperToolLabel: "Enable agent wrappers",
    preferredWrapperLabel: "Preferred wrapper",
    dockerSandboxLabel: "Use Docker sandbox",
    allowPasswordsLabel: "Allow password typing",
    allowDestructiveLabel: "Allow destructive actions",
    dockerImageLabel: "Docker image",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Start run",
    stopRunButton: "Stop",
    stoppingRun: "Stopping...",
    stopRunFailed: "Failed to stop run.",
    runOutputTitle: "Run output",
    noRunStarted: "No run started.",
    conversationTitle: "Conversation",
    noSessionSelected: "No session selected",
    selectRecentSession: "Select a recent session",
    noConversationLoaded: "No conversation loaded.",
    chatPlaceholder: "Continue the selected conversation here.",
    sendMessageButton: "Send message",
    assistantLabel: "Assistant",
    youLabel: "You",
    keysLabel: "Keys",
    wrappersLabel: "Wrappers",
    selectedWrapperLabel: "Selected",
    wrappersOffLabel: "wrapper tools off",
    wrapperCapabilityTitle: "Agent wrappers",
    workspaceCapabilityTitle: "Workspace files",
    workspaceToolsLabel: "File tools",
    workspaceChangesEmpty: "No file changes yet.",
    changedLabel: "changed",
    blockedLabel: "blocked",
    mockLabel: "Mock",
    sandboxStatusTitle: "Sandbox status",
    sandboxStatusEmpty: "Not checked yet.",
    sandboxLogsEmpty: "No sandbox logs yet.",
    checkSandboxButton: "Check",
    preflightSandboxButton: "Preflight",
    sandboxReadyLabel: "ready",
    sandboxNotReadyLabel: "not ready",
    availableLabel: "available",
    missingLabel: "missing",
    goalRequired: "Goal is required.",
    startingRun: "Starting run...",
    failedStartRun: "Failed to start run.",
    noRunSelected: "No run selected.",
    selectSessionFirst: "Select or start a session first.",
    messageRequired: "Message is required.",
    sendingStatus: "Sending...",
    runningStatus: "Running...",
    queuedStatus: "Queued for the running agent.",
    queuedAsapStatus: "Piped into the shared session inbox.",
    queuedAfterFinishStatus: "Queued for the next web run.",
    failedContinue: "Failed to continue the conversation.",
    chatShortcutHelp: "Enter sends · Shift+Enter adds a newline · use buttons for pipe/queue control",
    pipeMessageButton: "Pipe to run",
    queueAfterFinishButton: "Queue after finish",
    pendingMessagesTitle: "Pending messages",
    asapQueueLabel: "ASAP pipe",
    afterFinishQueueLabel: "After finish",
    editQueuedMessage: "Edit",
    removeQueuedMessage: "Remove",
    queuedConsumedHint: "ASAP pipe messages are shared with CLI and consumed at the next safe agent boundary.",
    conversationMenuLabel: "Manage conversations",
    manageConversationsTitle: "Manage conversations",
    manageConversationsHelp: "Rename, auto-rename, or delete saved chat history.",
    conversationTitleLabel: "Conversation title",
    conversationTitlePlaceholder: "Short title for this conversation",
    autoRenameButton: "Auto rename",
    renameButton: "Rename",
    deleteButton: "Delete",
    cancelButton: "Cancel",
    noSessionsToManage: "No saved conversations yet.",
    titleRequired: "Title is required.",
    sessionRenamed: "Conversation renamed.",
    sessionDeleted: "Conversation deleted.",
    deleteConfirm: "Delete this conversation and its local session history?",
    manageSessionFailed: "Failed to update conversation.",
    artifactTunnelLabel: "Open canvas and artifacts",
    artifactTunnelTitle: "Canvas & artifacts",
    artifactTunnelHelp: "Agent-selected canvas items, generated files, screenshots, diffs, and final answers.",
    artifactCanvasTab: "Canvas",
    artifactPdfTab: "PDF Reader",
    artifactExplorerTab: "Explorer",
    artifactNotificationsTab: "Notifications",
    artifactListTitle: "Artifacts",
    artifactMarkSeenButton: "Mark seen",
    artifactEmpty: "No artifacts yet.",
    artifactViewerEmptyTitle: "Nothing selected",
    artifactViewerEmpty: "Select an artifact to preview it here.",
    artifactLoading: "Loading artifact...",
    artifactLoadFailed: "Failed to load artifact.",
    artifactSeenUpdated: "Notifications marked as seen.",
    artifactDownloadLabel: "Download artifact",
    artifactDownloadPreparing: "Preparing download...",
    artifactDownloadReady: "Download started.",
    artifactDownloadFailed: "Download failed.",
  },
  ar: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "اللغة",
    intro:
      "وكيل متصفح مع اختيار المزوّد، تشغيل قابل للاستئناف، إعدادات محفوظة، وأداة shell محمية اختيارية مع دعم Docker sandbox.",
    providerLabel: "المزوّد",
    modelLabel: "النموذج",
    goalLabel: "الهدف",
    goalPlaceholder: "افتح موقعا ولخصه، أو استخدم run_command لفحص طرفية بسيط.",
    startUrlLabel: "رابط البدء",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "النطاقات المسموحة",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "مجلد العمل",
    maxStepsLabel: "أقصى خطوات",
    headlessLabel: "متصفح بدون واجهة",
    shellToolLabel: "تفعيل أداة shell",
    dockerSandboxLabel: "استخدم Docker sandbox",
    allowPasswordsLabel: "السماح بكتابة كلمات المرور",
    allowDestructiveLabel: "السماح بإجراءات مدمرة",
    dockerImageLabel: "صورة Docker",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "ابدأ التشغيل",
    runOutputTitle: "مخرجات التشغيل",
    noRunStarted: "لم يبدأ أي تشغيل.",
    conversationTitle: "المحادثة",
    noSessionSelected: "لا توجد جلسة محددة",
    selectRecentSession: "اختر جلسة حديثة",
    noConversationLoaded: "لم يتم تحميل محادثة.",
    chatPlaceholder: "تابع المحادثة المحددة هنا.",
    sendMessageButton: "إرسال الرسالة",
    assistantLabel: "المساعد",
    youLabel: "أنت",
    keysLabel: "المفاتيح",
    availableLabel: "متاح",
    missingLabel: "غير موجود",
    goalRequired: "الهدف مطلوب.",
    startingRun: "جار بدء التشغيل...",
    failedStartRun: "فشل بدء التشغيل.",
    noRunSelected: "لا يوجد تشغيل محدد.",
    selectSessionFirst: "اختر أو ابدأ جلسة أولا.",
    messageRequired: "الرسالة مطلوبة.",
    sendingStatus: "جار الإرسال...",
    runningStatus: "قيد التشغيل...",
    failedContinue: "فشل متابعة المحادثة.",
  },
  es: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Idioma",
    intro:
      "Agente de navegador con selección de proveedor, ejecuciones reanudables, ajustes persistentes y shell protegido opcional con Docker sandbox.",
    providerLabel: "Proveedor",
    modelLabel: "Modelo",
    goalLabel: "Objetivo",
    goalPlaceholder: "Abre un sitio y resúmelo, o usa run_command para una inspección simple de terminal.",
    startUrlLabel: "URL inicial",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Dominios permitidos",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Directorio de trabajo",
    maxStepsLabel: "Pasos máximos",
    headlessLabel: "Navegador headless",
    shellToolLabel: "Activar shell",
    dockerSandboxLabel: "Usar Docker sandbox",
    allowPasswordsLabel: "Permitir escribir contraseñas",
    allowDestructiveLabel: "Permitir acciones destructivas",
    dockerImageLabel: "Imagen Docker",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Iniciar ejecución",
    runOutputTitle: "Salida de ejecución",
    noRunStarted: "No hay ejecución iniciada.",
    conversationTitle: "Conversación",
    noSessionSelected: "Sin sesión seleccionada",
    selectRecentSession: "Selecciona una sesión reciente",
    noConversationLoaded: "No hay conversación cargada.",
    chatPlaceholder: "Continúa aquí la conversación seleccionada.",
    sendMessageButton: "Enviar mensaje",
    assistantLabel: "Asistente",
    youLabel: "Tú",
    keysLabel: "Claves",
    availableLabel: "disponible",
    missingLabel: "faltante",
    goalRequired: "El objetivo es obligatorio.",
    startingRun: "Iniciando ejecución...",
    failedStartRun: "No se pudo iniciar la ejecución.",
    noRunSelected: "No hay ejecución seleccionada.",
    selectSessionFirst: "Selecciona o inicia una sesión primero.",
    messageRequired: "El mensaje es obligatorio.",
    sendingStatus: "Enviando...",
    runningStatus: "Ejecutando...",
    failedContinue: "No se pudo continuar la conversación.",
  },
  fr: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Langue",
    intro:
      "Agent navigateur avec choix du fournisseur, runs reprenables, réglages persistants et outil shell gardé optionnel avec Docker sandbox.",
    providerLabel: "Fournisseur",
    modelLabel: "Modèle",
    goalLabel: "Objectif",
    goalPlaceholder: "Ouvrez un site et résumez-le, ou utilisez run_command pour une inspection terminal simple.",
    startUrlLabel: "URL de départ",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Domaines autorisés",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Dossier de travail",
    maxStepsLabel: "Étapes max",
    headlessLabel: "Navigateur headless",
    shellToolLabel: "Activer l'outil shell",
    dockerSandboxLabel: "Utiliser Docker sandbox",
    allowPasswordsLabel: "Autoriser la saisie de mots de passe",
    allowDestructiveLabel: "Autoriser les actions destructives",
    dockerImageLabel: "Image Docker",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Démarrer",
    runOutputTitle: "Sortie du run",
    noRunStarted: "Aucun run démarré.",
    conversationTitle: "Conversation",
    noSessionSelected: "Aucune session sélectionnée",
    selectRecentSession: "Sélectionner une session récente",
    noConversationLoaded: "Aucune conversation chargée.",
    chatPlaceholder: "Continuez ici la conversation sélectionnée.",
    sendMessageButton: "Envoyer",
    assistantLabel: "Assistant",
    youLabel: "Vous",
    keysLabel: "Clés",
    availableLabel: "disponible",
    missingLabel: "manquante",
    goalRequired: "L'objectif est requis.",
    startingRun: "Démarrage du run...",
    failedStartRun: "Échec du démarrage.",
    noRunSelected: "Aucun run sélectionné.",
    selectSessionFirst: "Sélectionnez ou démarrez d'abord une session.",
    messageRequired: "Le message est requis.",
    sendingStatus: "Envoi...",
    runningStatus: "Exécution...",
    failedContinue: "Impossible de continuer la conversation.",
  },
  ja: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "言語",
    intro:
      "プロバイダー選択、再開可能な実行、保存される設定、Docker sandbox対応の保護されたshellツールを備えたブラウザエージェントです。",
    providerLabel: "プロバイダー",
    modelLabel: "モデル",
    goalLabel: "目標",
    goalPlaceholder: "サイトを開いて要約する、または run_command で簡単な端末確認を行う。",
    startUrlLabel: "開始URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "許可ドメイン",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "作業ディレクトリ",
    maxStepsLabel: "最大ステップ",
    headlessLabel: "ヘッドレスブラウザ",
    shellToolLabel: "shellツールを有効化",
    dockerSandboxLabel: "Docker sandboxを使う",
    allowPasswordsLabel: "パスワード入力を許可",
    allowDestructiveLabel: "破壊的操作を許可",
    dockerImageLabel: "Dockerイメージ",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "実行開始",
    runOutputTitle: "実行出力",
    noRunStarted: "実行はまだ開始されていません。",
    conversationTitle: "会話",
    noSessionSelected: "セッション未選択",
    selectRecentSession: "最近のセッションを選択",
    noConversationLoaded: "会話は読み込まれていません。",
    chatPlaceholder: "選択した会話をここで続けます。",
    sendMessageButton: "送信",
    assistantLabel: "アシスタント",
    youLabel: "あなた",
    keysLabel: "キー",
    availableLabel: "利用可能",
    missingLabel: "未設定",
    goalRequired: "目標が必要です。",
    startingRun: "実行を開始しています...",
    failedStartRun: "実行開始に失敗しました。",
    noRunSelected: "実行が選択されていません。",
    selectSessionFirst: "先にセッションを選択または開始してください。",
    messageRequired: "メッセージが必要です。",
    sendingStatus: "送信中...",
    runningStatus: "実行中...",
    failedContinue: "会話の継続に失敗しました。",
  },
  ko: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "언어",
    intro:
      "제공자 선택, 재개 가능한 실행, 저장되는 설정, Docker sandbox 지원 보호 shell 도구를 갖춘 브라우저 에이전트입니다.",
    providerLabel: "제공자",
    modelLabel: "모델",
    goalLabel: "목표",
    goalPlaceholder: "사이트를 열고 요약하거나 run_command로 간단한 터미널 검사를 실행하세요.",
    startUrlLabel: "시작 URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "허용 도메인",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "작업 디렉터리",
    maxStepsLabel: "최대 단계",
    headlessLabel: "헤드리스 브라우저",
    shellToolLabel: "shell 도구 활성화",
    dockerSandboxLabel: "Docker sandbox 사용",
    allowPasswordsLabel: "비밀번호 입력 허용",
    allowDestructiveLabel: "파괴적 작업 허용",
    dockerImageLabel: "Docker 이미지",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "실행 시작",
    runOutputTitle: "실행 출력",
    noRunStarted: "아직 실행이 시작되지 않았습니다.",
    conversationTitle: "대화",
    noSessionSelected: "선택된 세션 없음",
    selectRecentSession: "최근 세션 선택",
    noConversationLoaded: "불러온 대화가 없습니다.",
    chatPlaceholder: "선택한 대화를 여기서 계속하세요.",
    sendMessageButton: "메시지 보내기",
    assistantLabel: "어시스턴트",
    youLabel: "나",
    keysLabel: "키",
    availableLabel: "사용 가능",
    missingLabel: "없음",
    goalRequired: "목표가 필요합니다.",
    startingRun: "실행을 시작하는 중...",
    failedStartRun: "실행 시작에 실패했습니다.",
    noRunSelected: "선택된 실행이 없습니다.",
    selectSessionFirst: "먼저 세션을 선택하거나 시작하세요.",
    messageRequired: "메시지가 필요합니다.",
    sendingStatus: "보내는 중...",
    runningStatus: "실행 중...",
    failedContinue: "대화를 계속하지 못했습니다.",
  },
  vi: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Ngôn ngữ",
    intro:
      "Agent trình duyệt có chọn provider, phiên chạy tiếp tục được, cài đặt được lưu, và shell tool được bảo vệ tùy chọn với Docker sandbox.",
    providerLabel: "Provider",
    modelLabel: "Model",
    goalLabel: "Mục tiêu",
    goalPlaceholder: "Mở một trang và tóm tắt, hoặc dùng run_command để kiểm tra terminal đơn giản.",
    startUrlLabel: "URL bắt đầu",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Domain được phép",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Thư mục làm việc",
    maxStepsLabel: "Số bước tối đa",
    headlessLabel: "Trình duyệt headless",
    shellToolLabel: "Bật shell tool",
    dockerSandboxLabel: "Dùng Docker sandbox",
    allowPasswordsLabel: "Cho phép nhập mật khẩu",
    allowDestructiveLabel: "Cho phép hành động phá hủy",
    dockerImageLabel: "Docker image",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Bắt đầu chạy",
    runOutputTitle: "Kết quả chạy",
    noRunStarted: "Chưa có phiên chạy.",
    conversationTitle: "Hội thoại",
    noSessionSelected: "Chưa chọn phiên",
    selectRecentSession: "Chọn phiên gần đây",
    noConversationLoaded: "Chưa tải hội thoại.",
    chatPlaceholder: "Tiếp tục hội thoại đã chọn tại đây.",
    sendMessageButton: "Gửi tin nhắn",
    assistantLabel: "Trợ lý",
    youLabel: "Bạn",
    keysLabel: "Khóa",
    availableLabel: "có",
    missingLabel: "thiếu",
    goalRequired: "Cần nhập mục tiêu.",
    startingRun: "Đang bắt đầu chạy...",
    failedStartRun: "Không thể bắt đầu chạy.",
    noRunSelected: "Chưa chọn phiên chạy.",
    selectSessionFirst: "Hãy chọn hoặc bắt đầu một phiên trước.",
    messageRequired: "Cần nhập tin nhắn.",
    sendingStatus: "Đang gửi...",
    runningStatus: "Đang chạy...",
    failedContinue: "Không thể tiếp tục hội thoại.",
  },
  "zh-Hans": {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "语言",
    intro:
      "浏览器智能体，支持模型供应商选择、可恢复运行、持久设置，以及可选的受保护 shell 工具和 Docker 沙箱。",
    providerLabel: "供应商",
    modelLabel: "模型",
    goalLabel: "目标",
    goalPlaceholder: "打开网站并总结，或使用 run_command 做简单终端检查。",
    startUrlLabel: "起始 URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "允许域名",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "工作目录",
    maxStepsLabel: "最大步数",
    headlessLabel: "无头浏览器",
    shellToolLabel: "启用 shell 工具",
    dockerSandboxLabel: "使用 Docker 沙箱",
    allowPasswordsLabel: "允许输入密码",
    allowDestructiveLabel: "允许破坏性操作",
    dockerImageLabel: "Docker 镜像",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "开始运行",
    runOutputTitle: "运行输出",
    noRunStarted: "还没有开始运行。",
    conversationTitle: "对话",
    noSessionSelected: "未选择会话",
    selectRecentSession: "选择最近会话",
    noConversationLoaded: "未加载对话。",
    chatPlaceholder: "在这里继续当前选中的对话。",
    sendMessageButton: "发送消息",
    assistantLabel: "助手",
    youLabel: "你",
    keysLabel: "密钥",
    availableLabel: "可用",
    missingLabel: "缺失",
    goalRequired: "目标是必填项。",
    startingRun: "正在开始运行...",
    failedStartRun: "启动运行失败。",
    noRunSelected: "未选择运行。",
    selectSessionFirst: "请先选择或开始一个会话。",
    messageRequired: "消息是必填项。",
    sendingStatus: "正在发送...",
    runningStatus: "正在运行...",
    failedContinue: "继续对话失败。",
  },
  "zh-Hant": {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "語言",
    intro:
      "瀏覽器智能體，支援模型供應商選擇、可恢復執行、持久設定，以及可選的受保護 shell 工具與 Docker 沙箱。",
    providerLabel: "供應商",
    modelLabel: "模型",
    goalLabel: "目標",
    goalPlaceholder: "開啟網站並總結，或使用 run_command 做簡單終端檢查。",
    startUrlLabel: "起始 URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "允許網域",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "工作目錄",
    maxStepsLabel: "最大步數",
    headlessLabel: "無頭瀏覽器",
    shellToolLabel: "啟用 shell 工具",
    dockerSandboxLabel: "使用 Docker 沙箱",
    allowPasswordsLabel: "允許輸入密碼",
    allowDestructiveLabel: "允許破壞性操作",
    dockerImageLabel: "Docker 映像",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "開始執行",
    runOutputTitle: "執行輸出",
    noRunStarted: "尚未開始執行。",
    conversationTitle: "對話",
    noSessionSelected: "未選擇會話",
    selectRecentSession: "選擇最近會話",
    noConversationLoaded: "未載入對話。",
    chatPlaceholder: "在這裡繼續目前選中的對話。",
    sendMessageButton: "傳送訊息",
    assistantLabel: "助手",
    youLabel: "你",
    keysLabel: "金鑰",
    availableLabel: "可用",
    missingLabel: "缺失",
    goalRequired: "目標為必填。",
    startingRun: "正在開始執行...",
    failedStartRun: "啟動執行失敗。",
    noRunSelected: "未選擇執行。",
    selectSessionFirst: "請先選擇或開始一個會話。",
    messageRequired: "訊息為必填。",
    sendingStatus: "正在傳送...",
    runningStatus: "正在執行...",
    failedContinue: "繼續對話失敗。",
  },
  de: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Sprache",
    intro:
      "Browser-Agent mit Provider-Auswahl, fortsetzbaren Läufen, gespeicherten Einstellungen und optional geschütztem Shell-Tool mit Docker-Sandbox.",
    providerLabel: "Provider",
    modelLabel: "Modell",
    goalLabel: "Ziel",
    goalPlaceholder: "Eine Website öffnen und zusammenfassen oder run_command für einfache Terminalprüfung nutzen.",
    startUrlLabel: "Start-URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Erlaubte Domains",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Arbeitsverzeichnis",
    maxStepsLabel: "Max. Schritte",
    headlessLabel: "Headless-Browser",
    shellToolLabel: "Shell-Tool aktivieren",
    dockerSandboxLabel: "Docker-Sandbox nutzen",
    allowPasswordsLabel: "Passworteingabe erlauben",
    allowDestructiveLabel: "Destruktive Aktionen erlauben",
    dockerImageLabel: "Docker-Image",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Lauf starten",
    runOutputTitle: "Laufausgabe",
    noRunStarted: "Kein Lauf gestartet.",
    conversationTitle: "Konversation",
    noSessionSelected: "Keine Session ausgewählt",
    selectRecentSession: "Aktuelle Session auswählen",
    noConversationLoaded: "Keine Konversation geladen.",
    chatPlaceholder: "Die ausgewählte Konversation hier fortsetzen.",
    sendMessageButton: "Nachricht senden",
    assistantLabel: "Assistent",
    youLabel: "Du",
    keysLabel: "Keys",
    availableLabel: "verfügbar",
    missingLabel: "fehlt",
    goalRequired: "Ziel ist erforderlich.",
    startingRun: "Lauf wird gestartet...",
    failedStartRun: "Lauf konnte nicht gestartet werden.",
    noRunSelected: "Kein Lauf ausgewählt.",
    selectSessionFirst: "Bitte zuerst eine Session auswählen oder starten.",
    messageRequired: "Nachricht ist erforderlich.",
    sendingStatus: "Senden...",
    runningStatus: "Läuft...",
    failedContinue: "Konversation konnte nicht fortgesetzt werden.",
  },
  ru: {
    documentTitle: "AgInTiFlow",
    brandKicker: "Developed by AgInTi Lab, LazyingArt LLC",
    languageLabel: "Язык",
    intro:
      "Браузерный агент с выбором провайдера, возобновляемыми запусками, сохраненными настройками и опциональным защищенным shell tool с Docker sandbox.",
    providerLabel: "Провайдер",
    modelLabel: "Модель",
    goalLabel: "Цель",
    goalPlaceholder: "Откройте сайт и сделайте summary или используйте run_command для простой проверки терминала.",
    startUrlLabel: "Начальный URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Разрешенные домены",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Рабочая папка",
    maxStepsLabel: "Макс. шагов",
    headlessLabel: "Headless browser",
    shellToolLabel: "Включить shell tool",
    dockerSandboxLabel: "Использовать Docker sandbox",
    allowPasswordsLabel: "Разрешить ввод паролей",
    allowDestructiveLabel: "Разрешить опасные действия",
    dockerImageLabel: "Docker image",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Запустить",
    runOutputTitle: "Вывод запуска",
    noRunStarted: "Запуск еще не начат.",
    conversationTitle: "Диалог",
    noSessionSelected: "Сессия не выбрана",
    selectRecentSession: "Выберите недавнюю сессию",
    noConversationLoaded: "Диалог не загружен.",
    chatPlaceholder: "Продолжите выбранный диалог здесь.",
    sendMessageButton: "Отправить",
    assistantLabel: "Ассистент",
    youLabel: "Вы",
    keysLabel: "Ключи",
    availableLabel: "доступен",
    missingLabel: "нет",
    goalRequired: "Цель обязательна.",
    startingRun: "Запуск начинается...",
    failedStartRun: "Не удалось начать запуск.",
    noRunSelected: "Запуск не выбран.",
    selectSessionFirst: "Сначала выберите или начните сессию.",
    messageRequired: "Сообщение обязательно.",
    sendingStatus: "Отправка...",
    runningStatus: "Выполняется...",
    failedContinue: "Не удалось продолжить диалог.",
  },
};

const form = document.querySelector("#run-form");
const languageField = document.querySelector("#language");
const routingModeField = document.querySelector("#routingMode");
const providerField = document.querySelector("#provider");
const modelField = document.querySelector("#model");
const modelCatalogEl = document.querySelector("#model-catalog");
const modelRoleGridEl = document.querySelector("#model-role-grid");
const modelRoutePillEl = document.querySelector("#model-route-pill");
const routeProviderField = document.querySelector("#routeProvider");
const routeModelField = document.querySelector("#routeModel");
const mainProviderField = document.querySelector("#mainProvider");
const mainModelField = document.querySelector("#mainModel");
const spareProviderField = document.querySelector("#spareProvider");
const spareModelField = document.querySelector("#spareModel");
const spareReasoningField = document.querySelector("#spareReasoning");
const wrapperModelField = document.querySelector("#wrapperModel");
const wrapperReasoningField = document.querySelector("#wrapperReasoning");
const auxiliaryProviderField = document.querySelector("#auxiliaryProvider");
const auxiliaryModelField = document.querySelector("#auxiliaryModel");
const routingHintEl = document.querySelector("#routing-hint");
const modelRouteStatusEl = document.querySelector("#model-route-status");
const projectStatusEl = document.querySelector("#project-status");
const setupCardEl = document.querySelector("#setup-card");
const setupProviderField = document.querySelector("#setup-provider");
const setupApiKeyField = document.querySelector("#setup-api-key");
const saveApiKeyButton = document.querySelector("#save-api-key");
const setupStatusEl = document.querySelector("#setup-status");
const taskProfileField = document.querySelector("#taskProfile");
const permissionModeField = document.querySelector("#permissionMode");
const permissionHintEl = document.querySelector("#permission-hint");
const sandboxModeField = document.querySelector("#sandboxMode");
const packageInstallPolicyField = document.querySelector("#packageInstallPolicy");
const packageWarningEl = document.querySelector("#package-warning");
const logsEl = document.querySelector("#logs");
const runMetaEl = document.querySelector("#run-meta");
const stopRunButton = document.querySelector("#stop-run");
const keyStatusEl = document.querySelector("#key-status");
const allowAuxiliaryToolsField = document.querySelector("#allowAuxiliaryTools");
const allowWebSearchField = document.querySelector("#allowWebSearch");
const allowParallelScoutsField = document.querySelector("#allowParallelScouts");
const parallelScoutCountField = document.querySelector("#parallelScoutCount");
const allowWrapperToolsField = document.querySelector("#allowWrapperTools");
const preferredWrapperField = document.querySelector("#preferredWrapper");
const wrapperStatusEl = document.querySelector("#wrapper-status");
const wrapperGridEl = document.querySelector("#wrapper-grid");
const workspaceStatusEl = document.querySelector("#workspace-status");
const workspaceToolsEl = document.querySelector("#workspace-tools");
const workspaceChangesEl = document.querySelector("#workspace-changes");
const sandboxStatusEl = document.querySelector("#sandbox-status");
const sandboxLogsEl = document.querySelector("#sandbox-logs");
const checkSandboxButton = document.querySelector("#check-sandbox");
const preflightSandboxButton = document.querySelector("#preflight-sandbox");
const sessionSelectEl = document.querySelector("#session-select");
const chatThreadEl = document.querySelector("#chat-thread");
const chatFormEl = document.querySelector("#chat-form");
const chatInputEl = document.querySelector("#chat-input");
const chatPendingEl = document.querySelector("#chat-pending");
const chatStatusEl = document.querySelector("#chat-status");
const pipeMessageButton = document.querySelector("#pipe-message");
const queueAfterFinishButton = document.querySelector("#queue-after-finish");
const manageSessionsButton = document.querySelector("#manage-sessions");
const openArtifactsButton = document.querySelector("#open-artifacts");
const artifactBadgeEl = document.querySelector("#artifact-badge");
const sessionManagerDialog = document.querySelector("#session-manager");
const closeSessionManagerButton = document.querySelector("#close-session-manager");
const cancelSessionManagerButton = document.querySelector("#cancel-session-manager");
const sessionManagerListEl = document.querySelector("#session-manager-list");
const sessionTitleInputEl = document.querySelector("#session-title-input");
const sessionManagerStatusEl = document.querySelector("#session-manager-status");
const autoRenameSessionButton = document.querySelector("#auto-rename-session");
const renameSessionButton = document.querySelector("#rename-session");
const deleteSessionButton = document.querySelector("#delete-session");
const artifactTunnelDialog = document.querySelector("#artifact-tunnel");
const closeArtifactTunnelButton = document.querySelector("#close-artifact-tunnel");
const artifactTabsEl = document.querySelector(".artifact-tabs");
const artifactListEl = document.querySelector("#artifact-list");
const artifactViewerTitleEl = document.querySelector("#artifact-viewer-title");
const artifactViewerMetaEl = document.querySelector("#artifact-viewer-meta");
const artifactViewerKindEl = document.querySelector("#artifact-viewer-kind");
const artifactViewerBodyEl = document.querySelector("#artifact-viewer-body");
const artifactStatusEl = document.querySelector("#artifact-status");
const markArtifactsSeenButton = document.querySelector("#mark-artifacts-seen");
const settingsDialog = document.querySelector("#settings-modal");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const doneSettingsButton = document.querySelector("#done-settings");
const translatableNodes = [...document.querySelectorAll("[data-i18n]")];
const placeholderNodes = [...document.querySelectorAll("[data-i18n-placeholder]")];
const ariaLabelNodes = [...document.querySelectorAll("[data-i18n-aria-label]")];

const defaults = {
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-v4-flash",
  qwen: "qwen-plus",
  venice: "venice-uncensored-1-2",
  mock: "mock-agent",
};

let currentLanguage = "en";
let routingPresets = {};
let modelCatalog = {};
let modelRoles = {};
let modelGroups = {};
let auxiliaryModelCatalog = {};
let taskProfiles = [];
let projectInfo = null;
let currentSessionId = "";
let currentRunStatus = "";
let pollTimer = null;
let saveTimer = null;
let lastChatEntries = [];
let lastSessions = [];
let pendingInboxItems = [];
let pendingAfterFinishItems = [];
let flushingAfterFinish = false;
let lastKeyStatus = null;
let lastWrappers = [];
let lastSandbox = null;
let lastWorkspace = null;
let lastWorkspaceActivity = [];
let managedSessionId = "";
let artifactItems = [];
let selectedArtifactId = "";
let currentArtifactTab = "canvas";
let artifactUnreadCount = 0;

function normalizeLanguage(language) {
  const lower = String(language || "").toLowerCase();
  if (lower.startsWith("zh-hant") || lower.includes("tw") || lower.includes("hk")) return "zh-Hant";
  if (lower.startsWith("zh")) return "zh-Hans";
  return supportedLanguages.find((supported) => lower.startsWith(supported.toLowerCase())) || "en";
}

function t(key) {
  return translations[currentLanguage]?.[key] || translations.en[key] || key;
}

function setLogs(text, mode = "active") {
  logsEl.dataset.mode = mode;
  logsEl.textContent = text;
}

function outputLineCount(value = "") {
  const text = String(value || "");
  return text ? text.split(/\r?\n/).length : 0;
}

function outputPreviewText(value = "", maxLines = 18) {
  const lines = String(value || "").split(/\r?\n/);
  const shown = lines.slice(0, maxLines);
  return {
    text: shown.join("\n"),
    hidden: Math.max(lines.length - shown.length, 0),
    total: value ? lines.length : 0,
  };
}

function updateStopRunButton() {
  if (!stopRunButton) return;
  stopRunButton.hidden = currentRunStatus !== "running";
  stopRunButton.disabled = currentRunStatus !== "running";
}

function renderKeyStatus(status = lastKeyStatus) {
  lastKeyStatus = status;
  if (!status) return;
  keyStatusEl.textContent = `${t("keysLabel")}: OpenAI ${
    status.openai ? t("availableLabel") : t("missingLabel")
  } · DeepSeek ${status.deepseek ? t("availableLabel") : t("missingLabel")} · Qwen ${
    status.qwen ? t("availableLabel") : t("missingLabel")
  } · Venice ${
    status.venice ? t("availableLabel") : t("missingLabel")
  } · GRS AI ${
    status.grsai ? t("availableLabel") : t("missingLabel")
  } · ${t("mockLabel")} ${
    status.mock ? t("availableLabel") : t("missingLabel")
  }`;
  if (setupCardEl) setupCardEl.hidden = Boolean(status.openai || status.deepseek || status.qwen || status.venice);
}

function renderProjectStatus(info = projectInfo) {
  projectInfo = info;
  if (!projectStatusEl || !info) return;
  projectStatusEl.textContent = [
    info.platform?.label ? `os=${info.platform.label}` : "",
    `root=${info.root || ""}`,
    `cwd=${info.commandCwd || ""}`,
    `sessions=${info.sessionsDir || ""}`,
    `db=${info.sessionDbPath || ""}`,
    `shared=${info.sharedSessionFolder ? "yes" : "no"}`,
  ].join(" · ");
}

function renderTaskProfiles(selected = "auto") {
  if (!taskProfileField) return;
  const profiles = taskProfiles.length ? taskProfiles : [{ id: "auto", label: "Auto" }];
  taskProfileField.innerHTML = profiles
    .map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label || profile.id)}</option>`)
    .join("");
  taskProfileField.value = profiles.some((profile) => profile.id === selected) ? selected : "auto";
}

const COMPLEX_ENGINEERING_HINT = /\b(large|complex|complicated|monorepo|codebase|repository|repo-wide|multi[- ]file|cross[- ]file|architecture|refactor|migration|regression|root cause|failing tests?|fix build|system bug|debug|performance|security)\b/i;

function recommendedMaxStepsForProfile(profile = "auto", goal = "") {
  if (profile === "large-codebase") return 36;
  if (profile === "app") return 40;
  if (profile === "android") return 60;
  if (profile === "supervision") return 40;
  if (profile === "latex") return 30;
  if (["paper", "research", "book", "novel", "c-cpp", "r-stan", "github", "word", "maintenance"].includes(profile)) return 30;
  if (COMPLEX_ENGINEERING_HINT.test(goal || "")) return 36;
  if (/\b(latex|tex|pdflatex|latexmk|pdf|website|app|docker|system|install|setup|debug)\b/i.test(goal || "")) return 30;
  return 24;
}

function ensureRecommendedMaxStepsForCurrentTask() {
  const maxStepsField = document.querySelector("#maxSteps");
  const goalField = document.querySelector("#goal");
  const recommended = recommendedMaxStepsForProfile(taskProfileField?.value || "auto", goalField?.value || "");
  if (maxStepsField && Number(maxStepsField.value || 0) < recommended) {
    maxStepsField.value = String(recommended);
  }
}

function renderWrapperStatus(wrappers = lastWrappers) {
  lastWrappers = wrappers || [];
  if (lastWrappers.length === 0) {
    wrapperStatusEl.textContent = "";
    wrapperGridEl.innerHTML = "";
    return;
  }
  const selectedWrapper = preferredWrapperField?.value || "codex";
  const selected = lastWrappers.find((wrapper) => wrapper.name === selectedWrapper);
  const selectedLabel = selected?.label || selectedWrapper;
  const enabledPrefix = allowWrapperToolsField?.checked ? t("selectedWrapperLabel") : t("wrappersOffLabel");
  wrapperStatusEl.textContent = `${enabledPrefix}: ${selectedLabel} · ${t("wrappersLabel")}: ${lastWrappers
    .map((wrapper) => `${wrapper.label || wrapper.name} ${wrapper.available ? t("availableLabel") : t("missingLabel")}`)
    .join(" · ")}`;
  wrapperGridEl.innerHTML = lastWrappers
    .map(
      (wrapper) => `
        <div class="capability-chip" data-ready="${Boolean(wrapper.available)}" data-selected="${wrapper.name === selectedWrapper}">
          <strong>${escapeHtml(wrapper.label || wrapper.name)}</strong>
          <span>${wrapper.name === selectedWrapper ? `${t("selectedWrapperLabel")} · ` : ""}${wrapper.available ? t("availableLabel") : t("missingLabel")}</span>
        </div>
      `
    )
    .join("");
}

function renderWorkspacePanel(workspace = lastWorkspace, activity = lastWorkspaceActivity) {
  lastWorkspace = workspace;
  lastWorkspaceActivity = activity || [];

  if (!workspace) {
    workspaceStatusEl.textContent = "";
    workspaceToolsEl.innerHTML = "";
    workspaceChangesEl.innerHTML = `<p class="subtle">${t("workspaceChangesEmpty")}</p>`;
    return;
  }

  workspaceStatusEl.textContent = `${workspace.enabled ? t("availableLabel") : t("missingLabel")} · ${
    workspace.workspace || ""
  }`;
  workspaceToolsEl.innerHTML = (workspace.tools || [])
    .map(
      (tool) => `
        <div class="capability-chip" data-ready="${Boolean(workspace.enabled)}">
          <strong>${escapeHtml(tool)}</strong>
          <span>${(workspace.writeTools || []).includes(tool) ? "write guarded" : "read guarded"}</span>
        </div>
      `
    )
    .join("");

  if (!lastWorkspaceActivity.length) {
    workspaceChangesEl.innerHTML = `<p class="subtle">${t("workspaceChangesEmpty")}</p>`;
    return;
  }

  workspaceChangesEl.innerHTML = lastWorkspaceActivity
    .slice(0, 6)
    .map((item) => {
      const blocked = item.kind === "blocked";
      const label = blocked ? t("blockedLabel") : t("changedLabel");
      const path = escapeHtml(item.path || "");
      const reason = blocked ? `<div class="subtle">${escapeHtml(item.reason || "")}</div>` : "";
      const advice =
        blocked && item.permissionAdvice
          ? `<div class="subtle"><strong>${escapeHtml(item.permissionAdvice.summary || "Permission advice")}</strong>${
              item.permissionAdvice.suggestedCommand
                ? `<br /><code>${escapeHtml(item.permissionAdvice.suggestedCommand)}</code>`
                : ""
            }</div>`
          : "";
      const diff = item.diff ? `<pre class="change-diff">${renderDiffHtml(item.diff, 1200)}</pre>` : "";
      const hashes =
        item.beforeHash || item.afterHash
          ? `<div class="change-meta"><span>before=${escapeHtml((item.beforeHash || "new").slice(0, 10))}</span><span>after=${escapeHtml((item.afterHash || "").slice(0, 10))}</span></div>`
          : "";
      return `
        <article class="change-item ${blocked ? "blocked" : ""}">
          <div class="change-meta">
            <span>${label}</span>
            <span>${escapeHtml(item.toolName || "")}</span>
            <span>${item.at ? new Date(item.at).toLocaleString() : ""}</span>
          </div>
          <strong class="change-path">${path}</strong>
          ${reason}
          ${advice}
          ${hashes}
          ${diff}
        </article>
      `;
    })
    .join("");
}

function renderSandboxStatus(status = lastSandbox) {
  lastSandbox = status;
  if (!status) {
    sandboxStatusEl.textContent = t("sandboxStatusEmpty");
    sandboxLogsEl.textContent = t("sandboxLogsEmpty");
    return;
  }

  const readiness =
    status.sandboxMode === "host"
      ? status.workspaceReadable
      : status.dockerAvailable && status.imageReady && status.workspaceReadable;
  const parts = [
    `${status.sandboxMode} · ${readiness ? t("sandboxReadyLabel") : t("sandboxNotReadyLabel")}`,
    `image=${status.image}`,
    `workspace=${status.workspace}`,
    `package=${status.packageInstallPolicy}`,
    `docker=${status.dockerAvailable ? t("availableLabel") : t("missingLabel")}`,
    `imageReady=${status.imageReady}`,
    status.persistentDocker?.env ? `env=${status.persistentDocker.env}` : "",
  ];
  sandboxStatusEl.textContent = parts.filter(Boolean).join(" · ");
  renderSandboxLogs(status.logs || []);
}

function renderSandboxLogs(logs) {
  if (!logs || logs.length === 0) {
    sandboxLogsEl.textContent = t("sandboxLogsEmpty");
    return;
  }
  sandboxLogsEl.textContent = logs
    .slice(-12)
    .map((entry) => `[${entry.at}] ${entry.type}\n${JSON.stringify(entry.data || {}, null, 2)}`)
    .join("\n\n");
}

function fieldValue(field) {
  return String(field?.value || "").trim();
}

function providerModelOptions(provider = providerField.value) {
  return (modelCatalog[provider] || []).filter((item) => !item.hidden);
}

function mergeModelOptions(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const item of group || []) {
      const id = String(item?.id || item?.model || item || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(typeof item === "string" ? { id, label: id } : { ...item, id });
    }
  }
  return merged;
}

function wrapperModelOptions() {
  const openai = providerModelOptions("openai").filter((item) => /gpt|codex/i.test(item.id || item.label || ""));
  return mergeModelOptions(
    [
      { id: "gpt-5.5", label: "GPT-5.5", bucket: "Codex wrapper" },
      { id: "gpt-5.4", label: "GPT-5.4", bucket: "Codex wrapper" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", bucket: "Codex wrapper" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", bucket: "Codex wrapper" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", bucket: "Codex wrapper" },
      { id: "gpt-5.2", label: "GPT-5.2", bucket: "Codex wrapper" },
    ],
    openai
  );
}

function auxiliaryModelOptions(provider = auxiliaryProviderField?.value || "grsai") {
  if (provider === "venice") {
    return mergeModelOptions(auxiliaryModelCatalog["venice-image"], [
      { id: "nano-banana-2", label: "Nano Banana 2", bucket: "Venice image" },
      { id: "gpt-image-2", label: "GPT Image 2", bucket: "Venice image" },
      { id: "gpt-image-2-edit", label: "GPT Image 2 Edit", bucket: "Venice image" },
      { id: "bria-bg-remover", label: "Background Remover", bucket: "Venice image" },
    ]);
  }
  return mergeModelOptions(auxiliaryModelCatalog.grsai, [
    { id: "nano-banana-2", label: "Nano Banana 2", bucket: "GRS AI" },
    { id: "gpt-image-2", label: "GPT Image 2", bucket: "GRS AI" },
  ]);
}

function setSelectOptions(select, options, selectedValue = "", fallbackValue = "") {
  if (!select) return "";
  const selected = String(selectedValue || fallbackValue || "").trim();
  const merged = mergeModelOptions(options);
  if (selected && !merged.some((item) => item.id === selected)) {
    merged.unshift({ id: selected, label: `Custom: ${selected}` });
  }
  select.innerHTML = merged
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)}</option>`)
    .join("");
  select.value = selected && merged.some((item) => item.id === selected) ? selected : merged[0]?.id || "";
  return select.value;
}

function refreshModelDropdowns() {
  const provider = providerField?.value || "deepseek";
  setSelectOptions(modelField, providerModelOptions(provider), fieldValue(modelField), defaults[provider]);
  setSelectOptions(
    routeModelField,
    providerModelOptions(routeProviderField?.value || "deepseek"),
    fieldValue(routeModelField),
    modelRoles.route?.model || "deepseek-v4-flash"
  );
  setSelectOptions(
    mainModelField,
    providerModelOptions(mainProviderField?.value || "deepseek"),
    fieldValue(mainModelField),
    modelRoles.main?.model || "deepseek-v4-pro"
  );
  setSelectOptions(
    spareModelField,
    providerModelOptions(spareProviderField?.value || "openai"),
    fieldValue(spareModelField),
    modelRoles.spare?.model || "gpt-5.4"
  );
  setSelectOptions(wrapperModelField, wrapperModelOptions(), fieldValue(wrapperModelField), modelRoles.wrapper?.model || "gpt-5.5");
  setSelectOptions(
    auxiliaryModelField,
    auxiliaryModelOptions(auxiliaryProviderField?.value || "grsai"),
    fieldValue(auxiliaryModelField),
    modelRoles.auxiliary?.model || "nano-banana-2"
  );
}

function renderModelRoles() {
  if (!modelRoleGridEl) return;
  const roles = {
    route: {
      ...(modelRoles.route || {}),
      provider: routeProviderField?.value || modelRoles.route?.provider || "deepseek",
      model: routeModelField?.value || modelRoles.route?.model || "deepseek-v4-flash",
    },
    main: {
      ...(modelRoles.main || {}),
      provider: mainProviderField?.value || modelRoles.main?.provider || "deepseek",
      model: mainModelField?.value || modelRoles.main?.model || "deepseek-v4-pro",
    },
    spare: {
      ...(modelRoles.spare || {}),
      provider: spareProviderField?.value || modelRoles.spare?.provider || "openai",
      model: spareModelField?.value || modelRoles.spare?.model || "gpt-5.4",
      reasoning: spareReasoningField?.value || modelRoles.spare?.reasoning || "medium",
    },
    wrapper: {
      ...(modelRoles.wrapper || {}),
      provider: preferredWrapperField?.value || modelRoles.wrapper?.provider || "codex",
      model: wrapperModelField?.value || modelRoles.wrapper?.model || "gpt-5.5",
      reasoning: wrapperReasoningField?.value || modelRoles.wrapper?.reasoning || "medium",
    },
    auxiliary: {
      ...(modelRoles.auxiliary || {}),
      provider: auxiliaryProviderField?.value || modelRoles.auxiliary?.provider || "grsai",
      model: auxiliaryModelField?.value || modelRoles.auxiliary?.model || "nano-banana-2",
    },
  };
  modelRoleGridEl.innerHTML = Object.values(roles)
    .map((role) => {
      const reasoning = role.reasoning ? ` · ${role.reasoning}` : "";
      return `
        <div class="model-role-card">
          <strong>${escapeHtml(role.label || role.id)}</strong>
          <span>${escapeHtml(`${role.provider}/${role.model}${reasoning}`)}</span>
        </div>
      `;
    })
    .join("");
}

function renderModelOptions() {
  const provider = providerField.value || "deepseek";
  const options = providerModelOptions(provider);
  refreshModelDropdowns();
  if (modelRoutePillEl) {
    const mode = routingModeField.value || "smart";
    const primary = fieldValue(modelField) || defaults[provider] || "";
    const routeLabel = `${routeProviderField?.value || "deepseek"}/${routeModelField?.value || "deepseek-v4-flash"}`;
    const mainLabel = `${mainProviderField?.value || "deepseek"}/${mainModelField?.value || "deepseek-v4-pro"}`;
    modelRoutePillEl.textContent =
      mode === "manual"
        ? `${provider} · ${primary}`
        : `${mode} · ${routeLabel} -> ${mainLabel}`;
    modelRoutePillEl.title =
      mode === "manual" ? `Manual route: ${provider}/${primary}` : `Route: ${routeLabel}. Main: ${mainLabel}.`;
  }
  if (!modelCatalogEl) return;
  if (options.length === 0) {
    modelCatalogEl.innerHTML = "";
    return;
  }
  modelCatalogEl.innerHTML = options
    .map(
      (item) => `
        <button class="model-chip" type="button" data-model-id="${escapeHtml(item.id)}" data-active="${item.id === fieldValue(modelField)}">
          <strong>${escapeHtml(item.label || item.id)}</strong>
          <span>${escapeHtml([item.bucket || item.role, item.context, item.reasoning?.length ? `reasoning ${item.reasoning.join("/")}` : ""].filter(Boolean).join(" · "))}</span>
        </button>
      `
    )
    .join("");
  renderModelRoles();
}

function updateRoutingHint() {
  const mode = routingModeField.value || "smart";
  const hintKey = {
    smart: "routingHintSmart",
    fast: "routingHintFast",
    complex: "routingHintComplex",
    manual: "routingHintManual",
  }[mode];
  routingHintEl.textContent = t(hintKey);

  if (mode !== "manual" && providerField.value === "deepseek") {
    const preset =
      mode === "complex"
        ? {
            provider: mainProviderField?.value || routingPresets.complex?.provider,
            model: mainModelField?.value || routingPresets.complex?.model,
          }
        : {
            provider: routeProviderField?.value || routingPresets.fast?.provider,
            model: routeModelField?.value || routingPresets.fast?.model,
          };
    if (preset) {
      providerField.value = preset.provider === "deepseek" ? "deepseek" : providerField.value;
      modelField.value = preset.model || modelField.value;
    }
  }

  modelRouteStatusEl.textContent = `${t("modelRouteStatus")}: ${providerField.value} / ${
    fieldValue(modelField) || defaults[providerField.value] || ""
  }`;
  renderModelOptions();
}

function updatePackageWarning() {
  const policy = packageInstallPolicyField.value || "prompt";
  const sandboxMode = sandboxModeField.value || "host";
  const key =
    policy === "allow" && sandboxMode === "host"
      ? "packageWarningHostAllow"
      : policy === "allow"
        ? "packageWarningAllow"
        : policy === "block"
          ? "packageWarningBlock"
          : "packageWarningPrompt";
  packageWarningEl.textContent = t(key);
}

function permissionDefaults(mode = "normal") {
  if (mode === "safe") {
    return {
      sandboxMode: "docker-readonly",
      packageInstallPolicy: "prompt",
      workspaceWritePolicy: "prompt",
      allowPasswords: false,
      allowDestructive: false,
      allowOutsideWorkspaceFileTools: false,
    };
  }
  if (mode === "danger") {
    return {
      sandboxMode: "host",
      packageInstallPolicy: "allow",
      workspaceWritePolicy: "allow",
      allowPasswords: true,
      allowDestructive: true,
      allowOutsideWorkspaceFileTools: true,
    };
  }
  return {
    sandboxMode: "docker-workspace",
    packageInstallPolicy: "allow",
    workspaceWritePolicy: "allow",
    allowPasswords: false,
    allowDestructive: false,
    allowOutsideWorkspaceFileTools: false,
  };
}

function updatePermissionHint() {
  if (!permissionHintEl || !permissionModeField) return;
  const key =
    permissionModeField.value === "safe"
      ? "permissionHintSafe"
      : permissionModeField.value === "danger"
        ? "permissionHintDanger"
        : "permissionHintNormal";
  permissionHintEl.textContent = t(key);
}

function applyPermissionModeToForm(mode = permissionModeField?.value || "normal") {
  const defaults = permissionDefaults(mode);
  if (sandboxModeField) sandboxModeField.value = defaults.sandboxMode;
  if (packageInstallPolicyField) packageInstallPolicyField.value = defaults.packageInstallPolicy;
  const allowPasswordsField = document.querySelector("#allowPasswords");
  const allowDestructiveField = document.querySelector("#allowDestructive");
  if (allowPasswordsField) allowPasswordsField.checked = defaults.allowPasswords;
  if (allowDestructiveField) allowDestructiveField.checked = defaults.allowDestructive;
  updatePermissionHint();
  updatePackageWarning();
}

function applyLanguage(language, { persist = true } = {}) {
  currentLanguage = normalizeLanguage(language);
  document.documentElement.lang = currentLanguage;
  document.documentElement.dir = currentLanguage === "ar" ? "rtl" : "ltr";
  document.title = t("documentTitle");
  languageField.value = currentLanguage;

  for (const node of translatableNodes) {
    if (node === logsEl && logsEl.dataset.mode !== "empty") continue;
    node.textContent = t(node.dataset.i18n);
  }

  for (const node of placeholderNodes) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }

  for (const node of ariaLabelNodes) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  }

  renderKeyStatus();
  renderProjectStatus();
  renderWrapperStatus();
  renderWorkspacePanel();
  renderSandboxStatus();
  updateRoutingHint();
  updatePermissionHint();
  updatePackageWarning();
  renderSessions(lastSessions);
  renderSessionManager();
  renderChat(lastChatEntries);
  renderArtifactShell();
  updateStopRunButton();
  if (persist) schedulePreferenceSave();
}

function formPayload() {
  return {
    language: languageField.value,
    routingMode: routingModeField.value,
    provider: providerField.value,
    model: fieldValue(modelField),
    routeProvider: routeProviderField?.value || "deepseek",
    routeModel: fieldValue(routeModelField) || "deepseek-v4-flash",
    mainProvider: mainProviderField?.value || "deepseek",
    mainModel: fieldValue(mainModelField) || "deepseek-v4-pro",
    spareProvider: spareProviderField?.value || "openai",
    spareModel: fieldValue(spareModelField) || "gpt-5.4",
    spareReasoning: spareReasoningField?.value || "medium",
    wrapperModel: fieldValue(wrapperModelField) || "gpt-5.5",
    wrapperReasoning: wrapperReasoningField?.value || "medium",
    auxiliaryProvider: auxiliaryProviderField?.value || "grsai",
    auxiliaryModel: fieldValue(auxiliaryModelField) || "nano-banana-2",
    startUrl: document.querySelector("#startUrl").value.trim(),
    allowedDomains: document.querySelector("#allowedDomains").value.trim(),
    commandCwd: document.querySelector("#commandCwd").value.trim(),
    maxSteps: Number(document.querySelector("#maxSteps").value) || 24,
    permissionMode: permissionModeField?.value || "normal",
    sandboxMode: sandboxModeField.value,
    packageInstallPolicy: packageInstallPolicyField.value,
    workspaceWritePolicy: permissionDefaults(permissionModeField?.value || "normal").workspaceWritePolicy,
    headless: document.querySelector("#headless").checked,
    allowShellTool: document.querySelector("#allowShellTool").checked,
    allowFileTools: document.querySelector("#allowFileTools").checked,
    allowAuxiliaryTools: allowAuxiliaryToolsField?.checked ?? true,
    allowWebSearch: allowWebSearchField?.checked ?? true,
    allowParallelScouts: allowParallelScoutsField?.checked ?? true,
    parallelScoutCount: Math.min(Math.max(Number(parallelScoutCountField?.value) || 3, 1), 10),
    allowWrapperTools: allowWrapperToolsField.checked,
    preferredWrapper: preferredWrapperField.value,
    taskProfile: taskProfileField?.value || "auto",
    useDockerSandbox: sandboxModeField.value !== "host",
    dockerSandboxImage: document.querySelector("#dockerSandboxImage").value.trim(),
    allowPasswords: document.querySelector("#allowPasswords").checked,
    allowDestructive: document.querySelector("#allowDestructive").checked,
    allowOutsideWorkspaceFileTools: permissionDefaults(permissionModeField?.value || "normal").allowOutsideWorkspaceFileTools,
  };
}

function renderCommandOutputLog(entry) {
  const data = entry.data || {};
  const command = data.command || "";
  const stdout = data.stdout || "";
  const stderr = data.stderr || "";
  const stdoutPreview = outputPreviewText(stdout);
  const stderrPreview = outputPreviewText(stderr);
  const totalLines = outputLineCount(stdout) + outputLineCount(stderr);
  const large = totalLines > 18 || stdout.length + stderr.length > 2600;
  const policy = data.commandPolicy?.category ? ` · ${data.commandPolicy.category}` : "";
  const status = data.blocked ? "blocked" : data.error ? "error" : "ok";
  const details = [
    stdout ? `<div class="log-stream-title">stdout</div><pre>${escapeHtml(stdoutPreview.text)}</pre>` : "",
    stdoutPreview.hidden > 0 ? `<div class="log-fold-note">... ${stdoutPreview.hidden} more stdout line(s) folded</div>` : "",
    stderr ? `<div class="log-stream-title">stderr</div><pre>${escapeHtml(stderrPreview.text)}</pre>` : "",
    stderrPreview.hidden > 0 ? `<div class="log-fold-note">... ${stderrPreview.hidden} more stderr line(s) folded</div>` : "",
    data.error ? `<div class="log-fold-note">${escapeHtml(data.error)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <details class="log-command" ${large ? "" : "open"}>
      <summary>
        <span>${escapeHtml(`[${entry.at}] command ${status}${policy}`)}</span>
        <code>${escapeHtml(command)}</code>
        <small>stdout=${outputLineCount(stdout)} stderr=${outputLineCount(stderr)}${large ? " · folded" : ""}</small>
      </summary>
      ${details || `<div class="log-fold-note">No command output.</div>`}
    </details>
  `;
}

function renderPermissionApproval(entry) {
  const advice = entry.data?.permissionAdvice;
  if (!advice) return "";
  const summary = advice.summary || advice.reason || "Permission approval is required.";
  const category = advice.category || entry.data?.category || "";
  const suggested = advice.suggestedCommand
    ? `<div class="log-fold-note"><strong>rerun:</strong> <code>${escapeHtml(advice.suggestedCommand)}</code></div>`
    : "";
  const trusted = advice.trustedHostCommand
    ? `<div class="log-fold-note"><strong>host:</strong> <code>${escapeHtml(advice.trustedHostCommand)}</code></div>`
    : "";
  return `
    <article class="permission-approval">
      <strong>${escapeHtml(t("permissionApprovalTitle"))}</strong>
      <p>${escapeHtml(summary)}</p>
      <div class="subtle">${escapeHtml(category)}</div>
      ${suggested}
      ${trusted}
      <div class="permission-actions">
        <button type="button" class="mini-button danger" data-permission-action="no">${escapeHtml(t("permissionApprovalNo"))}</button>
        <button type="button" class="mini-button" data-permission-action="once">${escapeHtml(t("permissionApprovalOnce"))}</button>
        <button type="button" class="mini-button" data-permission-action="always">${escapeHtml(t("permissionApprovalAlways"))}</button>
      </div>
    </article>
  `;
}

function renderLogs(run) {
  logsEl.dataset.mode = "active";
  const parts = [
    `<div class="log-line">${escapeHtml(`status=${run.status} session=${run.sessionId} provider=${run.provider} model=${run.model}`)}</div>`,
    run.result ? `<div class="log-line">${escapeHtml(`result=${run.result}`)}</div>` : "",
    run.error ? `<div class="log-line error">${escapeHtml(`error=${run.error}`)}</div>` : "",
  ];

  for (const entry of run.logs || []) {
    if (entry.message === "command.output") {
      parts.push(renderCommandOutputLog(entry));
      continue;
    }
    parts.push(`<div class="log-line">${escapeHtml(`[${entry.at}] ${entry.kind}: ${entry.message}`)}</div>`);
    if (entry.message === "tool.blocked" && entry.data?.permissionAdvice) {
      parts.push(renderPermissionApproval(entry));
      continue;
    }
    if (entry.data && Object.keys(entry.data).length > 0) {
      parts.push(`<pre class="log-json">${escapeHtml(JSON.stringify(entry.data, null, 2))}</pre>`);
    }
  }

  logsEl.innerHTML = parts.filter(Boolean).join("");
  logsEl.scrollTop = logsEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function renderDiffHtml(value, maxChars = 1200) {
  return String(value || "")
    .slice(0, maxChars)
    .split(/\r?\n/)
    .map((line) => {
      const escaped = escapeHtml(line);
      if (/^\+(?!\+\+)/.test(line)) return `<span class="diff-add">${escaped}</span>`;
      if (/^-(?!--)/.test(line)) return `<span class="diff-del">${escaped}</span>`;
      if (/^\+\+\+/.test(line)) return `<span class="diff-file-add">${escaped}</span>`;
      if (/^---/.test(line)) return `<span class="diff-file-del">${escaped}</span>`;
      if (/^@@/.test(line)) return `<span class="diff-hunk">${escaped}</span>`;
      return escaped;
    })
    .join("\n");
}

function safeLinkHref(value) {
  const raw = String(value || "").trim();
  try {
    const parsed = new URL(raw, window.location.origin);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function renderInlineMarkdown(value) {
  const placeholders = [];
  const protect = (html) => {
    const index = placeholders.push(html) - 1;
    return `\u0000${index}\u0000`;
  };

  let text = String(value || "");
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => protect(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = safeLinkHref(href);
    if (!safeHref) return escapeHtml(label);
    return protect(
      `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  });

  let html = escapeHtml(text);
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

function renderMarkdownTable(headerLine, rows) {
  const headers = splitTableRow(headerLine);
  const bodyRows = rows.map(splitTableRow);
  return `
    <div class="markdown-table-wrap">
      <table>
        <thead>
          <tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${bodyRows
            .map((row) => `<tr>${headers.map((_header, index) => `<td>${renderInlineMarkdown(row[index] || "")}</td>`).join("")}</tr>`)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function isMarkdownBlockStart(line, nextLine = "") {
  const trimmed = String(line || "").trim();
  return (
    /^```/.test(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^[-*_]{3,}$/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    (trimmed.includes("|") && isMarkdownTableSeparator(nextLine))
  );
}

function unwrapRenderableMarkdownFence(value = "") {
  const raw = String(value || "");
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : raw;
}

function renderMarkdown(value) {
  const lines = unwrapRenderableMarkdownFence(value).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" ").trim())}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    html.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = "";
    listItems = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const language = fence[1] || "";
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      html.push(
        `<pre class="markdown-code"><code data-language="${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre>`
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    if (trimmed.includes("|") && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      flushList();
      const header = line;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTable(header, rows));
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    if (listItems.length) flushList();
    paragraph.push(trimmed);
    if (index + 1 >= lines.length || isMarkdownBlockStart(lines[index + 1], lines[index + 2])) flushParagraph();
  }

  flushParagraph();
  flushList();
  return html.join("");
}

function renderChat(chatEntries) {
  lastChatEntries = chatEntries || [];

  if (lastChatEntries.length === 0) {
    chatThreadEl.innerHTML = `<div class="subtle">${t("noConversationLoaded")}</div>`;
    return;
  }

  chatThreadEl.innerHTML = lastChatEntries
    .map((entry) => {
      const role = entry.role === "assistant" ? "assistant" : "user";
      const label = role === "assistant" ? t("assistantLabel") : t("youLabel");
      const content =
        role === "assistant"
          ? `<div class="markdown-body">${renderMarkdown(entry.content)}</div>`
          : escapeHtml(entry.content).replace(/\n/g, "<br>");
      return `
        <article class="chat-item ${role}">
          <div class="chat-meta">${label}${entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}</div>
          <div class="chat-content">${content}</div>
        </article>
      `;
    })
    .join("");

  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

function afterFinishQueueKey(sessionId = currentSessionId) {
  return `agintiflow.web.afterFinishQueue.${sessionId || "none"}`;
}

function loadAfterFinishQueue(sessionId = currentSessionId) {
  if (!sessionId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(afterFinishQueueKey(sessionId)) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.content) : [];
  } catch {
    return [];
  }
}

function saveAfterFinishQueue(sessionId = currentSessionId) {
  if (!sessionId) return;
  localStorage.setItem(afterFinishQueueKey(sessionId), JSON.stringify(pendingAfterFinishItems));
}

function newLocalQueueId() {
  if (globalThis.crypto?.randomUUID) return `after-${globalThis.crypto.randomUUID()}`;
  return `after-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compactMessage(content, limit = 220) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function renderPendingMessages() {
  if (!chatPendingEl) return;
  const inboxItems = pendingInboxItems || [];
  const afterItems = pendingAfterFinishItems || [];
  if (inboxItems.length === 0 && afterItems.length === 0) {
    chatPendingEl.hidden = true;
    chatPendingEl.innerHTML = "";
    return;
  }

  const section = (label, items, kind) => {
    if (!items.length) return "";
    return `
      <div class="pending-section">
        <div class="pending-label">${escapeHtml(label)}</div>
        ${items
          .map(
            (item) => `
              <div class="pending-item">
                <div class="pending-copy">
                  <span class="pending-kind ${kind}">${kind === "asap" ? "→" : "↳"}</span>
                  <span>${escapeHtml(compactMessage(item.content))}</span>
                </div>
                <div class="pending-actions">
                  <button type="button" class="mini-button" data-edit-${kind}="${escapeHtml(item.id)}">${t(
                    "editQueuedMessage"
                  )}</button>
                  <button type="button" class="mini-button danger" data-remove-${kind}="${escapeHtml(item.id)}">${t(
                    "removeQueuedMessage"
                  )}</button>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  };

  chatPendingEl.hidden = false;
  chatPendingEl.innerHTML = `
    <div class="pending-header">
      <strong>${t("pendingMessagesTitle")}</strong>
      <span>${t("queuedConsumedHint")}</span>
    </div>
    ${section(t("asapQueueLabel"), inboxItems, "asap")}
    ${section(t("afterFinishQueueLabel"), afterItems, "after")}
  `;
}

async function refreshInbox() {
  if (!currentSessionId) {
    pendingInboxItems = [];
    pendingAfterFinishItems = [];
    renderPendingMessages();
    return;
  }

  pendingAfterFinishItems = loadAfterFinishQueue(currentSessionId);
  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/inbox`);
  if (!response.ok) {
    pendingInboxItems = [];
    renderPendingMessages();
    return;
  }
  const data = await response.json();
  pendingInboxItems = data.items || [];
  renderPendingMessages();
}

async function updateInboxItem(itemId, content) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/inbox/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("failedContinue"));
  await refreshInbox();
}

async function removeInboxItem(itemId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/inbox/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("failedContinue"));
  await refreshInbox();
}

function editAfterFinishItem(itemId) {
  const item = pendingAfterFinishItems.find((candidate) => candidate.id === itemId);
  if (!item) return;
  pendingAfterFinishItems = pendingAfterFinishItems.filter((candidate) => candidate.id !== itemId);
  saveAfterFinishQueue();
  chatInputEl.value = item.content;
  chatInputEl.focus();
  renderPendingMessages();
}

function removeAfterFinishItem(itemId) {
  pendingAfterFinishItems = pendingAfterFinishItems.filter((candidate) => candidate.id !== itemId);
  saveAfterFinishQueue();
  renderPendingMessages();
}

function queueAfterFinishFromInput() {
  if (!currentSessionId) {
    chatStatusEl.textContent = t("selectSessionFirst");
    return;
  }
  const content = chatInputEl.value.trim();
  if (!content) {
    chatStatusEl.textContent = t("messageRequired");
    return;
  }
  pendingAfterFinishItems = [
    ...pendingAfterFinishItems,
    {
      id: newLocalQueueId(),
      content,
      timestamp: new Date().toISOString(),
      source: "web",
    },
  ];
  saveAfterFinishQueue();
  chatInputEl.value = "";
  chatStatusEl.textContent = t("queuedAfterFinishStatus");
  renderPendingMessages();
}

async function pipeMessageFromInput() {
  if (!currentSessionId) {
    chatStatusEl.textContent = t("selectSessionFirst");
    return;
  }
  const content = chatInputEl.value.trim();
  if (!content) {
    chatStatusEl.textContent = t("messageRequired");
    return;
  }

  chatStatusEl.textContent = t("sendingStatus");
  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, priority: "asap" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    chatStatusEl.textContent = data.error || t("failedContinue");
    return;
  }
  chatInputEl.value = "";
  chatStatusEl.textContent = t("queuedAsapStatus");
  pendingInboxItems = data.item ? [...pendingInboxItems, data.item] : pendingInboxItems;
  renderPendingMessages();
  await refreshInbox();
}

async function flushAfterFinishQueue() {
  if (!currentSessionId || flushingAfterFinish || currentRunStatus === "running" || pendingAfterFinishItems.length === 0) return;
  flushingAfterFinish = true;
  const next = pendingAfterFinishItems[0];
  pendingAfterFinishItems = pendingAfterFinishItems.slice(1);
  saveAfterFinishQueue();
  renderPendingMessages();

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...formPayload(),
        content: next.content,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t("failedContinue"));
    currentSessionId = data.sessionId;
    currentRunStatus = data.queued ? currentRunStatus : "running";
    updateStopRunButton();
    chatStatusEl.textContent = data.queued ? t("queuedStatus") : t("runningStatus");
    await refreshSessions();
    await refreshChat();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshRun, 1500);
    await refreshRun();
  } catch (error) {
    pendingAfterFinishItems = [next, ...pendingAfterFinishItems];
    saveAfterFinishQueue();
    renderPendingMessages();
    chatStatusEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    flushingAfterFinish = false;
  }
}

function artifactReadKey(sessionId = currentSessionId) {
  return `agintiflow.artifacts.readIds.${sessionId || "none"}`;
}

function getArtifactReadIds(sessionId = currentSessionId) {
  try {
    const raw = localStorage.getItem(artifactReadKey(sessionId)) || "[]";
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveArtifactReadIds(readIds, sessionId = currentSessionId) {
  if (!sessionId) return;
  try {
    localStorage.setItem(artifactReadKey(sessionId), JSON.stringify([...readIds].slice(-800)));
  } catch {
    // Local storage is optional for notification state.
  }
}

function computeUnreadArtifactCount() {
  const readIds = getArtifactReadIds();
  return artifactItems.filter((item) => !readIds.has(item.id)).length;
}

function markArtifactRead(artifactId) {
  if (!artifactId) return;
  const readIds = getArtifactReadIds();
  readIds.add(artifactId);
  saveArtifactReadIds(readIds);
  artifactUnreadCount = computeUnreadArtifactCount();
}

function markAllArtifactsRead() {
  const readIds = getArtifactReadIds();
  for (const item of artifactItems) readIds.add(item.id);
  saveArtifactReadIds(readIds);
  artifactUnreadCount = 0;
}

function renderArtifactBadge(count = computeUnreadArtifactCount()) {
  artifactUnreadCount = Number(count) || 0;
  if (!artifactBadgeEl) return;
  artifactBadgeEl.textContent = artifactUnreadCount > 99 ? "99+" : String(artifactUnreadCount);
  artifactBadgeEl.hidden = artifactUnreadCount <= 0;
}

function artifactLabel(item) {
  const source = item.source ? item.source.replace(/-/g, " ") : "artifact";
  const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
  return [item.kind, source, when].filter(Boolean).join(" · ");
}

function isPdfArtifact(item) {
  return item?.kind === "pdf" || item?.mime === "application/pdf" || /\.pdf$/i.test(item?.path || "");
}

function artifactVisibleInCurrentTab(item) {
  if (currentArtifactTab === "pdf") return isPdfArtifact(item);
  return item.tab === currentArtifactTab;
}

function preferredArtifactForCurrentTab(fallbackId = "") {
  const current = artifactItems.find((item) => item.id === selectedArtifactId && artifactVisibleInCurrentTab(item));
  if (current) return current;

  const fallback = artifactItems.find((item) => item.id === fallbackId && artifactVisibleInCurrentTab(item));
  if (fallback) return fallback;

  return artifactItems.find(artifactVisibleInCurrentTab) || null;
}

function renderArtifactList() {
  if (!artifactListEl) return;
  const visible = artifactItems.filter(artifactVisibleInCurrentTab);
  const readIds = getArtifactReadIds();

  document.querySelectorAll(".artifact-tab").forEach((tab) => {
    tab.dataset.selected = String(tab.dataset.artifactTab === currentArtifactTab);
  });

  if (!currentSessionId) {
    artifactListEl.innerHTML = `<p class="subtle">${t("selectSessionFirst")}</p>`;
    return;
  }

  if (visible.length === 0) {
    artifactListEl.innerHTML = `<p class="subtle">${t("artifactEmpty")}</p>`;
    return;
  }

  artifactListEl.innerHTML = visible
    .map(
      (item) => {
        const read = readIds.has(item.id);
        return `
        <div class="artifact-row" data-selected="${item.id === selectedArtifactId}" data-read="${read}">
          <button class="artifact-row-main" type="button" data-artifact-id="${escapeHtml(item.id)}">
            <span class="artifact-row-top">
              <strong>${escapeHtml(item.title || item.path || item.kind)}</strong>
              <span>${read ? escapeHtml(item.kind) : `New · ${escapeHtml(item.kind)}`}</span>
            </span>
            <span class="artifact-row-meta">${escapeHtml(artifactLabel(item))}</span>
            <span class="artifact-row-preview">${escapeHtml(item.preview || item.path || "")}</span>
          </button>
          <button
            class="artifact-menu-button"
            type="button"
            data-artifact-download-id="${escapeHtml(item.id)}"
            aria-label="${escapeHtml(t("artifactDownloadLabel"))}"
            title="${escapeHtml(t("artifactDownloadLabel"))}"
          >...</button>
        </div>
      `;
      }
    )
    .join("");
}

function resetArtifactViewer() {
  artifactViewerTitleEl.textContent = t("artifactViewerEmptyTitle");
  artifactViewerMetaEl.textContent = "";
  artifactViewerKindEl.textContent = "";
  artifactViewerBodyEl.innerHTML = `<p class="subtle">${t("artifactViewerEmpty")}</p>`;
}

function artifactRawUrl(artifactId, { download = false } = {}) {
  if (!currentSessionId || !artifactId) return "";
  const base = `/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts/${encodeURIComponent(artifactId)}/raw`;
  return download ? `${base}?download=1` : base;
}

function renderArtifactShell() {
  renderArtifactBadge();
  renderArtifactList();
  const selected = artifactItems.find((item) => item.id === selectedArtifactId);
  if (!selected || !artifactVisibleInCurrentTab(selected)) {
    resetArtifactViewer();
  }
}

function renderArtifactContent(content) {
  const item = artifactItems.find((candidate) => candidate.id === content.id);
  artifactViewerTitleEl.textContent = content.title || item?.title || t("artifactViewerEmptyTitle");
  artifactViewerMetaEl.textContent = [content.path || item?.path, item ? artifactLabel(item) : ""].filter(Boolean).join(" · ");
  artifactViewerKindEl.textContent = content.kind || item?.kind || "";
  const streamedUrl = content.url || (content.id ? artifactRawUrl(content.id) : "");
  const downloadUrl = content.downloadUrl || (content.id ? artifactRawUrl(content.id, { download: true }) : "");
  const renderUrl = streamedUrl || content.dataUrl;

  if (renderUrl && (content.kind === "pdf" || content.mime === "application/pdf")) {
    artifactViewerBodyEl.innerHTML = `
      <iframe class="artifact-pdf-frame" src="${renderUrl}" title="${escapeHtml(content.title || "Artifact PDF")}"></iframe>
    `;
    return;
  }

  if (renderUrl && (content.kind === "image" || String(content.mime || "").startsWith("image/"))) {
    artifactViewerBodyEl.innerHTML = `
      <figure class="artifact-image-frame">
        <img class="artifact-preview-image" src="${renderUrl}" alt="${escapeHtml(content.title || "Artifact image")}" />
      </figure>
    `;
    return;
  }

  if ((content.tooLargeForInline || content.binary) && streamedUrl) {
    artifactViewerBodyEl.innerHTML = `
      <div class="artifact-large-file">
        <strong>${escapeHtml(content.preview || "Artifact is available as a streamed file.")}</strong>
        <p>${escapeHtml(content.path || item?.path || content.title || "Generated artifact")}</p>
        <div class="artifact-file-actions">
          <a class="secondary-button" href="${streamedUrl}" target="_blank" rel="noreferrer">Open preview</a>
          <a class="secondary-button" href="${downloadUrl}" download="${escapeHtml(artifactDownloadName(item, content))}">Download</a>
        </div>
      </div>
    `;
    return;
  }

  const text = typeof content.text === "string" ? content.text : "";
  if (content.kind === "markdown" || /markdown/i.test(content.mime || "")) {
    artifactViewerBodyEl.innerHTML = `<div class="artifact-markdown markdown-body">${renderMarkdown(text)}</div>`;
    return;
  }

  artifactViewerBodyEl.innerHTML = `
    <textarea class="artifact-editor" readonly spellcheck="false">${escapeHtml(text)}</textarea>
  `;
}

function artifactDownloadName(item, content) {
  const sourceName = content.path || item?.path || content.title || item?.title || `artifact-${content.id || "download"}`;
  const fallbackExt =
    content.mime === "application/pdf" || content.kind === "pdf"
      ? ".pdf"
      : content.mime?.startsWith("image/png")
        ? ".png"
        : content.mime?.startsWith("image/jpeg")
          ? ".jpg"
          : content.mime?.startsWith("image/webp")
            ? ".webp"
            : content.mime?.startsWith("image/svg")
              ? ".svg"
              : content.kind === "json"
                ? ".json"
                : content.kind === "diff"
                  ? ".diff"
                  : content.kind === "markdown"
                    ? ".md"
                    : ".txt";
  const base = sourceName
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = base || `artifact-${content.id || Date.now()}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}${fallbackExt}`;
}

function blobFromDataUrl(dataUrl) {
  const [meta = "", payload = ""] = String(dataUrl || "").split(",", 2);
  const mime = meta.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  if (meta.includes(";base64")) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

async function downloadArtifact(artifactId) {
  if (!currentSessionId || !artifactId) return;
  const item = artifactItems.find((candidate) => candidate.id === artifactId);
  artifactStatusEl.textContent = t("artifactDownloadPreparing");

  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts/${encodeURIComponent(artifactId)}`
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t("artifactDownloadFailed"));

    if ((data.downloadUrl || data.url) && !data.dataUrl && typeof data.text !== "string") {
      const link = document.createElement("a");
      link.href = data.downloadUrl || artifactRawUrl(artifactId, { download: true }) || data.url;
      link.download = artifactDownloadName(item, data);
      document.body.append(link);
      link.click();
      link.remove();

      markArtifactRead(artifactId);
      renderArtifactBadge();
      renderArtifactList();
      artifactStatusEl.textContent = t("artifactDownloadReady");
      return;
    }

    const blob = data.dataUrl
      ? blobFromDataUrl(data.dataUrl)
      : new Blob([typeof data.text === "string" ? data.text : JSON.stringify(data, null, 2)], {
          type: data.mime || "text/plain;charset=utf-8",
        });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactDownloadName(item, data);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    markArtifactRead(artifactId);
    renderArtifactBadge();
    renderArtifactList();
    artifactStatusEl.textContent = t("artifactDownloadReady");
  } catch (error) {
    artifactStatusEl.textContent = error instanceof Error ? error.message : t("artifactDownloadFailed");
  }
}

async function refreshArtifacts({ loadSelected = false } = {}) {
  if (!currentSessionId) {
    artifactItems = [];
    selectedArtifactId = "";
    artifactUnreadCount = 0;
    renderArtifactShell();
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts`);
  if (!response.ok) return;
  const data = await response.json();
  artifactItems = data.items || [];
  artifactUnreadCount = computeUnreadArtifactCount();

  if (loadSelected) {
    const backendSelected = artifactItems.find((item) => item.id === data.selectedItemId);
    const pdfCandidate = artifactItems.find((item) => item.id === selectedArtifactId && isPdfArtifact(item))
      || (backendSelected && isPdfArtifact(backendSelected) ? backendSelected : null)
      || artifactItems.find(isPdfArtifact);
    if (pdfCandidate) {
      currentArtifactTab = "pdf";
      selectedArtifactId = pdfCandidate.id;
    }
  }

  if (!selectedArtifactId || !artifactItems.some((item) => item.id === selectedArtifactId)) {
    selectedArtifactId = data.selectedItemId || artifactItems[0]?.id || "";
  }

  const visiblePreferred = preferredArtifactForCurrentTab(data.selectedItemId);
  if (visiblePreferred) {
    selectedArtifactId = visiblePreferred.id;
  }

  renderArtifactShell();
  if (loadSelected && selectedArtifactId) await selectArtifact(selectedArtifactId, { persist: false });
}

async function selectArtifact(artifactId, { persist = true } = {}) {
  if (!currentSessionId || !artifactId) return;
  selectedArtifactId = artifactId;
  renderArtifactList();
  artifactStatusEl.textContent = t("artifactLoading");

  if (persist) {
    await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId }),
    }).catch(() => {});
  }

  const response = await fetch(
    `/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts/${encodeURIComponent(artifactId)}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    artifactStatusEl.textContent = data.error || t("artifactLoadFailed");
    return;
  }

  artifactStatusEl.textContent = "";
  markArtifactRead(artifactId);
  renderArtifactBadge();
  renderArtifactList();
  renderArtifactContent(data);
}

async function openArtifactTunnel() {
  if (!currentSessionId) {
    chatStatusEl.textContent = t("selectSessionFirst");
    return;
  }
  artifactStatusEl.textContent = "";
  artifactTunnelDialog.showModal();
  await refreshArtifacts({ loadSelected: true });
}

function closeArtifactTunnel() {
  artifactTunnelDialog.close();
  artifactStatusEl.textContent = "";
}

function renderSessions(sessions) {
  lastSessions = sessions || [];
  const current = sessionSelectEl.value;
  const options = [`<option value="">${t("selectRecentSession")}</option>`]
    .concat(
      lastSessions.map((session) => {
        const rawTitle = session.title || session.goal || session.sessionId;
        const title = escapeHtml(`${rawTitle.slice(0, 60)}${rawTitle.length > 60 ? "..." : ""}`);
        const label = `${escapeHtml(session.provider)} · ${title}`;
        return `<option value="${escapeHtml(session.sessionId)}">${label}</option>`;
      })
    )
    .join("");

  sessionSelectEl.innerHTML = options;
  if (current && [...sessionSelectEl.options].some((opt) => opt.value === current)) {
    sessionSelectEl.value = current;
  }
}

function currentManagedSession() {
  return lastSessions.find((session) => session.sessionId === managedSessionId) || lastSessions[0] || null;
}

function renderSessionManager(message = "") {
  if (!sessionManagerListEl) return;
  if (!managedSessionId && currentSessionId) managedSessionId = currentSessionId;
  if (!lastSessions.some((session) => session.sessionId === managedSessionId)) {
    managedSessionId = lastSessions[0]?.sessionId || "";
  }

  const selected = currentManagedSession();
  sessionTitleInputEl.value = selected ? selected.title || selected.goal || "" : "";
  sessionTitleInputEl.disabled = !selected;
  autoRenameSessionButton.disabled = !selected;
  renameSessionButton.disabled = !selected;
  deleteSessionButton.disabled = !selected;
  sessionManagerStatusEl.textContent = message;

  if (!lastSessions.length) {
    sessionManagerListEl.innerHTML = `<p class="subtle">${t("noSessionsToManage")}</p>`;
    return;
  }

  sessionManagerListEl.innerHTML = lastSessions
    .map((session) => {
      const title = session.title || session.goal || session.sessionId;
      const meta = [session.status, session.provider, session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ""]
        .filter(Boolean)
        .join(" · ");
      return `
        <button class="session-row" type="button" data-session-id="${escapeHtml(session.sessionId)}" data-selected="${session.sessionId === managedSessionId}">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(meta)}</span>
        </button>
      `;
    })
    .join("");
}

async function refreshSessions() {
  const response = await fetch("/api/sessions");
  const data = await response.json();
  renderSessions(data.sessions || []);
  renderSessionManager();
}

async function refreshWorkspaceChanges() {
  const response = await fetch("/api/workspace/changes");
  if (!response.ok) return;
  const data = await response.json();
  renderWorkspacePanel(data.workspace, data.activity || []);
}

async function refreshRun() {
  if (!currentSessionId) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(currentSessionId)}`);
  if (!response.ok) return;
  const run = await response.json();
  currentRunStatus = run.status || "";
  updateStopRunButton();
  runMetaEl.textContent = `${run.status} · ${run.sessionId}`;
  renderLogs(run);
  await refreshArtifacts({ loadSelected: artifactTunnelDialog?.open });
  await refreshInbox();

  if (run.status === "finished" || run.status === "failed" || run.status === "stopped") {
    clearInterval(pollTimer);
    pollTimer = null;
    await refreshChat();
    await refreshSessions();
    await refreshWorkspaceChanges();
    await refreshArtifacts({ loadSelected: artifactTunnelDialog?.open });
    if (run.status === "finished") await flushAfterFinishQueue();
  }
}

async function stopCurrentRun() {
  if (!currentSessionId || currentRunStatus !== "running") return;
  stopRunButton.disabled = true;
  chatStatusEl.textContent = t("stoppingRun");
  const response = await fetch(`/api/runs/${encodeURIComponent(currentSessionId)}/stop`, {
    method: "POST",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    chatStatusEl.textContent = data.error || t("stopRunFailed");
    updateStopRunButton();
    return;
  }
  await refreshRun();
}

async function approvePermission(action) {
  if (!currentSessionId) return;
  chatStatusEl.textContent = t("sendingStatus");
  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/approve-permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...formPayload(),
      action,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    chatStatusEl.textContent = data.error || t("permissionApprovalFailed");
    return;
  }
  if (data.permissionMode && action === "always" && permissionModeField) {
    permissionModeField.value = data.permissionMode;
    applyPermissionModeToForm(data.permissionMode);
  }
  currentRunStatus = action === "no" ? currentRunStatus : "running";
  chatStatusEl.textContent = action === "no" ? t("permissionApprovalNo") : t("runningStatus");
  updateStopRunButton();
  await refreshRun();
  if (action !== "no") {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshRun, 1500);
  }
}

async function refreshChat() {
  if (!currentSessionId) {
    pendingInboxItems = [];
    pendingAfterFinishItems = [];
    renderPendingMessages();
    renderChat([]);
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/chat`);
  if (!response.ok) {
    renderChat([]);
    return;
  }

  const data = await response.json();
  pendingInboxItems = data.inbox || [];
  pendingAfterFinishItems = loadAfterFinishQueue(currentSessionId);
  renderPendingMessages();
  renderChat(data.chat || []);
}

async function savePreferences() {
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formPayload()),
  });
}

async function refreshSandboxStatus() {
  await savePreferences();
  sandboxStatusEl.textContent = "Checking sandbox...";
  const response = await fetch("/api/sandbox/status");
  const data = await response.json();
  if (!response.ok) {
    sandboxStatusEl.textContent = data.error || "Sandbox status failed.";
    return;
  }
  renderSandboxStatus(data.status);
}

async function runSandboxPreflight() {
  await savePreferences();
  sandboxStatusEl.textContent = "Running preflight...";
  const response = await fetch("/api/sandbox/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...formPayload(), buildImage: true }),
  });
  const data = await response.json();
  if (!response.ok) {
    sandboxStatusEl.textContent = data.error || "Sandbox preflight failed.";
    return;
  }
  renderSandboxStatus(data.status);
  const checkLines = (data.checks || [])
    .map((check) => `${check.ok ? "OK" : "FAIL"} ${check.command}: ${check.stdout || check.stderr || check.error || ""}`)
    .join("\n");
  sandboxLogsEl.textContent = [checkLines, JSON.stringify({ manifests: data.manifests || [] }, null, 2)]
    .filter(Boolean)
    .join("\n\n");
}

async function openSessionManager() {
  await refreshSessions();
  managedSessionId = currentSessionId || managedSessionId || lastSessions[0]?.sessionId || "";
  renderSessionManager();
  sessionManagerDialog.showModal();
}

function closeSessionManager() {
  sessionManagerDialog.close();
  sessionManagerStatusEl.textContent = "";
}

async function renameManagedSession() {
  const selected = currentManagedSession();
  if (!selected) return;

  const title = sessionTitleInputEl.value.trim();
  if (!title) {
    sessionManagerStatusEl.textContent = t("titleRequired");
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(selected.sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    sessionManagerStatusEl.textContent = data.error || t("manageSessionFailed");
    return;
  }

  await refreshSessions();
  renderSessionManager(t("sessionRenamed"));
}

async function autoRenameManagedSession() {
  const selected = currentManagedSession();
  if (!selected) return;

  const response = await fetch(`/api/sessions/${encodeURIComponent(selected.sessionId)}/auto-title`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    sessionManagerStatusEl.textContent = data.error || t("manageSessionFailed");
    return;
  }

  await refreshSessions();
  renderSessionManager(t("sessionRenamed"));
}

async function deleteManagedSession() {
  const selected = currentManagedSession();
  if (!selected || !confirm(t("deleteConfirm"))) return;

  const response = await fetch(`/api/sessions/${encodeURIComponent(selected.sessionId)}`, {
    method: "DELETE",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    sessionManagerStatusEl.textContent = data.error || t("manageSessionFailed");
    return;
  }

  if (currentSessionId === selected.sessionId) {
    currentSessionId = "";
    sessionSelectEl.value = "";
    runMetaEl.textContent = "";
    setLogs(t("noRunSelected"), "empty");
    renderChat([]);
    artifactItems = [];
    selectedArtifactId = "";
    renderArtifactShell();
  }
  managedSessionId = "";
  await refreshSessions();
  renderSessionManager(t("sessionDeleted"));
}

function schedulePreferenceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePreferences().catch(() => {});
  }, 250);
}

languageField.addEventListener("change", () => {
  applyLanguage(languageField.value);
});

routingModeField.addEventListener("change", () => {
  updateRoutingHint();
  schedulePreferenceSave();
});

checkSandboxButton.addEventListener("click", () => {
  refreshSandboxStatus().catch((error) => {
    sandboxStatusEl.textContent = String(error);
  });
});

preflightSandboxButton.addEventListener("click", () => {
  runSandboxPreflight().catch((error) => {
    sandboxStatusEl.textContent = String(error);
  });
});

manageSessionsButton.addEventListener("click", () => {
  openSessionManager().catch((error) => {
    chatStatusEl.textContent = String(error);
  });
});

openArtifactsButton.addEventListener("click", () => {
  openArtifactTunnel().catch((error) => {
    chatStatusEl.textContent = String(error);
  });
});

function closeSettings() {
  settingsDialog?.close();
  renderModelOptions();
  schedulePreferenceSave();
}

openSettingsButton?.addEventListener("click", () => {
  refreshModelDropdowns();
  settingsDialog?.showModal();
});

closeSettingsButton?.addEventListener("click", closeSettings);
doneSettingsButton?.addEventListener("click", closeSettings);
closeSessionManagerButton.addEventListener("click", closeSessionManager);
cancelSessionManagerButton.addEventListener("click", closeSessionManager);
closeArtifactTunnelButton.addEventListener("click", closeArtifactTunnel);

settingsDialog?.addEventListener("click", (event) => {
  if (event.target === settingsDialog) closeSettings();
});

sessionManagerDialog.addEventListener("click", (event) => {
  if (event.target === sessionManagerDialog) closeSessionManager();
});

artifactTunnelDialog.addEventListener("click", (event) => {
  if (event.target === artifactTunnelDialog) closeArtifactTunnel();
});

artifactTabsEl.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-artifact-tab]");
  if (!tab) return;
  currentArtifactTab = tab.dataset.artifactTab || "canvas";
  const preferred = preferredArtifactForCurrentTab();
  if (preferred) selectedArtifactId = preferred.id;
  renderArtifactShell();
  if (selectedArtifactId) {
    selectArtifact(selectedArtifactId, { persist: false }).catch((error) => {
      artifactStatusEl.textContent = String(error);
    });
  }
});

artifactListEl.addEventListener("click", (event) => {
  const downloadButton = event.target.closest("[data-artifact-download-id]");
  if (downloadButton) {
    event.stopPropagation();
    downloadArtifact(downloadButton.dataset.artifactDownloadId || "").catch((error) => {
      artifactStatusEl.textContent = String(error);
    });
    return;
  }

  const row = event.target.closest("[data-artifact-id]");
  if (!row) return;
  selectArtifact(row.dataset.artifactId || "").catch((error) => {
    artifactStatusEl.textContent = String(error);
  });
});

markArtifactsSeenButton.addEventListener("click", () => {
  markAllArtifactsRead();
  renderArtifactBadge();
  renderArtifactList();
  artifactStatusEl.textContent = t("artifactSeenUpdated");
  refreshArtifacts({ loadSelected: false }).catch(() => {});
});

sessionManagerListEl.addEventListener("click", (event) => {
  const row = event.target.closest("[data-session-id]");
  if (!row) return;
  managedSessionId = row.dataset.sessionId || "";
  renderSessionManager();
});

renameSessionButton.addEventListener("click", () => {
  renameManagedSession().catch((error) => {
    sessionManagerStatusEl.textContent = String(error);
  });
});

autoRenameSessionButton.addEventListener("click", () => {
  autoRenameManagedSession().catch((error) => {
    sessionManagerStatusEl.textContent = String(error);
  });
});

deleteSessionButton.addEventListener("click", () => {
  deleteManagedSession().catch((error) => {
    sessionManagerStatusEl.textContent = String(error);
  });
});

providerField.addEventListener("change", () => {
  if (providerField.value === "mock" || providerField.value === "venice" || providerField.value === "openai" || providerField.value === "qwen") {
    routingModeField.value = "manual";
  }

  if (
    !fieldValue(modelField) ||
    modelField.value === defaults.openai ||
    modelField.value === defaults.deepseek ||
    modelField.value === defaults.qwen ||
    modelField.value === defaults.venice ||
    modelField.value === defaults.mock
  ) {
    modelField.value = defaults[providerField.value] || "";
  }
  updateRoutingHint();
  schedulePreferenceSave();
});

modelCatalogEl?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-model-id]");
  if (!button) return;
  modelField.value = button.dataset.modelId || modelField.value;
  updateRoutingHint();
  schedulePreferenceSave();
});

modelField.addEventListener("change", updateRoutingHint);
[routeProviderField, routeModelField, mainProviderField, mainModelField, spareProviderField, spareModelField, spareReasoningField, wrapperModelField, wrapperReasoningField, auxiliaryProviderField, auxiliaryModelField]
  .filter(Boolean)
  .forEach((field) => {
    field.addEventListener("input", () => {
      if (field === routeProviderField || field === mainProviderField || field === spareProviderField || field === auxiliaryProviderField) refreshModelDropdowns();
      renderModelRoles();
      renderModelOptions();
      schedulePreferenceSave();
    });
    field.addEventListener("change", () => {
      if (field === routeProviderField || field === mainProviderField || field === spareProviderField || field === auxiliaryProviderField) refreshModelDropdowns();
      renderModelRoles();
      renderModelOptions();
      schedulePreferenceSave();
    });
  });
sandboxModeField.addEventListener("change", updatePackageWarning);
packageInstallPolicyField.addEventListener("change", updatePackageWarning);
permissionModeField?.addEventListener("change", () => {
  applyPermissionModeToForm(permissionModeField.value);
  schedulePreferenceSave();
});
allowWrapperToolsField.addEventListener("change", () => renderWrapperStatus());
preferredWrapperField.addEventListener("change", () => renderWrapperStatus());
taskProfileField?.addEventListener("change", () => {
  ensureRecommendedMaxStepsForCurrentTask();
  schedulePreferenceSave();
});

saveApiKeyButton?.addEventListener("click", async () => {
  const provider = setupProviderField.value || "deepseek";
  const apiKey = setupApiKeyField.value.trim();
  if (!apiKey) {
    setupStatusEl.textContent = t("setupKeyLabel");
    return;
  }
  setupStatusEl.textContent = t("sendingStatus");
  const response = await fetch(`/api/keys/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await response.json().catch(() => ({}));
  setupApiKeyField.value = "";
  if (!response.ok) {
    setupStatusEl.textContent = data.error || t("keySaveFailed");
    return;
  }
  setupStatusEl.textContent = t("keySavedStatus");
  renderKeyStatus(data.keyStatus);
});

form.addEventListener("input", schedulePreferenceSave);
form.addEventListener("change", schedulePreferenceSave);

chatInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    chatFormEl.requestSubmit();
  }
});

pipeMessageButton?.addEventListener("click", () => {
  pipeMessageFromInput().catch((error) => {
    chatStatusEl.textContent = String(error);
  });
});

queueAfterFinishButton?.addEventListener("click", queueAfterFinishFromInput);

chatPendingEl?.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  const editAsap = target.dataset.editAsap;
  const removeAsap = target.dataset.removeAsap;
  const editAfter = target.dataset.editAfter;
  const removeAfter = target.dataset.removeAfter;

  if (editAsap) {
    const item = pendingInboxItems.find((candidate) => candidate.id === editAsap);
    const next = prompt(t("editQueuedMessage"), item?.content || "");
    if (next !== null) {
      updateInboxItem(editAsap, next).catch((error) => {
        chatStatusEl.textContent = String(error);
      });
    }
    return;
  }

  if (removeAsap) {
    removeInboxItem(removeAsap).catch((error) => {
      chatStatusEl.textContent = String(error);
    });
    return;
  }

  if (editAfter) {
    editAfterFinishItem(editAfter);
    return;
  }

  if (removeAfter) {
    removeAfterFinishItem(removeAfter);
  }
});

stopRunButton?.addEventListener("click", () => {
  stopCurrentRun().catch((error) => {
    chatStatusEl.textContent = String(error);
    updateStopRunButton();
  });
});

logsEl?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-permission-action]");
  if (!button) return;
  approvePermission(button.dataset.permissionAction || "no").catch((error) => {
    chatStatusEl.textContent = error instanceof Error ? error.message : String(error);
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || currentRunStatus !== "running") return;
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === "select" || tag === "button") return;
  event.preventDefault();
  stopCurrentRun().catch((error) => {
    chatStatusEl.textContent = String(error);
    updateStopRunButton();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const goal = document.querySelector("#goal").value.trim();
  if (!goal) {
    setLogs(t("goalRequired"), "empty");
    return;
  }
  ensureRecommendedMaxStepsForCurrentTask();

  const payload = {
    ...formPayload(),
    goal,
  };

  setLogs(t("startingRun"));
  runMetaEl.textContent = "";
  chatStatusEl.textContent = "";

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    setLogs(data.error || t("failedStartRun"));
    return;
  }

  currentSessionId = data.sessionId;
  currentRunStatus = "running";
  updateStopRunButton();
  sessionSelectEl.value = currentSessionId;
  runMetaEl.textContent = `${t("runningStatus").replace("...", "")} · ${currentSessionId}`;
  await refreshSessions();
  await refreshChat();
  await refreshWorkspaceChanges();
  await refreshArtifacts({ loadSelected: artifactTunnelDialog?.open });

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

sessionSelectEl.addEventListener("change", async () => {
  currentSessionId = sessionSelectEl.value;
  if (!currentSessionId) {
    currentRunStatus = "";
    pendingInboxItems = [];
    pendingAfterFinishItems = [];
    updateStopRunButton();
    runMetaEl.textContent = "";
    setLogs(t("noRunSelected"), "empty");
    renderChat([]);
    renderPendingMessages();
    artifactItems = [];
    selectedArtifactId = "";
    renderArtifactShell();
    return;
  }
  await refreshRun();
  await refreshChat();
  await refreshArtifacts({ loadSelected: artifactTunnelDialog?.open });
});

chatFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentSessionId) {
    chatStatusEl.textContent = t("selectSessionFirst");
    return;
  }

  const content = chatInputEl.value.trim();
  if (!content) {
    chatStatusEl.textContent = t("messageRequired");
    return;
  }

  chatStatusEl.textContent = t("sendingStatus");

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...formPayload(),
      content,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    chatStatusEl.textContent = data.error || t("failedContinue");
    return;
  }

  currentSessionId = data.sessionId;
  currentRunStatus = data.queued ? currentRunStatus : "running";
  updateStopRunButton();
  chatInputEl.value = "";
  chatStatusEl.textContent = data.queued ? t("queuedStatus") : t("runningStatus");
  await refreshSessions();
  await refreshChat();
  await refreshWorkspaceChanges();
  await refreshArtifacts({ loadSelected: artifactTunnelDialog?.open });

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();
  const prefs = data.preferences || {};
  routingPresets = data.routing?.presets || {};
  modelCatalog = data.modelCatalog || {};
  modelRoles = data.modelRoles || {};
  modelGroups = data.modelGroups || {};
  auxiliaryModelCatalog = data.auxiliaryModelCatalog || {};
  taskProfiles = data.taskProfiles || [];
  projectInfo = data.project || null;
  defaults.openai = data.defaults?.openai?.model || defaults.openai;
  defaults.qwen = data.defaults?.qwen?.model || defaults.qwen;
  defaults.venice = data.defaults?.venice?.model || defaults.venice;
  defaults.deepseek = routingPresets.fast?.model || data.defaults?.deepseek?.model || defaults.deepseek;
  defaults.mock = data.defaults?.mock?.model || defaults.mock;

  applyLanguage(prefs.language || normalizeLanguage(navigator.language || "en"), { persist: false });

  routingModeField.value = prefs.routingMode || "smart";
  providerField.value = prefs.provider || "deepseek";
  if (routeProviderField) routeProviderField.value = prefs.routeProvider || modelRoles.route?.provider || "deepseek";
  if (mainProviderField) mainProviderField.value = prefs.mainProvider || modelRoles.main?.provider || "deepseek";
  if (spareProviderField) spareProviderField.value = prefs.spareProvider || modelRoles.spare?.provider || "openai";
  if (spareReasoningField) spareReasoningField.value = prefs.spareReasoning || modelRoles.spare?.reasoning || "medium";
  if (wrapperReasoningField) wrapperReasoningField.value = prefs.wrapperReasoning || modelRoles.wrapper?.reasoning || "medium";
  if (auxiliaryProviderField) auxiliaryProviderField.value = prefs.auxiliaryProvider || modelRoles.auxiliary?.provider || "grsai";
  setSelectOptions(modelField, providerModelOptions(providerField.value), prefs.model || defaults[providerField.value], defaults[providerField.value]);
  setSelectOptions(
    routeModelField,
    providerModelOptions(routeProviderField?.value || "deepseek"),
    prefs.routeModel || modelRoles.route?.model,
    "deepseek-v4-flash"
  );
  setSelectOptions(
    mainModelField,
    providerModelOptions(mainProviderField?.value || "deepseek"),
    prefs.mainModel || modelRoles.main?.model,
    "deepseek-v4-pro"
  );
  setSelectOptions(
    spareModelField,
    providerModelOptions(spareProviderField?.value || "openai"),
    prefs.spareModel || modelRoles.spare?.model,
    "gpt-5.4"
  );
  setSelectOptions(wrapperModelField, wrapperModelOptions(), prefs.wrapperModel || modelRoles.wrapper?.model, "gpt-5.5");
  setSelectOptions(
    auxiliaryModelField,
    auxiliaryModelOptions(auxiliaryProviderField?.value || "grsai"),
    prefs.auxiliaryModel || modelRoles.auxiliary?.model,
    "nano-banana-2"
  );
  renderTaskProfiles(prefs.taskProfile || "auto");
  document.querySelector("#startUrl").value = prefs.startUrl || "";
  document.querySelector("#allowedDomains").value = prefs.allowedDomains || "";
  document.querySelector("#commandCwd").value = prefs.commandCwd || data.project?.root || "";
  document.querySelector("#headless").checked = prefs.headless ?? data.defaults.headless;
  document.querySelector("#maxSteps").value = prefs.maxSteps ?? data.defaults.maxSteps;
  if (permissionModeField) permissionModeField.value = prefs.permissionMode || "normal";
  sandboxModeField.value = prefs.sandboxMode || (prefs.useDockerSandbox ? "docker-workspace" : "host");
  packageInstallPolicyField.value = prefs.packageInstallPolicy || "allow";
  document.querySelector("#allowShellTool").checked = prefs.allowShellTool ?? true;
  document.querySelector("#allowFileTools").checked = prefs.allowFileTools ?? true;
  if (allowAuxiliaryToolsField) allowAuxiliaryToolsField.checked = prefs.allowAuxiliaryTools ?? true;
  if (allowWebSearchField) allowWebSearchField.checked = prefs.allowWebSearch ?? true;
  if (allowParallelScoutsField) allowParallelScoutsField.checked = prefs.allowParallelScouts ?? true;
  if (parallelScoutCountField) parallelScoutCountField.value = String(prefs.parallelScoutCount || 3);
  allowWrapperToolsField.checked = prefs.allowWrapperTools ?? false;
  preferredWrapperField.value = prefs.preferredWrapper || "codex";
  document.querySelector("#dockerSandboxImage").value = prefs.dockerSandboxImage || "agintiflow-sandbox:latest";
  document.querySelector("#allowPasswords").checked = prefs.allowPasswords ?? false;
  document.querySelector("#allowDestructive").checked = prefs.allowDestructive ?? false;

  renderKeyStatus(data.keyStatus);
  renderProjectStatus(data.project);
  renderWrapperStatus(data.wrappers || []);
  renderWorkspacePanel(data.workspace, []);
  await refreshWorkspaceChanges();
  renderSandboxLogs(data.sandbox?.logs || []);
  updateRoutingHint();
  updatePermissionHint();
  updatePackageWarning();

  renderSessions(data.sessions || []);
  if (data.sessions && data.sessions.length > 0) {
    currentSessionId = data.sessions[0].sessionId;
    sessionSelectEl.value = currentSessionId;
    await refreshRun();
    await refreshChat();
    await refreshArtifacts({ loadSelected: false });
  }
}

applyLanguage(normalizeLanguage(navigator.language || "en"), { persist: false });

loadConfig().catch((error) => {
  setLogs(String(error));
});
