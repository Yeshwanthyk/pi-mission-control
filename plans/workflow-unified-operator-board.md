# Unified Mission Operator Board

**Status:** Proposed; implementation-ready; no product implementation started  
**Goal:** Replace the Glimpse-first, session-scoped dashboard with one compact terminal-first operator board for an explicitly planned mission shared by multiple Pi sessions, while preserving immutable `pi.evidence/v1` receipts and existing-store readability.

## 1. Product contract

The default `/mission` surface is one unified board:

1. **Mission header** — mission title, explicit state, aggregate remaining ETA, committed change statistics, and age of the latest semantic completion.
2. **Roadmap** — current top-level item(s) first, followed by upcoming top-level items in explicit plan order. ETA values are cumulative and use only explicit remaining estimates.
3. **Progress** — completed semantic milestones newest-first, with relative time and validated summaries such as `8 screenshots`, `14 tests`, `1 link`, or `1 diff`.
4. **Item detail** — an in-place drilldown containing the selected item’s plan fields, contributors, nested planned children, workflow/subagent/task executions, semantic milestones, conflicts, and artifacts.

```text
Mission title                         ACTIVE
eta ~52m                           +978/-115

Roadmap
■ Current item                         eta 4m   S1
□ Upcoming item                       eta 12m   S2
□ Upcoming item                       eta 18m

Progress
Completed onboarding walkthrough       2m ago
  1 video
Verified responsive breakpoints        4m ago
  8 screenshots
```

### Required behavior

- A mission may have many contributing Pi sessions. Each explicit member has one persisted display name, initials, and contrast-safe color token within that mission.
- Session identity is compact attribution and scope metadata only. It does not create lanes, cards, navigation, or per-session layouts.
- Cross-session joins require exact `missionId` and `itemId`. Context ancestry is not membership. Titles, cwd, timestamps, runtime metadata, nearest start times, and numeric task IDs never establish a join.
- Child workflows, subagents, tasks, and nested planned items appear under their owning roadmap item. They are never peer roadmap rows.
- Default Progress contains completed semantic evidence only. Launch, agent-turn, task-state, tool-count, and other execution telemetry is excluded.
- Membership, active binding, estimates, plan order, change data, and evidence association are explicit data. Missing values remain unknown, pending, conflict, or unassigned; they are never inferred.
- Artifact actions carry an opaque `artifactId`. Only the backend resolves content. UI messages never contain store paths, commands, or trusted artifact HTML.
- Glimpse is an artifact viewer only. The main board uses Pi’s `ctx.ui.custom()` in TUI mode. Plain and JSON views use the same projection.
- No plan and no active binding produce an empty/unassigned board with setup guidance. Opening `/mission` must not create `mission:${sessionId}` or any other implicit mission.

### Reference fidelity and responsive rules

- Match the supplied references’ density, hierarchy, and typography rather than reproducing pixels.
- Use one vertical board; no dashboard chrome, picker, columns by session, cards, or persistent execution panel.
- Current rows use a filled marker and emphasized title. Upcoming rows use an empty marker. Every state has a textual/ASCII fallback; color is supplemental.
- ETA is right-aligned where width permits. Unknown cumulative ETA renders `eta —`. Change stats render only with provenance; otherwise render `changes —` or omit at narrow widths.
- Progress title and age occupy one row; the summary occupies a dim second row. Attribution may collapse to persisted initials but never to color alone.
- `>=100` columns: full title/state, cumulative ETA, and compact attribution.
- `80–99` columns: one compact column, attribution initials, retained ETA.
- `<80` columns: compact header plus bounded roadmap/progress slices, scrolling, and explicit hidden-row counts. The header and current item remain visible at short heights.
- Every rendered line has visible width `<= width`; rows do not wrap into semantically ambiguous layouts.

## 2. Current-state constraints

- `extensions/mission-control/index.ts` currently creates `mission:${sessionId}`, hydrates branch-local context tokens, tracks launch correlation in memory, starts an always-on reconciliation timer, and opens a Glimpse presenter.
- `src/types.ts` has immutable evidence and contexts but no explicit plan, plan order, estimate, session membership, durable active binding, exact external identity, evidence link, operation, or board view-model contracts.
- `src/store.ts` snapshots artifacts and publishes `pi.evidence/v1`, but retry currently removes an existing artifact directory, context writes are unlocked, terminal states may regress, conflicting `eventId` reuse is accepted, and `snapshot()` can mix independently read state.
- `src/projections.ts` keys tasks by local numeric ID and presents tasks/workflows/agents as peer rows.
- `src/source-adapter.ts` uses nearest-start-time workflow matching.
- `src/presenter.ts` derives progress from execution counts, exposes paths to actions, and routes Quickdiff through a shell command.
- `src/context-prompt.ts` and `src/workflow-wrap.ts` propagate context ancestry but not an exact mission/item binding.

Existing `pi.evidence/v1`, `pi.mission-context/v1`, and `pi.mission-context-ref/v1` bytes are compatibility inputs. They remain readable and are never rewritten by migration.

## 3. Target architecture

```text
explicit plan/session/binding commands
                 │
                 ▼
       MissionPlanStore ── mission lock ──► generation snapshots
                 │                              │
exact launch/record operation                  │
                 │                              │
                 ▼                              ▼
       MissionRecordService ───────► immutable receipts/artifacts
                 │                              │
                 └──────── exact links ─────────┘
                                                │
                                      MissionIndex.snapshot()
                                                │
                                      MissionSourceSnapshot
                                                │
                                   buildMissionProjection()
                                  ┌─────────────┼─────────────┐
                                  ▼             ▼             ▼
                              Pi TUI       plain/JSON    ArtifactRouter
                                                               │
                                             TUI/Pierre/Glimpse/argv viewer
```

### Component boundaries

- `MissionStore` remains the compatibility owner for v1 contexts, receipts, and artifact snapshots.
- `MissionPlanStore` owns plans, session attribution, durable session bindings, execution bindings, evidence links, operations, and per-mission generations.
- `MissionRecordService` orchestrates artifact, receipt, link, and operation publication. Callers do not compose those writes independently.
- `MissionIndex` returns one generation-consistent `MissionSourceSnapshot`; renderers never scan mutable directories directly.
- `buildMissionProjection()` is pure for a supplied source snapshot and clock.
- `OperatorBoardController` owns refresh while a board is open. There is no session-start poller or daemon.
- `ArtifactRouter` resolves IDs into verified descriptors or controlled copies and then selects a typed viewer capability.

## 4. Public and persistence contracts

Add all contracts to `src/mission-types.ts`; add boundary parsers and canonical builders to `src/mission-validation.ts`. Interfaces below are normative. Serialized records use the shown schema tags.

