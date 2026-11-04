# Standalone CLI Provider Defaults

Choose the provider for new standalone tasks and chats without changing an
application's explicit routing or editing a credential file:

```bash
aginti defaults set --provider deepseek
aginti defaults status
aginti --routing fast "Explain this idea briefly."
aginti --routing complex "Review this architecture."
aginti defaults reset
```

The settings command uses only Node built-ins. It loads no Agent runtime, model,
tools, browser or credential files, makes no provider request and does not start
Studio or auto-update. Setting a provider does not prove its credentials, quota
or endpoint are ready. Hosted inference remains a separately authenticated call.
Use the existing protected `aginti auth deepseek` workflow when needed; never
put a key in the preference or a task prompt.

## Scope and precedence

The preference applies to new `aginti "task"`, `aginti chat`, and the bare
interactive CLI. It selects only a provider; it does not grant tools, change
sandbox/permission policy, select a fallback or enable an integration capability.
The precedence is:

1. Explicit CLI provider or saved-session runtime.
2. Existing environment/project `AGENT_PROVIDER` configuration.
3. The standalone user preference.
4. The existing LocalLLM baseline or explicit legacy configuration.

Dedicated role/model settings retain their existing precedence. A saved session
keeps its provider/model until the caller explicitly changes its runtime.
Resume does not read the personal preference. `aginti run`, machine
`run --json`, SDK/config imports, Studio and native application services also do
not read this file. Applications should continue supplying their own admitted
provider, model, endpoint, credentials and tools. The command is not an app
configuration API.

`reset` stores an explicit null preference. It leaves credentials, sessions and
project settings unchanged. Existing project/environment overrides can therefore
still select a provider after reset. Status returns only a closed non-secret
object identifying the preference and its standalone scope.

## Current DeepSeek names

The direct DeepSeek fast default is `deepseek-flash`; the complex default remains
`deepseek-v4-pro`. On 2026-11-04 the [official model documentation](https://api-docs.deepseek.com/quick_start/pricing/)
identifies those routes as V4.1-Flash-1017 and V4-Pro-0813. DeepSeek still accepts
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` as aliases for current Flash.
Existing explicit models are preserved. Third-party gateway identifiers are not
rewritten. Timeout recovery recognizes equivalent Flash names instead of
pretending that changing only an alias selected a different model.

## Storage and limits

The Linux/macOS preference is exactly `{schemaVersion:1,provider}` in
`$AGINTIFLOW_HOME/cli-provider-default.json`, or
`~/.agintiflow/cli-provider-default.json`. It contains no key, prompt, history,
tool, path, model or endpoint authority. A canonical owned directory with no
group/other write permission contains the regular private 0600 file. Symlink,
hardlink, wrong-mode, corrupt/future/extra-field and oversized files fail closed.
Explicit provider/environment selection can bypass a damaged personal preference.
Unsupported platforms retain existing routing and explicit `--provider` support.
When no preference file exists, legacy startup is unchanged, including legacy
homes with group-write permission. Saving or using a preference requires the
stricter owned-directory/file checks. The command does not silently change an
existing home's permissions. Ordinary creation of session subdirectories does
not invalidate a preference whose directory inode and file identity are stable.

Writes use a fresh private file, fsync and atomic replacement; concurrent
explicit settings are last-writer-wins. A concurrent replacement can make an
individual command refuse confirmation; re-read status rather than assuming
success. This personal setting is not a retained-descriptor service store or
protection from another process using the same OS account. No service readiness,
cross-process job transaction or production sandbox guarantee is implied.
