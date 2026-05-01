# Auxiliary Image Generation

AgInTiFlow separates **skills** from **tools**:

- A skill is instruction and routing context that teaches the agent when a capability is useful.
- A tool is the deterministic callable function that performs the action and writes auditable artifacts.

The optional image-generation skill is `image_generation`. Its tool is `generate_image`.

## Setup

Store the GRS AI key project-locally:

```bash
aginti login grsai
# or
printf '%s' "$GRSAI" | aginti keys set grsai --stdin
```

Inside interactive chat, use either spelling:

```text
/auxilliary grsai
/auxiliary grsai
```

The key is saved in `.aginti/.env` as `GRSAI` with `0600` permissions. The CLI and web app only report whether the key exists; they never return the raw value.

## Runtime Flow

For image, cover, poster, illustration, photo, or logo-concept requests, the model can call:

```json
{
  "prompt": "A polished cyan robot painting a circuit-board river, high-end product illustration",
  "outputDir": "artifacts/images/robot-cover",
  "outputStem": "robot-cover",
  "aspectRatio": "1:1",
  "imageSize": "2K"
}
```

The tool uses the GRS AI Nano Banana API:

- `POST https://grsaiapi.com/v1/draw/nano-banana`
- `POST https://grsaiapi.com/v1/draw/result`
- `Authorization: Bearer <GRSAI>`

Saved workspace artifacts:

- `prompt.txt`
- `request_payload.redacted.json`
- `submit_response.json`
- `result_response.json`
- `task_manifest.json`
- generated image files, for example `image.png`

Generated images are sent to the canvas automatically when available.

## Guardrails

Output paths must stay inside the project workspace. Secret paths, `.git`, `node_modules` writes, and oversized reference images are blocked. Reference images may be workspace files, HTTPS URLs, or data URLs.
