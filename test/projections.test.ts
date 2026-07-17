import assert from "node:assert/strict";
import test from "node:test";
import { ProjectionRegistry } from "../src/projections.ts";

test("task projection follows TaskCreate, TaskUpdate, and TaskList results", async () => {
  const registry = new ProjectionRegistry();
  registry.observeTaskResult(
    "TaskCreate",
    { subject: "Build evidence store" },
    "Task #7 created successfully: Build evidence store",
    false,
  );
  registry.observeTaskResult(
    "TaskUpdate",
    { taskId: "7", status: "in_progress" },
    "Updated task #7 status",
    false,
  );
  registry.observeTaskResult(
    "TaskUpdate",
    { taskId: "99", status: "completed" },
    "Task #99 not found",
    false,
  );
  registry.observeTaskResult(
    "TaskList",
    {},
    "#7 [in_progress] Build evidence store (agent-1)\n#8 [pending] Build UI [blocked by #7]",
    false,
  );
  const snapshot = await registry.snapshot([], [], "nonexistent-session");
  assert.deepEqual(
    snapshot.tasks.map(({ id, status, blockedBy }) => ({
      id,
      status,
      blockedBy,
    })),
    [
      { id: "7", status: "in_progress", blockedBy: [] },
      { id: "8", status: "pending", blockedBy: ["7"] },
    ],
  );
});
