# Auxiliary Image Generation

AgInTiFlow separates **skills** from **tools**:

- A skill is instruction and routing context that teaches the agent when a capability is useful.
- A tool is the deterministic callable function that performs the action and writes auditable artifacts.

The optional image-generation skills are `image_generation` and `venice_image_generation`. Both use the deterministic `generate_image` tool.

Hosted image generation is off by default. Enable the auxiliary mode explicitly with `/auxiliary on`, `/auxiliary image`, the corresponding UI toggle, or `allowAuxiliaryTools=true`. Merely storing `GRSAI` or `VENICE_API_KEY` does not expose or authorize `generate_image` in an agent run.

`generate_image` is a raster-image tool. It does not produce true SVG/vector output. If a caller requests `svg`, the tool records
`requestedFormat: "svg"`, generates a PNG fallback with `actualFormat: "png"`, and returns a `formatNotice`. If the task truly requires
editable vectors, use AgInTiFlow file tools to write deterministic SVG/LaTeX/HTML instead of calling `generate_image`.

## Setup

Store a GRS AI or Venice image key account-wide:

```bash
aginti login grsai
aginti login venice
# or
printf '%s' "$GRSAI" | aginti keys set grsai --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set --project venice --stdin  # optional project override
```

Inside interactive chat, use either spelling:

```text
/auxiliary grsai
```

Keys are saved in `~/.agintiflow/.env` by default as `GRSAI` or `VENICE_API_KEY` with `0600` permissions. Project `.aginti/.env` can override them. The CLI and web app only report whether a key exists; they never return raw values.

Provider selection is independent of key discovery. The selected auxiliary provider remains GRS AI or Venice for the whole call. If its key is missing or the request fails, the tool stops visibly; it never switches to the other provider because that provider's ambient key happens to exist. When no provider is selected, the deterministic default is GRS AI.

## Runtime Flow

For image, cover, poster, illustration, photo, or logo-concept requests, the model can call:

```json
{
  "prompt": "A polished cyan robot painting a circuit-board river, high-end product illustration",
  "provider": "venice",
  "model": "nano-banana-2",
  "outputDir": "artifacts/images/robot-cover",
  "outputStem": "robot-cover",
  "format": "png",
  "aspectRatio": "1:1",
  "imageSize": "2K"
}
```

For trusted local apps that need image generation without routing through a language-model run, the web server exposes a deterministic endpoint:

```bash
curl -sS http://127.0.0.1:3210/api/auxiliary/generate-image \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "A polished cyan robot painting a circuit-board river",
    "provider": "venice",
    "format": "svg",
    "outputDir": "artifacts/images/robot-cover",
    "outputStem": "robot-cover"
  }'
```

This endpoint is intended for trusted local/server-side callers. Browser apps on another origin should use an explicit adapter/proxy
rather than relying on permissive CORS, because generation can consume API keys and write workspace artifacts.

That SVG request returns a PNG fallback contract rather than pretending SVG was generated:

```json
{
  "requestedFormat": "svg",
  "actualFormat": "png",
  "formatNotice": "SVG/vector output is not supported by generate_image. A raster PNG is generated instead."
}
```

The CLI exposes the same direct path for shell scripts and other local apps:

```bash
aginti image --json --dry-run \
  --provider venice \
  --format svg \
  --output-dir artifacts/images/robot-cover \
  --output-stem cover.svg \
  "A cyan robot painting a poster, clean product illustration"
```

`aginti image ...` returns the same `requestedFormat`, `actualFormat`, and `formatNotice` fields as the web API. Use this direct CLI when
an app needs a deterministic tool call. Use `aginti --image "..."` when the user wants an agent-mediated image task that may plan, inspect
references, create files, or send artifacts to the canvas.

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

The mode gate is enforced inside `generate_image` as well as in progressive tool exposure, so a handcrafted model tool call cannot bypass a disabled auxiliary mode.
