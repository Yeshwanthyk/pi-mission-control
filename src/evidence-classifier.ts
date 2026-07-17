import type { EvidenceReceipt } from "./types.ts";
import type {
  EventClassification,
  MissionEvidenceLink,
} from "./mission-types.ts";

export function classifyLinkedEvidence(
  link: MissionEvidenceLink,
  receipt: EvidenceReceipt,
): EventClassification | undefined {
  if (link.eventId !== receipt.eventId) return undefined;
  if (link.classification !== "semantic") return link.classification;
  return receipt.milestone.state === "completed" ? "semantic" : undefined;
}

export function classifyLegacyEvidence(_receipt: EvidenceReceipt): undefined {
  return undefined;
}
