/**
 * Spec §7 *Divergent arms*, as executable assertions over `kona graph --json`.
 *
 * > *"from a v1 plan where every arm is identical, assert **(a)** a node no v1 node's shape
 * > describes · **(b)** a counterparty absent from the v1 roster · **(c)** three arms with
 * > pairwise different node counts · **(d)** an arm with an edge leaving its own group. Pass
 * > and the run produced structure no parameterised fan-out could. Fail and the system
 * > behaved as `withParam` regardless of the code."*
 *
 * That last sentence is why this file is careful rather than convenient. Argo, Kestra and
 * Windmill have all done parameterised fan-out since 2018, and a test that passes for a
 * reason unrelated to the claim is worse than no test — it certifies the objection.
 *
 * ## Two ways to write these wrong, both of which produce a green run
 *
 * **(b) via a `recipient_ref` set difference.** "Collect every `recipient_ref` at head,
 * subtract v1's, assert non-empty" returns Sam, Priya and Pat — who are exactly the names the
 * v1 roster step DID return, and exactly what a `withParam` fan-out over that list would
 * produce. It is green, and it proves the opposite of the claim. So (b) is asserted against
 * the roster the graph itself recorded, and demands a counterparty who is not in it.
 *
 * **(c) via groups.** Counting `provenance.group` gives goalies 8, setup 4, marcus 2 —
 * pairwise different, and meaningless: `setup` is not an arm, and `goalies` is four arms
 * fused. So an arm here is derived from the topology: reachability forward from an arm root.
 *
 * ## What an arm is
 *
 * A **root** is a node outside the `setup` group with no in-edge from another non-setup node.
 * An **arm** is everything reachable forward from a root, stopping at the `setup` group —
 * because `setup` is the shared scaffolding every arm converges on, and walking into it would
 * merge all the arms into one.
 *
 * Under that definition an arm that grew a sub-flow really is bigger, which is the property
 * (c) is trying to detect.
 */

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  spec: {
    effect_class?: string;
    effect?: { channel?: string; recipient_ref?: string };
    match?: { kind?: string };
    deadline?: Record<string, unknown>;
    outputs?: { name: string; type: string }[];
  };
  status: {
    state: string;
    output?: Record<string, unknown> | null;
  };
  provenance: { created_by_version: number; group?: string; superseded_by: string | null };
}

export interface GraphEdge {
  from: string;
  to: string;
  condition?: { on: string };
}

export interface GraphJson {
  schema_version: number;
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const SETUP_GROUP = "setup";

export interface Assertion {
  id: "a" | "b" | "c" | "d";
  claim: string;
  passed: boolean;
  /** The specific node, edge or number that decided it. Printed either way. */
  witness: string;
}

/** Narrow the `unknown` that `kona graph --json` hands back, loudly. */
export function asGraph(value: unknown): GraphJson {
  if (typeof value !== "object" || value === null) throw new TypeError("graph is not an object");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) {
    throw new TypeError("graph has no nodes/edges arrays");
  }
  return value as GraphJson;
}

/**
 * The structural signature of a node.
 *
 * `template_id` does not exist anywhere in `packages/core` — the beads wording for (a) that
 * mentions one is aspirational — so "a shape v1 describes" has to be computed. These are the
 * five things that make two nodes the same kind of thing: what it is, how reversible it is,
 * what it waits on, what shape its deadline takes, and whether it touches a counterparty.
 */
export function shapeOf(node: GraphNode): string {
  const deadlineKeys = Object.keys(node.spec.deadline ?? {}).toSorted().join("+") || "none";
  return [
    node.type,
    node.spec.effect_class ?? "none",
    node.spec.match?.kind ?? "none",
    deadlineKeys,
    node.spec.effect === undefined ? "no-effect" : "effect",
  ].join("/");
}

export function isSetup(node: GraphNode): boolean {
  return (node.provenance.group ?? SETUP_GROUP) === SETUP_GROUP;
}

/** Arms, keyed by their root node id, computed from the topology rather than from names. */
export function arms(graph: GraphJson): Map<string, string[]> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nonSetup = graph.nodes.filter((node) => !isSetup(node));
  const nonSetupIds = new Set(nonSetup.map((node) => node.id));

  const hasArmParent = new Set<string>();
  for (const edge of graph.edges) {
    if (nonSetupIds.has(edge.from) && nonSetupIds.has(edge.to)) hasArmParent.add(edge.to);
  }

  const result = new Map<string, string[]>();
  for (const root of nonSetup) {
    if (hasArmParent.has(root.id)) continue;
    const seen = new Set<string>();
    const queue = [root.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      const node = byId.get(id);
      // Stop at `setup`: it is the shared scaffolding, and walking in would fuse every arm.
      if (node === undefined || isSetup(node)) continue;
      seen.add(id);
      for (const edge of graph.edges) if (edge.from === id) queue.push(edge.to);
    }
    result.set(root.id, [...seen]);
  }
  return result;
}

