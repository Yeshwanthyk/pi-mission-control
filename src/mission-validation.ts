import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";
import type {
  ArgvToken,
  CanonicalExternalIdentity,
  ChangeStat,
  EvidenceStateEffect,
  EvidenceSummary,
  ExternalViewerRoute,
  MissionEvidenceLink,
  MissionExecutionBinding,
  MissionExternalRef,
  MissionGeneration,
  MissionGenerationPointer,
  MissionOperation,
  MissionPlan,
  MissionSchedule,
  MissionSessionAttribution,
  MissionSessionBinding,
  MissionState,
  PlanEstimate,
  RoadmapItem,
  SessionColorToken,
  StorageKey,
} from "./mission-types.ts";

export class MissionContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionContractError";
    this.code = code;
  }
}

const STATES: readonly MissionState[] = [
  "planned",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];
const COLORS: readonly SessionColorToken[] = [
  "blue",
  "cyan",
  "green",
  "magenta",
  "orange",
  "purple",
  "red",
  "teal",
  "yellow",
];
const TERMINAL = new Set<MissionState>(["completed", "failed", "cancelled"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export function validateNewLogicalId(
  value: unknown,
  label = "logical ID",
): string {
  const id = requiredText(value, label);
  if (Buffer.byteLength(id, "utf8") > 512 || CONTROL.test(id)) {
    fail(
      "INVALID_LOGICAL_ID",
      `${label} must be <=512 UTF-8 bytes without controls`,
    );
  }
  return id;
}

export function storageKey(namespace: string, logicalId: string): StorageKey {
  const safeNamespace = requiredText(namespace, "storage namespace");
  const hash = createHash("sha256")
    .update(safeNamespace)
    .update("\0")
    .update(logicalId)
    .digest("hex");
  return `k_${hash}`;
}

export function verifyStorageIdentity(
  namespace: string,
  logicalId: string,
  key: string,
): void {
  if (storageKey(namespace, logicalId) !== key) {
    fail("STORAGE_KEY_MISMATCH", `embedded logical ID does not match ${key}`);
  }
}

export function canonicalExternalIdentity(
  ref: MissionExternalRef | unknown,
): CanonicalExternalIdentity {
  const parsed = parseExternalRef(ref);
  const tuple = externalTuple(parsed);
  const framed = tuple
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("");
  return `xref:${createHash("sha256").update(framed).digest("hex")}`;
}

export function parseExternalRef(value: unknown): MissionExternalRef {
  const input = record(value, "external ref");
  const kind = requiredText(input.kind, "externalRef.kind");
  const producerNamespace = validateNewLogicalId(
    input.producerNamespace,
    "externalRef.producerNamespace",
  );
  if (kind === "pi-task") {
    return exact(
      input,
      [
        "kind",
        "producerNamespace",
        "projectRoot",
        "listId",
        "sessionId",
        "taskId",
        "executionId",
      ],
      {
        kind,
        producerNamespace,
        projectRoot: requiredText(input.projectRoot, "externalRef.projectRoot"),
        listId: validateNewLogicalId(input.listId, "externalRef.listId"),
        sessionId: validateNewLogicalId(
          input.sessionId,
          "externalRef.sessionId",
        ),
        taskId: validateNewLogicalId(input.taskId, "externalRef.taskId"),
        executionId: validateNewLogicalId(
          input.executionId,
          "externalRef.executionId",
        ),
      },
    );
  }
  if (kind === "pi-workflow") {
    return exact(input, ["kind", "producerNamespace", "runId"], {
      kind,
      producerNamespace,
      runId: validateNewLogicalId(input.runId, "externalRef.runId"),
    });
  }
  if (kind === "pi-subagent") {
    return exact(
      input,
      ["kind", "producerNamespace", "sessionId", "executionId"],
      {
        kind,
        producerNamespace,
        sessionId: validateNewLogicalId(
          input.sessionId,
          "externalRef.sessionId",
        ),
        executionId: validateNewLogicalId(
          input.executionId,
          "externalRef.executionId",
        ),
      },
    );
  }
  if (kind === "other") {
    if (!Array.isArray(input.identity) || input.identity.length === 0) {
      fail(
        "INVALID_EXTERNAL_IDENTITY",
        "other identity must be a non-empty tuple",
      );
    }
    const identity = input.identity.map((part, index) =>
      validateNewLogicalId(part, `externalRef.identity[${index}]`),
    );
    const first = identity[0];
    if (first === undefined)
      fail("INVALID_EXTERNAL_IDENTITY", "identity is empty");
    return exact(input, ["kind", "producerNamespace", "identity"], {
      kind,
      producerNamespace,
      identity: [first, ...identity.slice(1)],
    });
  }
  return fail("INVALID_EXTERNAL_REF", `unsupported external ref kind: ${kind}`);
}

export function parseMissionPlan(value: unknown): MissionPlan {
  const input = record(value, "mission plan");
  schema(input, "pi.mission-plan/v1");
  const missionId = validateNewLogicalId(input.missionId, "missionId");
  const schedule = parseSchedule(input.schedule);
  if (!Array.isArray(input.items))
    fail("INVALID_PLAN", "items must be an array");
  const plan: MissionPlan = {
    schema: "pi.mission-plan/v1",
    missionId,
    title: requiredText(input.title, "title"),
    ...optionalTextField(input, "description"),
    state: missionState(input.state, "state"),
    revision: nonNegativeInteger(input.revision, "revision"),
    schedule,
    items: input.items.map(parseRoadmapItem),
    createdAt: timestamp(input.createdAt, "createdAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt"),
  };
  validatePlanInvariants(plan);
  return plan;
}

export function validatePlanInvariants(plan: MissionPlan): void {
  const byId = new Map<string, RoadmapItem>();
  const orders = new Set<number>();
  for (const item of plan.items) {
    if (byId.has(item.itemId)) fail("DUPLICATE_ITEM_ID", item.itemId);
    if (orders.has(item.order))
      fail("DUPLICATE_ITEM_ORDER", String(item.order));
    byId.set(item.itemId, item);
    orders.add(item.order);
  }
  for (const item of plan.items) {
    if (item.parentItemId && !byId.has(item.parentItemId)) {
      fail("UNKNOWN_PARENT", `${item.itemId} -> ${item.parentItemId}`);
    }
    for (const dependency of item.dependencyItemIds) {
      if (!byId.has(dependency))
        fail("UNKNOWN_DEPENDENCY", `${item.itemId} -> ${dependency}`);
      if (dependency === item.itemId) fail("DEPENDENCY_CYCLE", item.itemId);
    }
  }
  assertAcyclic(
    plan.items,
    (item) => (item.parentItemId ? [item.parentItemId] : []),
    "PARENT_CYCLE",
  );
  assertAcyclic(
    plan.items,
    (item) => item.dependencyItemIds,
    "DEPENDENCY_CYCLE",
  );
  const owner = (item: RoadmapItem): RoadmapItem => {
    let current = item;
    const seen = new Set<string>();
    while (current.parentItemId) {
      if (seen.has(current.itemId)) fail("PARENT_CYCLE", current.itemId);
      seen.add(current.itemId);
      const parent = byId.get(current.parentItemId);
      if (!parent) fail("UNKNOWN_PARENT", current.parentItemId);
      current = parent;
    }
    return current;
  };
  for (const item of plan.items) {
    const top = owner(item);
    if (item.parentItemId) {
      if (item.estimate?.scope === "schedule")
        fail("NESTED_ESTIMATE_SCOPE", item.itemId);
      for (const dependencyId of item.dependencyItemIds) {
        const dependency = byId.get(dependencyId);
        if (!dependency || owner(dependency).itemId !== top.itemId) {
          fail("CROSS_SLOT_DEPENDENCY", `${item.itemId} -> ${dependencyId}`);
        }
      }
    } else if (item.estimate?.scope === "included-in-parent") {
      fail("TOP_LEVEL_ESTIMATE_SCOPE", item.itemId);
    }
    for (const dependencyId of item.dependencyItemIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      if (
        isAncestor(item.itemId, dependency, byId) ||
        isAncestor(dependencyId, item, byId)
      ) {
        fail("DEPENDENCY_HIERARCHY", `${item.itemId} -> ${dependencyId}`);
      }
    }
    const descendants = plan.items.filter((candidate) =>
      isAncestor(item.itemId, candidate, byId),
    );
    if (
      item.state === "completed" &&
      descendants.some(
        (child) =>
          !TERMINAL.has(child.state) ||
          child.state === "failed" ||
          (child.state === "cancelled" && !child.exclusionReason),
      )
    ) {
      fail("PARENT_STATE_CONFLICT", item.itemId);
    }
    if (
      (item.state === "failed" || item.state === "cancelled") &&
      descendants.some((child) => !TERMINAL.has(child.state))
    ) {
      fail("PARENT_STATE_CONFLICT", item.itemId);
    }
  }
  validateSchedule(
    plan.schedule,
    [...byId.values()].filter((item) => !item.parentItemId),
    byId,
  );
}

export function assertMissionTransition(
  from: MissionState,
  to: MissionState,
): void {
  if (from === to) return;
  const allowed: Readonly<Record<MissionState, readonly MissionState[]>> = {
    planned: ["active", "cancelled"],
    active: ["blocked", "completed", "failed", "cancelled"],
    blocked: ["active", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to))
    fail("ILLEGAL_STATE_TRANSITION", `${from} -> ${to}`);
}

export function normalizedRequestDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseEvidenceSummary(value: unknown): EvidenceSummary {
  const input = record(value, "evidence summary");
  const allowed = [
    "tests",
    "screenshots",
    "links",
    "diffs",
    "videos",
    "logs",
    "diagrams",
  ] as const;
  rejectUnknown(input, allowed);
  const output: Partial<Record<(typeof allowed)[number], number>> = {};
  for (const key of allowed) {
    if (input[key] !== undefined)
      output[key] = nonNegativeInteger(input[key], `summary.${key}`);
  }
  return output;
}

export function parseSessionAttribution(
  value: unknown,
): MissionSessionAttribution {
  const input = record(value, "mission session");
  schema(input, "pi.mission-session/v1");
  const colorText = requiredText(input.color, "color");
  const color = COLORS.find((candidate) => candidate === colorText);
  if (!color) fail("INVALID_COLOR", colorText);
  return {
    schema: "pi.mission-session/v1",
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    sessionId: validateNewLogicalId(input.sessionId, "sessionId"),
    displayName: requiredText(input.displayName, "displayName"),
    initials: requiredText(input.initials, "initials"),
    color,
    firstSeenAt: timestamp(input.firstSeenAt, "firstSeenAt"),
    lastSeenAt: timestamp(input.lastSeenAt, "lastSeenAt"),
    revision: nonNegativeInteger(input.revision, "revision"),
  };
}

export function parseSessionBinding(value: unknown): MissionSessionBinding {
  const input = record(value, "session binding");
  schema(input, "pi.mission-session-binding/v1");
  const state = input.state;
  if (state !== "bound" && state !== "unbound")
    fail("INVALID_BINDING", "invalid state");
  const missionId = optionalLogicalId(input.missionId, "missionId");
  const itemId = optionalLogicalId(input.itemId, "itemId");
  if (state === "bound" && (!missionId || !itemId))
    fail("INVALID_BINDING", "bound requires missionId and itemId");
  if (state === "unbound" && (missionId || itemId))
    fail("INVALID_BINDING", "unbound cannot name mission/item");
  const changedBy = input.changedBy;
  if (changedBy !== "operator" && changedBy !== "explicit-fork")
    fail("INVALID_BINDING", "invalid changedBy");
  return {
    schema: "pi.mission-session-binding/v1",
    sessionId: validateNewLogicalId(input.sessionId, "sessionId"),
    revision: nonNegativeInteger(input.revision, "revision"),
    state,
    ...defined("missionId", missionId),
    ...defined("itemId", itemId),
    changedAt: timestamp(input.changedAt, "changedAt"),
    changedBy,
    ...defined(
      "previousRevision",
      optionalNonNegativeInteger(input.previousRevision, "previousRevision"),
    ),
  };
}

export function parseExecutionBinding(value: unknown): MissionExecutionBinding {
  const input = record(value, "execution binding");
  schema(input, "pi.mission-execution-binding/v1");
  const externalRef = parseExternalRef(input.externalRef);
  const identity = canonicalExternalIdentity(externalRef);
  if (input.canonicalIdentity !== identity)
    fail("EXTERNAL_IDENTITY_MISMATCH", "canonical identity differs");
  const state = input.state;
  if (
    state !== "intent" &&
    state !== "bound" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    fail("INVALID_EXECUTION_STATE", String(state));
  }
  return {
    schema: "pi.mission-execution-binding/v1",
    bindingId: validateNewLogicalId(input.bindingId, "bindingId"),
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    itemId: validateNewLogicalId(input.itemId, "itemId"),
    sessionId: validateNewLogicalId(input.sessionId, "sessionId"),
    parentContextToken: requiredText(
      input.parentContextToken,
      "parentContextToken",
    ),
    ...optionalTextField(input, "childContextToken"),
    toolCallId: validateNewLogicalId(input.toolCallId, "toolCallId"),
    externalRef,
    canonicalIdentity: identity,
    state,
    revision: nonNegativeInteger(input.revision, "revision"),
    createdAt: timestamp(input.createdAt, "createdAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt"),
  };
}

export function parseEvidenceLink(value: unknown): MissionEvidenceLink {
  const input = record(value, "evidence link");
  schema(input, "pi.mission-evidence-link/v1");
  const classification = input.classification;
  if (
    classification !== "semantic" &&
    classification !== "execution" &&
    classification !== "telemetry"
  )
    fail("INVALID_CLASSIFICATION", String(classification));
  const changeStats = Array.isArray(input.changeStats)
    ? input.changeStats.map(parseChangeStat)
    : fail("INVALID_CHANGE_STATS", "must be an array");
  return {
    schema: "pi.mission-evidence-link/v1",
    linkId: validateNewLogicalId(input.linkId, "linkId"),
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    itemId: validateNewLogicalId(input.itemId, "itemId"),
    eventId: requiredText(input.eventId, "eventId"),
    sessionId: validateNewLogicalId(input.sessionId, "sessionId"),
    classification,
    stateEffect: parseStateEffect(input.stateEffect),
    ...(input.summary === undefined
      ? {}
      : { summary: parseEvidenceSummary(input.summary) }),
    changeStats,
    createdAt: timestamp(input.createdAt, "createdAt"),
  };
}

export function parseMissionOperation(value: unknown): MissionOperation {
  const input = record(value, "mission operation");
  schema(input, "pi.mission-operation/v1");
  const kinds = [
    "plan-create",
    "plan-mutate",
    "session-upsert",
    "binding-set",
    "binding-fork",
    "execution-bind",
    "evidence-record-link",
    "evidence-link",
    "migration-index",
  ] as const;
  const kind = requiredText(input.kind, "kind");
  const selectedKind = kinds.find((candidate) => candidate === kind);
  if (!selectedKind) fail("INVALID_OPERATION_KIND", kind);
  const state = input.state;
  if (state !== "intent" && state !== "retryable" && state !== "committed")
    fail("INVALID_OPERATION_STATE", String(state));
  if (!Array.isArray(input.publications))
    fail("INVALID_PUBLICATIONS", "must be an array");
  const publications = input.publications.map((entry) => {
    if (
      entry !== "artifacts" &&
      entry !== "receipt" &&
      entry !== "generation" &&
      entry !== "binding-history"
    )
      fail("INVALID_PUBLICATION", String(entry));
    return entry;
  });
  return {
    schema: "pi.mission-operation/v1",
    operationId: validateNewLogicalId(input.operationId, "operationId"),
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    ...defined("itemId", optionalLogicalId(input.itemId, "itemId")),
    idempotencyKey: validateNewLogicalId(
      input.idempotencyKey,
      "idempotencyKey",
    ),
    kind: selectedKind,
    requestDigest: hexDigest(input.requestDigest, "requestDigest"),
    state,
    publications,
    ...(input.artifactManifest === undefined
      ? {}
      : { artifactManifest: parseArtifactManifest(input.artifactManifest) }),
    ...optionalTextField(input, "resultRef"),
    ...optionalTextField(input, "errorCode"),
    createdAt: timestamp(input.createdAt, "createdAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt"),
  };
}

export function parseMissionGeneration(value: unknown): MissionGeneration {
  const input = record(value, "mission generation");
  schema(input, "pi.mission-generation/v1");
  return {
    schema: "pi.mission-generation/v1",
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    generation: nonNegativeInteger(input.generation, "generation"),
    previousGeneration:
      input.previousGeneration === null
        ? null
        : nonNegativeInteger(input.previousGeneration, "previousGeneration"),
    planRevision:
      input.planRevision === null
        ? null
        : nonNegativeInteger(input.planRevision, "planRevision"),
    ...optionalTextField(input, "planKey"),
    sessionKeys: textArray(input.sessionKeys, "sessionKeys"),
    bindingKeys: textArray(input.bindingKeys, "bindingKeys"),
    executionLinkKeys: textArray(input.executionLinkKeys, "executionLinkKeys"),
    evidenceLinkKeys: textArray(input.evidenceLinkKeys, "evidenceLinkKeys"),
    contextTokens: textArray(input.contextTokens, "contextTokens"),
    contextHashes:
      input.contextHashes === undefined
        ? []
        : parseContextHashes(input.contextHashes),
    eventIds: textArray(input.eventIds, "eventIds"),
    committedOperationIds: textArray(
      input.committedOperationIds,
      "committedOperationIds",
    ),
    publishedAt: timestamp(input.publishedAt, "publishedAt"),
  };
}

export function parseGenerationPointer(
  value: unknown,
): MissionGenerationPointer {
  const input = record(value, "generation pointer");
  schema(input, "pi.mission-generation-pointer/v1");
  return {
    schema: "pi.mission-generation-pointer/v1",
    missionId: validateNewLogicalId(input.missionId, "missionId"),
    generation: nonNegativeInteger(input.generation, "generation"),
    generationSha256: hexDigest(input.generationSha256, "generationSha256"),
  };
}

export function parseExternalViewerRoute(value: unknown): ExternalViewerRoute {
  const input = record(value, "viewer route");
  rejectUnknown(input, ["executable", "argv"]);
  if (!Array.isArray(input.argv) || input.argv.length > 64)
    fail("INVALID_ARGV", "argv must be an array with at most 64 tokens");
  const argv: ArgvToken[] = input.argv.map((entry, index) => {
    const token = record(entry, `argv[${index}]`);
    if (token.kind === "literal")
      return exact(token, ["kind", "value"], {
        kind: "literal",
        value: safeProcessText(token.value, `argv[${index}].value`),
      });
    if (token.kind === "placeholder" && token.value === "verifiedPath")
      return exact(token, ["kind", "value"], {
        kind: "placeholder",
        value: "verifiedPath",
      });
    return fail("INVALID_ARGV_TOKEN", `argv[${index}]`);
  });
  return { executable: safeProcessText(input.executable, "executable"), argv };
}

function parseRoadmapItem(value: unknown, index: number): RoadmapItem {
  const input = record(value, `items[${index}]`);
  return {
    itemId: validateNewLogicalId(input.itemId, `items[${index}].itemId`),
    order: nonNegativeInteger(input.order, `items[${index}].order`),
    ...defined(
      "parentItemId",
      optionalLogicalId(input.parentItemId, `items[${index}].parentItemId`),
    ),
    title: requiredText(input.title, `items[${index}].title`),
    ...optionalTextField(input, "description"),
    state: missionState(input.state, `items[${index}].state`),
    ...(input.estimate === undefined
      ? {}
      : { estimate: parseEstimate(input.estimate) }),
    dependencyItemIds: logicalIdArray(
      input.dependencyItemIds,
      `items[${index}].dependencyItemIds`,
    ),
    contributorSessionIds: logicalIdArray(
      input.contributorSessionIds,
      `items[${index}].contributorSessionIds`,
    ),
    externalRefs: Array.isArray(input.externalRefs)
      ? input.externalRefs.map(parseExternalRef)
      : fail("INVALID_EXTERNAL_REFS", `items[${index}]`),
    updatedAt: timestamp(input.updatedAt, `items[${index}].updatedAt`),
    ...optionalTextField(input, "exclusionReason"),
  };
}

function parseEstimate(value: unknown): PlanEstimate {
  const input = record(value, "estimate");
  if (input.unit !== "minute")
    fail("INVALID_ESTIMATE_UNIT", String(input.unit));
  const scope = input.scope;
  if (scope !== "schedule" && scope !== "included-in-parent")
    fail("INVALID_ESTIMATE_SCOPE", String(scope));
  const expected = nonNegativeFinite(input.expected, "estimate.expected");
  const optimistic = optionalNonNegativeFinite(
    input.optimistic,
    "estimate.optimistic",
  );
  const pessimistic = optionalNonNegativeFinite(
    input.pessimistic,
    "estimate.pessimistic",
  );
  if (optimistic !== undefined && optimistic > expected)
    fail("INVALID_ESTIMATE_BOUNDS", "optimistic exceeds expected");
  if (pessimistic !== undefined && pessimistic < expected)
    fail("INVALID_ESTIMATE_BOUNDS", "pessimistic is below expected");
  const confidenceValue = input.confidence;
  if (
    confidenceValue !== undefined &&
    confidenceValue !== "low" &&
    confidenceValue !== "medium" &&
    confidenceValue !== "high"
  )
    fail("INVALID_ESTIMATE_CONFIDENCE", String(confidenceValue));
  const confidence: PlanEstimate["confidence"] =
    confidenceValue === "low" ||
    confidenceValue === "medium" ||
    confidenceValue === "high"
      ? confidenceValue
      : undefined;
  return {
    unit: "minute",
    expected,
    ...defined("optimistic", optimistic),
    ...defined("pessimistic", pessimistic),
    ...defined("confidence", confidence),
    asOf: timestamp(input.asOf, "estimate.asOf"),
    scope,
  };
}

function parseSchedule(value: unknown): MissionSchedule {
  const input = record(value, "schedule");
  if (input.mode === "serial")
    return exact(input, ["mode"], { mode: "serial" });
  if (input.mode !== "waves" || !Array.isArray(input.waves))
    fail("INVALID_SCHEDULE", "expected serial or waves");
  return {
    mode: "waves",
    waves: input.waves.map((value, index) => {
      const wave = record(value, `waves[${index}]`);
      return {
        waveId: validateNewLogicalId(wave.waveId, `waves[${index}].waveId`),
        itemIds: logicalIdArray(wave.itemIds, `waves[${index}].itemIds`),
      };
    }),
  };
}

function validateSchedule(
  schedule: MissionSchedule,
  topLevel: readonly RoadmapItem[],
  byId: ReadonlyMap<string, RoadmapItem>,
): void {
  const slot = new Map<string, number>();
  if (schedule.mode === "serial") {
    [...topLevel]
      .sort((a, b) => a.order - b.order)
      .forEach((item, index) => slot.set(item.itemId, index));
    const ordered = [...topLevel].sort((a, b) => a.order - b.order);
    const current = ordered.filter(
      (item) => item.state === "active" || item.state === "blocked",
    );
    if (current.length > 1)
      fail(
        "SERIAL_MULTIPLE_CURRENT",
        current.map((item) => item.itemId).join(","),
      );
    const earliestUnfinished = ordered.find(
      (item) => !TERMINAL.has(item.state),
    );
    if (
      current.length === 1 &&
      current[0]?.itemId !== earliestUnfinished?.itemId
    )
      fail("ACTIVE_LATER_SERIAL_ITEM", current[0]?.itemId ?? "unknown");
  } else {
    const waveIds = new Set<string>();
    for (const [waveIndex, wave] of schedule.waves.entries()) {
      if (waveIds.has(wave.waveId)) fail("DUPLICATE_WAVE_ID", wave.waveId);
      waveIds.add(wave.waveId);
      for (const itemId of wave.itemIds) {
        const item = byId.get(itemId);
        if (!item || item.parentItemId) fail("INVALID_WAVE_ITEM", itemId);
        if (slot.has(itemId)) fail("DUPLICATE_WAVE_ITEM", itemId);
        slot.set(itemId, waveIndex);
      }
    }
    if (slot.size !== topLevel.length)
      fail("INCOMPLETE_WAVES", "every top-level item must occur once");
    const unfinishedWave = schedule.waves.findIndex((wave) =>
      wave.itemIds.some((id) => {
        const item = byId.get(id);
        return item !== undefined && !TERMINAL.has(item.state);
      }),
    );
    for (const item of topLevel) {
      const index = slot.get(item.itemId);
      if (
        (item.state === "active" || item.state === "blocked") &&
        index !== unfinishedWave
      )
        fail("ACTIVE_LATER_WAVE", item.itemId);
    }
  }
  for (const item of topLevel) {
    const itemSlot = slot.get(item.itemId);
    for (const dependencyId of item.dependencyItemIds) {
      const dependencySlot = slot.get(dependencyId);
      if (
        itemSlot === undefined ||
        dependencySlot === undefined ||
        dependencySlot >= itemSlot
      ) {
        fail("CROSS_SLOT_DEPENDENCY", `${item.itemId} -> ${dependencyId}`);
      }
    }
  }
}

function parseArtifactManifest(value: unknown): readonly {
  readonly artifactId: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}[] {
  if (!Array.isArray(value))
    fail("INVALID_ARTIFACT_MANIFEST", "must be an array");
  return value.map((entry, index) => {
    const input = record(entry, `artifactManifest[${index}]`);
    return exact(input, ["artifactId", "fileName", "size", "sha256"], {
      artifactId: requiredText(input.artifactId, "artifactId"),
      fileName: requiredText(input.fileName, "fileName"),
      size: nonNegativeInteger(input.size, "size"),
      sha256: hexDigest(input.sha256, "sha256"),
    });
  });
}

function parseContextHashes(
  value: unknown,
): readonly { readonly token: string; readonly sha256: string }[] {
  if (!Array.isArray(value)) fail("INVALID_CONTEXT_HASHES", "must be an array");
  return value.map((entry, index) => {
    const input = record(entry, `contextHashes[${index}]`);
    return exact(input, ["token", "sha256"], {
      token: requiredText(input.token, `contextHashes[${index}].token`),
      sha256: hexDigest(input.sha256, `contextHashes[${index}].sha256`),
    });
  });
}

function parseChangeStat(value: unknown): ChangeStat {
  const input = record(value, "change stat");
  const provenance = record(input.provenance, "change stat provenance");
  const parser = provenance.parser;
  if (parser !== "unified-diff/v1" && parser !== "explicit/v1")
    fail("INVALID_CHANGE_PROVENANCE", String(parser));
  return {
    additions: nonNegativeInteger(input.additions, "additions"),
    deletions: nonNegativeInteger(input.deletions, "deletions"),
    provenance: {
      artifactId: requiredText(provenance.artifactId, "artifactId"),
      sha256: hexDigest(provenance.sha256, "sha256"),
      parser,
    },
  };
}

function parseStateEffect(value: unknown): EvidenceStateEffect {
  const input = record(value, "state effect");
  if (input.kind === "none") return exact(input, ["kind"], { kind: "none" });
  const transition = input.transition;
  if (
    transition !== "complete-item" &&
    transition !== "fail-item" &&
    transition !== "cancel-item"
  )
    fail("INVALID_STATE_EFFECT", "invalid transition");
  if (input.kind === "execution-terminal")
    return exact(input, ["kind", "bindingId", "transition"], {
      kind: input.kind,
      bindingId: validateNewLogicalId(input.bindingId, "bindingId"),
      transition,
    });
  if (input.kind === "operator-plan-mutation")
    return exact(input, ["kind", "operationId", "transition"], {
      kind: input.kind,
      operationId: validateNewLogicalId(input.operationId, "operationId"),
      transition,
    });
  return fail("INVALID_STATE_EFFECT", "invalid kind");
}

function externalTuple(ref: MissionExternalRef): readonly string[] {
  switch (ref.kind) {
    case "pi-task":
      return [
        ref.kind,
        ref.producerNamespace,
        ref.projectRoot,
        ref.listId,
        ref.sessionId,
        ref.taskId,
        ref.executionId,
      ];
    case "pi-workflow":
      return [ref.kind, ref.producerNamespace, ref.runId];
    case "pi-subagent":
      return [ref.kind, ref.producerNamespace, ref.sessionId, ref.executionId];
    case "other":
      return [ref.kind, ref.producerNamespace, ...ref.identity];
  }
}

function assertAcyclic(
  items: readonly RoadmapItem[],
  edges: (item: RoadmapItem) => readonly string[],
  code: string,
): void {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(code, id);
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    if (item) for (const target of edges(item)) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.itemId);
}

function isAncestor(
  ancestorId: string,
  item: RoadmapItem,
  byId: ReadonlyMap<string, RoadmapItem>,
): boolean {
  let current = item;
  const seen = new Set<string>();
  while (current.parentItemId) {
    if (current.parentItemId === ancestorId) return true;
    if (seen.has(current.parentItemId)) return false;
    seen.add(current.parentItemId);
    const parent = byId.get(current.parentItemId);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_OBJECT", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function schema(input: Record<string, unknown>, expected: string): void {
  if (input.schema !== expected) fail("INVALID_SCHEMA", `expected ${expected}`);
}
function exact<T>(
  input: Record<string, unknown>,
  keys: readonly string[],
  output: T,
): T {
  rejectUnknown(input, keys);
  return output;
}
function rejectUnknown(
  input: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) fail("UNKNOWN_FIELD", unknown);
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail("INVALID_STRING", `${label} must be non-empty`);
  return value;
}
function safeProcessText(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (Buffer.byteLength(text, "utf8") > 4096 || /[\0\r\n]/.test(text))
    fail("INVALID_PROCESS_TEXT", label);
  return text;
}
function optionalLogicalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : validateNewLogicalId(value, label);
}
function optionalTextField<Key extends string>(
  input: Record<string, unknown>,
  key: Key,
): { [P in Key]?: string } {
  return defined(
    key,
    input[key] === undefined ? undefined : requiredText(input[key], key),
  );
}
function timestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!Number.isFinite(Date.parse(text))) fail("INVALID_TIMESTAMP", label);
  return text;
}
function missionState(value: unknown, label: string): MissionState {
  const text = requiredText(value, label);
  const state = STATES.find((candidate) => candidate === text);
  return state ?? fail("INVALID_STATE", text);
}
function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail("INVALID_NUMBER", label);
  return value;
}
function optionalNonNegativeFinite(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined ? undefined : nonNegativeFinite(value, label);
}
function nonNegativeInteger(value: unknown, label: string): number {
  const number = nonNegativeFinite(value, label);
  if (!Number.isSafeInteger(number)) fail("INVALID_INTEGER", label);
  return number;
}
function optionalNonNegativeInteger(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}
function logicalIdArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) fail("INVALID_ARRAY", label);
  const values = value.map((entry, index) =>
    validateNewLogicalId(entry, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length)
    fail("DUPLICATE_ARRAY_VALUE", label);
  return values;
}
function textArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) fail("INVALID_ARRAY", label);
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
}
function hexDigest(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) fail("INVALID_DIGEST", label);
  return text;
}
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [P in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [P in Key]: Value });
}
function fail(code: string, message: string): never {
  throw new MissionContractError(code, message);
}
