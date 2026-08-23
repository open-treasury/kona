#!/usr/bin/env bash
# Launch a run that OUTLIVES the session that started it.
#
# Three A/B attempts died tonight and none of them died to the experiment. One was a stale
# binary, one was an over-broad kill, and one was a session interrupt that took down the run,
# the log watcher and an unrelated viewer at the same instant — because all three were
# background tasks owned by the session.
#
# A two-hour job must not be tied to the lifetime of a conversation. `setsid` puts it in its
# own process group so a Ctrl+C aimed at the session cannot reach it, and `nohup` detaches it
# from the terminal so a disconnect cannot either. Polling needs the log and the job directory,
# not the process — so nothing is lost by not owning it.
#
#   eval/run/detached.sh 02-ab.sh          # any script in eval/run/
#   eval/run/detached.sh 01-probe.sh
#
# Environment passes straight through:
#   KONA_INSTRUCTED=1 KONA_SEED=1 TASKS=... MODEL=... MULT=2.0 eval/run/detached.sh 02-ab.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-}"
if [[ -z "${script}" ]]; then
  echo "usage: eval/run/detached.sh <script.sh>" >&2
  exit 2
fi
target="${here}/${script}"
[[ -f "${target}" ]] || { echo "no such script: ${target}" >&2; exit 2; }

stamp="$(date +%Y%m%d-%H%M%S)"
log="${here}/../report/run-${stamp}.log"
mkdir -p "$(dirname "${log}")"

# NO `setsid` — it is a util-linux program and does not exist on macOS, where this runs. An
# earlier version used it and died instantly with `command not found`, having reported success.
#
# What actually detaches here: `nohup` ignores SIGHUP so a closing terminal cannot end it,
# `< /dev/null` and the redirects cut every tie to the parent's streams, and `disown` drops it
# from the launching shell's job table. The launching shell then exits — which is the important
# part — and the orphan is reparented to launchd, outside any process tree a session can kill.
nohup bash "${target}" > "${log}" 2>&1 < /dev/null &
pid=$!
disown "${pid}" 2>/dev/null || true

cat <<EOF
detached: ${script}
pid:      ${pid}   (reparented to launchd once this shell exits)
log:      ${log}

  tail -f ${log}
  pkill -f '${script}'    # to stop it deliberately
EOF
