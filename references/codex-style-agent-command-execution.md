# Codex-Style Agent Command Execution

A Codex-style agent does not run commands like `ls` inside the LLM. The LLM proposes structured tool calls, and the surrounding host runtime executes those calls on the machine.

## Execution Mechanism

The core loop is:

1. The model receives the conversation context, system and developer instructions, current working directory, sandbox or permission settings, and available tool schemas.

2. The model decides it needs environment information and emits a structured tool call, for example:

   ```json
   {
     "cmd": "ls",
     "workdir": "/home/lachlan/ProjectsLFS/Agent"
   }
   ```

3. The host CLI receives the tool call. The model itself does not execute the command.

4. The host checks the requested working directory, sandbox policy, permission mode, approval rules, and tool constraints.

5. If the call is allowed, the host starts a real subprocess on the machine, roughly equivalent to:

   ```bash
   cd /home/lachlan/ProjectsLFS/Agent
   ls
   ```

6. The host captures stdout, stderr, exit code, and sometimes session metadata for long-running or interactive processes.

7. The captured result is returned to the model as new context.

8. The model reads the result and decides the next step: run another command, inspect files, apply a patch, run tests, summarize findings, ask the user, or stop.

In this architecture, the LLM is the planner and interpreter. The host CLI or agent runtime is the executor. The model has no native filesystem or process access; it only sees what the host returns through tool results.

## Permission And Working Directory Model

A practical Codex-style runtime needs to bind each command to an explicit execution context:

- `workdir`: the project directory where commands should run.
- `permissionMode`: the allowed access level, such as read-only, workspace-write, or full-access.
- `sandboxMode`: filesystem and network boundaries.
- `approvalPolicy`: whether risky commands require user confirmation.
- `allowedTools`: the tools the model may request, such as shell, file read, patch, test runner, Git, or GitHub.

The host enforces these settings. The model can request an action, but the runtime decides whether the request is valid and how it is executed.

## Connection To AgInTiFlow As An AAPS Backend Agent

The same mechanism can later connect to AgInTiFlow as an AAPS backend agent for project workflows.

Conceptually:

```text
AgInTiFlow workflow
        |
        v
AAPS backend task
        |
        v
Codex-style agent runtime
        |
        v
Tool calls: shell, git, tests, file reads, patches, GitHub, CI
        |
        v
Observed outputs returned to agent
        |
        v
Agent reports status, artifacts, and next actions to AgInTiFlow
```

AgInTiFlow would own workflow orchestration, user intent, task lifecycle, permissions, identity, audit logs, and UI state. The Codex-style agent runtime would own local project reasoning, command selection, code inspection, implementation, and verification.

An AAPS backend task could submit a run like:

```json
{
  "projectId": "agent-project",
  "workdir": "/srv/projects/agent-project",
  "task": "Investigate failing workflow build",
  "permissionMode": "read-only",
  "allowedTools": ["shell", "git", "tests"],
  "branch": "feature/aaps-agent"
}
```

The backend could expose an agent service interface such as:

```text
POST /agent/runs
GET  /agent/runs/{id}
POST /agent/runs/{id}/cancel
GET  /agent/runs/{id}/events
```

The agent runtime could stream events back to AgInTiFlow:

```text
agent.started
tool.requested
tool.completed
file.changed
test.completed
agent.message
agent.finished
```

This gives AgInTiFlow a controlled project-workflow agent: AgInTiFlow decides what work should happen and under what constraints, while the Codex-style backend agent performs the iterative model/tool loop inside the project environment.
