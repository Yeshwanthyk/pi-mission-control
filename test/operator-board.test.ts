import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { OperatorBoardController } from "../src/operator-board.ts";
import {
  OperatorBoardComponent,
  reservedRoadmapRows,
} from "../src/tui/operator-board-component.ts";
import type { MissionProjection } from "../src/mission-types.ts";

const projection: MissionProjection = {
  schema: "pi.mission-projection/v1",
  missionId: { status: "known", value: "mission" },
  projectionRevision: "revision",
  boardState: "ready",
  header: {
    title: "Unified operator board with a deliberately long title",
    state: { status: "known", value: "active" },
    aggregateEta: {
      status: "known",
      value: {
        expected: 12,
        optimistic: { status: "known", value: 10 },
        pessimistic: { status: "known", value: 16 },
      },
    },
    changeStats: { status: "known", value: { additions: 42, deletions: 7 } },
    latestSemanticAt: { status: "known", value: "2026-01-01T00:00:00.000Z" },
  },
  roadmap: [
    {
      itemId: "item-1",
      phase: "current",
      state: "active",
      title: "Implement terminal board",
      cumulativeEta: {
        status: "known",
        value: {
          expected: 4,
          optimistic: { status: "known", value: 3 },
          pessimistic: { status: "known", value: 6 },
        },
      },
      attribution: [
        {
          sessionId: "session",
          displayName: "Yesh",
          initials: "YK",
          color: "blue",
        },
      ],
      blockedReason: { status: "unknown", reason: "not-planned" },
      conflictCount: 0,
    },
    {
      itemId: "item-2",
      phase: "upcoming",
      state: "planned",
      title: "Harden integration tests",
      cumulativeEta: {
        status: "known",
        value: {
          expected: 12,
          optimistic: { status: "known", value: 10 },
          pessimistic: { status: "known", value: 16 },
        },
      },
      attribution: [],
      blockedReason: { status: "unknown", reason: "not-planned" },
      conflictCount: 0,
    },
  ],
  progress: [
    {
      eventId: "event",
      itemId: "item-1",
      title: "Secure artifact routing verified",
      occurredAt: "2026-01-01T00:00:00.000Z",
      summary: [{ kind: "tests", count: 8 }],
      attribution: {
        status: "known",
        value: {
          sessionId: "session",
          displayName: "Yesh",
          initials: "YK",
          color: "blue",
        },
      },
      artifactIds: ["event:1"],
      changeStats: [],
    },
  ],
  detailsByItemId: {},
  unassignedCount: 0,
  capabilities: { text: true, diff: true, media: false, external: false },
};
const details = {
  ...projection,
  detailsByItemId: {
    "item-1": {
      itemId: "item-1",
      plan: {
        itemId: "item-1",
        order: 0,
        title: "Implement terminal board",
        state: "active" as const,
        dependencyItemIds: [],
        contributorSessionIds: ["session"],
        externalRefs: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      plannedChildren: [],
      executions: [],
      milestones: projection.progress,
      artifactIds: ["event:1"],
      pending: [],
      conflicts: [],
    },
  },
} satisfies MissionProjection;

const theme = {
  fg: (
    _color: "accent" | "dim" | "error" | "muted" | "text" | "warning",
    text: string,
  ) => text,
  bg: (_color: "selectedBg", text: string) => text,
  bold: (text: string) => text,
};

test("operator board controller cancels timers and ignores refresh completion after close", async () => {
  let resolveLoad: ((value: MissionProjection) => void) | undefined;
  const load = new Promise<MissionProjection>((resolve) => {
    resolveLoad = resolve;
  });
  let updates = 0;
  const controller = new OperatorBoardController(() => load, 250);
  controller.start(() => updates++);
  assert.equal(controller.state.refreshing, true);
  controller.stop();
  controller.stop();
  resolveLoad?.(details);
  await load;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.state.projection, undefined);
  assert.equal(updates, 1);
});

test("roadmap slicing reserves every current row while scrolling upcoming work", () => {
  const first = projection.roadmap[0];
  const upcoming = projection.roadmap[1];
  assert.ok(first && upcoming);
  const rows = [
    first,
    { ...first, itemId: "item-current-2", title: "Second current" },
    ...Array.from({ length: 6 }, (_, index) => ({
      ...upcoming,
      itemId: `upcoming-${index}`,
      title: `Upcoming ${index}`,
    })),
  ];
  const visible = reservedRoadmapRows(rows, 7, 4);
  assert.deepEqual(
    visible.values.map((entry) => entry.row.itemId),
    ["item-1", "item-current-2", "upcoming-4", "upcoming-5"],
  );
});

test("real board component is responsive and supports detail/help/refresh/close interactions", async () => {
  const controller = new OperatorBoardController(async () => details, 10_000);
  let height = 20;
  let renders = 0;
  let closes = 0;
  const artifacts: string[] = [];
  const component = new OperatorBoardComponent({
    controller,
    theme,
    height: () => height,
    done: () => closes++,
    requestRender: () => renders++,
    openArtifact: (artifactId) => {
      artifacts.push(artifactId);
    },
    now: () => new Date("2026-01-01T00:05:00.000Z"),
  });
  controller.start((state) => component.setState(state));
  await controller.refresh();
  const snapshots: Record<string, readonly string[]> = {};
  for (const width of [120, 100, 80, 79, 40]) {
    for (height of [20, 6]) {
      component.invalidate();
      const lines = component.render(width);
      if ((width === 40 && height === 6) || (width === 100 && height === 20))
        snapshots[`${width}x${height}`] = lines;
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /Implement terminal board/);
    }
  }

  const asciiComponent = new OperatorBoardComponent({
    controller,
    theme,
    height: () => 8,
    done: () => {},
    requestRender: () => {},
    ascii: true,
  });
  asciiComponent.setState(controller.state);
  assert.match(
    asciiComponent.render(80).join("\n"),
    />\* Implement terminal board/,
  );

  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/operator-board/responsive.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  assert.deepEqual(snapshots, golden);

  height = 20;
  component.handleInput("\r");
  assert.match(component.render(80).join("\n"), /Detail · plan/);
  for (let index = 0; index < 4; index++) component.handleInput("\t");
  assert.match(component.render(80).join("\n"), /Detail · artifacts/);
  component.handleInput("\r");
  assert.deepEqual(artifacts, ["event:1"]);
  component.handleInput("?");
  assert.match(component.render(40).join("\n"), /Mission board help/);
  component.handleInput("\x1b");
  component.handleInput("r");
  component.handleInput("\x1b");
  component.handleInput("\x1b");
  assert.equal(closes, 1);
  assert.ok(renders > 0);
  controller.stop();
});
