import { BASELINE_PROVIDER, normalizeProviderId, resolveProviderDefaults } from "./provider-contract.js";

const COMPLEXITY_KEYWORDS = [
  "architecture",
  "refactor",
  "debug",
  "failing",
  "test",
  "implement",
  "patch",
  "apply_patch",
  "edit",
  "large codebase",
  "codebase",
  "monorepo",
  "repository",
  "cross-file",
  "multi file",
  "large repo",
  "engineering",
  "entry point",
  "regression",
  "root cause",
  "design",
  "review",
  "migrate",
  "security",
  "performance",
  "multi-file",
  "database",
  "docker",
  "ci",
  "github",
  "system",
  "systemd",
  "permission denied",
  "install",
  "setup",
  "toolchain",
  "conda",
  "venv",
  "kubernetes",
  "nginx",
  "postgres",
  "redis",
  "segfault",
  "typescript",
  "python",
  "rust",
  "cargo",
  "golang",
  "cmake",
  "gradle",
  "maven",
  "novel",
  "book",
  "chapter",
  "screenplay",
  "story bible",
  "long-form",
  "manuscript",
];

const COMPLEX_ROUTE_HINTS = [
  /\b(large|big|complex|complicated)\s+(repo|repository|codebase|project|task)\b/i,
  /\b(multi[- ]file|cross[- ]file|repo[- ]wide|workspace[- ]wide)\b/i,
  /\b(root cause|regression|failing tests?|fix the build|make it pass)\b/i,
  /\b(system bug|system problem|permission denied|service failed|daemon|systemd|toolchain|install|setup)\b/i,
  /\b(conda|venv|python|node|typescript|rust|cargo|golang|java|gradle|maven|cmake|c\+\+)\b.*\b(project|app|tests?|build|compile|fix)\b/i,
  /\blatex\b/i,
  /\btexlive\b/i,
  /\bpdflatex\b/i,
  /\blatexmk\b/i,
  /\b(manuscript|research paper|white paper|technical report)\b/i,
  /\b(novel|book|chapter|screenplay|story bible|long[- ]form|fiction arc|scene draft)\b/i,
  /\bcompile\b.*\bpdf\b/i,
  /\bwrite\b.*\bpdf\b/i,
];

export const ROUTING_MODES = ["smart", "fast", "complex", "manual"];
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
export const REASONING_PROVIDER_DEFAULT_LABEL = "Provider default";

export const LOCALLLM_AUTO_MAX_MIN_COMPLEXITY = 8;

export const LOCALLLM_RESOURCE_STATES = Object.freeze({
  UNKNOWN: "unknown",
  READY: "ready",
  PRESSURED: "pressured",
});

export const LOCALLLM_MODEL_TIERS = Object.freeze({
  fast: Object.freeze({
    id: "fast",
    model: "localllm-fast",
    label: "LocalLLM Fast",
    role: "simple routing",
    target: "Qwen3 8B Q4",
    autoPolicy: "default-simple",
    capabilities: Object.freeze(["text", "tools", "code"]),
  }),
  deep: Object.freeze({
    id: "deep",
    model: "localllm-deep",
    label: "LocalLLM Deep",
    role: "substantive agent and coding work",
    target: "Qwen3 30B-A3B Instruct Q4_K_M",
    autoPolicy: "default-complex",
    capabilities: Object.freeze(["text", "tools", "code", "reasoning"]),
  }),
  code: Object.freeze({
    id: "code",
    model: "localllm-code",
    label: "LocalLLM Code",
    role: "coding and repository implementation specialist",
    target: "Configured LocalLLM coding-capability alias",
    autoPolicy: "implementation-intent-and-authenticated-availability",
    capabilities: Object.freeze(["text", "tools", "code", "reasoning"]),
  }),
  max: Object.freeze({
    id: "max",
    model: "localllm-max",
    label: "LocalLLM Max",
    role: "highest-fidelity local text and code",
    target: "Qwen3 30B-A3B Instruct Q8_0",
    autoPolicy: "explicit-opt-in-and-confirmed-headroom",
    capabilities: Object.freeze(["text", "tools", "code", "reasoning"]),
  }),
  vision: Object.freeze({
    id: "vision",
    model: "localllm-vision-xl",
    label: "LocalLLM Vision XL",
    role: "image understanding",
    target: "Qwen3-VL 30B-A3B Instruct Q4_K_M",
    autoPolicy: "vision-intent-and-image-capability",
    capabilities: Object.freeze(["text", "vision"]),
  }),
});

const LOCALLLM_TIER_BY_MODEL = new Map(
  Object.values(LOCALLLM_MODEL_TIERS).map((tier) => [tier.model, tier])
);

const VISION_TASK_HINTS = [
  /\b(describe|inspect|analy[sz]e|examine|read|compare|understand|identify|recognize|ocr)\b.{0,64}\b(image|photo|picture|screenshot|diagram|scan)\b/i,
  /\b(image|photo|picture|screenshot|diagram|scan)\b.{0,64}\b(describe|inspect|analy[sz]e|examine|read|compare|understand|identify|recognize|ocr)\b/i,
  /(?:分析|查看|检查|描述|识别|读取|比较).{0,24}(?:图片|图像|照片|截图|图表|扫描件)/u,
  /(?:图片|图像|照片|截图|图表|扫描件).{0,24}(?:分析|查看|检查|描述|识别|读取|比较)/u,
];

const NON_CODE_SPECIALIST_PROFILES = new Set([
  "writing",
  "research",
  "paper",
  "book",
  "novel",
  "design",
  "docs",
  "slides",
  "education",
  "image",
]);

const CODE_IMPLEMENTATION_PROFILES = new Set([
  "code",
  "large-codebase",
  "qa",
  "database",
  "devops",
  "security",
  "pipeline",
  "app",
  "python",
  "node",
  "java",
  "ios",
  "go",
  "rust",
  "dotnet",
  "php",
  "ruby",
  "c-cpp",
  "android",
  "website",
  "aaps",
  "github",
  "maintenance",
  "chatops",
  "review",
]);

