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
import type { Graph } from "@kona/core";
import { inEdges, outEdges, resolutionOf } from "@kona/core";
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
const KV = "grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3.5 py-2.5 font-mono text-[11px]";

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
          <Row label="status" value={activity.status.state} />
          <Row label="readiness" value={view.readiness} />
          <Row label="group" value={view.group} />
          <Row label="effect class" value={activity.spec.effect_class} />
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
              <Row label="on timeout" value={wait.onTimeout ?? "—"} />
              <Row label="waiting for" value={wait.matchLabel} />
              {wait.predicate !== null && (
                <Row
                  label="predicate"
                  value={`${wait.predicate.label} — ${String(wait.predicate.have)}/${String(wait.predicate.need)}, ${String(wait.predicate.live)} still live`}
                />
              )}
              {wait.unresolvedReason !== null && (
                <Row label="note" value={wait.unresolvedReason} />
              )}
            </>
          )}
          <Row
            label="requires"
            value={
              incoming.length === 0
                ? "—"
                : incoming
                    .map((e) => e.from + (e.condition === undefined ? "" : ` [${e.condition.on}]`))
                    .join(", ")
            }
          />
          <Row
            label="unblocks"
            value={outgoing.length === 0 ? "—" : outgoing.map((e) => e.to).join(", ")}
          />
        </dl>

        {view.blocked !== null && (
          <>
            <Separator />
            <dl className={KV}>
              <Row
                label={view.blocked.unreachable ? "unreachable" : "blocked"}
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

        <Reveal title="instruction">{activity.spec.instruction}</Reveal>

        {activity.status.outcomes.length > 0 && (
          <Reveal title={`outcomes (${String(activity.status.outcomes.length)}) — append-only`}>
            {activity.status.outcomes
              .map(
                (outcome) =>
                  `v${String(outcome.at_version)}  ${outcome.verdict}  ${outcome.evidence_ref}` +
                  (outcome.attrs === undefined ? "" : `\n      ${JSON.stringify(outcome.attrs)}`),
              )
              .join("\n")}
          </Reveal>
        )}

        {activity.status.output !== null && (
          <Reveal title="output">{pretty(activity.status.output)}</Reveal>
        )}

        {activity.status.effect_log.length > 0 && (
          <Reveal title={`effect log (${String(activity.status.effect_log.length)})`}>
            {activity.status.effect_log
              .map(
                (record) =>
                  `${record.effect_key}\n  attempted ${formatIso(record.attempted_at)}` +
                  `\n  completed ${record.completed_at === null ? "—" : formatIso(record.completed_at)}` +
                  `\n  message   ${record.message_id ?? "—"}`,
              )
              .join("\n")}
          </Reveal>
        )}

        {activity.status.conditions.length > 0 && (
          <Reveal title={`conditions (${String(activity.status.conditions.length)})`}>
            {pretty(activity.status.conditions)}
          </Reveal>
        )}

        <Reveal title="raw activity">{pretty(activity)}</Reveal>
      </ScrollArea>
    </section>
  );
}
