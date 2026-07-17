# pi-mission-control

Terminal-first mission planning, cross-session attribution, and immutable evidence for Pi. The default `/mission` surface is a Pi TUI component; Glimpse is used only for bounded artifact viewing.

The package does **not** import or modify `pi-tasks`, `pi-workflows`, or `pi-subagents`.

## Install

```bash
pi install /Users/yesh/code/personal/pi-mission-control
```

Restart Pi or run `/reload`.

## Operator workflow

Mission state is explicit. Opening `/mission` never creates a mission, plan, membership, binding, context, or evidence record.

```bash
# Create a plan from a validated pi.mission-plan/v1 document.
missionctl plan create \
  --stdin \
  --idempotency-key workflow-plan-v1 < plan.json

# Add this Pi session as an explicit mission member.
missionctl session add \
  --stdin \
  --idempotency-key add-session-01 < session.json

# Bind the session to one exact roadmap item.
missionctl binding set \
  --session "$PI_SESSION_ID" \
  --mission workflow \
  --item wp8 \
  --expected-revision 0 \
  --idempotency-key bind-session-01

# Scriptable views use the same projection as the TUI.
missionctl mission show --mission workflow --plain
missionctl mission show --mission workflow --json
missionctl artifact verify EVENT_ID:ARTIFACT_INDEX
```

Bindings are CAS-protected and durable. A new fork starts unbound unless copied explicitly:

```bash
missionctl binding fork \
  --from SOURCE_SESSION_ID \
  --session NEW_SESSION_ID \
  --expected-revision 0 \
  --idempotency-key fork-binding-01
```

Within Pi:

```text
/mission                         Open the terminal board (TUI mode only)
/mission status                  Plain status via TUI/RPC notification
/mission json                    JSON projection via TUI/RPC notification
/mission close                   Close the open board
/mission bind M I REV KEY        Explicitly bind this session
/mission unbind REV KEY          Explicitly clear this session binding
```

For print/JSON modes, use `missionctl mission show`; Pi custom components are intentionally TUI-only.

### Empty and missing-plan states

An unbound session shows setup guidance without writing to the store. A bound mission without a readable plan shows a missing-plan board. Neither state infers membership, creates `mission:${sessionId}`, or starts background reconciliation.

## Board behavior

The board shows:

- explicit mission state, remaining ETA, and provenance-backed change totals;
- current and upcoming top-level roadmap items in plan order;
- completed semantic milestones only;
- nested items, executions, conflicts, and artifact IDs in item detail.

Controls:

```text
↑/↓ or j/k  select
enter       detail or artifact action
tab         next detail section
r           refresh
?           help
esc         back or close
```

The board refresh interval exists only while `ctx.ui.custom()` is open. Close, repeated close, reload, shutdown, and late refresh completion are idempotent. `MISSION_CONTROL_ASCII=1` enables ASCII markers.

## Evidence

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

With an exact persisted session binding, omitted `context_token` records and links semantic evidence to the active item. An explicit context token remains compatible with raw `pi.evidence/v1` storage and is reported as unassigned unless separately linked. Ambiguous unbound recording fails with setup guidance.

External producers can use the compatibility surface:

```bash
missionctl context-create --mission workflow --title "Worker" --cwd "$PWD"
missionctl record --context mc_... --title "Report ready" --artifact report=/tmp/report.md
missionctl record --context mc_... --mission workflow --item wp8 --session "$PI_SESSION_ID" \
  --idempotency-key report-ready-v1 --title "Report ready"
missionctl record --stdin
missionctl list --context mc_...
missionctl show ev_...
missionctl link execution --stdin --idempotency-key execution-01 < execution.json
missionctl migrate index --stdin < legacy-mapping.json
```

## Artifact security

UI actions carry only opaque `artifactId` values. Resolution scans immutable receipt data for an exact ID and then:

1. rejects malformed/unknown/duplicate IDs;
2. rejects root, intermediate, and leaf symlinks, traversal, non-files, replacement, and metadata conflicts;
3. opens with no-follow semantics and verifies inode, size, and SHA-256 from the descriptor;
4. lets internal text/diff viewers consume only verified descriptor bytes;
5. gives external viewers only a controller-owned, hash-named, mode-`0400` copy.

External viewer routes are typed executable/argv records with exactly one `verifiedPath` placeholder. They use `spawn(executable, argv, { shell: false })`; labels and UI values never become executables or argv tokens.

Diffs use exactly `@pierre/diffs@1.2.12` SSR APIs. Generated pages are read-only, bounded, CSP-restricted, and contain no remote resources or artifact-provided CSS/scripts. Text, JSON, Markdown, malformed diffs, and HTML source are escaped. Unsupported or oversized media is unavailable rather than opened through an implicit system command.

Glimpse is an artifact-focused HTML adapter only. There is no Glimpse mission dashboard and no Quickdiff shell route.

## Persistence and compatibility

Default root:

```text
~/.pi/agent/mission-control/
  manifest.json
  plans/  mission-generations/  mission-current/
  mission-sessions/  session-bindings/  binding-history/
  mission-links/  mission-operations/  migrations/
  contexts/  receipts/  artifacts/  staging/  locks/
  quarantine/orphans/
```

Logical IDs never become path components; new records use namespaced SHA-256 storage keys. Mission generations provide one commit point for plan, membership, binding, execution, context, receipt, and evidence-link catalogs.

Existing `pi.evidence/v1`, `pi.mission-context/v1`, and `pi.mission-context-ref/v1` files remain readable. Legacy colon artifact IDs resolve by exact receipt lookup. Migration/indexing is additive and never rewrites or renames legacy receipts, contexts, or artifact bytes.

Immutable artifact retry never deletes or overwrites a published directory. Exact output is reused, unreferenced mismatches are quarantined, and referenced mismatches fail closed.

## Development

```bash
npm ci
npm run check
npm test
npm run format:check
git diff --check
```

The test suite covers legacy readability, publication idempotency, generation/CAS behavior, exact projection semantics, artifact routing and shell-free viewers, Pierre/CSP output, responsive TUI goldens, custom-UI lifecycle, and unbound no-write behavior.
