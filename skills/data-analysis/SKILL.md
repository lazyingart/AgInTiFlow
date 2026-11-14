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

Inspect inputs and existing code. For a requested rerunnable analyzer/checker,
create or extend the workspace program with file tools, then run its permitted
project entry. Preserve raw inputs unless explicitly asked to edit them. Check
outputs against current inputs; a read-only hash guard compares before/after
within each invocation, not a permanent past-source hash. Preserve independent
test expectations. Avoid preliminary inline programs; do not disguise denied
commands or elevate privileges.

Inspect source schema, row counts, missing values, duplicates, units, time zones
and outliers before conclusions. On a source refresh, regenerate every affected
output from the latest source and rerun semantic checks. A fixed golden fixture
is authoritative only when the task or existing project explicitly defines it;
never change an independent oracle merely to make a failed check pass.

Prefer the project's existing reproducible analyzer over one-off chat math; repair or extend it when needed. Save cleaned data, plots, and reports at the exact declared output paths. Keep machine outputs separate from raw inputs and make the report explain methods, evidence, limitations, and the practical result.

After an edit or patch conflict, reread the exact target and error before choosing a different bounded repair. Never repeat an unchanged failing patch. Rerun the smallest relevant check, then the full analysis and project tests. Verify cleaned schemas and row counts, inspect plot metadata or pixels, remove only generated caches, and do not claim success until every requested artifact exists and can be regenerated.
