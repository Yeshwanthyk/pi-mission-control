# Workflow discovery findings

## Scope and recommendation

Do not extend the current Glimpse dashboard. Replace the default `/mission` surface with one compact, terminal-first operator board, and keep Glimpse as an artifact-only viewer. The board is a projection of explicit planning data plus immutable evidence; it must never infer mission membership, roadmap order, estimates, completion, or cross-session identity from titles or timing.

The reference images establish three visual contracts:

- A single mission header: title, state, aggregate ETA, and change statistics (`+978/-115` in the reference).
- Roadmap first: active item(s), then upcoming items in explicit plan order, with cumulative ETA (`4m`, `12m`, `18m`, …), not just per-item duration.
- Progress second: completed semantic items newest-first, relative times, short summaries, and committed artifact counts (`8 screenshots`, `14 tests`, `1 link`, `1 diff`).

The 172x279 reference is a narrow/compact state, not a separate product. It shows the same board compressed to a single column with no execution cards or session picker.

## Current-state findings

- `src/presenter.ts:52-107` computes progress from observed task/child-context counts. It has no plan, ETA, change-stat, roadmap order, item identity, or honest unknown state. It renders a large two-column Glimpse dashboard (`src/presenter.ts:301-401`) with separate Roadmap, Executions, and Evidence sections, which conflicts with the corrected vision.
- `src/presenter.ts:394-396` puts tasks and workflow agents into peer roadmap rows and exposes every child context as a peer execution card. Child work must instead nest under its owning roadmap item and remain hidden from default Progress.
- `src/projections.ts:53-55` keys observed tasks by numeric `id`; `src/projections.ts:135-153` sorts numerically. IDs can collide across sessions and there is no mission/item namespace. This cannot be the board's identity model.
- `src/source-adapter.ts:58-84` assigns workflow contexts to runs by nearest start time within 30 seconds. `README.md:140-141` documents this limitation. That fuzzy correlation must not feed cross-session board membership; new board data requires explicit `missionId` + `itemId` links.
- `src/types.ts:8-21` has `missionId` on contexts, but there is no roadmap item, plan order, estimate, schedule model, session display identity/color, or artifact summary contract. `EvidenceMilestone.parentId` is an untyped string only (`src/types.ts:53-60`).
- `src/store.ts:110-147` correctly validates the context and publishes immutable `pi.evidence/v1` receipts after artifact snapshotting. `src/store.ts:221-295` hashes copied artifacts and preserves source paths. This durability/readability must remain unchanged.
- The current artifact boundary is too weak for the new UI: the page receives paths and sends them back (`src/presenter.ts:129-132`), while `isArtifactPath` only checks lexical containment (`src/presenter.ts:238-247`). Artifact actions must accept artifact IDs and resolve the receipt/artifact server-side.
- `src/presenter.ts:260-276` builds `quickdiff` shell commands and launches `sh -lc`; this violates the shell-free argv routing requirement even though `shellQuote` reduces one injection vector. All viewer commands need direct executable + argv spawning.
- `glimpseui` receives HTML and can evaluate JavaScript (`node_modules/glimpseui/src/glimpse.mjs`, `GlimpseWindow.send`/`setHTML`). It is appropriate for a focused artifact viewer, but not as the primary board and not as a trusted HTML renderer for arbitrary artifact content.
- Existing baseline is healthy: `npm run check`, `npm test` (13 tests), and `npm run format:check` all pass.

## Proposed information architecture

### Default board

One `OperatorBoardViewModel` renders these regions in order:

1. **Mission header**: mission title; state (`active`, `blocked`, `settled`, `failed`); aggregate ETA only when explicit schedule inputs are sufficient; committed change statistics only when derived from a known diff artifact or explicit payload; compact update age.
2. **Roadmap**: current item(s) first, then pending items in `planOrder`. Each row contains state marker, title, cumulative ETA, and compact attribution (`session name` + stable color marker). Multiple current items are allowed only when the plan declares parallel scheduling.
3. **Progress**: completed semantic items newest-first. Each row contains title, relative time, and a summary generated only from its receipt artifacts/payload. Examples: `8 screenshots`, `14 tests`, `1 link`, `1 diff`. Raw launch/turn/task telemetry is excluded.
4. **Selection/help line**: keyboard affordances and explicit empty/unknown states.

No lane/card board, execution panel, session picker, cmux integration, or per-session layout is part of the default surface.

### Responsive terminal states

- **Wide (>=100 columns)**: header plus roadmap and progress with aligned ETA/attribution columns; detail navigation remains in the same custom component.
- **Compact (80-99 columns)**: single unified column, shortened titles, ETA retained, attribution reduced to color/name initials; roadmap and Progress remain visibly distinct.
- **Narrow (<80 columns)**: header collapses to title/state/ETA; show current item(s), then a bounded roadmap slice and newest Progress rows; use scrolling for the rest. Never wrap a row into ambiguous multiple semantic rows.
- **Very short height**: preserve header/current item and add `n more` indicators; do not fabricate hidden progress or change the ordering.

