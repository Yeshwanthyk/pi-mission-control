# Review: unified operator board plan

## Verdict

**Reject as implementation-ready; revise before implementation.** The product direction and anti-scope-drift constraints are correct, but the persistence/linking contract still has several correctness blockers and the Pi UI lifecycle is misstated.

## Blockers

1. **No atomic idempotency protocol across receipt/link/operation writes.** The plan says a receipt is written before a link and that retries repair the crash window, but does not define operation states, commit markers, or the ordering that makes `idempotency_key` safe. An operation record durably written before the plan/link can cause a retry to return a false success; written after it can duplicate work. Define an intent/committed/retryable protocol and recovery rules for every boundary. Require idempotency for every mission write (or derive a stable key), and deduplicate `(missionId,itemId,eventId)` rather than only `linkId`.

2. **MissionIndex is not a consistent snapshot.** Reading a revisioned plan plus independently mutable membership, links, contexts, and receipts can mix revisions; a plan revision does not change when evidence arrives. Add a per-mission read generation/manifest or hold the same mission lock for the full read, and expose a projection revision covering plan, links, memberships, bindings, and evidence. Define whether receipt files are immutable snapshots read by event ID and how partial publication is represented.

3. **Legacy IDs are incompatible with the new safe-ID/path contract.** Existing `mission:${sessionId}` IDs are explicitly preserved, while the new contract says IDs are safe identifiers and stores `plans/<missionId>.json`. Current `missionId` validation permits arbitrary non-empty strings and existing artifact IDs are `${eventId}:${index}`. Define opaque-ID encoding for filenames and a legacy artifact-ID resolver; never apply the new safe-ID regex to legacy values. Test colon, slash, Unicode, and malicious legacy IDs without path traversal.

4. **Artifact immutability/crash recovery is underspecified and conflicts with current code.** `MissionStore.snapshotArtifacts()` removes an existing artifact directory before re-snapshotting. A crash after directory rename and before receipt publication therefore cannot be reconciled without potentially replacing an already-published directory. Specify orphan-directory detection, hash/metadata verification, quarantine/repair behavior, and idempotent receipt publication; never delete an immutable directory during retry.

5. **Active mission/item binding has no durable schema.** `mission_record` may rely on a “previously persisted active-item binding,” but no session binding/current-item record or lifecycle is defined. `MissionExecutionBinding` is per tool call and cannot represent an operator changing the active item. Add a versioned session mission/item binding with CAS/history, or require explicit IDs on every record. Define reload, fork, resume, and branch behavior.

6. **External identity is optional and not actually discriminated.** The interface permits ambiguous refs containing no identity or arbitrary combinations, while the prose requires a task tuple and workflow `(producerNamespace, runId)`. Replace it with discriminated unions and canonical identity functions, including canonical project/list/session namespaces. Enforce that binding session/context/mission fields agree and that a linked receipt’s context mission matches the link mission. Do not let `stateEffect` be supplied by an untrusted semantic record unless an exact binding/explicit operator mutation authorizes it.

7. **The schema is incomplete for the required product contract.** `SessionColorToken`, `Operation`, `MissionHeaderView`, `RoadmapRowView`, `ProgressRowView`, `ItemDetailView`, change-stat/provenance types, source snapshot input, and conflict representation are referenced but not defined. The header’s required state, aggregate ETA, change stats, and semantic update age therefore have no implementation contract. Define all public types and their unknown/conflict states before WP1 acceptance.

8. **Plan/item semantics are under-constrained.** Specify whether failed/cancelled top-level items must appear in waves, how nested estimates relate to the owner estimate, whether parent completion requires children, whether child dependencies may cross schedule slots, and how blocked rows are ordered/styled relative to current rows. Do not allow a parent and child to produce double-counted ETA or contradictory terminal states.

9. **Artifact routing still has TOCTOU and compatibility gaps.** `realpath/stat/hash` followed by opening/spawning a path is not an immutable verification boundary if the file can be replaced. Use a verified file descriptor/content or a controlled immutable copy for viewers, and define symlink handling at every path component. Validate argv templates as token arrays with only typed placeholders; never interpolate labels, commands, or paths from UI messages. Keep legacy `eventId:index` artifact IDs resolvable by ID only.

## Corrections

