/**
 * What SHAPE did the model actually author?
 *
 * `docs/prd-activity-model.md` R1 says "watch it in the eval rig" and its Definition of Done
 * asks for a regenerated authoring run that "produces a graph that is not a chain". Neither
 * had an instrument: the rig scores rewards and CTRF, and nothing anywhere reads structure.
 * So the claim the whole redesign rests on — that naming concurrency makes the model express
 * it — was unfalsifiable. This is the falsifier.
 *
 * It reads `/.kona/mutations.jsonl`, which all three run scripts already collect as an
 * artifact and nothing has ever opened. No new plumbing, and it works on runs already banked.
 *
 *   bun eval/analyze/shape.ts eval/jobs                       # every run found
 *   bun eval/analyze/shape.ts fixtures/goalie.mutations.jsonl # one log
 *
 * The headline number is CHAIN RATIO: the share of nodes whose in-degree and out-degree are
 * both at most one. A pure chain is 1.00. It is reported next to the widest fan, because the
 * two fail differently — a plan can be one long chain with a single three-way fan-out at the
 * end and still be, in every sense that matters, a list.
 *
 * It is computed over ALL nodes, control ones included, and that is not a detail. The first
 * version of this file measured only WORKED nodes and scored the fork/join fixture a perfect
 * 1.00 — because S7 REQUIRES every action to have exactly one in-edge and one out-edge, so a
 * worked-node linearity measure is 1.00 by construction on any legal v2 graph. All the
 * branching lives in the control nodes; measuring the boxes and ignoring the diamonds measures
 * the one part of the graph that is not allowed to branch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Op = Record<string, unknown>;
type Record_ = { v?: number; ops?: Op[] };

/** Node types that carry work. Everything else is the store's shape, and free. */
const WORKED = new Set(["action", "accept_event", "task", "wait"]);

export interface Shape {
  source: string;
  versions: number;
  worked: number;
  control: number;
  edges: number;
  /** Topology ops, which is what "the agent maintained its plan" actually means. */
  topologyOps: number;
  byType: Record<string, number>;
  widestFan: number;
  chainRatio: number;
  /** Did it ever author a fork, a decision, or a merge/join? The three shapes a list cannot have. */
  expressedBranching: boolean;
  expressedConcurrency: boolean;
}

export function shapeOf(source: string, text: string): Shape {
  const byType: Record<string, number> = {};
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const typeOf = new Map<string, string>();
  let versions = 0;
  let edges = 0;
  let topologyOps = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record_;
    try {
      record = JSON.parse(line) as Record_;
    } catch {
      continue; // a torn tail is the log's business, not this report's
    }
    versions += 1;
    for (const op of record.ops ?? []) {
      const kind = op["op"];
      if (kind === "add_node" || kind === "add_activity") {
        topologyOps += 1;
        const raw = op["type"];
        const type = typeof raw === "string" ? raw : "unknown";
        byType[type] = (byType[type] ?? 0) + 1;
        const id = op["id"];
        if (typeof id === "string") typeOf.set(id, type);
      } else if (kind === "add_edge") {
        topologyOps += 1;
        edges += 1;
        const from = op["from"];
        const to = op["to"];
        if (typeof from === "string") outDeg.set(from, (outDeg.get(from) ?? 0) + 1);
        if (typeof to === "string") inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
      } else if (kind === "supersede_node" || kind === "supersede_activity") {
        topologyOps += 1;
      }
    }
  }

  const workedIds = [...typeOf].filter(([, type]) => WORKED.has(type)).map(([id]) => id);
  const allIds = [...typeOf.keys()];
  const linear = allIds.filter(
    (id) => (inDeg.get(id) ?? 0) <= 1 && (outDeg.get(id) ?? 0) <= 1,
  ).length;

  const control = [...typeOf.values()].filter((type) => !WORKED.has(type)).length;
  // `reduce` rather than `Math.max(...values)`: a plan with thousands of edges would blow
  // the argument limit, and a shape report that crashes on the biggest plan is the wrong way
  // round.
  const widestFan = [...outDeg.values()].reduce((max, n) => (n > max ? n : max), 0);

  return {
    source,
    versions,
    worked: workedIds.length,
    control,
    edges,
    topologyOps,
    byType,
    widestFan,
    // A pursuit with no nodes is not a chain; it is nothing. Reporting 1.00 there would read
    // as "maximally list-like", which is the opposite of what an empty log means.
    chainRatio: allIds.length === 0 ? 0 : linear / allIds.length,
    expressedBranching: (byType["decision"] ?? 0) > 0,
    expressedConcurrency: (byType["fork"] ?? 0) > 0,
  };
}

function logsUnder(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "mutations.jsonl") found.push(path);
    }
  };
  walk(root);
  return found.toSorted();
}

function main(): void {
  const root = process.argv[2] ?? "eval/jobs";
  const logs = logsUnder(root);
  if (logs.length === 0) {
    console.log(`no mutations.jsonl under ${root}`);
    return;
  }

  console.log(
    ["chain", "worked", "ctrl", "edges", "topo", "fan", "branch", "conc", "source"].join("\t"),
  );
  for (const path of logs) {
    const s = shapeOf(path, readFileSync(path, "utf8"));
    console.log(
      [
        s.chainRatio.toFixed(2),
        s.worked,
        s.control,
        s.edges,
        s.topologyOps,
        s.widestFan,
        s.expressedBranching ? "yes" : "no",
        s.expressedConcurrency ? "yes" : "no",
        s.source,
      ].join("\t"),
    );
  }
}

if (import.meta.main) main();
