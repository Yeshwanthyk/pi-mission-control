import type {
  CreateMissionContextInput,
  EvidenceArtifact,
  EvidenceArtifactInput,
  EvidenceMilestone,
  EvidenceReceipt,
  EvidenceProducer,
  EvidenceState,
  JsonValue,
  RecordEvidenceInput,
} from "./types.ts";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
  options: { optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return string(record[key], key, { optional: true });
}

export function asJsonValue(value: unknown, label = "payload"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => asJsonValue(item, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      output[key] = asJsonValue(item, `${label}.${key}`);
    }
    return output;
  }
  throw new Error(`${label} must be JSON-serializable`);
}

export function parseCreateContextInput(
  value: unknown,
): CreateMissionContextInput {
  const input = object(value, "context");
  const result: CreateMissionContextInput = {
    missionId: string(input.missionId, "missionId")!,
    title: string(input.title, "title")!,
    cwd: string(input.cwd, "cwd")!,
    source: parseSource(input.source),
    parentSessionId: string(input.parentSessionId, "parentSessionId")!,
    ...defined("originLeafId", optionalString(input, "originLeafId")),
    ...defined("parentToolCallId", optionalString(input, "parentToolCallId")),
    ...defined(
      "parentContextToken",
      optionalString(input, "parentContextToken"),
    ),
    ...defined("sourceId", optionalString(input, "sourceId")),
  };
  return result;
}

function parseSource(value: unknown): CreateMissionContextInput["source"] {
  const source = string(value, "source");
  if (
    source !== "session" &&
    source !== "workflow" &&
    source !== "subagent" &&
    source !== "task" &&
    source !== "cli"
  ) {
    throw new Error(`unsupported context source: ${source}`);
  }
  return source;
}

function parseState(value: unknown): EvidenceState {
  const state = string(value, "milestone.state");
  if (
    state !== "started" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    throw new Error(`unsupported evidence state: ${state}`);
  }
  return state;
}

function parseProducer(value: unknown): EvidenceProducer {
  const producer = object(value, "producer");
  return {
    kind: string(producer.kind, "producer.kind")!,
    ...defined(
      "instanceId",
      string(producer.instanceId, "producer.instanceId", { optional: true }),
    ),
    ...defined(
      "sessionId",
      string(producer.sessionId, "producer.sessionId", { optional: true }),
    ),
    ...defined(
      "toolCallId",
      string(producer.toolCallId, "producer.toolCallId", { optional: true }),
    ),
  };
}

function parseMilestone(value: unknown): EvidenceMilestone {
  const milestone = object(value, "milestone");
  const occurredAt = string(milestone.occurredAt, "milestone.occurredAt")!;
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("milestone.occurredAt must be an ISO timestamp");
  }
  return {
    id: string(milestone.id, "milestone.id")!,
    ...defined(
      "parentId",
      string(milestone.parentId, "milestone.parentId", { optional: true }),
    ),
    kind: string(milestone.kind, "milestone.kind")!,
    state: parseState(milestone.state),
    title: string(milestone.title, "milestone.title")!,
    occurredAt,
  };
}

function parseArtifact(value: unknown, index: number): EvidenceArtifactInput {
  const artifact = object(value, `artifacts[${index}]`);
  const path = string(artifact.path, `artifacts[${index}].path`, {
    optional: true,
  });
  const content = string(artifact.content, `artifacts[${index}].content`, {
    optional: true,
  });
  if ((path === undefined) === (content === undefined)) {
    throw new Error(
      `artifacts[${index}] must contain exactly one of path or content`,
    );
  }
  return {
    role: string(artifact.role, `artifacts[${index}].role`)!,
    ...defined(
      "label",
      string(artifact.label, `artifacts[${index}].label`, { optional: true }),
    ),
    ...defined("path", path),
    ...defined("content", content),
    ...defined(
      "mediaType",
      string(artifact.mediaType, `artifacts[${index}].mediaType`, {
        optional: true,
      }),
    ),
  };
}

export function parseEvidenceReceipt(value: unknown): EvidenceReceipt {
  const receipt = object(value, "receipt");
  if (receipt.schema !== "pi.evidence/v1")
    throw new Error("receipt has an unsupported schema");
  if (!Array.isArray(receipt.artifacts))
    throw new Error("receipt.artifacts must be an array");
  const artifacts: EvidenceArtifact[] = receipt.artifacts.map(
    (value, index) => {
      const artifact = object(value, `receipt.artifacts[${index}]`);
      const size = nonNegativeInteger(
        artifact.size,
        `receipt.artifacts[${index}].size`,
      );
      const sha256 = string(
        artifact.sha256,
        `receipt.artifacts[${index}].sha256`,
      )!;
      if (!/^[a-f0-9]{64}$/.test(sha256))
        throw new Error(`receipt.artifacts[${index}].sha256 is invalid`);
      return {
        artifactId: string(
          artifact.artifactId,
          `receipt.artifacts[${index}].artifactId`,
        )!,
        role: string(artifact.role, `receipt.artifacts[${index}].role`)!,
        ...defined(
          "label",
          string(artifact.label, `receipt.artifacts[${index}].label`, {
            optional: true,
          }),
        ),
        path: string(artifact.path, `receipt.artifacts[${index}].path`)!,
        ...defined(
          "sourcePath",
          string(
            artifact.sourcePath,
            `receipt.artifacts[${index}].sourcePath`,
            { optional: true },
          ),
        ),
        mediaType: string(
          artifact.mediaType,
          `receipt.artifacts[${index}].mediaType`,
        )!,
        size,
        sha256,
      };
    },
  );
  const recordedAt = string(receipt.recordedAt, "receipt.recordedAt")!;
  if (Number.isNaN(Date.parse(recordedAt)))
    throw new Error("receipt.recordedAt must be an ISO timestamp");
  return {
    schema: "pi.evidence/v1",
    eventId: string(receipt.eventId, "receipt.eventId")!,
    contextToken: string(receipt.contextToken, "receipt.contextToken")!,
    producer: parseProducer(receipt.producer),
    milestone: parseMilestone(receipt.milestone),
    artifacts,
    payload: asJsonValue(receipt.payload),
    recordedAt,
  };
}

export function parseRecordEvidenceInput(value: unknown): RecordEvidenceInput {
  const input = object(value, "evidence");
  const artifactsValue = input.artifacts;
  if (artifactsValue !== undefined && !Array.isArray(artifactsValue)) {
    throw new Error("artifacts must be an array");
  }
  const payload = input.payload === undefined ? {} : asJsonValue(input.payload);
  return {
    ...defined("eventId", string(input.eventId, "eventId", { optional: true })),
    contextToken: string(input.contextToken, "contextToken")!,
    producer: parseProducer(input.producer),
    milestone: parseMilestone(input.milestone),
    artifacts: (artifactsValue ?? []).map(parseArtifact),
    payload,
  };
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
