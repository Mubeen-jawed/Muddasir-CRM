# Ben ADU — Budget Pacing Dashboard

Live Meta Ads budget monitoring dashboard. Pulls spend data straight from the Meta Marketing API (free — Meta charges nothing for API calls), categorizes by geo (LA, OC, SJ, Green V2), alerts on overspend via Slack.

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

### 1. Get a Meta access token

The Marketing API is free. You need one token with the `ads_read` scope, and
the identity that generates it must already have access to the ad accounts in
`config.js`. Two kinds work — the code treats them identically.

**Option A — System User token (never expires, preferred)**

Requires Admin rights on the Business portfolio that owns the ad accounts.

1. [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System users → Add**
2. **Add assets → Ad accounts** → select the accounts → grant *View performance*
3. **Add assets → Apps** → select your app (create one at [developers.facebook.com/apps](https://developers.facebook.com/apps), type *Business*, product *Marketing API*)
4. **Generate new token** → scope `ads_read` → expiration **Never**

**Option B — Long-lived user token (~60 days)**

No portfolio Admin rights needed. Works with whatever ad accounts *you* can
already see in Ads Manager.

1. [Graph API Explorer](https://developers.facebook.com/tools/explorer) → select your app → add `ads_read` → **Generate Access Token**
2. [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken) → paste it → **Extend Access Token**

This one expires. The dashboard posts a Slack warning `TOKEN_WARN_DAYS` (default 7)
before it does, and `/api/health` always reports the exact expiry date.

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
# ↑ Paste your META_ACCESS_TOKEN here

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

## Continuous Deployment

`.github/workflows/deploy.yml` redeploys on every push to `main` (and on manual
**Run workflow**). It syntax-checks, rsyncs the repo to the VPS, runs
`npm ci --omit=dev`, reloads PM2 with zero downtime, and fails the run if the
app doesn't complete a Meta fetch afterwards.

### Required repository secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Example | Notes |
|--------|---------|-------|
| `VPS_HOST` | `203.0.113.10` | IP or hostname |
| `VPS_USER` | `root` | SSH user that owns the app directory |
| `VPS_PATH` | `/opt/ben-budget-dashboard` | Absolute path, no trailing slash |
| `VPS_SSH_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----…` | Full **private** key, including header/footer lines |
| `VPS_PORT` | `22` | Optional — defaults to 22 if unset |

### Generating the deploy key

On your local machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vps_deploy -N "" -C "github-actions"

# authorize the public half on the VPS
ssh-copy-id -i ~/.ssh/vps_deploy.pub USER@VPS_HOST

# the private half goes into the VPS_SSH_KEY secret
cat ~/.ssh/vps_deploy
```

### What the deploy never touches

These live only on the server and are excluded from the sync, so a deploy can't
clobber them:

- `.env` — secrets
- `budgets.json` — budget overrides made in the dashboard UI
- `logs/` — PM2 output
- `node_modules/` — rebuilt from the lockfile on the server

> `budgets.json` is committed as a starting point for a fresh install, but the
> live copy on the VPS is authoritative and is never overwritten by CI.

---

## Features

- **Auto-refresh**: Server pulls Meta Ads data every 60 minutes (configurable)
- **Budget alerts**: Warns at 80% / 95% thresholds
- **Slack notifications**: Optional — sends alerts to your Slack channel
- **Sign-in required**: Username + password, scrypt-hashed, with rate limiting (see *Authentication*)
- **Campaign breakdown**: Expand each geo to see individual campaign spend/leads/CPL
- **Editable budgets**: Click "Edit budget" on any geo card — persists on disk
- **Projected EOM**: Shows where each geo will land if current pace continues

---


## Authentication

The dashboard requires a sign-in. Nothing is served to an anonymous visitor
except `/login` itself.

### How it works

| | |
|---|---|
| Password storage | scrypt hash in `.env` (`AUTH_PASSWORD_HASH`) — the plaintext is never stored or committed |
| Comparison | constant-time; username and password are always both checked, so response time can't be used to discover a valid username |
| Session | stateless HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` behind SSL, 12h expiry |
| Rate limiting | 5 failed attempts per IP → 15 minute lockout |
| Coverage | the auth gate runs **before** `express.static`, so `index.html` is protected too — not just the API |

Nothing sensitive is kept in the browser: the session lives in an `HttpOnly`
cookie the page itself cannot read.

### Changing the credentials

```bash
# 1. generate a new hash
node -e "const c=require('crypto');const s=c.randomBytes(16);
console.log('scrypt\$16384\$8\$1\

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
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

---

## Troubleshooting

**"Meta token expired or revoked" (OAuth code 190)**
→ The token is dead. Regenerate it — see *Get a Meta access token* above — and
  update `META_ACCESS_TOKEN` in `.env`, then `pm2 restart ben-budget-dashboard`.
→ `curl localhost:3500/api/health` shows `token.expiresAt` and `token.daysLeft`.

**"Meta API error 400 ... (#100) Unsupported get request"**
→ The token's identity has no role on that ad account. Confirm you can see the
  account in Ads Manager; if not, ask for access there first.

**Numbers stopped updating but the page still loads**
→ Almost always an expired token. Check `/api/health` — `error` will be set.

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
+s.toString('base64')+'\

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
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

---

## Troubleshooting

**"Meta token expired or revoked" (OAuth code 190)**
→ The token is dead. Regenerate it — see *Get a Meta access token* above — and
  update `META_ACCESS_TOKEN` in `.env`, then `pm2 restart ben-budget-dashboard`.
→ `curl localhost:3500/api/health` shows `token.expiresAt` and `token.daysLeft`.

**"Meta API error 400 ... (#100) Unsupported get request"**
→ The token's identity has no role on that ad account. Confirm you can see the
  account in Ads Manager; if not, ask for access there first.

**Numbers stopped updating but the page still loads**
→ Almost always an expired token. Check `/api/health` — `error` will be set.

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
+
c.scryptSync(process.argv[1],s,64,{N:16384,r:8,p:1}).toString('base64'))" 'NEW-PASSWORD'

# 2. paste it into .env as AUTH_PASSWORD_HASH, set AUTH_USERNAME, then
pm2 restart ben-budget-dashboard
```

Rotating `SESSION_SECRET` immediately signs out every existing session.
Changing `AUTH_USERNAME` does the same, since sessions are signed for a
specific user.

### `/api/health` and CI

`/api/health` is the one endpoint reachable without a session, and only from
**direct loopback** — a request arriving through Nginx carries `X-Forwarded-For`
and is rejected. That's what lets the deploy workflow smoke-test the app on the
VPS without credentials, while keeping it closed to the internet.

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
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

---

## Troubleshooting

**"Meta token expired or revoked" (OAuth code 190)**
→ The token is dead. Regenerate it — see *Get a Meta access token* above — and
  update `META_ACCESS_TOKEN` in `.env`, then `pm2 restart ben-budget-dashboard`.
→ `curl localhost:3500/api/health` shows `token.expiresAt` and `token.daysLeft`.

**"Meta API error 400 ... (#100) Unsupported get request"**
→ The token's identity has no role on that ad account. Confirm you can see the
  account in Ads Manager; if not, ask for access there first.

**Numbers stopped updating but the page still loads**
→ Almost always an expired token. Check `/api/health` — `error` will be set.

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
