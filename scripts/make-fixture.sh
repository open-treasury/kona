#!/usr/bin/env bash
# Build the handoff fixture: a realistic multi-version pursuit, produced by the real
# binary so it cannot drift from what the CLI actually emits.
#
# Regenerate with:  ./scripts/make-fixture.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KONA="bun ${ROOT}/packages/kona/src/bin.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cd "${WORK}"

# Ids are hashes, so a batch cannot name a node from an EARLIER commit by guessing its id the
# way a slug once let you. `$N` still covers references inside one batch; across batches the
# id has to be read back out of the graph. This script keeps writing the readable name and
# resolves it here, which is exactly what an agent does with `kona graph --json` — the only
# difference is that the agent reads the id instead of predicting it.
resolve() {
  ${KONA} graph --json > graph.json 2>/dev/null || { cat > ops.resolved.json; return; }
  python3 - "$1" <<'PY'
import json, re, sys

graph = json.load(open("graph.json"))
def slug(label):
    s = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:48].rstrip("-")
    return s or "node"

by_slug = {slug(n["name"]): n["id"] for n in graph.get("nodes", [])}
ids = {n["id"] for n in graph.get("nodes", [])}

def fix(value):
    if not isinstance(value, str) or value.startswith("$") or value in ids:
        return value
    head, dot, tail = value.partition(".")
    if dot and head in by_slug:
        return by_slug[head] + dot + tail
    return by_slug.get(value, value)

def walk(node):
    if isinstance(node, dict):
        return {k: (fix(v) if k in ("node", "from", "to", "by", "on_timeout", "compensates", "ref", "after") else walk(v)) for k, v in node.items()}
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

