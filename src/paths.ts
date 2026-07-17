import { homedir } from "node:os";
import path from "node:path";

export interface StorePaths {
  readonly root: string;
  readonly contexts: string;
  readonly receipts: string;
  readonly artifacts: string;
  readonly staging: string;
  readonly locks: string;
  readonly quarantine: string;
  readonly plans: string;
  readonly missionGenerations: string;
  readonly missionCurrent: string;
  readonly missionSessions: string;
  readonly sessionBindings: string;
  readonly bindingHistory: string;
  readonly missionLinks: string;
  readonly missionOperations: string;
  readonly migrations: string;
  readonly manifest: string;
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
    quarantine: path.join(absoluteRoot, "quarantine", "orphans"),
    plans: path.join(absoluteRoot, "plans"),
    missionGenerations: path.join(absoluteRoot, "mission-generations"),
    missionCurrent: path.join(absoluteRoot, "mission-current"),
    missionSessions: path.join(absoluteRoot, "mission-sessions"),
    sessionBindings: path.join(absoluteRoot, "session-bindings"),
    bindingHistory: path.join(absoluteRoot, "binding-history"),
    missionLinks: path.join(absoluteRoot, "mission-links"),
    missionOperations: path.join(absoluteRoot, "mission-operations"),
    migrations: path.join(absoluteRoot, "migrations"),
    manifest: path.join(absoluteRoot, "manifest.json"),
  };
}
