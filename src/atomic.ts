import { open, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { storage } from "./effect.ts";

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
