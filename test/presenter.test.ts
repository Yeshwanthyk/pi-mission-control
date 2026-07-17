import assert from "node:assert/strict";
import test from "node:test";
import { renderMissionJson, renderMissionPlain } from "../src/presenter.ts";
import type { MissionProjection } from "../src/mission-types.ts";

const projection: MissionProjection = {
  schema: "pi.mission-projection/v1",
  missionId: { status: "known", value: "mission" },
  projectionRevision: "revision",
  boardState: "ready",
  header: {
    title: "Mission",
    state: { status: "known", value: "active" },
    aggregateEta: {
      status: "known",
      value: {
        expected: 4,
        optimistic: { status: "known", value: 3 },
        pessimistic: { status: "known", value: 6 },
      },
    },
    changeStats: { status: "unknown", reason: "missing-provenance" },
    latestSemanticAt: { status: "unknown", reason: "legacy-unassigned" },
  },
  roadmap: [],
  progress: [],
  detailsByItemId: {},
  unassignedCount: 0,
  capabilities: { text: true, diff: true, media: false, external: false },
};

test("presenter adapters expose only the shared plain and JSON projection", () => {
  assert.match(renderMissionPlain(projection), /^Mission  ACTIVE/m);
  assert.deepEqual(JSON.parse(renderMissionJson(projection)), projection);
  assert.doesNotMatch(
    renderMissionJson(projection),
    /artifactPath|shell|command/,
  );
});
