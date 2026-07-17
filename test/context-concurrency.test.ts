import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MissionIndex } from "../src/mission-index.ts";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

test("concurrent context writers cannot regress or replace a terminal state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "context-concurrency-"));
  const store = new MissionStore(root);
  try {
    const context = await runMission(
      store.createContext({
        missionId: "mission",
        title: "Mission",
        cwd: root,
        source: "subagent",
        parentSessionId: "session",
      }),
    );
    const results = await Promise.allSettled(
      ["completed", "failed"].map((state, index) =>
        runMission(
          store.recordEvidence({
            eventId: `terminal-${index}`,
            contextToken: context.token,
            producer: { kind: "test" },
            milestone: {
              id: `m-${index}`,
              kind: "agent-run",
              state: state === "completed" ? "completed" : "failed",
              title: state,
              occurredAt: `2026-01-01T00:00:0${index}.000Z`,
            },
          }),
        ),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const terminal = await runMission(store.getContext(context.token));
    assert.ok(
      terminal?.status === "completed" || terminal?.status === "failed",
    );
    const unchanged = await runMission(
      store.updateContextStatus(context.token, "active"),
    );
    assert.equal(unchanged.status, terminal?.status);

    const before = await new MissionIndex(root).snapshot("mission");
    const sourced = await runMission(
      store.updateContextSourceId(context.token, "durable-source"),
    );
    assert.equal(sourced.status, terminal?.status);
    const after = await new MissionIndex(root).snapshot("mission");
    assert.notEqual(after.projectionRevision, before.projectionRevision);
    assert.equal(after.contexts[0]?.sourceId, "durable-source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
