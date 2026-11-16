# Native tool and workspace policy

Native runtime schema v3 stores tool-family and workspace path restrictions
with the session. Schema v2 already proved the sixteen tool-family flags;
those values remain authoritative during migration.
Changing the provider or model preserves those restrictions. Current incoming
defaults cannot widen saved policy; an intentional change uses the existing
`runtimePatch` and `expectedRuntimeRevision` compare-and-swap contract.

The trusted configuration resolver accepts these boolean fields:

| Family | Fields |
| --- | --- |
| Browser and canvas | `allowBrowserTools`, `allowCanvasTools` |
| Coordination | `allowAgentLinkTools`, `allowCoordinationTools`, `allowTmuxTools` |
| Background work | `allowLongJobTools`, `allowBackgroundJobs` |
| Specialists | `allowSpecialistTools`, `allowJsonTools`, `allowJsonSpecialist`, `allowWritingTools`, `allowWritingSpecialist` |
| Images | `allowImageTools`, `allowVisionTools`, `allowImagePerception`, `allowImageGeneration` |

A disabled family continues to hide its tools across saved-session resume and
provider handoff. Existing file, shell, web, MCP, wrapper and auxiliary controls
remain independent. Unrestricted defaults retain their previous behavior.

Schema v1 snapshots omitted these fields and cannot establish an earlier restriction.
If the current trusted caller asks to disable a family whose policy is missing,
resume returns `SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED` before model dispatch.
An explicit restrictive boolean patch at the current revision can establish the
new policy. Prior tool visibility, prompt wording and absence of activity are
not migration evidence. Malformed stored policy and non-boolean patches fail.
Ordinary unrestricted v1 defaults retain their effective behavior when normalized
to the current schema. Older binaries reject v3 rather than ignoring its
security-relevant fields; resume a v3 session only with a supporting runtime.

## Workspace path scopes

Trusted native configuration may also set:

- `workspacePathScopeRoots`: file-tool reads and writes stay within these roots.
- `workspaceWritePathScopeRoots`: an additional restriction on file-tool writes.

An empty list adds no restriction; ordinary workspace and sensitive-path rules
still apply. Missing fresh configuration defaults to that empty list. Each list
has at most 32 roots, each at most 4096 UTF-8 bytes. The resolver normalizes
workspace-contained paths to detached, sorted relative paths. Invalid, outside,
duplicate, sparse or accessor-bearing data fails instead of becoming an empty
unrestricted list. Stored lists and revision-checked patches use exact canonical
relative paths.

Nonempty restrictions intersect. Read permission never grants a write outside
the write scope. A task-derived artifact directory adds another restriction;
it cannot replace or widen host policy. Disjoint restrictions deny the write.
Explicit read-only roots and stronger permission modes cannot expand an active
workspace path scope.

Schema v1/v2 snapshots omitted this authority. Extra fields on an older snapshot
cannot prove restrictions that its reader ignored. A caller requesting a scope
on such a resume receives `SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED` before
model dispatch until it supplies an explicit current-revision scope patch.
Provider-only patches do not establish missing scope authority. For example,
the trusted host can set `runtimePatch.workspacePathScopeRoots = ["notes"]`
and `runtimePatch.workspaceWritePathScopeRoots = ["notes/out"]` with the saved
`expectedRuntimeRevision`. A deliberate wider scope also requires an explicit
CAS patch; incoming defaults never widen a known saved scope.

These scopes govern file tools. They do not confine shell commands, browser or
wrapper processes and do not replace application authentication, a sandbox or
retained-descriptor storage. Existing canonical file-reader checks still apply.

These are native configuration fields, not a public application RPC or an OS
sandbox. Application callers should use the restricted application runner with
host-owned tools, account scope and commit authority. Retained integration,
sandbox and provider-role admission keep their separate qualification gates;
this change does not mount or enable an integration service.
