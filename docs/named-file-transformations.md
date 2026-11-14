# Named file transformations

Requests such as “tidy readings.csv into brief.md and brief.json” bind the CSV
as an input and both named files as outputs. “Clean … into …” follows the same
bounded source-to-output grammar as “turn”, “convert”, and “transform”. A request
may describe a named destination as a JSON list or CSV table.

AgInTi rejects completion while a required output is missing or only stale
pre-existing evidence is available. “Leave readings.csv alone” preserves that
input; it does not request another output. A completed-task continuation keeps
its saved result, while a new named transformation requires fresh evidence.

A transformation input keeps its explicit preservation rule even when a
destination names the same file through a relative path alias. Synthetic
creation syntax grants no permission to overwrite that input. Choose a separate
destination or clarify the requested edit when those instructions conflict.
Genuinely new destinations can still be created and then preserved.
With exactly one named input, “leave the source and earlier outputs unchanged”
also protects that input. This does not infer historical output filenames;
name those files explicitly when their machine-enforced identity matters.
If completion is attempted before the new files exist, recovery keeps their
creation path available. It does not demand a patch to an unrelated earlier
artifact. Genuine source-quality and producer repairs retain their own gates.

Quoted examples, explanations, hypothetical transformations, and prohibitions
grant no new transformation authority. These rules do not relax workspace path,
tool, shell, or package-install permissions. They do not prove arbitrary data
fidelity or discover every unnamed deliverable; inspect important outputs and
name required files when their identity matters.
