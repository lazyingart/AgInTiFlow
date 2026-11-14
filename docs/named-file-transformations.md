# Named file transformations

Requests such as “tidy readings.csv into brief.md and brief.json” bind the CSV
as an input and both named files as outputs. “Clean … into …” follows the same
bounded source-to-output grammar as “turn”, “convert”, and “transform”. A request
may describe a named destination as a JSON list or CSV table.

AgInTi rejects completion while a required output is missing or only stale
pre-existing evidence is available. “Leave readings.csv alone” preserves that
input; it does not request another output. A completed-task continuation keeps
its saved result, while a new named transformation requires fresh evidence.

Quoted examples, explanations, hypothetical transformations, and prohibitions
grant no new transformation authority. These rules do not relax workspace path,
tool, shell, or package-install permissions. They do not prove arbitrary data
fidelity or discover every unnamed deliverable; inspect important outputs and
name required files when their identity matters.
