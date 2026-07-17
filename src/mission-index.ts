import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { withOwnedLocks } from "./atomic.ts";
import { MissionPlanStore } from "./mission-plan-store.ts";
import { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";
import type {
  MissionConflict,
  MissionOperation,
  MissionSourceSnapshot,
  UnassignedRecord,
} from "./mission-types.ts";
import { parseMissionOperation, storageKey } from "./mission-validation.ts";

export class MissionIndex {
  private readonly planStore: MissionPlanStore;
  private readonly legacyStore: MissionStore;

  constructor(root?: string) {
    this.planStore = new MissionPlanStore(root);
    this.legacyStore = new MissionStore(root);
  }

  async snapshot(missionId: string): Promise<MissionSourceSnapshot> {
    await this.planStore.initialize();
    return withOwnedLocks(
      [this.planStore.missionLockPath(missionId)],
      async () => {
        const generation = await this.planStore.readGenerationOwned(missionId);
        if (!generation) {
          return {
            schema: "pi.mission-source-snapshot/v1",
            missionId,
            generation: -1,
            projectionRevision: digest(`unassigned\0${missionId}`),
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
        const [plan, sessions, bindings, executions, links, pendingOperations] =
          await Promise.all([
            this.planStore.readPlanFromGeneration(generation),
            this.planStore.readSessions(generation),
            this.planStore.readBindings(generation),
            this.planStore.readExecutions(generation),
            this.planStore.readEvidenceLinks(generation),
            this.pendingOperations(missionId),
          ]);
        const contexts = await Promise.all(
          generation.contextTokens.map(async (token) => {
            const context = await runMission(
              this.legacyStore.getContext(token),
            );
            if (!context || context.missionId !== missionId)
              throw new Error(`IMMUTABLE_CONTEXT_CORRUPTION: ${token}`);
            const expected = generation.contextHashes.find(
              (entry) => entry.token === token,
            );
            const bytes = await readFile(
              path.join(this.planStore.paths.contexts, `${token}.json`),
              "utf8",
            );
            if (!expected || expected.sha256 !== digest(bytes))
              throw new Error(`IMMUTABLE_CONTEXT_CORRUPTION: ${token}`);
            return context;
          }),
        );
        const receiptResults = await Promise.all(
          generation.eventIds.map(async (eventId) => ({
            eventId,
            receipt: await runMission(this.legacyStore.getReceipt(eventId)),
          })),
        );
        const receipts = receiptResults.flatMap(({ receipt }) =>
          receipt ? [receipt] : [],
        );
        const conflicts: MissionConflict[] = receiptResults.flatMap(
          ({ eventId, receipt }) =>
            receipt
              ? []
              : [
                  {
                    conflictId: `missing-receipt:${eventId}`,
                    kind: "missing-receipt" as const,
                    missionId,
                    recordIds: [eventId],
                    reason: "generation references a missing immutable receipt",
                    detectedAt: generation.publishedAt,
                  },
                ],
        );
        const unassigned: UnassignedRecord[] = pendingOperations.map(
          (operation) => ({
            recordId: operation.operationId,
            kind: "execution" as const,
            reason: "partial-operation" as const,
            createdAt: operation.createdAt,
          }),
        );
        const receiptHashes = receipts
          .map((receipt) => digest(stringify(receipt)))
          .sort();
        const contextHashes = generation.contextHashes
          .map((entry) => `${entry.token}:${entry.sha256}`)
          .sort();
        return {
          schema: "pi.mission-source-snapshot/v1",
          missionId,
          generation: generation.generation,
          projectionRevision: digest(
            `${stringify(generation)}${contextHashes.join("")}${receiptHashes.join("")}`,
          ),
          plan: plan ?? null,
          sessions,
          sessionBindings: bindings,
          executionBindings: executions,
          evidenceLinks: links,
          contexts,
          receipts,
          pendingOperations,
          unassigned,
          conflicts,
        };
      },
    );
  }

  private async pendingOperations(
    missionId: string,
  ): Promise<readonly MissionOperation[]> {
    const directory = path.join(
      this.planStore.paths.missionOperations,
      storageKey("mission", missionId),
    );
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const operations = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) =>
          parseMissionOperation(
            JSON.parse(
              await readFile(path.join(directory, entry.name), "utf8"),
            ),
          ),
        ),
    );
    return operations
      .filter((operation) => operation.state !== "committed")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
