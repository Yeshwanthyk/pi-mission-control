import { access } from "node:fs/promises";
import { Effect } from "effect";
import path from "node:path";
import { listWorkflowRuns, type WorkflowProjection } from "./projections.ts";
import { MissionStore } from "./store.ts";
import { storage } from "./effect.ts";
import type { EvidenceArtifactInput, MissionContext } from "./types.ts";

export class PassiveSourceAdapter {
  private readonly store: MissionStore;

  constructor(store: MissionStore) {
    this.store = store;
  }

  reconcile(contexts: readonly MissionContext[], sessionId: string) {
    const store = this.store;
    return Effect.gen(function* () {
      const workflowContexts = contexts.filter(
        (context) =>
          context.source === "workflow" &&
          context.parentSessionId === sessionId,
      );
      if (workflowContexts.length === 0) return;
      const runs = yield* storage("list workflow runs", () =>
        listWorkflowRuns(sessionId),
      );
      const assignments = assignWorkflowContexts(workflowContexts, runs);
      for (const [run, context] of assignments) {
        if (run.status === "running") continue;
        const state =
          run.status === "completed"
            ? "completed"
            : run.status === "aborted"
              ? "cancelled"
              : "failed";
        const artifacts = yield* workflowArtifacts(run);
        yield* store.recordEvidence({
          eventId: `source_${run.runId}_terminal`,
          contextToken: context.token,
          producer: {
            kind: "pi-workflows",
            instanceId: run.runId,
            sessionId,
            ...defined("toolCallId", context.parentToolCallId),
          },
          milestone: {
            id: `${run.runId}:terminal`,
            kind: "workflow-run",
            state,
            title: `${run.name} ${state}`,
            occurredAt: new Date(run.finishedAt ?? Date.now()).toISOString(),
          },
          artifacts,
          payload: {
            runId: run.runId,
            currentPhase: run.currentPhase ?? null,
            agents: {
              total: run.agents.length,
              completed: run.agents.filter((agent) => agent.state === "done")
                .length,
              failed: run.agents.filter((agent) => agent.state === "error")
                .length,
            },
          },
        });
        if (context.status !== state) {
          yield* store.updateContextStatus(context.token, state);
        }
      }
    });
  }
}

export function assignWorkflowContexts(
  contexts: readonly MissionContext[],
  runs: readonly WorkflowProjection[],
): ReadonlyMap<WorkflowProjection, MissionContext> {
  const byRunId = new Map<string, MissionContext>();
  for (const context of contexts) {
    if (context.source !== "workflow" || !context.sourceId) continue;
    if (byRunId.has(context.sourceId)) continue;
    byRunId.set(context.sourceId, context);
  }
  const assignments = new Map<WorkflowProjection, MissionContext>();
  for (const run of runs) {
    const context = byRunId.get(run.runId);
    if (!context) continue;
    if (run.sessionId && context.parentSessionId !== run.sessionId) continue;
    assignments.set(run, context);
  }
  return assignments;
}

function workflowArtifacts(run: WorkflowProjection) {
  const candidates: Array<{
    role: string;
    label: string;
    path: string;
    mediaType: string;
  }> = [
    {
      role: "workflow-script",
      label: "Workflow script",
      path: path.join(run.runDirectory, "script.js"),
      mediaType: "text/javascript",
    },
    {
      role: "transcript",
      label: "Agent transcripts",
      path: path.join(run.runDirectory, "transcripts.json"),
      mediaType: "application/json",
    },
    {
      role: "result",
      label: "Workflow result",
      path: path.join(run.runDirectory, "result.json"),
      mediaType: "application/json",
    },
  ];
  return Effect.forEach(
    candidates,
    (candidate) =>
      storage("inspect workflow sidecar", () => access(candidate.path)).pipe(
        Effect.as(candidate),
        Effect.catchIf(
          () => true,
          () => Effect.succeed(undefined),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((artifacts) =>
      artifacts.filter(
        (artifact): artifact is (typeof candidates)[number] =>
          artifact !== undefined,
      ),
    ),
  );
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
