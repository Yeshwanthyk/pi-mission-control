import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactAvailability,
  VerifiedArtifactDescriptor,
} from "../mission-types.ts";
import { createStorePaths, type StorePaths } from "../paths.ts";
import type { EvidenceArtifact, EvidenceReceipt } from "../types.ts";
import { parseEvidenceReceipt } from "../validation.ts";

const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export class ArtifactRouter {
  readonly paths: StorePaths;
  private readonly maxArtifactBytes: number;

  constructor(root?: string, maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES) {
    this.paths = createStorePaths(root);
    this.maxArtifactBytes = maxArtifactBytes;
  }

  async resolve(
    artifactId: string,
  ): Promise<ArtifactAvailability<VerifiedArtifactDescriptor>> {
    if (!validOpaqueId(artifactId)) {
      return { status: "unavailable", reason: "malformed artifact ID" };
    }
    const matches = await this.findExactMatches(artifactId);
    if (matches.length === 0) {
      return { status: "unavailable", reason: "unknown artifact ID" };
    }
    if (matches.length !== 1) {
      return {
        status: "conflict",
        reason: "artifact ID occurs in multiple immutable receipts",
      };
    }
    const match = matches[0];
    if (!match) {
      return { status: "unavailable", reason: "unknown artifact ID" };
    }
    return this.openVerified(match.receipt, match.artifact);
  }

  close(descriptor: VerifiedArtifactDescriptor): void {
    closeSync(descriptor.fd);
  }

  private async findExactMatches(artifactId: string): Promise<
    readonly {
      readonly receipt: EvidenceReceipt;
      readonly artifact: EvidenceArtifact;
    }[]
  > {
    let entries;
    try {
      entries = await readdir(this.paths.receipts, { withFileTypes: true });
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return [];
      throw error;
    }
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let receipt: EvidenceReceipt;
      try {
        receipt = parseEvidenceReceipt(
          JSON.parse(
            await readFile(path.join(this.paths.receipts, entry.name), "utf8"),
          ),
        );
        if (`${receipt.eventId}.json` !== entry.name) continue;
      } catch {
        continue;
      }
      for (const artifact of receipt.artifacts) {
        if (artifact.artifactId === artifactId)
          matches.push({ receipt, artifact });
      }
    }
    return matches;
  }

  private openVerified(
    receipt: EvidenceReceipt,
    artifact: EvidenceArtifact,
  ): ArtifactAvailability<VerifiedArtifactDescriptor> {
    let fd: number | undefined;
    try {
      if (
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 ||
        artifact.size > this.maxArtifactBytes ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)
      ) {
        return {
          status: "conflict",
          reason: "invalid committed artifact metadata",
        };
      }
      const root = path.resolve(this.paths.artifacts);
      const candidate = path.resolve(artifact.path);
      const relative = path.relative(root, candidate);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return {
          status: "conflict",
          reason: "artifact path escapes the store root",
        };
      }
      const receiptRoot = path.resolve(root, receipt.eventId);
      const receiptRootRelative = path.relative(root, receiptRoot);
      const receiptRelative = path.relative(receiptRoot, candidate);
      if (
        !receiptRootRelative ||
        receiptRootRelative.startsWith("..") ||
        path.isAbsolute(receiptRootRelative) ||
        !receiptRelative ||
        receiptRelative.startsWith("..") ||
        path.isAbsolute(receiptRelative)
      ) {
        return {
          status: "conflict",
          reason: "artifact path crosses its receipt directory",
        };
      }
      rejectSymlinkComponents(root, relative);
      const rootReal = realpathSync(root);
      fd = openSync(candidate, constants.O_RDONLY | noFollowFlag());
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        return closeConflict(fd, "artifact is not a regular file");
      }
      if (opened.size !== artifact.size) {
        return closeConflict(fd, "artifact size differs from its receipt");
      }
      const actualPath = descriptorPath(fd);
      if (actualPath) {
        const actualRelative = path.relative(rootReal, actualPath);
        if (
          !actualRelative ||
          actualRelative.startsWith("..") ||
          path.isAbsolute(actualRelative)
        ) {
          return closeConflict(fd, "opened artifact is outside the store root");
        }
      }
      const leaf = lstatSync(candidate);
      if (leaf.dev !== opened.dev || leaf.ino !== opened.ino) {
        return closeConflict(fd, "artifact was replaced during verification");
      }
      const sha256 = hashDescriptor(fd, opened.size);
      if (sha256 !== artifact.sha256) {
        return closeConflict(fd, "artifact hash differs from its receipt");
      }
      const controlledFd = controlledDescriptorCopy(
        fd,
        artifact.size,
        artifact.sha256,
        this.paths.root,
      );
      closeSync(fd);
      fd = controlledFd;
      return {
        status: "available",
        value: {
          artifactId: artifact.artifactId,
          receiptEventId: receipt.eventId,
          mediaType: artifact.mediaType,
          role: artifact.role,
          size: artifact.size,
          sha256,
          fd,
        },
      };
    } catch (error) {
      if (fd !== undefined) closeQuietly(fd);
      return {
        status: nodeCode(error) === "ENOENT" ? "unavailable" : "conflict",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function rejectSymlinkComponents(root: string, relative: string): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("artifact root is not a real directory");
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const value = lstatSync(current);
    if (value.isSymbolicLink())
      throw new Error("artifact path contains a symlink");
  }
}

function descriptorPath(fd: number): string | undefined {
  try {
    return realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    // The inode comparison still detects leaf replacement on platforms without procfs.
    return undefined;
  }
}

function hashDescriptor(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.min(READ_BUFFER_BYTES, Math.max(1, size)),
  );
  let offset = 0;
  while (offset < size) {
    const length = readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (length === 0) throw new Error("artifact ended during verification");
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  return hash.digest("hex");
}

function controlledDescriptorCopy(
  sourceFd: number,
  size: number,
  expectedSha256: string,
  root: string,
): number {
  const directory = mkdtempSync(path.join(root, ".artifact-router-"));
  const destination = path.join(directory, expectedSha256);
  let output: number | undefined;
  let input: number | undefined;
  try {
    output = openSync(destination, "wx", 0o400);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(READ_BUFFER_BYTES, Math.max(1, size)),
    );
    let offset = 0;
    while (offset < size) {
      const length = readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (length === 0)
        throw new Error("artifact ended during controlled copy");
      const chunk = buffer.subarray(0, length);
      let written = 0;
      while (written < chunk.length) {
        written += writeSync(output, chunk, written, chunk.length - written);
      }
      hash.update(chunk);
      offset += length;
    }
    fsyncSync(output);
    if (hash.digest("hex") !== expectedSha256)
      throw new Error("controlled artifact copy hash mismatch");
    closeSync(output);
    output = undefined;
    input = openSync(destination, constants.O_RDONLY | noFollowFlag());
    rmSync(directory, { recursive: true, force: true });
    return input;
  } catch (error) {
    if (output !== undefined) closeQuietly(output);
    if (input !== undefined) closeQuietly(input);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function closeConflict(
  fd: number,
  reason: string,
): ArtifactAvailability<VerifiedArtifactDescriptor> {
  closeQuietly(fd);
  return { status: "conflict", reason };
}
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Idempotent cleanup.
  }
}
function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}
function validOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 1024 &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}
function nodeCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
