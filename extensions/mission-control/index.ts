import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  childPromptPrefix,
  extractContextToken,
  hasMissionPolicy,
  missionPolicy,
} from "../../src/context-prompt.ts";
import { ArtifactRouter } from "../../src/artifacts/artifact-router.ts";
import { renderDiffPage } from "../../src/artifacts/diff-renderer.ts";
import { GlimpseArtifactViewer } from "../../src/artifacts/glimpse-viewer.ts";
import {
  artifactCapability,
  escapeHtml,
  readVerifiedText,
} from "../../src/artifacts/media-policy.ts";
import { MissionIndex } from "../../src/mission-index.ts";
import { MissionPlanStore } from "../../src/mission-plan-store.ts";
import {
  buildMissionProjection,
  projectionToPlain,
} from "../../src/mission-projection.ts";
import type {
  MissionProjection,
  MissionSourceSnapshot,
} from "../../src/mission-types.ts";
import { MissionRecordService } from "../../src/mission-record-service.ts";
import { OperatorBoardController } from "../../src/operator-board.ts";
import { MissionStore } from "../../src/store.ts";
import { OperatorBoardComponent } from "../../src/tui/operator-board-component.ts";
import type {
  EvidenceArtifactInput,
  MissionContext,
  MissionContextReference,
} from "../../src/types.ts";
import { asJsonValue } from "../../src/validation.ts";
import { runMission } from "../../src/runtime.ts";
import { wrapWorkflowScript } from "../../src/workflow-wrap.ts";

const CONTEXT_ENTRY_TYPE = "pi.mission-context-ref/v1";
const STATUS_KEY = "mission-control";

