import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { MissionContext, EvidenceReceipt } from "./types.ts";

export interface TaskProjection {
  readonly id: string;
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly owner?: string;
  readonly blockedBy: readonly string[];
  readonly updatedAt?: number;
}

export interface WorkflowAgentProjection {
  readonly index: number;
  readonly label: string;
  readonly phase?: string;
  readonly state: "running" | "done" | "error";
  readonly preview: string;
}

export interface WorkflowProjection {
  readonly runId: string;
  readonly sessionId?: string;
  readonly name: string;
  readonly description?: string;
  readonly status: "running" | "completed" | "failed" | "aborted";
  readonly currentPhase?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly agents: readonly WorkflowAgentProjection[];
  readonly runDirectory: string;
}

export interface AgentProjection {
  readonly token: string;
  readonly title: string;
  readonly source: MissionContext["source"];
  readonly status: MissionContext["status"];
  readonly createdAt: string;
  readonly latestMilestone?: string;
  readonly latestAt?: string;
}

export interface DashboardProjection {
  readonly tasks: readonly TaskProjection[];
  readonly workflows: readonly WorkflowProjection[];
  readonly agents: readonly AgentProjection[];
}

export class ProjectionRegistry {
  private readonly observedTasks = new Map<string, TaskProjection>();

