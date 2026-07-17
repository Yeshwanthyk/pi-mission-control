import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionContext } from "./types.ts";

export interface PromptMissionBinding {
  readonly missionId: string;
  readonly itemId: string;
  readonly sessionId: string;
}

const CONTEXT_PATTERN =
  /<pi-execution-context\s+token="([A-Za-z0-9._-]+)"\s*\/?>(?:<\/pi-execution-context>)?/;
const POLICY_MARKER = "<!-- pi-mission-control-policy/v1 -->";

export function extractContextToken(text: string): string | undefined {
  return CONTEXT_PATTERN.exec(text)?.[1];
}

export function contextMarker(token: string): string {
  return `<pi-execution-context token="${token}"/>`;
}

export function missionPolicy(context: MissionContext): string {
  return `${POLICY_MARKER}
Mission evidence context: ${context.token}
Mission: ${context.title}

Record semantic milestones only when their state and artifacts are durable. Use the mission_record tool for Pi agents. For screenshots, reports, videos, diffs, or other files, attach the artifact path in the same completed milestone. Do not claim an artifact exists before mission_record succeeds.`;
}

export function hasMissionPolicy(systemPrompt: string): boolean {
  return systemPrompt.includes(POLICY_MARKER);
}

export function childPromptPrefix(
  context: MissionContext,
  storeRoot: string,
  binding?: PromptMissionBinding,
): string {
  const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "missionctl.ts",
  );
  const recordPrefix = [
    "node",
    shellQuote(cliPath),
    "record",
    "--root",
    shellQuote(storeRoot),
    "--context",
    context.token,
    ...(binding
      ? [
          "--mission",
          shellQuote(binding.missionId),
          "--item",
          shellQuote(binding.itemId),
          "--session",
          shellQuote(binding.sessionId),
          "--idempotency-key",
          shellQuote("<KEY>"),
        ]
      : []),
  ].join(" ");
  return `${contextMarker(context.token)}
You are contributing to mission "${context.title}". Before reporting a semantic milestone as complete, record it with mission_record when available. Otherwise run:
  ${recordPrefix} --title <TITLE> [--artifact role=PATH]
For your final result use kind "agent-run" and state "completed" or "failed". Only record completion after attached artifacts are closed and readable.`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
