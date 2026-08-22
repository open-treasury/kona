#!/usr/bin/env bash
# Compile the `kona` binary for both Linux architectures.
#
# The container gets a single static artifact and needs no Bun — which is what
# plugin/bin/kona already anticipates when it resolves `kona-bin` before falling back to
# `bun packages/kona/src/bin.ts`. ⚖ The binary contains no model, so there is nothing
# provider-specific to port; that law is why this arm can run against DeepSeek at all.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
dist="${repo}/eval/dist"

mkdir -p "${dist}"

for target in x64 arm64; do
  case "${target}" in
    x64)   bun_target="bun-linux-x64" ;;
    arm64) bun_target="bun-linux-arm64" ;;
  esac
  echo "==> ${bun_target}"
  bun build --compile --target="${bun_target}" \
    "${repo}/packages/kona/src/bin.ts" \
    --outfile "${dist}/kona-linux-${target}"
done

ls -lh "${dist}"
echo
echo "Both binaries built. eval/harbor/kona_agent.py picks one by \`uname -m\` at setup."
