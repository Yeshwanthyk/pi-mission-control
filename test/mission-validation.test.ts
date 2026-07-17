import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMissionTransition,
  canonicalExternalIdentity,
  parseExternalRef,
  parseMissionPlan,
} from "../src/mission-validation.ts";
import type { MissionPlan } from "../src/mission-types.ts";

const now = "2026-01-01T00:00:00.000Z";

function plan(
  items: MissionPlan["items"],
  schedule: MissionPlan["schedule"] = { mode: "serial" },
): MissionPlan {
  return {
    schema: "pi.mission-plan/v1",
    missionId: "mission:/雪",
    title: "Mission",
    state: "planned",
    revision: 0,
    schedule,
    items,
    createdAt: now,
    updatedAt: now,
  };
}
function item(itemId: string, order: number): MissionPlan["items"][number] {
  return {
    itemId,
    order,
    title: itemId,
    state: "planned",
    dependencyItemIds: [],
    contributorSessionIds: [],
    externalRefs: [],
    updatedAt: now,
  };
}

test("strict mission plan validation enforces graph, schedule, estimate, and transition invariants", () => {
  assert.equal(parseMissionPlan(plan([item("a", 0)])).missionId, "mission:/雪");
  assert.throws(
    () =>
      parseMissionPlan(
        plan([
          { ...item("a", 0), dependencyItemIds: ["b"] },
          { ...item("b", 1), dependencyItemIds: ["a"] },
        ]),
      ),
    /DEPENDENCY_CYCLE/,
  );
  assert.throws(
    () =>
      parseMissionPlan(
        plan([item("a", 0), item("b", 1)], {
          mode: "waves",
          waves: [{ waveId: "w1", itemIds: ["a"] }],
        }),
      ),
    /INCOMPLETE_WAVES/,
  );
  assert.throws(
    () =>
      parseMissionPlan(
        plan([
          {
            ...item("a", 0),
            estimate: {
              unit: "minute",
              expected: 3,
              optimistic: 4,
              asOf: now,
              scope: "schedule",
            },
          },
        ]),
      ),
    /INVALID_ESTIMATE_BOUNDS/,
  );
  assert.throws(
    () => assertMissionTransition("completed", "active"),
    /ILLEGAL_STATE_TRANSITION/,
  );
  assert.doesNotThrow(() => assertMissionTransition("active", "active"));
});

test("serial activation and completed-parent exclusions enforce the earliest unfinished work", () => {
  assert.throws(
    () =>
      parseMissionPlan(
        plan([item("first", 0), { ...item("later", 1), state: "active" }]),
      ),
    /ACTIVE_LATER_SERIAL_ITEM/,
  );
  assert.throws(
    () =>
      parseMissionPlan(
        plan([
          { ...item("parent", 0), state: "completed" },
          {
            ...item("excluded", 1),
            parentItemId: "parent",
            state: "cancelled",
          },
        ]),
      ),
    /PARENT_STATE_CONFLICT/,
  );
  assert.doesNotThrow(() =>
    parseMissionPlan(
      plan([
        { ...item("parent", 0), state: "completed" },
        {
          ...item("excluded", 1),
          parentItemId: "parent",
          state: "cancelled",
          exclusionReason: "explicitly removed from completion scope",
        },
      ]),
    ),
  );
});

test("external identities are exact discriminated tuples and collision resistant", () => {
  const first = {
    kind: "pi-task" as const,
    producerNamespace: "pi.tasks/v1",
    projectRoot: "/code/a",
    listId: "12",
    sessionId: "3",
    taskId: "4",
    executionId: "5",
  };
  const second = { ...first, listId: "1", sessionId: "23" };
  assert.notEqual(
    canonicalExternalIdentity(first),
    canonicalExternalIdentity(second),
  );
  assert.throws(
    () =>
      parseExternalRef({
        kind: "pi-workflow",
        producerNamespace: "pi.workflow/v1",
      }),
    /externalRef.runId/,
  );
  assert.throws(
    () => parseExternalRef({ ...first, runId: "ambiguous" }),
    /UNKNOWN_FIELD/,
  );
});
