import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { createStorePaths, type StorePaths } from "./paths.ts";
import { runMission } from "./runtime.ts";
import type {
  MissionOperation,
  MissionOperationKind,
} from "./mission-types.ts";
import {
  MissionContractError,
  parseMissionOperation,
  storageKey,
} from "./mission-validation.ts";

export class MissionOperationStore {
  readonly paths: StorePaths;

  constructor(root?: string) {
    this.paths = createStorePaths(root);
  }

  operationId(missionId: string, idempotencyKey: string): string {
    return `op_${storageKey("mission-operation", `${missionId}\0${idempotencyKey}`).slice(2)}`;
  }

  async get(
    missionId: string,
    idempotencyKey: string,
  ): Promise<MissionOperation | undefined> {
    return this.getById(missionId, this.operationId(missionId, idempotencyKey));
  }

  async getById(
    missionId: string,
    operationId: string,
  ): Promise<MissionOperation | undefined> {
    try {
      return parseMissionOperation(
        JSON.parse(await readFile(this.path(missionId, operationId), "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    kind: MissionOperationKind,
    requestDigest?: string,
  ): Promise<MissionOperation | undefined> {
    let missionDirectories;
    try {
      missionDirectories = await readdir(this.paths.missionOperations, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const matches: MissionOperation[] = [];
    for (const directory of missionDirectories) {
      if (!directory.isDirectory()) continue;
      const entries = await readdir(
        path.join(this.paths.missionOperations, directory.name),
        { withFileTypes: true },
      );
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const operation = parseMissionOperation(
          JSON.parse(
            await readFile(
              path.join(
                this.paths.missionOperations,
                directory.name,
                entry.name,
              ),
              "utf8",
            ),
          ),
        );
        if (
          operation.idempotencyKey === idempotencyKey &&
          operation.kind === kind &&
          (requestDigest === undefined ||
            operation.requestDigest === requestDigest)
        ) {
          matches.push(operation);
        }
      }
    }
    if (matches.length > 1) {
      throw new MissionContractError(
        "AMBIGUOUS_IDEMPOTENCY_KEY",
        idempotencyKey,
      );
    }
    return matches[0];
  }

  async put(operation: MissionOperation): Promise<void> {
    const destination = this.path(operation.missionId, operation.operationId);
    await mkdir(path.dirname(destination), { recursive: true });
    await runMission(atomicWriteFile(destination, stringify(operation)));
  }

  assertCompatible(
    operation: MissionOperation,
    kind: MissionOperationKind,
    requestDigest: string,
  ): void {
    if (operation.kind !== kind || operation.requestDigest !== requestDigest) {
      throw new MissionContractError(
        "IDEMPOTENCY_CONFLICT",
        "key was reused with different input",
      );
    }
  }

  private path(missionId: string, operationId: string): string {
    return path.join(
      this.paths.missionOperations,
      storageKey("mission", missionId),
      `${storageKey("operation", operationId)}.json`,
    );
  }
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
