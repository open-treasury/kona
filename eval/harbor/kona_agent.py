"""The Kona arm: stock Terminus-2 plus the `kona` binary and one skill.

The A/B is deliberately this thin. Baseline is Harbor's `terminus-2`, unmodified. This
subclass changes nothing about the model, the prompt template, the parser, the tmux
session or the turn loop — it only makes three things true inside the container before
the agent starts:

  1. `kona` is on PATH
  2. `.kona/` is initialised at `/`, so every task's working directory finds it
     (the CLI walks up from cwd looking for `.kona/`, the way git finds `.git`)
  3. `/opt/kona/skills/kona/SKILL.md` exists, which Terminus-2 discovers on its own and
     appends to the instruction as an <available_skills> block

Anything else would confound the comparison.

Run it with:
    harbor run -d terminal-bench/terminal-bench@latest \
        --agent-import-path eval.harbor.kona_agent:KonaTerminus \
        --model deepseek/deepseek-v4-flash
"""

from __future__ import annotations

import logging
import os
import shlex
from pathlib import Path

from harbor.agents.terminus_2.terminus_2 import Terminus2
from harbor.environments.base import BaseEnvironment

logger = logging.getLogger(__name__)

# eval/harbor/kona_agent.py -> eval/
_EVAL_ROOT = Path(__file__).resolve().parent.parent
_DIST = _EVAL_ROOT / "dist"
_SKILLS = _EVAL_ROOT / "skills"

_SKILLS_TARGET = "/opt/kona/skills"
_CONFIG_TARGET = "/opt/kona/config.json"
_BIN_TARGET = "/usr/local/bin/kona"


