import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MissionIndex } from "../src/mission-index.ts";
import { MissionPlanStore } from "../src/mission-plan-store.ts";
import { buildMissionProjection } from "../src/mission-projection.ts";
import { MissionStore } from "../src/store.ts";
import {
  canonicalExternalIdentity,
  storageKey,
} from "../src/mission-validation.ts";
import { runMission } from "../src/runtime.ts";
import type {
  MissionPlan,
  MissionSessionAttribution,
} from "../src/mission-types.ts";

const now = "2026-01-01T00:00:00.000Z";
const missionId = "mission:/shared/雪";
const plan: MissionPlan = {
  schema: "pi.mission-plan/v1",
  missionId,
  title: "Shared mission",
  state: "active",
  revision: 0,
  schedule: { mode: "serial" },
  items: [
    {
      itemId: "foundation",
      order: 0,
      title: "Foundation",
      state: "active",
      estimate: {
        unit: "minute",
        expected: 5,
        optimistic: 3,
        pessimistic: 8,
        asOf: now,
        scope: "schedule",
      },
      dependencyItemIds: [],
      contributorSessionIds: ["session-1"],
      externalRefs: [],
      updatedAt: now,
    },
  ],
  createdAt: now,
  updatedAt: now,
};
const member: MissionSessionAttribution = {
  schema: "pi.mission-session/v1",
  missionId,
  sessionId: "session-1",
  displayName: "Writer",
  initials: "WR",
  color: "blue",
  firstSeenAt: now,
  lastSeenAt: now,
  revision: 0,
};

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mission-plan-store-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("operations are idempotent, CAS-bound, and generation snapshots link exact evidence", async () => {
  await fixture(async (root) => {
    const plans = new MissionPlanStore(root);
    const legacy = new MissionStore(root);
    await plans.createPlan(plan, "create-1");
    const firstGeneration = await plans.readCurrentGeneration(missionId);
    const committed = await plans.operations.get(missionId, "create-1");
    assert.ok(committed);
    const { resultRef: _resultRef, ...withoutResult } = committed;
    await plans.operations.put({ ...withoutResult, state: "intent" });
    await plans.createPlan(plan, "create-1");
    assert.equal(
      (await plans.readCurrentGeneration(missionId))?.generation,
      firstGeneration?.generation,
    );
    assert.equal(
      (await plans.operations.get(missionId, "create-1"))?.state,
      "committed",
    );
    await assert.rejects(
      plans.createPlan({ ...plan, title: "Different" }, "create-1"),
      /IDEMPOTENCY_CONFLICT/,
    );

    await plans.upsertSession(member, null, "member-1");
    const bindingInput = {
      sessionId: member.sessionId,
      missionId,
      itemId: "foundation",
      expectedRevision: 0,
      idempotencyKey: "bind-1",
    } as const;
    const firstBinding = await plans.setBinding(bindingInput);
    const retriedBinding = await plans.setBinding(bindingInput);
    assert.deepEqual(retriedBinding, firstBinding);
    await assert.rejects(
      plans.setBinding({
        sessionId: member.sessionId,
        missionId,
        itemId: "foundation",
        expectedRevision: 0,
        idempotencyKey: "bind-stale",
      }),
      /STALE_BINDING_REVISION/,
    );
    assert.equal(
      await plans.operations.get(missionId, "bind-stale"),
      undefined,
      "rejected CAS must not leave an operation intent",
    );

    const context = await runMission(
      legacy.createContext({
        missionId,
        title: "Shared mission",
        cwd: root,
        source: "session",
        parentSessionId: member.sessionId,
      }),
    );
    await plans.indexContext(missionId, context.token, "context-1");
    const receipt = await runMission(
      legacy.recordEvidence({
        eventId: "semantic-one",
        contextToken: context.token,
        producer: { kind: "test", sessionId: member.sessionId },
        milestone: {
          id: "m1",
          kind: "checkpoint",
          state: "completed",
          title: "Foundation durable",
          occurredAt: now,
        },
        artifacts: [
          { role: "screenshot", content: "image bytes" },
          {
            role: "diff",
            content: "--- a/file\n+++ b/file\n-old\n+new\n",
            mediaType: "text/x-diff",
          },
        ],
      }),
    );
    const beforeLink = (await plans.readCurrentGeneration(missionId))
      ?.generation;
    const diff = receipt.artifacts[1];
    assert.ok(diff);
    await assert.rejects(
      plans.linkEvidence(
        {
          schema: "pi.mission-evidence-link/v1",
          linkId: "link-invalid-stats",
          missionId,
          itemId: "foundation",
          eventId: receipt.eventId,
          sessionId: member.sessionId,
          classification: "semantic",
          stateEffect: { kind: "none" },
          changeStats: [
            {
              additions: 99,
              deletions: 99,
              provenance: {
                artifactId: diff.artifactId,
                sha256: diff.sha256,
                parser: "unified-diff/v1",
              },
            },
          ],
          createdAt: now,
        },
        "link-invalid-stats",
      ),
      /CHANGE_STATS_MISMATCH/,
    );
    assert.equal(
      await plans.operations.get(missionId, "link-invalid-stats"),
      undefined,
    );
    await plans.linkEvidence(
      {
        schema: "pi.mission-evidence-link/v1",
        linkId: "link-one",
        missionId,
        itemId: "foundation",
        eventId: receipt.eventId,
        sessionId: member.sessionId,
        classification: "semantic",
        stateEffect: { kind: "none" },
        changeStats: [
          {
            additions: 1,
            deletions: 1,
            provenance: {
              artifactId: diff.artifactId,
              sha256: diff.sha256,
              parser: "unified-diff/v1",
            },
          },
        ],
        createdAt: now,
      },
      "link-1",
    );
    const snapshot = await new MissionIndex(root).snapshot(missionId);
    assert.equal(snapshot.generation, (beforeLink ?? -1) + 1);
    const projection = buildMissionProjection(snapshot, () => new Date(now));
    assert.equal(projection.progress.length, 1);
    assert.equal(projection.progress[0]?.eventId, receipt.eventId);
    assert.equal(projection.roadmap[0]?.phase, "current");
  });
});

