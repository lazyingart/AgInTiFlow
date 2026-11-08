# Named source preservation in Japanese tasks

Explicit Japanese whole-file constraints join the native task contract and
file-tool guard, including when SCS is disabled. For example:

```text
input.csv を読み取り、summary.md を作成してください。
input.csv は変更しないでください。
```

The source remains readable, while a proposed overwrite, patch, move or shell
mutation of `input.csv` is blocked. Creating the separate `summary.md` remains
permitted under the existing workspace permissions. A model's mistaken tool
call cannot override the named source constraint. Resuming the same completed
task does not repeat its output write; a new follow-up derives its own contract.

The bounded parser recognizes explicit literal targets with Japanese change,
overwrite, edit, delete and leave-intact prohibitions, and named read/create/
update requests. Coordinated literal lists are bounded by the existing file
list limits. Quote filenames containing spaces or characters outside the
existing unquoted path grammar, for example `"メモ.md"`. File naming and policy
do not depend on provider selection.

Spaces between literal filenames and Japanese particles are optional. A named
new output followed by a leave-intact instruction retains its creation
requirement; an existing protected source does not become an update target.
Multiple explicit read and output roles keep their request order.

Whole-file protection is separate from a request to preserve only formatting
or column names. Pronouns, ambiguous source aliases, quoted example sentences,
conditionals and past-tense narration do not grant new file authority. A request
to create a new deliverable and then leave it intact still permits that initial
creation, as in the existing English and Chinese contract. This is a bounded
intent grammar, not unrestricted Japanese understanding.

The runtime still needs successful tool evidence and valid artifacts before
completion. This does not add a tool, grant shell or host access, sandbox code,
resolve symlink races or qualify a provider/model. Restricted application SDK
proposals remain a separate interface whose host owns records and commits.

Regression coverage in `test/japanese-file-preservation.test.js` checks literal
roles, false positives, mutation blocks and persisted native start/follow-up
with SCS on and off. Existing English/Chinese preservation tests remain in the
same native-turn gate and the installed-package consumer checks.
