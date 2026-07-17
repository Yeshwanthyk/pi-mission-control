import path from "node:path";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".diff": "text/x-diff",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

export function inferMediaType(filePath: string): string {
  return (
    MEDIA_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

export function safeArtifactName(index: number, inputPath?: string): string {
  const base = inputPath ? path.basename(inputPath) : "artifact.txt";
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${String(index + 1).padStart(2, "0")}-${sanitized || "artifact"}`;
}
