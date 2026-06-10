# Bug Report: Image Generation Reference Upload Works, but Help, Failure Diagnostics, and Mask Geometry Are Weak

## Summary

`aginti image --reference` works for reference-image generation with GRS AI / Nano Banana, but the workflow has several rough edges when used for scientific image-mask generation:

- `aginti image --help` prints the global CLI usage instead of the direct image-generation usage that documents `--reference`.
- A provider failure is surfaced only as a generic CLI error, while the useful provider reason is left in `result_response.json`.
- The failed task manifest does not record `failure_reason` or a provider error summary.
- Generated reference-image masks do not preserve the source-image geometry, even when the prompt asks for a same-size binary mask.

These are not blockers for general image generation, but they are important for image-to-mask workflows where users need reproducible dimensions and actionable failure messages.

## Environment

- Repo under test: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`
- Version in `package.json`: `0.20.195`
- Installed CLI path:

```bash
/home/lachlan/.nvm/versions/node/v22.21.0/lib/node_modules/@lazyingart/agintiflow/bin/aginti-cli.js
```

- Downstream project where the issue was observed:

```text
/home/lachlan/ProjectsLFS/OrganoidCompactnessAnalysis
```

- Task: use Nano Banana through AgInTi to generate binary masks for faint neurite-like structures from uploaded microscopy reference images.

## Reproduction

From the microscopy project root:

```bash
PKG="outputs/neurite_outgrowth_full_analysis/ai_mask_prompt_package_2026-06-10"
REF="$PKG/image_model_inputs/conditional_medium_10x-2_core_removed_outskirt_input.png"
PROMPT="$PKG/prompts/conditional_medium_10x-2_nanobanana_mask_prompt.txt"

cat "$PROMPT" | aginti image --json \
  --provider grsai \
  --reference "$REF" \
  --format png \
  --aspect-ratio 4:3 \
  --image-size 1536x1024 \
  --output-dir "$PKG/aginti_nanobanana_generation/conditional_medium_10x-2" \
  --output-stem conditional_medium_10x-2_generated_mask \
  --stdin
```

Also compare help output:

```bash
aginti image --help
```

## Observed Behavior

### 1. `aginti image --help` hides `--reference`

Observed output begins with the global CLI usage:

```text
Usage: aginti [chat] OR aginti init ... OR aginti image [--json] [--dry-run] [--format png|webp|svg] "prompt" ...
```

It does not show the more complete direct image usage that exists in `src/cli.js`:

```text
Usage: aginti image [generate] [--json] [--dry-run] [--provider grsai|venice] ... [--reference path-or-url] "prompt"
```

This led to a mistaken interpretation that direct image generation did not support uploaded/reference images.

### 2. CLI summary hides provider failure reason

The failed command returned:

```json
{
  "ok": false,
  "error": "Image generation failed with status failed. See /home/lachlan/ProjectsLFS/OrganoidCompactnessAnalysis/outputs/neurite_outgrowth_full_analysis/ai_mask_prompt_package_2026-06-10/aginti_nanobanana_generation/conditional_medium_10x-2/task_manifest.json."
}
```

But the useful diagnostic was only in `result_response.json`:

```json
{
  "data": {
    "failure_reason": "output_moderation",
    "error": "To extract the precise, low-contrast neurTo extract the precise, low-contrast neurite outgrowths ... **Hessian-based ridge detection filter ...",
    "status": "failed"
  }
}
```

The `task_manifest.json` only recorded:

```json
{
  "status": "failed",
  "taskId": "16-1a4e75a3-f089-4cc9-8d05-87daf0c9dd58"
}
```

It did not include `failure_reason`, provider error text, or a redacted/short failure summary.

### 3. Reference-image mask geometry is not preserved

All uploaded reference images were:

```text
1440 x 1024
```

Generated masks had different sizes:

```text
AD_10x-6_generated_mask.png                  1200 x 896
conditional_medium_10x-2_generated_mask.png  1200 x 896
control_10x-18_generated_mask.png            1215 x 864
msc_treatment_10x-16_generated_mask.png      1215 x 864
```

The downstream workflow had to resize masks back to the source image size before overlaying and measuring them.

## Expected Behavior

### Help

`aginti image --help` should print direct image-generation usage, including:

- `--reference`
- `--provider grsai|venice`
- `--output-dir`
- `--output-stem`
- `--image-size`
- `--aspect-ratio`
- `--stdin`

### Failure Diagnostics

When the provider returns `status: failed`, AgInTi should:

- print a concise reason in CLI JSON and non-JSON output;
- add `failureReason` and `providerErrorSummary` to `task_manifest.json`;
- link to `result_response.json` as supporting detail;
- redact overly long provider messages, but do not hide the diagnostic category.

For the observed failure, the user-facing error should have included at least:

```text
Image generation failed: output_moderation
```

### Geometry / Mask Workflow

For reference-image tasks, especially masks, AgInTi should either:

- warn that generated output dimensions may differ from the reference image; or
- provide an option such as `--match-reference-size` that postprocesses generated images back to the first reference image dimensions; or
- record source dimensions and output dimensions in the manifest.

This would make mask-overlay workflows less error-prone.

## Workaround Used

The scientific workflow worked after:

1. using `aginti image --reference` with the microscopy input image;
2. retrying the failed prompt with a shorter prompt and `--image-size 1K`;
3. resizing generated masks to the original image dimensions in downstream Python code;
4. overlaying generated masks and skeletons on the original brightfield image for manual QC.

Final output folder:

```text
/home/lachlan/ProjectsLFS/OrganoidCompactnessAnalysis/outputs/neurite_outgrowth_full_analysis/ai_mask_prompt_package_2026-06-10/
```

## Suggested Fix

1. Route `aginti image --help` and `aginti image generate --help` to `printImageCommandUsage()`.
2. In `generateImage()`, when provider polling returns failed status, copy provider `failure_reason` and a short redacted `error` string into:
   - the thrown error message;
   - the returned JSON object;
   - `task_manifest.json`.
3. Record reference image dimensions and generated output dimensions in `task_manifest.json`.
4. Consider an opt-in postprocessing flag:

```bash
aginti image --reference input.png --match-reference-size ...
```

This can be implemented without changing provider behavior by resizing the downloaded result after generation.

