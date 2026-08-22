#!/usr/bin/env bash
# The cost probe. One task, both arms, a third of its budget: ~10-15 minutes and ~$0.30.
#
# Why this exists: the per-run cost estimate spans $0.5 to $1.7 depending entirely on
# whether prompt caching engages, and that decides whether the real iteration costs $6 or
# $20. Nobody should guess it. This measures tokens, cache-hit ratio and cost_usd for real,
# and eval/analyze/paired.ts then extrapolates the exact price of the six-task run.
#
# It also proves the whole chain end to end — model auth, both agents, the kona layer,
# the verifier — before a full slot is spent on it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_key; require_harbor; require_binaries

JOB_SUFFIX="${JOB_SUFFIX:-}"
# PROBE_TASK names the single task. TASKS is the A/B's variable, but people (me, twice) reach
# for it here too — so honour its first entry rather than silently probing the default and
# quietly running the wrong experiment for an hour.
PROBE_TASK="${PROBE_TASK:-${TASKS%% *}}"
PROBE_TASK="${PROBE_TASK:-bun-sourcemap-leak}"   # shortest native budget in the set: 30m
MULT="${MULT:-0.34}"                              # 30m -> ~10m

# ARMS lets a probe run one side only. For an ADOPTION question the baseline arm carries no
# information — it has no skill to adopt — so `ARMS=kona` halves the cost of asking it.
cd "${REPO_ROOT}"
for arm in ${ARMS:-baseline kona}; do
  case "${arm}" in
    baseline) agent="${AGENT_BASELINE}" ;;
    kona)     agent="${AGENT_KONA}" ;;
  esac
  banner "probe: ${arm}"
  "${HARBOR}" run \
    -d "${DATASET}" \
    -i "$(qualify "${PROBE_TASK}")" \
    -a "${agent}" \
    -m "${MODEL}" \
    $(env_file_flag) \
    -k 1 \
    -n 2 \
    --agent-timeout-multiplier "${MULT}" \
    -o "${JOBS_DIR}" \
    --job-name "probe-${arm}${JOB_SUFFIX:+-${JOB_SUFFIX}}" \
    --artifact /.kona/mutations.jsonl \
    -y
done

banner "probe results"
bun "${EVAL_ROOT}/analyze/paired.ts" "${JOBS_DIR}" --probe