All renderers must truncate/wrap against the supplied width. TUI rows must have stable selection, visible focus, and a non-color state indicator. Use Unicode markers when supported and ASCII fallbacks where needed.

### Drilldown

`Enter` on a roadmap item opens an in-place detail state, not a new peer panel. The detail shows the item's explicit estimate/state, owning session attribution, nested child workflows/subagents/tasks, latest semantic milestones, and artifact summaries/actions. `Esc` returns to the board. Child work is never promoted to a roadmap row. A receipt with no explicit item link is not attached by title; it remains legacy/unassigned and is not shown as planned progress.

## Contract and persistence proposal

Add versioned planning contracts without rewriting `pi.evidence/v1` or `pi.mission-context/v1`:

- `src/plan-types.ts`: `MissionPlan`, `RoadmapItem`, `PlanEstimate`, `PlanSchedule`, `SessionAttribution`, `PlanState`, and `RoadmapItemId`. Every item has `{ missionId, itemId, planOrder, title, state }`; estimates are optional and explicit. Add `parentItemId` only for child nesting, never for peer roadmap ordering.
- `src/plan-validation.ts`: boundary parser for a versioned `pi.mission-plan/v1` document. Reject duplicate `(missionId,itemId)`, duplicate `planOrder`, missing mission IDs, invalid estimate units, and child links to a different mission. Validate schedule mode (`serial`/`parallel`) before aggregate ETA calculation.
- `src/plan-store.ts`: atomic plan/attribution persistence under a new `plans/` (or versioned `mission-plans/`) directory. Reuse atomic writes and per-mission locks; do not mutate existing contexts, receipts, or artifact files.
- `src/types.ts` / validation: add optional `missionId` and `itemId` links to newly recorded milestones as additive fields, or introduce a versioned receipt/milestone union if the current public shape cannot safely accept them. Existing v1 receipts remain readable and are treated as legacy/unassigned when item membership is absent. New completed roadmap evidence must carry both IDs.
- `src/context-prompt.ts` and `extensions/mission-control/index.ts`: extend the producer contract with explicit item linkage (`missionId`, `itemId`) and make omission visible as unassigned evidence; never infer from title. Child prompt prefixes should carry the owning item only when the parent explicitly has one.
- `src/session-attribution.ts`: persist stable session name/color per `(missionId, sessionId)`. Generate a deterministic color from the stable session ID only once, reserve contrast-safe palette entries, and never use color as the sole state signal.

Compatibility rule: old contexts and `pi.evidence/v1` receipts remain readable and immutable. A migration/import command may explicitly map legacy records to item IDs, but there is no title, timestamp, or numeric-task-ID fuzzy migration. Legacy records can appear in an explicitly labeled unassigned view/detail, never as planned Progress.

## Projection/view-model design

Add `src/board-projection.ts` with a pure projection boundary:

- Input: one `MissionPlan`, all contexts/receipts explicitly filtered by `missionId`, explicit source links, session attribution records, and a clock for deterministic relative-time tests.
- Output: `OperatorBoardViewModel` containing header, ordered roadmap rows, completed Progress rows, nested child details, artifact summaries, and capability/unknown markers.
- Join keys: `(missionId,itemId)` for roadmap/evidence; `(missionId,sessionId)` for attribution; `(missionId,contextToken)` for execution ownership. Never title-match, time-match, or numeric-ID-match across sessions.
- Roadmap state comes from the plan and explicit item-linked terminal receipts, with a documented precedence rule for conflicts. A child receipt may update its parent detail but cannot complete the parent without an explicit parent-item policy.
- ETA: show a cumulative value only when the plan has explicit estimates for the required items and an explicit schedule mode. If an estimate is absent or schedule inputs are incomplete, render `ETA —` / `estimate not set`; do not convert task counts or wall-clock telemetry into time.
- Change stats: derive only from committed diff artifacts via a bounded parser or from explicitly declared receipt payload fields. Include provenance in the view model; unknown/unparseable artifacts remain `n/a`.
- Artifact summaries count committed `EvidenceArtifact` entries by media type/role and use receipt payload only when schema-validated. Do not count raw tool turns, launch receipts, or file names heuristically.
- Progress sorts by semantic milestone `occurredAt` descending, then stable event ID; it never exposes raw task/launch/agent-turn telemetry by default.

`src/projections.ts` should remain a source adapter for legacy task/workflow observations, not the board's final model. Add explicit task/workflow mapping adapters keyed by mission/item IDs. The existing time-based `assignWorkflowContexts` must be removed from the board path; if retained for compatibility, mark its result legacy/unassigned and never merge it into a mission roadmap.

