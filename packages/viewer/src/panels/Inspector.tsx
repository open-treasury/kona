/**
 * The activity detail. Opened by selection, and by nothing else — the canvas has no other verb.
 *
 * §6.10 rule 9: **message bodies behind an explicit reveal.** A pursuit log carries real
 * counterparty names, real addresses and real reply text, and this window sits on a projector
 * during a demo. Everything that could be a person's words is inside a collapsed section; the
 * parts that are structure — status, provenance, deadline, dependencies — are open, because
 * they are the point.
 */

import { X } from "lucide-react";
import type { ActivityNode, Edge, Graph } from "@kona/core";
import {
  firedGuard,
  inEdges,
  isEdgeDead,
  isEdgeSatisfied,
  isBehaviour,
  outEdges,
  resolutionOf,
} from "@kona/core";
import { guardLabel } from "../model/guard.ts";
import type { ActivityView } from "../model/types.ts";
import { formatIso, pretty } from "../format.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Separator } from "../ui/separator.tsx";

export interface InspectorProps {
  graph: Graph;
  view: ActivityView;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt className="text-carbon-40">{label}</dt>
      <dd className="break-words text-foreground">{value}</dd>
    </>
  );
}

function Reveal({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Collapsible>
      <CollapsibleTrigger>{title}</CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Two columns rather than stacked label-over-value, at 100px because that is what a 380px rail
 * leaves. Stacking would read more comfortably and doubles the length of a panel that is
 * already the longest thing in the app — and this is a reference panel, scanned down the label
 * column for one row, not prose. Density wins here; it would not on the card.
 */
const KV =
  "grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3.5 py-2.5 font-mono text-[11px]";

export function liveControlInputs(graph: Graph, id: string): Edge[] {
  return inEdges(graph, id).filter(
    (edge) => (graph.nodes.get(edge.from)?.provenance.superseded_by ?? null) === null,
  );
}

export function hasRecordedOutput(activity: ActivityNode): boolean {
  return activity.status?.output != null;
}

/**
 * What each control node has to say for itself.
 *
 * Deliberately the SHAPE rather than a status: these nodes are the graph's own structure, and
 * the question a reader brings to one is "which way did this go" or "what is this still waiting
 * for" — never "how is it getting on".
 */
function ControlRows({
  graph,
  activity,
  incoming,
  outgoing,
}: {
  graph: Graph;
  activity: ActivityNode;
  incoming: Edge[];
  outgoing: Edge[];
}): React.ReactElement {
  const name = (id: string) => graph.nodes.get(id)?.name ?? id;
  const liveIncoming = liveControlInputs(graph, activity.id);

  if (activity.type === "decision") {
    const fired = firedGuard(graph, activity);
    return (
      <>
        <Row label="routes on" value={name(incoming[0]?.from ?? "—")} />
        {outgoing.map((edge, index) => (
          <Row
            key={`${edge.from}>${edge.to}>${String(index)}`}
            label={guardLabel(edge) ?? "unguarded"}
            // Evaluation order is edge order (§6.1), and first match wins — so the list IS the
            // rule, and marking the fired arm is the whole answer to "why did it go that way".
            value={`${edge === fired ? "→ " : "  "}${name(edge.to)}`}
          />
        ))}
      </>
    );
  }

  if (activity.type === "merge" || activity.type === "join") {
    const satisfied = liveIncoming.filter((edge) => isEdgeSatisfied(graph, edge));
    const dead = liveIncoming.filter((edge) => isEdgeDead(graph, edge));
    return (
      <>
        <Row
          label="arms"
          value={`${String(satisfied.length)} of ${String(liveIncoming.length)} satisfied${dead.length === 0 ? "" : `, ${String(dead.length)} over`}`}
        />
        <Row label="needs" value={activity.type === "join" ? "all of them" : "any one of them"} />
        {liveIncoming.map((edge, index) => (
          <Row
            key={`${edge.from}>${String(index)}`}
            label={isEdgeSatisfied(graph, edge) ? "in ✓" : isEdgeDead(graph, edge) ? "in ✗" : "in"}
            value={name(edge.from)}
          />
        ))}
      </>
    );
  }

  if (activity.type === "fork") {
    return (
      <>
        <Row label="arms" value={String(outgoing.length)} />
        {outgoing.map((edge, index) => (
          <Row key={`${edge.to}>${String(index)}`} label="runs" value={name(edge.to)} />
        ))}
      </>
    );
  }

  return (
    <Row
      label="feeds"
      value={outgoing.length === 0 ? "nothing — the flow ends here" : name(outgoing[0]?.to ?? "—")}
    />
  );
}

export function Inspector({ graph, view, onClose }: InspectorProps): React.ReactElement {
  const activity = view.activity;
  const incoming = inEdges(graph, activity.id);
  const outgoing = outEdges(graph, activity.id);
  const fired = resolutionOf(activity);
  const wait = view.wait;

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3 text-ui font-medium text-muted-foreground uppercase">
        <span className="truncate">{activity.id}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="cursor-pointer px-1 text-carbon-40 hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>

      <ScrollArea className="min-h-0">
        <dl className={KV}>
          {/*
            The header shows the id too, but `truncate`d — and ids run to 48 characters, so
            a real one is routinely clipped mid-word in a 380px rail. This row is the full,
            wrapping, selectable copy: it is the id you type into `kona brief <activity-id>`,
            and it is the activity's correlation address, so a half of it is no use.
          */}
          <Row label="id" value={<span className="select-all">{activity.id}</span>} />
          <Row label="name" value={activity.name} />
          <Row label="type" value={activity.type} />
          {/*
            The family decides what there is to say. A control node has no status, no readiness
            and no effect class — rendering those rows for one is not merely empty, it asserts
            three things that are not true of it. What it DOES have is the thing §3 says the
            whole redesign is for: an id a rationale can cite, and a shape a reader can check.
          */}
          {isBehaviour(activity) ? (
            <>
              <Row label="status" value={activity.status?.state} />
              <Row label="group" value={view.group} />
              <Row label="effect class" value={activity.spec.effect_class} />
            </>
          ) : (
            <ControlRows
              graph={graph}
              activity={activity}
              incoming={incoming}
              outgoing={outgoing}
            />
          )}
          {activity.spec.effect !== undefined && (
            <Row label="recipient" value={activity.spec.effect.recipient_ref} />
          )}
          <Row
            label="created / observed"
            value={`v${String(view.createdAtVersion)} → v${String(view.observedAtVersion)}`}
          />
          {activity.provenance.supersedes !== null && (
            <Row label="supersedes" value={activity.provenance.supersedes} />
          )}
          {activity.provenance.superseded_by !== null && (
            <Row label="superseded by" value={activity.provenance.superseded_by} />
          )}
          {fired !== null && <Row label="fired" value={fired} />}
          {wait !== null && (
            <>
              <Row label="deadline" value={wait.deadlineLabel} />
              <Row label="timeout route" value={wait.timeoutTarget ?? "—"} />
              <Row label="waiting for" value={wait.matchLabel} />
              {wait.predicate !== null && (
                <Row
                  label="predicate"
                  value={`${wait.predicate.label} — ${String(wait.predicate.have)}/${String(wait.predicate.need)}, ${String(wait.predicate.live)} still live`}
                />
              )}
              {wait.unresolvedReason !== null && <Row label="note" value={wait.unresolvedReason} />}
            </>
          )}
          <Row
            label="requires"
            value={
              incoming.length === 0
                ? "—"
                : incoming
                    .map((e) => e.from + (e.guard === undefined ? "" : ` [${guardLabel(e)}]`))
                    .join(", ")
            }
          />
          <Row
            label="unblocks"
            value={outgoing.length === 0 ? "—" : outgoing.map((e) => e.to).join(", ")}
          />
        </dl>

        {/* A reason with no causes is not a reason. It happens on a control node whose one
            in-edge is satisfied — the walk correctly finds nothing to report — and rendering
            the label anyway puts the word "blocked" next to an empty list. */}
        {view.blocked !== null && view.blocked.causes.length > 0 && (
          <>
            <Separator />
            <dl className={KV}>
              <Row
                label={
                  view.blocked.unreachable
                    ? "unreachable"
                    : view.blocked.parked
                      ? "parked"
                      : "blocked"
                }
                value={
                  <ul className="list-disc pl-4">
                    {view.blocked.causes.map((cause) => (
                      <li key={`${cause.from}:${cause.kind}`}>{cause.text}</li>
                    ))}
                  </ul>
                }
              />
            </dl>
          </>
        )}

        <Separator className="mb-3" />

        {/* A control node has no instruction — it is shape, not work. An empty reveal here
            invites a reader to open it and find out that the graph has nothing to say. */}
        {activity.spec.instruction !== undefined && (
          <Reveal title="instruction">{activity.spec.instruction}</Reveal>
        )}

        {(activity.status?.outcomes.length ?? 0) > 0 && (
          <Reveal
            title={`outcomes (${String(activity.status?.outcomes.length ?? 0)}) — append-only`}
          >
            {(activity.status?.outcomes ?? [])
              .map(
                (outcome) =>
                  `v${String(outcome.at_version)}  ${outcome.verdict}  ${outcome.evidence_ref}` +
                  (outcome.attrs === undefined ? "" : `\n      ${JSON.stringify(outcome.attrs)}`),
              )
              .join("\n")}
          </Reveal>
        )}

        {hasRecordedOutput(activity) && (
          <Reveal title="output">{pretty(activity.status?.output)}</Reveal>
        )}

        {(activity.status?.effect_log.length ?? 0) > 0 && (
          <Reveal title={`effect log (${String(activity.status?.effect_log.length ?? 0)})`}>
            {(activity.status?.effect_log ?? [])
              .map(
                (record) =>
                  `${record.effect_key}\n  attempted ${formatIso(record.attempted_at)}` +
                  `\n  completed ${record.completed_at === null ? "—" : formatIso(record.completed_at)}` +
                  `\n  message   ${record.message_id ?? "—"}`,
              )
              .join("\n")}
          </Reveal>
        )}

        {(activity.status?.conditions.length ?? 0) > 0 && (
          <Reveal title={`conditions (${String(activity.status?.conditions.length ?? 0)})`}>
            {pretty(activity.status?.conditions)}
          </Reveal>
        )}

        <Reveal title="raw activity">{pretty(activity)}</Reveal>
      </ScrollArea>
    </section>
  );
}
