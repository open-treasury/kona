#!/usr/bin/env bash
# Build the schema-v6 fixture: a pursuit using all nine node types, produced by
# the real binary so it cannot drift from what the CLI actually emits.
#
# This is the native schema-v6 fixture generator. `make-fixture.sh` separately preserves the
# migrated historical Thursday story used by the viewer regression suite.
#
# Regenerate with:  ./scripts/make-activity-fixture.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KONA="bun ${ROOT}/packages/kona/src/bin.ts"
PREFIX="${KONA_FIXTURE_PREFIX:-gk}"
BASENAME="${KONA_FIXTURE_BASENAME:-goalie}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cd "${WORK}"

# Resolve a readable name to the id the store minted. Same job as `make-fixture.sh`'s, with one
# fix: that one keyed a dict on the slug and took the FIRST match, so three terminators named
# "Declined" would collapse onto one id and the fixture would silently test the wrong graph.
# This one refuses an ambiguous name instead of guessing.
resolve() {
  ${KONA} graph --json > graph.json 2>/dev/null || { cat > ops.resolved.json; return; }
  python3 - "$1" <<'PY'
import json, re, sys, collections

graph = json.load(open("graph.json"))
def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48].rstrip("-")
    return s or "node"

counts = collections.Counter(slug(n["name"]) for n in graph.get("nodes", graph.get("nodes", [])))
by_slug = {slug(n["name"]): n["id"] for n in graph.get("nodes", graph.get("nodes", []))}
ids = {n["id"] for n in graph.get("nodes", graph.get("nodes", []))}

def fix(value):
    if not isinstance(value, str) or value.startswith("$") or value in ids:
        return value
    head, dot, tail = value.partition(".")
    key = head if dot else value
    if key in counts and counts[key] > 1:
        raise SystemExit(f"ambiguous name '{key}': {counts[key]} nodes slug to it")
    if dot and head in by_slug:
        return by_slug[head] + dot + tail
    return by_slug.get(value, value)

def walk(node):
    if isinstance(node, dict):
        return {k: (fix(v) if k in ("node", "from", "to", "by", "compensates", "ref", "after") else walk(v)) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v) for v in node]
    return node

json.dump(walk(json.load(open(sys.argv[1]))), open("ops.resolved.json", "w"))
PY
}

ops() { cat > ops.json; }
commit() {
  resolve ops.json
  ${KONA} mutate --ops ops.resolved.json --base-version "$1" --why "$2" --reason-code "$3" "${@:4}" >/dev/null
}
node_id() {
  ${KONA} graph --json | python3 -c 'import json,sys; name=sys.argv[1]; matches=[n["id"] for n in json.load(sys.stdin)["nodes"] if n["name"] == name]; assert len(matches) == 1, matches; print(matches[0])' "$1"
}
send_effect() {
  local id reserved key
  id="$(node_id "$1")"
  reserved="$(${KONA} effect reserve "${id}" --payload-hash "$2" --why "$3" --json)"
  key="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["effect_key"])' <<<"${reserved}")"
  ${KONA} effect record "${id}" --key "${key}" --outcome sent --message-id "$4" --why "$5" >/dev/null
}

cat > config.json <<'EOF'
{
  "identity": {
    "mailbox": "ilya@example.com",
    "display_name": "Ilya Vorobiev",
    "signature": "— Ilya",
    "authority": "You may confirm or decline a slot in Thursday's game. You may NOT commit funds, promise a different date, change the venue, or contact anyone not named in this brief."
  },
  "effect_budget": 12
}
EOF
${KONA} init --actor-id ilya --config config.json --prefix "${PREFIX}" >/dev/null

