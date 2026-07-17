import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type {
  OperatorBoardController,
  OperatorBoardState,
} from "../operator-board.ts";
import type {
  ItemDetailView,
  MissionProjection,
  ProgressRowView,
  RoadmapRowView,
} from "../mission-types.ts";
import {
  boundedSlice,
  columns,
  etaText,
  fitLine,
  marker,
  relativeTime,
} from "./format.ts";

type DetailSection =
  "plan" | "children" | "executions" | "milestones" | "artifacts" | "conflicts";
const DETAIL_SECTIONS: readonly DetailSection[] = [
  "plan",
  "children",
  "executions",
  "milestones",
  "artifacts",
  "conflicts",
];

export interface BoardTheme {
  fg(
    color: "accent" | "dim" | "error" | "muted" | "text" | "warning",
    text: string,
  ): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export interface OperatorBoardComponentOptions {
  readonly controller: OperatorBoardController;
  readonly theme: BoardTheme;
  readonly height: () => number;
  readonly done: () => void;
  readonly requestRender: () => void;
  readonly openArtifact?: (artifactId: string) => void | Promise<void>;
  readonly ascii?: boolean;
  readonly now?: () => Date;
}

export class OperatorBoardComponent implements Component {
  private readonly options: OperatorBoardComponentOptions;
  private state: OperatorBoardState;
  private selected = 0;
  private artifactSelected = 0;
  private mode: "board" | "detail" | "help" = "board";
  private detailSectionIndex = 0;
  private closed = false;
  private cache:
    { readonly key: string; readonly lines: readonly string[] } | undefined;

  constructor(options: OperatorBoardComponentOptions) {
    this.options = options;
    this.state = options.controller.state;
  }