const ArtifactParameter = Type.Object({
  role: Type.String(),
  label: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  media_type: Type.Optional(Type.String()),
});
const MissionRecordParameters = Type.Object({
  title: Type.String({ description: "Human-readable milestone title" }),
  kind: Type.Optional(Type.String()),
  state: Type.Optional(
    StringEnum(["started", "completed", "failed", "cancelled"] as const),
  ),
  milestone_id: Type.Optional(Type.String()),
  parent_id: Type.Optional(Type.String()),
  context_token: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(ArtifactParameter)),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
type MissionRecordDetails = {
  readonly eventId: string;
  readonly contextToken: string;
  readonly artifactIds: readonly string[];
  readonly linked: boolean;
};

interface ActiveBoard {
  readonly controller: OperatorBoardController;
  close(): void;
}

export default function missionControl(pi: ExtensionAPI): void {
  const store = new MissionStore();
  const plans = new MissionPlanStore();
  const index = new MissionIndex();
  const recordService = new MissionRecordService();
  const artifactRouter = new ArtifactRouter();
  const artifactViewer = new GlimpseArtifactViewer();
  const contexts = new Map<string, MissionContext>();
  let primaryToken: string | undefined;
  let activeBoard: ActiveBoard | undefined;

  const primaryContext = (): MissionContext | undefined =>
    primaryToken ? contexts.get(primaryToken) : undefined;

  const appendContextReference = (
    context: MissionContext,
    makePrimary = false,
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
    contexts.set(context.token, context);
    if (makePrimary) primaryToken = context.token;
  };

  const hydrateBranch = async (ctx: ExtensionContext): Promise<void> => {
    contexts.clear();
    primaryToken = undefined;
    let fallbackToken: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONTEXT_ENTRY_TYPE)
        continue;
      const reference = parseContextReference(entry.data);
      if (!reference) continue;
      const context = await runMission(store.getContext(reference.token));
      if (!context) continue;
      contexts.set(context.token, context);
      fallbackToken = context.token;
      if (context.source === "session") primaryToken = context.token;
    }
    primaryToken ??= fallbackToken;
  };

  const projectionForSession = async (
    ctx: ExtensionContext,
  ): Promise<MissionProjection> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const binding = await plans.getBinding(sessionId);
    if (
      !binding ||
      binding.state !== "bound" ||
      !binding.missionId ||
      !binding.itemId
    ) {
      return buildMissionProjection(emptySnapshot());
    }
    return buildMissionProjection(await index.snapshot(binding.missionId));
  };

  const openArtifact = async (
    artifactId: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const result = await artifactRouter.resolve(artifactId);
    if (result.status !== "available") {
      ctx.ui.notify(`Artifact unavailable: ${result.reason}`, "warning");
      return;
    }
    const descriptor = result.value;
    try {
      const diff = artifactCapability(descriptor, "diff");
      if (diff.status === "available") {
        await artifactViewer.open(
          await renderDiffPage(descriptor, `Artifact ${descriptor.artifactId}`),
          `Artifact ${descriptor.artifactId}`,
        );
        return;
      }
      const text = artifactCapability(descriptor, "text");
      if (text.status === "available") {
        const source = readVerifiedText(descriptor);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Artifact</title><style>body{margin:0;padding:16px;background:Canvas;color:CanvasText}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}</style></head><body><pre>${escapeHtml(source)}</pre></body></html>`;
        await artifactViewer.open(html, `Artifact ${descriptor.artifactId}`);
        return;
      }
      ctx.ui.notify(
        `No bounded internal viewer for ${descriptor.mediaType}`,
        "warning",
      );
    } finally {
      artifactRouter.close(descriptor);
    }
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
      const sessionId = ctx.sessionManager.getSessionId();
      const binding = await plans.getBinding(sessionId);
      const suppliedContextToken = params.context_token;
      const explicitContext = suppliedContextToken !== undefined;
      let context = suppliedContextToken
        ? (contexts.get(suppliedContextToken) ??
          (await runMission(store.getContext(suppliedContextToken))))
        : primaryContext();
      if (
        !explicitContext &&
        binding?.state === "bound" &&
        binding.missionId &&
        (!context ||
          context.missionId !== binding.missionId ||
          context.parentSessionId !== sessionId)
      ) {
        context = await runMission(
          store.createContext({
            missionId: binding.missionId,
            title: `Session ${sessionId.slice(0, 8)}`,
            cwd: ctx.cwd,
            source: "session",
            parentSessionId: sessionId,
            ...defined(
              "originLeafId",
              ctx.sessionManager.getLeafId() ?? undefined,
            ),
          }),
        );
        appendContextReference(context, true);
      }
      if (!context) {
        throw new Error(
          "Mission recording is unbound. Supply an explicit context_token or bind this session with missionctl binding set.",
        );
      }
      const evidence = {
        contextToken: context.token,
        producer: {
          kind: "pi-agent",
          instanceId: sessionId,
          sessionId,
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
      };
      const canLink =
        !explicitContext &&
        binding?.state === "bound" &&
        binding.missionId === context.missionId &&
        context.parentSessionId === sessionId &&
        typeof binding.itemId === "string";
      const eventId = canLink
        ? (
            await recordService.record({
              missionId: binding.missionId,
              itemId: binding.itemId,
              sessionId,
              idempotencyKey: `mission-record:${toolCallId}`,
              classification: "semantic",
              evidence,
            })
          ).eventId
        : (await runMission(store.recordEvidence(evidence))).eventId;
      const receipt = await runMission(store.getReceipt(eventId));
      if (!receipt)
        throw new Error(`Recorded receipt is unavailable: ${eventId}`);
      void activeBoard?.controller.refresh();
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${receipt.milestone.state} milestone ${eventId} with ${receipt.artifacts.length} artifact(s)${canLink ? " and linked it to the active roadmap item" : " as unassigned context evidence"}.`,
          },
        ],
        details: {
          eventId,
          contextToken: context.token,
          artifactIds: receipt.artifacts.map((artifact) => artifact.artifactId),
          linked: canLink,
        },
      };
    },
  });

  pi.registerCommand("mission", {
    description:
      "Open the mission board or manage the explicit session binding",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0];
      if (action === "close") {
        activeBoard?.close();
        return;
      }
      if (action === "bind") {
        const [missionId, itemId, revisionText, idempotencyKey] =
          tokens.slice(1);
        if (!missionId || !itemId || !revisionText || !idempotencyKey)
          throw new Error(
            "/mission bind requires MISSION ITEM EXPECTED_REVISION IDEMPOTENCY_KEY",
          );
        await plans.setBinding({
          sessionId: ctx.sessionManager.getSessionId(),
          missionId,
          itemId,
          expectedRevision: nonNegativeInteger(revisionText),
          idempotencyKey,
        });
        ctx.ui.notify(`Bound to ${missionId}/${itemId}`, "info");
        return;
      }
      if (action === "unbind") {
        const [revisionText, idempotencyKey] = tokens.slice(1);
        if (!revisionText || !idempotencyKey)
          throw new Error(
            "/mission unbind requires EXPECTED_REVISION IDEMPOTENCY_KEY",
          );
        await plans.setBinding({
          sessionId: ctx.sessionManager.getSessionId(),
          expectedRevision: nonNegativeInteger(revisionText),
          idempotencyKey,
        });
        ctx.ui.notify("Mission binding cleared", "info");
        return;
      }
      if (action === "status" || action === "json") {
        const projection = await projectionForSession(ctx);
        const output =
          action === "json"
            ? JSON.stringify(projection)
            : projectionToPlain(projection).trimEnd();
        if (!ctx.hasUI)
          throw new Error(
            `${output}\nUse missionctl mission show --mission ID --plain|--json for non-interactive output.`,
          );
        ctx.ui.notify(output, "info");
        return;
      }
      if (ctx.mode !== "tui") {
        throw new Error(
          "/mission board requires TUI mode. Use /mission status in RPC or missionctl mission show --mission ID --plain|--json.",
        );
      }
      if (activeBoard) {
        ctx.ui.notify("Mission board is already open", "info");
        return;
      }
      const controller = new OperatorBoardController(() =>
        projectionForSession(ctx),
      );
      let component: OperatorBoardComponent | undefined;
      let close = (): void => component?.close();
      activeBoard = { controller, close: () => close() };
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true;
            done();
          };
          component = new OperatorBoardComponent({
            controller,
            theme,
            height: () => tui.terminal.rows,
            done: finish,
            requestRender: () => tui.requestRender(),
            openArtifact: (artifactId) => openArtifact(artifactId, ctx),
            ascii:
              process.env.TERM === "dumb" ||
              process.env.MISSION_CONTROL_ASCII === "1",
          });
          close = () => component?.close();
          controller.start((state) => {
            component?.setState(state);
            tui.requestRender();
          });
          return component;
        });
      } finally {
        controller.stop();
        if (activeBoard?.controller === controller) activeBoard = undefined;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await hydrateBranch(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await hydrateBranch(ctx);
    void activeBoard?.controller.refresh();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const inheritedToken =
      extractContextToken(event.prompt) ??
      extractContextToken(event.systemPrompt);
    if (inheritedToken) {
      const inherited = await runMission(store.getContext(inheritedToken));
      if (inherited) {
        contexts.set(inherited.token, inherited);
        primaryToken = inherited.token;
        if (
          !ctx.sessionManager
            .getBranch()
            .some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === CONTEXT_ENTRY_TYPE &&
                parseContextReference(entry.data)?.token === inherited.token,
            )
        ) {
          appendContextReference(inherited);
        }
      }
    }
    const context = primaryContext();
    if (!context || hasMissionPolicy(event.systemPrompt)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${missionPolicy(context)}`,
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    const parent = primaryContext();
    if (!parent) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const binding = await plans.getBinding(sessionId);
      const promptBinding =
        binding?.state === "bound" &&
        binding.missionId === parent.missionId &&
        typeof binding.itemId === "string"
          ? {
              missionId: binding.missionId,
              itemId: binding.itemId,
              sessionId,
            }
          : undefined;
      if (
        event.toolName === "workflow" &&
        typeof event.input.script === "string"
      ) {
        const child = await createChildContext(
          store,
          parent,
          "workflow",
          "Workflow",
          event.toolCallId,
          ctx,
        );
        appendContextReference(child);
        event.input.script = wrapWorkflowScript(
          event.input.script,
          childPromptPrefix(child, store.paths.root, promptBinding),
        );
      } else if (
        event.toolName === "subagent_spawn" &&
        typeof event.input.prompt === "string"
      ) {
        const child = await createChildContext(
          store,
          parent,
          "subagent",
          typeof event.input.title === "string"
            ? event.input.title
            : "Subagent",
          event.toolCallId,
          ctx,
        );
        appendContextReference(child);
        event.input.prompt = `${childPromptPrefix(child, store.paths.root, promptBinding)}\n\n${event.input.prompt}`;
      } else if (event.toolName === "TaskExecute") {
        const taskIds = Array.isArray(event.input.task_ids)
          ? event.input.task_ids.filter(
              (taskId): taskId is string => typeof taskId === "string",
            )
          : [];
        const child = await createChildContext(
          store,
          parent,
          "task",
          taskIds.length > 0 ? `Tasks ${taskIds.join(", ")}` : "Task execution",
          event.toolCallId,
          ctx,
        );
        appendContextReference(child);
        const current =
          typeof event.input.additional_context === "string"
            ? event.input.additional_context
            : "";
        event.input.additional_context = `${current}${current ? "\n\n" : ""}${childPromptPrefix(child, store.paths.root, promptBinding)}`;
      }
    } catch (error) {
      ctx.ui.notify(
        `Mission context propagation failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    activeBoard?.close();
    activeBoard?.controller.stop();
    activeBoard = undefined;
    artifactViewer.close();
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

async function createChildContext(
  store: MissionStore,
  parent: MissionContext,
  source: "workflow" | "subagent" | "task",
  title: string,
  toolCallId: string,
  ctx: ExtensionContext,
): Promise<MissionContext> {
  return runMission(
    store.createContext({
      missionId: parent.missionId,
      title: title.slice(0, 160),
      cwd: ctx.cwd,
      source,
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...defined("originLeafId", ctx.sessionManager.getLeafId() ?? undefined),
      parentToolCallId: toolCallId,
      parentContextToken: parent.token,
      sourceId: toolCallId,
    }),
  );
}

function emptySnapshot(): MissionSourceSnapshot {
  return {
    schema: "pi.mission-source-snapshot/v1",
    missionId: "",
    generation: -1,
    projectionRevision: "unbound",
    plan: null,
    sessions: [],
    sessionBindings: [],
    executionBindings: [],
    evidenceLinks: [],
    contexts: [],
    receipts: [],
    pendingOperations: [],
    unassigned: [],
    conflicts: [],
  };
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
    typeof record.createdAt !== "string" ||
    (record.source !== "session" &&
      record.source !== "workflow" &&
      record.source !== "subagent" &&
      record.source !== "task" &&
      record.source !== "cli")
  )
    return undefined;
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

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("expected revision must be a non-negative integer");
  return parsed;
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