class KonaTerminus(Terminus2):
    """Terminus-2 with the Kona state layer installed."""

    @staticmethod
    def name() -> str:
        return "kona-terminus-2"

    def __init__(self, *args, **kwargs):
        # Terminus-2 only emits the <available_skills> block when skills_dir is set AND the
        # directory exists in the container. Default it here so the arm needs no extra flag.
        kwargs.setdefault("skills_dir", _SKILLS_TARGET)
        super().__init__(*args, **kwargs)

    async def _install_kona(self, environment: BaseEnvironment) -> None:
        arch_result = await environment.exec("uname -m", timeout_sec=30)
        arch = (arch_result.stdout or "").strip()
        binary = {
            "x86_64": "kona-linux-x64",
            "amd64": "kona-linux-x64",
            "aarch64": "kona-linux-arm64",
            "arm64": "kona-linux-arm64",
        }.get(arch)
        if binary is None:
            raise RuntimeError(
                f"no kona binary for arch {arch!r}; build one with eval/bin/build-kona.sh"
            )

        source = _DIST / binary
        if not source.exists():
            raise RuntimeError(f"{source} is missing — run eval/bin/build-kona.sh first")

        await environment.exec("mkdir -p /opt/kona", timeout_sec=30, user="root")
        await environment.upload_file(source, _BIN_TARGET)
        await environment.upload_dir(_SKILLS, _SKILLS_TARGET)
        await environment.upload_file(_SKILLS / "kona" / "config.json", _CONFIG_TARGET)
        await environment.exec(f"chmod 0755 {_BIN_TARGET}", timeout_sec=30, user="root")

        # `brief` refuses with NO_IDENTITY unless the pursuit has one, and identity can only
        # be set at init — the log is never re-created. So the config must be in place first.
        init = await environment.exec(
            # `--prefix` is required: every node id opens with it and it is fixed for the life of
            # the pursuit. `kn` keeps the correlation address short.
            f"cd / && {_BIN_TARGET} init --config {_CONFIG_TARGET} --prefix kn",
            timeout_sec=60,
            user="root",
        )
        if init.return_code != 0:
            raise RuntimeError(
                f"kona init failed ({init.return_code}): {init.stderr or init.stdout}"
            )

        # The pursuit lives at / and every task cwd is below it, so the agent can run kona
        # from wherever the task drops it. Loosen the mode: tasks do not all run as root.
        await environment.exec("chmod -R 0777 /.kona", timeout_sec=30, user="root")

        # Verify from a task-like working directory, not from /, so this also proves the
        # walk-up lookup works where the agent will actually stand. Raise rather than log:
        # a silently half-installed layer would make the Kona arm a slower copy of the
        # baseline and quietly turn the whole comparison into a measurement of nothing.
        verify = await environment.exec(
            f"cd / && {_BIN_TARGET} next && {_BIN_TARGET} graph --json | head -c 200",
            timeout_sec=60,
        )
        if verify.return_code != 0:
            raise RuntimeError(
                f"kona is installed but not working (exit {verify.return_code}): "
                f"{(verify.stderr or verify.stdout or '').strip()[:500]}"
            )

        log_check = await environment.exec("wc -l < /.kona/mutations.jsonl", timeout_sec=30)
        if log_check.return_code != 0 or not (log_check.stdout or "").strip():
            raise RuntimeError("kona init left no /.kona/mutations.jsonl")

        # KONA_SEED=1 commits a generic skeleton — an `initial`, five `action`s and a `final` —
        # so the agent starts at `kona next` instead of at an empty store.
        #
        # Why: measured on production-planning, the model invoked `kona next` and then
        # `kona --help`/`kona mutate --help`, and never committed a graph. Reading the frontier
        # is one command; AUTHORING one is a small program — a JSON ops file, minted ids,
        # dependency edges, a rationale — all owed before any payoff. That is where it stops.
        #
        # The skeleton is deliberately TASK-AGNOSTIC (understand inputs → state requirements →
        # decide approach → do the work → verify). It encodes no knowledge of any task and
        # gives away no answers; it only removes the blank page. Its `do the work` node says out
        # loud that it is a placeholder and tells the model how to replace it — supersede it and
        # commit the real steps wired to its neighbours — so authoring is still tested, just
        # incrementally rather than all at once, up front, for free.
        #
        # And the five worked nodes are still a CHAIN, which after the activity model is a
        # deliberate choice rather than an inherited one. `eval/analyze/shape.ts` scores a run by
        # whether the log contains a `fork` and a `decision`; the seed is in that same log, so a
        # seed that forked would report `expressedConcurrency` on every seeded trial no matter
        # what the model did, and the one instrument that can falsify the redesign would be
        # measuring itself. Concurrency is taught in the skill and in KONA_DIRECTIVE below; the
        # starting graph stays the flattest legal thing, so branching in the log is the model's.
        if os.environ.get("KONA_SEED", "") not in ("", "0", "false", "no"):
            await environment.upload_file(_SKILLS / "kona" / "seed.json", "/opt/kona/seed.json")
            seeded = await environment.exec(
                f"cd / && {_BIN_TARGET} mutate --ops /opt/kona/seed.json --base-version 0 "
                f"--why 'Skeleton plan: understand before deciding, decide before doing, "
                f"verify against stated requirements.' --reason-code MISSING_STEP",
                timeout_sec=60,
                user="root",
            )
            if seeded.return_code != 0:
                raise RuntimeError(
                    f"kona seed failed ({seeded.return_code}): "
                    f"{(seeded.stderr or seeded.stdout or '').strip()[:400]}"
                )
            await environment.exec("chmod -R 0777 /.kona", timeout_sec=30, user="root")

        # Written where trial artifacts are collected AND printed, so the install is provable
        # from the job output rather than inferred from the absence of an exception.
        summary = (
            f"kona ok · {(verify.stdout or '').strip()[:120]} · "
            f"log lines: {(log_check.stdout or '').strip()}"
        )
        logger.info(summary)
        await environment.exec(
            f"printf '%s\\n' {shlex.quote(summary)} > /tmp/kona-install.txt", timeout_sec=30
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await self._install_kona(environment)

    async def run(self, instruction: str, environment: BaseEnvironment, context) -> None:
        if _instructed():
            instruction = f"{instruction}\n\n{KONA_DIRECTIVE}"
        await super().run(instruction, environment, context)


# ---------------------------------------------------------------------------------------
# The INSTRUCTED variant — a different question from the one the skill mechanism asks.
#
# Offered-and-chosen was measured first: 3 runs, 2 models, 2 tasks, 0 executions. DeepSeek
# never opened the skill; Sonnet 5 opened it and declined. So voluntary adoption cannot carry
# the A/B, and the question becomes "does Kona help when it IS used" — which needs the model
# told to use it.
#
# THE CONTROL THAT MATTERS: telling one arm to plan and not the other measures the planning
# instruction, not the tool. So the baseline gets a matched directive with the same shape and
# the same demand — plan first, name what truly depends on what, name what runs at once, work
# everything that is available, track progress, revise deliberately — and no tool. The only
# thing that differs between arms is whether that discipline is enforced by `kona` or left to
# the model's own notes.
#
# The two lists are matched BULLET FOR BULLET, and they have to stay that way: a demand added
# to one arm and not the other silently turns the A/B into a measurement of the prompt. Where
# Kona's bullet names a node type — `fork`, `join`, `merge` — the baseline's names the same
# obligation without a vocabulary to write it in, which is exactly the difference under test.
# ---------------------------------------------------------------------------------------

KONA_DIRECTIVE = """\
Before your first command, read /opt/kona/skills/kona/SKILL.md and follow it. This is not
advice and it is not optional: on this task, the graph is how you work.

`kona` is on your PATH and a pursuit is already initialised.

- **Author the plan first.** One node per concrete, checkable step, not three large ones. If a
  step would take more than a few commands to finish, it is two steps. `kona mutate --steps`
  starts a plan in a single command, so there is no reason to defer it.
- **Draw an edge only where one step truly needs another.** An edge means "this must be
  finished before that can start" — it does not mean "I planned to do that next". A plan that
  is one long chain is usually wrong: check every edge by asking whether the target genuinely
  needs the source.
- **Draw the concurrency; do not leave it implied.** Steps that do not need each other belong
  on the arms of a `fork`, and they come back together at a `join` when you need all of them or
  a `merge` when any one will do. An `action` takes exactly one in-edge and one out-edge, so a
  fan-out is something the graph states or does not have.
- **Work the whole frontier.** `kona next` returns everything that is ready, not one thing. If
  it hands you three nodes, the plan is saying all three can be worked now — do that, rather
  than taking one and coming back for the others.
- **Claim before you work.** Set a node `active` before you start it, so the graph says what
  is being worked and not merely what is ready.
- **Record before you move on.** Every finished step gets its outcome and an `evidence_ref`
  naming what you actually looked at — a file, a log, a command.
- **`kona next` is the only source of work.** Do not keep a to-do list, a notes file, or a plan
  in your head beside the graph. If you catch yourself tracking state the CLI could track, put
  it in the graph instead.
- **When the work proves the plan wrong, change the plan** — supersede the node that was wrong
  and commit what replaces it, wired to its neighbours in the same batch — and say why.
  Replanning is the expected case, not a failure.

Work the whole task this way, from the first step to the last one."""

PLAN_DIRECTIVE = """\
Before your first command, plan this task explicitly. This is not advice and it is not
optional: on this task, the written plan is how you work.

- **Write the plan first.** One entry per concrete, checkable step, not three large ones. If a
  step would take more than a few commands to finish, it is two steps.
- **Record a prerequisite only where one step truly needs another.** "Depends on" means "this
  must be finished before that can start" — not "I planned to do that next". A plan that is one
  long sequence is usually wrong: check each prerequisite by asking whether it is real.
- **Write the concurrency down; do not leave it implied.** Steps that do not need each other go
  in one named group that is worked together, and the plan says what waits on that group and
  whether it waits for all of them or for whichever finishes first. A set of steps that runs at
  once is something the plan states or does not have.
- **Work the whole available set.** When the plan says three steps are available, that means
  all three can be worked now — do that, rather than taking one and coming back for the others.
- **Mark a step started before you work it**, so the plan says what is being worked and not
  merely what is ready.
- **Record before you move on.** Every finished step gets its outcome and a note of what you
  actually looked at — a file, a log, a command.
- **The plan is the only source of work.** Consult it rather than your memory when choosing
  what to do next, and keep one plan rather than a second list beside it.
- **When the work proves the plan wrong, change the plan** — replace the step that was wrong
  with the steps it turned out to be, and say what now comes before and after them — and note
  why. Replanning is the expected case, not a failure.

Work the whole task this way, from the first step to the last one."""


def _instructed() -> bool:
    """KONA_INSTRUCTED=1 selects the instructed question. Default is the voluntary one."""
    return os.environ.get("KONA_INSTRUCTED", "") not in ("", "0", "false", "no")


class BaselineTerminus(Terminus2):
    """Stock Terminus-2 plus the matched planning directive — the control for KonaTerminus."""

    @staticmethod
    def name() -> str:
        return "baseline-terminus-2"

    async def run(self, instruction: str, environment: BaseEnvironment, context) -> None:
        if _instructed():
            instruction = f"{instruction}\n\n{PLAN_DIRECTIVE}"
        await super().run(instruction, environment, context)
