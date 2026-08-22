#!/usr/bin/env bash
# Shared settings for every run script. Source, do not execute.
set -euo pipefail

EVAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${EVAL_ROOT}/.." && pwd)"
VENV="${EVAL_ROOT}/.venv"
HARBOR="${VENV}/bin/harbor"
JOBS_DIR="${EVAL_ROOT}/jobs"

# `-a eval.harbor.kona_agent:KonaTerminus` is imported by Harbor's console script, which does
# not put the working directory on sys.path. Without this the Kona arm fails at resolve time —
# after the images have built, which is the expensive place to find out.
export PYTHONPATH="${REPO_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"

DATASET="${DATASET:-terminal-bench/terminal-bench@latest}"

# LiteLLM provider-prefixed name. Override if DeepSeek's id differs from this:
#   MODEL=deepseek/deepseek-chat eval/run/02-ab.sh
MODEL="${MODEL:-deepseek/deepseek-v4-flash}"

# Both arms. The ONLY difference is the agent class: KonaTerminus is Terminus2 plus the
# kona binary, an initialised .kona/ at /, and one SKILL.md. Same model, same prompt
# template, same parser, same loop.
AGENT_BASELINE="${AGENT_BASELINE:-eval.harbor.kona_agent:BaselineTerminus}"
AGENT_KONA="eval.harbor.kona_agent:KonaTerminus"

# 6 tasks x 2 arms = 12 trials. Set from your VM: each concurrent trial needs its task's
# declared memory (2-4 GB here) plus headroom.
N_CONCURRENT="${N_CONCURRENT:-12}"

# Harbor filters with fnmatch against PackageTaskId.get_name(), which is "org/name" for a
# registry dataset — so a bare `-i bun-sourcemap-leak` matches NOTHING and the job aborts
# with "No tasks matched the filter(s)". Qualify every pattern with the dataset's org.
TASK_ORG="${TASK_ORG:-${DATASET%%/*}}"

tasks() {
  # TASKS overrides the registered set — for PILOT runs on a small machine only. A subset is
  # not the pre-registered experiment (docs/eval.md §10 pins six tasks and a >=5-of-6 bar), so
  # a pilot proves the rig works and cannot produce the finding. Keep the two apart.
  if [[ -n "${TASKS:-}" ]]; then
    printf '%s\n' ${TASKS}
    return
  fi
  # Task names from tasks.txt, ignoring comments and inline annotations.
  sed 's/#.*//' "${EVAL_ROOT}/harbor/tasks.txt" | awk 'NF {print $1}'
}

qualify() { printf '%s/%s' "${TASK_ORG}" "$1"; }

include_flags() {
  local t
  for t in $(tasks); do printf -- '-i %s ' "$(qualify "${t}")"; done
}

# The key lives in eval/.env, which .gitignore ignores. Keeping it in a file rather than an
# exported variable means it survives between commands and never has to be typed anywhere it
# would be recorded.
ENV_FILE="${ENV_FILE:-${EVAL_ROOT}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

env_file_flag() {
  [[ -f "${ENV_FILE}" ]] && printf -- '--env-file %s ' "${ENV_FILE}"
}

require_key() {
  # Which key is needed depends on the model's LiteLLM provider prefix.
  local needed="DEEPSEEK_API_KEY"
  case "${MODEL}" in
    anthropic/*) needed="ANTHROPIC_API_KEY" ;;
    openai/*)    needed="OPENAI_API_KEY" ;;
  esac
  if [[ -z "${!needed:-}" ]]; then
    echo "REFUSED NO_KEY  ${MODEL} needs ${needed} in ${ENV_FILE}" >&2
    exit 1
  fi
  if [[ -z "${DEEPSEEK_API_KEY:-}" && "${needed}" == "DEEPSEEK_API_KEY" ]]; then
    cat >&2 <<EOF
REFUSED NO_KEY

Create ${ENV_FILE} containing:

    DEEPSEEK_API_KEY=sk-...

It is gitignored. Write it from your own terminal rather than pasting the key into
anything that keeps a transcript.
EOF
    exit 1
  fi
}

# A stale binary is worse than a missing one: the container gets an old store with the current
# skill, and the mismatch shows up as the agent's claims being refused mid-run. That happened —
# `in_flight` shipped in the skill while the container still held a binary that only knew
# `sending` — and it cost a two-hour Sonnet A/B that was testing a product nobody was running.
#
# So the check is freshness, not existence: rebuild whenever anything the binary is compiled
# from, or anything uploaded beside it, is newer than the binary.
require_binaries() {
  local bin="${EVAL_ROOT}/dist/kona-linux-x64"
  if [[ ! -f "${bin}" ]]; then
    echo "REFUSED NO_BINARY  run eval/bin/build-kona.sh first" >&2
    exit 1
  fi
  local newer
  newer="$(find "${REPO_ROOT}/packages" "${EVAL_ROOT}/skills" \
    -name '*.ts' -o -name '*.md' -o -name '*.json' 2>/dev/null \
    | while read -r f; do [[ "${f}" -nt "${bin}" ]] && echo "${f}"; done | head -3)"
  if [[ -n "${newer}" ]]; then
    echo "REFUSED STALE_BINARY  eval/dist/kona-linux-x64 is older than:" >&2
    echo "${newer}" | sed 's/^/    /' >&2
    echo "  The container would run an old store with the current skill. Rebuild:" >&2
    echo "    eval/bin/build-kona.sh" >&2
    exit 1
  fi
}

require_harbor() {
  if [[ ! -x "${HARBOR}" ]]; then
    echo "REFUSED NO_HARBOR  run eval/run/00-preflight.sh first" >&2
    exit 1
  fi
}

banner() { printf '\n=== %s ===\n' "$*"; }
