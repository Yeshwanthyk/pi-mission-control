import path from "node:path";
import { withOwnedLocks } from "./atomic.ts";
import type {
  ChangeStat,
  EventClassification,
  EvidenceSummary,
  MissionEvidenceLink,
  MissionOperation,
} from "./mission-types.ts";
import {
  MissionContractError,
  normalizedRequestDigest,
  storageKey,
} from "./mission-validation.ts";
import { MissionPlanStore } from "./mission-plan-store.ts";
import { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";
import type { RecordEvidenceInput } from "./types.ts";
import { asJsonValue } from "./validation.ts";

export interface RecordLinkedEvidenceInput {
  readonly missionId: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly classification: EventClassification;
  readonly evidence: RecordEvidenceInput;
  readonly summary?: EvidenceSummary;
  readonly changeStats?: readonly ChangeStat[];
}

export class MissionRecordService {
  private readonly legacy: MissionStore;
  private readonly plans: MissionPlanStore;

  constructor(root?: string) {
    this.legacy = new MissionStore(root);
    this.plans = new MissionPlanStore(root);
  }

  async record(input: RecordLinkedEvidenceInput): Promise<MissionEvidenceLink> {
    await this.plans.initialize();
    return withOwnedLocks(
      [this.plans.missionLockPath(input.missionId)],
      async () => this.recordOwned(input),
    );
  }

  private async recordOwned(
    input: RecordLinkedEvidenceInput,
  ): Promise<MissionEvidenceLink> {
    const binding = await this.plans.getBinding(input.sessionId);
    if (
      !binding ||
      binding.state !== "bound" ||
      binding.missionId !== input.missionId ||
      binding.itemId !== input.itemId
    ) {
      throw new MissionContractError("BINDING_MISMATCH", input.sessionId);
    }
    const context = await runMission(
      this.legacy.getContext(input.evidence.contextToken),
    );
    if (!context || context.missionId !== input.missionId) {
      throw new MissionContractError(
        "CONTEXT_MISSION_MISMATCH",
        input.evidence.contextToken,
      );
    }
    if (context.parentSessionId !== input.sessionId) {
      throw new MissionContractError(
        "CONTEXT_SESSION_MISMATCH",
        input.evidence.contextToken,
      );
    }
    if (
      input.evidence.producer.sessionId &&
      input.evidence.producer.sessionId !== input.sessionId
    ) {
      throw new MissionContractError(
        "CONTEXT_SESSION_MISMATCH",
        input.evidence.contextToken,
      );
    }

    const requestValue = asJsonValue(input);
    const requestDigest = normalizedRequestDigest(requestValue);
    const eventId =
      input.evidence.eventId ??
      `ev_${storageKey("record-event", `${input.missionId}\0${input.idempotencyKey}`).slice(2)}`;
    const linkId = `link_${storageKey("evidence-link", `${input.missionId}\0${input.itemId}\0${eventId}`).slice(2)}`;
    const operationId = this.plans.operations.operationId(
      input.missionId,
      input.idempotencyKey,
    );
    let operation = await this.plans.operations.getById(
      input.missionId,
      operationId,
    );
    if (operation) {
      this.plans.operations.assertCompatible(
        operation,
        "evidence-record-link",
        requestDigest,
      );
    } else {
      const now = new Date().toISOString();
      operation = {
        schema: "pi.mission-operation/v1",
        operationId,
        missionId: input.missionId,
        itemId: input.itemId,
        idempotencyKey: input.idempotencyKey,
        kind: "evidence-record-link",
        requestDigest,
        state: "intent",
        publications: [],
        resultRef: `event:${eventId};link:${linkId}`,
        createdAt: now,
        updatedAt: now,
      };
      await this.plans.operations.put(operation);
    }

    if (!operation)
      throw new MissionContractError("OPERATION_INTENT_MISSING", operationId);
    let durableOperation: MissionOperation = operation;
    let receipt = await runMission(this.legacy.getReceipt(eventId));
    if (!receipt) {
      if (durableOperation.state === "committed")
        throw new MissionContractError(
          "CORRUPT_COMMITTED_OPERATION",
          operationId,
        );
      receipt = await runMission(
        this.legacy.recordEvidenceOwned(
          { ...input.evidence, eventId },
          async (artifactManifest) => {
            durableOperation = {
              ...durableOperation,
              artifactManifest,
              updatedAt: new Date().toISOString(),
            };
            await this.plans.operations.put(durableOperation);
          },
        ),
      );
      const publications: MissionOperation["publications"] =
        receipt.artifacts.length > 0 ? ["artifacts", "receipt"] : ["receipt"];
      durableOperation = {
        ...durableOperation,
        publications,
        artifactManifest: receipt.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          fileName: path.basename(artifact.path),
          size: artifact.size,
          sha256: artifact.sha256,
        })),
        updatedAt: new Date().toISOString(),
      };
      await this.plans.operations.put(durableOperation);
    }
    if (!durableOperation.publications.includes("receipt")) {
      durableOperation = {
        ...durableOperation,
        publications:
          receipt.artifacts.length > 0 ? ["artifacts", "receipt"] : ["receipt"],
        artifactManifest: receipt.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          fileName: path.basename(artifact.path),
          size: artifact.size,
          sha256: artifact.sha256,
        })),
        updatedAt: new Date().toISOString(),
      };
      await this.plans.operations.put(durableOperation);
    }

    const link: MissionEvidenceLink = {
      schema: "pi.mission-evidence-link/v1",
      linkId,
      missionId: input.missionId,
      itemId: input.itemId,
      eventId,
      sessionId: input.sessionId,
      classification: input.classification,
      stateEffect: { kind: "none" },
      ...(input.summary ? { summary: input.summary } : {}),
      changeStats: input.changeStats ?? [],
      createdAt: receipt.recordedAt,
    };
    return this.plans.linkEvidenceOwned(link, input.idempotencyKey, {
      kind: "evidence-record-link",
      value: requestValue,
    });
  }
}
