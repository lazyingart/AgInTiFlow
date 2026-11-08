# Bounded AWK inspection

Restricted host mode supports a small AWK language for inspecting workspace
files and independently checking numeric results, without enabling destructive
host commands. For example:

```sh
awk -F, 'NR>1{n++;s+=$3} END{printf "count=%d mean=%.4f\n",n,s/n}' clean.csv
```

The program must be inline and single-quoted. Supported forms are BEGIN/END,
field and row predicates, scalar counters and arithmetic, if/else, and stdout
print/printf with literal bounded formats. Input operands must be literal
workspace-relative paths. A literal comma, colon, space or tab separator is
supported. The classifier bounds program size, nesting, statement count,
formats and input count; existing execution time and output limits still apply.

External programs (`-f`), variable injection (`-v`), arrays, loops, function
calls, system/getline, file output, subprocess pipes, includes, dynamic formats,
globs and parent/absolute input paths are outside this language. Unsupported
forms retain their existing permission requirements. Credential-path and shell
policy checks apply independently, and compound commands are assessed segment
by segment. A network segment does not become read-only because AWK precedes it.

This is a syntax classification rule, not a sandbox or an assertion that arbitrary
AWK is safe. Existing workspace/path and host execution boundaries remain in force.
It does not establish symlink isolation or protect against a modified executable
on the host search path. Use the configured sandbox for that stronger boundary.
