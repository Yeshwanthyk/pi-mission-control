import type {
  DurationRange,
  MissionPlan,
  RoadmapItem,
  ValueState,
} from "./mission-types.ts";

interface Accumulator {
  expected: number;
  optimistic: number;
  pessimistic: number;
  optimisticKnown: boolean;
  pessimisticKnown: boolean;
  expectedKnown: boolean;
  blocked: boolean;
}

export interface MissionEtaResult {
  readonly byItemId: ReadonlyMap<string, ValueState<DurationRange>>;
  readonly aggregate: ValueState<DurationRange>;
}

export function calculateMissionEta(plan: MissionPlan): MissionEtaResult {
  const topLevel = plan.items.filter((item) => !item.parentItemId);
  const byId = new Map(plan.items.map((item) => [item.itemId, item]));
  const slots =
    plan.schedule.mode === "serial"
      ? [...topLevel]
          .sort((left, right) => left.order - right.order)
          .map((item) => [item] as readonly RoadmapItem[])
      : plan.schedule.waves.map((wave) =>
          wave.itemIds
            .flatMap((id) => {
              const item = byId.get(id);
              return item ? [item] : [];
            })
            .sort((left, right) => left.order - right.order),
        );
  const result = new Map<string, ValueState<DurationRange>>();
  let accumulated: Accumulator = {
    expected: 0,
    optimistic: 0,
    pessimistic: 0,
    optimisticKnown: true,
    pessimisticKnown: true,
    expectedKnown: true,
    blocked: false,
  };
  for (const slot of slots) {
    accumulated = addSlot(accumulated, slot, byId);
    const value = accumulatorValue(accumulated);
    for (const item of slot) result.set(item.itemId, value);
  }
  return { byItemId: result, aggregate: accumulatorValue(accumulated) };
}

function addSlot(
  previous: Accumulator,
  items: readonly RoadmapItem[],
  byId: ReadonlyMap<string, RoadmapItem>,
): Accumulator {
  const remaining = items.filter(
    (item) =>
      item.state !== "completed" &&
      item.state !== "failed" &&
      item.state !== "cancelled",
  );
  const blocked =
    previous.blocked ||
    remaining.some((item) =>
      item.dependencyItemIds.some((id) => {
        const dependency = byId.get(id);
        return (
          dependency?.state === "failed" || dependency?.state === "cancelled"
        );
      }),
    );
  if (remaining.length === 0) return { ...previous, blocked };
  const estimates = remaining.map((item) => item.estimate);
  const expectedKnown =
    previous.expectedKnown &&
    estimates.every((estimate) => estimate !== undefined);
  const optimisticKnown =
    previous.optimisticKnown &&
    estimates.every((estimate) => estimate?.optimistic !== undefined);
  const pessimisticKnown =
    previous.pessimisticKnown &&
    estimates.every((estimate) => estimate?.pessimistic !== undefined);
  const select = (field: "expected" | "optimistic" | "pessimistic"): number => {
    const values = estimates.map((estimate) => estimate?.[field] ?? 0);
    return items.length === 1 ? (values[0] ?? 0) : Math.max(0, ...values);
  };
  return {
    expected: previous.expected + select("expected"),
    optimistic: previous.optimistic + select("optimistic"),
    pessimistic: previous.pessimistic + select("pessimistic"),
    expectedKnown,
    optimisticKnown,
    pessimisticKnown,
    blocked,
  };
}

function accumulatorValue(value: Accumulator): ValueState<DurationRange> {
  if (value.blocked)
    return { status: "unknown", reason: "blocked-by-terminal" };
  if (!value.expectedKnown)
    return { status: "unknown", reason: "not-estimated" };
  return {
    status: "known",
    value: {
      expected: value.expected,
      optimistic: value.optimisticKnown
        ? { status: "known", value: value.optimistic }
        : { status: "unknown", reason: "missing-bound" },
      pessimistic: value.pessimisticKnown
        ? { status: "known", value: value.pessimistic }
        : { status: "unknown", reason: "missing-bound" },
    },
  };
}
