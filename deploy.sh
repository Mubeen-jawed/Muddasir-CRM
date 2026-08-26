#!/bin/bash
# =============================================
# Ben ADU Budget Dashboard — VPS Deploy Script
# Run this on your Contabo VPS
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

# 3. Install dependencies
echo "Installing dependencies..."
npm install --production

# 4. Create logs directory
mkdir -p logs

# 5. Check .env exists
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  No .env file found!"
    echo "   Copy and edit the example:"
    echo ""
    echo "   cp .env.example .env"
    echo "   nano .env"
    echo ""
    echo "   You need to set PIPEBOARD_API_KEY"
    echo "   Get it from: https://pipeboard.co/settings/api"
    echo ""
    echo "   After editing .env, run this script again."
    exit 1
fi

# 6. Stop existing instance if running
pm2 delete ben-budget-dashboard 2>/dev/null || true

# 7. Start with PM2
echo "Starting dashboard..."
pm2 start ecosystem.config.js

# 8. Save PM2 process list (survives reboot)
pm2 save

# 9. Setup PM2 startup (auto-start on reboot)
echo ""
echo "Setting up auto-start on boot..."
pm2 startup | tail -1 | bash 2>/dev/null || echo "Run the pm2 startup command manually if needed"

# 10. Show status
echo ""
echo "=========================================="
echo "  Dashboard is running!"
echo "=========================================="
pm2 status
echo ""
echo "  Local:  http://localhost:$(grep PORT .env | cut -d= -f2 || echo 3500)"
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
