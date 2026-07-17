import assert from "node:assert/strict";
import test from "node:test";
import { assignWorkflowContexts } from "../src/source-adapter.ts";
import type { MissionContext } from "../src/types.ts";
import type { WorkflowProjection } from "../src/projections.ts";

function context(token: string, createdAt: number): MissionContext {
  return {
    schema: "pi.mission-context/v1",
    token,
    missionId: "mission",
    title: token,
    cwd: "/tmp",
    source: "workflow",
    parentSessionId: "session",
    createdAt: new Date(createdAt).toISOString(),
    status: "active",
  };
}

function run(runId: string, startedAt: number): WorkflowProjection {
  return {
    runId,
    sessionId: "session",
    name: runId,
    status: "running",
    startedAt,
    agents: [],
    runDirectory: `/tmp/${runId}`,
  };
}

test("workflow reconciliation assigns nearest launch context once", () => {
  const base = Date.now();
  const first = context("first", base);
  const second = context("second", base + 2_000);
  const firstRun = run("wf_first", base + 100);
  const secondRun = run("wf_second", base + 2_100);
  const assigned = assignWorkflowContexts(
    [first, second],
    [secondRun, firstRun],
  );
  assert.equal(assigned.get(firstRun)?.token, "first");
  assert.equal(assigned.get(secondRun)?.token, "second");
});

test("workflow reconciliation ignores unrelated old runs", () => {
  const now = Date.now();
  const assigned = assignWorkflowContexts(
    [context("current", now)],
    [run("wf_old", now - 60_000)],
  );
  assert.equal(assigned.size, 0);
});
