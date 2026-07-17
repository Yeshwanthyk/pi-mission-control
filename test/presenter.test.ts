import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createMissionPresenter,
  type GlimpseModuleAdapter,
  type GlimpseWindowAdapter,
} from "../src/presenter.ts";
import { MissionStore } from "../src/store.ts";
import { runMission } from "../src/runtime.ts";

class FakeWindow implements GlimpseWindowAdapter {
  readonly scripts: string[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(value?: unknown) => void>
  >();

  on(event: "ready", listener: () => void): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "closed", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "ready" | "message" | "closed" | "error",
    listener:
      (() => void) | ((message: unknown) => void) | ((error: Error) => void),
  ): void {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(listener as (value?: unknown) => void);
    this.listeners.set(event, callbacks);
  }

  send(script: string): void {
    this.scripts.push(script);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: "ready" | "closed"): void;
  emit(event: "message", value: unknown): void;
  emit(event: "error", value: Error): void;
  emit(event: "ready" | "message" | "closed" | "error", value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

test("stale Glimpse close events cannot detach a reopened window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mission-presenter-"));
  try {
    const store = new MissionStore(root);
    const context = await runMission(
      store.createContext({
        missionId: "mission",
        title: "Presenter test",
        cwd: root,
        source: "session",
        parentSessionId: "session",
      }),
    );
    const windows: FakeWindow[] = [];
    const module: GlimpseModuleAdapter = {
      open() {
        const window = new FakeWindow();
        windows.push(window);
        return window;
      },
    };
    const notifications: string[] = [];
    const sessionManager = SessionManager.inMemory(root);
    const extensionContext = {
      sessionManager,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionContext;
    const presenter = createMissionPresenter(
      store,
      undefined,
      async () => module,
    );

    await presenter.open(extensionContext, new Set([context.token]));
    const first = windows[0]!;
    presenter.close();
    await presenter.open(extensionContext, new Set([context.token]));
    const second = windows[1]!;
    first.emit("closed");
    second.emit("ready");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      second.scripts.some((script) => script.includes("window.updateMission")),
    );

    second.emit("error", new Error("fake failure"));
    assert.ok(
      notifications.some((message) => message.includes("fake failure")),
    );
    await presenter.open(extensionContext, new Set([context.token]));
    assert.equal(windows.length, 3);
    const third = windows[2];
    assert.ok(third);
    third.emit("ready");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      third.scripts.some((script) => script.includes("window.updateMission")),
    );
    presenter.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
