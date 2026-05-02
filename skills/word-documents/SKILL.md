---
id: word-documents
label: Microsoft Word Documents
description: Edit, convert, inspect, or generate Word-style documents using available local tools.
triggers:
  - word
  - docx
  - microsoft word
  - office
  - pandoc
  - libreoffice
tools:
  - read_file
  - write_file
  - run_command
  - send_to_canvas
---
# Microsoft Word Documents

Prefer safe conversions through available tools such as `pandoc`, `libreoffice`, or Python libraries when installed. Preserve originals; write converted or edited outputs to a new file unless overwrite is explicit.

If binary `.docx` content cannot be inspected directly, explain the needed converter and create a project-local script or setup note.
