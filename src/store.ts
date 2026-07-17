import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  acquireOwnedLock,
  atomicRenameDirectory,
  atomicWriteFile,
  releaseOwnedLock,
  syncFile,
} from "./atomic.ts";
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

export interface StagedArtifactManifestEntry {
  readonly artifactId: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

interface StagedArtifact {
  readonly input: EvidenceArtifactInput;
  readonly fileName: string;
  readonly sourcePath?: string;
  readonly size: number;
  readonly sha256: string;
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
      [
        this.paths.root,
        this.paths.contexts,
        this.paths.receipts,
        this.paths.artifacts,
        this.paths.staging,
        this.paths.locks,
        this.paths.quarantine,
      ],
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
      yield* store.publishContextRevision(context);
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

  updateContextStatus(
    token: string,
    status: MissionContext["status"],
    publishRevision = true,
  ) {
    const store = this;
    const lockPath = path.join(store.paths.locks, `context.${token}.lock`);
    return storage("acquire mission context lock", () =>
      acquireOwnedLock(lockPath),
    ).pipe(
      Effect.flatMap((lock) =>
        Effect.gen(function* () {
          const context = yield* store.requireContext(token);
          if (context.status !== "active") {
            if (context.status === status || status === "active")
              return context;
            return yield* Effect.fail(
              new MissionValidationError({
                message: `terminal context status cannot change: ${context.status} -> ${status}`,
                cause: new Error("TERMINAL_CONTEXT_REGRESSION"),
              }),
            );
          }
          const updated: MissionContext = { ...context, status };
          yield* atomicWriteFile(store.contextPath(token), stringify(updated));
          if (publishRevision) yield* store.publishContextRevision(updated);
          return updated;
        }).pipe(
          Effect.ensuring(
            storage("release mission context lock", () =>
              releaseOwnedLock(lock),
            ).pipe(Effect.ignore),
          ),
        ),
      ),
    );
  }

  updateContextSourceId(token: string, sourceId: string) {
    const store = this;
    const lockPath = path.join(store.paths.locks, `context.${token}.lock`);
    return storage("acquire mission context lock", () =>
      acquireOwnedLock(lockPath),
    ).pipe(
      Effect.flatMap((lock) =>
        Effect.gen(function* () {
          const context = yield* store.requireContext(token);
          const updated: MissionContext = { ...context, sourceId };
          yield* atomicWriteFile(store.contextPath(token), stringify(updated));
          yield* store.publishContextRevision(updated);
          return updated;
        }).pipe(
          Effect.ensuring(
            storage("release mission context lock", () =>
              releaseOwnedLock(lock),
            ).pipe(Effect.ignore),
          ),
        ),
      ),
    );
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
    return this.recordEvidenceInternal(rawInput, true);
  }

  /** Caller holds the matching mission lock; event locking remains internal. */
  recordEvidenceOwned(
    rawInput: RecordEvidenceInput | unknown,
    onStaged?: (
      manifest: readonly StagedArtifactManifestEntry[],
    ) => Promise<void>,
  ) {
    return this.recordEvidenceInternal(rawInput, false, onStaged);
  }