## Terminal-first presenter

Add `src/operator-board.ts` and `src/tui/operator-board-component.ts` (or equivalent focused modules) and change the `/mission` command in `extensions/mission-control/index.ts`:

- In `ctx.mode === "tui"`, call `ctx.ui.custom()` and keep a live component handle. The factory receives `tui`, `theme`, `keybindings`, and `done`; async store/projection refreshes update immutable view-model state, call `component.invalidate()`, and call `handle.requestRender()`.
- Use `@earendil-works/pi-tui` components/utilities (`Container`, `Text`, `DynamicBorder`, `matchesKey`, `truncateToWidth`, `visibleWidth`) rather than HTML. Follow Pi's component contract: every rendered line <= width; implement `invalidate()`; call `tui.requestRender()` after input/state changes; use theme callbacks so theme changes are reflected.
- Handle `up/down`, `enter`, `escape`, `tab`/detail navigation, and an explicit refresh key. Do not steal editor focus after `done()`; abort/close must be idempotent.
- In non-TUI modes, expose the same `OperatorBoardViewModel` through the existing status/JSON/CLI projection. `ctx.mode === "rpc"` must not call `custom()`; `json`/`print` must not claim an interactive board.
- Preserve the footer status as a compact count only; it is not a second dashboard.
- Replace the current `GlimpseModuleAdapter` role with an artifact-only presenter. Glimpse close/focus lifecycle tests remain useful but must no longer test the main mission board.

Pi API constraints confirmed in local docs: `ctx.ui.custom()` temporarily replaces the editor until `done()`; it returns `undefined` in RPC mode; components need `render`, `handleInput`, and `invalidate`; overlay mode is optional and should not be used for the default board. See Pi `docs/extensions.md` Custom UI and `docs/tui.md` Component Interface/Custom Components.

## Artifact-only Glimpse/router path

Add:

- `src/artifact-router.ts`: parse/validate `{ action, artifactId }`, resolve `artifactId` through the store/receipt index, verify the resolved path is a regular immutable artifact under the artifact root, and return a typed `ResolvedArtifact`. No path from the browser is accepted.
- `src/viewer-routes.ts`: configurable `ViewerRoute` values as direct executable + argv arrays. Use `spawn(executable, argv, { shell: false })`/stream pipes. Defaults must not use `sh -lc`, `cmd /c`, or string interpolation. Quickdiff is a direct process with `--stdin` and a readable stream; a terminal emulator, if supported, is an explicit configured argv route.
- `src/artifact-viewer.ts`: media policy and size limits. Small text/Markdown/JSON can be rendered in TUI; images/video/PDF/large text can open the focused Glimpse artifact window; HTML is source-viewed escaped by default, never navigated as trusted page content. External open is an explicit action and route, not the default.
- `src/diff-viewer.ts`: read-only diff rendering using `@pierre/diffs` vanilla + SSR entry points. Prefer `preloadPatchDiff`/`preloadDiffHTML` on the server side and hydrate with the vanilla `FileDiff` only if interaction is required. Keep the Glimpse page static and use a strict CSP; dynamic artifact text goes through DOM text APIs, not raw `innerHTML` templates.

`@pierre/diffs` current source is at commit `4f94a5e765195b27e1e4188b943aab2ae44613cb` in `pierrecomputer/pierre/packages/diffs`. Its package exports vanilla, `ssr`, and `worker` entry points; SSR builds HAST HTML using `hast-util-to-html`, and `preloadPatchDiff` returns `prerenderedHTML`. The React entry is unnecessary for this project. The library still renders HTML/shadow DOM and permits `unsafeCSS`, so treat generated content/CSS as a controlled boundary, pin/configure themes and omit unsafe CSS from artifact data. Add the dependency explicitly and test the selected version rather than assuming the package is present.

Glimpse specifics from installed `glimpseui` 0.8.1: `open()` accepts HTML and `openLinks`; the page bridge accepts arbitrary JSON messages and `send(js)` evaluates JavaScript. Use `openLinks: false` for artifact viewers unless an explicit external-link action is requested, never use `loadFile()` for untrusted HTML, and keep the message protocol to typed artifact IDs/actions.

## Accessibility and readability requirements

- State is conveyed by marker + text, never color alone. Session attribution color is paired with stable short name/initials.
- TUI selection is visibly focused, keyboard help is always available in the component, and all content is reachable without mouse/Unicode support.
- Long titles, file names, and artifact labels truncate with a visible ellipsis; timestamps use relative time plus a detail-view absolute timestamp.
- Respect Pi theme colors and invalidation; include high-contrast and reduced-motion behavior in the Glimpse viewer. Do not rely on CSS `color-mix` or unsupported terminal glyphs for essential meaning.
- Glimpse artifact HTML uses semantic headings/buttons, focus-visible styles, keyboard activation, and an `aria-live` status for loading/error. Arbitrary artifact HTML is rendered as text/source, not as executable document markup.
- Bound artifact size/line count and show an explicit “too large; open externally” action rather than freezing the board.

