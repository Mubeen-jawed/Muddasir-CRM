#!/bin/bash
# =============================================
# Ben ADU Budget Dashboard — VPS first-time setup
# Run this on your Contabo VPS.
# Redeploys are handled by .github/workflows/deploy.yml
# =============================================

set -e

echo "=========================================="
echo "  Ben ADU Budget Dashboard — Deploying"
echo "=========================================="

# 1. Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "Node: $(node -v)"
echo "NPM: $(npm -v)"

# 2. Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    sudo npm install -g pm2
fi

# 3. Check .env exists BEFORE installing anything
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  No .env file found!"
    echo "   Copy and edit the example:"
    echo ""
    echo "   cp .env.example .env"
    echo "   nano .env"
    echo ""
    echo "   You need to set META_ACCESS_TOKEN (scope: ads_read)."
    echo "   Long-lived user token (~60 days):"
    echo "     1. developers.facebook.com/tools/explorer  — generate with ads_read"
    echo "     2. developers.facebook.com/tools/debug/accesstoken — Extend Access Token"
    echo "   Or a System User token (never expires) from Business Settings."
    echo ""
    echo "   After editing .env, run this script again."
    exit 1
fi

# 4. Install dependencies (lockfile-exact when we have one)
echo "Installing dependencies..."
if [ -f package-lock.json ]; then
    npm ci --omit=dev
else
    npm install --omit=dev
fi

# 5. Create logs directory
mkdir -p logs

# 6. Stop existing instance if running
pm2 delete ben-budget-dashboard 2>/dev/null || true

# 7. Start with PM2
echo "Starting dashboard..."
pm2 start ecosystem.config.js

# 8. Save PM2 process list (survives reboot)
pm2 save

# 9. Setup PM2 startup (auto-start on reboot)
# pm2 startup prints a command for you to run; only execute it if it
# actually looks like that command.
echo ""
echo "Setting up auto-start on boot..."
STARTUP_CMD="$(pm2 startup 2>/dev/null | grep -E '^sudo env' | tail -1 || true)"
if [ -n "$STARTUP_CMD" ]; then
    echo "  Running: $STARTUP_CMD"
    eval "$STARTUP_CMD"
else
    echo "  Already configured (or run 'pm2 startup' manually and follow its output)."
fi

# 10. Show status
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3500}"

echo ""
echo "=========================================="
echo "  Dashboard is running!"
echo "=========================================="
pm2 status
echo ""
echo "  Local:  http://localhost:${PORT}"
echo ""
echo "  Logs:   pm2 logs ben-budget-dashboard"
echo "  Stop:   pm2 stop ben-budget-dashboard"
echo "  Restart: pm2 restart ben-budget-dashboard"
echo ""
echo "  Next steps:"
echo "  1. Set up Nginx reverse proxy (see README.md)"
echo "  2. Add SSL with Let's Encrypt"
echo "  3. Optional: Set SLACK_WEBHOOK_URL in .env for alerts"
echo "=========================================="
