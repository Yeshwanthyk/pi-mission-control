import type {
  ChangeStat,
  EvidenceSummary,
  MissionEvidenceLink,
  SummaryCountView,
  ValueState,
} from "./mission-types.ts";
import type { EvidenceReceipt } from "./types.ts";

const ROLE_TO_SUMMARY: Readonly<Record<string, keyof EvidenceSummary>> = {
  test: "tests",
  "test-log": "tests",
  screenshot: "screenshots",
  link: "links",
  diff: "diffs",
  patch: "diffs",
  video: "videos",
  log: "logs",
  diagram: "diagrams",
};
const SUMMARY_ORDER: readonly (keyof EvidenceSummary)[] = [
  "tests",
  "screenshots",
  "links",
  "diffs",
  "videos",
  "logs",
  "diagrams",
];

export function summarizeEvidence(
  link: MissionEvidenceLink,
  receipt: EvidenceReceipt,
): readonly SummaryCountView[] {
  const counts = new Map<keyof EvidenceSummary, number>();
  for (const kind of SUMMARY_ORDER) {
    const explicit = link.summary?.[kind];
    if (explicit !== undefined) counts.set(kind, explicit);
  }
  for (const artifact of receipt.artifacts) {
    const kind = ROLE_TO_SUMMARY[artifact.role];
    if (kind && link.summary?.[kind] === undefined) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return SUMMARY_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined || count === 0 ? [] : [{ kind, count }];
  });
}

export function aggregateChangeStats(
  links: readonly MissionEvidenceLink[],
): ValueState<{ readonly additions: number; readonly deletions: number }> {
  const unique = new Map<string, ChangeStat>();
  for (const link of links) {
    for (const stat of link.changeStats) {
      const key = `${stat.provenance.artifactId}\0${stat.provenance.sha256}`;
      if (!unique.has(key)) unique.set(key, stat);
    }
  }
  if (unique.size === 0)
    return { status: "unknown", reason: "missing-provenance" };
  let additions = 0;
  let deletions = 0;
  for (const stat of unique.values()) {
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return { status: "known", value: { additions, deletions } };
}
