---
id: image-generation
label: Image Generation
description: Generate or edit raster images, posters, covers, logos, illustrations, and visual assets.
triggers:
  - image
  - logo
  - poster
  - cover
  - illustration
  - nanobanana
  - grsai
  - gpt image
tools:
  - generate_image
  - write_file
  - send_to_canvas
---
# Image Generation

Use image generation when the user asks for a raster visual asset or prompt. Write a concise prompt with subject, style, composition, color, lighting, and output constraints.

Prefer `generate_image` when a GRS AI key is available. Save selected outputs under artifacts and send the chosen image to canvas.
