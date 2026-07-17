import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

test("Pi loads the extension and propagates workflow context through tool_call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-extension-"));
  const previousHome = process.env.MISSION_CONTROL_HOME;
  process.env.MISSION_CONTROL_HOME = path.join(root, "store");
  try {
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: true,
    });
    const extensionPath = path.resolve(
      import.meta.dirname,
      "..",
      "extensions",
      "mission-control",
      "index.ts",
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager,
    });
    await session.bindExtensions({ mode: "print" });
    assert.ok(session.getActiveToolNames().includes("mission_record"));

    await session.extensionRunner.emitInput(
      "Implement the mission feature",
      undefined,
      "interactive",
    );
    assert.ok(
      sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi.mission-context-ref/v1",
        ),
    );

    const input: Record<string, unknown> = {
      script: `export const meta = { name: "demo", phases: [] };\nreturn await agent("inspect");`,
    };
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "workflow",
      toolCallId: "call-workflow-1",
      input,
    });
    assert.match(String(input.script), /pi-mission-control workflow context/);
    assert.match(String(input.script), /pi-execution-context/);

    const taskInput: Record<string, unknown> = { task_ids: ["1", "2"] };
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "TaskExecute",
      toolCallId: "call-task-batch",
      input: taskInput,
    });
    assert.match(String(taskInput.additional_context), /pi-execution-context/);
    await session.extensionRunner.emitToolResult({
      type: "tool_result",
      toolName: "TaskExecute",
      toolCallId: "call-task-batch",
      input: taskInput,
      content: [
        {
          type: "text",
          text: "Launched 2 agent(s):\n#1 → agent sa-1\n#2 → agent sa-2",
        },
      ],
      details: undefined,
      isError: false,
    });
    await session.extensionRunner.emitToolResult({
      type: "tool_result",
      toolName: "TaskList",
      toolCallId: "call-task-list",
      input: {},
      content: [
        {
          type: "text",
          text: "#1 [completed] First task\n#2 [completed] Second task",
        },
      ],
      details: undefined,
      isError: false,
    });
    const taskContexts = (
      await runMission(
        new MissionStore(path.join(root, "store")).listContexts(),
      )
    ).filter((context) => context.source === "task");
    assert.equal(taskContexts.length, 1);
    assert.equal(taskContexts[0]?.sourceId, "tasks:1,2");
    assert.equal(taskContexts[0]?.status, "completed");

    const childSettings = SettingsManager.inMemory(undefined, {
      projectTrusted: true,
    });
    const childLoader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(root, "child-agent"),
      settingsManager: childSettings,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await childLoader.reload();
    const childSessionManager = SessionManager.inMemory(cwd);
    const { session: childSession } = await createAgentSession({
      cwd,
      agentDir: path.join(root, "child-agent"),
      resourceLoader: childLoader,
      settingsManager: childSettings,
      sessionManager: childSessionManager,
    });
    await childSession.bindExtensions({ mode: "print" });
    await childSession.extensionRunner.emitBeforeAgentStart(
      String(taskInput.additional_context),
      undefined,
      "base system prompt",
      { cwd },
    );
    assert.ok(
      childSessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi.mission-context-ref/v1",
        ),
    );
    await childSession.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    childSession.dispose();

    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.MISSION_CONTROL_HOME;
    else process.env.MISSION_CONTROL_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
