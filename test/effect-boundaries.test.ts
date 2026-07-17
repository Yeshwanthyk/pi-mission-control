import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("the runtime is the only place mission effects are executed", async () => {
  const runtime = await source("src/runtime.ts");
  assert.match(runtime, /runPromiseExit/);

  const effectfulModules = await Promise.all(
    [
      "src/store.ts",
      "src/source-adapter.ts",
      "src/atomic.ts",
      "src/projections.ts",
      "src/presenter.ts",
      "src/cli.ts",
      "extensions/mission-control/index.ts",
    ].map(source),
  );
  for (const module of effectfulModules) {
    assert.doesNotMatch(module, /(?:Effect\.|ManagedRuntime\.)runPromise/);
  }
});

test("typed storage adapters are kept at the Node I/O edge", async () => {
  const [effect, atomic, store, sourceAdapter] = await Promise.all([
    source("src/effect.ts"),
    source("src/atomic.ts"),
    source("src/store.ts"),
    source("src/source-adapter.ts"),
  ]);
  assert.match(effect, /Effect\.tryPromise/);
  assert.match(atomic, /storage\(/);
  assert.doesNotMatch(store, /Effect\.tryPromise/);
  assert.doesNotMatch(sourceAdapter, /Effect\.tryPromise/);
});
