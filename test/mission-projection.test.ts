import assert from "node:assert/strict";
import test from "node:test";
import { buildMissionProjection } from "../src/mission-projection.ts";
import type { MissionSourceSnapshot } from "../src/mission-types.ts";

const now = "2026-01-01T00:00:00.000Z";
const snapshot: MissionSourceSnapshot = {
  schema: "pi.mission-source-snapshot/v1",
  missionId: "mission",
  generation: 4,
  projectionRevision: "revision",
  plan: {
    schema: "pi.mission-plan/v1",
    missionId: "mission",
    title: "Mission",
    state: "active",
    revision: 2,
    schedule: {
      mode: "waves",
      waves: [
        { waveId: "w1", itemIds: ["blocked", "active"] },
        { waveId: "w2", itemIds: ["next"] },
      ],
    },
    items: [
      {
        itemId: "active",
        order: 0,
        title: "Active",
        state: "active",
        estimate: { unit: "minute", expected: 4, asOf: now, scope: "schedule" },
        dependencyItemIds: [],
        contributorSessionIds: ["s"],
        externalRefs: [],
        updatedAt: now,
      },
      {
        itemId: "blocked",
        order: 1,
        title: "Blocked",
        state: "blocked",
        estimate: { unit: "minute", expected: 5, asOf: now, scope: "schedule" },
        dependencyItemIds: [],
        contributorSessionIds: [],
        externalRefs: [],
        updatedAt: now,
      },
      {
        itemId: "next",
        order: 2,
        title: "Next",
        state: "planned",
        estimate: { unit: "minute", expected: 2, asOf: now, scope: "schedule" },
        dependencyItemIds: [],
        contributorSessionIds: [],
        externalRefs: [],
        updatedAt: now,
      },
      {
        itemId: "child",
        order: 3,
        parentItemId: "active",
        title: "Child",
        state: "active",
        dependencyItemIds: [],
        contributorSessionIds: [],
        externalRefs: [],
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
  sessions: [
    {
      schema: "pi.mission-session/v1",
      missionId: "mission",
      sessionId: "s",
      displayName: "Session",
      initials: "SE",
      color: "blue",
      firstSeenAt: now,
      lastSeenAt: now,
      revision: 0,
    },
  ],
  sessionBindings: [],
  executionBindings: [],
  evidenceLinks: [
    {
      schema: "pi.mission-evidence-link/v1",
      linkId: "semantic",
      missionId: "mission",
      itemId: "active",
      eventId: "e2",
      sessionId: "s",
      classification: "semantic",
      stateEffect: { kind: "none" },
      changeStats: [],
      createdAt: now,
    },
    {
      schema: "pi.mission-evidence-link/v1",
      linkId: "telemetry",
      missionId: "mission",
      itemId: "active",
      eventId: "e1",
      sessionId: "s",
      classification: "telemetry",
      stateEffect: { kind: "none" },
      changeStats: [],
      createdAt: now,
    },
  ],
  contexts: [
    {
      schema: "pi.mission-context/v1",
      token: "mc",
      missionId: "mission",
      title: "Mission",
      cwd: "/tmp",
      source: "session",
      parentSessionId: "s",
      createdAt: now,
      status: "active",
    },
  ],
  receipts: [
    {
      schema: "pi.evidence/v1",
      eventId: "e2",
      contextToken: "mc",
      producer: { kind: "test", sessionId: "s" },
      milestone: {
        id: "m2",
        kind: "checkpoint",
        state: "completed",
        title: "Semantic",
        occurredAt: now,
      },
      artifacts: [],
      payload: {},
      recordedAt: now,
    },
    {
      schema: "pi.evidence/v1",
      eventId: "e1",
      contextToken: "mc",
      producer: { kind: "test", sessionId: "s" },
      milestone: {
        id: "m1",
        kind: "checkpoint",
        state: "completed",
        title: "Telemetry",
        occurredAt: now,
      },
      artifacts: [],
      payload: {},
      recordedAt: now,
    },
  ],
  pendingOperations: [],
  unassigned: [],
  conflicts: [],
};

test("projection is deterministic, semantic-only, and keeps nested work in detail", () => {
  const first = buildMissionProjection(snapshot, () => new Date(now));
  const second = buildMissionProjection(
    snapshot,
    () => new Date("2030-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.roadmap.map((row) => row.itemId),
    ["active", "blocked", "next"],
  );
  assert.deepEqual(
    first.progress.map((row) => row.eventId),
    ["e2"],
  );
  assert.equal(
    first.roadmap.some((row) => row.itemId === "child"),
    false,
  );
  assert.equal(
    first.detailsByItemId.active?.plannedChildren[0]?.itemId,
    "child",
  );
  assert.equal(
    first.header.aggregateEta.status === "known"
      ? first.header.aggregateEta.value.expected
      : -1,
    7,
  );
});
