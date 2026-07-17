export interface GlimpseArtifactWindow {
  on(event: "closed", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  close(): void;
}

export interface GlimpseArtifactModule {
  open(
    html: string,
    options: {
      readonly width: number;
      readonly height: number;
      readonly title: string;
      readonly noDock: boolean;
      readonly openLinks: false;
    },
  ): GlimpseArtifactWindow;
}

export class GlimpseArtifactViewer {
  private windows = new Set<GlimpseArtifactWindow>();
  private readonly load: () => Promise<GlimpseArtifactModule>;

  constructor(load: () => Promise<GlimpseArtifactModule> = loadInstalled) {
    this.load = load;
  }

  async open(html: string, title: string): Promise<void> {
    const glimpse = await this.load();
    const window = glimpse.open(html, {
      width: 1060,
      height: 760,
      title: title.slice(0, 160),
      noDock: true,
      openLinks: false,
    });
    this.windows.add(window);
    const remove = (): void => {
      this.windows.delete(window);
    };
    window.on("closed", remove);
    window.on("error", () => {
      remove();
      window.close();
    });
  }

  close(): void {
    const windows = [...this.windows];
    this.windows.clear();
    for (const window of windows) window.close();
  }
}

async function loadInstalled(): Promise<GlimpseArtifactModule> {
  const loaded: unknown = await import(import.meta.resolve("glimpseui"));
  if (!isGlimpseModule(loaded)) throw new Error("Invalid Glimpse installation");
  return loaded;
}

function isGlimpseModule(value: unknown): value is GlimpseArtifactModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function"
  );
}
