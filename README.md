# pi-mission-control

## Effect boundary

Mission Control uses Effect v4 for all authoritative store operations and passive source reconciliation. Those modules return typed effects; only the Pi extension and `missionctl` cross into `src/runtime.ts`, the single `runPromiseExit` boundary. Filesystem failures are normalized at the Node I/O edge, while event locking, immutable artifact publication, and terminal-state updates remain composable `Effect.gen` programs.

Independent Pi extension for mission progress, child-execution context, and durable evidence artifacts in a focused Glimpse window.

It does **not** import or modify `pi-tasks`, `pi-workflows`, or `pi-subagents`.

## Features

- `/mission` opens or focuses a native Glimpse Mission Control window.
- `mission_record` commits semantic milestones with immutable artifact snapshots.
- `missionctl` gives Claude, Codex, shell processes, and other external producers the same durable evidence path.
- Dynamic mission policy is injected with `before_agent_start`; no `AGENTS.md` mutation.
- Session entries contain branch-linked context references but do not enter model context.
- Subagent prompts, task execution context, and workflow `agent()` prompts receive opaque mission context without producer changes.
- Workflow/task/subagent state is projected from public tool results and existing persisted artifacts.
- Diff evidence opens in Quickdiff from the Mission Control window.

## Install

```bash
pi install /Users/yesh/code/personal/pi-mission-control
```

Then restart Pi or run `/reload`.

## Pi commands

```text
/mission          Open or focus Mission Control
/mission status   Show active context/evidence counts
/mission close    Close the window; collection continues
```

## Evidence tool

Pi agents receive `mission_record`:

```json
{
  "title": "API implementation verified",
  "kind": "checkpoint",
  "state": "completed",
  "artifacts": [
    { "role": "diff", "path": "/absolute/path/change.diff" },
    { "role": "test-log", "path": "/absolute/path/test.log" }
  ],
  "payload": { "tests": 42 }
}
```

A completed receipt is published only after all artifact files are copied, closed, hashed, and committed.

## CLI

The package exposes `missionctl`. Child prompts also contain a package-local absolute invocation, so global PATH installation is not required.

```bash
# Create a context manually
missionctl context-create \
  --mission demo \
  --title "Demo mission" \
  --cwd "$PWD"

# Record using an explicit token
missionctl record \
  --context mc_... \
  --title "Report ready" \
  --kind checkpoint \
  --state completed \
  --artifact report=/tmp/report.md

# External child: PI_EXECUTION_CONTEXT is used by default
missionctl record \
  --title "Agent completed" \
  --kind agent-run \
  --state completed \
  --artifact result=/tmp/result.json

# Structured producer input
printf '%s' "$EVIDENCE_JSON" | missionctl record --stdin

missionctl list --context mc_...
missionctl show ev_...
missionctl contexts
```

Environment:

- `MISSION_CONTROL_HOME`: override the evidence store root.
- `PI_EXECUTION_CONTEXT`: default context token for `missionctl record`.
- `PI_TASK_LIST_ID`: enables projection of the configured file-backed pi-tasks list.

## Storage

Default root:

```text
~/.pi/agent/mission-control/
  contexts/    opaque execution context records
  receipts/    committed pi.evidence/v1 manifests
  artifacts/   immutable artifact snapshots
  staging/     incomplete writes, never displayed
  locks/       per-event writer serialization
```

Artifact commit sequence:

1. Copy/write into an exclusive staging directory.
2. Flush each file, compute SHA-256, and flush the staging directory.
3. Atomically rename the artifact directory and flush its parent.
4. Flush and atomically publish the receipt manifest.
5. Settle only a matching terminal kind: `agent-run` for subagents, `workflow-run` for workflows, or `task-run` for task batches.

`eventId` is the idempotency key. Locks fail closed: an abandoned lock is never removed automatically because unlinking a lock that may have been replaced can permit concurrent writers. After verifying its recorded PID is dead, remove that event's lock manually before retrying the same `eventId`. New event IDs are unaffected.

## Integration without producer changes

### Pi sessions

The extension uses `before_agent_start`, tool lifecycle hooks, `agent_settled`, `appendEntry`, and `mission_record` directly. `agent_settled` records a non-terminal turn receipt because Pi does not expose the run outcome in that event.

### pi-subagents

`subagent_spawn.prompt` is prefixed during Pi's mutable `tool_call` hook. This works for Pi, Claude, and Codex backends because all consume the prompt field. Pi children load this extension normally; external children receive explicit `missionctl` instructions. A subagent context settles only when the child explicitly commits an `agent-run` terminal receipt; generic Pi settlement alone cannot distinguish success, failure, and cancellation.

### pi-workflows

The submitted workflow script is prefixed with a small wrapper that rebinds the sandbox's mutable `agent()` parameter. Every nested `agent(prompt, options)` call receives the mission context. The original workflow package is unchanged.

Terminal workflow state and its `script.js`, `transcripts.json`, and `result.json` sidecars are reconciled from `~/.pi/agent/workflows` after the producer's final atomic checkpoint.

### pi-tasks

Task state is projected from `TaskCreate`, `TaskUpdate`, and `TaskList` results. File-backed lists are also read from `~/.pi/tasks`. Successful `TaskUpdate` transitions produce task evidence receipts. `TaskExecute` uses one batch context, narrows it to the task IDs actually launched, and settles it only after every launched task is observed as completed.

## Boundaries

These are consequences of the no-producer-change constraint:

- Workflow runs are correlated to their launch context by parent session and nearest start time within 30 seconds. Explicit producer context would be stronger.
- Claude/Codex semantic evidence depends on the child following the injected `missionctl` contract; Pi cannot observe their private runtime directly.
- Session-scoped in-memory pi-tasks state is reconstructed from observed tool results and therefore resets on extension reload. File-backed task lists survive reload. A background task batch can remain active until a later `TaskList` result exposes every terminal task.
- Existing pi-tasks/subagent RPC compatibility issues are not changed or hidden by this package.
- Glimpse is a projection only. Closing the window does not stop collection.

## Development

```bash
npm install
npm run check
npm test
npm run format:check
```
