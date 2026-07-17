import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MissionPlanStore } from "./mission-plan-store.ts";
import { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";

export interface LegacyImportMapping {
  readonly sourceMissionId: string;
  readonly contextToken: string;
  readonly targetMissionId: string;
  readonly idempotencyKey: string;
}

export class MissionMigrations {
  private readonly legacy: MissionStore;
  private readonly plans: MissionPlanStore;

  constructor(root?: string) {
    this.legacy = new MissionStore(root);
    this.plans = new MissionPlanStore(root);
  }

  async index(
    mapping: LegacyImportMapping,
  ): Promise<{ readonly contextToken: string; readonly sourceHash: string }> {
    const context = await runMission(
      this.legacy.getContext(mapping.contextToken),
    );
    if (!context || context.missionId !== mapping.sourceMissionId)
      throw new Error("LEGACY_MAPPING_MISMATCH: context/source mission differ");
    if (mapping.sourceMissionId !== mapping.targetMissionId)
      throw new Error(
        "EXPLICIT_TARGET_PLAN_REQUIRED: cross-mission evidence must be linked item-by-item",
      );
    const bytes = await readFile(
      `${this.legacy.paths.contexts}/${mapping.contextToken}.json`,
    );
    await this.plans.indexContext(
      mapping.targetMissionId,
      mapping.contextToken,
      mapping.idempotencyKey,
    );
    return {
      contextToken: mapping.contextToken,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}
