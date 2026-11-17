# Preserved inputs and requested outputs

Coding requests often name both files to change and files to preserve:

```text
Update src/parser.mjs. Write tests in test/parser.test.mjs.
Keep README.md, package.json and other files unchanged.
Run `node --test test/parser.test.mjs`.
```

AgInTiFlow treats the named preservation inputs separately from deliverables.
The preservation sentence does not require a Markdown report, a new package
manifest, or copies of those files in the test directory. A terminal phrase
such as “and other files” preserves the meaning of the explicit named list;
it does not turn unnamed files into paths or grant permission to read or edit
them. Wildcard and format-only preservation instructions likewise supply no
literal path authority.

Output directory hints apply within their instruction clause. For example,
“Write one.txt in first/. Write two.txt in second/.” requires first/one.txt and
second/two.txt. Quoted filenames may contain a period followed by a space.
ES module and CommonJS filenames ending in .mjs and .cjs are recognized alongside
the existing file types.

Preservation does not erase a separately requested deliverable. “Create
report.md. Keep source.md unchanged.” still requires report.md. Completion
continues to require the applicable real mutations, source checks, artifact
validation and successful tests; a tool call or a model assertion alone does
not satisfy those checks.

On an SCS-enabled resume, a cached contract from before output-role versioning
is refreshed from the retained user request and already grounded project
instructions. Saved tool evidence and file contents remain intact. This refresh
does not rerun a confirmed producer or reinterpret the old model plan as user
authority.

These are bounded intent-inference rules, not a complete natural-language
parser or a filesystem security boundary. Workspace policy, provider selection,
session revision checks and tool permissions remain separate controls.
