import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { atomicRenameDirectory, atomicWriteFile, syncFile } from "./atomic.ts";
import {
  MissionNotFoundError,
  MissionStorageError,
  MissionValidationError,
  nodeCode,
  storage,
  validate,
} from "./effect.ts";
import { inferMediaType, safeArtifactName } from "./media.ts";
import { createStorePaths, type StorePaths } from "./paths.ts";
import type {
  CreateMissionContextInput,
  EvidenceArtifact,
  EvidenceArtifactInput,
  EvidenceReceipt,
  MissionContext,
  MissionSnapshot,
  RecordEvidenceInput,
} from "./types.ts";
import {
  parseCreateContextInput,
  parseRecordEvidenceInput,
} from "./validation.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LOCK_WAIT_MS = 60_000;

interface EventLock {
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

/**
 * Authoritative mission evidence store.
 *
 * Every command returns an Effect. The store does not run its own effects or
 * hide failures behind Promise methods: the CLI and Pi extension own the
 * single runtime boundary in `runtime.ts`.
 */
export class MissionStore {
  readonly paths: StorePaths;

  constructor(root?: string) {
    this.paths = createStorePaths(root);
  }

  initialize() {
    return Effect.forEach(
      Object.values(this.paths),
      (directory) =>
        storage("initialize mission store", () =>
          mkdir(directory, { recursive: true }),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid);
  }

  createContext(rawInput: CreateMissionContextInput | unknown) {
    const store = this;
    return Effect.gen(function* () {
      const input = yield* validate(() => parseCreateContextInput(rawInput));
      yield* store.initialize();
      const token = yield* Effect.sync(
        () => `mc_${randomBytes(16).toString("hex")}`,
      );
      const context: MissionContext = {
        schema: "pi.mission-context/v1",
        token,
        missionId: input.missionId,
        title: input.title,
        cwd: path.resolve(input.cwd),
        source: input.source,
        parentSessionId: input.parentSessionId,
        ...defined("originLeafId", input.originLeafId),
        ...defined("parentToolCallId", input.parentToolCallId),
        ...defined("parentContextToken", input.parentContextToken),
        ...defined("sourceId", input.sourceId),
        createdAt: new Date().toISOString(),
        status: "active",
      };
      yield* atomicWriteFile(store.contextPath(token), stringify(context));
      return context;
    });
  }

  getContext(token: string) {
    const store = this;
    return Effect.gen(function* () {
      yield* validId(token, "context token");
      return yield* readJsonIfExists<MissionContext>(store.contextPath(token));
    });
  }

  updateContextStatus(token: string, status: MissionContext["status"]) {
    const store = this;
    return Effect.gen(function* () {
      const context = yield* store.requireContext(token);
      const updated: MissionContext = { ...context, status };
      yield* atomicWriteFile(store.contextPath(token), stringify(updated));
      return updated;
    });
  }

  updateContextSourceId(token: string, sourceId: string) {
    const store = this;
    return Effect.gen(function* () {
      const context = yield* store.requireContext(token);
      const updated: MissionContext = { ...context, sourceId };
      yield* atomicWriteFile(store.contextPath(token), stringify(updated));
      return updated;
    });
  }

  listContexts() {
    const store = this;
    return Effect.gen(function* () {
      yield* store.initialize();
      const contexts = yield* readJsonDirectory<MissionContext>(
        store.paths.contexts,
      );
      return contexts.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    });
  }

  recordEvidence(rawInput: RecordEvidenceInput | unknown) {
    const store = this;
    return Effect.gen(function* () {
      const input = yield* validate(() => parseRecordEvidenceInput(rawInput));
      yield* store.initialize();
      yield* store.requireContext(input.contextToken);
      const eventId = input.eventId ?? `ev_${randomUUID()}`;
      yield* validId(eventId, "event ID");

      const existing = yield* store.getReceipt(eventId);
      if (existing) {
        yield* store.syncTerminalContextStatus(existing);
        return existing;
      }

      const receipt = yield* store.withEventLock(eventId, () =>
        Effect.gen(function* () {
          const raced = yield* store.getReceipt(eventId);
          if (raced) return raced;
          const artifacts = yield* store.snapshotArtifacts(
            eventId,
            input.artifacts ?? [],
          );
          const created: EvidenceReceipt = {
            schema: "pi.evidence/v1",
            eventId,
            contextToken: input.contextToken,
            producer: input.producer,
            milestone: input.milestone,
            artifacts,
            payload: input.payload ?? {},
            recordedAt: new Date().toISOString(),
          };
          yield* atomicWriteFile(
            store.receiptPath(eventId),
            stringify(created),
          );
          return created;
        }),
      );
      yield* store.syncTerminalContextStatus(receipt);
      return receipt;
    });
  }

  getReceipt(eventId: string) {
    const store = this;
    return Effect.gen(function* () {
      yield* validId(eventId, "event ID");
      return yield* readJsonIfExists<EvidenceReceipt>(
        store.receiptPath(eventId),
      );
    });
  }

  listReceipts(contextTokens?: ReadonlySet<string>) {
    const store = this;
    return Effect.gen(function* () {
      yield* store.initialize();
      const receipts = yield* readJsonDirectory<EvidenceReceipt>(
        store.paths.receipts,
      );
      return receipts
        .filter(
          (receipt) =>
            contextTokens === undefined ||
            contextTokens.has(receipt.contextToken),
        )
        .sort((left, right) =>
          right.milestone.occurredAt.localeCompare(left.milestone.occurredAt),
        );
    });
  }

  snapshot(contextTokens?: ReadonlySet<string>) {
    const store = this;
    return Effect.gen(function* () {
      const [allContexts, receipts] = yield* Effect.all([
        store.listContexts(),
        store.listReceipts(contextTokens),
      ]);
      const contexts =
        contextTokens === undefined
          ? allContexts
          : allContexts.filter((context) => contextTokens.has(context.token));
      return { contexts, receipts } satisfies MissionSnapshot;
    });
  }

  private requireContext(token: string) {
    return this.getContext(token).pipe(
      Effect.flatMap((context) =>
        context === undefined
          ? Effect.fail(
              new MissionNotFoundError({
                resource: "mission context",
                id: token,
              }),
            )
          : Effect.succeed(context),
      ),
    );
  }

  private syncTerminalContextStatus(receipt: EvidenceReceipt) {
    const store = this;
    return Effect.gen(function* () {
      const state = receipt.milestone.state;
      if (state !== "completed" && state !== "failed" && state !== "cancelled")
        return;
      const context = yield* store.requireContext(receipt.contextToken);
      const terminalKind =
        context.source === "subagent"
          ? "agent-run"
          : context.source === "workflow"
            ? "workflow-run"
            : context.source === "task"
              ? "task-run"
              : undefined;
      if (receipt.milestone.kind !== terminalKind || context.status === state)
        return;
      yield* store.updateContextStatus(context.token, state);
    });
  }

  private contextPath(token: string): string {
    return path.join(this.paths.contexts, `${token}.json`);
  }

  private receiptPath(eventId: string): string {
    return path.join(this.paths.receipts, `${eventId}.json`);
  }

  private snapshotArtifacts(
    eventId: string,
    inputs: readonly EvidenceArtifactInput[],
  ) {
    if (inputs.length === 0)
      return Effect.succeed([] as readonly EvidenceArtifact[]);
    const stagingDirectory = path.join(
      this.paths.staging,
      `${eventId}.${process.pid}.${randomBytes(6).toString("hex")}`,
    );
    const destinationDirectory = path.join(this.paths.artifacts, eventId);
    const store = this;
    const publish = Effect.gen(function* () {
      yield* storage("replace mission artifact snapshot", () =>
        rm(destinationDirectory, { recursive: true, force: true }),
      );
      yield* storage("create mission artifact staging directory", () =>
        mkdir(stagingDirectory, { recursive: false, mode: 0o700 }),
      );
      const staged = yield* Effect.forEach(
        inputs,
        (input, index) => store.stageArtifact(stagingDirectory, input, index),
        { concurrency: 1 },
      );
      yield* atomicRenameDirectory(stagingDirectory, destinationDirectory);
      return staged.map(
        ({ input, fileName, sourcePath, size, sha256 }, index) => ({
          artifactId: `${eventId}:${index + 1}`,
          role: input.role,
          ...defined("label", input.label),
          path: path.join(destinationDirectory, fileName),
          ...defined("sourcePath", sourcePath),
          mediaType: input.mediaType ?? inferMediaType(fileName),
          size,
          sha256,
        }),
      );
    });
    return publish.pipe(
      Effect.catchIf(
        () => true,
        (error) =>
          storage("clean failed mission artifact staging", () =>
            rm(stagingDirectory, { recursive: true, force: true }),
          ).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    );
  }

  private stageArtifact(
    stagingDirectory: string,
    input: EvidenceArtifactInput,
    index: number,
  ) {
    return Effect.gen(function* () {
      const fileName = safeArtifactName(index, input.path);
      const stagedPath = path.join(stagingDirectory, fileName);
      let sourcePath: string | undefined;
      if (input.path !== undefined) {
        sourcePath = yield* storage("resolve mission artifact", () =>
          realpath(path.resolve(input.path!)),
        );
        const sourceStat = yield* storage("stat mission artifact", () =>
          stat(sourcePath!),
        );
        if (!sourceStat.isFile()) {
          return yield* Effect.fail(
            new MissionStorageError({
              operation: "snapshot mission artifact",
              cause: new Error(`artifact is not a regular file: ${input.path}`),
            }),
          );
        }
        yield* storage("copy mission artifact", () =>
          copyFile(sourcePath!, stagedPath),
        );
      } else {
        if (input.content === undefined) {
          return yield* Effect.fail(
            new MissionStorageError({
              operation: "snapshot mission artifact",
              cause: new Error(`artifact ${index + 1} has no path or content`),
            }),
          );
        }
        yield* storage("write inline mission artifact", () =>
          writeFile(stagedPath, input.content!, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          }),
        );
      }
      yield* syncFile(stagedPath);
      const hash = yield* hashFile(stagedPath);
      return { input, fileName, sourcePath, ...hash };
    });
  }

  private withEventLock(
    eventId: string,
    create: () => Effect.Effect<
      EvidenceReceipt,
      MissionStorageError | MissionValidationError
    >,
  ) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    return this.acquireEventLock(eventId, deadline).pipe(
      Effect.flatMap((lock) =>
        lock._tag === "Existing"
          ? Effect.succeed(lock.receipt)
          : create().pipe(
              Effect.ensuring(this.releaseEventLock(eventId, lock)),
            ),
      ),
    );
  }

