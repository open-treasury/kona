#!/usr/bin/env bash
# Pre-flight. Spends NO model tokens and needs no API key — run it before the day you
# intend to measure anything, because the scarce resource is run slots, not money.
#
#   1. install Harbor into eval/.venv
#   2. compile the kona binaries
#   3. check the skill has not drifted from the shipped plugin
#   4. apply the seed the container applies, to a throwaway store, and see it accepted
#   5. pull the six task images and prove the Kona layer installs in them (--install-only)
#
# Step 5 is the one that matters: --install-only runs agent setup and exits without ever
# calling the model, so it exercises the binary upload, `kona init`, the identity config
# and the skill directory for real, at zero cost.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

banner "1/5  Harbor"
if [[ ! -x "${HARBOR}" ]]; then
  uv venv "${VENV}" --python 3.13
  uv pip install --python "${VENV}/bin/python" harbor
fi
"${HARBOR}" --version || true

banner "2/5  kona binaries"
"${EVAL_ROOT}/bin/build-kona.sh"

banner "3/5  skill provenance"
bun "${EVAL_ROOT}/gen/check-drift.ts"

banner "4/5  the seed the container applies"
# eval/skills/kona/seed.json is committed into the Kona container and applied there with
# `kona mutate --ops`. kona_agent.py raises on a non-zero exit, and a raise inside setup()
# makes an ERRORED trial rather than a failed one — so a seed the store refuses does not
# weaken the Kona arm, it VOIDS it. Every trial errors, and the run measures nothing while
# being billed for all of it. That is the README's headline invocation, which passes
# `KONA_SEED=1` and is capped at two hours.
#
# Nothing type-checks that file. It is hand-authored JSON standing against a vocabulary the
# store keeps moving — node types, statuses, op names, the keys inside `spec` — and when the
# two drift apart nothing says so until a container reads it.
#
# So apply it, for real, rather than eyeballing the JSON: a throwaway `kona init` in a temp
# dir and the same `mutate --ops` the agent runs. `packages/kona/src/bin.ts` is the exact
# entry point `bin/build-kona.sh` compiles, so "accepted here" and "accepted by the binary
# inside the container" are one statement rather than two.
#
# Step 5 will not catch it. `KONA_SEED` is off unless the operator exports it, so
# --install-only can install a flawless layer without ever reading the seed; and on the runs
# where it IS exported, the seed is reached at the far end of the image build. This step runs
# unconditionally because the file is committed either way, and here it costs seconds with
# somebody watching.
seed_file="${EVAL_ROOT}/skills/kona/seed.json"
seed_dir="$(mktemp -d)"
trap 'rm -rf "${seed_dir}"' EXIT

# The CLI finds `.kona/` by walking up from cwd, the way git finds `.git`, so every call has
# to stand inside the throwaway pursuit.
kona_seed() { ( cd "${seed_dir}" && bun "${REPO_ROOT}/packages/kona/src/bin.ts" "$@" ); }

# Same `--config` and `--prefix` as kona_agent.py's init: identity is fixed at init and can
# never be added later, so a seed that only commits against a pursuit with no identity would
# be a different experiment from the one the container runs.
if ! kona_seed init --config "${EVAL_ROOT}/skills/kona/config.json" --prefix kn >/dev/null; then
  echo "REFUSED SEED_INIT  kona init failed in an empty temp dir — the store itself is broken," >&2
  echo "  so read that refusal before reading anything about the seed." >&2
  exit 1
fi

# stderr is deliberately not swallowed: the store's own REFUSED line names the op and the
# reason, and it is more useful than anything this script could say about it.
if ! kona_seed mutate --ops "${seed_file}" --base-version 0 \
  --reason-code MISSING_STEP \
  --why 'Pre-flight: does the store still accept the committed seed?'; then
  cat >&2 <<EOF

REFUSED BAD_SEED  ${seed_file}

The store refused the seed — the line above names which op and why. In a run that same
refusal is a RuntimeError inside KonaTerminus.setup(), which errors every Kona trial.

Fix the seed against the current vocabulary — packages/core/src/vocab.ts is the list of
every node type, status and op the store accepts. Dropping KONA_SEED also gets you a run,
but an unseeded one is a different arm from the seeded one, not a workaround for this.
EOF
  exit 1
fi

# A seed that commits and leaves nothing ready is this file's failure mode wearing a green
# exit code: the agent would meet the blank page the seed exists to remove, and the run would
# read as honest zero adoption. `next` is the frontier, so assert it is not empty.
if ! kona_seed next --json | bun -e '
  const frontier = JSON.parse(await Bun.stdin.text());
  const ready = frontier.nodes.length;
  console.log("  seed committed at v" + frontier.version + " · " + ready + " ready");
  process.exit(ready > 0 ? 0 : 1);
'; then
  cat >&2 <<EOF
REFUSED EMPTY_FRONTIER  ${seed_file}

It committed, and left nothing for the agent to pick up. A seed whose every node is blocked
starts the Kona arm at the same blank page as the baseline.
EOF
  exit 1
fi

banner "5/5  image build + Kona layer install (no tokens spent)"
cd "${REPO_ROOT}"
# shellcheck disable=SC2046
"${HARBOR}" run \
  -d "${DATASET}" \
  $(include_flags) \
  -a "${AGENT_KONA}" \
  -m "${MODEL}" \
  --install-only \
  -n "${N_CONCURRENT}" \
  -o "${JOBS_DIR}" \
  --job-name preflight \
  --artifact /.kona/mutations.jsonl \
  -y

# Verify against the job result, not against downloaded artifacts.
#
# `--install-only` skips the agent run, and `--artifact` collection happens inside that run —
# so no artifact ever comes back here, and an earlier version of this check failed on a
# working layer. What IS meaningful: Trial._prepare() calls the agent's setup(), and any
# exception it raises is recorded to the trial's exception_info. `_install_kona` runs
# `kona next`, `kona graph --json` and a line count over /.kona/mutations.jsonl, and raises
# on any of them — so "0 errored trials" is a real assertion that the layer works inside a
# real task container, not merely that nothing threw.
#
# Harbor exits 0 with zero trials, so this must be asserted explicitly.
banner "verifying the Kona layer installed in every container"
"${VENV}/bin/python" - "${JOBS_DIR}/preflight/result.json" "$(tasks | wc -l | tr -d ' ')" <<'PY'
import json, sys

result_path, expected = sys.argv[1], int(sys.argv[2])
stats = json.load(open(result_path))["stats"]
done, errored = stats["n_completed_trials"], stats["n_errored_trials"]

print(f"  trials completed {done}/{expected} · errored {errored}")
if errored or done != expected:
    print(
        "REFUSED KONA_LAYER  the Kona arm did not install cleanly in every container.\n"
        "Read the per-trial exception_info under the job dir before spending a run slot.",
        file=sys.stderr,
    )
    raise SystemExit(1)
print("  kona binary, identity config and .kona/ verified inside each task container")
PY

banner "pre-flight done"
cat <<'EOF'
If step 5 was green, tomorrow is: export DEEPSEEK_API_KEY, then

    eval/run/01-probe.sh     ~10 min, ~$0.30 — measures the real cost per run
    eval/run/02-ab.sh        ~70 min       — the paired A/B

Do NOT skip 01. The per-run cost estimate spans $0.5-$1.7 depending on whether prompt
caching engages, and that is the difference between this iteration costing $6 and $20.
EOF
