#!/usr/bin/env bash
# The paired A/B. Six tasks, two arms, ~70 minutes, one attempt each.
#
# --agent-timeout-multiplier is 1.0 and stays 1.0: every task in tasks.txt has a native
# budget of <= 60 minutes, so each runs exactly as its author intended. That is the whole
# reason for the task selection, and changing the multiplier throws it away.
#
# Both arms launch as separate jobs, because Harbor binds a job to one agent. It is still a
# paired design: same tasks, same model, same conditions, compared task-by-task in
# eval/analyze/paired.ts. They run concurrently, so the wall-clock is one 70-minute window.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_key; require_harbor; require_binaries

STAMP="$(date +%Y%m%d-%H%M%S)"

cd "${REPO_ROOT}"
for arm in baseline kona; do
  case "${arm}" in
    baseline) agent="${AGENT_BASELINE}" ;;
    kona)     agent="${AGENT_KONA}" ;;
  esac
  banner "arm: ${arm}  (${agent})"
  # shellcheck disable=SC2046
  "${HARBOR}" run \
    -d "${DATASET}" \
    $(include_flags) \
    -a "${agent}" \
    -m "${MODEL}" \
    $(env_file_flag) \
    -k 1 \
    -n "${N_CONCURRENT}" \
    --agent-timeout-multiplier "${MULT:-1.0}" \
    -o "${JOBS_DIR}" \
    --job-name "ab-${STAMP}-${arm}" \
    --artifact /.kona/mutations.jsonl \
    -y &
done

wait

banner "results"
bun "${EVAL_ROOT}/analyze/paired.ts" "${JOBS_DIR}" --job-prefix "ab-${STAMP}"

# T2, and free: it re-reads the trajectories the run just wrote. At six tasks the reward
# delta is a weak signal; redo rate draws on hundreds of actions per run, so it is the
# less noisy of the two and may be the more useful output.
banner "mechanism"
bun "${EVAL_ROOT}/analyze/trajectory.ts" "${JOBS_DIR}" --job-prefix "ab-${STAMP}" || true
