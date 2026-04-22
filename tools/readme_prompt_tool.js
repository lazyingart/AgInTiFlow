#!/usr/bin/env node

const profiles = {
  agintiflow: {
    name: "AgInTiFlow",
    purpose:
      "browser and tool-use agent with provider selection, persistent chat, resumable runs, guarded shell tools, and optional Docker sandboxing",
    requiredSections: [
      "language links at the top",
      "existing Lachlan and AgInTiFlow banners preserved",
      "short product summary",
      "product snapshot table",
      "quick start commands",
      "web UI behavior",
      "safety model",
      "configuration",
      "runtime artifacts",
      "project structure",
      "localized translations",
    ],
  },
  "aginti-landing": {
    name: "AgInTi Website",
    purpose:
      "bright GitHub Pages landing site for AgInTi, an autonomous laboratory intelligence company for chemistry and biomedicine",
    requiredSections: [
      "language links at the top",
      "live site and repository links",
      "short company positioning",
      "project snapshot table",
      "local preview command",
      "GitHub Pages deployment notes",
      "site structure",
      "localized translations",
    ],
  },
};

const key = process.argv[2] || "agintiflow";
const profile = profiles[key];

if (!profile) {
  console.error(`Unknown profile: ${key}`);
  console.error(`Available profiles: ${Object.keys(profiles).join(", ")}`);
  process.exit(1);
}

console.log(`# README polish prompt: ${profile.name}

Write a polished, concise, multilingual README for ${profile.name}.

Project purpose:
${profile.purpose}

Style rules:
- Use a clear language switch at the top: English, Arabic, Spanish, French, Japanese, Korean, Vietnamese, Simplified Chinese, Traditional Chinese, German, and Russian.
- Keep the English README as the canonical root document.
- Put localized README files under i18n/README.<locale>.md.
- Prefer concise product language over long marketing copy.
- Use tables for snapshots, configuration, and structure when they reduce scanning time.
- Keep commands copy-pasteable.
- Avoid claiming unsupported features.
- Keep repository-specific branding intact.

Required sections:
${profile.requiredSections.map((section) => `- ${section}`).join("\n")}
`);
