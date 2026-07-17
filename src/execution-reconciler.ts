import { MissionPlanStore } from "./mission-plan-store.ts";
import type { MissionExecutionBinding } from "./mission-types.ts";
import { MissionContractError } from "./mission-validation.ts";

const TERMINAL = new Set<MissionExecutionBinding["state"]>([
  "completed",
  "failed",
  "cancelled",
]);

export class ExecutionReconciler {
  private readonly store: MissionPlanStore;

  constructor(store: MissionPlanStore) {
    this.store = store;
  }

  async transition(
    current: MissionExecutionBinding,
    state: MissionExecutionBinding["state"],
    idempotencyKey: string,
    childContextToken?: string,
  ): Promise<MissionExecutionBinding> {
    if (current.state === state) return current;
    if (TERMINAL.has(current.state)) {
      throw new MissionContractError(
        "TERMINAL_EXECUTION_REGRESSION",
        `${current.state} -> ${state}`,
      );
    }
    if (
      current.state === "intent" &&
      state !== "bound" &&
      !TERMINAL.has(state)
    ) {
      throw new MissionContractError(
        "INVALID_EXECUTION_TRANSITION",
        `${current.state} -> ${state}`,
      );
    }
    if (current.state === "bound" && state === "intent") {
      throw new MissionContractError(
        "INVALID_EXECUTION_TRANSITION",
        `${current.state} -> ${state}`,
      );
    }
    const updated: MissionExecutionBinding = {
      ...current,
      ...(childContextToken ? { childContextToken } : {}),
      state,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.bindExecution(updated, idempotencyKey);
    return updated;
  }
}
