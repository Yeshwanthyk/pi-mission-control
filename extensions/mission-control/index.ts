import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  childPromptPrefix,
  extractContextToken,
  hasMissionPolicy,
  missionPolicy,
} from "../../src/context-prompt.ts";
import { createMissionPresenter } from "../../src/presenter.ts";
import { ProjectionRegistry } from "../../src/projections.ts";
import { PassiveSourceAdapter } from "../../src/source-adapter.ts";
import { MissionStore } from "../../src/store.ts";
import { runMission } from "../../src/runtime.ts";
import type {
  EvidenceArtifactInput,
  EvidenceReceipt,
  JsonValue,
  MissionContext,
  MissionContextReference,
} from "../../src/types.ts";
import { asJsonValue } from "../../src/validation.ts";
import { wrapWorkflowScript } from "../../src/workflow-wrap.ts";

const CONTEXT_ENTRY_TYPE = "pi.mission-context-ref/v1";
const STATUS_KEY = "mission-control";

const ArtifactParameter = Type.Object({
  role: Type.String({
    description:
      "Artifact role, such as diff, screenshot, report, test-log, or video",
  }),
  label: Type.Optional(Type.String()),
  path: Type.Optional(
    Type.String({ description: "Path to a closed artifact file" }),
  ),
  content: Type.Optional(
    Type.String({ description: "Inline textual artifact content" }),
  ),
  media_type: Type.Optional(Type.String()),
});

