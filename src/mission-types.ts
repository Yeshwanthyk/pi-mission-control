import type { EvidenceReceipt, MissionContext } from "./types.ts";

export type MissionState =
  "planned" | "active" | "blocked" | "completed" | "failed" | "cancelled";
export type ItemState = MissionState;
export type UnknownReason =
  | "not-planned"
  | "not-estimated"
  | "missing-bound"
  | "blocked-by-terminal"
  | "missing-provenance"
  | "legacy-unassigned"
  | "partial-operation";
export type StorageKey = `k_${string}`;
export type CanonicalExternalIdentity = `xref:${string}`;

export type ValueState<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "unknown"; readonly reason: UnknownReason }
  | {
      readonly status: "conflict";
      readonly values: readonly T[];
      readonly reason: string;
    };

export interface PlanEstimate {
  readonly unit: "minute";
  readonly expected: number;
  readonly optimistic?: number;
  readonly pessimistic?: number;
  readonly confidence?: "low" | "medium" | "high";
  readonly asOf: string;
  readonly scope: "schedule" | "included-in-parent";
}

export type MissionSchedule =
  | { readonly mode: "serial" }
  | {
      readonly mode: "waves";
      readonly waves: readonly {
        readonly waveId: string;
        readonly itemIds: readonly string[];
      }[];
    };

export interface RoadmapItem {
  readonly itemId: string;
  readonly order: number;
  readonly parentItemId?: string;
  readonly title: string;
  readonly description?: string;
  readonly state: ItemState;
  readonly estimate?: PlanEstimate;
  readonly dependencyItemIds: readonly string[];
  readonly contributorSessionIds: readonly string[];
  readonly externalRefs: readonly MissionExternalRef[];
  readonly updatedAt: string;
  readonly exclusionReason?: string;
}

