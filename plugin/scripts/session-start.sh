#!/usr/bin/env bash
# SessionStart — say where the pursuit stands, and change nothing.
#
# §8 wants a fresh terminal to print correct status with no session state, and this is
# where that becomes free: open a shell in a pursuit and you are told what is ready, what
# is armed, and what needs a human.
#
# IT ASKS THE CLI WHETHER A PURSUIT EXISTS, rather than looking for `.kona/` itself. §8 also
# says "nothing outside the CLI reads or writes `.kona/`", and a `[[ -f .kona/... ]]` here
# would be a second thing that knows the layout — small today, and exactly how a format
# ends up with two readers. `kona resume` already refuses with NO_PURSUIT outside one, so
# the check is a non-zero exit.
#
# DELIBERATELY `--dry-run`. Plan T5.5 describes this hook as making kill-and-resume
# automatic, and a plain `kona resume` would do that — by COMMITTING a mutation. Firing
# timeouts unprompted at every session start, in a session the user may have opened for
# something else entirely, is a write nobody asked for. §6.9 also requires the plugin to be
# "additive and trivially removable". So it reports, and says what it WOULD repair; the
# repair is one command away and belongs to whoever reads the report.
set -uo pipefail

kona="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/bin/kona"
[[ -x "${kona}" ]] || exit 0

# Silent outside a pursuit: this runs in every directory the user ever opens Claude Code
# in, and a hook that complains in all of them gets uninstalled.
report="$("${kona}" resume --dry-run 2>/dev/null)" || exit 0

echo "kona — a pursuit is open here"
echo "${report}"
exit 0
