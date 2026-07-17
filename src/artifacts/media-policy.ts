import { readSync } from "node:fs";
import type {
  ArtifactViewerCapability,
  ArtifactViewerKind,
  VerifiedArtifactDescriptor,
} from "../mission-types.ts";

export interface MediaPolicyLimits {
  readonly textBytes: number;
  readonly diffBytes: number;
  readonly mediaBytes: number;
  readonly externalBytes: number;
  readonly textLines: number;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicyLimits = {
  textBytes: 2 * 1024 * 1024,
  diffBytes: 8 * 1024 * 1024,
  mediaBytes: 32 * 1024 * 1024,
  externalBytes: 64 * 1024 * 1024,
  textLines: 20_000,
};

export function artifactCapability(
  descriptor: VerifiedArtifactDescriptor,
  kind: ArtifactViewerKind,
  limits: MediaPolicyLimits = DEFAULT_MEDIA_POLICY,
): ArtifactViewerCapability {
  const maxBytes = maximum(kind, limits);
  if (!supports(kind, descriptor.mediaType, descriptor.role)) {
    return {
      status: "unavailable",
      kind,
      reason: `viewer does not accept ${descriptor.mediaType}`,
    };
  }
  return descriptor.size <= maxBytes
    ? { status: "available", kind, maxBytes }
    : {
        status: "unavailable",
        kind,
        reason: `artifact exceeds the ${maxBytes}-byte viewer limit`,
      };
}

export function readVerifiedText(
  descriptor: VerifiedArtifactDescriptor,
  kind: "text" | "diff" = "text",
  limits: MediaPolicyLimits = DEFAULT_MEDIA_POLICY,
): string {
  const capability = artifactCapability(descriptor, kind, limits);
  if (capability.status !== "available") throw new Error(capability.reason);
  const buffer = Buffer.allocUnsafe(descriptor.size);
  let offset = 0;
  while (offset < buffer.length) {
    const length = readSync(
      descriptor.fd,
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (length === 0) throw new Error("verified artifact ended during read");
    offset += length;
  }
  return boundText(buffer.toString("utf8"), {
    ...limits,
    textBytes: kind === "diff" ? limits.diffBytes : limits.textBytes,
  });
}

export function boundText(
  value: string,
  limits: MediaPolicyLimits = DEFAULT_MEDIA_POLICY,
): string {
  if (Buffer.byteLength(value, "utf8") > limits.textBytes)
    throw new Error("text artifact exceeds viewer byte limit");
  const lines = value.split("\n");
  if (lines.length > limits.textLines)
    throw new Error("text artifact exceeds viewer line limit");
  return value;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function maximum(kind: ArtifactViewerKind, limits: MediaPolicyLimits): number {
  switch (kind) {
    case "text":
      return limits.textBytes;
    case "diff":
      return limits.diffBytes;
    case "media":
      return limits.mediaBytes;
    case "external":
      return limits.externalBytes;
  }
}
function supports(
  kind: ArtifactViewerKind,
  mediaType: string,
  role: string,
): boolean {
  if (kind === "external") return true;
  if (kind === "diff")
    return mediaType === "text/x-diff" || role === "diff" || role === "patch";
  if (kind === "text")
    return (
      mediaType.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType === "application/xml"
    );
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}
