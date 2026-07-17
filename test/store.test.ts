import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

async function fixture(
  run: (store: MissionStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "mission-store-"));
  try {
    await run(new MissionStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function context(
  store: MissionStore,
  cwd: string,
  source: "session" | "subagent" = "session",
) {
  return runMission(
    store.createContext({
      missionId: "mission:test",
      title: "Test mission",
      cwd,
      source,
      parentSessionId: "session-1",
    }),
  );
}

test("records immutable artifact snapshots after context validation", async () => {
  await fixture(async (store, root) => {
    const active = await context(store, root);
    const source = path.join(root, "report.txt");
    await writeFile(source, "original\n");
    const receipt = await runMission(
      store.recordEvidence({
        eventId: "event-one",
        contextToken: active.token,
        producer: { kind: "test" },
        milestone: {
          id: "checkpoint-1",
          kind: "checkpoint",
          state: "completed",
          title: "Report ready",
          occurredAt: new Date().toISOString(),
        },
        artifacts: [{ role: "report", path: source }],
        payload: { verified: true },
      }),
    );

    assert.equal(receipt.artifacts.length, 1);
    const artifact = receipt.artifacts[0]!;
    assert.notEqual(artifact.path, source);
    assert.equal(artifact.sourcePath, await realpath(source));
    assert.equal(
      artifact.sha256,
      createHash("sha256").update("original\n").digest("hex"),
    );

    await writeFile(source, "changed\n");
    assert.equal(await readFile(artifact.path, "utf8"), "original\n");
    assert.equal(
      (await runMission(store.listReceipts(new Set([active.token])))).length,
      1,
    );
  });
});

test("event IDs are idempotent under concurrent writers", async () => {
  await fixture(async (store, root) => {
    const active = await context(store, root);
    const input = {
      eventId: "same-event",
      contextToken: active.token,
      producer: { kind: "test" },
      milestone: {
        id: "same",
        kind: "checkpoint",
        state: "completed" as const,
        title: "Same event",
        occurredAt: new Date().toISOString(),
      },
      artifacts: [{ role: "note", content: "hello" }],
    };
    const [left, right] = await Promise.all([
      runMission(store.recordEvidence(input)),
      runMission(store.recordEvidence(input)),
    ]);
    assert.equal(left.eventId, right.eventId);
    assert.equal(left.recordedAt, right.recordedAt);
    assert.equal((await runMission(store.listReceipts())).length, 1);
  });
});

test("terminal run receipts settle only the matching child context kind", async () => {
  await fixture(async (store, root) => {
    const active = await context(store, root, "subagent");
    await runMission(
      store.recordEvidence({
        contextToken: active.token,
        producer: { kind: "pi-session" },
        milestone: {
          id: "run-1",
          kind: "agent-run",
          state: "completed",
          title: "Agent completed",
          occurredAt: new Date().toISOString(),
        },
      }),
    );
    assert.equal(
      (await runMission(store.getContext(active.token)))?.status,
      "completed",
    );

    const task = await runMission(
      store.createContext({
        missionId: "mission:test",
        title: "Task batch",
        cwd: root,
        source: "task",
        parentSessionId: "session-1",
      }),
    );
    await runMission(
      store.recordEvidence({
        contextToken: task.token,
        producer: { kind: "task-child" },
        milestone: {
          id: "child-agent",
          kind: "agent-run",
          state: "completed",
          title: "One child completed",
          occurredAt: new Date().toISOString(),
        },
      }),
    );
    assert.equal(
      (await runMission(store.getContext(task.token)))?.status,
      "active",
    );
    await runMission(
      store.recordEvidence({
        contextToken: task.token,
        producer: { kind: "pi-tasks" },
        milestone: {
          id: "task-batch",
          kind: "task-run",
          state: "completed",
          title: "Task batch completed",
          occurredAt: new Date().toISOString(),
        },
      }),
    );
    assert.equal(
      (await runMission(store.getContext(task.token)))?.status,
      "completed",
    );
  });
});

test("rejects receipts for unknown contexts", async () => {
  await fixture(async (store) => {
    await assert.rejects(
      runMission(
        store.recordEvidence({
          contextToken: "mc_00000000000000000000000000000000",
          producer: { kind: "test" },
          milestone: {
            id: "missing",
            kind: "checkpoint",
            state: "failed",
            title: "Missing",
            occurredAt: new Date().toISOString(),
          },
        }),
      ),
      /unknown mission context/,
    );
  });
});