const MissionRecordParameters = Type.Object({
  title: Type.String({ description: "Human-readable milestone title" }),
  kind: Type.Optional(
    Type.String({ description: "Milestone kind; defaults to checkpoint" }),
  ),
  state: Type.Optional(
    StringEnum(["started", "completed", "failed", "cancelled"] as const),
  ),
  milestone_id: Type.Optional(Type.String()),
  parent_id: Type.Optional(Type.String()),
  context_token: Type.Optional(
    Type.String({ description: "Defaults to the active execution context" }),
  ),
  artifacts: Type.Optional(Type.Array(ArtifactParameter)),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type MissionRecordDetails = {
  readonly eventId: string;
  readonly contextToken: string;
  readonly artifactPaths: readonly string[];
};

interface AgentRunState {
  active: boolean;
  sequence: number;
  toolCounts: Map<string, number>;
  toolErrors: number;
  editPatches: string[];
}

export default function missionControl(pi: ExtensionAPI): void {
  const store = new MissionStore();
  const projections = new ProjectionRegistry();
  const presenter = createMissionPresenter(store, projections);
  const sourceAdapter = new PassiveSourceAdapter(store);
  const contexts = new Map<string, MissionContext>();
  const activeTokens = new Set<string>();
  const pendingLaunches = new Map<string, MissionContext>();
  let primaryToken: string | undefined;
  let ensurePromise: Promise<MissionContext> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciling = false;
  const agentRun: AgentRunState = {
    active: false,
    sequence: 0,
    toolCounts: new Map(),
    toolErrors: 0,
    editPatches: [],
  };

  const primaryContext = (): MissionContext | undefined =>
    primaryToken === undefined ? undefined : contexts.get(primaryToken);

  const refreshPresenter = async (): Promise<void> => {
    await presenter.refresh(activeTokens);
  };

  const reconcileSources = async (ctx: ExtensionContext): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      const snapshot = await runMission(store.snapshot(activeTokens));
      const sessionId = ctx.sessionManager.getSessionId();
      await runMission(sourceAdapter.reconcile(snapshot.contexts, sessionId));
      await reconcileTaskBatches(
        snapshot.contexts,
        snapshot.receipts,
        projections,
        store,
        sessionId,
      );
      await refreshPresenter();
    } catch {
      // Passive adapters retry; source tools must never be blocked by observation.
    } finally {
      reconciling = false;
    }
  };

  const updateStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;
    const receipts = await runMission(store.listReceipts(activeTokens));
    ctx.ui.setStatus(
      STATUS_KEY,
      activeTokens.size === 0
        ? undefined
        : `◆ ${activeTokens.size} context${activeTokens.size === 1 ? "" : "s"} · ${receipts.length} evidence`,
    );
  };

  const appendContextReference = (
    context: MissionContext,
    ctx: ExtensionContext,
  ): void => {
    const reference: MissionContextReference = {
      schema: "pi.mission-context-ref/v1",
      token: context.token,
      missionId: context.missionId,
      source: context.source,
      ...defined("sourceId", context.sourceId),
      createdAt: context.createdAt,
    };
    pi.appendEntry(CONTEXT_ENTRY_TYPE, reference);
    activeTokens.add(context.token);
    contexts.set(context.token, context);
    void updateStatus(ctx);
  };

  const ensureSessionContext = async (
    ctx: ExtensionContext,
    requestedTitle?: string,
  ): Promise<MissionContext> => {
    const existing = primaryContext();
    if (existing) return existing;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const sessionId = ctx.sessionManager.getSessionId();
      const context = await runMission(
        store.createContext({
          missionId: `mission:${sessionId}`,
          title:
            requestedTitle?.trim().slice(0, 120) ||
            `Session ${sessionId.slice(0, 8)}`,
          cwd: ctx.cwd,
          source: "session",
          parentSessionId: sessionId,
          ...defined(
            "originLeafId",
            ctx.sessionManager.getLeafId() ?? undefined,
          ),
        }),
      );
      primaryToken = context.token;
      appendContextReference(context, ctx);
      return context;
    })();
    try {
      return await ensurePromise;
    } finally {
      ensurePromise = undefined;
    }
  };

  const hydrateBranch = async (ctx: ExtensionContext): Promise<void> => {
    activeTokens.clear();
    contexts.clear();
    primaryToken = undefined;
    const references: MissionContextReference[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONTEXT_ENTRY_TYPE)
        continue;
      const reference = parseContextReference(entry.data);
      if (reference) references.push(reference);
    }
    for (const reference of references) {
      const context = await runMission(store.getContext(reference.token));
      if (!context) continue;
      activeTokens.add(context.token);
      contexts.set(context.token, context);
      if (context.source === "session") primaryToken = context.token;
    }
    await updateStatus(ctx);
    await refreshPresenter();
  };

  const createChildContext = async (
    source: "workflow" | "subagent" | "task",
    title: string,
    toolCallId: string,
    ctx: ExtensionContext,
    sourceId = toolCallId,
  ): Promise<MissionContext> => {
    const parent = await ensureSessionContext(ctx);
    const context = await runMission(
      store.createContext({
        missionId: parent.missionId,
        title: title.slice(0, 160),
        cwd: ctx.cwd,
        source,
        parentSessionId: ctx.sessionManager.getSessionId(),
        ...defined("originLeafId", ctx.sessionManager.getLeafId() ?? undefined),
        parentToolCallId: toolCallId,
        parentContextToken: parent.token,
        sourceId,
      }),
    );
    appendContextReference(context, ctx);
    pendingLaunches.set(toolCallId, context);
    await runMission(
      store.recordEvidence({
        contextToken: context.token,
        producer: {
          kind: `${source}-launcher`,
          instanceId: toolCallId,
          sessionId: ctx.sessionManager.getSessionId(),
          toolCallId,
        },
        milestone: {
          id: `${context.token}:launch`,
          kind: `${source}-launch`,
          state: "started",
          title: `${title} requested`,
          occurredAt: new Date().toISOString(),
        },
        payload: {},
      }),
    );
    return context;
  };

  pi.registerTool<typeof MissionRecordParameters, MissionRecordDetails>({
    name: "mission_record",
    label: "Mission Record",
    description:
      "Durably record a semantic mission milestone with immutable artifact snapshots. Call only after the reported state and artifact files are ready.",
    promptSnippet: "Record a durable mission milestone and its artifacts",
    promptGuidelines: [
      "Use mission_record for semantic checkpoints and evidence; attach artifacts in the same completed record.",
      "Do not record completed state until artifact files are closed and readable.",
    ],
    parameters: MissionRecordParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      let context: MissionContext | undefined;
      if (params.context_token) {
        context =
          contexts.get(params.context_token) ??
          (await runMission(store.getContext(params.context_token)));
      } else {
        context = primaryContext() ?? (await ensureSessionContext(ctx));
      }
      if (!context) throw new Error("Mission context is unavailable");
      contexts.set(context.token, context);
      activeTokens.add(context.token);
      const receipt = await runMission(
        store.recordEvidence({
          contextToken: context.token,
          producer: {
            kind: "pi-agent",
            instanceId: ctx.sessionManager.getSessionId(),
            sessionId: ctx.sessionManager.getSessionId(),
            toolCallId,
          },
          milestone: {
            id:
              params.milestone_id ??
              `${context.token}:checkpoint:${Date.now().toString(36)}`,
            ...defined("parentId", params.parent_id),
            kind: params.kind ?? "checkpoint",
            state: params.state ?? "completed",
            title: params.title,
            occurredAt: new Date().toISOString(),
          },
          artifacts: (params.artifacts ?? []).map(
            (artifact): EvidenceArtifactInput => ({
              role: artifact.role,
              ...defined("label", artifact.label),
              ...defined("path", artifact.path),
              ...defined("content", artifact.content),
              ...defined("mediaType", artifact.media_type),
            }),
          ),
          payload: asJsonValue(params.payload ?? {}),
        }),
      );
      await updateStatus(ctx);
      await refreshPresenter();
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${receipt.milestone.state} milestone ${receipt.eventId} with ${receipt.artifacts.length} artifact(s).`,
          },
        ],
        details: {
          eventId: receipt.eventId,
          contextToken: receipt.contextToken,
          artifactPaths: receipt.artifacts.map((artifact) => artifact.path),
        },
      };
    },
  });

  pi.registerCommand("mission", {
    description: "Open Mission Control or show mission status",
    async handler(args, ctx) {
      if (args.trim() === "close") {
        presenter.close();
        return;
      }
      await ensureSessionContext(ctx);
      if (args.trim() === "status") {
        const snapshot = await runMission(store.snapshot(activeTokens));
        ctx.ui.notify(
          `${snapshot.contexts.length} active context(s), ${snapshot.receipts.length} evidence receipt(s).`,
          "info",
        );
        return;
      }
      await presenter.open(ctx, activeTokens);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await runMission(store.initialize());
    await hydrateBranch(ctx);
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = setInterval(() => void reconcileSources(ctx), 1_000);
    reconcileTimer.unref();
    await reconcileSources(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await hydrateBranch(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || primaryContext()) return;
    const title = titleFromPrompt(event.text);
    try {
      await ensureSessionContext(ctx, title);
    } catch (error) {
      ctx.ui.notify(
        `Mission Control context failed: ${errorText(error)}`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const inheritedToken =
      extractContextToken(event.prompt) ??
      extractContextToken(event.systemPrompt);
    if (inheritedToken) {
      const inherited = await runMission(store.getContext(inheritedToken));
      if (inherited) {
        const alreadyActive = activeTokens.has(inherited.token);
        contexts.set(inherited.token, inherited);
        primaryToken = inherited.token;
        if (alreadyActive) activeTokens.add(inherited.token);
        else appendContextReference(inherited, ctx);
      }
    }
    const context =
      primaryContext() ??
      (await ensureSessionContext(ctx, titleFromPrompt(event.prompt)));
    if (hasMissionPolicy(event.systemPrompt)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${missionPolicy(context)}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (
        event.toolName === "subagent_spawn" &&
        typeof event.input.prompt === "string"
      ) {
        const requestedTitle =
          typeof event.input.title === "string"
            ? event.input.title
            : typeof event.input.name === "string"
              ? event.input.name
              : undefined;
        const title = requestedTitle?.trim() || "Subagent";
        const context = await createChildContext(
          "subagent",
          title,
          event.toolCallId,
          ctx,
        );
        event.input.prompt = `${childPromptPrefix(context, store.paths.root)}\n\n${event.input.prompt}`;
      } else if (
        event.toolName === "workflow" &&
        typeof event.input.script === "string"
      ) {
        const context = await createChildContext(
          "workflow",
          "Workflow",
          event.toolCallId,
          ctx,
        );
        event.input.script = wrapWorkflowScript(
          event.input.script,
          childPromptPrefix(context, store.paths.root),
        );
      } else if (event.toolName === "TaskExecute") {
        const taskIds = Array.isArray(event.input.task_ids)
          ? event.input.task_ids.filter(
              (taskId): taskId is string => typeof taskId === "string",
            )
          : [];
        const taskLabel =
          taskIds.length === 0
            ? "Task execution"
            : `Tasks ${taskIds.map((taskId) => `#${taskId}`).join(", ")}`;
        const context = await createChildContext(
          "task",
          taskLabel,
          event.toolCallId,
          ctx,
          `tasks:${taskIds.join(",")}`,
        );
        const current =
          typeof event.input.additional_context === "string"
            ? event.input.additional_context
            : "";
        event.input.additional_context = `${current}${current ? "\n\n" : ""}${childPromptPrefix(
          context,
          store.paths.root,
        )}`;
      }
    } catch (error) {
      ctx.ui.notify(
        `Mission context propagation failed: ${errorText(error)}`,
        "warning",
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    collectToolResult(event, agentRun);
    projections.observeTaskResult(
      event.toolName,
      event.input,
      textContent(event),
      event.isError,
    );
    try {
      await recordTaskTransition(event, primaryContext(), store, ctx);
    } catch {
      // Task execution is authoritative; evidence observation remains best-effort.
    }
    const launch = pendingLaunches.get(event.toolCallId);
    if (!launch) {
      await reconcileSources(ctx);
      return;
    }
    pendingLaunches.delete(event.toolCallId);
    if (!event.isError) {
      if (launch.source === "task") {
        const launchedTaskIds = taskIdsFromLaunchResult(textContent(event));
        if (launchedTaskIds.length === 0) {
          await runMission(
            store.recordEvidence({
              eventId: `task_batch_${safeId(event.toolCallId)}_cancelled`,
              contextToken: launch.token,
              producer: {
                kind: "pi-tasks",
                instanceId: event.toolCallId,
                sessionId: ctx.sessionManager.getSessionId(),
                toolCallId: event.toolCallId,
              },
              milestone: {
                id: `${launch.token}:task-run:cancelled`,
                kind: "task-run",
                state: "cancelled",
                title: `${launch.title} did not launch`,
                occurredAt: new Date().toISOString(),
              },
              payload: { result: textContent(event) },
            }),
          );
        } else {
          const updated = await runMission(
            store.updateContextSourceId(
              launch.token,
              `tasks:${launchedTaskIds.join(",")}`,
            ),
          );
          contexts.set(updated.token, updated);
        }
      }
      await reconcileSources(ctx);
      return;
    }
    await runMission(store.updateContextStatus(launch.token, "failed"));
    await runMission(
      store.recordEvidence({
        contextToken: launch.token,
        producer: {
          kind: `${launch.source}-launcher`,
          instanceId: event.toolCallId,
          sessionId: ctx.sessionManager.getSessionId(),
          toolCallId: event.toolCallId,
        },
        milestone: {
          id: `${launch.token}:launch-failed`,
          kind: `${launch.source}-launch`,
          state: "failed",
          title: `${launch.title} failed to launch`,
          occurredAt: new Date().toISOString(),
        },
        payload: { error: textContent(event) },
      }),
    );
    await updateStatus(ctx);
    await refreshPresenter();
  });

  pi.on("agent_start", () => {
    if (agentRun.active) return;
    agentRun.active = true;
    agentRun.sequence++;
    agentRun.toolCounts.clear();
    agentRun.toolErrors = 0;
    agentRun.editPatches = [];
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!agentRun.active) return;
    agentRun.active = false;
    const context = primaryContext();
    if (!context) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const toolCounts: Record<string, JsonValue> = {};
    for (const [name, count] of agentRun.toolCounts) toolCounts[name] = count;
    const settledKind =
      context.source === "workflow"
        ? "workflow-agent-turn"
        : context.source === "task"
          ? "task-agent-turn"
          : "agent-turn";
    await runMission(
      store.recordEvidence({
        contextToken: context.token,
        producer: {
          kind: "pi-session",
          instanceId: sessionId,
          sessionId,
        },
        milestone: {
          id: `${context.token}:${sessionId}:settled:${agentRun.sequence}`,
          kind: settledKind,
          state: "completed",
          title:
            context.source === "session"
              ? "Agent turn settled"
              : `${context.title} turn settled`,
          occurredAt: new Date().toISOString(),
        },
        artifacts:
          agentRun.editPatches.length === 0
            ? []
            : [
                {
                  role: "diff",
                  label: "Edit patches",
                  content: agentRun.editPatches.join("\n\n"),
                  mediaType: "text/x-diff",
                },
              ],
        payload: { toolCounts, toolErrors: agentRun.toolErrors },
      }),
    );
    await updateStatus(ctx);
    await reconcileSources(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    presenter.close();
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

async function reconcileTaskBatches(
  contexts: readonly MissionContext[],
  receipts: readonly EvidenceReceipt[],
  projections: ProjectionRegistry,
  store: MissionStore,
  sessionId: string,
): Promise<void> {
  const taskContexts = contexts.filter(
    (context) =>
      context.source === "task" &&
      context.status === "active" &&
      context.sourceId?.startsWith("tasks:"),
  );
  if (taskContexts.length === 0) return;
  const projection = await projections.snapshot(contexts, receipts, sessionId);
  const tasksById = new Map(projection.tasks.map((task) => [task.id, task]));
  for (const context of taskContexts) {
    const sourceId = context.sourceId;
    if (!sourceId) continue;
    const taskIds = sourceId.slice("tasks:".length).split(",").filter(Boolean);
    if (
      taskIds.length === 0 ||
      !taskIds.every((taskId) => tasksById.get(taskId)?.status === "completed")
    ) {
      continue;
    }
    await runMission(
      store.recordEvidence({
        eventId: `source_task_batch_${safeId(context.token)}_terminal`,
        contextToken: context.token,
        producer: {
          kind: "pi-tasks",
          instanceId: sourceId,
          sessionId,
          ...defined("toolCallId", context.parentToolCallId),
        },
        milestone: {
          id: `${context.token}:task-run:completed`,
          kind: "task-run",
          state: "completed",
          title: `${context.title} completed`,
          occurredAt: new Date().toISOString(),
        },
        payload: { taskIds },
      }),
    );
  }
}

async function recordTaskTransition(
  event: ToolResultEvent,
  context: MissionContext | undefined,
  store: MissionStore,
  ctx: ExtensionContext,
): Promise<void> {
  if (
    event.toolName !== "TaskUpdate" ||
    event.isError ||
    !context ||
    !/^Updated task #/m.test(textContent(event))
  )
    return;
  const taskId =
    typeof event.input.taskId === "string" ? event.input.taskId : undefined;
  const requestedStatus = event.input.status;
  const state =
    requestedStatus === "in_progress"
      ? "started"
      : requestedStatus === "completed"
        ? "completed"
        : undefined;
  if (!taskId || !state) return;
  const safeCallId = event.toolCallId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 100);
  await runMission(
    store.recordEvidence({
      eventId: `task_${taskId}_${safeCallId}`,
      contextToken: context.token,
      producer: {
        kind: "pi-tasks",
        instanceId: taskId,
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
      },
      milestone: {
        id: `task:${taskId}:${state}:${safeCallId}`,
        kind: "task-state",
        state,
        title: `Task #${taskId} ${state === "started" ? "started" : "completed"}`,
        occurredAt: new Date().toISOString(),
      },
      payload: {
        taskId,
        ...(typeof event.input.subject === "string"
          ? { subject: event.input.subject }
          : {}),
      },
    }),
  );
}

