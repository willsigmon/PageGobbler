#!/usr/bin/env bash
# Build the Chrome Web Store upload: dist/PageGobbler-v<version>.zip
# Contains runtime files only (no docs, store assets, tests, or icon sources).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "package.sh: could not read version from manifest.json" >&2
  exit 1
fi

RUNTIME_PATHS=(manifest.json background.js content lib popup viewer ui)
for path in "${RUNTIME_PATHS[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "package.sh: missing runtime path: $path" >&2
    exit 1
  fi
done

shopt -s nullglob
ICONS=(icons/icon[0-9]*.png) # manifest sizes only; not icon_circular_1024.png
shopt -u nullglob
if [[ ${#ICONS[@]} -eq 0 ]]; then
  echo "package.sh: no icons/icon<size>.png found" >&2
  exit 1
fi

# The viewer loads this SVG at runtime (logo mark and empty state).
EXTRA_ASSETS=(icons/turkey-32.svg)

mkdir -p dist
OUT="dist/PageGobbler-v${VERSION}.zip"
rm -f "$OUT"

zip -q -r -X "$OUT" "${RUNTIME_PATHS[@]}" "${ICONS[@]}" "${EXTRA_ASSETS[@]}" \
  -x '*.DS_Store' -x '*/.*'

echo "Built $OUT"
unzip -l "$OUT" | tail -n 1
