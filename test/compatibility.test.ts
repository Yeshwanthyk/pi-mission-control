import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

const fixture = fileURLToPath(
  new URL("fixtures/legacy-store-v1", import.meta.url),
);
const files = [
  "contexts/mc_legacy.json",
  "receipts/ev_legacy.json",
  "artifacts/ev_legacy/01-artifact.txt",
];

async function hashes(root: string): Promise<readonly string[]> {
  return Promise.all(
    files.map(async (file) =>
      createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    ),
  );
}

test("legacy v1 bytes and colon artifact IDs remain readable and untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-store-"));
  try {
    await cp(fixture, root, { recursive: true });
    const before = await hashes(root);
    const store = new MissionStore(root);
    const contexts = await runMission(store.listContexts());
    const receipts = await runMission(store.listReceipts());
    assert.equal(contexts[0]?.missionId, "mission:/../雪");
    assert.equal(receipts[0]?.artifacts[0]?.artifactId, "ev_legacy:1");
    assert.deepEqual(await hashes(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