# §6.6's outbox, as two shell verbs. Every send here is three commits — reserve, (the bytes),
# record — because that is the only order that survives a crash: append and fsync the intent
# BEFORE anything leaves, so a machine that dies mid-send leaves a slot a human can be shown.
# The fixture used to hand-write `set_status done` instead, which produced a log the CLI
# itself could never emit.
nodeid() { ${KONA} graph --json | python3 -c "'''resolve one label-slug to its id'''
import json,re,sys
g=json.load(sys.stdin)
s=lambda l:(re.sub(r'[^a-z0-9]+','-',l.lower()).strip('-')[:48].rstrip('-') or 'node')
print(next((n['id'] for n in g['nodes'] if s(n['name'])==sys.argv[1]), sys.argv[1]))" "$1"; }

reserve() {
  ${KONA} effect reserve "$(nodeid "$1")" --payload-hash "$2" --why "$3" --json \
    | sed -n 's/.*"effect_key":"\([^"]*\)".*/\1/p'
}
record() { ${KONA} effect record "$(nodeid "$1")" --key "$2" --outcome "$3" --message-id "$4" --why "$5" >/dev/null; }

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
# `--prefix` is required: every node id opens with it, and it is fixed for the life of the
# pursuit. `th` for thursday, so the fixture's ids read as this fixture's ids.
${KONA} init --actor-id ilya --config config.json --prefix th >/dev/null

# v1 — READ THE ROSTER, and nothing else. Invariant 3(b) rejects "a recipient existing only
# in the proposing batch", so nothing may email Dana until a COMMITTED record names her.
# This pursuit used to decide to read the roster and email Dana in the same breath.
ops <<'EOF'
[
 {"op":"add_node","name":"Confirm roster availability","type":"task","scope":"setup",
  "spec":{"instruction":"Read the roster and list who has not yet answered.",
          "outputs":[{"name":"availability","type":"string[]"}],"effect_class":"pure"}},
 {"op":"add_node","name":"Escalate: no goalie found","type":"task","scope":"setup",
  "spec":{"instruction":"Tell Ilya no goalie was found and the game needs a decision.",
          "outputs":[{"name":"escalated","type":"boolean"}],"effect_class":"pure"}},
 {"op":"record_output","node":"$0","output_name":"availability",
  "value":["dana","sam","priya","pat"],"evidence_ref":"roster.csv#v3"},
 {"op":"set_status","node":"$0","status":"done","evidence_ref":"roster.csv#v3"}
]
EOF
commit 0 "Read the roster before contacting anyone on it." MISSING_STEP

# v2 — the approved plan: everyone the roster named, asked at once, merging on a predicate.
ops <<'EOF'
[
 {"op":"add_node","name":"Ask Dana to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Dana asking if she can play in goal Thursday.",
          "inputs":[{"ref":"confirm-roster-availability.availability"}],
          "effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#dana"}}},
 {"op":"add_node","name":"Wait for Dana","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Dana's reply.","effect_class":"pure",
          "deadline":{"after":"$0","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","name":"Ask Sam to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Sam asking if he can play in goal Thursday.",
          "effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#sam"}}},
 {"op":"add_node","name":"Wait for Sam","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Sam's reply.","effect_class":"pure",
          "deadline":{"after":"$2","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","name":"Ask Priya to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Priya asking if she can play in goal Thursday.",
          "effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#priya"}}},
 {"op":"add_node","name":"Wait for Priya","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Priya's reply.","effect_class":"pure",
          "deadline":{"after":"$4","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","name":"Goalie confirmed","type":"wait","scope":"setup",
  "spec":{"instruction":"At least one goalie has confirmed.","effect_class":"pure",
          "deadline":{"at":"2026-08-21T17:00:00.000Z"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"predicate","conditions":[{"kind":"predicate","on":"satisfied",
            "predicate":{"count":{"verdict":"confirmed","attrs":{"role":"goalie"}},"op":">=","n":1}}]}}},
 {"op":"add_edge","from":"confirm-roster-availability","to":"$0"},
 {"op":"add_edge","from":"$0","to":"$1"},
 {"op":"add_edge","from":"$2","to":"$3"},
 {"op":"add_edge","from":"$4","to":"$5"},
 {"op":"add_edge","from":"$1","to":"$6","condition":{"on":"satisfied"}},
 {"op":"add_edge","from":"$3","to":"$6","condition":{"on":"satisfied"}},
 {"op":"add_edge","from":"$5","to":"$6","condition":{"on":"satisfied"}}
]
EOF
commit 1 "The roster named four; ask all three goalies in parallel rather than serially." NEW_CONSTRAINT

# v3..v7 — the sends go out. Dana's and Sam's complete; Priya's stops after the reservation
# and stays open for four versions, which is CRASH WINDOW 2: a `sending` node whose slot is
# fsynced, with nothing on disk able to say whether the bytes moved.
DANA_KEY="$(reserve ask-dana-to-play-in-goal sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a "Dana is the only goalie the roster names")"
record ask-dana-to-play-in-goal "${DANA_KEY}" sent "<m-101@mail>" "the mail server accepted it"
SAM_KEY="$(reserve ask-sam-to-play-in-goal sha256:2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b "Sam has kept goal before and the roster names him")"
record ask-sam-to-play-in-goal "${SAM_KEY}" sent "<m-102@mail>" "the mail server accepted it"
PRIYA_KEY="$(reserve ask-priya-to-play-in-goal sha256:3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c "Priya is the third name on the roster")"

# v8 — Dana declines. Her arm is dropped; the merge survives on the live arms.
ops <<'EOF'
[
 {"op":"record_outcome","node":"wait-for-dana","verdict":"declined","evidence_ref":"<m-201@mail>",
  "attrs":{"role":"goalie","reason":"away that week"}},
 {"op":"set_status","node":"wait-for-dana","status":"done","evidence_ref":"<m-201@mail>"}
]
EOF
commit 7 "Dana is away that week. Her arm cannot satisfy the quorum." COUNTERPARTY_DECLINED

