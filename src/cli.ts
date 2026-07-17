import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";
import type {
  EvidenceArtifactInput,
  EvidenceState,
  MissionContextSource,
  RecordEvidenceInput,
} from "./types.ts";
import { asJsonValue } from "./validation.ts";

interface ParsedArguments {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

export async function runCli(
  argv: readonly string[],
  io: {
    readonly stdout: (value: string) => void;
    readonly stderr: (value: string) => void;
    readonly readStdin: () => Promise<string>;
  } = defaultIo,
): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if (!parsed.command || has(parsed, "help")) {
      io.stdout(usage());
      return 0;
    }
    const store = new MissionStore(option(parsed, "root"));
    switch (parsed.command) {
      case "context-create": {
        const context = await runMission(
          store.createContext({
            missionId: required(parsed, "mission"),
            title: required(parsed, "title"),
            cwd: option(parsed, "cwd") ?? cwd(),
            source: source(option(parsed, "source") ?? "cli"),
            parentSessionId:
              option(parsed, "session") ?? `cli:${process.pid.toString()}`,
            ...defined("originLeafId", option(parsed, "leaf")),
            ...defined("parentToolCallId", option(parsed, "tool-call")),
            ...defined("parentContextToken", option(parsed, "parent-context")),
            ...defined("sourceId", option(parsed, "source-id")),
          }),
        );
        io.stdout(`${JSON.stringify(context, null, 2)}\n`);
        return 0;
      }
      case "context-status": {
        const token = parsed.positionals[0] ?? required(parsed, "context");
        const statusValue = required(parsed, "status");
        if (
          statusValue !== "active" &&
          statusValue !== "completed" &&
          statusValue !== "failed" &&
          statusValue !== "cancelled"
        ) {
          throw new Error(`invalid context status: ${statusValue}`);
        }
        const context = await runMission(
          store.updateContextStatus(token, statusValue),
        );
        io.stdout(`${JSON.stringify(context, null, 2)}\n`);
        return 0;
      }
      case "record": {
        const input = has(parsed, "stdin")
          ? await parseStdinEvidence(await io.readStdin(), parsed)
          : evidenceFromFlags(parsed);
        const receipt = await runMission(store.recordEvidence(input));
        io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
        return 0;
      }
      case "list": {
        const tokens = options(parsed, "context");
        const receipts = await runMission(
          store.listReceipts(tokens.length === 0 ? undefined : new Set(tokens)),
        );
        io.stdout(`${JSON.stringify(receipts, null, 2)}\n`);
        return 0;
      }
      case "contexts": {
        io.stdout(
          `${JSON.stringify(await runMission(store.listContexts()), null, 2)}\n`,
        );
        return 0;
      }
      case "show": {
        const eventId = parsed.positionals[0];
        if (!eventId) throw new Error("show requires an event ID");
        const receipt = await runMission(store.getReceipt(eventId));
        if (!receipt) throw new Error(`unknown evidence receipt: ${eventId}`);
        io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
        return 0;
      }
      default:
        throw new Error(`unknown command: ${parsed.command}`);
    }
  } catch (error) {
    io.stderr(
      `missionctl: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function evidenceFromFlags(parsed: ParsedArguments): RecordEvidenceInput {
  const contextToken =
    option(parsed, "context") ?? process.env.PI_EXECUTION_CONTEXT;
  if (!contextToken)
    throw new Error("--context or PI_EXECUTION_CONTEXT is required");
  const now = new Date().toISOString();
  const title = required(parsed, "title");
  const milestoneId =
    option(parsed, "milestone") ?? `milestone:${randomUUID()}`;
  const note = option(parsed, "note");
  const payloadText = option(parsed, "payload");
  const payload =
    payloadText === undefined ? {} : asJsonValue(JSON.parse(payloadText));
  return {
    ...defined("eventId", option(parsed, "event-id")),
    contextToken,
    producer: {
      kind: option(parsed, "producer") ?? "cli",
      ...defined("instanceId", option(parsed, "instance")),
      ...defined("sessionId", option(parsed, "session")),
      ...defined("toolCallId", option(parsed, "tool-call")),
    },
    milestone: {
      id: milestoneId,
      ...defined("parentId", option(parsed, "parent-milestone")),
      kind: option(parsed, "kind") ?? "checkpoint",
      state: evidenceState(option(parsed, "state") ?? "completed"),
      title,
      occurredAt: option(parsed, "occurred-at") ?? now,
    },
    artifacts: [
      ...options(parsed, "artifact").map(parseArtifactFlag),
      ...options(parsed, "content").map(parseContentFlag),
    ],
    payload:
      note === undefined
        ? payload
        : { ...(isJsonObject(payload) ? payload : { value: payload }), note },
  };
}

async function parseStdinEvidence(
  text: string,
  parsed: ParsedArguments,
): Promise<unknown> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  if (record.contextToken === undefined) {
    const token = option(parsed, "context") ?? process.env.PI_EXECUTION_CONTEXT;
    if (token) record.contextToken = token;
  }
  return record;
}

function parseArtifactFlag(value: string): EvidenceArtifactInput {
  const [role, artifactPath] = splitAssignment(value, "artifact");
  return { role, path: artifactPath };
}

function parseContentFlag(value: string): EvidenceArtifactInput {
  const [role, content] = splitAssignment(value, "content");
  return { role, content, mediaType: "text/plain" };
}

function splitAssignment(
  value: string,
  label: string,
): readonly [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--${label} must use role=value`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function evidenceState(value: string): EvidenceState {
  if (
    value !== "started" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new Error(`invalid evidence state: ${value}`);
  }
  return value;
}

function source(value: string): MissionContextSource {
  if (
    value !== "session" &&
    value !== "workflow" &&
    value !== "subagent" &&
    value !== "task" &&
    value !== "cli"
  ) {
    throw new Error(`invalid context source: ${value}`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const mutableOptions = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === undefined) break;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : argument.slice(equals + 1);
    const next = rest[index + 1];
    if (value === undefined && next !== undefined && !next.startsWith("--")) {
      index++;
      value = next;
    }
    const values = mutableOptions.get(key) ?? [];
    values.push(value ?? "true");
    mutableOptions.set(key, values);
  }
  return {
    ...defined("command", command),
    positionals,
    options: mutableOptions,
  };
}

function option(parsed: ParsedArguments, key: string): string | undefined {
  return parsed.options.get(key)?.at(-1);
}

function options(parsed: ParsedArguments, key: string): readonly string[] {
  return parsed.options.get(key) ?? [];
}

function required(parsed: ParsedArguments, key: string): string {
  const value = option(parsed, key);
  if (!value || value === "true") throw new Error(`--${key} is required`);
  return value;
}

function has(parsed: ParsedArguments, key: string): boolean {
  return parsed.options.has(key);
}

function isJsonObject(
  value: unknown,
): value is Record<string, import("./types.ts").JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}

function usage(): string {
  return `missionctl — durable mission evidence\n\nUsage:\n  missionctl context-create --mission ID --title TITLE [--cwd PATH]\n  missionctl context-status TOKEN --status completed|failed|cancelled\n  missionctl record --context TOKEN --title TITLE [--artifact role=PATH]\n  missionctl record --stdin [--context TOKEN]\n  missionctl list [--context TOKEN]\n  missionctl contexts\n  missionctl show EVENT_ID\n\nEnvironment:\n  MISSION_CONTROL_HOME   Override the durable store root\n  PI_EXECUTION_CONTEXT   Default context token for record\n`;
}

const defaultIo = {
  stdout(value: string): void {
    process.stdout.write(value);
  },
  stderr(value: string): void {
    process.stderr.write(value);
  },
  async readStdin(): Promise<string> {
    if (process.stdin.isTTY) throw new Error("--stdin requires JSON on stdin");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};
