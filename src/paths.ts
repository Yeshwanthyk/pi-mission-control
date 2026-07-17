import { homedir } from "node:os";
import path from "node:path";

export interface StorePaths {
  readonly root: string;
  readonly contexts: string;
  readonly receipts: string;
  readonly artifacts: string;
  readonly staging: string;
  readonly locks: string;
}

export function defaultMissionControlRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MISSION_CONTROL_HOME?.trim();
  return configured || path.join(homedir(), ".pi", "agent", "mission-control");
}

export function createStorePaths(
  root = defaultMissionControlRoot(),
): StorePaths {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    contexts: path.join(absoluteRoot, "contexts"),
    receipts: path.join(absoluteRoot, "receipts"),
    artifacts: path.join(absoluteRoot, "artifacts"),
    staging: path.join(absoluteRoot, "staging"),
    locks: path.join(absoluteRoot, "locks"),
  };
}