# v9 — Sam refers Marcus, who is not on the roster. The graph grows a node no v1 shape describes.
ops <<'EOF'
[
 {"op":"record_outcome","node":"wait-for-sam","verdict":"declined","evidence_ref":"<m-202@mail>",
  "attrs":{"role":"goalie","referral":"marcus"}},
 {"op":"set_status","node":"wait-for-sam","status":"done","evidence_ref":"<m-202@mail>"},
 {"op":"add_node","name":"Check Marcus is eligible","type":"task","scope":"marcus",
  "spec":{"instruction":"Marcus is not on the roster. Confirm he is eligible before contacting him.",
          "outputs":[{"name":"eligible","type":"boolean"}],"effect_class":"pure"}},
 {"op":"add_node","name":"Wait for eligibility ruling","type":"wait","scope":"marcus",
  "spec":{"instruction":"A human must rule on an unrostered player.","effect_class":"pure",
          "deadline":{"at":"2026-08-21T12:00:00.000Z"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"human","conditions":[
            {"kind":"decision","on":"accept"},{"kind":"decision","on":"ignore"}]}}},
 {"op":"add_edge","from":"$2","to":"$3"},
 {"op":"add_edge","from":"$3","to":"goalie-confirmed","condition":{"on":"accept"}}
]
EOF
commit 8 "Sam cannot play but referred Marcus, who is not on the roster; eligibility needs a human." NEW_CONSTRAINT

# v10 — the roster step is superseded by a better one, and the old node is kept, not deleted.
ops <<'EOF'
[
 {"op":"add_node","name":"Confirm roster availability and eligibility","type":"task","scope":"setup",
  "spec":{"instruction":"Read the roster, list non-responders, and flag anyone unrostered.",
          "outputs":[{"name":"availability","type":"string[]"}],"effect_class":"pure"}},
 {"op":"supersede_node","node":"confirm-roster-availability","by":"$0"}
]
EOF
commit 9 "The roster step missed eligibility, which is what let an unrostered referral through." MISSING_STEP

# v11 — Priya's address bounced. The reservation opened at v7 is CLOSED by the outbox rather
# than by a hand-written status: what makes the slot unspendable again is the store closing
# the slot it issued.
record ask-priya-to-play-in-goal "${PRIYA_KEY}" failed "<bounce-550@mail>" "the address is dead: 550 5.1.1 user unknown"

# v12 — the send failed, so the wait behind it is pointless: superseding a still-live node
# drops it, and the store does that housekeeping itself.
ops <<'EOF'
[
 {"op":"record_outcome","node":"wait-for-priya","verdict":"bounced","evidence_ref":"<bounce-550@mail>",
  "attrs":{"role":"goalie","smtp":"550 5.1.1 user unknown"}},
 {"op":"supersede_node","node":"wait-for-priya"},
 {"op":"add_node","name":"Ask Pat to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Pat asking if he can play in goal Thursday.",
          "effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#pat"}}},
 {"op":"add_node","name":"Wait for Pat","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Pat's reply. Pat is often silent; the deadline is the plan.",
          "effect_class":"pure",
          "deadline":{"after":"$2","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_edge","from":"$2","to":"$3"},
 {"op":"add_edge","from":"$3","to":"goalie-confirmed","condition":{"on":"satisfied"}}
]
EOF
commit 11 "Priya bounced with 550, so the pool is down to Marcus pending a ruling; ask Pat too." CONTRADICTION

# v13 — and the fixture ENDS on an open reservation, deliberately. A handoff artefact whose
# every node is settled teaches nothing about the state that actually costs you sleep: Pat's
# slot is fsynced, the bytes may or may not have moved, and the honest answer is a human.
reserve ask-pat-to-play-in-goal \
  "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0" \
  "Pat is the last untried goalie and the deadline is Thursday" >/dev/null

mkdir -p "${ROOT}/fixtures"
cp .kona/mutations.jsonl "${ROOT}/fixtures/thursday.mutations.jsonl"
${KONA} graph --json > "${ROOT}/fixtures/thursday.graph.json"
${KONA} graph
echo
echo "wrote fixtures/thursday.mutations.jsonl and fixtures/thursday.graph.json"
