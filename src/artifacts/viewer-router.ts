import { spawn, type ChildProcess } from "node:child_process";
import type {
  ExternalViewerRoute,
  VerifiedArtifactDescriptor,
} from "../mission-types.ts";
import { parseExternalViewerRoute } from "../mission-validation.ts";
import { artifactCapability } from "./media-policy.ts";
import { VerifiedCopyStore } from "./verified-copy.ts";

export type SpawnViewer = (
  executable: string,
  argv: readonly string[],
  options: {
    readonly shell: false;
    readonly detached: boolean;
    readonly stdio: "ignore";
  },
) => ChildProcess;

export class ExternalViewerController {
  private readonly copies: VerifiedCopyStore;
  private readonly spawnViewer: SpawnViewer;

  constructor(copyRoot: string, spawnViewer: SpawnViewer = spawnDirect) {
    this.copies = new VerifiedCopyStore(copyRoot);
    this.spawnViewer = spawnViewer;
  }

  open(
    descriptor: VerifiedArtifactDescriptor,
    routeValue: ExternalViewerRoute | unknown,
  ): ChildProcess {
    const capability = artifactCapability(descriptor, "external");
    if (capability.status !== "available") throw new Error(capability.reason);
    const route = parseExternalViewerRoute(routeValue);
    const placeholders = route.argv.filter(
      (token) => token.kind === "placeholder",
    ).length;
    if (placeholders !== 1)
      throw new Error(
        "viewer argv must contain exactly one verifiedPath placeholder",
      );
    const verifiedPath = this.copies.create(descriptor);
    const argv = route.argv.map((token) =>
      token.kind === "literal" ? token.value : verifiedPath,
    );
    const child = this.spawnViewer(route.executable, argv, {
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return child;
  }

  close(): void {
    this.copies.close();
  }
}

function spawnDirect(
  executable: string,
  argv: readonly string[],
  options: {
    readonly shell: false;
    readonly detached: boolean;
    readonly stdio: "ignore";
  },
): ChildProcess {
  return spawn(executable, [...argv], options);
}