  private acquireEventLock(
    eventId: string,
    deadline: number,
  ): Effect.Effect<
    | { readonly _tag: "Existing"; readonly receipt: EvidenceReceipt }
    | ({ readonly _tag: "Locked" } & EventLock),
    MissionStorageError | MissionValidationError
  > {
    const lockPath = path.join(this.paths.locks, `${eventId}.lock`);
    return storage("acquire mission event lock", () =>
      open(lockPath, "wx", 0o600),
    ).pipe(
      Effect.flatMap((handle) =>
        storage("inspect mission event lock", () => handle.stat()).pipe(
          Effect.flatMap((owned) =>
            storage("mark mission event lock", () =>
              handle.writeFile(
                JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
                "utf8",
              ),
            ).pipe(
              Effect.andThen(
                storage("sync mission event lock", () => handle.sync()),
              ),
              Effect.as({
                _tag: "Locked" as const,
                handle,
                device: owned.dev,
                inode: owned.ino,
              }),
            ),
          ),
        ),
      ),
      Effect.catchIf(
        () => true,
        (error) => {
          if (nodeCode(error.cause) !== "EEXIST") return Effect.fail(error);
          return this.getReceipt(eventId).pipe(
            Effect.flatMap((receipt) => {
              if (receipt)
                return Effect.succeed({ _tag: "Existing" as const, receipt });
              if (Date.now() >= deadline) {
                return Effect.fail(
                  new MissionStorageError({
                    operation: "acquire mission event lock",
                    cause: new Error(
                      `timed out waiting for evidence event lock: ${eventId}`,
                    ),
                  }),
                );
              }
              return Effect.sleep(25).pipe(
                Effect.andThen(this.acquireEventLock(eventId, deadline)),
              );
            }),
          );
        },
      ),
    );
  }

