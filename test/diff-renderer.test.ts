import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderDiffPage } from "../src/artifacts/diff-renderer.ts";
import type { VerifiedArtifactDescriptor } from "../src/mission-types.ts";

async function withDescriptor(
  content: string,
  run: (descriptor: VerifiedArtifactDescriptor) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "diff-renderer-"));
  const file = path.join(root, "artifact.diff");
  writeFileSync(file, content);
  const bytes = Buffer.from(content);
  const fd = openSync(file, "r");
  try {
    await run({
      artifactId: "event:1",
      receiptEventId: "event",
      mediaType: "text/x-diff",
      role: "diff",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      fd,
    });
  } finally {
    closeSync(fd);
    await rm(root, { recursive: true, force: true });
  }
}

test("Pierre renders bounded single and multi-file diffs with a static CSP", async () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-c",
    "+d",
    "",
  ].join("\n");
  await withDescriptor(patch, async (descriptor) => {
    const html = await renderDiffPage(
      descriptor,
      `Diff <script>alert(1)</script>`,
    );
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'none'/);
    assert.doesNotMatch(html, /<title>Diff <script>/);
    assert.match(html, /Diff &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok((html.match(/data-diffs/g) ?? []).length >= 2);
  });
});

test("malformed diff is escaped source and artifact HTML stays inert", async () => {
  await withDescriptor(`<img src=x onerror=alert(1)>`, async (descriptor) => {
    const html = await renderDiffPage(descriptor);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
  });
});