### 4.1 Logical IDs and filesystem keys

Logical IDs are opaque UTF-8 strings, compared byte-for-byte after JSON decoding. New IDs are non-empty, at most 512 UTF-8 bytes, contain no NUL or control characters, and are not Unicode-normalized. Legacy IDs are accepted exactly as stored even when they do not satisfy new-ID creation rules.

Logical IDs are never interpolated into paths. New mission-scoped files use:

```ts
type StorageKey = `k_${string}`; // lowercase SHA-256 of `${namespace}\0${logicalId}`
```

Every keyed record stores its logical ID. A read computes the key and rejects a hash collision or mismatched embedded ID. Directory enumeration parses record contents rather than decoding filenames. Existing context and receipt filenames retain their current safe-token rules. Existing artifact IDs such as `${eventId}:${index}` remain opaque IDs and resolve by exact receipt/index lookup; routers do not derive a path by splitting the ID.

### 4.2 Mission plan

```ts
type MissionState =
  "planned" | "active" | "blocked" | "completed" | "failed" | "cancelled";

type ItemState = MissionState;

type EstimateValue =
  | { readonly status: "known"; readonly minutes: number }
  | { readonly status: "unknown"; readonly reason: UnknownReason };

interface PlanEstimate {
  readonly unit: "minute";
  readonly expected: number;
  readonly optimistic?: number;
  readonly pessimistic?: number;
  readonly confidence?: "low" | "medium" | "high";
  readonly asOf: string;
  readonly scope: "schedule" | "included-in-parent";
}

interface MissionPlan {
  readonly schema: "pi.mission-plan/v1";
  readonly missionId: string;
  readonly title: string;
  readonly description?: string;
  readonly state: MissionState;
  readonly revision: number;
  readonly schedule: MissionSchedule;
  readonly items: readonly RoadmapItem[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

type MissionSchedule =
  | { readonly mode: "serial" }
  | {
      readonly mode: "waves";
      readonly waves: readonly {
        readonly waveId: string;
        readonly itemIds: readonly string[];
      }[];
    };

interface RoadmapItem {
  readonly itemId: string;
  readonly order: number;
  readonly parentItemId?: string;
  readonly title: string;
  readonly description?: string;
  readonly state: ItemState;
  readonly estimate?: PlanEstimate;
  readonly dependencyItemIds: readonly string[];
  readonly contributorSessionIds: readonly string[];
  readonly externalRefs: readonly MissionExternalRef[];
  readonly updatedAt: string;
}
```

Plan invariants:

- Item IDs and non-negative integer `order` values are unique within a mission. Parent and dependency references exist in that mission; both graphs are acyclic. An item cannot depend on itself, its ancestor, or its descendant.
- Every top-level item, including completed, failed, and cancelled items, occurs exactly once in a wave plan. Wave order is plan order; item order is the stable tie-break within a wave. Serial order uses `order`.
- Top-level estimates use `scope: "schedule"`. Nested estimates, when present, use `scope: "included-in-parent"` and are informational; they are never added to aggregate ETA.
- A nested item has the same schedule slot as its top-level owner. Nested dependencies remain within that owner subtree. Top-level dependencies point only to an earlier serial item or earlier wave.
- Serial plans permit at most one active or blocked top-level item. Wave plans permit active/blocked top-level items only in the earliest unfinished wave. A later wave cannot become active while an earlier wave contains planned, active, or blocked work.
- A parent cannot be completed while a descendant is planned, active, blocked, or failed. Cancelled descendants are allowed only when the completing plan mutation explicitly records their exclusion reason. A failed parent may retain non-terminal descendants only if the same mutation cancels them. Cancellation cascades explicitly; it is never inferred.
- Mission and item transitions are `planned → active|cancelled`, `active → blocked|completed|failed|cancelled`, and `blocked → active|failed|cancelled`. Terminal states do not transition. Repeating the same transition is idempotent.
- A failed/cancelled top-level item remains in its schedule slot and detail history but contributes zero remaining ETA and is omitted from default current/upcoming rows. Its dependency consequences are represented as blocked/unknown, never silently skipped.

### 4.3 Session attribution and active binding

```ts
type SessionColorToken =
  | "blue"
  | "cyan"
  | "green"
  | "magenta"
  | "orange"
  | "purple"
  | "red"
  | "teal"
  | "yellow";

interface MissionSessionAttribution {
  readonly schema: "pi.mission-session/v1";
  readonly missionId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly initials: string;
  readonly color: SessionColorToken;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly revision: number;
}

interface MissionSessionBinding {
  readonly schema: "pi.mission-session-binding/v1";
  readonly sessionId: string;
  readonly revision: number;
  readonly state: "unbound" | "bound";
  readonly missionId?: string;
  readonly itemId?: string;
  readonly changedAt: string;
  readonly changedBy: "operator" | "explicit-fork";
  readonly previousRevision?: number;
}

interface MissionSessionBindingHistoryEntry {
  readonly schema: "pi.mission-session-binding-history/v1";
  readonly sessionId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly before: MissionSessionBinding | null;
  readonly after: MissionSessionBinding;
  readonly recordedAt: string;
}
```

- Attribution is explicit mission membership; binding does not create membership.
- Binding mutation requires `expectedRevision` and an idempotency key. Binding an item requires an existing plan, item, and membership for the same session and mission.
- Reload and resume of the same Pi `sessionId` load its latest persisted binding. Branch changes within the same session retain it.
- A fork with a new `sessionId` starts unbound. `binding fork --from <session>` is an explicit CAS operation that copies the selected mission/item and records `changedBy: "explicit-fork"`; it still requires explicit membership for the new session.
- Missing, stale, or malformed session entries never override the persisted binding. Session entries may cache a binding revision for display but are not authoritative.
- Semantic recording with omitted mission/item uses the current persisted binding only when the supplied session ID and context agree exactly. Otherwise it fails with an actionable unbound/stale error. Raw context-only evidence may still be stored, but remains unassigned and cannot affect a plan.

### 4.4 Exact external identities and execution bindings

