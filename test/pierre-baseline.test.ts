import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preloadDiffHTML, preloadPatchDiff } from "@pierre/diffs/ssr";

test("Pierre SSR baseline is pinned to the reviewed API", async () => {
  const root = path.dirname(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  );
  const packageValue = JSON.parse(
    await readFile(
      path.join(root, "node_modules", "@pierre", "diffs", "package.json"),
      "utf8",
    ),
  ) as unknown;
  assert.equal(
    typeof packageValue === "object" &&
      packageValue !== null &&
      "version" in packageValue
      ? packageValue.version
      : undefined,
    "1.2.12",
  );
  assert.equal(typeof preloadPatchDiff, "function");
  assert.equal(typeof preloadDiffHTML, "function");
});
