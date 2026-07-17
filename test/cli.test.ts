import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

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
    assert.equal(
      (JSON.parse(recorded.stdout) as { contextToken: string }).contextToken,
      token,
    );

    const listed = await capture(["list", "--root", root, "--context", token]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reports invalid commands without throwing", async () => {
  const result = await capture(["nope"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command/);
});