```ts
type MissionExternalRef =
  | {
      readonly kind: "pi-task";
      readonly producerNamespace: string;
      readonly projectRoot: string;
      readonly listId: string;
      readonly sessionId: string;
      readonly taskId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "pi-workflow";
      readonly producerNamespace: string;
      readonly runId: string;
    }
  | {
      readonly kind: "pi-subagent";
      readonly producerNamespace: string;
      readonly sessionId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "other";
      readonly producerNamespace: string;
      readonly identity: readonly [string, ...string[]];
    };

type CanonicalExternalIdentity = `xref:${string}`;

interface MissionExecutionBinding {
  readonly schema: "pi.mission-execution-binding/v1";
  readonly bindingId: string;
  readonly missionId: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly parentContextToken: string;
  readonly childContextToken?: string;
  readonly toolCallId: string;
  readonly externalRef: MissionExternalRef;
  readonly canonicalIdentity: CanonicalExternalIdentity;
  readonly state: "intent" | "bound" | "completed" | "failed" | "cancelled";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Canonical identity builders length-prefix every tuple element before hashing/encoding; concatenation with ambiguous separators is forbidden. Required fields cannot be omitted. A producer that cannot supply its full discriminator is represented by `UnassignedExecution` and cannot create an execution binding.

Binding validation requires:

- plan, item, session membership, active session binding, parent context mission, and link mission to agree exactly;
- unique `(missionId, canonicalIdentity)` and `(missionId, toolCallId, sessionId)` tuples;
- child context ancestry to point to the bound parent context;
- terminal execution transitions to be monotonic and idempotent.

### 4.5 Evidence links, summaries, and state-effect authority

```ts
type EventClassification = "semantic" | "execution" | "telemetry";
type EvidenceStateEffect =
  | { readonly kind: "none" }
  | {
      readonly kind: "execution-terminal";
      readonly bindingId: string;
      readonly transition: "complete-item" | "fail-item" | "cancel-item";
    }
  | {
      readonly kind: "operator-plan-mutation";
      readonly operationId: string;
      readonly transition: "complete-item" | "fail-item" | "cancel-item";
    };

interface EvidenceSummary {
  readonly tests?: number;
  readonly screenshots?: number;
  readonly links?: number;
  readonly diffs?: number;
  readonly videos?: number;
  readonly logs?: number;
  readonly diagrams?: number;
}

interface ChangeStatProvenance {
  readonly artifactId: string;
  readonly sha256: string;
  readonly parser: "unified-diff/v1" | "explicit/v1";
}

interface ChangeStat {
  readonly additions: number;
  readonly deletions: number;
  readonly provenance: ChangeStatProvenance;
}

interface MissionEvidenceLink {
  readonly schema: "pi.mission-evidence-link/v1";
  readonly linkId: string;
  readonly missionId: string;
  readonly itemId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly classification: EventClassification;
  readonly stateEffect: EvidenceStateEffect;
  readonly summary?: EvidenceSummary;
  readonly changeStats: readonly ChangeStat[];
  readonly createdAt: string;
}
```

- `(missionId, itemId, eventId)` is unique. Exact duplicate publication is idempotent; any differing duplicate is a conflict.
- The receipt’s context must exist and its stored `missionId` must equal the link mission. The linked session must be an explicit mission member and agree with the context/binding producer.
- An authorized state effect publishes the evidence link and the resulting plan revision in the same generation; neither is mission-visible alone.
- A `mission_record` semantic call cannot directly request a state effect. `execution-terminal` requires a terminal receipt and exact terminal execution binding owned by the same item. `operator-plan-mutation` is created only by the plan mutation service. Unauthorized effects reject; conflicting late terminal evidence is retained as a detail conflict and does not mutate terminal plan state.
- Structured summary counts are non-negative safe integers. Artifact-role counts are committed from the immutable receipt. Arbitrary payload keys, labels, and filenames are not facts.
- Change stats come from a bounded committed diff artifact or validated explicit values with the shown provenance. Aggregation deduplicates by artifact ID and hash.

### 4.6 Durable operations and generation snapshots

```ts
type MissionOperationKind =
  | "plan-create"
  | "plan-mutate"
  | "session-upsert"
  | "binding-set"
  | "binding-fork"
  | "execution-bind"
  | "evidence-record-link"
  | "evidence-link"
  | "migration-index";

type OperationPublication =
  "artifacts" | "receipt" | "generation" | "binding-history";

interface MissionOperation {
  readonly schema: "pi.mission-operation/v1";
  readonly operationId: string;
  readonly missionId: string;
  readonly itemId?: string;
  readonly idempotencyKey: string;
  readonly kind: MissionOperationKind;
  readonly requestDigest: string;
  readonly state: "intent" | "retryable" | "committed";
  readonly publications: readonly OperationPublication[];
  readonly resultRef?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MissionGeneration {
  readonly schema: "pi.mission-generation/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly previousGeneration: number | null;
  readonly planRevision: number | null;
  readonly planKey?: string;
  readonly sessionKeys: readonly string[];
  readonly bindingKeys: readonly string[];
  readonly executionLinkKeys: readonly string[];
  readonly evidenceLinkKeys: readonly string[];
  readonly contextTokens: readonly string[];
  readonly eventIds: readonly string[];
  readonly committedOperationIds: readonly string[];
  readonly publishedAt: string;
}

interface MissionGenerationPointer {
  readonly schema: "pi.mission-generation-pointer/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly generationSha256: string;
}
```

Every mission mutation requires an operator-supplied idempotency key or a documented deterministic key derived from stable producer identity. Random retry keys are forbidden. The service normalizes the request, hashes content-bearing staged artifacts, and computes `requestDigest` before accepting the operation.

#### Publication protocol

All mission-state decisions occur under the per-mission owned lock; event publication additionally takes the event lock in fixed order: mission lock, then event lock. A binding move touching two missions acquires both mission locks in ascending `StorageKey` order and publishes a generation for each affected mission before committing; retry verifies both pointers.

1. Re-read the current generation, operation, and expected plan/binding revisions after acquiring the lock.
2. If an operation exists with a different digest or kind, reject `IDEMPOTENCY_CONFLICT`.
3. If it is `committed`, verify its result is present in the pointed generation and return it. Missing committed output is corruption, never success.
4. Otherwise atomically publish/update `intent`, including deterministic event/link/result IDs and the durable staged-artifact manifest when applicable.
5. Publish each immutable prerequisite idempotently. Existing output must match exact normalized bytes/hash; mismatch is a conflict.
6. Publish a complete immutable `MissionGeneration(generation + 1)` and fsync it, then atomically replace/fsync the generation pointer. This is the commit point for mission-visible state.
7. Publish binding history if required, then mark the operation `committed`. A crash after the pointer but before this marker is repaired by detecting the exact result in the current/later generation.
8. On a retryable environmental failure, retain durable staging, publish `retryable` with an error code, and return failure. Retry resumes from verified publications; it never reports success before the generation commit point.

Plan-only and link-only operations use the same protocol without artifact/receipt steps. Plan snapshots and all records referenced by a generation are immutable; later updates publish new keyed record revisions and a new generation.

#### Crash recovery table

| Last durable boundary | Visible in MissionIndex                                         | Retry action                                        |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| none                  | no                                                              | normalize/stage and create intent                   |
| intent only           | no                                                              | verify digest/revisions and resume                  |
| artifacts only        | no                                                              | verify/reuse exact directory and publish receipt    |
| receipt only          | no linked Progress; receipt is unassigned/pending recovery data | verify exact receipt and publish link generation    |
| generation file only  | no; pointer still selects prior generation                      | verify file and republish pointer                   |
| generation pointer    | yes exactly once                                                | mark operation committed and return existing result |
| committed marker      | yes exactly once                                                | verify result and return                            |

A link without its receipt is invalid and cannot be published into a generation. A receipt without a link is excluded from default Progress. An operation intent referencing it is `pending`; otherwise it is `unassigned`.

### 4.7 Artifact publication and verified routing

Artifact publication changes the current retry behavior:

- Stage into an operation-owned directory, copy through an opened source descriptor, hash the staged bytes, fsync files and directory, and persist the staged manifest in the operation intent.
- Rename to the deterministic event artifact directory only when no destination exists.
- Never remove or overwrite an existing destination. If it matches the staged manifest byte-for-byte, reuse it. If it differs and no published receipt references it, atomically move it to `quarantine/orphans/<key>.<timestamp>` and record recovery metadata before publishing the staged directory. If a receipt references it, fail immutable-corruption recovery and leave it untouched.
- Orphan cleanup is a separate explicit maintenance command; normal retry never deletes an orphan, quarantine entry, receipt, or artifact.
- Receipt publication is atomic and idempotent. Existing `eventId` input must match canonical receipt content and artifact metadata exactly, excluding only the original `recordedAt` chosen by the first successful publication.

Routing returns one of:

```ts
type ArtifactAvailability<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "conflict"; readonly reason: string };