# v1-v2 — establish evidenced recipients before proposing any email effect. Invariant 3(b)
# reads evidence from pre-commit head, so the roster output and email nodes cannot share a batch.
ops <<'EOF'
[
 {"op":"add_node","name":"Start the roster hunt","type":"initial","spec":{}},
 {"op":"add_node","name":"Confirm roster contacts","type":"action",
  "spec":{"instruction":"Read the roster and venue directory.","inputs":[],
          "outputs":[{"name":"contacts","type":"string[]"}],"effect_class":"pure"}},
 {"op":"add_node","name":"Initial plan complete","type":"final","spec":{}},
 {"op":"add_edge","from":"$0","to":"$1"},
 {"op":"add_edge","from":"$1","to":"$2"}
]
EOF
commit 0 "Read the evidenced contact list before creating effects that address anyone." MISSING_STEP

ops <<'EOF'
[{"op":"record_output","node":"confirm-roster-contacts","output_name":"contacts","value":["dana","pat","leisure-centre"],"evidence_ref":"roster.csv#v3"},
 {"op":"set_status","node":"confirm-roster-contacts","status":"completed","evidence_ref":"roster.csv#v3"}]
EOF
commit 1 "The roster and venue directory identify both goalies and the leisure centre." OTHER

# v3 — the whole shape, in ONE commit. Under S1/S2 that is not a stylistic choice: every node
# must be reachable from the initial node and must reach a terminator, checked against
# post-commit state, so a batch that adds a step must also terminate it. A fan-out therefore
# arrives whole, which is what §6.4 always wanted and could not previously enforce.
#
# Both control diamonds and both bars, each doing the job only it can do: a MERGE takes either
# goalie (one is enough), and a JOIN takes the merge AND the pitch (both are needed). Under v1
# that distinction was `merge: "any"` versus its absence, on the node being joined into.
#
#   ● → ▮fork ┬→ [Ask Dana] → (Dana replies) → ◇ ─satisfied→ ◇ accepted ┐
#             │                                ├─bounced───→ ⊗           ├→ ◇ outcome ┐
#             │                                └─else──────→ ▮ timed out ┤            ├→ ▮join → [Lock] → ◎
#             ├→ [Ask Pat]  → (Pat replies)  → ◇ ─satisfied→ ◇ accepted │            │
#             │                                ├─bounced───→ ⊗           │            │
#             │                                └─else──────→ ▮ ─→ [Escalate] ─────────┘            │
#             └→ [Book the pitch] ──────────────────────────────────────────────────────────────────┘
ops <<'EOF'
[
 {"op":"add_node","name":"Ask both goalies at once","type":"fork","spec":{}},

 {"op":"add_node","name":"Ask Dana to play in goal","type":"action",
  "spec":{"instruction":"Email Dana and ask her to keep Thursday.","inputs":[],
          "outputs":[{"name":"sent","type":"string"}],"effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#dana"}}},
 {"op":"add_node","name":"Dana replies","type":"accept_event",
  "spec":{"instruction":"Wait for Dana.","inputs":[],"outputs":[],"effect_class":"pure",
          "deadline":{"at":"2026-08-22T17:00:00.000Z"},
          "match":{"kind":"event","conditions":[{"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","name":"Did Dana keep the slot","type":"decision","spec":{}},
 {"op":"add_node","name":"Dana is out","type":"flow_final","spec":{}},

 {"op":"add_node","name":"Ask Pat to play in goal","type":"action",
  "spec":{"instruction":"Email Pat and ask him to keep Thursday.","inputs":[],
          "outputs":[{"name":"sent","type":"string"}],"effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#pat"}}},
 {"op":"add_node","name":"Pat replies","type":"accept_event",
  "spec":{"instruction":"Wait for Pat.","inputs":[],"outputs":[],"effect_class":"pure",
          "deadline":{"at":"2026-08-22T17:00:00.000Z"},
          "match":{"kind":"event","conditions":[{"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","name":"Did Pat keep the slot","type":"decision","spec":{}},
 {"op":"add_node","name":"Pat is out","type":"flow_final","spec":{}},

 {"op":"add_node","name":"Book the pitch","type":"action",
  "spec":{"instruction":"Hold the 8pm slot at the leisure centre.","inputs":[],
          "outputs":[{"name":"booking","type":"string"}],"effect_class":"reversible"}},

 {"op":"add_node","name":"Either goalie will do","type":"merge","spec":{}},
 {"op":"add_node","name":"Goalie and pitch both in","type":"join","spec":{}},
 {"op":"add_node","name":"Lock the roster","type":"action",
  "spec":{"instruction":"Publish the final roster.","inputs":[],
          "outputs":[{"name":"roster","type":"string"}],"effect_class":"pure"}},
 {"op":"add_node","name":"Thursday is settled","type":"final","spec":{}},
 {"op":"add_node","name":"Both goalie deadlines passed","type":"join","spec":{}},
 {"op":"add_node","name":"Escalate: no goalie found","type":"action",
  "spec":{"instruction":"Tell Ilya no goalie is available and the roster cannot be locked.","inputs":[],
          "outputs":[{"name":"decision","type":"string"}],"effect_class":"pure"}},
 {"op":"add_node","name":"Goalie outcome available","type":"merge","spec":{}},
 {"op":"supersede_node","node":"initial-plan-complete","by":"$0"},

 {"op":"add_edge","from":"confirm-roster-contacts","to":"$0"},
 {"op":"add_edge","from":"$0","to":"$1"},
 {"op":"add_edge","from":"$0","to":"$5"},
 {"op":"add_edge","from":"$0","to":"$9"},
 {"op":"add_edge","from":"$1","to":"$2"},
 {"op":"add_edge","from":"$2","to":"$3"},
 {"op":"add_edge","from":"$3","to":"$10","guard":{"on":"satisfied"}},
 {"op":"add_edge","from":"$3","to":"$4","guard":{"on":"bounced"}},
 {"op":"add_edge","from":"$3","to":"$14","guard":"else"},
 {"op":"add_edge","from":"$5","to":"$6"},
 {"op":"add_edge","from":"$6","to":"$7"},
 {"op":"add_edge","from":"$7","to":"$10","guard":{"on":"satisfied"}},
 {"op":"add_edge","from":"$7","to":"$8","guard":{"on":"bounced"}},
 {"op":"add_edge","from":"$7","to":"$14","guard":"else"},
 {"op":"add_edge","from":"$10","to":"$16"},
 {"op":"add_edge","from":"$14","to":"$15"},
 {"op":"add_edge","from":"$15","to":"$16"},
 {"op":"add_edge","from":"$16","to":"$11"},
 {"op":"add_edge","from":"$9","to":"$11"},
 {"op":"add_edge","from":"$11","to":"$12"},
 {"op":"add_edge","from":"$12","to":"$13"}
]
EOF
commit 2 "Two goalies asked in parallel and the pitch booked alongside. Either goalie will do, so they meet at a merge; the roster needs a goalie AND a pitch, so those meet at a join." MISSING_STEP

# v2 — one arm of the fork is worked. The other two stay on the frontier, which is the whole
# point of a fork: `kona next` offers a SET, not a sequence.
ops <<'EOF'
[{"op":"set_status","node":"book-the-pitch","status":"active","evidence_ref":"local:claim-1"}]
EOF
commit 3 "Taking the pitch booking; it needs no reply from anybody." OTHER

# v3 — the claimed step is stopped MID-WORK and replaced. Superseding a node that is being
# worked writes `terminated`, not `withdrawn`: the two are different facts and the store reads
# which from the state it finds, so an author never chooses between them. Every doc used to
# say this case could not happen — `isDroppable` refuses to touch a claimed node — but that is
# true of the CASCADE only, and supersede reaches one.
#
# It also shows the growth shape D5 exists for: the replacement carries its OWN edges, because
# no op creates an edge you did not write, and the superseded node's edges stop counting the
# moment it is superseded.
ops <<'EOF'
[
 {"op":"add_node","name":"Confirm the pitch in writing","type":"action",
  "spec":{"instruction":"Confirm the leisure-centre booking in its system; a phone hold is not a booking.","inputs":[],
          "outputs":[{"name":"booking","type":"string"}],"effect_class":"reversible"}},
 {"op":"supersede_node","node":"book-the-pitch","by":"$0"},
 {"op":"add_edge","from":"ask-both-goalies-at-once","to":"$0"},
 {"op":"add_edge","from":"$0","to":"goalie-and-pitch-both-in"}
]
EOF
commit 4 "A phone hold is not a booking. Stopping that and confirming in writing instead." CONTRADICTION

ops <<'EOF'
[{"op":"record_output","node":"confirm-the-pitch-in-writing","output_name":"booking","value":"LC-8PM-THU","evidence_ref":"local:booking-LC-8PM-THU"},
 {"op":"set_status","node":"confirm-the-pitch-in-writing","status":"completed","evidence_ref":"local:booking-LC-8PM-THU"}]
EOF
commit 5 "8pm at the leisure centre is confirmed in writing." OTHER

# v7-v8 — Dana's email runs through the outbox: reserve claims it and spends budget, then
# record closes the slot and completes the node.
send_effect "Ask Dana to play in goal" "sha256:dana-invite" "Asking Dana first; she kept goal last week." "m-201" "The mail server accepted Dana's invitation."

# v9 — Dana's deadline passes. Her decision takes its else arm toward the two-timeout join — and
# NOTHING downstream moves, because the merge is disjunctive and Pat is still live. This is
# §6.4's "it stops at a node still held by a live in-edge", which under v1 was a property of
# a `merge` field nothing read.
ops <<'EOF'
[{"op":"record_outcome","node":"dana-replies","verdict":"timed_out","evidence_ref":"deadline:dana"},
 {"op":"set_status","node":"dana-replies","status":"completed","evidence_ref":"deadline:dana"}]
EOF
commit 8 "Dana's deadline passed without a reply. Pat is still out there." DEADLINE_PASSED

# v10-v12 — Pat's arm runs, and goes quiet too. Reserve claims Pat before record completes him.
# Once both deadlines pass, the timeout join releases the escalation action. That live action
# keeps the outcome merge and roster join blocked while a human decides how to recover.
send_effect "Ask Pat to play in goal" "sha256:pat-invite" "Pat is the last goalie in the pool." "m-203" "The mail server accepted Pat's invitation."

ops <<'EOF'
[{"op":"record_outcome","node":"pat-replies","verdict":"timed_out","evidence_ref":"deadline:pat"},
 {"op":"set_status","node":"pat-replies","status":"completed","evidence_ref":"deadline:pat"}]
EOF
commit 11 "Both goalie deadlines passed. Escalation is ready; the roster remains locked." DEADLINE_PASSED

mkdir -p "${ROOT}/fixtures"
# The CLI intentionally uses the wall clock. Fixtures do not: pin each version to a stable
# instant, then project from those exact bytes so the log and graph stay in lockstep.
python3 - <<'PY'
import json
from datetime import datetime, timedelta, timezone

path = ".kona/mutations.jsonl"
epoch = datetime(2026, 8, 29, 4, 12, tzinfo=timezone.utc)
records = []
with open(path) as source:
    for line in source:
        record = json.loads(line)
        stamp = (epoch + timedelta(seconds=record["v"])).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        record["observed_at"] = stamp
        record["occurred_at"] = stamp
        records.append(record)
with open(path, "w") as target:
    for record in records:
        target.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")
PY
cp .kona/mutations.jsonl "${ROOT}/fixtures/${BASENAME}.mutations.jsonl"
${KONA} graph --json > "${ROOT}/fixtures/${BASENAME}.graph.json"
${KONA} graph
echo
echo "wrote fixtures/${BASENAME}.mutations.jsonl and fixtures/${BASENAME}.graph.json"
