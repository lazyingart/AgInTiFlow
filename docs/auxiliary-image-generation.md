# Auxiliary Image Generation

AgInTiFlow separates **skills** from **tools**:

- A skill is instruction and routing context that teaches the agent when a capability is useful.
- A tool is the deterministic callable function that performs the action and writes auditable artifacts.

The optional image-generation skills are `image_generation` and `venice_image_generation`. Both use the deterministic `generate_image` tool.

## Setup

Store a GRS AI or Venice key project-locally:

```bash
aginti login grsai
aginti login venice
# or
printf '%s' "$GRSAI" | aginti keys set grsai --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

Inside interactive chat, use either spelling:

```text
/auxiliary grsai
```

Keys are saved in `.aginti/.env` as `GRSAI` or `VENICE_API_KEY` with `0600` permissions. The CLI and web app only report whether a key exists; they never return raw values.

## Runtime Flow

For image, cover, poster, illustration, photo, or logo-concept requests, the model can call:

```json
{
  "prompt": "A polished cyan robot painting a circuit-board river, high-end product illustration",
  "provider": "venice",
  "model": "nano-banana-2",
  "outputDir": "artifacts/images/robot-cover",
  "outputStem": "robot-cover",
  "aspectRatio": "1:1",
  "imageSize": "2K"
}
```

With GRS AI, the tool uses the Nano Banana API:

- `POST https://grsaiapi.com/v1/draw/nano-banana`
- `POST https://grsaiapi.com/v1/draw/result`
- `Authorization: Bearer <GRSAI>`

With Venice, the tool uses the image-generation API:

- `POST https://api.venice.ai/api/v1/image/generate`
- `Authorization: Bearer <VENICE_API_KEY>`
- image models such as `nano-banana-2`, `gpt-image-2`, `qwen-image-2`, `wan-2-7-text-to-image`, `bria-bg-remover`, and `venice-sd35`

Saved workspace artifacts:

- `prompt.txt`
- `request_payload.redacted.json`
- `submit_response.json`
- `result_response.json`
- `venice_result_response.json` for Venice image calls
- `task_manifest.json`
- generated image files, for example `image.png`

Generated images are sent to the canvas automatically when available.

## Guardrails

Output paths must stay inside the project workspace. Secret paths, `.git`, `node_modules` writes, and oversized reference images are blocked. Reference images may be workspace files, HTTPS URLs, or data URLs.
