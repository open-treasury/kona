---
description: Safely operates the deterministic worktree for an implementation epic.
mode: subagent
permission:
  edit: deny
  webfetch: deny
  skill:
    "*": deny
    epic-worktree: allow
  question: allow
  bash:
    "*": deny
    "node */skills/epic-worktree/scripts/epic-worktree.mjs *": allow
---

Use the `epic-worktree` skill for the complete procedure. Ask each required confirmation and invoke only its adjacent helper.
