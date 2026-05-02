# Auth and Keys

AgInTiFlow supports local provider keys without committing secrets.

## Interactive Auth

```bash
aginti auth
aginti login
aginti auth openai
aginti auth qwen
aginti auth grsai
```

The prompt shows a tidy input box. If a key already exists, the input displays a masked preview such as:

```text
sk-a...wxyz (48 chars)
```

The existing key is selected. Type to replace it, press Enter or Esc to keep it.

## Key Sources

| Provider | Key Page |
| --- | --- |
| DeepSeek | `https://platform.deepseek.com/api_keys` |
| OpenAI | `https://platform.openai.com/api-keys` |
| Qwen | Use your Qwen-compatible API key source. |
| GRS AI | Optional image-generation auxiliary provider. |

## Storage

Keys are saved in:

```text
.aginti/.env
```

The file is ignored by git and written with local-only permissions where the platform supports it.

## Safe Status

```bash
aginti keys status
```

Status output reports availability only. It never prints raw key values.

## Noninteractive Setup

```bash
printf '%s' "$DEEPSEEK_API_KEY" | aginti keys set deepseek --stdin
printf '%s' "$OPENAI_API_KEY" | aginti keys set openai --stdin
```
