import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { canonicalExternalIdentity } from "../src/mission-validation.ts";

async function capture(
  args: readonly string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout(value) {
      stdout += value;
    },
    stderr(value) {
      stderr += value;
    },
    async readStdin() {
      return stdin;
    },
  });
  return { code, stdout, stderr };
}

test("CLI creates a context, records stdin evidence, and lists it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-cli-"));
  try {
    const created = await capture([
      "context-create",
      "--root",
      root,
      "--mission",
      "demo",
      "--title",
      "Demo mission",
    ]);
    assert.equal(created.code, 0, created.stderr);
    const token = (JSON.parse(created.stdout) as { token: string }).token;
    const migrated = await capture(
      ["migrate", "index", "--root", root, "--stdin"],
      JSON.stringify({
        sourceMissionId: "demo",
        contextToken: token,
        targetMissionId: "demo",
        idempotencyKey: "index-demo-context",
      }),
    );
    assert.equal(migrated.code, 0, migrated.stderr);
    assert.equal(
      (JSON.parse(migrated.stdout) as { contextToken: string }).contextToken,
      token,
    );
    const input = JSON.stringify({
      producer: { kind: "external-agent" },
      milestone: {
        id: "run",
        kind: "agent-run",
        state: "completed",
        title: "External run complete",
        occurredAt: new Date().toISOString(),
      },
      artifacts: [{ role: "note", content: "done" }],
    });
    const recorded = await capture(
      ["record", "--root", root, "--context", token, "--stdin"],
      input,
    );
    assert.equal(recorded.code, 0, recorded.stderr);
    const receipt = JSON.parse(recorded.stdout) as {
      contextToken: string;
      artifacts: Array<{ artifactId: string }>;
    };
    assert.equal(receipt.contextToken, token);
    const artifactId = receipt.artifacts[0]?.artifactId;
    assert.ok(artifactId);
    const verified = await capture([
      "artifact",
      "verify",
      artifactId,
      "--root",
      root,
    ]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(
      (JSON.parse(verified.stdout) as { descriptor: { artifactId: string } })
        .descriptor.artifactId,
      artifactId,
    );
    assert.doesNotMatch(verified.stdout, /"fd"|"path"/);

    const listed = await capture(["list", "--root", root, "--context", token]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exposes scriptable plan creation and deterministic JSON projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-cli-plan-"));
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const plan = {
      schema: "pi.mission-plan/v1",
      missionId: "mission:/cli",
      title: "CLI mission",
      state: "planned",
      revision: 0,
      schedule: { mode: "serial" },
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    const created = await capture(
      [
        "plan",
        "create",
        "--root",
        root,
        "--stdin",
        "--idempotency-key",
        "create",
      ],
      JSON.stringify(plan),
    );
    assert.equal(created.code, 0, created.stderr);
    const shown = await capture([
      "mission",
      "show",
      "--root",
      root,
      "--mission",
      "mission:/cli",
      "--json",
    ]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(
      (JSON.parse(shown.stdout) as { header: { title: string } }).header.title,
      "CLI mission",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI linked record follows the durable binding and rejects a foreign context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-cli-linked-"));
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const missionId = "mission:/linked";
    const sessionId = "session-linked";
    const plan = {
      schema: "pi.mission-plan/v1",
      missionId,
      title: "Linked mission",
      state: "active",
      revision: 0,
      schedule: { mode: "serial" },
      items: [
        {
          itemId: "item-1",
          order: 0,
          title: "Linked item",
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
    assert.equal(
      (
        await capture(
          [
            "plan",
            "create",
            "--root",
            root,
            "--stdin",
            "--idempotency-key",
            "plan",
          ],
          JSON.stringify(plan),
        )
      ).code,
      0,
    );
    const member = {
      schema: "pi.mission-session/v1",
      missionId,
      sessionId,
      displayName: "Linked writer",
      initials: "LW",
      color: "blue",
      firstSeenAt: now,
      lastSeenAt: now,
      revision: 0,
    };
    assert.equal(
      (
        await capture(
          [
            "session",
            "add",
            "--root",
            root,
            "--stdin",
            "--idempotency-key",
            "member",
          ],
          JSON.stringify(member),
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await capture([
          "binding",
          "set",
          "--root",
          root,
          "--session",
          sessionId,
          "--mission",
          missionId,
          "--item",
          "item-1",
          "--expected-revision",
          "0",
          "--idempotency-key",
          "binding",
        ])
      ).code,
      0,
    );
    const context = await capture([
      "context-create",
      "--root",
      root,
      "--mission",
      missionId,
      "--title",
      "Linked context",
      "--session",
      sessionId,
    ]);
    const token = (JSON.parse(context.stdout) as { token: string }).token;
    const linked = await capture([
      "record",
      "--root",
      root,
      "--context",
      token,
      "--mission",
      missionId,
      "--item",
      "item-1",
      "--session",
      sessionId,
      "--idempotency-key",
      "record-1",
      "--title",
      "Boundary verified",
    ]);
    assert.equal(linked.code, 0, linked.stderr);
    assert.equal(
      (JSON.parse(linked.stdout) as { itemId: string }).itemId,
      "item-1",
    );

    const externalRef = {
      kind: "pi-workflow" as const,
      producerNamespace: "pi-workflows",
      runId: "run-1",
    };
    const executionIntent = {
      schema: "pi.mission-execution-binding/v1" as const,
      bindingId: "execution-1",
      missionId,
      itemId: "item-1",
      sessionId,
      parentContextToken: token,
      toolCallId: "tool-call-1",
      externalRef,
      canonicalIdentity: canonicalExternalIdentity(externalRef),
      state: "intent" as const,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const intent = await capture(
      [
        "link",
        "execution",
        "--root",
        root,
        "--stdin",
        "--idempotency-key",
        "execution-intent-1",
      ],
      JSON.stringify(executionIntent),
    );
    assert.equal(intent.code, 0, intent.stderr);
    const execution = await capture(
      [
        "link",
        "execution",
        "--root",
        root,
        "--stdin",
        "--idempotency-key",
        "execution-bound-1",
      ],
      JSON.stringify({
        ...executionIntent,
        state: "bound",
        revision: 1,
      }),
    );
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(
      (JSON.parse(execution.stdout) as { bindingId: string }).bindingId,
      "execution-1",
    );

    const shown = await capture([
      "mission",
      "show",
      "--root",
      root,
      "--mission",
      missionId,
      "--json",
    ]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(
      (
        JSON.parse(shown.stdout) as { progress: Array<{ title: string }> }
      ).progress.map((row) => row.title),
      ["Boundary verified"],
    );

    const foreign = await capture([
      "context-create",
      "--root",
      root,
      "--mission",
      missionId,
      "--title",
      "Foreign context",
      "--session",
      "other-session",
    ]);
    const foreignToken = (JSON.parse(foreign.stdout) as { token: string })
      .token;
    const rejected = await capture([
      "record",
      "--root",
      root,
      "--context",
      foreignToken,
      "--mission",
      missionId,
      "--item",
      "item-1",
      "--session",
      sessionId,
      "--idempotency-key",
      "record-foreign",
      "--title",
      "Must reject",
    ]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /CONTEXT_SESSION_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reports invalid commands without throwing", async () => {
  const result = await capture(["nope"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command/);
});
