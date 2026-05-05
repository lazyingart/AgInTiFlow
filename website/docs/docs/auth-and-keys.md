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

## Provider Key Sources

| Provider | Register / key page | API base URL |
| --- | --- | --- |
| DeepSeek | [https://platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | `https://api.deepseek.com` |
| Venice | [https://venice.ai/settings/api](https://venice.ai/settings/api) | `https://api.venice.ai/api/v1` |
| OpenAI | [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `https://api.openai.com/v1` |
| Qwen / DashScope | [https://bailian.console.aliyun.com/](https://bailian.console.aliyun.com/) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| GRS AI image tools | [https://grsai.ai/dashboard/api-keys](https://grsai.ai/dashboard/api-keys) | Configure with `/auxiliary grsai` or `aginti login grsai`. |

DeepSeek is the default low-cost text route. Venice is useful for optional uncensored text routes and Venice image routes. OpenAI is useful as a spare, wrapper, or explicit main provider. GRS AI is auxiliary-only in AgInTiFlow and is mainly used for image generation.

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