  private recordEvidenceInternal(
    rawInput: RecordEvidenceInput | unknown,
    publishContextRevision: boolean,
    onStaged?: (
      manifest: readonly StagedArtifactManifestEntry[],
    ) => Promise<void>,
  ) {
    const store = this;
    return Effect.gen(function* () {
      const input = yield* validate(() => parseRecordEvidenceInput(rawInput));
      yield* store.initialize();
      yield* store.requireContext(input.contextToken);
      const eventId = input.eventId ?? `ev_${randomUUID()}`;
      yield* validId(eventId, "event ID");

      const existing = yield* store.getReceipt(eventId);
      if (existing) {
        yield* store.verifyReceiptMatchesInput(existing, input);
        yield* store.syncTerminalContextStatus(
          existing,
          publishContextRevision,
        );
        return existing;
      }

      const receipt = yield* store.withEventLock(eventId, () =>
        Effect.gen(function* () {
          const raced = yield* store.getReceipt(eventId);
          if (raced) return raced;
          const artifacts = yield* store.snapshotArtifacts(
            eventId,
            input.artifacts ?? [],
            onStaged,
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
      yield* store.verifyReceiptMatchesInput(receipt, input);
      yield* store.syncTerminalContextStatus(receipt, publishContextRevision);
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

  private publishContextRevision(context: MissionContext) {
    const revision = createHash("sha256")
      .update(stringify(context))
      .digest("hex");
    return storage("publish mission context revision", async () => {
      const { MissionPlanStore } = await import("./mission-plan-store.ts");
      await new MissionPlanStore(this.paths.root).indexContext(
        context.missionId,
        context.token,
        `context-${revision}`,
      );
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

  private syncTerminalContextStatus(
    receipt: EvidenceReceipt,
    publishContextRevision: boolean,
  ) {
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
      yield* store.updateContextStatus(
        context.token,
        state,
        publishContextRevision,
      );
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
    onStaged?: (
      manifest: readonly StagedArtifactManifestEntry[],
    ) => Promise<void>,
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
      yield* storage("create mission artifact staging directory", () =>
        mkdir(stagingDirectory, { recursive: false, mode: 0o700 }),
      );
      const staged = yield* Effect.forEach(
        inputs,
        (input, index) => store.stageArtifact(stagingDirectory, input, index),
        { concurrency: 1 },
      );
      if (onStaged) {
        yield* storage("persist staged mission artifact manifest", () =>
          onStaged(
            staged.map((artifact, index) => ({
              artifactId: `${eventId}:${index + 1}`,
              fileName: artifact.fileName,
              size: artifact.size,
              sha256: artifact.sha256,
            })),
          ),
        );
      }
      const existingDestination = yield* storage(
        "inspect immutable mission artifact destination",
        async () => {
          try {
            return await stat(destinationDirectory);
          } catch (error) {
            if (nodeCode(error) === "ENOENT") return undefined;
            throw error;
          }
        },
      );
      if (existingDestination) {
        const matches = yield* store.artifactDirectoryMatches(
          destinationDirectory,
          staged,
        );
        if (!matches) {
          const publishedReceipt = yield* store.getReceipt(eventId);
          if (publishedReceipt) {
            return yield* Effect.fail(
              new MissionStorageError({
                operation: "publish immutable mission artifacts",
                cause: new Error(
                  `published artifact directory conflicts: ${eventId}`,
                ),
              }),
            );
          }
          const quarantine = path.join(
            store.paths.quarantine,
            `${eventId}.${Date.now().toString()}`,
          );
          yield* storage("quarantine orphan artifact directory", () =>
            rename(destinationDirectory, quarantine),
          );
          yield* atomicRenameDirectory(stagingDirectory, destinationDirectory);
        } else {
          yield* storage("discard matching artifact staging", () =>
            rm(stagingDirectory, { recursive: true, force: true }),
          );
        }
      } else {
        yield* atomicRenameDirectory(stagingDirectory, destinationDirectory);
      }
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

  private verifyReceiptMatchesInput(
    receipt: EvidenceReceipt,
    input: RecordEvidenceInput,
  ) {
    return Effect.gen(function* () {
      const artifacts = yield* Effect.forEach(
        input.artifacts ?? [],
        (artifact, index) =>
          Effect.gen(function* () {
            const fileName = safeArtifactName(index, artifact.path);
            if (artifact.path !== undefined) {
              const sourcePath = yield* storage("resolve retry artifact", () =>
                realpath(path.resolve(artifact.path ?? "")),
              );
              const hash = yield* hashFile(sourcePath);
              return {
                role: artifact.role,
                ...defined("label", artifact.label),
                sourcePath,
                mediaType: artifact.mediaType ?? inferMediaType(fileName),
                ...hash,
              };
            }
            const content = artifact.content ?? "";
            const buffer = Buffer.from(content, "utf8");
            return {
              role: artifact.role,
              ...defined("label", artifact.label),
              mediaType: artifact.mediaType ?? inferMediaType(fileName),
              size: buffer.byteLength,
              sha256: createHash("sha256").update(buffer).digest("hex"),
            };
          }),
        { concurrency: 1 },
      );
      const existingArtifacts = receipt.artifacts.map((artifact) => ({
        role: artifact.role,
        ...defined("label", artifact.label),
        ...defined("sourcePath", artifact.sourcePath),
        mediaType: artifact.mediaType,
        size: artifact.size,
        sha256: artifact.sha256,
      }));
      const expected = {
        contextToken: input.contextToken,
        producer: input.producer,
        milestone: input.milestone,
        artifacts,
        payload: input.payload ?? {},
      };
      const existing = {
        contextToken: receipt.contextToken,
        producer: receipt.producer,
        milestone: receipt.milestone,
        artifacts: existingArtifacts,
        payload: receipt.payload,
      };
      if (JSON.stringify(expected) !== JSON.stringify(existing)) {
        return yield* Effect.fail(
          new MissionValidationError({
            message: `event ID conflicts with existing receipt: ${receipt.eventId}`,
            cause: new Error("IDEMPOTENCY_CONFLICT"),
          }),
        );
      }
    });
  }

  private artifactDirectoryMatches(
    destinationDirectory: string,
    staged: readonly StagedArtifact[],
  ) {
    return Effect.gen(function* () {
      const entries = yield* storage("list immutable artifact directory", () =>
        readdir(destinationDirectory, { withFileTypes: true }),
      );
      if (
        entries.length !== staged.length ||
        entries.some((entry) => !entry.isFile())
      ) {
        return false;
      }
      for (const artifact of staged) {
        const destination = path.join(destinationDirectory, artifact.fileName);
        const hash = yield* hashFile(destination);
        if (hash.size !== artifact.size || hash.sha256 !== artifact.sha256) {
          return false;
        }
      }
      return true;
    });
  }

  private stageArtifact(
    stagingDirectory: string,
    input: EvidenceArtifactInput,
    index: number,
  ): Effect.Effect<StagedArtifact, MissionStorageError> {
    return Effect.gen(function* () {
      const fileName = safeArtifactName(index, input.path);
      const stagedPath = path.join(stagingDirectory, fileName);
      let sourcePath: string | undefined;
      let copiedHash:
        { readonly size: number; readonly sha256: string } | undefined;
      if (input.path !== undefined) {
        const requestedPath = path.resolve(input.path);
        copiedHash = yield* storage("copy mission artifact", async () => {
          const source = await open(
            requestedPath,
            constants.O_RDONLY |
              ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
          );
          let destination: FileHandle | undefined;
          try {
            const sourceStat = await source.stat();
            if (!sourceStat.isFile()) {
              throw new Error(`artifact is not a regular file: ${input.path}`);
            }
            sourcePath = await realpath(requestedPath);
            destination = await open(stagedPath, "wx", 0o600);
            const hash = createHash("sha256");
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let size = 0;
            for (;;) {
              const { bytesRead } = await source.read(
                buffer,
                0,
                buffer.length,
                size,
              );
              if (bytesRead === 0) break;
              const chunk = buffer.subarray(0, bytesRead);
              let written = 0;
              while (written < chunk.length) {
                const result = await destination.write(
                  chunk,
                  written,
                  chunk.length - written,
                );
                written += result.bytesWritten;
              }
              hash.update(chunk);
              size += bytesRead;
            }
            const after = await source.stat();
            if (
              after.dev !== sourceStat.dev ||
              after.ino !== sourceStat.ino ||
              after.size !== sourceStat.size ||
              after.mtimeMs !== sourceStat.mtimeMs ||
              size !== sourceStat.size
            ) {
              throw new Error("artifact changed while it was being copied");
            }
            await destination.sync();
            return { size, sha256: hash.digest("hex") };
          } finally {
            await destination?.close().catch(() => undefined);
            await source.close().catch(() => undefined);
          }
        });
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
      if (!copiedHash) yield* syncFile(stagedPath);
      const hash = copiedHash ?? (yield* hashFile(stagedPath));
      return {
        input,
        fileName,
        ...defined("sourcePath", sourcePath),
        ...hash,
      };
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
              return storage("recover dead mission event lock", () =>
                recoverDeadEventLock(lockPath),
              ).pipe(
                Effect.flatMap((recovered) => {
                  if (recovered)
                    return this.acquireEventLock(eventId, deadline);
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

async function recoverDeadEventLock(lockPath: string): Promise<boolean> {
  let before;
  let pid: unknown;
  try {
    before = await stat(lockPath);
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      readonly pid?: unknown;
    };
    pid = value.pid;
  } catch (error) {
    return nodeCode(error) === "ENOENT";
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (nodeCode(error) === "EPERM") return false;
  }
  const current = await stat(lockPath).catch((error: unknown) => {
    if (nodeCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return true;
  if (current.dev !== before.dev || current.ino !== before.ino) return false;
  await rm(lockPath);
  return true;
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
