#!/usr/bin/env bash
# SessionStart — say where the pursuit stands, and change nothing.
#
# §8 wants a fresh terminal to print correct status with no session state, and this is
# where that becomes free: open a shell in a pursuit and you are told what is ready, what
# is armed, and what needs a human.
#
# DELIBERATELY `--dry-run`. Plan T5.5 describes this hook as making kill-and-resume
# automatic, and a plain `kona resume` would do that — by COMMITTING a mutation. Firing
# timeouts unprompted at every session start, in a session the user may have opened for
# something else entirely, is a write nobody asked for. §6.9 also requires the plugin to be
# "additive and trivially removable". So it reports, and says what it WOULD repair; the
# repair is one command away and belongs to whoever reads the report.
#
# Silent and successful outside a pursuit: this runs in every directory the user ever opens
# Claude Code in, and a hook that complains in all of them gets uninstalled.
set -uo pipefail

root="$PWD"
while [[ "${root}" != "/" ]]; do
  [[ -f "${root}/.kona/mutations.jsonl" ]] && break
  root="$(dirname "${root}")"
done
[[ -f "${root}/.kona/mutations.jsonl" ]] || exit 0

kona="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/bin/kona"
[[ -x "${kona}" ]] || exit 0

echo "kona — a pursuit is open here (${root}/.kona/)"
"${kona}" resume --dry-run 2>&1 || true
exit 0
