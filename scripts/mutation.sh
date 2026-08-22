#!/usr/bin/env bash
# Run every mutation tier. §7 makes the score a target, not a gate — but a tier that falls
# below its `break` threshold exits non-zero, so the number is visible rather than assumed.
set -uo pipefail
cd "$(dirname "$0")/.."

TIERS=("$@")
if [ ${#TIERS[@]} -eq 0 ]; then TIERS=(core durability rest); fi

FAILED=()
for tier in "${TIERS[@]}"; do
  echo "───────── mutation tier: ${tier} ─────────"
  if STRYKER_TIER="${tier}" ./node_modules/.bin/stryker run stryker.conf.mjs; then
    echo "PASS ${tier}"
  else
    echo "BELOW THRESHOLD ${tier}"
    FAILED+=("${tier}")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Tiers below threshold: ${FAILED[*]}"
  exit 1
fi
echo "All mutation tiers met their thresholds."
