import { parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff, preloadPatchDiff } from "@pierre/diffs/ssr";
import type { VerifiedArtifactDescriptor } from "../mission-types.ts";
import { escapeHtml, readVerifiedText } from "./media-policy.ts";

export interface DiffViewerOptions {
  readonly theme: "github-dark" | "github-light";
  readonly fontFamily: "ui-monospace" | "monospace";
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly tabWidth: number;
  readonly lineNumbers: boolean;
  readonly wrap: boolean;
}

export const DEFAULT_DIFF_VIEWER_OPTIONS: DiffViewerOptions = {
  theme: "github-dark",
  fontFamily: "ui-monospace",
  fontSize: 13,
  lineHeight: 1.5,
  tabWidth: 4,
  lineNumbers: true,
  wrap: false,
};

export async function renderDiffPage(
  descriptor: VerifiedArtifactDescriptor,
  label = "Diff artifact",
  optionsValue: Partial<DiffViewerOptions> = {},
): Promise<string> {
  const patch = readVerifiedText(descriptor, "diff");
  const options = validateOptions({
    ...DEFAULT_DIFF_VIEWER_OPTIONS,
    ...optionsValue,
  });
  let body: string;
  try {
    const parsed = parsePatchFiles(patch, descriptor.sha256, true);
    const files = parsed.flatMap((entry) => entry.files);
    if (files.length === 0) throw new Error("patch contains no file diff");
    if (files.length === 1) {
      body = (
        await preloadPatchDiff({
          patch,
          options: pierreOptions(options),
        })
      ).prerenderedHTML;
    } else {
      body = (
        await Promise.all(
          files.map(
            async (fileDiff) =>
              (
                await preloadFileDiff({
                  fileDiff,
                  options: pierreOptions(options),
                })
              ).prerenderedHTML,
          ),
        )
      ).join("\n");
    }
  } catch {
    body = `<pre class="source">${escapeHtml(patch)}</pre>`;
  }
  const font =
    options.fontFamily === "ui-monospace"
      ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
      : "monospace";
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(label)}</title><style>html{font-family:${font};font-size:${options.fontSize}px;line-height:${options.lineHeight};tab-size:${options.tabWidth}}body{margin:0;padding:16px;background:Canvas;color:CanvasText}.source{white-space:${options.wrap ? "pre-wrap" : "pre"};overflow:auto}</style></head><body>${body}</body></html>\n`;
}

function pierreOptions(options: DiffViewerOptions) {
  return {
    theme: options.theme,
    diffStyle: "unified" as const,
    disableLineNumbers: !options.lineNumbers,
    overflow: options.wrap ? ("wrap" as const) : ("scroll" as const),
    stickyHeader: false,
    useCSSClasses: false,
  };
}

function validateOptions(options: DiffViewerOptions): DiffViewerOptions {
  if (
    (options.theme !== "github-dark" && options.theme !== "github-light") ||
    (options.fontFamily !== "ui-monospace" &&
      options.fontFamily !== "monospace") ||
    !Number.isFinite(options.fontSize) ||
    options.fontSize < 9 ||
    options.fontSize > 24 ||
    !Number.isFinite(options.lineHeight) ||
    options.lineHeight < 1 ||
    options.lineHeight > 2 ||
    !Number.isSafeInteger(options.tabWidth) ||
    options.tabWidth < 1 ||
    options.tabWidth > 8
  ) {
    throw new Error("invalid bounded diff viewer options");
  }
  return options;
}
