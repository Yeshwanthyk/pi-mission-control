import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

async function fixture(
  run: (store: MissionStore, root: string, token: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-publication-"));
  const store = new MissionStore(root);
  try {
    const context = await runMission(
      store.createContext({
        missionId: "mission",
        title: "Mission",
        cwd: root,
        source: "cli",
        parentSessionId: "session",
      }),
    );
    await run(store, root, context.token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function input(token: string, eventId: string, content: string) {
  return {
    eventId,
    contextToken: token,
    producer: { kind: "test" },
    milestone: {
      id: "m",
      kind: "checkpoint",
      state: "completed" as const,
      title: "Done",
      occurredAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [{ role: "report", content }],
  };
}

test("artifact retry reuses exact orphan output without replacing bytes", async () => {
  await fixture(async (store, _root, token) => {
    const destination = path.join(store.paths.artifacts, "orphan-exact");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "01-artifact.txt"), "same");
    const receipt = await runMission(
      store.recordEvidence(input(token, "orphan-exact", "same")),
    );
    assert.equal(
      await readFile(receipt.artifacts[0]?.path ?? "", "utf8"),
      "same",
    );
    assert.equal((await readdir(store.paths.quarantine)).length, 0);
  });
});

test("dead event-lock owners are recovered without deleting live output", async () => {
  await fixture(async (store, _root, token) => {
    await writeFile(
      path.join(store.paths.locks, "dead-owner.lock"),
      JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }),
    );
    const receipt = await runMission(
      store.recordEvidence(input(token, "dead-owner", "recovered")),
    );
    assert.equal(receipt.eventId, "dead-owner");
  });
});

test("mismatched orphan output is quarantined, while published output is never removed", async () => {
  await fixture(async (store, _root, token) => {
    const destination = path.join(store.paths.artifacts, "orphan-conflict");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "01-artifact.txt"), "orphan");
    const receipt = await runMission(
      store.recordEvidence(input(token, "orphan-conflict", "committed")),
    );
    assert.equal(
      await readFile(receipt.artifacts[0]?.path ?? "", "utf8"),
      "committed",
    );
    assert.equal((await readdir(store.paths.quarantine)).length, 1);
    await assert.rejects(
      runMission(
        store.recordEvidence(input(token, "orphan-conflict", "different")),
      ),
      /event ID conflicts/,
    );
    assert.equal(
      await readFile(receipt.artifacts[0]?.path ?? "", "utf8"),
      "committed",
    );
  });
});
