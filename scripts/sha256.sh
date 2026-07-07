#!/usr/bin/env bash
# Generate `<asset>.sha256` sidecars next to every shippable artifact in
# release/. Run after each electron-builder cut so users can verify their
# downloads against the published checksum (Cove Nexus mandates this for
# every repo under ~/Projects/).
#
# Output format matches `sha256sum`'s default — a single line of
# `<hex>  <basename>` so users can drop the sidecar next to the asset and
# verify with `sha256sum -c <file>.sha256`.
set -euo pipefail

cd "$(dirname "$0")/.."
release="release"

if [[ ! -d "$release" ]]; then
  echo "no release/ directory — run a dist:* script first" >&2
  exit 0
fi

count=0
shopt -s nullglob
for f in \
  "$release"/*.AppImage \
  "$release"/*.deb \
  "$release"/*.exe \
  "$release"/*.dmg \
  "$release"/*.zip \
  "$release"/*.msi \
  "$release"/*.snap \
  "$release"/*.rpm \
  "$release"/latest*.yml
do
  [[ -f "$f" ]] || continue
  out="${f}.sha256"
  # Skip if sidecar already current (handles rerunning the script).
  if [[ -f "$out" && "$out" -nt "$f" ]]; then continue; fi
  ( cd "$release" && sha256sum "$(basename "$f")" > "$(basename "$out")" )
  echo "sha256 → $out"
  count=$((count + 1))
done

if [[ "$count" -eq 0 ]]; then
  echo "no shippable artifacts found in $release/"
fi