## Phased work packages and dependencies

### Phase 0 — contracts and compatibility (blocks all UI work)

**Files/modules:** `src/plan-types.ts`, `src/plan-validation.ts`, `src/types.ts`, `src/validation.ts`, `src/plan-store.ts`, `src/session-attribution.ts`.

**Acceptance:** versioned plan documents parse; explicit mission/item IDs are required for new planned evidence; duplicate/order/mission violations reject; existing v1 context/receipt fixtures read unchanged; atomic writes and per-mission locks are covered.

**Tests:** schema validation, legacy-read fixtures, concurrent plan writes, migration/import requiring explicit mapping, stable attribution/color fixtures.

### Phase 1 — deterministic board projection (depends on Phase 0)

**Files/modules:** `src/board-projection.ts`, `src/operator-board.ts`, adapters under `src/projections.ts` and `src/source-adapter.ts`.

**Acceptance:** same input + clock produces byte-stable view model; current/upcoming ordering and cumulative ETA are explicit; parallel current items require declared schedule mode; child work nests; missing estimates/membership show unknown/unassigned; no fuzzy joins; committed artifact summaries and diff stats have provenance.

**Tests:** multiple sessions contributing to one item, colliding numeric task IDs, same titles in different items, out-of-order receipts, missing/partial estimates, unknown media, malformed legacy data, and no telemetry leakage.

### Phase 2 — terminal operator board (depends on Phase 1)

**Files/modules:** `src/tui/operator-board-component.ts`, `src/operator-board.ts`, `extensions/mission-control/index.ts`, `test/operator-board.test.ts`.

**Acceptance:** `/mission` opens one `ctx.ui.custom()` board in TUI; wide/compact/narrow/short states preserve semantic order; keyboard drilldown and refresh work; theme invalidation and line-width invariants hold; non-TUI modes use the shared view model without invoking TUI APIs.

**Tests:** fake Pi TUI/theme, render width property tests, keyboard state transitions, async refresh race/close idempotence, empty/unknown/error states, RPC/print guards.

### Phase 3 — artifact router and viewers (depends on Phase 0; diff viewer can proceed independently of Phase 2)

**Files/modules:** `src/artifact-router.ts`, `src/viewer-routes.ts`, `src/artifact-viewer.ts`, `src/diff-viewer.ts`, focused changes to `src/presenter.ts`, `package.json`/lockfile.

**Acceptance:** board emits artifact IDs only; server resolves and verifies them; direct argv routing works on supported platforms; no shell invocation; diff artifacts render readably with configurable typography; HTML/text cannot become trusted UI; Glimpse is not needed to view the board.

**Tests:** artifact ID lookup, traversal/symlink/missing-file rejection, hash/size mismatch behavior, argv exactness and no-shell spy, media policy, escaped HTML, Pierre SSR snapshots, large diff limits, Glimpse fake adapter lifecycle.

### Phase 4 — migration, integration, and visual QA (depends on Phases 1–3)

**Files/modules:** explicit migration/import command, README compatibility section, extension integration tests, visual fixtures under `test/fixtures/`.

**Acceptance:** old stores open without rewrite; unmapped evidence is visibly unassigned and excluded from planned progress; explicit attach/map makes it eligible; multiple Pi sessions update the same item without title matching; reference compact/wide fixtures are recognizable and readable.

**Tests/commands:** `npm run check`, `npm test`, `npm run format:check`, plus a TUI snapshot/ANSI harness and Glimpse artifact-viewer smoke test on macOS (and route/parser tests on other platforms).

## Risks and explicit non-goals

**Risks:** plan persistence introduces a second durable schema and concurrent writers; explicit item links require producer/prompt changes or honest unassigned states; TUI rendering must handle terminal resize and theme invalidation; SSR diff HTML increases artifact viewer complexity; system viewers vary by platform; artifact content may be malicious even though the local user is the trust boundary.

**Non-goals:** no session dashboard, session picker, lane/card board, cmux integration, per-session layout, automatic roadmap inference, title/timestamp fuzzy merging, fabricated ETA/change counts, raw telemetry in default Progress, trusted arbitrary HTML rendering, or a producer-specific workflow/task rewrite beyond additive linkage and adapters.

## Verification evidence

Baseline commands passed before implementation planning:

- `npm run check`
- `npm test` — 13 passing tests
- `npm run format:check`
