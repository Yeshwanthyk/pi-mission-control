import type { MissionProjection } from "./mission-types.ts";

export interface OperatorBoardState {
  readonly projection?: MissionProjection;
  readonly refreshing: boolean;
  readonly error?: string;
  readonly revision: number;
}

export type OperatorBoardListener = (state: OperatorBoardState) => void;

export class OperatorBoardController {
  private readonly load: () => Promise<MissionProjection>;
  private readonly intervalMs: number;
  private stateValue: OperatorBoardState = { refreshing: false, revision: 0 };
  private listener: OperatorBoardListener | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private refreshPromise: Promise<void> | undefined;
  private generation = 0;

  constructor(load: () => Promise<MissionProjection>, intervalMs = 2_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250)
      throw new Error("board refresh interval must be at least 250ms");
    this.load = load;
    this.intervalMs = intervalMs;
  }

  get state(): OperatorBoardState {
    return this.stateValue;
  }

  start(listener: OperatorBoardListener): void {
    if (this.active) return;
    this.active = true;
    this.listener = listener;
    this.generation++;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const { error: _error, ...current } = this.stateValue;
    this.publish({ ...current, refreshing: true });
    const pending = this.load()
      .then((projection) => {
        if (!this.active || generation !== this.generation) return;
        this.publish({
          projection,
          refreshing: false,
          revision: this.stateValue.revision + 1,
        });
      })
      .catch((error: unknown) => {
        if (!this.active || generation !== this.generation) return;
        this.publish({
          ...this.stateValue,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
          revision: this.stateValue.revision + 1,
        });
      })
      .finally(() => {
        if (this.refreshPromise === pending) this.refreshPromise = undefined;
      });
    this.refreshPromise = pending;
    return pending;
  }

  stop(): void {
    if (!this.active && !this.timer) return;
    this.active = false;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listener = undefined;
    this.refreshPromise = undefined;
  }

  private publish(state: OperatorBoardState): void {
    this.stateValue = state;
    this.listener?.(state);
  }
}