function taskIdsFromLaunchResult(output: string): string[] {
  return [...output.matchAll(/^#(\S+)\s+→\s+agent\s+/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function collectToolResult(event: ToolResultEvent, state: AgentRunState): void {
  state.toolCounts.set(
    event.toolName,
    (state.toolCounts.get(event.toolName) ?? 0) + 1,
  );
  if (event.isError) state.toolErrors++;
  if (
    event.toolName !== "edit" ||
    !event.details ||
    typeof event.details !== "object"
  )
    return;
  const patch = (event.details as Record<string, unknown>).patch;
  if (typeof patch === "string" && patch.trim()) state.editPatches.push(patch);
}

function parseContextReference(
  value: unknown,
): MissionContextReference | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== "pi.mission-context-ref/v1" ||
    typeof record.token !== "string" ||
    typeof record.missionId !== "string" ||
    typeof record.source !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  if (
    record.source !== "session" &&
    record.source !== "workflow" &&
    record.source !== "subagent" &&
    record.source !== "task" &&
    record.source !== "cli"
  ) {
    return undefined;
  }
  return {
    schema: "pi.mission-context-ref/v1",
    token: record.token,
    missionId: record.missionId,
    source: record.source,
    ...defined(
      "sourceId",
      typeof record.sourceId === "string" ? record.sourceId : undefined,
    ),
    createdAt: record.createdAt,
  };
}

function titleFromPrompt(prompt: string): string {
  const withoutContext = prompt.replace(
    /<pi-execution-context[^>]*\/?>(?:<\/pi-execution-context>)?/g,
    "",
  );
  const firstLine = withoutContext
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? "Pi mission").slice(0, 120);
}

function textContent(event: ToolResultEvent): string {
  return event.content
    .filter(
      (
        item,
      ): item is Extract<(typeof event.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .slice(0, 4_000);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
