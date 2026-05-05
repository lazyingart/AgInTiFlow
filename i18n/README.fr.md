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

AgInTiFlow est un espace de travail local Web et CLI pour agents, conçu pour de vrais dossiers de projet. Il combine routage de modèles à faible coût, usage d’outils inspectable, sessions persistantes, actions protégées sur fichiers/shell/navigateur, génération d’images optionnelle et supervision structurée des grandes tâches.

En bref : lancez `aginti` dans un projet, donnez-lui une tâche, inspectez son plan, voyez chaque appel d’outil, reprenez plus tard et gardez les sorties dans votre workspace.

**Liens**

| Ressource | URL |
| --- | --- |
| Website | [https://flow.lazying.art](https://flow.lazying.art) |
| GitHub | [https://github.com/lazyingart/AgInTiFlow](https://github.com/lazyingart/AgInTiFlow) |
| npm | [https://www.npmjs.com/package/@lazyingart/agintiflow](https://www.npmjs.com/package/@lazyingart/agintiflow) |
| AAPS npm | [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps) |
| README complet archivé | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

<p align="center">
  <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow interactive CLI launch screen with colorful terminal banner, Docker workspace status, and chat input panel" width="960" />
</p>

## Pourquoi ce projet existe

La plupart des outils d’agents sont soit une boîte de chat à état caché, soit une boucle coûteuse à modèle unique. AgInTiFlow repose sur une autre philosophie :

| Principe | Effet concret |
| --- | --- |
| L’intelligence bon marché change l’architecture | DeepSeek V4 Flash et Pro rendent réaliste l’usage d’appels supplémentaires pour routing, scouts, review et recovery, au lieu de tout forcer dans un appel coûteux. |
| Inspectable plutôt que mystérieux | Plans, appels d’outils, diffs de fichiers, sorties de commandes, artifacts canvas et événements de session sont sauvegardés et reprenables. |
| Modèles par rôles | Route, main, spare, wrapper et auxiliary image sont séparés. On peut combiner route models bon marché, main models plus puissants, routes OpenAI/Qwen/Venice et outils image GRS AI/Venice. |
| Scouts avant gros travail | Des scouts parallèles cartographient architecture, tests, risques, symboles et points d’intégration avant que l’exécuteur principal modifie les fichiers. |
| SCS pour le travail risqué | Student-Committee-Supervisor ajoute une porte typée : committee rédige, student approuve/surveille, supervisor exécute. Utilisez `/scs` ou `--scs auto`. |
| AAPS pour grands workflows | AAPS décrit des scripts de pipeline agentic top-down ; AgInTiFlow peut servir de backend interactif pour les valider, compiler et exécuter. |
| Sécurité locale par défaut | Docker workspace, garde-fous de chemins, redaction des secrets, blocage de npm publish/token et logs visibles gardent l’agent pratique sans opacité. |

## Démarrage rapide

Installez et ouvrez un projet :

```bash
npm install -g @lazyingart/agintiflow
cd /path/to/your-project
aginti init
aginti
```

Au premier usage interactif, si aucune clé de modèle principal n’est trouvée, AgInTiFlow ouvre un assistant d’authentification. Choisissez DeepSeek, OpenAI, Qwen ou Venice, collez la clé, et elle sera sauvegardée dans `.aginti/.env`, ignoré par git, avec permissions restreintes. Vous pouvez relancer la configuration à tout moment :

```bash
aginti auth
aginti auth deepseek
aginti auth venice
aginti login grsai
```

Lancez l’interface Web depuis le même projet :

```bash
aginti web --port 3210
# open http://127.0.0.1:3210
```

Lancez un smoke test sans identifiants de modèle réel :

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke-test note"
```

Définissez explicitement la langue, ou omettez-la pour suivre la locale système :

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language de
```

## Commandes quotidiennes

| Objectif | Commande |
| --- | --- |
| Démarrer le chat interactif | `aginti` ou `aginti chat` |
| Démarrer l’app Web locale | `aginti web --port 3210` |
| Sauvegarder les clés provider | `aginti auth`, `/auth`, `/login` |
| Relire le repo courant | `/review [focus]` |
| Activer/désactiver la porte SCS | `/scs` |
| Utiliser SCS seulement pour le complexe | `/scs auto` ou `aginti --scs auto "task"` |
| Travailler avec AAPS | `aginti aaps status`, `/aaps validate` |
| Choisir les modèles | `/route`, `/model`, `/spare`, `/wrapper`, `/auxiliary model` |
| Activer le raccourci Venice | `/venice` |
| Générer des images | `/auxiliary image`, puis demandez une image |
| Reprendre le projet courant | `aginti resume` |
| Parcourir toutes les sessions | `aginti resume --all-sessions` |
| Mettre en file dans une session active | `aginti queue <session-id> "extra instruction"` |
| Nettoyer les sessions vides | `aginti --remove-empty-sessions` |
| Vérifier les capacités | `aginti capabilities`, `aginti doctor --capabilities` |
| Synchroniser les skills revues | `aginti skillmesh status`, `aginti skillmesh sync` |
| Mettre à jour la CLI | `aginti update` |

Le chat interactif prend en charge la complétion slash, les sélecteurs Up/Down, l’entrée multilignes avec `Ctrl+J`, l’historique complet de reprise, le rendu Markdown, l’état visible d’exécution, les messages ASAP pipe pendant un run et l’interruption/reprise propre avec `Ctrl+C`. Les commandes interactives installées vérifient aussi npm pour une nouvelle version d’AgInTiFlow et affichent un sélecteur update/skip ; les checkouts source et automatisations non-TTY ne sont pas perturbés.

Pour une reprise one-shot entièrement contrôlée, utilisez un session id explicite et choisissez le profil de tâche volontairement. Utilisez `auto` pour le routing normal ou `android` pour le travail Android/émulateur :

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

## Captures réelles

| Lancement CLI | Vue Web |
| --- | --- |
| <img src="../demos/agintiflow-cli-launch.jpg" alt="AgInTiFlow CLI launch" width="480" /> | <img src="../website/assets/screenshots/app-overview.jpg" alt="AgInTiFlow web app overview" width="480" /> |

| Contrôles de tâche | Sortie runtime |
| --- | --- |
| <img src="../website/assets/screenshots/task-controls.jpg" alt="AgInTiFlow task controls" width="480" /> | <img src="../website/assets/screenshots/run-output.jpg" alt="AgInTiFlow runtime output" width="480" /> |

| Historique de conversation | État sandbox |
| --- | --- |
| <img src="../website/assets/screenshots/conversation-history.jpg" alt="AgInTiFlow conversation history" width="480" /> | <img src="../website/assets/screenshots/sandbox-status.jpg" alt="AgInTiFlow sandbox status" width="480" /> |

| Vue mobile |
| --- |
| <img src="../website/assets/screenshots/mobile-overview.jpg" alt="AgInTiFlow mobile overview" width="480" /> |

Les anciennes captures de lancement sont conservées dans le dépôt source sous [demos/archive/](https://github.com/lazyingart/AgInTiFlow/tree/main/demos/archive).

## Capacités principales

| Capacité | Ce que fournit AgInTiFlow |
| --- | --- |
| Workspace agent CLI | Chat terminal persistant avec cwd du projet, reprise de session, état modèle/outil visible et indices de commande propres. |
| Workspace Web local | UI navigateur pour sessions, logs runtime, artifacts, réglages de modèles, contrôles projet, previews canvas et état sandbox. |
| File tools | `inspect_project`, `list_files`, `read_file`, `search_files`, `write_file`, `apply_patch`, `open_workspace_file`, `preview_workspace`. |
| Shell tools | Exécution shell protégée en host ou Docker workspace avec politique d’installation et contrôles de commande. |
| Browser tools | Actions Playwright avec démarrage paresseux et allowlists de domaines optionnelles. |
| Model routing | Defaults DeepSeek fast/pro, routes manuelles OpenAI/Qwen/Venice/mock, spare models, wrapper models et auxiliary image models. |
| Patch workflow | Enveloppes patch style Codex, unified diffs, remplacements exacts, hashes, diffs compacts et garde-fous de chemin. |
| Parallel scouts | Appels scout optionnels pour architecture, implémentation, review, tests, git flow, recherche, symbol tracing et risques dépendances. |
| SCS mode | Porte qualité optionnelle Student-Committee-Supervisor pour tâches complexes ou risquées. |
| AAPS adapter | Intégration optionnelle `@lazyingart/aaps` pour init, validate, parse, compile, dry-run et run de workflows `.aaps`. |
| Image generation | Outils optionnels GRS AI et Venice avec manifests sauvegardés et previews canvas. |
| Skill library | Skills Markdown intégrées pour code, sites, Android/iOS, Python, Rust, Java, LaTeX, rédaction, reviews, GitHub, AAPS, etc. |
| Skill Mesh | Enregistrement/partage strict optionnel de packs de skills réutilisables et revus. Sans usage, AgInTiFlow fonctionne normalement sans partage en arrière-plan. |
| UI multilingue | CLI et docs en anglais, japonais, chinois simplifié/traditionnel, coréen, français, espagnol, arabe, vietnamien, allemand et russe. |

## Modèles et rôles

AgInTiFlow ne traite pas “le modèle” comme un seul réglage global. Il y a des rôles :

| Rôle | Défaut | Usage |
| --- | --- | --- |
| Route | `deepseek/deepseek-v4-flash` | Planification peu coûteuse, triage, tâches courtes, décisions de routing. |
| Main | `deepseek/deepseek-v4-pro` | Coding complexe, debugging, rédaction, recherche, longues tâches. |
| Spare | `openai/gpt-5.4` medium | Fallback optionnel ou route de cross-check. |
| Wrapper | `codex/gpt-5.5` medium | Conseiller externe optionnel de coding-agent. |
| Auxiliary | `grsai/nano-banana-2` | Génération d’images et autres outils non textuels. |

Sélecteurs utiles :

```text
/models
/route
/model
/spare
/wrapper
/auxiliary model
/venice
```

Les routes Venice peuvent servir aux travaux créatifs optionnels uncensored ou moins restreints. DeepSeek reste le défaut économique pour les workflows d’ingénierie normaux. Voir [../docs/model-selection.md](../docs/model-selection.md) et [../references/venice-model-reference.md](../references/venice-model-reference.md).

## AAPS et grands workflows

AAPS est la couche pipeline-script ; AgInTiFlow est le backend interactif agent/outils.

```bash
aginti aaps status
aginti aaps init "Project Workflow"
aginti aaps validate
aginti aaps compile check
```

Dans le chat :

```text
/aaps on
/aaps validate
/aaps dry-run workflows/main.aaps
```

Utilisez AAPS quand la tâche dépasse un chat : développement d’apps en étapes, workflows papier/livre, portes de validation, étapes de reprise, production d’artifacts ou scripts agentic top-down. Voir [../docs/aaps.md](../docs/aaps.md) et le package [https://www.npmjs.com/package/@lazyingart/aaps](https://www.npmjs.com/package/@lazyingart/aaps).

## Référence rapide API locale

L’app Web expose des APIs locales pour l’UI et l’automatisation. Ces endpoints rapportent l’état sans exposer les API keys brutes ni les npm tokens :

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

Lancer le smoke test API sans credentials :

```bash
npm run smoke:web-api
```

## Stockage, sécurité et reprise

AgInTiFlow stocke les sessions canoniques au centre et ne garde que des pointeurs locaux côté projet :

| Emplacement | Rôle |
| --- | --- |
| `~/.agintiflow/sessions/<session-id>/` | État canonique, événements, état navigateur, artifacts, snapshots, fichiers canvas. |
| `<project>/.aginti-sessions/` | Pointeurs de session locaux et base Web UI. Ignoré par git. |
| `<project>/.aginti/.env` | API keys optionnelles locales au projet, permissions restreintes. Ignoré par git. |
| `<project>/AGINTI.md` | Instructions projet éditables et préférences locales durables. Commit possible s’il n’y a pas de secrets. |

Défauts de sécurité :

- Docker workspace mode est le défaut normal CLI/Web pour le coding pratique et la génération d’artifacts.
- Les file tools bloquent chemins ressemblant à des secrets, `.env`, `.git`, écritures `node_modules`, échappements absolus, fichiers énormes et édition binaire.
- Les shell commands sont vérifiées par policy ; npm publish, npm token commands, sudo, git destructif et lectures de credentials sont bloqués.
- Les écritures de fichiers enregistrent hashes et diffs compacts.
- Les appels d’outils et résultats sont loggés dans des événements de session structurés.
- Web et CLI utilisent le même session store, donc un run peut être inspecté et repris plus tard.

Notes runtime détaillées : [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md), [../docs/patch-tools.md](../docs/patch-tools.md), [../docs/agent-runtime-pipe.md](../docs/agent-runtime-pipe.md).

## Configuration

Variables d’environnement courantes :

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

Clés locales au projet :

```bash
aginti init
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

Plus de détails :

- [../docs/model-selection.md](../docs/model-selection.md)
- [../docs/auxiliary-image-generation.md](../docs/auxiliary-image-generation.md)
- [../docs/cli-i18n.md](../docs/cli-i18n.md)
- [../docs/skillmesh.md](../docs/skillmesh.md)

## Carte de documentation

| Sujet | Lien |
| --- | --- |
| AAPS adapter | [../docs/aaps.md](../docs/aaps.md) |
| Sélection des modèles et rôles | [../docs/model-selection.md](../docs/model-selection.md) |
| SCS mode | [../docs/student-committee-supervisor.md](../docs/student-committee-supervisor.md) |
| Ingénierie de grandes codebases | [../docs/large-codebase-engineering.md](../docs/large-codebase-engineering.md) |
| Runtime modes et autonomie | [../docs/runtime-modes-and-autonomy.md](../docs/runtime-modes-and-autonomy.md) |
| Skills et outils | [../docs/skills-and-tools.md](../docs/skills-and-tools.md) |
| Skill Mesh | [../docs/skillmesh.md](../docs/skillmesh.md) |
| Housekeeping logs | [../docs/housekeeping.md](../docs/housekeeping.md) |
| Publication npm | [../docs/npm-publishing.md](../docs/npm-publishing.md) |
| Roadmap produit | [../docs/productive-agent-roadmap.md](../docs/productive-agent-roadmap.md) |
| Curriculum de capacités supervisées | [../docs/supervised-capability-curriculum.md](../docs/supervised-capability-curriculum.md) |
| Ancien README complet | [../references/notes/readme-full-reference-2026-05-05.md](../references/notes/readme-full-reference-2026-05-05.md) |

## Développement

Exécuter depuis les sources :

```bash
git clone https://github.com/lazyingart/AgInTiFlow.git
cd AgInTiFlow
npm install
npx playwright install chromium
npm run check
npm test
```

Démarrer le Web local depuis les sources :

```bash
npm run web
# open http://127.0.0.1:3210
```

Smoke checks utiles :

```bash
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:aaps-adapter
npm run smoke:cli-chat
npm run smoke:toolchain-docker
```

Les smoke scripts utilisent le provider mock local sauf s’ils sont explicitement marqués comme tests real-provider.

## Notes de release

AgInTiFlow est publié sous `@lazyingart/agintiflow`. Le chemin recommandé est GitHub Actions Trusted Publishing avec npm provenance. La publication locale par token n’est qu’un fallback de bootstrap et ne doit jamais commiter `.env`, `.npmrc`, npm tokens, OTPs ou debug logs.

Voir [../docs/npm-publishing.md](../docs/npm-publishing.md) pour le workflow complet.

## Soutien

Si ce projet vous est utile, vous pouvez soutenir son développement ici :

| Soutien | URL |
| --- | --- |
| GitHub Sponsors: LazyingArt | [https://github.com/sponsors/lazyingart](https://github.com/sponsors/lazyingart) |
| GitHub Sponsors: Lachlan Chen | [https://github.com/sponsors/lachlanchen](https://github.com/sponsors/lachlanchen) |
| LazyingArt | [https://lazying.art](https://lazying.art) |
| Chat | [https://chat.lazying.art](https://chat.lazying.art) |
| OnlyIdeas | [https://onlyideas.art](https://onlyideas.art) |

AgInTiFlow est développé par AgInTi Lab, LazyingArt LLC.
