import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MissionPlanStore } from "../src/mission-plan-store.ts";
import { MissionRecordService } from "../src/mission-record-service.ts";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";
import type { MissionPlan } from "../src/mission-types.ts";

const now = "2026-01-01T00:00:00.000Z";

test("linked recording persists one recoverable operation and retries without mutable sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-record-service-"));
  try {
    const missionId = "mission-record";
    const sessionId = "session-record";
    const plans = new MissionPlanStore(root);
    const legacy = new MissionStore(root);
    const plan: MissionPlan = {
      schema: "pi.mission-plan/v1",
      missionId,
      title: "Record mission",
      state: "active",
      revision: 0,
      schedule: { mode: "serial" },
      items: [
        {
          itemId: "item",
          order: 0,
          title: "Record evidence",
          state: "active",
          dependencyItemIds: [],
          contributorSessionIds: [sessionId],
          externalRefs: [],
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await plans.createPlan(plan, "create");
    await plans.upsertSession(
      {
        schema: "pi.mission-session/v1",
        missionId,
        sessionId,
        displayName: "Recorder",
        initials: "RC",
        color: "blue",
        firstSeenAt: now,
        lastSeenAt: now,
        revision: 0,
      },
      null,
      "member",
    );
    await plans.setBinding({
      sessionId,
      missionId,
      itemId: "item",
      expectedRevision: 0,
      idempotencyKey: "binding",
    });
    const context = await runMission(
      legacy.createContext({
        missionId,
        title: "Record mission",
        cwd: root,
        source: "session",
        parentSessionId: sessionId,
      }),
    );
    const source = path.join(root, "source.diff");
    await writeFile(source, "--- a/file\n+++ b/file\n-old\n+new\n");
    const input = {
      missionId,
      itemId: "item",
      sessionId,
      idempotencyKey: "record",
      classification: "semantic" as const,
      evidence: {
        contextToken: context.token,
        producer: { kind: "test", sessionId },
        milestone: {
          id: "milestone",
          kind: "checkpoint",
          state: "completed" as const,
          title: "Recorded",
          occurredAt: now,
        },
        artifacts: [{ role: "diff", path: source }],
      },
    };
    const service = new MissionRecordService(root);
    const link = await service.record(input);
    const generation = await plans.readCurrentGeneration(missionId);
    const operation = await plans.operations.get(missionId, "record");
    assert.equal(operation?.kind, "evidence-record-link");
    assert.equal(operation?.state, "committed");
    assert.deepEqual(operation?.publications, [
      "artifacts",
      "receipt",
      "generation",
    ]);
    assert.equal(operation?.artifactManifest?.length, 1);
    assert.equal(generation?.evidenceLinkKeys.length, 1);

    assert.ok(operation);
    await plans.operations.put({ ...operation, state: "retryable" });
    await rm(source);
    const retried = await service.record(input);
    assert.deepEqual(retried, link);
    assert.equal(
      (await plans.readCurrentGeneration(missionId))?.generation,
      generation?.generation,
    );
    assert.equal(
      (await plans.operations.get(missionId, "record"))?.state,
      "committed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
