import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ValueState } from "../mission-types.ts";

export function fitLine(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(value.replace(/[\r\n]/g, " "), width, "…");
}

export function columns(
  left: string,
  right: string,
  width: number,
  minimumGap = 2,
): string {
  if (width <= 0) return "";
  const boundedRight = fitLine(right, Math.max(0, Math.floor(width / 2)));
  const rightWidth = visibleWidth(boundedRight);
  if (rightWidth === 0) return fitLine(left, width);
  const leftWidth = width - rightWidth - minimumGap;
  if (leftWidth < 8) return fitLine(left, width);
  const boundedLeft = fitLine(left, leftWidth);
  return `${boundedLeft}${" ".repeat(width - visibleWidth(boundedLeft) - rightWidth)}${boundedRight}`;
}

export function relativeTime(iso: string, now: Date): string {
  const milliseconds = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(milliseconds)) return "time —";
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function etaText(
  eta: ValueState<{ readonly expected: number }>,
): string {
  return eta.status === "known" ? `eta ${eta.value.expected}m` : "eta —";
}

export function marker(
  kind: "current" | "upcoming" | "selected" | "child",
  ascii: boolean,
): string {
  if (ascii) {
    switch (kind) {
      case "current":
        return "*";
      case "upcoming":
        return "o";
      case "selected":
        return ">";
      case "child":
        return "-";
    }
  }
  switch (kind) {
    case "current":
      return "■";
    case "upcoming":
      return "□";
    case "selected":
      return "›";
    case "child":
      return "└";
  }
}

export function boundedSlice<T>(
  values: readonly T[],
  selected: number,
  maximum: number,
): {
  readonly values: readonly T[];
  readonly start: number;
  readonly hidden: number;
} {
  if (maximum <= 0) return { values: [], start: 0, hidden: values.length };
  const boundedSelected = Math.max(0, Math.min(selected, values.length - 1));
  const start = Math.max(
    0,
    Math.min(
      boundedSelected - Math.floor(maximum / 2),
      values.length - maximum,
    ),
  );
  const slice = values.slice(start, start + maximum);
  return { values: slice, start, hidden: values.length - slice.length };
}
