# CLI And App Language

AgInTiFlow supports a shared language preference for the interactive CLI, one-shot CLI runs, web defaults, and model prompt context.

## Supported Canonical Languages

| Canonical | Language | Common aliases |
| --- | --- |
| `en` | English | `english` |
| `ja` | Japanese | `jp`, `japanese` |
| `zh-Hans` | Simplified Chinese | `zh-s`, `zh s`, `cn`, `cn-s`, `cn s`, `zh-cn`, `simplified` |
| `zh-Hant` | Traditional Chinese | `zh-t`, `zh t`, `cn-t`, `cn t`, `zh-tw`, `zh-hk`, `traditional` |
| `ko` | Korean | `korean` |
| `fr` | French | `french` |
| `es` | Spanish | `spanish` |
| `ar` | Arabic | `arabic` |
| `vi` | Vietnamese | `vietnamese` |
| `de` | German | `deutsch`, `german` |
| `ru` | Russian | `russian` |

## Defaults

If no language is passed, AgInTiFlow follows the system language from:

```text
AGINTI_LANGUAGE -> LANGUAGE -> LC_ALL -> LC_MESSAGES -> LANG
```

If none of those map to a supported locale, English is used.

## CLI Usage

Start the interactive CLI in a specific language:

```bash
aginti --language ja
aginti --language zh-Hans
aginti --language zh-Hant
aginti --language ko
aginti --language fr
aginti --language es
aginti --language ar
aginti --language vi
aginti --language de
aginti --language ru
```

Inside interactive chat:

```text
/language
/language auto
/language en
/language ja
/language zh-Hans
/language zh-Hant
/language ko
```

`/lang` is an alias for `/language`.

One-shot tasks also accept the same option:

```bash
aginti --language zh-Hans "list files and summarize this project"
```

The selected language localizes the launch banner subtitle, prompt hint, help text, status labels, and language status. It also adds language guidance to the model context so the assistant usually replies in the selected UI language unless the user asks for another language.

## Web App

The web app already has an 11-language dropdown. Launching web with a language seeds the project-local default:

```bash
aginti web --language de --port 3210
```

The web preference is stored in the project-local `.aginti-sessions/web-state.sqlite` database, so the CLI and web app can share sessions while each frontend keeps its own UI controls.

## Notes

- `zh-Hans` and `zh-Hant` are the canonical Chinese values. `zh-s`, `zh-t`, `cn-s`, `cn-t`, `cn s`, and `cn t` remain compatibility aliases.
- API keys and `.aginti/.env` values are never translated, printed, or exposed through the language system.
- Model output language is guidance, not a hard safety filter. If the user asks in a different language or explicitly requests another output language, the model should follow that request.
