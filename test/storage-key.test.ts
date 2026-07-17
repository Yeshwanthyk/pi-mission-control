import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  storageKey,
  validateNewLogicalId,
  verifyStorageIdentity,
} from "../src/mission-validation.ts";

for (const id of [
  "mission:session",
  "mission/../../escape",
  "雪",
  "..",
  "a:b/c",
]) {
  test(`opaque logical ID stays out of paths: ${id}`, () => {
    const key = storageKey("mission", id);
    assert.match(key, /^k_[a-f0-9]{64}$/);
    assert.equal(path.basename(key), key);
    assert.doesNotThrow(() => verifyStorageIdentity("mission", id, key));
  });
}

test("storage identities reject mismatches and new controls", () => {
  assert.throws(
    () => verifyStorageIdentity("mission", "a", storageKey("mission", "b")),
    /STORAGE_KEY_MISMATCH/,
  );
  assert.throws(() => validateNewLogicalId("a\0b"), /INVALID_LOGICAL_ID/);
  assert.notEqual(storageKey("mission", "é"), storageKey("mission", "é"));
});
