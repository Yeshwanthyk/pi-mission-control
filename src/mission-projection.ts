import { aggregateChangeStats, summarizeEvidence } from "./artifact-summary.ts";
import { calculateMissionEta } from "./estimate.ts";
import { classifyLinkedEvidence } from "./evidence-classifier.ts";
import type {
  ConflictView,
  ItemDetailView,
  MissionProjection,
  MissionSourceSnapshot,
  PendingRecordView,
  ProgressRowView,
  RoadmapItem,
  RoadmapRowView,
  SessionAttributionView,
  ValueState,
} from "./mission-types.ts";

export type ProjectionClock = () => Date;

export function buildMissionProjection(
  snapshot: MissionSourceSnapshot,
  _clock: ProjectionClock = () => new Date(),
): MissionProjection {
  const plan = snapshot.plan;
  const missionId: ValueState<string> =
    snapshot.missionId.length === 0
      ? { status: "unknown", reason: "not-planned" }
      : { status: "known", value: snapshot.missionId };
  if (!plan) {
    return {
      schema: "pi.mission-projection/v1",
      missionId,
      projectionRevision: snapshot.projectionRevision,
      boardState:
        snapshot.missionId.length === 0 ? "empty-unbound" : "missing-plan",
      header: {
        title:
          snapshot.missionId.length === 0
            ? "No mission bound"
            : snapshot.missionId,
        state: { status: "unknown", reason: "not-planned" },
        aggregateEta: { status: "unknown", reason: "not-planned" },
        changeStats: { status: "unknown", reason: "missing-provenance" },
        latestSemanticAt: { status: "unknown", reason: "legacy-unassigned" },
      },
      roadmap: [],
      progress: [],
      detailsByItemId: {},
      unassignedCount: snapshot.unassigned.length,
      capabilities: defaultCapabilities(),
    };
  }
  const itemById = new Map(plan.items.map((item) => [item.itemId, item]));
  const sessionById = new Map(
    snapshot.sessions.map((session) => [session.sessionId, session]),
  );
  const receiptById = new Map(
    snapshot.receipts.map((receipt) => [receipt.eventId, receipt]),
  );
  const contextByToken = new Map(
    snapshot.contexts.map((context) => [context.token, context]),
  );
  const progress = snapshot.evidenceLinks
    .flatMap((link): ProgressRowView[] => {
      const receipt = receiptById.get(link.eventId);
      const item = itemById.get(link.itemId);
      const session = sessionById.get(link.sessionId);
      if (
        !receipt ||
        !item ||
        !session ||
        classifyLinkedEvidence(link, receipt) !== "semantic"
      )
        return [];
      const context = contextByToken.get(receipt.contextToken);
      if (!context || context.missionId !== snapshot.missionId) return [];
      if (
        receipt.producer.sessionId &&
        receipt.producer.sessionId !== link.sessionId
      )
        return [];
      return [
        {
          eventId: receipt.eventId,
          itemId: item.itemId,
          title: receipt.milestone.title,
          occurredAt: receipt.milestone.occurredAt,
          summary: summarizeEvidence(link, receipt),
          attribution: { status: "known", value: attribution(session) },
          artifactIds: receipt.artifacts.map((artifact) => artifact.artifactId),
          changeStats: link.changeStats,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        left.eventId.localeCompare(right.eventId),
    );
  const eta = calculateMissionEta(plan);
  const ordered = orderedTopLevel(plan.items, plan.schedule);
  const earliest = earliestUnfinishedSlot(plan.items, plan.schedule);
  const roadmap = ordered
    .flatMap(({ item, slot }): RoadmapRowView[] => {
      if (
        item.state === "completed" ||
        item.state === "failed" ||
        item.state === "cancelled"
      )
        return [];
      const phase =
        slot === earliest &&
        (item.state === "active" || item.state === "blocked")
          ? "current"
          : "upcoming";
      const contributors = item.contributorSessionIds.flatMap((sessionId) => {
        const session = sessionById.get(sessionId);
        return session ? [attribution(session)] : [];
      });
      const conflicts = snapshot.conflicts.filter(
        (conflict) => conflict.itemId === item.itemId,
      );
      return [
        {
          itemId: item.itemId,
          phase,
          state: item.state,
          title: item.title,
          cumulativeEta: eta.byItemId.get(item.itemId) ?? {
            status: "unknown",
            reason: "not-estimated",
          },
          attribution: contributors,
          blockedReason:
            item.state === "blocked"
              ? blockedReason(item, itemById)
              : { status: "unknown", reason: "not-planned" },
          conflictCount: conflicts.length,
        },
      ];
    })
    .sort((left, right) => {
      if (left.phase !== right.phase) return left.phase === "current" ? -1 : 1;
      if (left.phase === "current" && left.state !== right.state)
        return left.state === "active" ? -1 : 1;
      return (
        (itemById.get(left.itemId)?.order ?? 0) -
        (itemById.get(right.itemId)?.order ?? 0)
      );
    });
  const details: Record<string, ItemDetailView> = {};
  const buildDetail = (item: RoadmapItem): ItemDetailView => {
    const milestones = progress.filter((row) => row.itemId === item.itemId);
    const executions = snapshot.executionBindings
      .filter((binding) => binding.itemId === item.itemId)
      .map((binding) => ({
        bindingId: binding.bindingId,
        identity: binding.canonicalIdentity,
        state: binding.state,
        sessionId: binding.sessionId,
      }));
    const pending: PendingRecordView[] = snapshot.pendingOperations
      .filter((operation) => operation.itemId === item.itemId)
      .map((operation) => ({
        operationId: operation.operationId,
        kind: operation.kind,
        state: operation.state === "committed" ? "intent" : operation.state,
        ...defined("errorCode", operation.errorCode),
      }));
    const conflicts: ConflictView[] = snapshot.conflicts
      .filter((conflict) => conflict.itemId === item.itemId)
      .map((conflict) => ({
        conflictId: conflict.conflictId,
        kind: conflict.kind,
        reason: conflict.reason,
      }));
    const plannedChildren = plan.items
      .filter((candidate) => candidate.parentItemId === item.itemId)
      .sort((left, right) => left.order - right.order)
      .map(buildDetail);
    const artifactIds = [
      ...new Set(milestones.flatMap((row) => row.artifactIds)),
    ];
    const detail: ItemDetailView = {
      itemId: item.itemId,
      plan: item,
      plannedChildren,
      executions,
      milestones,
      artifactIds,
      pending,
      conflicts,
    };
    details[item.itemId] = detail;
    return detail;
  };
  for (const item of plan.items.filter((candidate) => !candidate.parentItemId))
    buildDetail(item);
  const latest = progress[0]?.occurredAt;
  return {
    schema: "pi.mission-projection/v1",
    missionId,
    projectionRevision: snapshot.projectionRevision,
    boardState: snapshot.conflicts.length > 0 ? "conflict" : "ready",
    header: {
      title: plan.title,
      state: { status: "known", value: plan.state },
      aggregateEta: eta.aggregate,
      changeStats: aggregateChangeStats(
        snapshot.evidenceLinks.filter((link) =>
          progress.some((row) => row.eventId === link.eventId),
        ),
      ),
      latestSemanticAt: latest
        ? { status: "known", value: latest }
        : { status: "unknown", reason: "legacy-unassigned" },
    },
    roadmap,
    progress,
    detailsByItemId: details,
    unassignedCount: snapshot.unassigned.length,
    capabilities: defaultCapabilities(),
  };
}

export function projectionToPlain(projection: MissionProjection): string {
  const eta =
    projection.header.aggregateEta.status === "known"
      ? `eta ~${projection.header.aggregateEta.value.expected}m`
      : "eta —";
  const lines = [
    `${projection.header.title}  ${projection.header.state.status === "known" ? projection.header.state.value.toUpperCase() : "UNASSIGNED"}`,
    eta,
    "",
    "Roadmap",
    ...projection.roadmap.map(
      (row) =>
        `${row.phase === "current" ? "■" : "□"} ${row.title}  ${row.cumulativeEta.status === "known" ? `eta ${row.cumulativeEta.value.expected}m` : "eta —"}`,
    ),
    "",
    "Progress",
    ...projection.progress.flatMap((row) =>
      [
        row.title,
        row.summary
          .map((summary) => `${summary.count} ${summary.kind}`)
          .join(", "),
      ].filter(Boolean),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function orderedTopLevel(
  items: readonly RoadmapItem[],
  schedule: import("./mission-types.ts").MissionSchedule,
): readonly { readonly item: RoadmapItem; readonly slot: number }[] {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  if (schedule.mode === "serial")
    return items
      .filter((item) => !item.parentItemId)
      .sort((left, right) => left.order - right.order)
      .map((item, slot) => ({ item, slot }));
  return schedule.waves.flatMap((wave, slot) =>
    wave.itemIds
      .flatMap((id) => {
        const item = byId.get(id);
        return item ? [{ item, slot }] : [];
      })
      .sort((left, right) => left.item.order - right.item.order),
  );
}
function earliestUnfinishedSlot(
  items: readonly RoadmapItem[],
  schedule: import("./mission-types.ts").MissionSchedule,
): number {
  const ordered = orderedTopLevel(items, schedule);
  return (
    ordered.find(
      (entry) =>
        entry.item.state !== "completed" &&
        entry.item.state !== "failed" &&
        entry.item.state !== "cancelled",
    )?.slot ?? -1
  );
}
function attribution(
  session: import("./mission-types.ts").MissionSessionAttribution,
): SessionAttributionView {
  return {
    sessionId: session.sessionId,
    displayName: session.displayName,
    initials: session.initials,
    color: session.color,
  };
}
function blockedReason(
  item: RoadmapItem,
  byId: ReadonlyMap<string, RoadmapItem>,
): ValueState<string> {
  const terminal = item.dependencyItemIds
    .map((id) => byId.get(id))
    .find(
      (dependency) =>
        dependency?.state === "failed" || dependency?.state === "cancelled",
    );
  return terminal
    ? {
        status: "known",
        value: `blocked by ${terminal.title} (${terminal.state})`,
      }
    : { status: "known", value: "explicitly blocked" };
}
function defaultCapabilities() {
  return { text: true, diff: true, media: false, external: false } as const;
}
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [P in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [P in Key]: Value });
}
