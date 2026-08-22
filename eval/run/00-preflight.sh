#!/usr/bin/env bash
# Pre-flight. Spends NO model tokens and needs no API key — run it before the day you
# intend to measure anything, because the scarce resource is run slots, not money.
#
#   1. install Harbor into eval/.venv
#   2. compile the kona binaries
#   3. check the skill has not drifted from the shipped plugin
#   4. pull the six task images and prove the Kona layer installs in them (--install-only)
#
# Step 4 is the one that matters: --install-only runs agent setup and exits without ever
# calling the model, so it exercises the binary upload, `kona init`, the identity config
# and the skill directory for real, at zero cost.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

banner "1/4  Harbor"
if [[ ! -x "${HARBOR}" ]]; then
  uv venv "${VENV}" --python 3.13
  uv pip install --python "${VENV}/bin/python" harbor
fi
"${HARBOR}" --version || true

banner "2/4  kona binaries"
"${EVAL_ROOT}/bin/build-kona.sh"

banner "3/4  skill provenance"
bun "${EVAL_ROOT}/gen/check-drift.ts"

banner "4/4  image build + Kona layer install (no tokens spent)"
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
If step 4 was green, tomorrow is: export DEEPSEEK_API_KEY, then

    eval/run/01-probe.sh     ~10 min, ~$0.30 — measures the real cost per run
    eval/run/02-ab.sh        ~70 min       — the paired A/B

Do NOT skip 01. The per-run cost estimate spans $0.5-$1.7 depending on whether prompt
caching engages, and that is the difference between this iteration costing $6 and $20.
EOF
