# Native tool-family policy

Native runtime schema v2 stores tool-family restrictions with the session.
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
to v2. Older binaries reject v2 rather than ignoring its security-relevant fields;
resume a v2 session only with a runtime that supports it.

These are native configuration fields, not a public application RPC or an OS
sandbox. Application callers should use the restricted application runner with
host-owned tools, account scope and commit authority. Retained integration,
sandbox and provider-role admission keep their separate qualification gates;
this change does not mount or enable an integration service.