  setState(state: OperatorBoardState): void {
    this.state = state;
    const rows = state.projection?.roadmap.length ?? 0;
    this.selected = Math.max(0, Math.min(this.selected, rows - 1));
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode !== "board") {
        this.mode = "board";
        this.invalidateAndRender();
      } else {
        this.close();
      }
      return;
    }
    if (data === "?" || matchesKey(data, "shift+/")) {
      this.mode = this.mode === "help" ? "board" : "help";
      this.invalidateAndRender();
      return;
    }
    if (data === "r") {
      void this.options.controller.refresh();
      return;
    }
    if (matchesKey(data, Key.tab) && this.mode === "detail") {
      this.detailSectionIndex =
        (this.detailSectionIndex + 1) % DETAIL_SECTIONS.length;
      this.artifactSelected = 0;
      this.invalidateAndRender();
      return;
    }
    const direction =
      matchesKey(data, Key.up) || data === "k"
        ? -1
        : matchesKey(data, Key.down) || data === "j"
          ? 1
          : 0;
    if (direction !== 0) {
      this.move(direction);
      return;
    }
    if (matchesKey(data, Key.enter)) this.enter();
  }

  render(width: number): string[] {
    const height = Math.max(4, this.options.height());
    const key = `${width}:${height}:${this.state.revision}:${this.state.refreshing}:${this.mode}:${this.selected}:${this.detailSectionIndex}:${this.artifactSelected}:${this.options.ascii === true}`;
    if (this.cache?.key === key) return [...this.cache.lines];
    const lines = this.renderUncached(Math.max(1, width), height).map((line) =>
      fitLine(line, Math.max(1, width)),
    );
    const bounded = lines.slice(0, height);
    this.cache = { key, lines: bounded };
    return [...bounded];
  }

  invalidate(): void {
    this.cache = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done();
  }

  private renderUncached(width: number, height: number): string[] {
    if (this.mode === "help") return this.renderHelp(width);
    const projection = this.state.projection;
    if (!projection) {
      return [
        this.options.theme.fg("accent", this.options.theme.bold("Mission")),
        this.state.error
          ? this.options.theme.fg(
              "error",
              `Refresh failed: ${this.state.error}`,
            )
          : this.options.theme.fg("muted", "Loading mission state…"),
        "",
        this.helpLine(),
      ];
    }
    if (this.mode === "detail") {
      const row = projection.roadmap[this.selected];
      const detail = row ? projection.detailsByItemId[row.itemId] : undefined;
      if (detail) return this.renderDetail(detail, width, height);
      this.mode = "board";
    }
    return this.renderBoard(projection, width, height);
  }

  private renderBoard(
    projection: MissionProjection,
    width: number,
    height: number,
  ): string[] {
    const state =
      projection.header.state.status === "known"
        ? projection.header.state.value.toUpperCase()
        : "UNASSIGNED";
    const title = this.options.theme.fg(
      "accent",
      this.options.theme.bold(projection.header.title),
    );
    const header = columns(title, state, width);
    const eta = etaText(projection.header.aggregateEta);
    const changes =
      projection.header.changeStats.status === "known"
        ? `+${projection.header.changeStats.value.additions}/-${projection.header.changeStats.value.deletions}`
        : "changes —";
    const subheader = columns(
      this.options.theme.fg("muted", eta),
      width >= 80 ? this.options.theme.fg("muted", changes) : "",
      width,
    );
    if (projection.boardState === "empty-unbound") {
      return [
        header,
        subheader,
        "",
        this.options.theme.fg(
          "warning",
          "No mission is bound to this session.",
        ),
        this.options.theme.fg(
          "muted",
          "Use missionctl binding set with an explicit mission, item, revision, and idempotency key.",
        ),
        "",
        this.helpLine(),
      ];
    }
    if (projection.boardState === "missing-plan") {
      return [
        header,
        subheader,
        "",
        this.options.theme.fg("warning", "The bound mission has no plan."),
        this.options.theme.fg(
          "muted",
          "Create a plan explicitly; opening this board writes nothing.",
        ),
        "",
        this.helpLine(),
      ];
    }
    const available = Math.max(1, height - 8);
    const currentCount = projection.roadmap.filter(
      (row) => row.phase === "current",
    ).length;
    const roadmapBudget = Math.max(
      currentCount,
      1,
      Math.ceil(available * 0.55),
    );
    const progressBudget = Math.max(0, available - roadmapBudget);
    const roadmap = reservedRoadmapRows(
      projection.roadmap,
      this.selected,
      roadmapBudget,
    );
    const progress = projection.progress.slice(
      0,
      Math.floor(progressBudget / 2),
    );
    const lines = [header, subheader, "", this.section("Roadmap")];
    for (const entry of roadmap.values) {
      lines.push(this.roadmapLine(entry.row, entry.index, width));
    }
    if (roadmap.hidden > 0)
      lines.push(
        this.options.theme.fg(
          "dim",
          `… ${roadmap.hidden} roadmap row(s) hidden`,
        ),
      );
    if (progress.length > 0) {
      lines.push("", this.section("Progress"));
      for (const row of progress) lines.push(...this.progressLines(row, width));
      const hidden = projection.progress.length - progress.length;
      if (hidden > 0)
        lines.push(
          this.options.theme.fg("dim", `… ${hidden} progress row(s) hidden`),
        );
    }
    if (this.state.error)
      lines.push(
        this.options.theme.fg("error", `Refresh failed: ${this.state.error}`),
      );
    lines.push(this.helpLine());
    return lines;
  }

  private roadmapLine(
    row: RoadmapRowView,
    index: number,
    width: number,
  ): string {
    const selected = index === this.selected;
    const phaseMarker = marker(row.phase, this.options.ascii === true);
    const cursor = selected
      ? marker("selected", this.options.ascii === true)
      : " ";
    const blocked = row.state === "blocked" ? " [BLOCKED]" : "";
    const attribution = row.attribution
      .map((entry) => entry.initials)
      .join(",");
    const left = `${cursor}${phaseMarker} ${row.title}${blocked}`;
    const right =
      width >= 100
        ? `${etaText(row.cumulativeEta)}${attribution ? `  ${attribution}` : ""}`
        : etaText(row.cumulativeEta);
    const line = columns(left, right, width);
    if (selected) return this.options.theme.bg("selectedBg", line);
    if (row.phase === "current")
      return this.options.theme.fg("text", this.options.theme.bold(line));
    return this.options.theme.fg("muted", line);
  }

  private progressLines(row: ProgressRowView, width: number): string[] {
    const age = relativeTime(row.occurredAt, this.now());
    const summary = row.summary
      .map((entry) => `${entry.count} ${entry.kind}`)
      .join(" · ");
    return [
      columns(row.title, age, width),
      this.options.theme.fg("dim", `  ${summary || "semantic milestone"}`),
    ];
  }

  private renderDetail(
    detail: ItemDetailView,
    width: number,
    height: number,
  ): string[] {
    const section = DETAIL_SECTIONS[this.detailSectionIndex] ?? "plan";
    const lines = [
      columns(
        this.options.theme.fg(
          "accent",
          this.options.theme.bold(detail.plan.title),
        ),
        detail.plan.state.toUpperCase(),
        width,
      ),
      this.options.theme.fg("muted", `Detail · ${section}`),
      "",
    ];
    switch (section) {
      case "plan":
        lines.push(detail.plan.description ?? "No description.");
        lines.push(
          `Estimate: ${detail.plan.estimate ? `${detail.plan.estimate.expected}m` : "—"}`,
        );
        lines.push(
          `Dependencies: ${detail.plan.dependencyItemIds.join(", ") || "none"}`,
        );
        break;
      case "children":
        lines.push(
          ...this.detailRows(
            detail.plannedChildren.map(
              (child) =>
                `${marker("child", this.options.ascii === true)} ${child.plan.title} [${child.plan.state}]`,
            ),
          ),
        );
        break;
      case "executions":
        lines.push(
          ...this.detailRows(
            detail.executions.map(
              (execution) => `${execution.state}  ${execution.identity}`,
            ),
          ),
        );
        break;
      case "milestones":
        lines.push(
          ...this.detailRows(
            detail.milestones.map(
              (milestone) =>
                `${milestone.title} · ${relativeTime(milestone.occurredAt, this.now())}`,
            ),
          ),
        );
        break;
      case "artifacts":
        lines.push(...this.artifactRows(detail.artifactIds));
        break;
      case "conflicts":
        lines.push(
          ...this.detailRows(
            detail.conflicts.map(
              (conflict) => `${conflict.kind}: ${conflict.reason}`,
            ),
          ),
        );
        break;
    }
    if (detail.pending.length > 0)
      lines.push(
        this.options.theme.fg(
          "warning",
          `${detail.pending.length} pending operation(s)`,
        ),
      );
    lines.push(
      "",
      this.options.theme.fg("dim", "tab sections · esc back · ? help"),
    );
    return lines.slice(0, height);
  }

  private renderHelp(width: number): string[] {
    return [
      this.options.theme.fg(
        "accent",
        this.options.theme.bold("Mission board help"),
      ),
      "",
      fitLine("↑/↓ or j/k  select", width),
      fitLine("enter       item detail / artifact action", width),
      fitLine("tab         next detail section", width),
      fitLine("r           refresh", width),
      fitLine("?           toggle help", width),
      fitLine("esc         back / close", width),
    ];
  }

  private detailRows(rows: readonly string[]): string[] {
    return rows.length === 0
      ? [this.options.theme.fg("muted", "None.")]
      : rows.map((row) => `  ${row}`);
  }

  private artifactRows(artifactIds: readonly string[]): string[] {
    if (artifactIds.length === 0)
      return [this.options.theme.fg("muted", "No artifacts.")];
    return artifactIds.map((artifactId, index) => {
      const line = `${index === this.artifactSelected ? ">" : " "} ${artifactId}`;
      return index === this.artifactSelected
        ? this.options.theme.bg("selectedBg", line)
        : line;
    });
  }

  private move(direction: number): void {
    const detail = this.selectedDetail();
    const section = DETAIL_SECTIONS[this.detailSectionIndex];
    if (this.mode === "detail" && section === "artifacts" && detail) {
      this.artifactSelected = clamp(
        this.artifactSelected + direction,
        detail.artifactIds.length,
      );
    } else if (this.mode === "board") {
      this.selected = clamp(
        this.selected + direction,
        this.state.projection?.roadmap.length ?? 0,
      );
    }
    this.invalidateAndRender();
  }

  private enter(): void {
    if (this.mode === "board" && this.selectedDetail()) {
      this.mode = "detail";
      this.invalidateAndRender();
      return;
    }
    const detail = this.selectedDetail();
    if (
      this.mode === "detail" &&
      DETAIL_SECTIONS[this.detailSectionIndex] === "artifacts" &&
      detail
    ) {
      const artifactId = detail.artifactIds[this.artifactSelected];
      if (artifactId) void this.options.openArtifact?.(artifactId);
    }
  }

  private selectedDetail(): ItemDetailView | undefined {
    const projection = this.state.projection;
    const row = projection?.roadmap[this.selected];
    return row ? projection.detailsByItemId[row.itemId] : undefined;
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.options.requestRender();
  }

  private section(title: string): string {
    return this.options.theme.fg("accent", this.options.theme.bold(title));
  }

  private helpLine(): string {
    const refresh = this.state.refreshing ? "refreshing… · " : "";
    return this.options.theme.fg(
      "dim",
      `${refresh}↑↓ select · enter detail · r refresh · ? help · esc close`,
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function reservedRoadmapRows(
  rows: readonly RoadmapRowView[],
  selected: number,
  maximum: number,
): {
  readonly values: readonly {
    readonly row: RoadmapRowView;
    readonly index: number;
  }[];
  readonly hidden: number;
} {
  const indexed = rows.map((row, index) => ({ row, index }));
  const current = indexed.filter((entry) => entry.row.phase === "current");
  const upcoming = indexed.filter((entry) => entry.row.phase === "upcoming");
  const remaining = Math.max(0, maximum - current.length);
  const selectedUpcoming = Math.max(
    0,
    upcoming.findIndex((entry) => entry.index === selected),
  );
  const slice = boundedSlice(upcoming, selectedUpcoming, remaining);
  const values = [...current, ...slice.values];
  return { values, hidden: rows.length - values.length };
}

function clamp(value: number, length: number): number {
  return length <= 0 ? 0 : Math.max(0, Math.min(value, length - 1));
}
