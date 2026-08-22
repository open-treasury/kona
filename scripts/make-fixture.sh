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

ops() { cat > ops.json; }
commit() { ${KONA} mutate --ops ops.json --base-version "$1" --why "$2" --reason-code "$3" "${@:4}" >/dev/null; }

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
${KONA} init --actor-id ilya --config config.json >/dev/null

# v1 — READ THE ROSTER, and nothing else. Invariant 3(b) rejects "a recipient existing only
# in the proposing batch", so nothing may email Dana until a COMMITTED record names her.
# This pursuit used to decide to read the roster and email Dana in the same breath.
ops <<'EOF'
[
 {"op":"add_node","label":"Confirm roster availability","type":"task","scope":"setup",
  "spec":{"instruction":"Read the roster and list who has not yet answered.",
          "outputs":[{"name":"availability","type":"string[]"}],"effect_class":"pure"}},
 {"op":"add_node","label":"Escalate: no goalie found","type":"task","scope":"setup",
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
 {"op":"add_node","label":"Ask Dana to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Dana asking if she can play in goal Thursday.",
          "inputs":[{"ref":"confirm-roster-availability.availability"}],
          "outputs":[{"name":"sent_message_id","type":"string"}],
          "effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#dana"}}},
 {"op":"add_node","label":"Wait for Dana","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Dana's reply.","effect_class":"pure",
          "deadline":{"after":"$0","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","label":"Ask Sam to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Sam asking if he can play in goal Thursday.",
          "outputs":[{"name":"sent_message_id","type":"string"}],"effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#sam"}}},
 {"op":"add_node","label":"Wait for Sam","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Sam's reply.","effect_class":"pure",
          "deadline":{"after":"$2","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","label":"Ask Priya to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Priya asking if she can play in goal Thursday.",
          "outputs":[{"name":"sent_message_id","type":"string"}],"effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#priya"}}},
 {"op":"add_node","label":"Wait for Priya","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Priya's reply.","effect_class":"pure",
          "deadline":{"after":"$4","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_node","label":"Goalie confirmed","type":"wait","scope":"setup",
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

# v3 — the sends go out. One is mid-flight when we look.
ops <<'EOF'
[
 {"op":"set_status","node":"ask-dana-to-play-in-goal","status":"done","evidence_ref":"<m-101@mail>"},
 {"op":"record_output","node":"ask-dana-to-play-in-goal","output_name":"sent_message_id",
  "value":"<m-101@mail>","evidence_ref":"<m-101@mail>"},
 {"op":"set_status","node":"ask-sam-to-play-in-goal","status":"done","evidence_ref":"<m-102@mail>"},
 {"op":"record_output","node":"ask-sam-to-play-in-goal","output_name":"sent_message_id",
  "value":"<m-102@mail>","evidence_ref":"<m-102@mail>"},
 {"op":"set_status","node":"ask-priya-to-play-in-goal","status":"sending","evidence_ref":"ek_priya_v2"}
]
EOF
commit 2 "Dana and Sam dispatched; Priya's send is reserved and in flight." OTHER

# v4 — Dana declines. Her arm is dropped; the merge survives on the live arms.
ops <<'EOF'
[
 {"op":"record_outcome","node":"wait-for-dana","verdict":"declined","evidence_ref":"<m-201@mail>",
  "attrs":{"role":"goalie","reason":"away that week"}},
 {"op":"set_status","node":"wait-for-dana","status":"done","evidence_ref":"<m-201@mail>"}
]
EOF
commit 3 "Dana is away that week. Her arm cannot satisfy the quorum." COUNTERPARTY_DECLINED

# v5 — Sam refers Marcus, who is not on the roster. The graph grows a node no v1 shape describes.
ops <<'EOF'
[
 {"op":"record_outcome","node":"wait-for-sam","verdict":"declined","evidence_ref":"<m-202@mail>",
  "attrs":{"role":"goalie","referral":"marcus"}},
 {"op":"set_status","node":"wait-for-sam","status":"done","evidence_ref":"<m-202@mail>"},
 {"op":"add_node","label":"Check Marcus is eligible","type":"task","scope":"marcus",
  "spec":{"instruction":"Marcus is not on the roster. Confirm he is eligible before contacting him.",
          "outputs":[{"name":"eligible","type":"boolean"}],"effect_class":"pure"}},
 {"op":"add_node","label":"Wait for eligibility ruling","type":"wait","scope":"marcus",
  "spec":{"instruction":"A human must rule on an unrostered player.","effect_class":"pure",
          "deadline":{"at":"2026-08-21T12:00:00.000Z"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"human","conditions":[
            {"kind":"decision","on":"accept"},{"kind":"decision","on":"ignore"}]}}},
 {"op":"add_edge","from":"$2","to":"$3"},
 {"op":"add_edge","from":"$3","to":"goalie-confirmed","condition":{"on":"accept"}}
]
EOF
commit 4 "Sam cannot play but referred Marcus, who is not on the roster; eligibility needs a human." NEW_CONSTRAINT

# v6 — the roster step is superseded by a better one, and the old node is kept, not deleted.
ops <<'EOF'
[
 {"op":"add_node","label":"Confirm roster availability and eligibility","type":"task","scope":"setup",
  "spec":{"instruction":"Read the roster, list non-responders, and flag anyone unrostered.",
          "outputs":[{"name":"availability","type":"string[]"}],"effect_class":"pure"}},
 {"op":"supersede_node","node":"confirm-roster-availability","by":"$0"}
]
EOF
commit 5 "The roster step missed eligibility, which is what let an unrostered referral through." MISSING_STEP

# v7 — Priya's address bounced. The send failed, so the wait behind it is pointless:
# superseding a still-live node drops it, and the store does that housekeeping itself.
ops <<'EOF'
[
 {"op":"set_status","node":"ask-priya-to-play-in-goal","status":"failed","evidence_ref":"<bounce-550@mail>"},
 {"op":"record_outcome","node":"wait-for-priya","verdict":"bounced","evidence_ref":"<bounce-550@mail>",
  "attrs":{"role":"goalie","smtp":"550 5.1.1 user unknown"}},
 {"op":"supersede_node","node":"wait-for-priya"},
 {"op":"add_node","label":"Ask Pat to play in goal","type":"task","scope":"goalies",
  "spec":{"instruction":"Email Pat asking if he can play in goal Thursday.",
          "outputs":[{"name":"sent_message_id","type":"string"}],"effect_class":"pivot",
          "effect":{"channel":"email","recipient_ref":"roster.contacts#pat"}}},
 {"op":"add_node","label":"Wait for Pat","type":"wait","scope":"goalies",
  "spec":{"instruction":"Await Pat's reply. Pat is often silent; the deadline is the plan.",
          "effect_class":"pure",
          "deadline":{"after":"$3","duration":"48h"},"on_timeout":"escalate-no-goalie-found",
          "match":{"kind":"event","conditions":[
            {"kind":"reply","on":"satisfied"},{"kind":"deadline","on":"timeout"}]}}},
 {"op":"add_edge","from":"$3","to":"$4"},
 {"op":"add_edge","from":"$4","to":"goalie-confirmed","condition":{"on":"satisfied"}}
]
EOF
commit 6 "Priya bounced with 550, so the pool is down to Marcus pending a ruling; ask Pat too." CONTRADICTION

# v8 — Pat's invite goes through the OUTBOX rather than a hand-set status, so the fixture
# carries a real open reservation: fsynced, sent-or-not-unknown, awaiting an answer.
# This is the state §6.6 exists for, and a hand-written `sending` with an empty
# effect_log would be a state the CLI can never actually produce.
${KONA} effect reserve ask-pat-to-play-in-goal \
  --payload-hash "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0" \
  --why "Pat is the last untried goalie and the deadline is Thursday" >/dev/null

mkdir -p "${ROOT}/fixtures"
cp .kona/mutations.jsonl "${ROOT}/fixtures/thursday.mutations.jsonl"
${KONA} graph --json > "${ROOT}/fixtures/thursday.graph.json"
${KONA} graph
echo
echo "wrote fixtures/thursday.mutations.jsonl and fixtures/thursday.graph.json"
