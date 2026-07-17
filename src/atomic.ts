import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { nodeCode, storage } from "./effect.ts";

export interface OwnedLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

export async function acquireOwnedLock(
  lockPath: string,
  timeoutMs = 60_000,
): Promise<OwnedLock> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owned = await handle.stat();
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        "utf8",
      );
      await handle.sync();
      return {
        path: lockPath,
        handle,
        device: owned.dev,
        inode: owned.ino,
      };
    } catch (error) {
      if (nodeCode(error) !== "EEXIST") throw error;
      if (await recoverDeadOwnedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function recoverDeadOwnedLock(lockPath: string): Promise<boolean> {
  let owner: { readonly pid?: unknown };
  let before;
  try {
    before = await stat(lockPath);
    owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      readonly pid?: unknown;
    };
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return true;
    return false;
  }
  if (
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    processAlive(owner.pid)
  ) {
    return false;
  }
  try {
    const current = await stat(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino) return false;
    await rm(lockPath);
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return true;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeCode(error) === "EPERM";
  }
}

export async function releaseOwnedLock(lock: OwnedLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  try {
    const current = await stat(lock.path);
    if (current.dev === lock.device && current.ino === lock.inode) {
      await rm(lock.path, { force: true });
    }
  } catch (error) {
    if (nodeCode(error) !== "ENOENT") throw error;
  }
}

export async function withOwnedLocks<Value>(
  lockPaths: readonly string[],
  run: () => Promise<Value>,
): Promise<Value> {
  const acquired: OwnedLock[] = [];
  try {
    for (const lockPath of [...new Set(lockPaths)].sort()) {
      acquired.push(await acquireOwnedLock(lockPath));
    }
    return await run();
  } finally {
    for (const lock of acquired.reverse()) await releaseOwnedLock(lock);
  }
}

export const syncDirectory = (directory: string) =>
  storage("sync mission directory", async () => {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

export const atomicWriteFile = (
  destination: string,
  content: string,
): Effect.Effect<void, import("./effect.ts").MissionStorageError> =>
  storage("atomically write mission file", async () => {
    const directory = path.dirname(destination);
    const temporary = path.join(
      directory,
      `.${path.basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await rename(temporary, destination);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (cause) {
      await import("node:fs/promises").then(({ rm }) =>
        rm(temporary, { force: true }),
      );
      throw cause;
    } finally {
      await handle.close();
    }
  });

export const syncFile = (filePath: string) =>
  storage("sync mission file", async () => {
    const handle = await open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

export const atomicRenameDirectory = (
  source: string,
  destination: string,
): Effect.Effect<void, import("./effect.ts").MissionStorageError> =>
  Effect.gen(function* () {
    yield* syncDirectory(source);
    yield* storage("publish mission artifact directory", () =>
      rename(source, destination),
    );
    yield* syncDirectory(path.dirname(destination));
  });
