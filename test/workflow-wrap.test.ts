import assert from "node:assert/strict";
import test from "node:test";
import { extractContextToken } from "../src/context-prompt.ts";
import { wrapWorkflowScript } from "../src/workflow-wrap.ts";

test("workflow wrapper prefixes every agent prompt without producer changes", async () => {
  const prompts: string[] = [];
  const agent = async (prompt: unknown) => {
    prompts.push(String(prompt));
    return { ok: true };
  };
  const script = `await agent("first"); await Promise.all([agent("second"), agent("third")]);`;
  const wrapped = wrapWorkflowScript(
    script,
    '<pi-execution-context token="mc_1234567890"/>',
  );
  const run = new Function("agent", `return (async () => { ${wrapped} })()`);
  await run(agent);
  assert.equal(prompts.length, 3);
  assert.ok(
    prompts.every((prompt) => extractContextToken(prompt) === "mc_1234567890"),
  );
});

test("workflow wrapper preserves a strict-mode directive and is idempotent", () => {
  const script = `'use strict';\nawait agent("hello");`;
  const once = wrapWorkflowScript(script, "context");
  const twice = wrapWorkflowScript(once, "other");
  assert.match(once, /^'use strict';/);
  assert.equal(twice, once);
});