const CODE_SPECIFIC_IMPLEMENTATION_HINTS = [
  /\b(implement|debug|refactor|patch|compile|scaffold)\b.{0,96}\b(code|source|parser|function|class|module|package|library|api|endpoint|cli|app|application|website|component|service|server|client|database|schema|migration|query|tests?|spec|build|compiler|script|tool|workflow|pipeline|dockerfile|config(?:uration)?|project|repository|repo|codebase|bug|regression|model|typescript|javascript|python|rust|golang|java|kotlin|swift|c\+\+|c#|php|ruby|sql|stan|html|css|react|vue|node)\b/i,
  /\b(fix|repair|add|create|write|update|modify|edit|build|migrate|port|optim[iz]e|develop|remove|rename)\b.{0,96}\b(code|source|function|class|module|package|library|api|endpoint|cli|app|application|website|component|service|server|client|database|schema|migration|query|tests?|spec|build|compiler|script|tool|workflow|pipeline|dockerfile|config(?:uration)?|project|repository|repo|codebase|bug|regression|typescript|javascript|python|rust|golang|java|kotlin|swift|c\+\+|c#|php|ruby|sql|html|css|react|vue|node)\b/i,
  /\b(code|source|function|class|module|package|library|api|endpoint|cli|app|application|website|component|service|server|client|database|schema|migration|query|tests?|spec|build|compiler|script|tool|workflow|pipeline|dockerfile|config(?:uration)?|project|repository|repo|codebase|bug|regression)\b.{0,96}\b(fix|repair|add|create|write|update|modify|edit|build|migrate|port|optim[iz]e|develop|remove|rename)\b/i,
  /\b(code|program)\s+(?:(?:a|an|the|this|that|new|my|our)\s+)?(parser|function|class|module|package|library|api|endpoint|cli|app|application|website|component|service|server|client|script|tool|project)\b/i,
  /\b(write|generate)\s+(?:some\s+)?code\b/i,
  /\b(make|finish|continue)\b.{0,48}\b(implementation|coding|tests?|build|app|service|repository|codebase)\b/i,
  /(?:帮我|幫我)?(?:写|寫)(?:一个|一個).{0,24}(?:登录|登入)(?:页面|頁面)/u,
];

const MULTILINGUAL_CODE_IMPLEMENTATION_HINTS = [
  {
    language: "ar",
    action: /(?:نفّذ|نفذ|طبّق|طبق|أصلح|اصلح|أضف|اضف|أنشئ|انشئ|ابن|طوّر|طور|حدّث|حدث|أعد هيكلة|عدّل|عدل)/u,
    subject: /(?:الكود|الشفرة|دالة|وحدة|واجهة|تطبيق|خدمة|قاعدة بيانات|اختبار|برنامج|مشروع|مستودع|خطأ|مصادقة|تسجيل الدخول|آلة حاسبة|الوضع الداكن|التبعيات|react|حالة تسابق)/iu,
  },
  {
    language: "es",
    action: /(?:implementa(?:r|d)?|implemente|corrige|corregir|arregla|repara|añade|agrega|crea|construye|actualiza|mejora|refactoriza|desarrolla|modifica|migra)/iu,
    subject: /(?:código|fuente|función|clase|módulo|paquete|api|aplicación|sitio web|componente|servicio|servidor|cliente|base de datos|esquema|consulta|pruebas?|script|proyecto|repositorio|error|regresión|autenticación|inicio de sesión|calculadora|modo oscuro|dependencias?|react|condición de carrera)/iu,
  },
  {
    language: "fr",
    action: /(?:implémentez|implémente|implémenter|corrigez|corrige|réparez|répare|ajoutez|ajoute|créez|crée|construisez|construire|mettez à jour|mettre à jour|refactorisez|refactoriser|développez|développer|modifiez|modifier|migrez|migrer)/iu,
    subject: /(?:code|source|fonction|classe|module|paquet|api|application|site web|composant|service|serveur|client|base de données|schéma|requête|tests?|script|projet|dépôt|bug|régression|authentification|connexion|calculatrice|mode sombre|dépendances?|react|condition de concurrence)/iu,
  },
  {
    language: "ja",
    action: /(?:実装|修正|修復|追加|作成|構築|更新|アップグレード|リファクタリング|開発|変更|移行)/u,
    subject: /(?:コード|ソース|関数|クラス|モジュール|パッケージ|api|アプリ|ウェブサイト|コンポーネント|サービス|サーバー|クライアント|データベース|スキーマ|テスト|スクリプト|プロジェクト|リポジトリ|バグ|リグレッション|認証|ログイン|電卓|ダークモード|依存関係|react|競合状態|レースコンディション)/iu,
  },
  {
    language: "ko",
    action: /(?:구현|수정|복구|추가|생성|구축|업데이트|업그레이드|리팩터링|개발|변경|마이그레이션)/u,
    subject: /(?:코드|소스|함수|클래스|모듈|패키지|api|앱|웹사이트|컴포넌트|서비스|서버|클라이언트|데이터베이스|스키마|테스트|스크립트|프로젝트|저장소|버그|회귀|인증|로그인|계산기|다크 모드|의존성|react|경쟁 상태|레이스 컨디션)/iu,
  },
  {
    language: "vi",
    action: /(?:triển khai|cài đặt|sửa|khắc phục|thêm|tạo|xây dựng|cập nhật|nâng cấp|tái cấu trúc|phát triển|chỉnh sửa|di chuyển)/iu,
    subject: /(?:mã nguồn|mã|hàm|lớp|mô-đun|gói|api|ứng dụng|trang web|thành phần|dịch vụ|máy chủ|máy khách|cơ sở dữ liệu|lược đồ|kiểm thử|tập lệnh|dự án|kho mã|lỗi|hồi quy|xác thực|đăng nhập|máy tính|chế độ tối|phụ thuộc|react|điều kiện tranh chấp)/iu,
  },
  {
    language: "zh",
    action: /(?:实现|實現|实作|實作|修复|修復|修正|新增|添加|添加|创建|建立|建立|更新|升级|升級|重构|重構|开发|開發|编写|編寫|修改|迁移|遷移)/u,
    subject: /(?:代码|程式碼|函数|類|模块|模組|包|api|接口|介面|应用|應用|服务|服務|数据库|資料庫|测试|測試|脚本|腳本|项目|專案|仓库|倉庫|缺陷|错误|錯誤|身份验证|身分驗證|认证|認證|登录|登入|计算器|計算機|深色模式|暗色模式|依赖|相依套件|react|竞态条件|競態條件)/iu,
  },
  {
    language: "de",
    action: /(?:implementiere|implementieren|behebe|beheben|repariere|reparieren|füge.{0,24}hinzu|hinzufügen|erstelle|erstellen|baue|bauen|aktualisiere|aktualisieren|upgrade|refaktorisiere|refaktorisieren|entwickle|entwickeln|ändere|ändern|migriere|migrieren)/iu,
    subject: /(?:code|quellcode|funktion|klasse|modul|paket|api|anwendung|webseite|komponente|dienst|server|client|datenbank|schema|abfrage|tests?|skript|projekt|repository|fehler|regression|authentifizierung|anmeldung|taschenrechner|dunkelmodus|abhängigkeiten|react|race condition|wettlaufsituation)/iu,
  },
  {
    language: "ru",
    action: /(?:реализуй|реализуйте|исправь|исправьте|почини|почините|добавь|добавьте|создай|создайте|собери|соберите|обнови|обновите|модернизируй|отрефакторь|разработай|измени|мигрируй)/iu,
    subject: /(?:код|исходник|функция|класс|модуль|пакет|api|приложение|сайт|компонент|сервис|сервер|клиент|база данных|схема|запрос|тесты?|скрипт|проект|репозиторий|баг|регрессия|аутентификация|аутентификацию|вход|калькулятор|тёмный режим|зависимости|react|состояние гонки)/iu,
  },
];

const CODE_PROFILE_IMPLEMENTATION_HINTS = [
  /\b(?:implement(?:ing)?|debug(?:ging)?|refactor(?:ing)?|patch(?:ing)?|compil(?:e|ing)|scaffold(?:ing)?|fix(?:ing)?|repair(?:ing)?|migrat(?:e|ing)|develop(?:ing)?|build(?:ing)?|add(?:ing)?|updat(?:e|ing)|upgrad(?:e|ing)|resolv(?:e|ing))\b/i,
  ...MULTILINGUAL_CODE_IMPLEMENTATION_HINTS.map(({ action }) => action),
];

const ADVISORY_ONLY_CODE_HINTS = [
  /^\s*(?:(?:please|(?:can|could|would)\s+you)\s+)?(?:explain|summari[sz]e|describe|analy[sz]e|compare|review|inspect|audit|teach|discuss|outline|document|documentation|docs?)\b/i,
  /^\s*(?:please\s+)?(?:draft|write|create|produce)\b.{0,64}\b(?:plan|proposal|review|documentation|docs?|readme|tutorial|guide|report)\b/i,
  /^\s*(?:please\s+)?(?:tell|show)\s+me\b.{0,48}\b(?:how|what|why|ways?)\b/i,
  /^\s*i\s+(?:want|need|would\s+like)\s+(?:an?\s+)?(?:plan|proposal|review|explanation|guide)\b/i,
  /^\s*i\s+am\s+(?:writing|researching|studying|learning)\b.{0,64}\b(?:how|ways?|methods?)\b/i,
  /^\s*update\s+me\s+(?:on|about)\b/i,
  /^\s*(?:add|insert|include)\b.{0,64}\b(?:details?|information|description)\b.{0,32}\b(?:documentation|docs?|report|proposal|review)\b/i,
  /^\s*(?:update|edit|revise)\s+(?:the\s+)?(?:api\s+)?(?:documentation|docs?|readme|guide)\b/i,
  /^\s*(?:add|insert|include)\b.{0,48}\b(?:examples?|details?|information|description)\b.{0,24}\bto\s+(?:the\s+)?(?:api\s+)?(?:documentation|docs?|readme|guide)\b/i,
  /^\s*(?:fix|correct|repair)\s+(?:the\s+)?(?:typos?|spelling|grammar|wording)\b.{0,48}\b(?:documentation|docs?|readme|guide)\b/i,
  /^\s*remove\b.{0,64}\bfrom\s+(?:(?:a|the|this|that)\s+)?(?:comparison|documentation|docs?|report|proposal|review)\b/i,
  /^\s*rename\b.{0,64}\bin\s+(?:(?:a|the|this|that)\s+)?(?:documentation|docs?|report|proposal|review)\b/i,
  /^\s*(?:build|make)\s+(?:an?\s+|the\s+)?(?:\w+[ -]+)?(?:comparison|report|proposal|review|tutorial)\b/i,
  /^\s*(?:should|would|could|can)\s+i\b/i,
  /^\s*(?:how|what|why|when|where)\b/i,
  /^\s*[¿¡]?(?:explica(?:r)?|explique|compara(?:r)?|compare|revisa(?:r)?|revise|analiza(?:r)?|documenta(?:r)?|documentación|debería\s+yo|cómo|qué|por\s+qué)\b/iu,
  /^\s*(?:expliquez|explique|expliquer|comparez|compare|comparer|examinez|examine|examiner|analysez|analyser|documentez|documenter|documentation|devrais-je|comment|pourquoi|qu['’]est-ce)\b/iu,
  /(?:説明|解説|比較|レビュー|文書化|ドキュメント)/u,
  /(?:설명|비교|검토|리뷰|문서화|문서\s*작성)/u,
  /^\s*(?:请|請)?\s*(?:解释|解釋|说明|說明|比较|比較|审查|審查|审核|審核|评审|評審|文档|文檔|如何|怎么|怎麼|为什么|為什麼|是否应该|是否應該)/u,
  /^\s*(?:giải\s+thích|so\s+sánh|đánh\s+giá|xem\s+xét|viết\s+tài\s+liệu|tài\s+liệu|tôi\s+có\s+nên|làm\s+thế\s+nào|tại\s+sao)\b/iu,
  /^\s*(?:اشرح|فسّر|فسر|وضّح|وضح|قارن|راجع|وثّق|وثق|توثيق|هل\s+ينبغي|هل\s+يجب|كيف|ماذا|لماذا)/u,
  /^\s*(?:erkläre|erklären|vergleiche|vergleichen|überprüfe|überprüfen|analysiere|analysieren|dokumentiere|dokumentieren|dokumentation|sollte\s+ich|wie|was|warum)\b/iu,
  /^\s*(?:объясни|объясните|сравни|сравните|проверь|проверьте|проанализируй|документируй|документация|стоит\s+ли\s+мне|как|что|почему)\b/iu,
];
const NEGATED_CODE_IMPLEMENTATION_HINTS = [
  /^\s*(?:please\s+)?(?:do\s+not|don['’]?t|never)\s+(?:implement|fix|repair|patch|edit|modify|add|build|refactor|update|upgrade|migrate|develop|resolve)\b/i,
  /\b(?:without|do\s+not|don['’]?t|never)\s+(?:changing|editing|modifying|writing|patching|implementing|fixing|refactoring)\b/i,
  /\b(?:read[- ]only|explanation[- ]only|advice[- ]only)\b/i,
  /^\s*(?:请|請)?\s*(?:不要|别|別|无需|無需).{0,24}(?:实现|實現|实作|實作|修复|修復|新增|添加|更新|重构|重構|开发|開發|编写|編寫|修改)/u,
  /(?:実装|修正|修復|追加|作成|構築|更新|開発).{0,16}(?:しないで|しない|しなくて)/u,
  /(?:구현|수정|복구|추가|생성|구축|업데이트|개발).{0,16}(?:하지\s*마세요|하지\s*말아|하지\s*마)/u,
  /^\s*no\s+(?:implementes|corrijas|repares|añadas|agregues|crees|construyas|actualices|refactorices|desarrolles)\b/iu,
  /^\s*n['’](?:implémentez|implémente|corrigez|corrige|réparez|répare|ajoutez|ajoute|créez|crée|construisez|construis|développez|développe)\b.{0,32}\bpas\b/iu,
  /\b(?:implementiere|behebe|repariere|füge|erstelle|baue|aktualisiere|refaktorisiere|entwickle)\b.{0,48}\bnicht\b/iu,
  /^\s*не\s+(?:реализуй|реализуйте|исправь|исправьте|почини|добавь|создай|собери|обнови|разработай)(?=\s|[.,!?;:]|$)/iu,
  /^\s*لا\s+(?:تنفّذ|تنفذ|تطبّق|تطبق|تصلح|تضف|تنشئ|تطوّر|تطور|تحدّث|تحدث)/u,
  /^\s*đừng\s+(?:triển\s+khai|cài\s+đặt|sửa|khắc\s+phục|thêm|tạo|xây\s+dựng|cập\s+nhật|phát\s+triển)\b/iu,
];
const EXPLICIT_FOLLOWUP_IMPLEMENTATION_HINTS = [
  /\b(?:(?:and\s+)?then|after\s+that)\s+(?:implement|fix|repair|patch|edit|modify|add|build|refactor|update|upgrade|migrate|develop|resolve)\b/i,
  /^\s*(?:please\s+)?(?:review|investigate|diagnose|inspect|audit)\b.{0,128}\band\s+(?:implement|fix|repair|patch|edit|modify|add|build|refactor|update|upgrade|migrate|develop|resolve)\b/i,
  /(?:然后|然後|接着|接著|之后|之後).{0,16}(?:实现|實現|实作|實作|修复|修復|新增|添加|更新|重构|重構|开发|開發)/u,
  /(?:审查|審查|审核|審核|检查|檢查|评审|評審).{0,64}(?:并|並|且).{0,16}(?:实现|實現|实作|實作|修复|修復|新增|添加|更新|重构|重構|开发|開發)/u,
  /(?:その後|次に|それから|してから).{0,16}(?:実装|修正|修復|追加|作成|構築|更新|開発)/u,
  /(?:レビュー|確認|検査).{0,32}して.{0,16}(?:実装|修正|修復|追加|作成|構築|更新|開発)/u,
  /(?:그런\s+다음|이후|그\s+후|하고\s+나서).{0,16}(?:구현|수정|복구|추가|생성|구축|업데이트|개발)/u,
  /(?:검토|리뷰|확인).{0,32}하고.{0,16}(?:구현|수정|복구|추가|생성|구축|업데이트|개발)/u,
  /(?:luego|después|a\s+continuación).{0,24}(?:implementa|corrige|repara|añade|agrega|crea|construye|actualiza|refactoriza|desarrolla)/iu,
  /^\s*(?:revisa|revise|inspecciona|audita)\b.{0,96}\by\s+(?:implementa|corrige|repara|añade|agrega|crea|construye|actualiza|refactoriza|desarrolla)/iu,
  /(?:puis|ensuite|après\s+cela).{0,24}(?:implémente|corrige|répare|ajoute|crée|construis|mets\s+à\s+jour|refactorise|développe)/iu,
  /^\s*(?:examinez|examine|inspectez|auditez)\b.{0,96}\bet\s+(?:implémente|corrige|répare|ajoute|crée|construis|mets\s+à\s+jour|refactorise|développe)/iu,
  /(?:sau\s+đó|tiếp\s+theo).{0,24}(?:triển\s+khai|cài\s+đặt|sửa|khắc\s+phục|thêm|tạo|xây\s+dựng|cập\s+nhật|phát\s+triển)/iu,
  /^\s*(?:xem\s+xét|đánh\s+giá|kiểm\s+tra)\b.{0,96}(?:^|\s)và\s+(?:triển\s+khai|cài\s+đặt|sửa|khắc\s+phục|thêm|tạo|xây\s+dựng|cập\s+nhật|phát\s+triển)/iu,
  /(?:ثم|بعد\s+ذلك).{0,24}(?:نفّذ|نفذ|طبّق|طبق|أصلح|اصلح|أضف|اضف|أنشئ|انشئ|طوّر|طور|حدّث|حدث)/u,
  /^\s*(?:راجع|افحص|دقق).{0,96}و(?:نفّذ|نفذ|طبّق|طبق|أصلح|اصلح|أضف|اضف|أنشئ|انشئ|طوّر|طور|حدّث|حدث)/u,
  /(?:dann|danach|anschließend).{0,24}(?:implementiere|behebe|repariere|füge|erstelle|baue|aktualisiere|refaktorisiere|entwickle)/iu,
  /^\s*(?:überprüfe|prüfe|inspiziere)\b.{0,96}\bund\s+(?:implementiere|behebe|repariere|füge|erstelle|baue|aktualisiere|refaktorisiere|entwickle)/iu,
  /(?:затем|после\s+этого).{0,24}(?:реализуй|исправь|почини|добавь|создай|собери|обнови|разработай)/iu,
  /^\s*(?:проверь|проверьте|изучи|проанализируй).{0,96}(?:^|\s)и\s+(?:реализуй|исправь|почини|добавь|создай|собери|обнови|разработай)/iu,
];
const CLEAR_IMPLEMENTATION_REQUEST_HINTS = [
  /^\s*(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)?(?:implement|fix|repair|resolve|build|add|create|refactor|update|upgrade|develop|remove|rename|migrate|port|optim[iz]e)\b.{0,128}\b(?:authentication|auth|oauth|login|sign[- ]?in|registration|sign[- ]?up|payment(?:\s+processing)?|rate\s+limiting|pagination|calculator|todo(?:\s+list)?|settings?(?:\s+page)?|game|dark\s+mode|theme|dependencies|dependency|react|node(?:\.js)?|race\s+condition|deadlock|memory\s+leak|crash|failure|compilation(?:\s+error)?|typescript|ci|feature|button|ui|frontend|backend|route|middleware|integration|validation|cache|database|schema|api|endpoint|app|application|website|component|service|server|client|module|package|library|tests?|build|script|tool|workflow|pipeline|config(?:uration)?|project|repository|repo|codebase|bug|error|regression)\b/i,
  /^\s*(?:please\s+)?(?:review|investigate|diagnose)\b.{0,96}\b(?:failure|login|crash|bug|error|regression|code|module|service|app|api)\b.{0,64}\band\s+(?:fix|repair|patch|resolve|implement)\b/i,
  /^\s*(?:please\s+)?(?:review|investigate|diagnose)\b.{0,64}\band\s+(?:fix|repair|patch|resolve|implement)\b.{0,96}\b(?:failure|login|crash|bug|error|regression|code|module|service|app|api)\b/i,
  /^\s*(?:please\s+)?continue\s+(?:implementing|coding|building|fixing|developing|refactoring)\b.{0,96}\b(?:feature|code|implementation|app|application|service|module|project|repository|tests?)\b/i,
  /^\s*(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)?(?:code|make)\b.{0,96}\b(?:authentication|auth|login|calculator|page|feature|button|api|app|application|service|module|script|tool|website|game)\b/i,
  /^\s*(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)?(?:set\s+up\s+(?:authentication|auth|login)|(?:integrate|wire\s+up)\s+oauth|complete\s+(?:the\s+)?implementation|finish\s+(?:this|the|a)?\s*feature)\b/i,
];

export function localLLMModelTier(model = "") {
  return LOCALLLM_TIER_BY_MODEL.get(String(model || "").trim()) || null;
}

export function normalizeLocalLLMResourceState(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(LOCALLLM_RESOURCE_STATES).includes(normalized)
    ? normalized
    : LOCALLLM_RESOURCE_STATES.UNKNOWN;
}

export function hasLocalLLMVisionIntent(goal = "", taskProfile = "auto") {
  const profile = String(taskProfile || "").trim().toLowerCase();
  if (["vision", "image-understanding", "image_analysis", "ocr"].includes(profile)) return true;
  return VISION_TASK_HINTS.some((hint) => hint.test(String(goal || "")));
}

/**
 * Return true only for high-confidence implementation work.
 *
 * Writing, research, documentation, and design profiles remain on their normal
 * route even when their subject happens to mention code. A code-oriented
 * profile is supporting evidence, not enough by itself: the request must still
 * contain an implementation action.
 */
export function hasLocalLLMCodeIntent(goal = "", taskProfile = "auto") {
  const profile = String(taskProfile || "").trim().toLowerCase();
  if (NON_CODE_SPECIALIST_PROFILES.has(profile)) return false;
  const text = String(goal || "").trim();
  if (!text) return false;
  const explicitFollowup = EXPLICIT_FOLLOWUP_IMPLEMENTATION_HINTS.some((hint) => hint.test(text));
  if (
    (ADVISORY_ONLY_CODE_HINTS.some((hint) => hint.test(text)) ||
      NEGATED_CODE_IMPLEMENTATION_HINTS.some((hint) => hint.test(text))) &&
    !explicitFollowup
  ) {
    return false;
  }
  if (
    /^\s*(explain|summari[sz]e|describe|analy[sz]e|inspect|review|teach|compare)\b/i.test(text) &&
    /\b(without\s+(?:changing|editing|modifying|writing|patching|implementing)|do\s+not\s+(?:change|edit|modify|write|patch|implement)|read[- ]only)\b/i.test(text)
  ) {
    return false;
  }
  if (CLEAR_IMPLEMENTATION_REQUEST_HINTS.some((hint) => hint.test(text))) {
    return true;
  }
  const specificImplementation =
    CODE_SPECIFIC_IMPLEMENTATION_HINTS.some((hint) => hint.test(text)) ||
    MULTILINGUAL_CODE_IMPLEMENTATION_HINTS.some(
      ({ action, subject }) => action.test(text) && subject.test(text)
    );
  if (specificImplementation) {
    return true;
  }
  return CODE_IMPLEMENTATION_PROFILES.has(profile) &&
    CODE_PROFILE_IMPLEMENTATION_HINTS.some((hint) => hint.test(text));
}

function localLLMModelForTier(tier, overrides = {}) {
  const sharedOverride =
    process.env.AGINTI_LOCALLLM_MODEL || process.env.LOCALLLM_MODEL || process.env.LOCAL_LLM_MODEL || "";
  if (tier === "fast") {
    return overrides.fastModel || process.env.AGINTI_LOCALLLM_ROUTE_MODEL || sharedOverride || LOCALLLM_MODEL_TIERS.fast.model;
  }
  if (tier === "deep") {
    return overrides.deepModel || process.env.AGINTI_LOCALLLM_MAIN_MODEL || sharedOverride || LOCALLLM_MODEL_TIERS.deep.model;
  }
  if (tier === "code") {
    return overrides.codeModel || process.env.AGINTI_LOCALLLM_CODE_MODEL || LOCALLLM_MODEL_TIERS.code.model;
  }
  if (tier === "max") {
    return overrides.maxModel || process.env.AGINTI_LOCALLLM_MAX_MODEL || LOCALLLM_MODEL_TIERS.max.model;
  }
  if (tier === "vision") {
    return overrides.visionModel || process.env.AGINTI_LOCALLLM_VISION_MODEL || LOCALLLM_MODEL_TIERS.vision.model;
  }
  return "";
}

function localLLMCodeFallbackModel(overrides = {}) {
  const configuredDeepModel = localLLMModelForTier("deep", overrides);
  const configuredTier = localLLMModelTier(configuredDeepModel)?.id || "";
  const codeModel = localLLMModelForTier("code", overrides);
  if (
    (configuredTier && configuredTier !== "deep") ||
    configuredDeepModel === codeModel
  ) {
    return LOCALLLM_MODEL_TIERS.deep.model;
  }
  return configuredDeepModel || LOCALLLM_MODEL_TIERS.deep.model;
}

function localLLMTierResult(tier, {
  model = "",
  reason = "",
  selection = "smart",
  blockedUpgrade = "",
} = {}) {
  const metadata = LOCALLLM_MODEL_TIERS[tier];
  const selectedModel = model || metadata?.model || "";
  const configuredTier = localLLMModelTier(selectedModel);
  const configuredTierOverride = Boolean(configuredTier && configuredTier.id !== tier);
  const effectiveTier = configuredTier?.id || tier;
  return {
    provider: "localllm",
    tier: effectiveTier,
    model: selectedModel,
    reason: configuredTierOverride
      ? `Explicit configured LocalLLM ${configuredTier.id} model overrides the automatic ${tier} tier.`
      : reason,
    selection: configuredTierOverride ? "configured-model" : selection,
    blockedUpgrade: ["max", "vision"].includes(effectiveTier) ? "" : blockedUpgrade,
    requiresResourcePreflight: effectiveTier === "max",
  };
}

/**
 * Select a LocalLLM alias without probing hardware or loading a model.
 *
 * Automatic Max selection intentionally requires four affirmative signals:
 * a sufficiently complex task, model availability, explicit operator opt-in,
 * and a resource snapshot that says ready with no shared-workstation pressure.
 * Unknown/missing resource state is fail-closed and stays on Deep.
 */
export function selectLocalLLMModelTier({
  goal = "",
  taskProfile = "auto",
  complexityScore,
  requestedModel = "",
  localCapabilities = {},
  localResourcePolicy = {},
  modelOverrides = {},
} = {}) {
  const explicitModel = String(requestedModel || "").trim();
  if (explicitModel) {
    const explicitTier = localLLMModelTier(explicitModel);
    return localLLMTierResult(explicitTier?.id || "custom", {
      model: explicitModel,
      reason: explicitTier
        ? `Explicit LocalLLM ${explicitTier.id} model selected.`
        : "Explicit custom LocalLLM model selected.",
      selection: "explicit",
    });
  }

  const score = Number.isFinite(Number(complexityScore))
    ? Number(complexityScore)
    : scoreTaskComplexity(goal, taskProfile);
  const visionIntent = hasLocalLLMVisionIntent(goal, taskProfile);
  const imageCapabilityReady =
    localCapabilities.imageInput === true && localCapabilities.visionModelAvailable === true;

  if (visionIntent && imageCapabilityReady) {
    return localLLMTierResult("vision", {
      model: localLLMModelForTier("vision", modelOverrides),
      reason: "Vision intent and an available image-input capability selected LocalLLM Vision XL.",
      selection: "vision-capability",
    });
  }

  if (hasLocalLLMCodeIntent(goal, taskProfile)) {
    const fallbackModel = localLLMCodeFallbackModel(modelOverrides);
    return {
      ...localLLMTierResult("deep", {
        model: fallbackModel,
        reason: "Implementation intent selected LocalLLM Deep as the safe fallback while the coding alias awaits authenticated discovery.",
        selection: "code-readiness-pending",
      }),
      codeCandidate: true,
      codeModel: localLLMModelForTier("code", modelOverrides),
      codeFallbackModel: fallbackModel,
    };
  }

  const resourceState = normalizeLocalLLMResourceState(localResourcePolicy.status);
  const maxAutoReady =
    score >= LOCALLLM_AUTO_MAX_MIN_COMPLEXITY &&
    localCapabilities.maxModelAvailable === true &&
    localResourcePolicy.allowMaxAuto === true &&
    resourceState === LOCALLLM_RESOURCE_STATES.READY &&
    localResourcePolicy.sharedWorkstationPressure === false;

  if (maxAutoReady) {
    return localLLMTierResult("max", {
      model: localLLMModelForTier("max", modelOverrides),
      reason: `Opted-in LocalLLM Max route selected with confirmed resource headroom; complexity score ${score}.`,
      selection: "resource-policy",
    });
  }

  if (score >= 3) {
    return localLLMTierResult("deep", {
      model: localLLMModelForTier("deep", modelOverrides),
      reason: `Substantive LocalLLM work selected Deep; complexity score ${score}.`,
      selection: "complexity",
      blockedUpgrade:
        visionIntent && !imageCapabilityReady
          ? "vision-capability-signal-required"
          : score >= LOCALLLM_AUTO_MAX_MIN_COMPLEXITY && !maxAutoReady
            ? "max-auto-policy-not-satisfied"
            : "",
    });
  }

  return localLLMTierResult("fast", {
    model: localLLMModelForTier("fast", modelOverrides),
    reason: `Simple LocalLLM work selected Fast; complexity score ${score}.`,
    selection: "complexity",
    blockedUpgrade: visionIntent && !imageCapabilityReady ? "vision-capability-signal-required" : "",
  });
}

export function normalizeReasoningEffort(value = "", fallback = "") {
  const text = String(value ?? "").trim().toLowerCase();
  const normalizedFallback = REASONING_EFFORTS.includes(String(fallback || "").trim().toLowerCase())
    ? String(fallback || "").trim().toLowerCase()
    : "";
  if (!text) return normalizedFallback;
  if (["none", "off", "default", "provider-default", "provider_default", "providerdefault", "auto"].includes(text)) return "";
  if (text === "min") return "minimal";
  if (text === "x-high" || text === "extra-high" || text === "extra_high") return "xhigh";
  return REASONING_EFFORTS.includes(text) ? text : normalizedFallback;
}

export function reasoningEffortLabel(value = "") {
  return normalizeReasoningEffort(value) || REASONING_PROVIDER_DEFAULT_LABEL;
}

export const MODEL_PROVIDER_GROUPS = {
  localllm: {
    label: "LocalLLM",
    provider: "localllm",
    role: "local baseline",
    description: "OpenAI-compatible loopback route through the sibling LocalLLM gateway. Use LOCALLLM_BASE_URL/LOCALLLM_MODEL for explicit local overrides.",
  },
  deepseek: {
    label: "DeepSeek",
    provider: "deepseek",
    role: "hosted upgrade",
    description: "Optional low-cost hosted coding route. Flash is used for fast planning; Pro is used for complex execution.",
  },
  openai: {
    label: "OpenAI",
    provider: "openai",
    role: "spare/frontier",
    description: "Optional frontier spare or direct manual route, usually with explicit reasoning effort.",
  },
  openrouter: {
    label: "OpenRouter",
    provider: "openrouter",
    role: "multi-provider router",
    description: "OpenAI-compatible gateway with one API key and selectable model families.",
  },
  "openrouter-openai": {
    label: "OpenRouter OpenAI",
    provider: "openrouter",
    role: "gateway OpenAI",
    description: "OpenAI-family models routed through OpenRouter.",
  },
  "openrouter-anthropic": {
    label: "OpenRouter Anthropic",
    provider: "openrouter",
    role: "gateway Claude",
    description: "Claude-family models routed through OpenRouter.",
  },
  "openrouter-google": {
    label: "OpenRouter Google",
    provider: "openrouter",
    role: "gateway Gemini/Gemma",
    description: "Google Gemini and Gemma models routed through OpenRouter.",
  },
  "openrouter-deepseek": {
    label: "OpenRouter DeepSeek",
    provider: "openrouter",
    role: "gateway DeepSeek",
    description: "DeepSeek models routed through OpenRouter.",
  },
  "openrouter-qwen": {
    label: "OpenRouter Qwen",
    provider: "openrouter",
    role: "gateway Qwen",
    description: "Qwen models routed through OpenRouter.",
  },
  "openrouter-meta": {
    label: "OpenRouter Meta",
    provider: "openrouter",
    role: "gateway Llama",
    description: "Meta Llama models routed through OpenRouter.",
  },
  "openrouter-mistral": {
    label: "OpenRouter Mistral",
    provider: "openrouter",
    role: "gateway Mistral",
    description: "Mistral and Devstral models routed through OpenRouter.",
  },
  "openrouter-moonshot": {
    label: "OpenRouter Moonshot",
    provider: "openrouter",
    role: "gateway Kimi",
    description: "Moonshot/Kimi models routed through OpenRouter.",
  },
  "openrouter-xai": {
    label: "OpenRouter xAI",
    provider: "openrouter",
    role: "gateway Grok",
    description: "xAI Grok models routed through OpenRouter.",
  },
  qwen: {
    label: "Qwen",
    provider: "qwen",
    role: "regional/general",
    description: "DashScope/OpenAI-compatible Qwen route for Chinese and general work.",
  },
  venice: {
    label: "Venice",
    provider: "venice",
    role: "alternate text",
    description: "Venice 1.2/1.1 and Gemma 4 Uncensored for optional manual routes.",
  },
  "venice-gpt": {
    label: "Venice GPT",
    provider: "venice",
    role: "alternate GPT",
    description: "GPT-family models routed through Venice.",
  },
  "venice-claude": {
    label: "Venice Claude",
    provider: "venice",
    role: "alternate Claude",
    description: "Claude-family models routed through Venice.",
  },
  "venice-gemma": {
    label: "Venice Gemma",
    provider: "venice",
    role: "alternate Gemma",
    description: "Gemma-family Venice models.",
  },
  "venice-qwen": {
    label: "Venice Qwen",
    provider: "venice",
    role: "alternate Qwen",
    description: "Qwen-family Venice models.",
  },
};

export const AUXILIARY_MODEL_CATALOG = {
  grsai: [
    {
      id: "nano-banana-2",
      label: "Nano Banana 2",
      type: "image",
      description: "Default auxiliary image-generation route through GRS AI-compatible APIs.",
    },
    {
      id: "nano-banana-2-edit",
      label: "Nano Banana 2 Edit",
      type: "inpaint",
      description: "Image edit route through GRS AI-compatible APIs when available.",
    },
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      type: "image",
      description: "High-quality image generation when available through the configured auxiliary endpoint.",
    },
    {
      id: "gpt-image-2-edit",
      label: "GPT Image 2 Edit",
      type: "inpaint",
      description: "High-quality image editing when available through the configured auxiliary endpoint.",
    },
  ],
  "venice-image": [
    { id: "wan-2-7-pro-edit", label: "Wan 2.7 Pro Edit", type: "inpaint", price: "$0.09/edit" },
    { id: "nano-banana-2", label: "Nano Banana 2", type: "image", price: "$0.10/image" },
    { id: "nano-banana-2-edit", label: "Nano Banana 2 Edit", type: "inpaint", price: "$0.10/edit" },
    { id: "gpt-image-2", label: "GPT Image 2", type: "image", price: "$0.27/image" },
    { id: "gpt-image-2-edit", label: "GPT Image 2 Edit", type: "inpaint", price: "$0.36/edit" },
    { id: "grok-imagine-image-pro", label: "Grok Imagine Pro", type: "image", price: "$0.09/image" },
    { id: "grok-imagine-image", label: "Grok Imagine", type: "image", price: "$0.03/image" },
    { id: "wan-2-7-text-to-image", label: "Wan 2.7", type: "image", price: "$0.04/image" },
    { id: "wan-2-7-pro-text-to-image", label: "Wan 2.7 Pro", type: "image", price: "$0.09/image" },
    { id: "qwen-image-2", label: "Qwen Image 2", type: "image", price: "$0.05/image" },
    { id: "qwen-image-2-pro", label: "Qwen Image 2 Pro", type: "image", price: "$0.10/image" },
    { id: "qwen-image-2-edit", label: "Qwen Image 2 Edit", type: "inpaint", price: "$0.05/edit" },
    { id: "qwen-image-2-pro-edit", label: "Qwen Image 2 Pro Edit", type: "inpaint", price: "$0.10/edit" },
    { id: "bria-bg-remover", label: "Background Remover", type: "image", price: "$0.03/image" },
    { id: "recraft-v4", label: "Recraft V4", type: "image", price: "$0.05/image" },
    { id: "recraft-v4-pro", label: "Recraft V4 Pro", type: "image", price: "$0.29/image" },
    { id: "flux-2-pro", label: "Flux 2 Pro", type: "image", price: "$0.04/image" },
    { id: "flux-2-max", label: "Flux 2 Max", type: "image", price: "$0.09/image" },
    { id: "nano-banana-pro", label: "Nano Banana Pro", type: "image", price: "$0.18/image" },
    { id: "nano-banana-pro-edit", label: "Nano Banana Pro Edit", type: "inpaint", price: "$0.18/edit" },
  ],
};

export const PROVIDER_MODEL_CATALOG = {
  localllm: [
    {
      ...LOCALLLM_MODEL_TIERS.fast,
      id: LOCALLLM_MODEL_TIERS.fast.model,
      tier: LOCALLLM_MODEL_TIERS.fast.id,
      context: "256K",
      description: "Fast local lane for simple conversation, classification, and routing.",
    },
    {
      ...LOCALLLM_MODEL_TIERS.deep,
      id: LOCALLLM_MODEL_TIERS.deep.model,
      tier: LOCALLLM_MODEL_TIERS.deep.id,
      context: "256K",
      description: "Default 30B-A3B Q4 lane for substantive agent, coding, debugging, and design work.",
    },
    {
      ...LOCALLLM_MODEL_TIERS.code,
      id: LOCALLLM_MODEL_TIERS.code.model,
      tier: LOCALLLM_MODEL_TIERS.code.id,
      context: "256K",
      description: "Configurable local coding specialist selected only for implementation work after authenticated alias discovery.",
    },
    {
      ...LOCALLLM_MODEL_TIERS.max,
      id: LOCALLLM_MODEL_TIERS.max.model,
      tier: LOCALLLM_MODEL_TIERS.max.id,
      context: "256K",
      description: "Explicit highest-fidelity Q8 lane; automatic use requires opt-in and confirmed resource headroom.",
    },
    {
      ...LOCALLLM_MODEL_TIERS.vision,
      id: LOCALLLM_MODEL_TIERS.vision.model,
      tier: LOCALLLM_MODEL_TIERS.vision.id,
      context: "256K",
      description: "30B-A3B vision lane for tasks with image input and confirmed vision-model availability.",
    },
  ],
  deepseek: [
    {
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      role: "fast",
      context: "1.0M",
      description: "Default fast route for normal shell, browser, and short coding tasks.",
    },
    {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      role: "complex",
      context: "1.0M",
      description: "Default complex route for large coding, debugging, and design tasks.",
    },
  ],
  openai: [
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      role: "frontier",
      reasoning: REASONING_EFFORTS,
      description: "Frontier model for complex coding, research, and real-world work.",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      role: "everyday coding",
      reasoning: REASONING_EFFORTS,
      description: "Strong model for everyday coding.",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      role: "fast spare",
      reasoning: REASONING_EFFORTS,
      description: "Small, fast, cost-efficient model for simpler coding tasks.",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      role: "coding",
      reasoning: REASONING_EFFORTS,
      description: "Coding-optimized model.",
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      role: "fast coding",
      reasoning: REASONING_EFFORTS,
      description: "Ultra-fast coding model.",
    },
    {
      id: "gpt-5.2",
      label: "GPT-5.2",
      role: "long-running",
      reasoning: REASONING_EFFORTS,
      description: "Optimized for professional work and long-running agents.",
    },
  ],
  openrouter: [
    {
      id: "openrouter/auto",
      label: "OpenRouter Auto",
      bucket: "openrouter",
      role: "router",
      description: "OpenRouter automatic router for broad manual fallback when no family is selected.",
    },
    {
      id: "openrouter/pareto-code",
      label: "Pareto Code Router",
      bucket: "openrouter",
      role: "coding router",
      description: "OpenRouter coding router for coding-heavy tasks.",
    },
    {
      id: "openrouter/free",
      label: "OpenRouter Free Router",
      bucket: "openrouter",
      role: "free router",
      description: "OpenRouter free-model route for low-stakes testing.",
    },
    {
      id: "openai/gpt-5.5",
      label: "GPT-5.5",
      bucket: "openrouter-openai",
      role: "frontier",
      context: "varies",
      description: "OpenAI-family frontier model through OpenRouter.",
    },
    {
      id: "openai/gpt-5.4",
      label: "GPT-5.4",
      bucket: "openrouter-openai",
      role: "strong general",
      context: "varies",
      description: "OpenAI-family everyday coding/general model through OpenRouter.",
    },
    {
      id: "openai/gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      bucket: "openrouter-openai",
      role: "fast",
      context: "varies",
      description: "Lower-cost OpenAI-family route through OpenRouter.",
    },
    {
      id: "openai/gpt-4o",
      label: "GPT-4o",
      bucket: "openrouter-openai",
      role: "multimodal",
      context: "128K",
      description: "Stable GPT-4o route through OpenRouter.",
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      label: "Claude Sonnet 4.6",
      bucket: "openrouter-anthropic",
      role: "balanced",
      context: "varies",
      description: "Claude Sonnet route through OpenRouter.",
    },
    {
      id: "anthropic/claude-opus-4.7",
      label: "Claude Opus 4.7",
      bucket: "openrouter-anthropic",
      role: "high capacity",
      context: "varies",
      description: "Claude Opus route through OpenRouter.",
    },
    {
      id: "anthropic/claude-opus-4.8-fast",
      label: "Claude Opus 4.8 Fast",
      bucket: "openrouter-anthropic",
      role: "fast high capacity",
      context: "varies",
      description: "Fast Claude Opus route through OpenRouter.",
    },
    {
      id: "google/gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      bucket: "openrouter-google",
      role: "fast",
      context: "varies",
      description: "Fast Gemini route through OpenRouter.",
    },
    {
      id: "google/gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash Lite",
      bucket: "openrouter-google",
      role: "low cost",
      context: "varies",
      description: "Lightweight Gemini route through OpenRouter.",
    },
    {
      id: "google/gemma-4-31b-it",
      label: "Gemma 4 31B Instruct",
      bucket: "openrouter-google",
      role: "open model",
      context: "varies",
      description: "Gemma instruct route through OpenRouter.",
    },
    {
      id: "deepseek/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      bucket: "openrouter-deepseek",
      role: "fast",
      context: "varies",
      description: "DeepSeek fast route through OpenRouter.",
    },
    {
      id: "deepseek/deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      bucket: "openrouter-deepseek",
      role: "complex",
      context: "varies",
      description: "DeepSeek pro route through OpenRouter.",
    },
    {
      id: "deepseek/deepseek-r1-0528",
      label: "DeepSeek R1 0528",
      bucket: "openrouter-deepseek",
      role: "reasoning",
      context: "varies",
      description: "Reasoning-oriented DeepSeek route through OpenRouter.",
    },
    {
      id: "qwen/qwen3.7-max",
      label: "Qwen 3.7 Max",
      bucket: "openrouter-qwen",
      role: "complex",
      context: "varies",
      description: "High-capacity Qwen route through OpenRouter.",
    },
    {
      id: "qwen/qwen3.6-flash",
      label: "Qwen 3.6 Flash",
      bucket: "openrouter-qwen",
      role: "fast",
      context: "varies",
      description: "Fast Qwen route through OpenRouter.",
    },
    {
      id: "qwen/qwen3.6-plus",
      label: "Qwen 3.6 Plus",
      bucket: "openrouter-qwen",
      role: "general",
      context: "varies",
      description: "General Qwen route through OpenRouter.",
    },
    {
      id: "meta-llama/llama-4-maverick",
      label: "Llama 4 Maverick",
      bucket: "openrouter-meta",
      role: "open model",
      context: "varies",
      description: "Meta Llama 4 route through OpenRouter.",
    },
    {
      id: "meta-llama/llama-4-scout",
      label: "Llama 4 Scout",
      bucket: "openrouter-meta",
      role: "open model",
      context: "varies",
      description: "Meta Llama 4 Scout route through OpenRouter.",
    },
    {
      id: "meta-llama/llama-3.3-70b-instruct",
      label: "Llama 3.3 70B Instruct",
      bucket: "openrouter-meta",
      role: "open model",
      context: "varies",
      description: "Stable Llama 3.3 route through OpenRouter.",
    },
    {
      id: "mistralai/mistral-medium-3-5",
      label: "Mistral Medium 3.5",
      bucket: "openrouter-mistral",
      role: "general",
      context: "varies",
      description: "Mistral Medium route through OpenRouter.",
    },
    {
      id: "mistralai/mistral-large-2512",
      label: "Mistral Large 2512",
      bucket: "openrouter-mistral",
      role: "complex",
      context: "varies",
      description: "Mistral Large route through OpenRouter.",
    },
    {
      id: "moonshotai/kimi-k2.6",
      label: "Kimi K2.6",
      bucket: "openrouter-moonshot",
      role: "general",
      context: "varies",
      description: "Moonshot Kimi route through OpenRouter.",
    },
    {
      id: "moonshotai/kimi-k2-thinking",
      label: "Kimi K2 Thinking",
      bucket: "openrouter-moonshot",
      role: "reasoning",
      context: "varies",
      description: "Reasoning-oriented Moonshot Kimi route through OpenRouter.",
    },
    {
      id: "x-ai/grok-4.3",
      label: "Grok 4.3",
      bucket: "openrouter-xai",
      role: "general",
      context: "varies",
      description: "xAI Grok route through OpenRouter.",
    },
    {
      id: "x-ai/grok-build-0.1",
      label: "Grok Build 0.1",
      bucket: "openrouter-xai",
      role: "coding",
      context: "varies",
      description: "Coding-oriented Grok route through OpenRouter.",
    },
  ],
  venice: [
    {
      id: "venice-uncensored-1-2",
      label: "Venice Uncensored 1.2",
      bucket: "venice",
      context: "128K",
      description: "Current Venice uncensored text route.",
    },
    {
      id: "venice-uncensored",
      label: "Venice Uncensored 1.1",
      bucket: "venice",
      context: "32K",
      description: "Working Venice uncensored 1.1 text route.",
    },
    {
      id: "e2ee-venice-uncensored-24b-p",
      label: "Venice Uncensored 1.1 E2EE",
      bucket: "venice",
      context: "32K",
      hidden: true,
      description: "Documented E2EE Venice 1.1 route; hidden from selectors until upstream stabilizes.",
    },
    {
      id: "venice-uncensored-role-play",
      label: "Venice Role Play Uncensored",
      bucket: "venice",
      context: "128K",
      hidden: true,
      description: "Role-play oriented Venice route.",
    },
    {
      id: "gemma-4-uncensored",
      label: "Gemma 4 Uncensored",
      bucket: "venice",
      context: "256K",
      description: "Gemma-family uncensored Venice route.",
    },
    {
      id: "google-gemma-4-31b-it",
      label: "Google Gemma 4 31B Instruct",
      bucket: "venice-gemma",
      context: "256K",
      description: "Gemma 4 instruct model through Venice.",
    },
    {
      id: "google-gemma-4-26b-a4b-it",
      label: "Google Gemma 4 26B A4B Instruct",
      bucket: "venice-gemma",
      context: "256K",
      description: "Smaller Gemma 4 instruct model through Venice.",
    },
    {
      id: "google-gemma-3-27b-it",
      label: "Google Gemma 3 27B Instruct",
      bucket: "venice-gemma",
      context: "198K",
      description: "Gemma 3 instruct model through Venice.",
    },
    {
      id: "e2ee-gemma-3-27b-p",
      label: "Gemma 3 27B E2EE",
      bucket: "venice-gemma",
      context: "40K",
      description: "Private E2EE Gemma 3 route through Venice.",
    },
    {
      id: "qwen3-6-27b",
      label: "Qwen 3.6 27B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Qwen-family Venice route.",
    },
    {
      id: "qwen-3-6-plus",
      label: "Qwen 3.6 Plus Uncensored",
      bucket: "venice-qwen",
      context: "1.0M",
      description: "Long-context Qwen 3.6 Plus route through Venice.",
    },
    {
      id: "qwen3-5-9b",
      label: "Qwen 3.5 9B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Small fast Qwen-family Venice route.",
    },
    {
      id: "qwen3-5-35b-a3b",
      label: "Qwen 3.5 35B A3B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Mid-size Qwen-family Venice route.",
    },
    {
      id: "qwen3-5-397b-a17b",
      label: "Qwen 3.5 397B A17B",
      bucket: "venice-qwen",
      context: "128K",
      description: "Large Qwen-family Venice route.",
    },
    {
      id: "qwen3-coder-480b-a35b-instruct-turbo",
      label: "Qwen 3 Coder 480B Turbo",
      bucket: "venice-qwen",
      context: "256K",
      description: "Coding-oriented Qwen route through Venice.",
    },
    {
      id: "qwen3-vl-235b-a22b",
      label: "Qwen3 VL 235B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Vision-language Qwen route through Venice.",
    },
    {
      id: "qwen3-235b-a22b-thinking-2507",
      label: "Qwen 3 235B A22B Thinking",
      bucket: "venice-qwen",
      context: "128K",
      description: "Qwen thinking route through Venice.",
    },
    {
      id: "qwen3-235b-a22b-instruct-2507",
      label: "Qwen 3 235B A22B Instruct",
      bucket: "venice-qwen",
      context: "128K",
      description: "Qwen instruct route through Venice.",
    },
    {
      id: "qwen3-next-80b",
      label: "Qwen 3 Next 80B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Qwen Next route through Venice.",
    },
    {
      id: "qwen3-coder-480b-a35b-instruct",
      label: "Qwen 3 Coder 480B",
      bucket: "venice-qwen",
      context: "256K",
      hidden: true,
      description: "Deprecated Qwen Coder route; hidden by default.",
    },
    {
      id: "openai-gpt-55",
      label: "GPT-5.5 via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "OpenAI-family Venice-routed model.",
    },
    {
      id: "openai-gpt-55-pro",
      label: "GPT-5.5 Pro via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "High-capacity GPT-5.5 Pro route through Venice.",
    },
    {
      id: "openai-gpt-54",
      label: "GPT-5.4 via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "GPT-5.4 route through Venice.",
    },
    {
      id: "openai-gpt-54-pro",
      label: "GPT-5.4 Pro via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "High-capacity GPT-5.4 Pro route through Venice.",
    },
    {
      id: "openai-gpt-54-mini",
      label: "GPT-5.4 Mini via Venice",
      bucket: "venice-gpt",
      context: "400K",
      description: "Small fast GPT route through Venice.",
    },
    {
      id: "openai-gpt-53-codex",
      label: "GPT-5.3 Codex via Venice",
      bucket: "venice-gpt",
      context: "400K",
      description: "Coding-optimized GPT route through Venice.",
    },
    {
      id: "openai-gpt-52",
      label: "GPT-5.2 via Venice",
      bucket: "venice-gpt",
      context: "256K",
      description: "Professional-work GPT route through Venice.",
    },
    {
      id: "openai-gpt-52-codex",
      label: "GPT-5.2 Codex via Venice",
      bucket: "venice-gpt",
      context: "256K",
      description: "Codex-flavored GPT-5.2 route through Venice.",
    },
    {
      id: "openai-gpt-4o-2024-11-20",
      label: "GPT-4o via Venice",
      bucket: "venice-gpt",
      context: "128K",
      description: "GPT-4o route through Venice.",
    },
    {
      id: "openai-gpt-4o-mini-2024-07-18",
      label: "GPT-4o Mini via Venice",
      bucket: "venice-gpt",
      context: "128K",
      description: "Small GPT-4o route through Venice.",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Claude-family Venice-routed model.",
    },
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "High-capacity Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-6-fast",
      label: "Claude Opus 4.6 Fast via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Fast Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-5",
      label: "Claude Opus 4.5 via Venice",
      bucket: "venice-claude",
      context: "198K",
      description: "Claude Opus 4.5 route through Venice.",
    },
    {
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5 via Venice",
      bucket: "venice-claude",
      context: "198K",
      description: "Claude Sonnet 4.5 route through Venice.",
    },
  ],
  qwen: [
    {
      id: "qwen-plus",
      label: "Qwen Plus",
      role: "default",
      description: "DashScope OpenAI-compatible route.",
    },
    {
      id: "qwen-turbo",
      label: "Qwen Turbo",
      role: "fast",
      description: "Fast DashScope OpenAI-compatible Qwen route.",
    },
    {
      id: "qwen-max",
      label: "Qwen Max",
      role: "complex",
      description: "Higher-capacity Qwen route.",
    },
  ],
  mock: [
    {
      id: "mock-agent",
      label: "Mock Agent",
      role: "local",
      description: "Deterministic local test route.",
    },
  ],
};

export function getProviderDefaults(provider = BASELINE_PROVIDER) {
  return resolveProviderDefaults(provider);
}

function normalizeConfiguredProvider(value, fallback = BASELINE_PROVIDER) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const normalized = normalizeProviderId(raw, "");
  if (normalized) return normalized;
  throw new Error(`Unknown provider "${raw}". Use localllm, deepseek, openai, openrouter, qwen, venice, or mock.`);
}

function providerDefaultModel(provider, fallback, role = "default") {
  const normalized = normalizeProviderId(provider);
  if (normalized === "localllm") {
    const sharedOverride =
      process.env.AGINTI_LOCALLLM_MODEL || process.env.LOCALLLM_MODEL || process.env.LOCAL_LLM_MODEL || "";
    if (role === "main") {
      return process.env.AGINTI_LOCALLLM_MAIN_MODEL || sharedOverride || LOCALLLM_MODEL_TIERS.deep.model;
    }
    if (role === "route") {
      return process.env.AGINTI_LOCALLLM_ROUTE_MODEL || sharedOverride || LOCALLLM_MODEL_TIERS.fast.model;
    }
  }
  if (normalized === "deepseek" && fallback) return fallback;
  return getProviderDefaults(normalized).model || fallback;
}

export function getModelPresets(overrides = {}) {
  const routeProvider = normalizeConfiguredProvider(overrides.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || process.env.AGENT_PROVIDER, BASELINE_PROVIDER);
  const mainProvider = normalizeConfiguredProvider(overrides.mainProvider || process.env.AGINTI_MAIN_PROVIDER || process.env.AGENT_PROVIDER, routeProvider);
  return {
    fast: {
      id: "fast",
      label: "Fast base",
      provider: routeProvider,
      model:
        overrides.routeModel ||
        process.env.AGINTI_ROUTE_MODEL ||
        (routeProvider === "deepseek" ? process.env.DEEPSEEK_FAST_MODEL : "") ||
        providerDefaultModel(routeProvider, routeProvider === "deepseek" ? "deepseek-v4-flash" : "", "route"),
      description: "Default fast route for normal browser, shell, and short coding tasks.",
    },
    complex: {
      id: "complex",
      label: "Complex reasoning",
      provider: mainProvider,
      model:
        overrides.mainModel ||
        process.env.AGINTI_MAIN_MODEL ||
        (mainProvider === "deepseek" ? process.env.DEEPSEEK_PRO_MODEL : "") ||
        providerDefaultModel(mainProvider, mainProvider === "deepseek" ? "deepseek-v4-pro" : "", "main"),
      description: "Higher-capacity route for multi-step coding and design tasks.",
    },
    localMax: {
      id: "localMax",
      label: LOCALLLM_MODEL_TIERS.max.label,
      provider: "localllm",
      model: overrides.maxModel || process.env.AGINTI_LOCALLLM_MAX_MODEL || LOCALLLM_MODEL_TIERS.max.model,
      description: "Explicit highest-fidelity local route; auto-routing is resource-policy gated.",
    },
    localCode: {
      id: "localCode",
      label: LOCALLLM_MODEL_TIERS.code.label,
      provider: "localllm",
      model: overrides.codeModel || process.env.AGINTI_LOCALLLM_CODE_MODEL || LOCALLLM_MODEL_TIERS.code.model,
      description: "Configurable coding-capability alias; smart use requires authenticated availability.",
    },
    localVision: {
      id: "localVision",
      label: LOCALLLM_MODEL_TIERS.vision.label,
      provider: "localllm",
      model: overrides.visionModel || process.env.AGINTI_LOCALLLM_VISION_MODEL || LOCALLLM_MODEL_TIERS.vision.model,
      description: "Local vision route for confirmed image-input tasks.",
    },
    mock: {
      id: "mock",
      label: "Local mock",
      provider: "mock",
      model: process.env.MOCK_MODEL || "mock-agent",
      description: "Credential-free local route for UI, API, and tool-routing smoke tests.",
    },
    venicePrimary: {
      id: "venicePrimary",
      label: "Venice primary",
      provider: "venice",
      model: process.env.VENICE_MODEL || process.env.VENICE_DEFAULT_MODEL || "venice-uncensored-1-2",
      description: "Manual/primary Venice OpenAI-compatible route.",
    },
    veniceUncensored: {
      id: "veniceUncensored",
      label: "Venice uncensored",
      provider: "venice",
      model: "venice-uncensored-1-2",
      description: "Venice uncensored 1.2 text route.",
    },
    veniceGemma: {
      id: "veniceGemma",
      label: "Venice Gemma",
      provider: "venice",
      model: "gemma-4-uncensored",
      description: "Venice Gemma-family route.",
    },
    veniceQwen: {
      id: "veniceQwen",
      label: "Venice Qwen",
      provider: "venice",
      model: "qwen3-6-27b",
      description: "Venice Qwen-family route.",
    },
    veniceGpt: {
      id: "veniceGpt",
      label: "Venice GPT",
      provider: "venice",
      model: "openai-gpt-55",
      description: "Venice GPT-family route.",
    },
    veniceClaude: {
      id: "veniceClaude",
      label: "Venice Claude",
      provider: "venice",
      model: "claude-sonnet-4-6",
      description: "Venice Claude-family route.",
    },
    openrouterAuto: {
      id: "openrouterAuto",
      label: "OpenRouter Auto",
      provider: "openrouter",
      model: process.env.OPENROUTER_MODEL || process.env.OPENROUTER_DEFAULT_MODEL || "openrouter/auto",
      description: "OpenRouter automatic gateway route.",
    },
    openrouterOpenAi: {
      id: "openrouterOpenAi",
      label: "OpenRouter GPT-5.4 Mini",
      provider: "openrouter",
      model: "openai/gpt-5.4-mini",
      description: "OpenAI-family model through OpenRouter.",
    },
    openrouterClaude: {
      id: "openrouterClaude",
      label: "OpenRouter Claude Sonnet",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      description: "Anthropic Claude-family model through OpenRouter.",
    },
    openaiGpt55: {
      id: "openaiGpt55",
      label: "OpenAI GPT-5.5",
      provider: "openai",
      model: "gpt-5.5",
      reasoning: "medium",
      description: "Frontier OpenAI route for complex coding, research, and real-world work.",
    },
    openaiGpt54: {
      id: "openaiGpt54",
      label: "OpenAI GPT-5.4",
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "medium",
      description: "Strong OpenAI route for everyday coding.",
    },
    openaiGpt54Mini: {
      id: "openaiGpt54Mini",
      label: "OpenAI GPT-5.4 Mini",
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoning: "high",
      description: "Fast OpenAI spare route for simpler coding tasks.",
    },
    openaiCodex: {
      id: "openaiCodex",
      label: "OpenAI GPT-5.3 Codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      reasoning: "medium",
      description: "Coding-optimized OpenAI route.",
    },
    openaiCodexSpark: {
      id: "openaiCodexSpark",
      label: "OpenAI GPT-5.3 Codex Spark",
      provider: "openai",
      model: "gpt-5.3-codex-spark",
      reasoning: "high",
      description: "Ultra-fast OpenAI coding route.",
    },
    openaiGpt52: {
      id: "openaiGpt52",
      label: "OpenAI GPT-5.2",
      provider: "openai",
      model: "gpt-5.2",
      reasoning: "medium",
      description: "OpenAI route for professional and long-running agent work.",
    },
    codexPrimary: {
      id: "codexPrimary",
      label: "Codex primary wrapper",
      provider: "codex-wrapper",
      model: overrides.wrapperModel || process.env.AGINTI_WRAPPER_MODEL || process.env.CODEX_PRIMARY_MODEL || "gpt-5.5",
      reasoning:
        overrides.wrapperReasoning || process.env.AGINTI_WRAPPER_REASONING || process.env.CODEX_PRIMARY_REASONING || "medium",
      description: "External Codex wrapper route for coding enhancement tasks.",
    },
    codexSpare: {
      id: "codexSpare",
      label: "Codex spare wrapper",
      provider: "codex-wrapper",
      model: process.env.CODEX_SPARE_MODEL || "gpt-5.4-mini",
      reasoning: process.env.CODEX_SPARE_REASONING || "high",
      description: "Fallback Codex wrapper route when the primary wrapper fails.",
    },
  };
}

export function getModelRoleDefaults(overrides = {}) {
  const presets = getModelPresets(overrides);
  const spareProvider = normalizeConfiguredProvider(
    overrides.spareProvider || process.env.AGINTI_SPARE_PROVIDER || presets.complex.provider,
    presets.complex.provider
  );
  const spareModel =
    overrides.spareModel ||
    process.env.AGINTI_SPARE_MODEL ||
    (spareProvider === presets.complex.provider
      ? presets.complex.model
      : providerDefaultModel(spareProvider, "", "main"));
  const auxiliaryProvider = overrides.auxiliaryProvider || process.env.AGINTI_AUX_PROVIDER || "grsai";
  const auxiliaryModel = overrides.auxiliaryModel || process.env.AGINTI_AUX_MODEL || process.env.VENICE_IMAGE_MODEL || "nano-banana-2";
  return {
    route: {
      id: "route",
      label: "Route model",
      command: "/route",
      provider: presets.fast.provider,
      model: presets.fast.model,
      reasoning: normalizeReasoningEffort(overrides.routeReasoning ?? process.env.AGINTI_ROUTE_REASONING ?? ""),
      description: "Fast planner and triage model. Default: LocalLLM loopback.",
    },
    main: {
      id: "main",
      label: "Main model",
      command: "/model",
      provider: presets.complex.provider,
      model: presets.complex.model,
      reasoning: normalizeReasoningEffort(overrides.mainReasoning ?? process.env.AGINTI_MAIN_REASONING ?? ""),
      description: "Complex executor for coding, debugging, writing, and long tasks. Default: LocalLLM loopback.",
    },
    spare: {
      id: "spare",
      label: "Spare model",
      command: "/spare",
      provider: spareProvider,
      model: spareModel,
      reasoning: normalizeReasoningEffort(overrides.spareReasoning ?? process.env.AGINTI_SPARE_REASONING ?? "medium", "medium"),
      description: "Explicit fallback or cross-check model. Defaults to the active main provider, so local-first runs stay local.",
    },
    wrapper: {
      id: "wrapper",
      label: "Wrapper",
      command: "/wrapper",
      provider: "codex",
      model: presets.codexPrimary.model,
      reasoning: presets.codexPrimary.reasoning,
      description: "External coding wrapper when enabled. Default: Codex with GPT-5.5 medium reasoning.",
    },
    auxiliary: {
      id: "auxiliary",
      label: "Auxiliary",
      command: "/auxiliary",
      provider: auxiliaryProvider,
      model: auxiliaryModel,
      description: "Image/media tools. Default: GRS AI/Nano Banana; Venice image is optional.",
    },
  };
}

export function modelsForProviderGroup(groupId) {
  const group = MODEL_PROVIDER_GROUPS[groupId];
  if (!group) return [];
  if (group.provider === "openrouter") {
    return (PROVIDER_MODEL_CATALOG.openrouter || []).filter((item) => item.bucket === groupId);
  }
  if (group.provider !== "venice") return PROVIDER_MODEL_CATALOG[group.provider] || [];
  return (PROVIDER_MODEL_CATALOG.venice || []).filter((item) => item.bucket === groupId);
}

export function scoreTaskComplexity(goal = "", taskProfile = "auto") {
  const text = String(goal).toLowerCase();
  let score = text.length > 600 ? 2 : text.length > 240 ? 1 : 0;
  const profile = String(taskProfile || "").toLowerCase();
  if (["large-codebase", "engineering", "codebase", "code", "qa", "database", "devops", "security"].includes(profile)) score += 3;
  if (["app", "data", "paper", "research", "latex", "github", "maintenance", "supervision", "writing", "book", "novel"].includes(profile)) {
    score += 2;
  }
  for (const keyword of COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) score += 1;
  }
  for (const hint of COMPLEX_ROUTE_HINTS) {
    if (hint.test(goal)) score += 3;
  }
  return score;
}

export function normalizeRoutingMode(value) {
  return ROUTING_MODES.includes(value) ? value : "smart";
}

function localRoutePolicyFields(model, selection = "role") {
  const tier = localLLMModelTier(model);
  if (!tier) {
    return {
      localTier: "custom",
      localSelection: selection,
      requiresResourcePreflight: false,
    };
  }
  return {
    localTier: tier.id,
    localSelection: selection,
    requiresResourcePreflight: tier.id === "max",
  };
}

export function selectModelRoute({
  routingMode = "smart",
  provider = BASELINE_PROVIDER,
  model = "",
  goal = "",
  taskProfile = "auto",
  routeProvider = "",
  routeModel = "",
  mainProvider = "",
  mainModel = "",
  localCapabilities = {},
  localResourcePolicy = {},
  localModelOverrides = {},
} = {}) {
  const mode = normalizeRoutingMode(routingMode);
  const requestedProvider = normalizeConfiguredProvider(provider, BASELINE_PROVIDER);
  const presets = getModelPresets({
    routeProvider: routeProvider || requestedProvider,
    routeModel,
    mainProvider: mainProvider || requestedProvider,
    mainModel,
    codeModel: localModelOverrides.codeModel,
    maxModel: localModelOverrides.maxModel,
    visionModel: localModelOverrides.visionModel,
  });

  if (requestedProvider === "mock") {
    const defaults = getProviderDefaults("mock");
    return {
      routingMode: "manual",
      provider: defaults.provider,
      model: model || defaults.model,
      reason: "Local mock route selected for smoke tests and offline UI/API checks.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  const explicitLocalTier = requestedProvider === "localllm" ? localLLMModelTier(model) : null;
  if (mode === "smart" && ["code", "max", "vision"].includes(explicitLocalTier?.id)) {
    const decision = selectLocalLLMModelTier({ requestedModel: model });
    return {
      routingMode: "manual",
      provider: "localllm",
      model: decision.model,
      reason: decision.reason,
      complexityScore: scoreTaskComplexity(goal, taskProfile),
      localTier: decision.tier,
      localSelection: decision.selection,
      requiresResourcePreflight: decision.requiresResourcePreflight,
    };
  }

  if (
    mode === "smart" &&
    requestedProvider !== presets.fast.provider &&
    requestedProvider !== presets.complex.provider
  ) {
    const defaults = getProviderDefaults(requestedProvider);
    return {
      routingMode: "manual",
      provider: defaults.provider,
      model: model || defaults.model,
      reason: `Smart routing delegated to selected primary provider "${defaults.provider}".`,
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  if (mode === "manual") {
    const defaults = getProviderDefaults(requestedProvider);
    const selectedModel = model || defaults.model;
    return {
      routingMode: mode,
      provider: defaults.provider,
      model: selectedModel,
      reason: "Manual provider/model selection.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
      ...(defaults.provider === "localllm" ? localRoutePolicyFields(selectedModel, "explicit") : {}),
    };
  }

  if (mode === "complex") {
    const selectedModel = presets.complex.model;
    return {
      routingMode: mode,
      provider: presets.complex.provider,
      model: selectedModel,
      reason: "Complex route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
      ...(presets.complex.provider === "localllm" ? localRoutePolicyFields(selectedModel, "explicit-role") : {}),
    };
  }

  if (mode === "fast") {
    const selectedModel = presets.fast.model;
    return {
      routingMode: mode,
      provider: presets.fast.provider,
      model: selectedModel,
      reason: "Fast route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
      ...(presets.fast.provider === "localllm" ? localRoutePolicyFields(selectedModel, "explicit-role") : {}),
    };
  }

  const complexityScore = scoreTaskComplexity(goal, taskProfile);

  if (presets.fast.provider === "localllm" && presets.complex.provider === "localllm") {
    const decision = selectLocalLLMModelTier({
      goal,
      taskProfile,
      complexityScore,
      localCapabilities,
      localResourcePolicy,
      modelOverrides: {
        fastModel: localModelOverrides.fastModel || presets.fast.model,
        deepModel: localModelOverrides.deepModel || presets.complex.model,
        codeModel: localModelOverrides.codeModel || presets.localCode.model,
        maxModel: localModelOverrides.maxModel || presets.localMax.model,
        visionModel: localModelOverrides.visionModel || presets.localVision.model,
      },
    });
    return {
      routingMode: mode,
      provider: decision.provider,
      model: decision.model,
      reason: decision.reason,
      complexityScore,
      localTier: decision.tier,
      localSelection: decision.selection,
      localUpgradeBlocked: decision.blockedUpgrade,
      localCodeCandidate: decision.codeCandidate === true,
      localCodeModel: decision.codeModel || "",
      localCodeFallbackModel: decision.codeFallbackModel || "",
      requiresResourcePreflight: decision.requiresResourcePreflight,
    };
  }

  const selected = complexityScore >= 3 ? presets.complex : presets.fast;
  return {
    routingMode: mode,
    provider: selected.provider,
    model: selected.model,
    reason:
      selected.id === "complex"
        ? `Smart routing selected complex route; complexity score ${complexityScore}.`
        : `Smart routing selected fast route; complexity score ${complexityScore}.`,
    complexityScore,
  };
}
