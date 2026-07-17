import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { MissionIndex } from "../src/mission-index.ts";
import { MissionPlanStore } from "../src/mission-plan-store.ts";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function harness(root: string, mode: "print" | "tui") {
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
  await session.bindExtensions({ mode });
  return { session, sessionManager, cwd };
}

test("extension stays unbound until explicit context and propagates only exact ancestry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-extension-"));
  const previousHome = process.env.MISSION_CONTROL_HOME;
  process.env.MISSION_CONTROL_HOME = path.join(root, "store");
  try {
    const { session, sessionManager, cwd } = await harness(root, "print");
    assert.ok(session.getActiveToolNames().includes("mission_record"));

    await session.extensionRunner.emitInput(
      "Implement the mission feature",
      undefined,
      "interactive",
    );
    assert.equal(
      sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi.mission-context-ref/v1",
        ),
      false,
    );
    const nonTuiCommand = session.extensionRunner.getCommand("mission");
    assert.ok(nonTuiCommand);
    await assert.rejects(() =>
      nonTuiCommand.handler("", session.extensionRunner.createCommandContext()),
    );

    const store = new MissionStore(path.join(root, "store"));
    const explicit = await runMission(
      store.createContext({
        missionId: "explicit-mission",
        title: "Explicit mission",
        cwd,
        source: "session",
        parentSessionId: sessionManager.getSessionId(),
      }),
    );
    const result = await session.extensionRunner.emitBeforeAgentStart(
      `<pi-execution-context token="${explicit.token}"/>`,
      undefined,
      "base system prompt",
      { cwd },
    );
    assert.match(result?.systemPrompt ?? "", /Mission evidence context/);
    assert.ok(
      sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi.mission-context-ref/v1",
        ),
    );

    const workflowInput: Record<string, unknown> = {
      script: `export const meta = { name: "demo", phases: [] };\nreturn await agent("inspect");`,
    };
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "workflow",
      toolCallId: "call-workflow-1",
      input: workflowInput,
    });
    assert.match(String(workflowInput.script), /pi-execution-context/);

    const taskInput: Record<string, unknown> = { task_ids: ["1", "2"] };
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "TaskExecute",
      toolCallId: "call-task-batch",
      input: taskInput,
    });
    assert.match(String(taskInput.additional_context), /pi-execution-context/);

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

test("bound mission_record creates an exact session context and linked projection row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-bound-record-"));
  const storeRoot = path.join(root, "store");
  const previousHome = process.env.MISSION_CONTROL_HOME;
  process.env.MISSION_CONTROL_HOME = storeRoot;
  try {
    const { session, sessionManager } = await harness(root, "print");
    const sessionId = sessionManager.getSessionId();
    const now = "2026-01-01T00:00:00.000Z";
    const plans = new MissionPlanStore(storeRoot);
    await plans.createPlan(
      {
        schema: "pi.mission-plan/v1",
        missionId: "bound-mission",
        title: "Bound mission",
        state: "active",
        revision: 0,
        schedule: { mode: "serial" },
        items: [
          {
            itemId: "active-item",
            order: 0,
            title: "Active item",
            state: "active",
            dependencyItemIds: [],
            contributorSessionIds: [sessionId],
            externalRefs: [],
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      "create-plan",
    );
    await plans.upsertSession(
      {
        schema: "pi.mission-session/v1",
        missionId: "bound-mission",
        sessionId,
        displayName: "Bound writer",
        initials: "BW",
        color: "blue",
        firstSeenAt: now,
        lastSeenAt: now,
        revision: 0,
      },
      null,
      "add-member",
    );
    await plans.setBinding({
      sessionId,
      missionId: "bound-mission",
      itemId: "active-item",
      expectedRevision: 0,
      idempotencyKey: "bind-session",
    });

    const foreign = await runMission(
      new MissionStore(storeRoot).createContext({
        missionId: "other-mission",
        title: "Stale primary",
        cwd: root,
        source: "session",
        parentSessionId: sessionId,
      }),
    );
    await session.extensionRunner.emitBeforeAgentStart(
      `<pi-execution-context token="${foreign.token}"/>`,
      undefined,
      "base system prompt",
      { cwd: root },
    );

    const tool = session.extensionRunner.getToolDefinition("mission_record");
    assert.ok(tool);
    const result = await tool.execute(
      "record-call-1",
      { title: "Integrated milestone", state: "completed" },
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
    assert.ok(isRecord(result.details));
    assert.equal(result.details.linked, true);
    const projection = await new MissionIndex(storeRoot).snapshot(
      "bound-mission",
    );
    assert.deepEqual(
      projection.contexts.map((context) => ({
        missionId: context.missionId,
        parentSessionId: context.parentSessionId,
      })),
      [{ missionId: "bound-mission", parentSessionId: sessionId }],
    );
    assert.equal(projection.evidenceLinks.length, 1);

    const workflowInput: Record<string, unknown> = {
      script: 'return await agent("inspect");',
    };
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "workflow",
      toolCallId: "workflow-call-1",
      input: workflowInput,
    });
    assert.match(String(workflowInput.script), /--mission 'bound-mission'/);
    assert.match(String(workflowInput.script), /--item 'active-item'/);
    assert.match(String(workflowInput.script), /--idempotency-key '<KEY>'/);
    session.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.MISSION_CONTROL_HOME;
    else process.env.MISSION_CONTROL_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("/mission uses the real custom Promise/factory lifecycle and unbound open writes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-custom-ui-"));
  const storeRoot = path.join(root, "store");
  const previousHome = process.env.MISSION_CONTROL_HOME;
  process.env.MISSION_CONTROL_HOME = storeRoot;
  try {
    const { session } = await harness(root, "tui");
    const base = session.extensionRunner.getUIContext();
    let factoryCalls = 0;
    let renderRequests = 0;
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const tui = {
      terminal: { rows: 12 },
      requestRender: () => {
        renderRequests++;
      },
    } as unknown as TUI;
    const keybindings = {} as KeybindingsManager;
    const uiContext: ExtensionUIContext = {
      ...base,
      custom<T>(
        factory: Parameters<ExtensionUIContext["custom"]>[0],
      ): Promise<T> {
        factoryCalls++;
        return new Promise<T>(async (resolve) => {
          const component = await factory(tui, theme, keybindings, (value) =>
            resolve(value as T),
          );
          component.render(40);
          component.invalidate();
          component.handleInput?.("\x1b");
        });
      },
    };
    session.extensionRunner.setUIContext(uiContext, "tui");
    const command = session.extensionRunner.getCommand("mission");
    assert.ok(command);
    await command.handler("", session.extensionRunner.createCommandContext());
    assert.equal(factoryCalls, 1);
    assert.ok(renderRequests >= 1);
    await assert.rejects(() => access(storeRoot));

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