export interface MissionPlan {
  readonly schema: "pi.mission-plan/v1";
  readonly missionId: string;
  readonly title: string;
  readonly description?: string;
  readonly state: MissionState;
  readonly revision: number;
  readonly schedule: MissionSchedule;
  readonly items: readonly RoadmapItem[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SessionColorToken =
  | "blue"
  | "cyan"
  | "green"
  | "magenta"
  | "orange"
  | "purple"
  | "red"
  | "teal"
  | "yellow";

export interface MissionSessionAttribution {
  readonly schema: "pi.mission-session/v1";
  readonly missionId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly initials: string;
  readonly color: SessionColorToken;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly revision: number;
}

export interface MissionSessionBinding {
  readonly schema: "pi.mission-session-binding/v1";
  readonly sessionId: string;
  readonly revision: number;
  readonly state: "unbound" | "bound";
  readonly missionId?: string;
  readonly itemId?: string;
  readonly changedAt: string;
  readonly changedBy: "operator" | "explicit-fork";
  readonly previousRevision?: number;
}

export interface MissionSessionBindingHistoryEntry {
  readonly schema: "pi.mission-session-binding-history/v1";
  readonly sessionId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly before: MissionSessionBinding | null;
  readonly after: MissionSessionBinding;
  readonly recordedAt: string;
}

export type MissionExternalRef =
  | {
      readonly kind: "pi-task";
      readonly producerNamespace: string;
      readonly projectRoot: string;
      readonly listId: string;
      readonly sessionId: string;
      readonly taskId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "pi-workflow";
      readonly producerNamespace: string;
      readonly runId: string;
    }
  | {
      readonly kind: "pi-subagent";
      readonly producerNamespace: string;
      readonly sessionId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "other";
      readonly producerNamespace: string;
      readonly identity: readonly [string, ...string[]];
    };

export interface MissionExecutionBinding {
  readonly schema: "pi.mission-execution-binding/v1";
  readonly bindingId: string;
  readonly missionId: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly parentContextToken: string;
  readonly childContextToken?: string;
  readonly toolCallId: string;
  readonly externalRef: MissionExternalRef;
  readonly canonicalIdentity: CanonicalExternalIdentity;
  readonly state: "intent" | "bound" | "completed" | "failed" | "cancelled";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EventClassification = "semantic" | "execution" | "telemetry";
export type EvidenceStateEffect =
  | { readonly kind: "none" }
  | {
      readonly kind: "execution-terminal";
      readonly bindingId: string;
      readonly transition: "complete-item" | "fail-item" | "cancel-item";
    }
  | {
      readonly kind: "operator-plan-mutation";
      readonly operationId: string;
      readonly transition: "complete-item" | "fail-item" | "cancel-item";
    };

export interface EvidenceSummary {
  readonly tests?: number;
  readonly screenshots?: number;
  readonly links?: number;
  readonly diffs?: number;
  readonly videos?: number;
  readonly logs?: number;
  readonly diagrams?: number;
}
export interface ChangeStatProvenance {
  readonly artifactId: string;
  readonly sha256: string;
  readonly parser: "unified-diff/v1" | "explicit/v1";
}
export interface ChangeStat {
  readonly additions: number;
  readonly deletions: number;
  readonly provenance: ChangeStatProvenance;
}
export interface MissionEvidenceLink {
  readonly schema: "pi.mission-evidence-link/v1";
  readonly linkId: string;
  readonly missionId: string;
  readonly itemId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly classification: EventClassification;
  readonly stateEffect: EvidenceStateEffect;
  readonly summary?: EvidenceSummary;
  readonly changeStats: readonly ChangeStat[];
  readonly createdAt: string;
}

export type MissionOperationKind =
  | "plan-create"
  | "plan-mutate"
  | "session-upsert"
  | "binding-set"
  | "binding-fork"
  | "execution-bind"
  | "evidence-record-link"
  | "evidence-link"
  | "migration-index";
export type OperationPublication =
  "artifacts" | "receipt" | "generation" | "binding-history";
export interface MissionOperation {
  readonly schema: "pi.mission-operation/v1";
  readonly operationId: string;
  readonly missionId: string;
  readonly itemId?: string;
  readonly idempotencyKey: string;
  readonly kind: MissionOperationKind;
  readonly requestDigest: string;
  readonly state: "intent" | "retryable" | "committed";
  readonly publications: readonly OperationPublication[];
  readonly artifactManifest?: readonly {
    readonly artifactId: string;
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly resultRef?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MissionGeneration {
  readonly schema: "pi.mission-generation/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly previousGeneration: number | null;
  readonly planRevision: number | null;
  readonly planKey?: string;
  readonly sessionKeys: readonly string[];
  readonly bindingKeys: readonly string[];
  readonly executionLinkKeys: readonly string[];
  readonly evidenceLinkKeys: readonly string[];
  readonly contextTokens: readonly string[];
  readonly contextHashes: readonly {
    readonly token: string;
    readonly sha256: string;
  }[];
  readonly eventIds: readonly string[];
  readonly committedOperationIds: readonly string[];
  readonly publishedAt: string;
}
export interface MissionGenerationPointer {
  readonly schema: "pi.mission-generation-pointer/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly generationSha256: string;
}

export interface MissionConflict {
  readonly conflictId: string;
  readonly kind:
    | "duplicate-external-identity"
    | "stale-binding"
    | "missing-receipt"
    | "immutable-hash-mismatch"
    | "terminal-state";
  readonly missionId: string;
  readonly itemId?: string;
  readonly recordIds: readonly string[];
  readonly reason: string;
  readonly detectedAt: string;
}
export interface UnassignedRecord {
  readonly recordId: string;
  readonly kind: "receipt" | "execution" | "legacy-observation";
  readonly reason: UnknownReason;
  readonly createdAt: string;
}

export interface MissionSourceSnapshot {
  readonly schema: "pi.mission-source-snapshot/v1";
  readonly missionId: string;
  readonly generation: number;
  readonly projectionRevision: string;
  readonly plan: MissionPlan | null;
  readonly sessions: readonly MissionSessionAttribution[];
  readonly sessionBindings: readonly MissionSessionBinding[];
  readonly executionBindings: readonly MissionExecutionBinding[];
  readonly evidenceLinks: readonly MissionEvidenceLink[];
  readonly contexts: readonly MissionContext[];
  readonly receipts: readonly EvidenceReceipt[];
  readonly pendingOperations: readonly MissionOperation[];
  readonly unassigned: readonly UnassignedRecord[];
  readonly conflicts: readonly MissionConflict[];
}

export interface DurationRange {
  readonly expected: number;
  readonly optimistic: ValueState<number>;
  readonly pessimistic: ValueState<number>;
}
export interface SessionAttributionView {
  readonly sessionId: string;
  readonly displayName: string;
  readonly initials: string;
  readonly color: SessionColorToken;
}
export interface SummaryCountView {
  readonly kind: keyof EvidenceSummary;
  readonly count: number;
}
export interface ExecutionDetailView {
  readonly bindingId: string;
  readonly identity: CanonicalExternalIdentity;
  readonly state: MissionExecutionBinding["state"];
  readonly sessionId: string;
}
export interface PendingRecordView {
  readonly operationId: string;
  readonly kind: MissionOperationKind;
  readonly state: "intent" | "retryable";
  readonly errorCode?: string;
}
export interface ConflictView {
  readonly conflictId: string;
  readonly kind: MissionConflict["kind"];
  readonly reason: string;
}
export type ArtifactViewerKind = "text" | "diff" | "media" | "external";
export type ArtifactViewerCapability =
  | {
      readonly status: "available";
      readonly kind: ArtifactViewerKind;
      readonly maxBytes: number;
    }
  | {
      readonly status: "unavailable";
      readonly kind: ArtifactViewerKind;
      readonly reason: string;
    };
export interface ArtifactCapabilities {
  readonly text: boolean;
  readonly diff: boolean;
  readonly media: boolean;
  readonly external: boolean;
}

export interface MissionHeaderView {
  readonly title: string;
  readonly state: ValueState<MissionState>;
  readonly aggregateEta: ValueState<DurationRange>;
  readonly changeStats: ValueState<{
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly latestSemanticAt: ValueState<string>;
}
export interface RoadmapRowView {
  readonly itemId: string;
  readonly phase: "current" | "upcoming";
  readonly state: ItemState;
  readonly title: string;
  readonly cumulativeEta: ValueState<DurationRange>;
  readonly attribution: readonly SessionAttributionView[];
  readonly blockedReason: ValueState<string>;
  readonly conflictCount: number;
}
export interface ProgressRowView {
  readonly eventId: string;
  readonly itemId: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly summary: readonly SummaryCountView[];
  readonly attribution: ValueState<SessionAttributionView>;
  readonly artifactIds: readonly string[];
  readonly changeStats: readonly ChangeStat[];
}
export interface ItemDetailView {
  readonly itemId: string;
  readonly plan: RoadmapItem;
  readonly plannedChildren: readonly ItemDetailView[];
  readonly executions: readonly ExecutionDetailView[];
  readonly milestones: readonly ProgressRowView[];
  readonly artifactIds: readonly string[];
  readonly pending: readonly PendingRecordView[];
  readonly conflicts: readonly ConflictView[];
}
export interface MissionProjection {
  readonly schema: "pi.mission-projection/v1";
  readonly missionId: ValueState<string>;
  readonly projectionRevision: string;
  readonly boardState: "ready" | "empty-unbound" | "missing-plan" | "conflict";
  readonly header: MissionHeaderView;
  readonly roadmap: readonly RoadmapRowView[];
  readonly progress: readonly ProgressRowView[];
  readonly detailsByItemId: Readonly<Record<string, ItemDetailView>>;
  readonly unassignedCount: number;
  readonly capabilities: ArtifactCapabilities;
}

export interface VerifiedArtifactDescriptor {
  readonly artifactId: string;
  readonly receiptEventId: string;
  readonly mediaType: string;
  readonly role: string;
  readonly size: number;
  readonly sha256: string;
  readonly fd: number;
}
export type ArtifactAvailability<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "conflict"; readonly reason: string };
export type ArgvToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "placeholder"; readonly value: "verifiedPath" };
export interface ExternalViewerRoute {
  readonly executable: string;
  readonly argv: readonly ArgvToken[];
}
