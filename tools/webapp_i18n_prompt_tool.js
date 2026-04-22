#!/usr/bin/env node

const localeSet = [
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

const keys = [
  "documentTitle",
  "brandKicker",
  "languageLabel",
  "intro",
  "providerLabel",
  "modelLabel",
  "goalLabel",
  "goalPlaceholder",
  "startUrlLabel",
  "startUrlPlaceholder",
  "allowedDomainsLabel",
  "allowedDomainsPlaceholder",
  "commandCwdLabel",
  "maxStepsLabel",
  "headlessLabel",
  "shellToolLabel",
  "dockerSandboxLabel",
  "allowPasswordsLabel",
  "allowDestructiveLabel",
  "dockerImageLabel",
  "dockerImagePlaceholder",
  "startRunButton",
  "runOutputTitle",
  "noRunStarted",
  "conversationTitle",
  "noSessionSelected",
  "selectRecentSession",
  "noConversationLoaded",
  "chatPlaceholder",
  "sendMessageButton",
  "assistantLabel",
  "youLabel",
  "keysLabel",
  "availableLabel",
  "missingLabel",
  "goalRequired",
  "startingRun",
  "failedStartRun",
  "noRunSelected",
  "selectSessionFirst",
  "messageRequired",
  "sendingStatus",
  "runningStatus",
  "failedContinue",
];

console.log(`# AgInTiFlow webapp i18n prompt

Update the AgInTiFlow webapp with complete multilingual UI support.

Locale set:
${localeSet.map((locale) => `- ${locale}`).join("\n")}

Translation keys:
${keys.map((key) => `- ${key}`).join("\n")}

Rules:
- Keep product names, provider names, model names, shell command names, Docker image names, and API identifiers unchanged.
- Keep translations concise because form labels and status messages are rendered in compact UI panels.
- Use public/app.js for the translation dictionaries and runtime language switching.
- Use public/index.html for data-i18n and data-i18n-placeholder attributes.
- Persist the selected language through the existing /api/preferences SQLite-backed preference flow.
- Preserve the same language set as the repository README and AgInTi landing website.
- Arabic must set document direction to rtl; all other locales should use ltr.
- Prefer extracting foreground transparency for image assets; do not add white logo backing cards in CSS.

Backfill checklist:
- Every locale must define every key above.
- Every data-i18n attribute in public/index.html must have a matching key.
- Every data-i18n-placeholder attribute in public/index.html must have a matching key.
- Dynamic UI messages in public/app.js should use t("key") instead of hardcoded English.

Validation:
- node --check public/app.js
- node --check web.js
- node --check src/*.js
- node tools/webapp_i18n_prompt_tool.js
`);
