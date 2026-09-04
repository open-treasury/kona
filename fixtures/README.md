# Fixtures

Both fixture pairs use the final schema-v6 wire format. They intentionally preserve two
different scenarios.

| fixture      | prefix | regenerate with                      |
| ------------ | ------ | ------------------------------------ |
| `thursday.*` | `th`   | `./scripts/make-fixture.sh`          |
| `goalie.*`   | `gk`   | `./scripts/make-activity-fixture.sh` |

`thursday.*` preserves the original fourteen-node, v0..v13 handoff story used by the viewer
tests, including its ids and timestamps. It is a migrated historical fold fixture, not topology
newly admitted by the current validator: the generator writes fixed schema-v6 records and uses
the real CLI only to fold and project them. This distinction preserves the viewer's regression
story without presenting legacy topology as a native v6 commit.

`goalie.*` is the canonical all-nine-node activity-model scenario. It deliberately exercises:

- all nine node types, with control-node specs exactly `{}`;
- a fork whose three action arms become ready together;
- `accept_event` nodes routed through decisions with guarded and explicit `else` arms;
- a disjunctive merge followed by a conjunctive join;
- `inactive`, `ready`, `active`, `completed`, and `terminated` across history;
- superseding active work, producing `terminated` rather than `withdrawn`;
- native `timed_out` outcomes routed through decision fallbacks;
- a no-goalie recovery path that leaves escalation `ready` and the roster lock `inactive`;
- decision routing and merge/join propagation under dead-input exclusion;
- a completed outbox record for each email action, including Pat's prior `active` claim.

Generation timestamps are pinned by version before the graph is projected. Re-running either
script therefore produces byte-identical mutation and graph fixtures.
