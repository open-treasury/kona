/**
 * How an activity is named in a message: its name, with the id that addresses it.
 *
 * Ids are hashes, so an id alone tells a reader nothing about which step is being refused.
 * The name alone would be ambiguous — two steps can share one — so both, always in the same
 * order, so the shape is learnable.
 */
export function named(activity: { id: string; name?: string }): string {
  return activity.name === undefined ? `'${activity.id}'` : `'${activity.name}' (${activity.id})`;
}

/**
 * `named`, for a message that has the id and the graph rather than the activity.
 *
 * Falls back to the bare id when the graph has never seen it — which is exactly the
 * UNKNOWN_ACTIVITY case, where there is no name to give and the id is the whole point.
 */
export function namedIn(
  graph: { nodes: Map<string, { id: string; name: string }> },
  id: string,
): string {
  const activity = graph.nodes.get(id);
  return activity === undefined ? `'${id}'` : named(activity);
}

/**
 * `namedIn`, extended to the batch being validated.
 *
 * A refusal often concerns an activity the author added in this very batch, which is not in head
 * yet — so a head-only lookup falls back to the bare id at exactly the moment the author most
 * wants to be told which of their new steps is wrong. They just wrote the name; use it.
 */
export function namedHere(
  graph: { nodes: Map<string, { id: string; name: string }> },
  ops: readonly { op: string; id?: string; name?: string }[],
  id: string,
): string {
  const committed = graph.nodes.get(id);
  if (committed !== undefined) return named(committed);
  for (const op of ops) {
    if (op.op === "add_node" && op.id === id && op.name !== undefined)
      return named({ id, name: op.name });
  }
  return `'${id}'`;
}
