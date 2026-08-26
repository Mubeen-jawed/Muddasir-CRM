#!/usr/bin/env bash
# =============================================
# Piped to the VPS over SSH by .github/workflows/deploy.yml and executed
# from stdin (bash -s), never from a file on the server — so updating the
# checkout mid-run cannot corrupt the script that is doing the updating.
#
# Expects VPS_PATH and SHA in the environment.
# =============================================
set -euo pipefail

cd "$VPS_PATH"

PREV="$(git rev-parse HEAD)"
echo "→ VPS currently at $PREV"

# budgets.json holds live budget overrides written by /api/budget. It used to
# be tracked; the commit that untracks it would otherwise DELETE it from the
# server on checkout. Snapshot before anything touches the working tree.
BUDGETS_BACKUP=""
if [ -f budgets.json ]; then
  BUDGETS_BACKUP="$(mktemp)"
  cp budgets.json "$BUDGETS_BACKUP"
fi

# People edit directly on this box. Never discard that work silently.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠ Uncommitted changes on the VPS — stashing them before deploy:"
  git status --short
  git stash push -u -m "pre-deploy $(date -u +%FT%TZ)"
  echo "  recover with:  cd $VPS_PATH && git stash list && git stash pop"
fi

echo "→ Fetching origin"
git fetch --prune origin

echo "→ Checking out $SHA"
git checkout -B main "$SHA"

if [ -n "$BUDGETS_BACKUP" ]; then
  if [ ! -f budgets.json ]; then
    cp "$BUDGETS_BACKUP" budgets.json
    echo "→ Restored budgets.json (server-side state, no longer tracked)"
  fi
  rm -f "$BUDGETS_BACKUP"
fi

echo "→ Now at $(git rev-parse HEAD)"
echo "  rollback:  cd $VPS_PATH && git reset --hard $PREV && bash deploy-remote.sh"
echo ""

bash deploy-remote.sh