interface VerifiedArtifactDescriptor {
  readonly artifactId: string;
  readonly receiptEventId: string;
  readonly mediaType: string;
  readonly role: string;
  readonly size: number;
  readonly sha256: string;
  readonly fd: number;
}

type ArgvToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "placeholder"; readonly value: "verifiedPath" };

interface ExternalViewerRoute {
  readonly executable: string;
  readonly argv: readonly ArgvToken[];
}
```

Resolution looks up the exact artifact ID in receipt data, opens every candidate with no-follow semantics, validates root containment and regular-file status, and verifies size/hash from the open descriptor. Internal text/diff/media viewers consume that descriptor. External viewers receive a controller-owned, hash-named, mode-`0400` copy created with exclusive open from the verified descriptor; the copy is fsynced and rehashed before direct `spawn(executable, argv, { shell: false })`. The original store path is never handed to a viewer after a separate check. Labels and UI data cannot enter executable or argv tokens. Symlink-at-root, intermediate, leaf, replacement, and inode-change cases fail closed.

### 4.8 Source snapshot and projection view model

```ts
type UnknownReason =
  | "not-planned"
  | "not-estimated"
  | "missing-bound"
  | "blocked-by-terminal"
  | "missing-provenance"
  | "legacy-unassigned"
  | "partial-operation";

type ValueState<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "unknown"; readonly reason: UnknownReason }
  | {
      readonly status: "conflict";
      readonly values: readonly T[];
      readonly reason: string;
    };

interface MissionSourceSnapshot {
  readonly schema: "pi.mission-source-snapshot/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly projectionRevision: string;
  readonly plan: MissionPlan | null;
  readonly sessions: readonly MissionSessionAttribution[];
  readonly sessionBindings: readonly MissionSessionBinding[];
  readonly executionBindings: readonly MissionExecutionBinding[];
  readonly evidenceLinks: readonly MissionEvidenceLink[];
  readonly contexts: readonly MissionContext[];
  readonly receipts: readonly EvidenceReceipt[];
  readonly pendingOperations: readonly MissionOperation[];
  readonly unassigned: readonly UnassignedRecord[];
  readonly conflicts: readonly MissionConflict[];
}

