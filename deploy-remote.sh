#!/usr/bin/env bash
# =============================================
# Runs ON the VPS, from the app directory, after
# CI has rsynced the files. Not for first-time
# setup — use deploy.sh for that.
# =============================================
set -euo pipefail

APP_NAME="ben-budget-dashboard"

if [ ! -f .env ]; then
  echo "✗ No .env on the server. The app cannot start without META_ACCESS_TOKEN." >&2
  echo "  cp .env.example .env && nano .env" >&2
  exit 1
fi

echo "→ Installing production dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mkdir -p logs

echo "→ Reloading PM2"
# reload is zero-downtime when the app is already up; start covers a cold box.
pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js
pm2 save

PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3500}"

# Success means a completed Meta fetch, not just an open socket — the server
# starts listening before its first fetch finishes, so an open port proves nothing.
echo "→ Smoke testing http://127.0.0.1:$PORT/api/health"
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  # Check the failure pattern first: a response can carry both a stale
  # lastFetched and a fresh error, and the error is the one that matters.
  case "$HEALTH" in
    *'"error":"'*)
      echo "$HEALTH" >&2
      echo "✗ App started but the Meta fetch failed." >&2
      pm2 logs "$APP_NAME" --lines 40 --nostream >&2 || true
      exit 1
      ;;
    *'"valid":false'*)
      echo "$HEALTH" >&2
      echo "✗ Meta token is invalid — dashboard is up but cannot fetch." >&2
      exit 1
      ;;
    *'"lastFetched":"'*)
      echo "$HEALTH"
      echo "✓ Deploy healthy"
      exit 0
      ;;
  esac
  sleep 2
done

echo "✗ Health check never completed a fetch within 60s. Recent logs:" >&2
pm2 logs "$APP_NAME" --lines 40 --nostream >&2 || true
exit 1
