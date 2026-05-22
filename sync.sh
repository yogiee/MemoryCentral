#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NO_COMMIT=false

for arg in "$@"; do
  [[ "$arg" == "--no-commit" ]] && NO_COMMIT=true
done

echo "=== MemoryCentral Sync  $(date -u '+%Y-%m-%d %H:%M UTC') ==="
echo ""

node "${SCRIPT_DIR}/server/sync.js"

if [[ "$NO_COMMIT" == false ]]; then
  changed="$(git -C "$SCRIPT_DIR" status --porcelain snapshots/ dashboard/ 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$changed" -gt 0 ]]; then
    echo ""
    echo "Committing ${changed} changed file(s)..."
    git -C "$SCRIPT_DIR" add snapshots/ dashboard/
    git -C "$SCRIPT_DIR" commit -m "sync: $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo "Run 'git push' to sync to remote."
  else
    echo ""
    echo "No snapshot changes — nothing to commit."
  fi
fi

echo ""
echo "Done."
