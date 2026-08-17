#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${1:-main}"
REMOTE="${2:-origin}"
INTERVAL="${3:-15}"

while true; do
  if [[ -n "$(git status --short --untracked-files=all)" ]]; then
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    git add -A || true
    if git diff --cached --quiet; then
      :
    else
      git commit -m "auto: snapshot $ts" || true
      git push "$REMOTE" "$BRANCH" || true
    fi
  fi
  sleep "$INTERVAL"
done
