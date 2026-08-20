---
id: data-analysis
label: Data Analysis And ETL
description: Clean, analyze, transform, validate, visualize, and report on datasets using reproducible scripts and durable artifacts.
triggers:
  - data
  - csv
  - dataset
  - dataframe
  - pandas
  - analysis
  - etl
  - chart
  - plot
  - visualization
tools:
  - inspect_project
  - read_file
  - write_file
  - apply_patch
  - run_command
  - send_to_canvas
---
# Data Analysis And ETL

Preserve raw/source/input exports as immutable evidence unless the user explicitly authorizes an in-place source change. Start with `inspect_project`, then read project instructions plus the relevant existing analyzer, configuration, and tests before editing or running ad hoc calculations. Inspect schemas, row counts, missing values, duplicate rows, units, aliases, time zones, and suspicious outliers before writing conclusions.

Prefer the project's existing reproducible analyzer over one-off chat math; repair or extend it when needed. Save cleaned data, plots, and reports at the exact declared output paths. Keep machine outputs separate from raw inputs and make the report explain methods, evidence, limitations, and the practical result.

After an edit or patch conflict, reread the exact target and error before choosing a different bounded repair. Never repeat an unchanged failing patch. Rerun the smallest relevant check, then the full analysis and project tests. Verify cleaned schemas and row counts, inspect plot metadata or pixels, remove only generated caches, and do not claim success until every requested artifact exists and can be regenerated.