test("binding moves publish both mission generations before committing", async () => {
  await fixture(async (root) => {
    const plans = new MissionPlanStore(root);
    await plans.createPlan(plan, "create-a");
    await plans.upsertSession(member, null, "member-a");
    await plans.setBinding({
      sessionId: member.sessionId,
      missionId,
      itemId: "foundation",
      expectedRevision: 0,
      idempotencyKey: "bind-a",
    });
    const otherMission = "mission:other";
    const otherPlan = { ...plan, missionId: otherMission };
    const otherMember = { ...member, missionId: otherMission };
    await plans.createPlan(otherPlan, "create-b");
    await plans.upsertSession(otherMember, null, "member-b");
    const moved = await plans.setBinding({
      sessionId: member.sessionId,
      missionId: otherMission,
      itemId: "foundation",
      expectedRevision: 1,
      idempotencyKey: "move",
    });
    assert.equal(moved.missionId, otherMission);
    const operationId = plans.operations.operationId(otherMission, "move");
    assert.equal(
      (
        await plans.readCurrentGeneration(missionId)
      )?.committedOperationIds.includes(operationId),
      true,
    );
    assert.equal(
      (
        await plans.readCurrentGeneration(otherMission)
      )?.committedOperationIds.includes(operationId),
      true,
    );
    const retried = await plans.setBinding({
      sessionId: member.sessionId,
      missionId: otherMission,
      itemId: "foundation",
      expectedRevision: 1,
      idempotencyKey: "move",
    });
    assert.deepEqual(retried, moved);
  });
});

