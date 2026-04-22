[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow est l'agent d'AgInTi pour contrôler le navigateur et les outils locaux avec des garde-fous: automatisation web, conversations persistantes, exécutions reprenables et commandes locales protégées.

## Aperçu

| Domaine | Direction |
| --- | --- |
| Boucle centrale | Planifier -> utiliser les outils -> journaliser -> terminer ou reprendre |
| Navigateur | Playwright, démarrage paresseux, allowlist de domaines |
| Modèles | Tool calling compatible OpenAI, presets OpenAI et DeepSeek |
| Outils locaux | Shell optionnel avec garde-fous et sandbox Docker |
| Mémoire | Etat de session, préférences persistantes, conversation continue |

## Démarrage rapide

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Ouvrez `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## Sécurité

- Les mots de passe et actions destructives sont bloqués sauf activation explicite.
- Le shell est optionnel et peut tourner dans Docker sans réseau.
- Chaque appel d'outil et résultat est enregistré dans `.sessions/`.

## Développement

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