  private releaseEventLock(eventId: string, lock: EventLock) {
    const lockPath = path.join(this.paths.locks, `${eventId}.lock`);
    return storage("close mission event lock", () => lock.handle.close()).pipe(
      Effect.ignore,
      Effect.andThen(
        storage("release mission event lock", async () => {
          try {
            const current = await stat(lockPath);
            if (current.dev === lock.device && current.ino === lock.inode) {
              await rm(lockPath, { force: true });
            }
          } catch (cause) {
            if (nodeCode(cause) !== "ENOENT") throw cause;
          }
        }).pipe(Effect.ignore),
      ),
    );
  }
}

function hashFile(filePath: string) {
  return storage("hash mission artifact", async () => {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      hash.update(buffer);
    }
    return { size, sha256: hash.digest("hex") };
  });
}

function readJsonDirectory<Value>(directory: string) {
  return Effect.gen(function* () {
    const entries = yield* storage("list mission records", () =>
      readdir(directory, { withFileTypes: true }),
    );
    const values = yield* Effect.forEach(
      entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")),
      (entry) => readJsonIfExists<Value>(path.join(directory, entry.name)),
      { concurrency: "unbounded" },
    );
    return values.filter((value): value is Value => value !== undefined);
  });
}

function readJsonIfExists<Value>(filePath: string) {
  return storage("read mission record", () => readFile(filePath, "utf8")).pipe(
    Effect.flatMap((text) => validate(() => JSON.parse(text) as Value)),
    Effect.catchIf(
      (error): error is MissionStorageError =>
        error._tag === "MissionStorageError" &&
        nodeCode(error.cause) === "ENOENT",
      () => Effect.succeed(undefined),
      (error) => Effect.fail(error),
    ),
  );
}

function validId(value: string, label: string) {
  return validate(() => {
    if (!SAFE_ID.test(value)) throw new Error(`invalid ${label}: ${value}`);
  });
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}
