import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { ExternalViewerController } from "../src/artifacts/viewer-router.ts";
import type { VerifiedArtifactDescriptor } from "../src/mission-types.ts";

function descriptor(filePath: string): VerifiedArtifactDescriptor {
  const bytes = readFileSync(filePath);
  return {
    artifactId: "event:1",
    receiptEventId: "event",
    mediaType: "text/plain",
    role: "report",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fd: openSync(filePath, "r"),
  };
}

test("external viewer receives only a read-only verified copy with exact argv and shell false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "viewer-router-"));
  const source = path.join(root, "source.txt");
  writeFileSync(source, "verified content");
  const verified = descriptor(source);
  let observed:
    | {
        executable: string;
        argv: readonly string[];
        shell: false;
      }
    | undefined;
  const controller = new ExternalViewerController(
    root,
    (executable, argv, options) => {
      observed = { executable, argv, shell: options.shell };
      return spawn(process.execPath, ["-e", ""], {
        detached: options.detached,
        stdio: options.stdio,
        shell: options.shell,
      });
    },
  );
  try {
    controller.open(verified, {
      executable: "/usr/bin/viewer",
      argv: [
        { kind: "literal", value: "--read-only" },
        { kind: "placeholder", value: "verifiedPath" },
      ],
    });
    assert.equal(observed?.executable, "/usr/bin/viewer");
    assert.equal(observed?.shell, false);
    const copy = observed?.argv[1];
    assert.ok(copy);
    assert.notEqual(copy, source);
    assert.equal(readFileSync(copy, "utf8"), "verified content");
    assert.equal(statSync(copy).mode & 0o777, 0o400);
    controller.open(verified, {
      executable: "/usr/bin/viewer",
      argv: [{ kind: "placeholder", value: "verifiedPath" }],
    });
    assert.equal(observed?.argv[0], copy);
    assert.equal(readFileSync(copy, "utf8"), "verified content");
    controller.close();
    assert.throws(() => statSync(copy));
  } finally {
    closeSync(verified.fd);
    try {
      unlinkSync(source);
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer routes reject interpolation and require exactly one typed placeholder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "viewer-route-invalid-"));
  const source = path.join(root, "source.txt");
  writeFileSync(source, "x");
  const verified = descriptor(source);
  const controller = new ExternalViewerController(root);
  try {
    assert.throws(() =>
      controller.open(verified, {
        executable: "viewer\nmalicious",
        argv: [{ kind: "placeholder", value: "verifiedPath" }],
      }),
    );
    assert.throws(() =>
      controller.open(verified, {
        executable: "viewer",
        argv: [{ kind: "literal", value: "{verifiedPath}" }],
      }),
    );
  } finally {
    closeSync(verified.fd);
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
