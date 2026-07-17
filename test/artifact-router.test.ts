import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactRouter } from "../src/artifacts/artifact-router.ts";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-router-"));
  const store = new MissionStore(root);
  const context = await runMission(
    store.createContext({
      missionId: "mission",
      title: "Mission",
      cwd: root,
      source: "cli",
      parentSessionId: "session",
    }),
  );
  const receipt = await runMission(
    store.recordEvidence({
      eventId: "event",
      contextToken: context.token,
      producer: { kind: "test" },
      milestone: {
        id: "milestone",
        kind: "checkpoint",
        state: "completed",
        title: "Evidence",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      artifacts: [
        { role: "diff", content: "safe bytes", mediaType: "text/x-diff" },
      ],
      payload: {},
    }),
  );
  const artifact = receipt.artifacts[0];
  assert.ok(artifact);
  return { root, artifact };
}

test("artifact IDs resolve to verified descriptors and survive later path replacement", async () => {
  const { root, artifact } = await fixture();
  try {
    const router = new ArtifactRouter(root);
    const result = await router.resolve(artifact.artifactId);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    const replaced = `${artifact.path}.old`;
    await rename(artifact.path, replaced);
    await writeFile(artifact.path, "hostile replacement");
    const bytes = Buffer.alloc(result.value.size);
    assert.equal(
      readSync(result.value.fd, bytes, 0, bytes.length, 0),
      bytes.length,
    );
    assert.equal(bytes.toString("utf8"), "safe bytes");
    router.close(result.value);
    assert.equal(readFileSync(artifact.path, "utf8"), "hostile replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact routing fails closed for unknown, hash, non-file, and symlink cases", async () => {
  const { root, artifact } = await fixture();
  try {
    const router = new ArtifactRouter(root);
    assert.equal((await router.resolve("../../escape")).status, "unavailable");
    await writeFile(artifact.path, "tampered!");
    assert.equal(
      (await router.resolve(artifact.artifactId)).status,
      "conflict",
    );

    await rm(artifact.path, { force: true });
    await symlink(path.join(root, "outside"), artifact.path);
    await writeFile(path.join(root, "outside"), "safe bytes");
    assert.equal(
      (await router.resolve(artifact.artifactId)).status,
      "conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact routing rejects root/intermediate symlinks and non-file leaves", async () => {
  const rootLink = await fixture();
  try {
    const artifacts = path.join(rootLink.root, "artifacts");
    const realArtifacts = path.join(rootLink.root, "artifacts-real");
    await rename(artifacts, realArtifacts);
    await symlink(realArtifacts, artifacts);
    assert.equal(
      (
        await new ArtifactRouter(rootLink.root).resolve(
          rootLink.artifact.artifactId,
        )
      ).status,
      "conflict",
    );
  } finally {
    await rm(rootLink.root, { recursive: true, force: true });
  }

  const intermediate = await fixture();
  try {
    const eventDirectory = path.dirname(intermediate.artifact.path);
    const realEvent = `${eventDirectory}-real`;
    await rename(eventDirectory, realEvent);
    await symlink(realEvent, eventDirectory);
    assert.equal(
      (
        await new ArtifactRouter(intermediate.root).resolve(
          intermediate.artifact.artifactId,
        )
      ).status,
      "conflict",
    );
  } finally {
    await rm(intermediate.root, { recursive: true, force: true });
  }

  const nonFile = await fixture();
  try {
    await rm(nonFile.artifact.path);
    await mkdir(nonFile.artifact.path);
    assert.equal(
      (
        await new ArtifactRouter(nonFile.root).resolve(
          nonFile.artifact.artifactId,
        )
      ).status,
      "conflict",
    );
  } finally {
    await rm(nonFile.root, { recursive: true, force: true });
  }
});

test("artifact routing rejects cross-receipt file references", async () => {
  const { root, artifact } = await fixture();
  try {
    const otherDirectory = path.join(root, "artifacts", "other-event");
    await mkdir(otherDirectory);
    const otherPath = path.join(otherDirectory, "artifact.txt");
    await writeFile(otherPath, "safe bytes");
    const receiptPath = path.join(root, "receipts", "event.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      artifacts: Array<{ path: string }>;
    };
    const first = receipt.artifacts[0];
    assert.ok(first);
    first.path = otherPath;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.equal(
      (await new ArtifactRouter(root).resolve(artifact.artifactId)).status,
      "conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact metadata mismatch is rejected before viewer consumption", async () => {
  const { root, artifact } = await fixture();
  try {
    const receiptPath = path.join(root, "receipts", "event.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      artifacts: Array<{ sha256: string }>;
    };
    const first = receipt.artifacts[0];
    assert.ok(first);
    first.sha256 = createHash("sha256").update("other").digest("hex");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.equal(
      (await new ArtifactRouter(root).resolve(artifact.artifactId)).status,
      "conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
