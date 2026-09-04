import type { Edge, GuardValue } from "@kona/core";

export function guardValue(edge: Edge): GuardValue | null {
  return typeof edge.guard === "object" && "on" in edge.guard ? edge.guard.on : null;
}

export function guardKey(edge: Edge): string {
  if (edge.guard === undefined) return "";
  if (edge.guard === "else") return "else";
  if ("on" in edge.guard) return `on:${edge.guard.on}`;
  return `count:${JSON.stringify(edge.guard)}`;
}

export function guardLabel(edge: Edge): string | null {
  if (edge.guard === undefined) return null;
  if (edge.guard === "else") return "else fallback";
  if ("on" in edge.guard) return edge.guard.on;
  const attrs = Object.entries(edge.guard.count.attrs ?? {}).map(
    ([key, value]) => `${key}=${String(value)}`,
  );
  return [`count ${edge.guard.count.verdict}`, ...attrs, edge.guard.op, String(edge.guard.n)].join(
    " ",
  );
}
