# Reusable data programs under bounded host permissions

When a request includes a rerunnable analyzer or checker, AgInTi should inspect
the current inputs and existing code, create or extend the workspace program
with file tools, and run its permitted project entry. A preliminary inline
interpreter experiment does not deliver that program and may require broader
host permission.

If such an inline command is denied, the native runtime permits one recovery
turn for an explicitly requested workspace program when file and shell tools
are already enabled. The command remains unexecuted. Recovery does not enable
destructive actions, install packages, relax path checks, or authorize copying
the denied code into a script. The program must independently implement the
user's requested deliverable under the existing guards. Repeating the denied
attempt cannot grant another program recovery; this is not a shell allowlist.

A reusable checker should compare outputs against the current source. To
verify that an input remains read-only, capture its hash before work and compare
it afterward within the same invocation. A permanent hash of a past input would
reject a legitimate later source correction even after the outputs are refreshed.
Existing independent tests and explicit golden fixtures retain their authority;
they must not be rewritten just to obtain a passing result.

After a source correction, regenerate every affected output and rerun semantic
checks. Independently inspect the data and presentation: agreement between a
generator and a checker sharing its implementation does not prove that the
underlying calculation is correct. State any working-directory or interpreter
limitations of the generated program.

The deterministic regression is `npm run test:requested-program-recovery`.
It uses the persisted native runtime with an offline provider and actual
temporary workspace files. It checks refusal without execution, one bounded
recovery, repeated-refusal stop, unchanged authority, and refreshed output after
a source change without modifying the reusable program. `npm run smoke:skills`
also checks that the workflow and oracle protections survive the actual bounded
skill excerpt used in prompts. These tests do not guarantee arbitrary provider
instruction compliance, program correctness, or untrusted application isolation.