  observeTaskResult(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    output: string,
    isError: boolean,
  ): void {
    if (isError) return;
    if (toolName === "TaskCreate") {
      const match = /^Task #(\S+) created successfully:\s*(.+)$/m.exec(output);
      const id = match?.[1];
      const outputSubject = match?.[2];
      if (!id || !outputSubject) return;
      this.observedTasks.set(id, {
        id,
        subject:
          typeof input.subject === "string"
            ? input.subject
            : outputSubject.trim(),
        status: "pending",
        blockedBy: [],
        updatedAt: Date.now(),
      });
      return;
    }
    if (toolName === "TaskUpdate") {
      if (!/^Updated task #/m.test(output)) return;
      const id = typeof input.taskId === "string" ? input.taskId : undefined;
      if (!id) return;
      if (input.status === "deleted") {
        this.observedTasks.delete(id);
        return;
      }
      const existing = this.observedTasks.get(id);
      const status =
        taskStatus(input.status) ??
        existing?.status ??
        statusFromTaskOutput(output);
      if (!status) return;
      this.observedTasks.set(id, {
        id,
        subject:
          typeof input.subject === "string"
            ? input.subject
            : (existing?.subject ?? `Task ${id}`),
        status,
        ...defined(
          "owner",
          typeof input.owner === "string" ? input.owner : existing?.owner,
        ),
        blockedBy: existing?.blockedBy ?? [],
        updatedAt: Date.now(),
      });
      return;
    }
    if (toolName === "TaskList") this.observeTaskList(output);
  }

  async snapshot(
    contexts: readonly MissionContext[],
    receipts: readonly EvidenceReceipt[],
    sessionId: string,
  ): Promise<DashboardProjection> {
    const [fileTasks, workflows] = await Promise.all([
      readFileBackedTasks(sessionId),
      listWorkflowRuns(sessionId),
    ]);
    const tasks = new Map(this.observedTasks);
    for (const task of fileTasks) tasks.set(task.id, task);
    const latestByContext = new Map<string, EvidenceReceipt>();
    for (const receipt of receipts) {
      const current = latestByContext.get(receipt.contextToken);
      if (
        !current ||
        current.milestone.occurredAt < receipt.milestone.occurredAt
      ) {
        latestByContext.set(receipt.contextToken, receipt);
      }
    }
    return {
      tasks: [...tasks.values()].sort(
        (left, right) => numericId(left.id) - numericId(right.id),
      ),
      workflows,
      agents: contexts
        .filter((context) => context.source !== "session")
        .map((context): AgentProjection => {
          const latest = latestByContext.get(context.token);
          return {
            token: context.token,
            title: context.title,
            source: context.source,
            status: context.status,
            createdAt: context.createdAt,
            ...defined("latestMilestone", latest?.milestone.title),
            ...defined("latestAt", latest?.milestone.occurredAt),
          };
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }

  private observeTaskList(output: string): void {
    for (const line of output.split("\n")) {
      const match = /^#(\S+) \[(pending|in_progress|completed)] (.+)$/.exec(
        line.trim(),
      );
      const id = match?.[1];
      const status = taskStatus(match?.[2]);
      const suffix = match?.[3];
      if (!id || !status || !suffix) continue;
      const subject =
        suffix.split(/\s+\{|\s+\(|\s+\[blocked by/)[0]?.trim() ?? suffix;
      const blockers =
        /\[blocked by ([^\]]+)]/
          .exec(suffix)?.[1]
          ?.split(",")
          .map((item) => item.trim().replace(/^#/, "")) ?? [];
      const owner = /\(([^)]+)\)/.exec(suffix)?.[1];
      this.observedTasks.set(id, {
        id,
        subject,
        status,
        ...defined("owner", owner),
        blockedBy: blockers,
        updatedAt: Date.now(),
      });
    }
  }
}

export async function listWorkflowRuns(
  sessionId?: string,
): Promise<readonly WorkflowProjection[]> {
  const workflowsRoot = path.join(getAgentDir(), "workflows");
  let entries;
  try {
    entries = await readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("wf_"))
      .map((entry) => readWorkflow(path.join(workflowsRoot, entry.name))),
  );
  return runs
    .filter((run): run is WorkflowProjection => run !== undefined)
    .filter((run) => sessionId === undefined || run.sessionId === sessionId)
    .sort((left, right) => right.startedAt - left.startedAt);
}

async function readWorkflow(
  runDirectory: string,
): Promise<WorkflowProjection | undefined> {
  try {
    const value = JSON.parse(
      await readFile(path.join(runDirectory, "workflow.json"), "utf8"),
    ) as unknown;
    if (!isRecord(value)) return undefined;
    const runId = text(value.runId);
    const status = workflowStatus(value.status);
    const startedAt = number(value.startedAt);
    if (!runId || !status || startedAt === undefined) return undefined;
    const agents = Array.isArray(value.agents)
      ? value.agents.flatMap((agent) => parseWorkflowAgent(agent))
      : [];
    return {
      runId,
      ...defined("sessionId", text(value.sessionId)),
      name: text(value.name) ?? runId,
      ...defined("description", text(value.description)),
      status,
      ...defined("currentPhase", text(value.currentPhase)),
      startedAt,
      ...defined("finishedAt", number(value.finishedAt)),
      agents,
      runDirectory,
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseWorkflowAgent(value: unknown): WorkflowAgentProjection[] {
  if (!isRecord(value)) return [];
  const index = number(value.index);
  const label = text(value.label);
  const state = value.state;
  if (
    index === undefined ||
    !label ||
    (state !== "running" && state !== "done" && state !== "error")
  ) {
    return [];
  }
  return [
    {
      index,
      label,
      ...defined("phase", text(value.phase)),
      state,
      preview: text(value.preview) ?? "",
    },
  ];
}

async function readFileBackedTasks(
  sessionId: string,
): Promise<readonly TaskProjection[]> {
  const configured = process.env.PI_TASK_LIST_ID?.trim();
  if (!configured) return [];
  const filePath = path.isAbsolute(configured)
    ? configured
    : path.join(homedir(), ".pi", "tasks", `${configured}.json`);
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value) || !Array.isArray(value.tasks)) return [];
    return value.tasks.flatMap((task) => parseTask(task, sessionId));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return [];
    throw error;
  }
}

function parseTask(value: unknown, sessionId: string): TaskProjection[] {
  if (!isRecord(value)) return [];
  const id = text(value.id);
  const subject = text(value.subject);
  const status = taskStatus(value.status);
  const taskSessionId = text(value.sessionId);
  if (
    !id ||
    !subject ||
    !status ||
    (taskSessionId && taskSessionId !== sessionId)
  )
    return [];
  return [
    {
      id,
      subject,
      status,
      ...defined("owner", text(value.owner)),
      blockedBy: Array.isArray(value.blockedBy)
        ? value.blockedBy.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      ...defined("updatedAt", number(value.updatedAt)),
    },
  ];
}

function statusFromTaskOutput(
  output: string,
): TaskProjection["status"] | undefined {
  const match =
    /status(?: changed to|:)\s*(pending|in_progress|completed)/i.exec(output);
  return taskStatus(match?.[1]);
}

function taskStatus(value: unknown): TaskProjection["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

function workflowStatus(
  value: unknown,
): WorkflowProjection["status"] | undefined {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numericId(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