/**
 * The roster the graph itself recorded, rather than a list this file happens to know.
 *
 * Reading it back out of `record_output` is the point: (b) has to be checked against what the
 * pursuit believed its roster was, or it is checking this file against itself.
 */
export function recordedRoster(graph: GraphJson): string[] {
  const rosterNodes = graph.nodes.filter(
    (node) => node.status.output !== null && node.status.output !== undefined,
  );
  for (const node of rosterNodes) {
    const availability = node.status.output?.["availability"];
    if (Array.isArray(availability)) {
      return availability.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

/** Every counterparty the graph is addressed to, as the fragment of its `recipient_ref`. */
export function addressedCounterparties(graph: GraphJson): Map<string, string> {
  const found = new Map<string, string>();
  for (const node of graph.nodes) {
    const ref = node.spec.effect?.recipient_ref;
    if (ref === undefined) continue;
    const fragment = ref.includes("#") ? (ref.split("#").at(-1) ?? ref) : ref;
    found.set(fragment, node.id);
  }
  return found;
}

export function assertDivergentArms(head: GraphJson, v1: GraphJson): Assertion[] {
  return [checkA(head, v1), checkB(head), checkC(head), checkD(head)];
}

/** (a) a node no v1 node's shape describes. */
function checkA(head: GraphJson, v1: GraphJson): Assertion {
  const v1Shapes = new Set(v1.nodes.map(shapeOf));
  const novel = head.nodes.filter((node) => !v1Shapes.has(shapeOf(node)));
  // An arm node is the witness the assertion's framing wants — "every arm is identical" is a
  // claim about arms. A novel node that is only shared scaffolding is a weaker beat.
  const inArm = novel.find((node) => !isSetup(node)) ?? novel[0];
  return {
    id: "a",
    claim: "a node no v1 node's shape describes",
    passed: inArm !== undefined,
    witness:
      inArm === undefined
        ? `every head shape is one of v1's ${v1Shapes.size}: ${[...v1Shapes].join(", ")}`
        : `${inArm.id} is ${shapeOf(inArm)}; v1 has only ${[...v1Shapes].join(", ")}`,
  };
}

/** (b) a counterparty absent from the v1 roster. */
function checkB(head: GraphJson): Assertion {
  const roster = new Set(recordedRoster(head));
  const addressed = addressedCounterparties(head);
  const offRoster = [...addressed].filter(([who]) => !roster.has(who));
  return {
    id: "b",
    claim: "a counterparty absent from the v1 roster",
    passed: offRoster.length > 0,
    witness:
      offRoster.length === 0
        ? `every addressed counterparty is on the recorded roster [${[...roster].join(", ")}]` +
          " — which is exactly what a parameterised fan-out over that list would produce"
        : offRoster
            .map(([who, node]) => `${who} is addressed by ${node} and is not on [${[...roster].join(", ")}]`)
            .join("; "),
  };
}

/** (c) three arms with pairwise different node counts. */
function checkC(head: GraphJson): Assertion {
  const byRoot = arms(head);
  const counts = [...byRoot].map(([root, nodes]) => ({ root, count: nodes.length }));
  const distinct = new Set(counts.map((entry) => entry.count));
  const detail = counts
    .toSorted((left, right) => right.count - left.count)
    .map((entry) => `${entry.root}=${entry.count}`)
    .join(" · ");
  return {
    id: "c",
    claim: "three arms with pairwise different node counts",
    passed: distinct.size >= 3,
    witness: `${distinct.size} distinct arm sizes across ${counts.length} arms — ${detail}`,
  };
}

/** (d) an arm with an edge leaving its own group. */
function checkD(head: GraphJson): Assertion {
  const byId = new Map(head.nodes.map((node) => [node.id, node]));
  // The strong form: an edge from one arm into ANOTHER arm. An edge into `setup` is the
  // shared merge every arm has by construction, so it cannot distinguish anything.
  for (const edge of head.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (isSetup(from) || isSetup(to)) continue;
    if ((from.provenance.group ?? "") === (to.provenance.group ?? "")) continue;
    return {
      id: "d",
      claim: "an arm with an edge leaving its own group",
      passed: true,
      witness: `${edge.from} (group ${from.provenance.group}) → ${edge.to} (group ${to.provenance.group})`,
    };
  }
  return {
    id: "d",
    claim: "an arm with an edge leaving its own group",
    passed: false,
    witness: "no edge runs between two different non-setup groups",
  };
}
