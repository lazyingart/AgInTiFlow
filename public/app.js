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
    brandKicker: "AI automation product by AgInTi Inc.",
    languageLabel: "Language",
    intro:
      "Web-first agent platform with smart model routing, resumable runs, guarded tools, and optional external agent wrappers.",
    routingModeLabel: "Routing policy",
    routingSmartOption: "Smart: fast unless complex",
    routingFastOption: "DeepSeek v4 flash",
    routingComplexOption: "DeepSeek v4 pro",
    routingManualOption: "Manual provider/model",
    routingHintSmart: "Smart routing uses DeepSeek v4 flash by default and escalates to DeepSeek v4 pro for complex work.",
    routingHintFast: "Fast route: DeepSeek v4 flash for normal browser, shell, and short coding tasks.",
    routingHintComplex: "Complex route: DeepSeek v4 pro for deeper implementation, debugging, and design work.",
    routingHintManual: "Manual route uses the provider and model fields exactly as entered.",
    providerLabel: "Provider",
    modelLabel: "Model",
    goalLabel: "Goal",
    goalPlaceholder: "Open a site and summarize it, or use run_command for simple terminal inspection.",
    startUrlLabel: "Start URL",
    startUrlPlaceholder: "https://news.ycombinator.com",
    allowedDomainsLabel: "Allowed domains",
    allowedDomainsPlaceholder: "news.ycombinator.com,github.com",
    commandCwdLabel: "Working directory",
    maxStepsLabel: "Max steps",
    headlessLabel: "Headless browser",
    shellToolLabel: "Enable shell tool",
    wrapperToolLabel: "Enable agent wrappers",
    dockerSandboxLabel: "Use Docker sandbox",
    allowPasswordsLabel: "Allow password typing",
    allowDestructiveLabel: "Allow destructive actions",
    dockerImageLabel: "Docker image",
    dockerImagePlaceholder: "agintiflow-sandbox:latest",
    startRunButton: "Start run",
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
    failedContinue: "Failed to continue the conversation.",
  },
  ar: {
    documentTitle: "AgInTiFlow",
    brandKicker: "منتج أتمتة بالذكاء الاصطناعي من AgInTi Inc.",
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
    brandKicker: "Producto de automatización IA de AgInTi Inc.",
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
    brandKicker: "Produit d'automatisation IA par AgInTi Inc.",
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
    brandKicker: "AgInTi Inc. のAI自動化プロダクト",
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
    brandKicker: "AgInTi Inc.의 AI 자동화 제품",
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
    brandKicker: "Sản phẩm tự động hóa AI của AgInTi Inc.",
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
    brandKicker: "AgInTi Inc. 的 AI 自动化产品",
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
    brandKicker: "AgInTi Inc. 的 AI 自動化產品",
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
    brandKicker: "KI-Automationsprodukt von AgInTi Inc.",
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
    brandKicker: "AI-автоматизация от AgInTi Inc.",
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
const routingHintEl = document.querySelector("#routing-hint");
const logsEl = document.querySelector("#logs");
const runMetaEl = document.querySelector("#run-meta");
const keyStatusEl = document.querySelector("#key-status");
const wrapperStatusEl = document.querySelector("#wrapper-status");
const sessionSelectEl = document.querySelector("#session-select");
const chatThreadEl = document.querySelector("#chat-thread");
const chatFormEl = document.querySelector("#chat-form");
const chatInputEl = document.querySelector("#chat-input");
const chatStatusEl = document.querySelector("#chat-status");
const translatableNodes = [...document.querySelectorAll("[data-i18n]")];
const placeholderNodes = [...document.querySelectorAll("[data-i18n-placeholder]")];

const defaults = {
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-v4-flash",
};

let currentLanguage = "en";
let routingPresets = {};
let currentSessionId = "";
let pollTimer = null;
let saveTimer = null;
let lastChatEntries = [];
let lastSessions = [];
let lastKeyStatus = null;
let lastWrappers = [];

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

function renderKeyStatus(status = lastKeyStatus) {
  lastKeyStatus = status;
  if (!status) return;
  keyStatusEl.textContent = `${t("keysLabel")}: OpenAI ${
    status.openai ? t("availableLabel") : t("missingLabel")
  } · DeepSeek ${status.deepseek ? t("availableLabel") : t("missingLabel")}`;
}

function renderWrapperStatus(wrappers = lastWrappers) {
  lastWrappers = wrappers || [];
  if (lastWrappers.length === 0) {
    wrapperStatusEl.textContent = "";
    return;
  }
  wrapperStatusEl.textContent = `${t("wrappersLabel")}: ${lastWrappers
    .map((wrapper) => `${wrapper.label || wrapper.name} ${wrapper.available ? t("availableLabel") : t("missingLabel")}`)
    .join(" · ")}`;
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

  if (mode !== "manual") {
    const preset = mode === "complex" ? routingPresets.complex : routingPresets.fast;
    if (preset) {
      providerField.value = preset.provider === "deepseek" ? "deepseek" : providerField.value;
      modelField.value = preset.model || modelField.value;
    }
  }
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

  renderKeyStatus();
  renderWrapperStatus();
  updateRoutingHint();
  renderSessions(lastSessions);
  renderChat(lastChatEntries);
  if (persist) schedulePreferenceSave();
}

function formPayload() {
  return {
    language: languageField.value,
    routingMode: routingModeField.value,
    provider: providerField.value,
    model: modelField.value.trim(),
    startUrl: document.querySelector("#startUrl").value.trim(),
    allowedDomains: document.querySelector("#allowedDomains").value.trim(),
    commandCwd: document.querySelector("#commandCwd").value.trim(),
    maxSteps: Number(document.querySelector("#maxSteps").value) || 15,
    headless: document.querySelector("#headless").checked,
    allowShellTool: document.querySelector("#allowShellTool").checked,
    allowWrapperTools: document.querySelector("#allowWrapperTools").checked,
    useDockerSandbox: document.querySelector("#useDockerSandbox").checked,
    dockerSandboxImage: document.querySelector("#dockerSandboxImage").value.trim(),
    allowPasswords: document.querySelector("#allowPasswords").checked,
    allowDestructive: document.querySelector("#allowDestructive").checked,
  };
}

function renderLogs(run) {
  const lines = [];
  lines.push(`status=${run.status} session=${run.sessionId} provider=${run.provider} model=${run.model}`);
  if (run.result) lines.push(`result=${run.result}`);
  if (run.error) lines.push(`error=${run.error}`);
  lines.push("");

  for (const entry of run.logs || []) {
    lines.push(`[${entry.at}] ${entry.kind}: ${entry.message}`);
    if (entry.data && Object.keys(entry.data).length > 0) {
      lines.push(JSON.stringify(entry.data, null, 2));
    }
    lines.push("");
  }

  setLogs(lines.join("\n"));
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
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
      const content = escapeHtml(entry.content).replace(/\n/g, "<br>");
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

function renderSessions(sessions) {
  lastSessions = sessions || [];
  const current = sessionSelectEl.value;
  const options = [`<option value="">${t("selectRecentSession")}</option>`]
    .concat(
      lastSessions.map((session) => {
        const goal = escapeHtml(`${session.goal.slice(0, 60)}${session.goal.length > 60 ? "..." : ""}`);
        const label = `${escapeHtml(session.provider)} · ${goal}`;
        return `<option value="${escapeHtml(session.sessionId)}">${label}</option>`;
      })
    )
    .join("");

  sessionSelectEl.innerHTML = options;
  if (current && [...sessionSelectEl.options].some((opt) => opt.value === current)) {
    sessionSelectEl.value = current;
  }
}

async function refreshSessions() {
  const response = await fetch("/api/sessions");
  const data = await response.json();
  renderSessions(data.sessions || []);
}

async function refreshRun() {
  if (!currentSessionId) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(currentSessionId)}`);
  if (!response.ok) return;
  const run = await response.json();
  runMetaEl.textContent = `${run.status} · ${run.sessionId}`;
  renderLogs(run);

  if (run.status === "finished" || run.status === "failed") {
    clearInterval(pollTimer);
    pollTimer = null;
    await refreshChat();
    await refreshSessions();
  }
}

async function refreshChat() {
  if (!currentSessionId) {
    renderChat([]);
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/chat`);
  if (!response.ok) {
    renderChat([]);
    return;
  }

  const data = await response.json();
  renderChat(data.chat || []);
}

