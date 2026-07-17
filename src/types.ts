export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type MissionContextSource =
  "session" | "workflow" | "subagent" | "task" | "cli";

export interface MissionContext {
  readonly schema: "pi.mission-context/v1";
  readonly token: string;
  readonly missionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly source: MissionContextSource;
  readonly parentSessionId: string;
  readonly originLeafId?: string;
  readonly parentToolCallId?: string;
  readonly parentContextToken?: string;
  readonly sourceId?: string;
  readonly createdAt: string;
  readonly status: "active" | "completed" | "failed" | "cancelled";
}

export interface CreateMissionContextInput {
  readonly missionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly source: MissionContextSource;
  readonly parentSessionId: string;
  readonly originLeafId?: string;
  readonly parentToolCallId?: string;
  readonly parentContextToken?: string;
  readonly sourceId?: string;
}

export type EvidenceState = "started" | "completed" | "failed" | "cancelled";

export interface EvidenceArtifactInput {
  readonly role: string;
  readonly label?: string;
  readonly path?: string;
  readonly content?: string;
  readonly mediaType?: string;
}

export interface EvidenceProducer {
  readonly kind: string;
  readonly instanceId?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

export interface EvidenceMilestone {
  readonly id: string;
  readonly parentId?: string;
  readonly kind: string;
  readonly state: EvidenceState;
  readonly title: string;
  readonly occurredAt: string;
}

export interface RecordEvidenceInput {
  readonly eventId?: string;
  readonly contextToken: string;
  readonly producer: EvidenceProducer;
  readonly milestone: EvidenceMilestone;
  readonly artifacts?: readonly EvidenceArtifactInput[];
  readonly payload?: JsonValue;
}

export interface EvidenceArtifact {
  readonly artifactId: string;
  readonly role: string;
  readonly label?: string;
  readonly path: string;
  readonly sourcePath?: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EvidenceReceipt {
  readonly schema: "pi.evidence/v1";
  readonly eventId: string;
  readonly contextToken: string;
  readonly producer: EvidenceProducer;
  readonly milestone: EvidenceMilestone;
  readonly artifacts: readonly EvidenceArtifact[];
  readonly payload: JsonValue;
  readonly recordedAt: string;
}

export interface MissionSnapshot {
  readonly contexts: readonly MissionContext[];
  readonly receipts: readonly EvidenceReceipt[];
}

export interface MissionContextReference {
  readonly schema: "pi.mission-context-ref/v1";
  readonly token: string;
  readonly missionId: string;
  readonly source: MissionContextSource;
  readonly sourceId?: string;
  readonly createdAt: string;
}
