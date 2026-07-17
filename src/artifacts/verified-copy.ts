import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { VerifiedArtifactDescriptor } from "../mission-types.ts";

const COPY_BUFFER_BYTES = 64 * 1024;

export class VerifiedCopyStore {
  readonly directory: string;
  private closed = false;

  constructor(root: string) {
    this.directory = path.join(
      path.resolve(root),
      `.viewer-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(this.directory, { recursive: false, mode: 0o700 });
  }

  create(descriptor: VerifiedArtifactDescriptor): string {
    if (this.closed) throw new Error("verified copy store is closed");
    const destination = path.join(this.directory, descriptor.sha256);
    let output: number | undefined;
    try {
      output = openSync(destination, "wx", 0o600);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(
        Math.min(COPY_BUFFER_BYTES, Math.max(1, descriptor.size)),
      );
      let offset = 0;
      while (offset < descriptor.size) {
        const length = readSync(
          descriptor.fd,
          buffer,
          0,
          Math.min(buffer.length, descriptor.size - offset),
          offset,
        );
        if (length === 0)
          throw new Error("verified artifact ended during copy");
        const chunk = buffer.subarray(0, length);
        writeAll(output, chunk);
        hash.update(chunk);
        offset += length;
      }
      fsyncSync(output);
      const copied = fstatSync(output);
      if (
        copied.size !== descriptor.size ||
        hash.digest("hex") !== descriptor.sha256
      ) {
        throw new Error("controlled copy failed immutable verification");
      }
      chmodSync(destination, 0o400);
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      return destination;
    } catch (error) {
      if (output !== undefined) closeQuietly(output);
      if (
        nodeCode(error) === "EEXIST" &&
        verifyExisting(destination, descriptor)
      )
        return destination;
      rmSync(destination, { force: true });
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}
function verifyExisting(
  filePath: string,
  descriptor: VerifiedArtifactDescriptor,
): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== descriptor.size) return false;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(COPY_BUFFER_BYTES, Math.max(1, descriptor.size)),
    );
    let offset = 0;
    while (offset < descriptor.size) {
      const length = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, descriptor.size - offset),
        offset,
      );
      if (length === 0) return false;
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    return hash.digest("hex") === descriptor.sha256;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Idempotent cleanup.
  }
}
function nodeCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
