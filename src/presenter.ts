import type { MissionProjection } from "./mission-types.ts";
import { projectionToPlain } from "./mission-projection.ts";

/** Renderer-only adapters. Artifact viewers live under src/artifacts/. */
export function renderMissionPlain(projection: MissionProjection): string {
  return projectionToPlain(projection);
}

export function renderMissionJson(projection: MissionProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