async function savePreferences() {
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formPayload()),
  });
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

providerField.addEventListener("change", () => {
  if (!modelField.value.trim() || modelField.value === defaults.openai || modelField.value === defaults.deepseek) {
    modelField.value = defaults[providerField.value] || "";
  }
  schedulePreferenceSave();
});

form.addEventListener("input", schedulePreferenceSave);
form.addEventListener("change", schedulePreferenceSave);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const goal = document.querySelector("#goal").value.trim();
  if (!goal) {
    setLogs(t("goalRequired"), "empty");
    return;
  }

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
  sessionSelectEl.value = currentSessionId;
  runMetaEl.textContent = `${t("runningStatus").replace("...", "")} · ${currentSessionId}`;
  await refreshSessions();
  await refreshChat();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

sessionSelectEl.addEventListener("change", async () => {
  currentSessionId = sessionSelectEl.value;
  if (!currentSessionId) {
    runMetaEl.textContent = "";
    setLogs(t("noRunSelected"), "empty");
    renderChat([]);
    return;
  }
  await refreshRun();
  await refreshChat();
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
  chatInputEl.value = "";
  chatStatusEl.textContent = t("runningStatus");
  await refreshSessions();
  await refreshChat();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();
  const prefs = data.preferences || {};
  routingPresets = data.routing?.presets || {};
  defaults.openai = data.defaults?.openai?.model || defaults.openai;
  defaults.deepseek = routingPresets.fast?.model || data.defaults?.deepseek?.model || defaults.deepseek;

  applyLanguage(prefs.language || normalizeLanguage(navigator.language || "en"), { persist: false });

  routingModeField.value = prefs.routingMode || "smart";
  providerField.value = prefs.provider || "deepseek";
  modelField.value = prefs.model || defaults[providerField.value] || "deepseek-v4-flash";
  document.querySelector("#startUrl").value = prefs.startUrl || "";
  document.querySelector("#allowedDomains").value = prefs.allowedDomains || "";
  document.querySelector("#commandCwd").value = prefs.commandCwd || "/home/lachlan/ProjectsLFS/Agent";
  document.querySelector("#headless").checked = prefs.headless ?? data.defaults.headless;
  document.querySelector("#maxSteps").value = prefs.maxSteps ?? data.defaults.maxSteps;
  document.querySelector("#allowShellTool").checked = prefs.allowShellTool ?? true;
  document.querySelector("#allowWrapperTools").checked = prefs.allowWrapperTools ?? false;
  document.querySelector("#useDockerSandbox").checked = prefs.useDockerSandbox ?? false;
  document.querySelector("#dockerSandboxImage").value = prefs.dockerSandboxImage || "agintiflow-sandbox:latest";
  document.querySelector("#allowPasswords").checked = prefs.allowPasswords ?? false;
  document.querySelector("#allowDestructive").checked = prefs.allowDestructive ?? false;

  renderKeyStatus(data.keyStatus);
  renderWrapperStatus(data.wrappers || []);
  updateRoutingHint();

  renderSessions(data.sessions || []);
  if (data.sessions && data.sessions.length > 0) {
    currentSessionId = data.sessions[0].sessionId;
    sessionSelectEl.value = currentSessionId;
    await refreshRun();
    await refreshChat();
  }
}

applyLanguage(normalizeLanguage(navigator.language || "en"), { persist: false });

loadConfig().catch((error) => {
  setLogs(String(error));
});