- Define a durable operation state machine and recovery table; serialize it under the mission lock and re-read CAS state after acquiring the lock.
- Add a mission generation/read token and immutable link/index snapshots, or lock the complete `MissionIndex.snapshot()` read. Make projection revision advance for evidence/link changes.
- Separate opaque logical IDs from filesystem names with a reversible encoding or digest map; preserve and test legacy IDs byte-for-byte.
- Change artifact retry behavior to verify/reuse an exact staged/published directory, never remove an existing destination, and record orphan handling.
- Add `MissionSessionBinding` (or eliminate implicit active-item fallback), with explicit mutation, expected revision, durable session-entry compatibility, and no automatic membership.
- Use namespace-specific external-ref unions and canonical tuple builders; require exact identity fields at all link/bind boundaries.
- Complete the view-model and operation/conflict schemas, including explicit `unknown`, `unassigned`, `pending`, and `conflict` values.
- Make item/parent/wave/estimate rules executable validation, including state-effect authorization and no double-counting nested estimates.
- Make artifact resolution consume IDs and verified descriptors/FDs; pin `@pierre/diffs` to an exact tested version in `dependencies` (not only the lockfile). `preloadPatchDiff` and `preloadDiffHTML` exist in the cited source, but the selected version and SSR output/CSP contract still need to be pinned and snapshotted.
- Correct the TUI contract: `ctx.ui.custom()` returns `Promise<T>`, not a live window handle. Capture the component and `tui`/`done` lifecycle in the factory; use `requestRender()` on the injected TUI. `onHandle` is an overlay handle and the default board must not use overlay mode.
- Define no-plan/no-bound-mission behavior as an unassigned/empty board; do not retain the current implicit `mission:${sessionId}` creation on the default board path.

## Missing tests

- Crash matrix for operation intent, plan rename, link publication, receipt publication, artifact-directory rename, and retry; assert no duplicate Progress and no false committed operation.
- Separate-process lock/read tests proving a MissionIndex snapshot cannot mix generations; evidence-only updates must change its projection revision.
- Legacy filename/artifact-ID fixtures with colon, slash, Unicode, malformed IDs, and path traversal attempts; assert all v1 bytes and hashes remain unchanged.
- Artifact replacement/symlink-at-each-component/TOCTOU tests using file descriptors or controlled copies; viewer argv placeholder and label-injection tests.
- Session binding tests for explicit bind, change-item, reload, fork, resume, stale CAS, and concurrent sessions; context-only semantic recording must remain unassigned or fail as specified.
- External-ref discriminator and canonical tuple tests, including missing list/project/session/run fields and cross-mission receipt links.
- Parent/child ETA and state transition tests, cancelled/failed wave membership, dependency-slot violations, blocked ordering, and state-effect authorization/conflicts.
- Projection revision tests for plan, membership, evidence, and link updates; conflict/pending/unassigned rendering tests.
- Pi integration tests using the actual `ctx.ui.custom()` Promise/factory lifecycle, repeated open/close, async refresh after close, session shutdown/reload, and non-TUI mode guards.
- Pierre tests should import the exact pinned version, snapshot generated inline CSS/CSP requirements, and test both patch and multi-file/empty/malformed diff inputs.

## Sequencing issues

1. **WP3 precedes WP7 but requires an explicit mission/item selection mechanism.** Move the session-binding command/tool and its persistence contract into WP1/WP2 or move the extension binding work after that interface exists. Do not ship an extension that has an “active item” concept without a scriptable, durable way to set it.
2. **WP2 changes legacy store behavior before the crash/recovery contract is specified.** Finalize operation/artifact publication semantics and compatibility fixtures before implementing store changes; otherwise “byte-identical” and retry guarantees cannot be proven.
3. **WP4 depends on WP3 while WP3 still relies on legacy task/workflow observations.** Define exact producer adapters and their unavailable-identity behavior before projection acceptance; otherwise projection tests will encode accidental telemetry inference.
4. **WP6 is listed as parallel with WP5 but its viewer protocol is part of item detail.** Freeze the artifact-ID/capability contract and router tests before WP5 drills into artifacts; integrate the component only after the router’s verified descriptor lifecycle is complete.
5. **WP7 depends on WP6 although CLI plan/link operations do not need viewers.** Split CLI plan/membership/link commands after WP2/WP4 from viewer configuration/documentation, or accept unnecessary serialization. Keep the board default blocked until WP5 and the explicit binding path are complete.
6. **Rollout stage 3 says the board becomes default before the plan states a defined no-plan behavior and before stage-4 artifact routing removes the old path protocol.** Gate the board on explicit plan/binding availability and ship ID-only action handling before any board release that can emit artifact actions; do not operate a mixed path/ID protocol.
7. **The current extension starts a one-second reconciliation timer at session start.** The revised plan requires a bounded timer only while the board is open; move timer ownership into the board controller and test shutdown/close cancellation so this does not become an always-on daemon-like poller.