test("execution binding transitions are CAS-checked, identity-stable, and monotonic", async () => {
  await fixture(async (root) => {
    const plans = new MissionPlanStore(root);
    const legacy = new MissionStore(root);
    await plans.createPlan(plan, "create");
    await plans.upsertSession(member, null, "member");
    await plans.setBinding({
      sessionId: member.sessionId,
      missionId,
      itemId: "foundation",
      expectedRevision: 0,
      idempotencyKey: "binding",
    });
    const context = await runMission(
      legacy.createContext({
        missionId,
        title: "Shared mission",
        cwd: root,
        source: "session",
        parentSessionId: member.sessionId,
      }),
    );
    const externalRef = {
      kind: "pi-workflow" as const,
      producerNamespace: "workflow-tests",
      runId: "run-1",
    };
    const intent = {
      schema: "pi.mission-execution-binding/v1" as const,
      bindingId: "execution",
      missionId,
      itemId: "foundation",
      sessionId: member.sessionId,
      parentContextToken: context.token,
      toolCallId: "tool-call",
      externalRef,
      canonicalIdentity: canonicalExternalIdentity(externalRef),
      state: "intent" as const,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    await assert.rejects(
      plans.bindExecution({ ...intent, state: "bound" }, "direct-bound"),
      /INVALID_EXECUTION_REVISION/,
    );
    assert.equal(
      await plans.operations.get(missionId, "direct-bound"),
      undefined,
    );
    await plans.bindExecution(intent, "intent");
    const bound = { ...intent, state: "bound" as const, revision: 1 };
    await plans.bindExecution(bound, "bound");
    const terminal = {
      ...bound,
      state: "completed" as const,
      revision: 2,
    };
    await plans.bindExecution(terminal, "terminal");
    await assert.rejects(
      plans.bindExecution(
        { ...terminal, state: "failed", revision: 3 },
        "regression",
      ),
      /TERMINAL_EXECUTION_REGRESSION/,
    );
    await assert.rejects(
      plans.bindExecution(
        { ...terminal, toolCallId: "changed", revision: 3 },
        "identity-change",
      ),
      /EXECUTION_IDENTITY_CHANGED/,
    );
  });
});

test("generation readers reject keyed immutable records with mismatched identity", async () => {
  await fixture(async (root) => {
    const plans = new MissionPlanStore(root);
    await plans.createPlan(plan, "create");
    const generation = await plans.readCurrentGeneration(missionId);
    assert.ok(generation?.planKey);
    const planPath = path.join(plans.paths.plans, generation.planKey);
    const stored = JSON.parse(await readFile(planPath, "utf8")) as MissionPlan;
    await writeFile(
      planPath,
      `${JSON.stringify({ ...stored, missionId: "other-mission" }, null, 2)}\n`,
    );
    await assert.rejects(
      new MissionIndex(root).snapshot(missionId),
      /STORAGE_KEY_MISMATCH/,
    );
    assert.notEqual(
      storageKey("mission", missionId),
      storageKey("mission", "other-mission"),
    );
  });
});

test("bindings require explicit membership and fork inheritance is explicit", async () => {
  await fixture(async (root) => {
    const plans = new MissionPlanStore(root);
    await plans.createPlan(plan, "create");
    await assert.rejects(
      plans.setBinding({
        sessionId: "outsider",
        missionId,
        itemId: "foundation",
        expectedRevision: 0,
        idempotencyKey: "bind",
      }),
      /SESSION_NOT_MEMBER/,
    );
    await plans.upsertSession(member, null, "member");
    await plans.setBinding({
      sessionId: member.sessionId,
      missionId,
      itemId: "foundation",
      expectedRevision: 0,
      idempotencyKey: "bind-member",
    });
    await assert.rejects(
      plans.forkBinding(member.sessionId, "fork", 0, "fork-1"),
      /SESSION_NOT_MEMBER/,
    );
  });
});