interface MissionHeaderView {
  readonly title: string;
  readonly state: ValueState<MissionState>;
  readonly aggregateEta: ValueState<DurationRange>;
  readonly changeStats: ValueState<{
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly latestSemanticAt: ValueState<string>;
}

interface RoadmapRowView {
  readonly itemId: string;
  readonly phase: "current" | "upcoming";
  readonly state: ItemState;
  readonly title: string;
  readonly cumulativeEta: ValueState<DurationRange>;
  readonly attribution: readonly SessionAttributionView[];
  readonly blockedReason: ValueState<string>;
  readonly conflictCount: number;
}

interface ProgressRowView {
  readonly eventId: string;
  readonly itemId: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly summary: readonly SummaryCountView[];
  readonly attribution: ValueState<SessionAttributionView>;
  readonly artifactIds: readonly string[];
  readonly changeStats: readonly ChangeStat[];
}

interface ItemDetailView {
  readonly itemId: string;
  readonly plan: RoadmapItem;
  readonly plannedChildren: readonly ItemDetailView[];
  readonly executions: readonly ExecutionDetailView[];
  readonly milestones: readonly ProgressRowView[];
  readonly artifactIds: readonly string[];
  readonly pending: readonly PendingRecordView[];
  readonly conflicts: readonly ConflictView[];
}

interface MissionProjection {
  readonly schema: "pi.mission-projection/v1";
  readonly missionId: ValueState<string>;
  readonly projectionRevision: string;
  readonly boardState: "ready" | "empty-unbound" | "missing-plan" | "conflict";
  readonly header: MissionHeaderView;
  readonly roadmap: readonly RoadmapRowView[];
  readonly progress: readonly ProgressRowView[];
  readonly detailsByItemId: Readonly<Record<string, ItemDetailView>>;
  readonly unassignedCount: number;
  readonly capabilities: ArtifactCapabilities;
}
```

`DurationRange`, attribution, summary, execution, pending, unassigned, capability, and conflict interfaces are defined in full in `src/mission-types.ts`; no public field uses `any`, an unsafe cast, ANSI, HTML, filesystem paths, or renderer state.

`MissionIndex.snapshot(missionId)` acquires the mission lock, reads and verifies one generation pointer/file, reads only immutable records named by that generation, reads receipts by the generation’s event IDs, computes `projectionRevision = sha256(generation bytes + referenced receipt hashes)`, and releases the lock only after constructing the complete source snapshot. Every plan, membership, session binding, execution binding, context catalog, mission-linked receipt catalog, or evidence-link publication advances the mission generation. Raw unassigned v1 receipts do not enter a mission catalog until an explicit indexing/link operation advances it. Evidence-only mission updates therefore change projection revision. Separate store instances and processes observe an old or new generation, never a mixture.

## 5. Projection semantics

### Roadmap ordering and state

- Only non-terminal top-level plan items appear in default Roadmap.
- Current rows are active and blocked items in the earliest unfinished schedule slot, ordered by `order`. Blocked rows are visibly labeled `BLOCKED` and follow active rows within the slot.
- Upcoming rows are planned top-level items in subsequent explicit serial/wave order, then `order`.
- Terminal items, nested plan items, executions, and conflicts remain available in item detail/history.
- If no mission is bound, the projection is `empty-unbound`. If a mission is bound but has no plan, it is `missing-plan`. Neither path creates data.

### ETA

- Estimates are explicit remaining work as of `asOf`; elapsed wall time is never subtracted.
- Completed, failed, and cancelled items contribute zero. A blocked item retains its explicit remaining estimate but its cumulative result is unknown if a failed/cancelled dependency prevents execution.
- Serial cumulative ETA is the prefix sum of top-level schedule estimates.
- Wave cumulative ETA is the prefix sum of each wave’s maximum top-level estimate. Nested estimates never contribute.
- Expected, optimistic, and pessimistic values use identical sum/max operations. Missing expected makes expected unknown from that row onward. Missing either bound makes that bound unknown without hiding a known expected value.
- The header uses the final cumulative value. It never invents bounds or substitutes historical duration.

### Progress and conflicts

- Include only links with `classification: "semantic"`, a completed receipt milestone, an existing exact item, and a valid mission/session association.
- Sort by `occurredAt` descending, then `eventId` ascending for deterministic ties.
- Pending operations, unassigned receipts, telemetry, and execution events are excluded from default Progress and surfaced only in detail/status counts.
- A conflicting terminal effect, duplicated external identity, stale binding, missing receipt, or immutable hash mismatch is represented explicitly in source/detail conflicts. Projection never resolves conflicts by last-write-wins.
- Header change stats sum unique committed provenance `(artifactId, sha256)` only. Missing provenance yields unknown rather than zero.

## 6. Ordered work packages

### WP0 — Freeze compatibility, crash, and visual baselines

**Dependencies:** none  
**Files:**

- Add `test/fixtures/legacy-store-v1/**` with byte-for-byte contexts, receipts, artifacts, colon IDs, Unicode logical IDs, malformed legacy IDs, slash/path-traversal attempts, and existing artifact IDs.
- Add `test/fixtures/operator-board/{wide,compact,narrow,empty,unknown,conflict}.json` from explicit sample data matching the reference hierarchy.
- Add `test/fixtures/crash-matrix/**` and `test/fixtures/artifacts/**`, including multi-file, empty, malformed, malicious-label, symlink, and replacement cases.
- Add `test/compatibility.test.ts` and `test/publication-contract.test.ts`.
- Update `package.json` formatting globs to include `plans/**/*.md` and documented binary-fixture exclusions.
- Record the exact `@pierre/diffs@1.2.12` package/API fixture and expected SSR/CSP inputs without adding runtime integration yet.

**Acceptance criteria:**

- Fixture hashes are checked into tests; current v1 readers read valid legacy fixtures; migration tests can prove original files stay byte-identical.
- The crash matrix names every operation/artifact/receipt/link/generation boundary and its expected retry result.
- The selected Pierre version exposes the chosen SSR/vanilla API; patch, multi-file, empty, and malformed inputs have pinned expected behavior before viewer work starts.

### WP1 — Complete schemas, validation, and canonical identities

**Dependencies:** WP0  
**Files:**

- Add `src/mission-types.ts` with every contract in sections 4–5, including all helper/detail/conflict/capability types.
- Add `src/mission-validation.ts` with parsers, logical-ID/storage-key builders, canonical external identity builders, transition rules, graph/wave/parent validation, normalized request digests, summary validation, and typed argv parsing.
- Update `src/types.ts` only with additive tool/CLI inputs; do not change v1 serialized interfaces.
- Update `src/validation.ts` to accept additive mission-record fields while retaining v1 receipt parsing.
- Add `test/mission-validation.test.ts`, `test/external-identity.test.ts`, and `test/storage-key.test.ts`.

**Acceptance criteria:**

- Invalid IDs/timestamps, duplicate order/IDs, non-finite/negative estimates, invalid bounds, parent/dependency cycles, cross-slot dependencies, incomplete waves, nested estimate ownership, contradictory parent/child terminal state, and illegal transitions reject with stable error codes.
- Every external-ref variant requires its exact tuple; ambiguous combinations reject; canonical tuple tests prove numeric task collisions cannot alias.
- New and legacy logical IDs cannot traverse paths; colon, slash, Unicode, malformed, and hash-mismatch records are covered.
- All public states include explicit known/unknown/pending/unassigned/conflict forms; TypeScript compiles without `any`, non-null assertions, or unsafe casts in new contracts.

### WP2 — Safe immutable artifact and receipt publication

**Dependencies:** WP1  
**Files:**

- Extend `src/atomic.ts` with owned locks, fixed lock ordering, file/directory fsync helpers, exclusive immutable rename, and fault-injection points.
- Extend `src/paths.ts` with staging manifests, quarantine, and encoded key helpers.
- Refactor `src/store.ts` artifact publication to the protocol in section 4.7; add exact conflicting-`eventId` detection, per-context locks, and terminal precedence.
- Add `src/artifact-publication.ts` and `src/publication-faults.ts` so crash semantics are isolated and testable.
- Extend `test/store.test.ts`; add `test/artifact-publication.test.ts` and `test/context-concurrency.test.ts`.

**Acceptance criteria:**

- Retry never deletes or overwrites an existing artifact directory. Exact output is reused; unreferenced mismatch is quarantined; referenced mismatch fails closed.
- Crashes before/after staging fsync, directory rename, receipt rename, and context terminal update recover without byte replacement, duplicate receipt, or false success.
- Reusing an event ID with different normalized input fails. Separate-process context writers preserve terminal precedence.
- Existing v1 receipt/artifact bytes and legacy artifact IDs remain readable and unchanged.

### WP3 — Generation store, operations, mission index, and migration

**Dependencies:** WP2  
**Files:**

- Extend `src/paths.ts` with `manifest`, `plans`, `mission-generations`, `mission-current`, `mission-sessions`, `session-bindings`, `binding-history`, `mission-links`, `mission-operations`, and `migrations` paths using storage keys.
- Add `src/mission-plan-store.ts` for plan CAS, membership, session binding/history, execution/evidence links, and generation publication.
- Add `src/mission-operation-store.ts` for intent/retryable/committed recovery and publication verification.
- Add `src/mission-record-service.ts` for the only supported combined artifact/receipt/link transaction workflow.
- Add `src/mission-index.ts` for locked generation-consistent snapshots.
- Add `src/mission-migrations.ts` for additive manifest/index creation and explicit legacy import mappings.
- Add `test/mission-plan-store.test.ts`, `test/mission-operation-store.test.ts`, `test/mission-record-service.test.ts`, `test/mission-index.test.ts`, and `test/mission-migrations.test.ts`.

**Persistence layout:**

```text
mission-control/
  manifest.json
  plans/<missionKey>/<revision>.json
  mission-generations/<missionKey>/<generation>.json
  mission-current/<missionKey>.json
  mission-sessions/<missionKey>/<sessionKey>/<revision>.json
  session-bindings/<sessionKey>/<revision>.json
  binding-history/<sessionKey>/<revision>.json
  mission-links/<missionKey>/{execution,evidence}/<recordKey>.json
  mission-operations/<missionKey>/<operationKey>.json
  migrations/<migrationKey>.json
  quarantine/orphans/**
  contexts/ receipts/ artifacts/ staging/ locks/   # v1-compatible locations
```

**Acceptance criteria:**

- Every mutation requires idempotency and re-reads CAS state under lock. Identical retries return the prior result; conflicting key reuse fails.
- The full crash table passes for operation intent, plan/link/receipt publication, generation file, pointer, history, and committed marker; Progress cannot duplicate and an operation cannot false-commit.
- Separate-process readers observe one complete generation. Plan-, membership-, binding-, link-, context-, and evidence-only changes all advance `projectionRevision`.
- Cross-mission receipt links and unauthorized state effects reject. `(missionId,itemId,eventId)` uniqueness is enforced.
- Legacy indexing is explicit, resumable, idempotent, and byte-preserving. Existing `mission:${sessionId}` values remain distinct logical IDs.

### WP4 — Scriptable plan, membership, and durable binding surface

**Dependencies:** WP3  
**Files:**

- Extend `src/cli.ts` with `plan create|show|update`, `item add|update`, `session add|update`, `binding show|set|clear|fork`, `link evidence|execution`, and `migrate index`.
- Add `--mission`, `--item`, `--session`, `--expected-revision`, `--idempotency-key`, exact producer identity options, and explicit mapping-file input.
- Add extension commands/tools in `extensions/mission-control/index.ts` for the same binding and plan-selection operations; keep them thin wrappers over stores.
- Extend `test/cli.test.ts` and `test/extension-integration.test.ts`; add `test/session-binding.test.ts`.

**Acceptance criteria:**

- Plan, membership, and active-item selection are fully scriptable before producer binding work begins.
- Set/change/clear/reload/resume/fork, stale CAS, concurrent sessions, and explicit fork history pass. A new fork is unbound unless explicitly copied.
- Binding requires matching membership/plan/item. No command performs fuzzy merge or implicit mission creation.
- Existing CLI commands remain compatible. Context-only evidence remains storable but unassigned; ambiguous semantic recording fails with guidance.

### WP5 — Exact producer adapters and durable reconciliation

**Dependencies:** WP4  
**Files:**

- Update `extensions/mission-control/index.ts` to persist execution intent before launch, propagate exact mission/item/session identity, bind child context/result, and remove `pendingLaunches` as authority.
- Update `src/context-prompt.ts` with validated mission/item/session references and CLI flags; retain context token solely for ancestry.
- Update `src/workflow-wrap.ts` to propagate exact workflow `runId` and binding metadata.
- Replace fuzzy matching in `src/source-adapter.ts` with discriminated producer adapters and exact canonical identities. Legacy observations become labeled unassigned records.
- Refactor `src/projections.ts` keys to full canonical external identity; keep it as a producer-detail adapter, not the board projection.
- Add `src/execution-reconciler.ts` for idempotent intent → bound → terminal recovery.
- Extend `test/source-adapter.test.ts`, `test/projections.test.ts`, `test/workflow-wrap.test.ts`, and `test/extension-integration.test.ts`; add `test/execution-reconciler.test.ts`.

**Acceptance criteria:**

- Reload between launch intent, child context creation, tool result, receipt, and generation commit preserves exact association.
- Two sessions’ task `#1` and concurrent workflow runs cannot collide or time-match.
- Binding mission/session/context fields must agree. Missing producer identity is unassigned and cannot mutate roadmap state.
- Terminal state effects require exact authorization. Telemetry never creates, completes, fails, or cancels a roadmap item.

### WP6 — Deterministic projection and plain/JSON views

**Dependencies:** WP3 and WP5  
**Files:**

- Add `src/mission-projection.ts` with pure `buildMissionProjection(snapshot, clock)`.
- Add `src/estimate.ts` for serial/wave cumulative ETA and honest unknown propagation.
- Add `src/evidence-classifier.ts` for explicit classifications and conservative legacy omission.
- Add `src/artifact-summary.ts` for structured counts and bounded change-stat provenance.
- Reduce `src/presenter.ts` to plain/JSON adapters over `MissionProjection`; remove execution-count dashboard derivation.
- Extend `src/cli.ts` with `mission show --plain|--json`.
- Add `test/mission-projection.test.ts`, `test/estimate.test.ts`, and `test/artifact-summary.test.ts`; replace dashboard assertions in `test/presenter.test.ts`.

**Acceptance criteria:**

- Current active rows precede blocked rows in the earliest slot; upcoming rows follow explicit plan order. Nested work appears only in owner detail.
- Progress is completed-semantic-only and newest-first with stable tie-breaking.
- Parent/child state, failed/cancelled slots, dependency blocking, wave critical path, nested estimate exclusion, unknown bounds, pending, unassigned, and conflicts match sections 4–5.
- Fixed-clock output is byte-stable. Plan, membership, link, and evidence generation changes alter projection revision.
- Plain and JSON projections contain no paths, shell commands, inferred estimates, or raw telemetry.

### WP7 — Artifact-ID router and verified viewers

**Dependencies:** WP3; Pierre baseline from WP0  
**Files:**

- Add `src/artifacts/artifact-router.ts` for exact ID lookup and descriptor verification.
- Add `src/artifacts/verified-copy.ts` for controlled external-viewer copies and lifecycle cleanup.
- Add `src/artifacts/viewer-router.ts` with typed argv tokens and direct shell-free spawn.
- Add `src/artifacts/media-policy.ts` for MIME/role/size/line limits.
- Add `src/artifacts/diff-renderer.ts` using exactly `@pierre/diffs@1.2.12` SSR/vanilla APIs without React.
- Add `src/artifacts/glimpse-viewer.ts` as an artifact-only adapter.
- Remove path/shell action logic from `src/presenter.ts`.
- Add exact `"@pierre/diffs": "1.2.12"` to `dependencies` and update `package-lock.json`.
- Add `test/artifact-router.test.ts`, `test/verified-copy.test.ts`, `test/viewer-router.test.ts`, `test/media-policy.test.ts`, and `test/diff-renderer.test.ts`.

**Viewer policy:**

- Pierre renders bounded read-only patch/multi-file output with validated font family, font size, line height, tab width, theme, line-number, and wrap settings.
- Generated pages use a snapshotted strict CSP, no remote resources, no artifact-provided script/style, disabled link opening, and escaped text-node labels. Artifact data cannot reach `unsafeCSS`.
- Markdown, text, and JSON are escaped. HTML is shown as escaped source, never injected as trusted UI.
- Browser/system routes are explicit executable plus typed argv-token arrays; no shell and no cmux dependency.

**Acceptance criteria:**

- Legacy colon artifact IDs resolve by exact ID. Unknown, traversal, malformed, cross-receipt, symlink-at-each-component, replacement, inode-change, non-file, size, and hash cases fail closed.
- Internal viewers consume verified descriptors; external viewers receive only verified controlled copies. TOCTOU replacement tests cannot alter displayed/spawned bytes.
- Shell spies confirm exact argv and `shell:false`; placeholder interpolation and label injection reject.
- Pierre patch, multi-file, empty, malformed, light/dark, typography, and CSP snapshots match the pinned version.

### WP8 — Terminal-first board and Pi lifecycle

**Dependencies:** WP4, WP6, and WP7  
**Files:**

- Add `src/operator-board.ts` for selection, refresh state, bounded polling, and cancellation.
- Add `src/tui/operator-board-component.ts` implementing Pi component `render`, `handleInput`, `invalidate`, selection, scroll, board/detail mode, and close behavior.
- Add `src/tui/format.ts` for visible-width truncation, relative times, ASCII fallback, and responsive allocation.
- Update `extensions/mission-control/index.ts` to make `/mission` open the TUI board, guard non-TUI modes, and remove the session-start reconciliation timer and Glimpse dashboard path.
- Add `test/operator-board.test.ts`, `test/tui-format.test.ts`, and actual custom-UI lifecycle cases in `test/extension-integration.test.ts`.

**Pi lifecycle contract:**

```ts
await ctx.ui.custom((tui, theme, _keybindings, done) => {
  const component = createOperatorBoardComponent({ theme, done });
  controller.start(() => tui.requestRender());
  component.onInvalidate(() => tui.requestRender());
  return component;
});
controller.stop();
```

The production implementation uses `try/finally` around the returned `Promise`. The factory captures the component, injected `tui`, and `done`; refresh calls injected `tui.requestRender()`. The default board does not use overlay mode or treat `onHandle` as a board window handle.

**Interactions:**

- `↑/↓` or `j/k`: select; `Enter`: item detail/artifact action; `Esc`: return/close; `Tab`: detail section; `r`: refresh; `?`: help.
- The controller refreshes on extension events, explicit `r`, and one bounded interval only while the custom UI promise is open.
- Close, repeated close, async refresh after close, resize, theme change, extension shutdown, and reload are idempotent; all timers and listeners are cancelled.

**Acceptance criteria:**

- `/mission` is one compact board at 120/100/80/79/40 columns and short heights; default open never launches Glimpse.
- Unbound and missing-plan states are useful empty boards and perform no writes.
- Children and artifacts appear only in item detail; artifact actions are ID-only and capability-gated.
- TUI tests exercise the real `ctx.ui.custom()` promise/factory lifecycle, repeated open/close, refresh-after-close, shutdown/reload, and non-TUI/RPC guards.
- Plain/JSON and TUI consume the same projection revision.

### WP9 — End-to-end hardening, documentation, and rollout gate

**Dependencies:** WP5–WP8  
**Files:**

- Add `test/e2e-shared-mission.test.ts`, `test/e2e-crash-recovery.test.ts`, and `test/fixtures/import-maps/**`.
- Add/update ANSI golden fixtures and Pierre HTML/CSP snapshots.
- Update `README.md` with explicit planning/binding examples, persistence compatibility, artifact viewer configuration, empty-board behavior, and removal of Glimpse-dashboard/Quickdiff-shell claims.
- Update `docs/workflow-discovery.md` only with a pointer to this plan.

**Acceptance scenarios:**

1. Two Pi sessions explicitly join one mission, contribute to the same and different items, and retain stable attribution after reload.
2. Both sessions execute task `#1`; canonical identities and details remain distinct.
3. Crashes at every operation/artifact/receipt/link/generation boundary recover idempotently with no duplicate Progress or false success.
4. Separate processes repeatedly read while another writes and never observe a mixed generation.
5. Legacy stores, colon/slash/Unicode IDs, and artifact bytes remain readable and byte-identical after indexing.
6. Wide, compact, narrow, short, empty, missing-plan, unknown-ETA, blocked, conflict, completed, failed, and cancelled projections satisfy ordering and width invariants.
7. Artifact selection resolves by ID; verified bytes reach Pierre/Glimpse/argv viewers; malicious HTML and labels remain inert.
8. Opening and closing `/mission` repeatedly leaves no timer, listener, overlay, or daemon-like polling behind.

## 7. Migration and compatibility

- Initialize additive manifests and directories lazily. Their absence means legacy layout, not corruption.
- Migration reads existing contexts/receipts/artifacts and writes only new indexes/generations/mapping records. It never mutates or renames v1 files.
- Existing `mission:${sessionId}` values remain distinct opaque missions. New plans for them use storage keys, not logical IDs in paths.
- Cross-session consolidation requires an operator mapping containing exact source mission/context/event IDs and target mission/item/session IDs. There is no title/time/cwd inference.
- Existing fuzzy workflow assignments are displayed only as `legacy-unassigned` and cannot affect roadmap state.
- Existing raw `record --context` remains valid evidence storage. It enters default Progress only after an explicit valid link operation.
- Legacy artifact IDs are indexed from receipt contents and remain addressable by ID. No public API accepts their stored path.
- Migrations are resumable operations with idempotency keys, source hashes, and generation commit points. Rollback disables new writers/readers but does not delete additive files or reverse immutable evidence.
- A one-release read-only legacy presenter may be exposed only as an explicitly named troubleshooting command. It cannot feed the new projection or emit path-based actions.

## 8. Test matrix

| Area              | Required coverage                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDs/schema        | New/legacy IDs; colon/slash/Unicode/control/traversal; storage-key collisions; complete public parsers; estimate bounds; parent/dependency cycles; schedule/wave/state invariants |
| Publication       | Stage/copy/hash/fsync/rename boundaries; exact reuse; quarantine; referenced corruption; receipt conflicts; context terminal precedence                                           |
| Operations        | Intent/retryable/committed; deterministic IDs; same/conflicting keys; stale CAS; every crash boundary; no false success; no duplicate `(mission,item,event)`                      |
| Index             | Separate-process generation consistency; pointer/file verification; plan/membership/binding/link/context/evidence revision changes; partial operation visibility                  |
| Binding           | Explicit set/change/clear/fork; membership requirement; reload/resume/branch; stale CAS; concurrent sessions; context-only semantic behavior                                      |
| External identity | Every discriminator; canonical tuple; missing fields; task ID collision; cross-mission/context/session rejection; terminal-effect authorization                                   |
| Projection        | Current/blocked/upcoming order; nested detail; terminal omission; semantic-only Progress; deterministic time/ties; unknown/pending/unassigned/conflict; change provenance         |
| ETA               | Serial/wave sum/max; nested exclusion; missing expected/bounds; failed/cancelled dependencies; blocked values; no elapsed-time inference                                          |
| Artifacts         | Exact ID; legacy ID; symlink each component; replacement/inode race; verified descriptor/copy; argv token validation; label injection; HTML escaping; limits                      |
| Pierre            | Exact 1.2.12 import; patch/multi-file/empty/malformed; light/dark typography; generated CSS/CSP snapshots; no React/unsafe artifact CSS                                           |
| TUI               | 120/100/80/79/40 widths; short heights; visible-width property; ASCII/Unicode; selection/scroll/detail/help; promise/factory lifecycle; cancellation; RPC guards                  |
| E2E               | Two sessions/one mission; shared/different items; colliding task IDs; crash/retry; separate processes; legacy migration; ID-only artifact drilldown                               |

Tests use temporary roots, deterministic clocks/IDs, fault injection, and separate store instances/processes where concurrency is claimed.

## 9. Verification commands

Run after every work package and before rollout:

```bash
npm ci
npm run check
npm test
npm run format:check
git diff --check
```

Focused verification:

```bash
node --test --experimental-strip-types test/mission-validation.test.ts test/storage-key.test.ts
node --test --experimental-strip-types test/artifact-publication.test.ts test/store.test.ts
node --test --experimental-strip-types test/mission-operation-store.test.ts test/mission-index.test.ts
node --test --experimental-strip-types test/session-binding.test.ts test/execution-reconciler.test.ts
node --test --experimental-strip-types test/mission-projection.test.ts test/estimate.test.ts
node --test --experimental-strip-types test/artifact-router.test.ts test/verified-copy.test.ts test/diff-renderer.test.ts
node --test --experimental-strip-types test/operator-board.test.ts test/extension-integration.test.ts
node --test --experimental-strip-types test/e2e-shared-mission.test.ts test/e2e-crash-recovery.test.ts
```

Manual release checks:

- Compare `/mission` hierarchy and density at representative widths/themes against all reference screenshots.
- Bind two real Pi sessions to one mission/item set, reload/resume them, explicitly fork one, and verify persisted attribution/binding history.
- Kill a recording process at each injected publication boundary and verify deterministic recovery.
- Open a real patch, multi-file diff, Markdown, image, and malicious HTML fixture; verify exact bytes, source-only HTML, CSP, and shell-free routing.
- Copy a legacy store, index it, and compare all original file hashes.
- Close the board and verify no timer/listener remains active.

## 10. Rollout

1. **Compatibility foundation:** ship WP0–WP3 behind an opt-in writer flag. Existing presenter remains default; no automatic membership or migration.
2. **Explicit planning surface:** ship WP4 CLI/tools and WP5 exact bindings. Keep the new board disabled. Validate operation recovery and unassigned behavior in real stores.
3. **Projection preview:** expose WP6 plain/JSON projection behind `MISSION_CONTROL_BOARD_V1=1`. Never merge legacy inferred state into it.
4. **Secure artifact protocol:** ship WP7 ID-only router and remove path actions/shell Quickdiff in the same release. Do not permit a mixed path/ID protocol.
5. **Board default:** enable WP8 only after explicit binding, empty-board behavior, ID-only artifacts, custom-UI lifecycle tests, and end-to-end gates pass.
6. **Legacy retirement:** retain an explicitly named read-only legacy troubleshooting view for one compatibility release, then remove it while preserving all legacy readers.

Rollback disables plan mutations and the new projection/board. It never deletes plans, generations, operations, links, bindings, receipts, artifacts, or migration records.

## 11. Risks and mitigations

- **Filesystem multi-record atomicity:** use durable operation intent, immutable prerequisites, one generation-pointer commit point, exact retry verification, and crash-matrix tests.
- **Mixed snapshots:** read one immutable generation under the mission lock and include receipt hashes in projection revision.
- **Legacy hostile IDs:** keep logical IDs out of paths, verify embedded IDs, and index legacy artifact IDs from receipts.
- **Artifact corruption/TOCTOU:** never overwrite published directories; quarantine only proven orphans; consume verified descriptors or controlled copies.
- **Producer omissions:** represent incomplete producer data as unassigned and provide explicit binding commands; never restore fuzzy matching.
- **Binding lifecycle ambiguity:** persist CAS bindings/history by session ID and require explicit fork inheritance.
- **State contradictions:** enforce executable parent/wave/dependency transitions; retain conflicts without last-write-wins or telemetry-driven changes.
- **Schema adoption:** add fields and records first; keep raw legacy recording; require exact binding only for semantic linkage/state effects.
- **Terminal rendering:** property-test visible width and lifecycle cancellation; retain ASCII/text state fallbacks.
- **Viewer hostility:** bound input, escape source, pin CSP and Pierre output, disable artifact scripts/links/styles, and validate typed argv tokens.
- **Pierre drift:** pin exactly `1.2.12`, isolate APIs behind `diff-renderer.ts`, and snapshot output/CSP contracts.
- **Platform viewers:** treat unsupported executable routes as unavailable capabilities rather than falling back to shell commands.

## 12. Explicit non-goals

- No session dashboard, picker, lane/card board, per-session layout, or session-as-navigation model.
- No cmux or terminal-multiplexer integration.
- No daemon, server, global event bus, or always-on reconciliation timer.
- No automatic mission creation, membership, active binding, roadmap generation, ordering, estimates, or change statistics.
- No title, cwd, timestamp, nearest-run, model, or numeric-task-ID fuzzy merging.
- No peer roadmap rows for workflows, subagents, tasks, launches, agent turns, or nested work.
- No raw telemetry in default Progress and no telemetry-authorized plan transition.
- No arbitrary paths/commands in UI actions, trusted artifact HTML, React diff stack, or Glimpse-based main board.
- No overwrite/rewrite of immutable `pi.evidence/v1` receipts or published artifact bytes.
- No forced merge of existing session missions and no inferred import mapping.
