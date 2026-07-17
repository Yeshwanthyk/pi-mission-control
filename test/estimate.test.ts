import assert from "node:assert/strict";
import test from "node:test";
import { calculateMissionEta } from "../src/estimate.ts";
import type { MissionPlan, RoadmapItem } from "../src/mission-types.ts";

const now = "2026-01-01T00:00:00.000Z";
function item(id: string, order: number, expected?: number): RoadmapItem {
  return {
    itemId: id,
    order,
    title: id,
    state: "planned",
    ...(expected === undefined
      ? {}
      : {
          estimate: {
            unit: "minute" as const,
            expected,
            optimistic: expected - 1,
            pessimistic: expected + 1,
            asOf: now,
            scope: "schedule" as const,
          },
        }),
    dependencyItemIds: [],
    contributorSessionIds: [],
    externalRefs: [],
    updatedAt: now,
  };
}
function plan(
  items: readonly RoadmapItem[],
  schedule: MissionPlan["schedule"],
): MissionPlan {
  return {
    schema: "pi.mission-plan/v1",
    missionId: "m",
    title: "M",
    state: "planned",
    revision: 0,
    schedule,
    items,
    createdAt: now,
    updatedAt: now,
  };
}

test("ETA uses serial prefix sums, wave maxima, and excludes nested estimates", () => {
  const serialItems = [
    item("a", 0, 4),
    item("b", 1, 6),
    {
      ...item("child", 2, 100),
      parentItemId: "b",
      estimate: {
        unit: "minute" as const,
        expected: 100,
        asOf: now,
        scope: "included-in-parent" as const,
      },
    },
  ];
  const serial = calculateMissionEta(plan(serialItems, { mode: "serial" }));
  assert.equal(
    serial.aggregate.status === "known" ? serial.aggregate.value.expected : -1,
    10,
  );
  const wave = calculateMissionEta(
    plan([item("a", 0, 4), item("b", 1, 6), item("c", 2, 2)], {
      mode: "waves",
      waves: [
        { waveId: "w1", itemIds: ["a", "b"] },
        { waveId: "w2", itemIds: ["c"] },
      ],
    }),
  );
  assert.equal(
    wave.aggregate.status === "known" ? wave.aggregate.value.expected : -1,
    8,
  );
});

test("ETA propagates missing estimates and terminal dependency blocking honestly", () => {
  const missing = calculateMissionEta(
    plan([item("a", 0, 2), item("b", 1)], { mode: "serial" }),
  );
  assert.deepEqual(missing.aggregate, {
    status: "unknown",
    reason: "not-estimated",
  });
  const failed = { ...item("a", 0, 2), state: "failed" as const };
  const blocked = {
    ...item("b", 1, 3),
    state: "blocked" as const,
    dependencyItemIds: ["a"],
  };
  assert.deepEqual(
    calculateMissionEta(plan([failed, blocked], { mode: "serial" })).aggregate,
    { status: "unknown", reason: "blocked-by-terminal" },
  );
});
