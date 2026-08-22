#!/usr/bin/env bash
# Copy a running trial's pursuit log out of its container so you can open it in the viewer.
#
# The log is the whole pursuit — `.kona/mutations.jsonl` is the system of record and the graph
# is a fold over it — so copying that one file out is enough to reconstruct every version
# locally. Nothing else needs to come with it.
#
#   eval/bin/pull-pursuit.sh              # copy once into eval/report/live/
#   eval/bin/pull-pursuit.sh --watch      # keep copying every 10s while the trial runs
#   eval/bin/pull-pursuit.sh --view       # copy once, then start the viewer
#
# Then, from the destination directory:
#   kona view            # the React viewer on localhost
#   kona graph --history # the same thing in the terminal, with the rationale chain
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval_root="$(cd "${here}/.." && pwd)"
repo_root="$(cd "${eval_root}/.." && pwd)"
dest="${DEST:-${eval_root}/report/live}"
kona="bun ${repo_root}/packages/kona/src/bin.ts"

watch=0; view=0
for a in "$@"; do
  case "${a}" in
    --watch) watch=1 ;;
    --view)  view=1 ;;
    *) echo "unknown flag: ${a}" >&2; exit 2 ;;
  esac
done

pull_once() {
  # In an A/B both arms are up and only ONE has a pursuit — the baseline has no `.kona/`
  # because it has no Kona, which is the whole point of it. So pick by what the container
  # holds rather than by name order, or half the time you tail the arm with nothing in it.
  local c=""
  for candidate in $(docker ps --format '{{.Names}}' | grep -- '-main-1$'); do
    if docker exec "${candidate}" test -f /.kona/mutations.jsonl 2>/dev/null; then
      c="${candidate}"
      break
    fi
  done
  if [[ -z "${c}" ]]; then
    echo "no running container has a pursuit" >&2
    return 1
  fi
  mkdir -p "${dest}/.kona"
  if ! docker cp "${c}:/.kona/mutations.jsonl" "${dest}/.kona/mutations.jsonl" 2>/dev/null; then
    echo "container ${c} has no /.kona — is this the Kona arm?" >&2
    return 1
  fi
  local v
  v="$(cd "${dest}" && ${kona} graph --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])' || echo "?")"
  echo "$(date +%H:%M:%S)  ${c}  ->  ${dest}  (head v${v})"
}

if [[ "${watch}" -eq 1 ]]; then
  echo "watching — ctrl-c to stop"
  last=""
  while true; do
    if out="$(pull_once 2>&1)"; then
      # Only print when the version actually moved, so a long node does not spam the terminal.
      cur="${out##*head }"
      [[ "${cur}" != "${last}" ]] && echo "${out}" && last="${cur}"
    fi
    sleep 10
  done
fi

pull_once

if [[ "${view}" -eq 1 ]]; then
  echo
  echo "starting the viewer in ${dest}"
  cd "${dest}" && exec ${kona} view
fi

cat <<EOF

Open it with:
    cd ${dest} && ${kona} view
or read it in the terminal:
    cd ${dest} && ${kona} graph --history
EOF
