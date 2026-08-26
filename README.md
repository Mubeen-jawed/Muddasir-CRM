# Ben ADU — Budget Pacing Dashboard

Live Meta Ads budget monitoring dashboard. Pulls spend data via Pipeboard API, categorizes by geo (LA, OC, SJ, Green V2), alerts on overspend via Slack.

**No Claude dependency** — runs standalone on your VPS.

---

## Geo → Account Mapping

| Geo | Account | Rule |
|-----|---------|------|
| LA County | FL (`act_598233003217290`) | All campaigns **except** ones named "Pacific" |
| LA County | Pacific (`act_1423425976190315`) | Only campaigns with **"LA"** in name |
| Orange County | Pacific (`act_1423425976190315`) | Only campaigns with **"OC"** in name |
| San Jose | Pacific (`act_1423425976190315`) | Only campaigns with **"SJ"** in name |
| Green V2 | Green V2 (`act_1281838446384778`) | All campaigns |

Edit `config.js` to change mappings, add geos, or update account IDs.

---

## Quick Start (Contabo VPS)

### 1. Get your Pipeboard API key

Two options:

**Option A — Pipeboard REST API key (recommended)**
1. Go to [pipeboard.co/settings/api](https://pipeboard.co/settings/api)
2. Generate an API key
3. It will look like: `pb_live_xxxxxxxxxxxx`

**Option B — Meta access token via Pipeboard**
1. Go to [pipeboard.co/connections](https://pipeboard.co/connections)
2. Your Meta connections show access tokens
3. Copy the long-lived token
4. The dashboard will use Meta's Graph API directly

### 2. Deploy

```bash
# Upload to your VPS (from your local machine)
scp -r ben-budget-dashboard/ root@YOUR_VPS_IP:/opt/

# SSH into your VPS
ssh root@YOUR_VPS_IP

# Go to project
cd /opt/ben-budget-dashboard

# Set up environment
cp .env.example .env
nano .env
# ↑ Paste your PIPEBOARD_API_KEY here

# Run deploy script
chmod +x deploy.sh
bash deploy.sh
```

### 3. Set up Nginx + SSL (optional but recommended)

```bash
# Copy nginx config
sudo cp nginx.conf /etc/nginx/sites-available/budget-dashboard

# Edit domain name
sudo nano /etc/nginx/sites-available/budget-dashboard
# Change budget.yourdomain.com to your actual domain

# Enable site
sudo ln -s /etc/nginx/sites-available/budget-dashboard /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Add SSL
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d budget.yourdomain.com
```

### 4. Access

- **Without Nginx**: `http://YOUR_VPS_IP:3500`
- **With Nginx + SSL**: `https://budget.yourdomain.com`

---

## Features

- **Auto-refresh**: Server pulls Meta Ads data every 60 minutes (configurable)
- **Budget alerts**: Warns at 80% / 95% thresholds
- **Slack notifications**: Optional — sends alerts to your Slack channel
- **Password protection**: Optional — set `DASHBOARD_PASSWORD` in `.env`
- **Campaign breakdown**: Expand each geo to see individual campaign spend/leads/CPL
- **Editable budgets**: Click "Edit budget" on any geo card — persists on disk
- **Projected EOM**: Shows where each geo will land if current pace continues

---

## Configuration

### Change budgets
Edit `config.js` → `monthlyBudget` per geo, or use the dashboard UI.

### Add a new geo
Add an entry to the `GEOS` array in `config.js`:

```javascript
{
  id: "new_geo",
  name: "New Geo Name",
  monthlyBudget: 15000,
  color: "#8b5cf6",
  accounts: [
    {
      accountId: "act_XXXXXXX",
      label: "Account Name",
      excludeKeywords: null,        // or ["keyword_to_skip"]
      includeKeywords: ["KEYWORD"], // or null for all campaigns
    },
  ],
}
```

### Alert thresholds
In `.env`:
```
ALERT_WARN_THRESHOLD=80    # Yellow warning at 80%
ALERT_DANGER_THRESHOLD=95  # Red danger at 95%
```

### Refresh interval
In `.env`:
```
REFRESH_INTERVAL_MINUTES=60  # Pull data every hour
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard` | Full dashboard data (geos, summary, meta) |
| POST | `/api/refresh` | Force data refresh from Meta Ads |
| POST | `/api/budget` | Update budget `{ geoId, budget }` |
| GET | `/api/health` | Health check (uptime, last fetch, errors) |

---

## Troubleshooting

**"Pipeboard API error 401"**
→ API key is invalid or expired. Get a new one from pipeboard.co/settings/api

**"Pipeboard API error 403"**
→ Key doesn't have access to these ad accounts. Check your Pipeboard connections.

**No data showing**
→ Check `pm2 logs ben-budget-dashboard` for errors.
→ Verify account IDs in `config.js` match your actual Meta ad accounts.

**Campaign shows in wrong geo**
→ Check campaign naming. The dashboard uses keywords in campaign names (LA, OC, SJ) to categorize. Rename campaigns in Ads Manager if needed, or adjust `includeKeywords` in `config.js`.

---

## PM2 Commands

```bash
pm2 status                          # Check if running
pm2 logs ben-budget-dashboard       # View logs
pm2 restart ben-budget-dashboard    # Restart
pm2 stop ben-budget-dashboard       # Stop
pm2 delete ben-budget-dashboard     # Remove
```
