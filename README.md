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
**Run workflow**). It syntax-checks, updates the VPS checkout with git, runs
`npm ci --omit=dev`, reloads PM2 with zero downtime, and fails the run if the
app doesn't complete a Meta fetch afterwards.

The VPS is itself a git clone that people commit from, so the deploy moves it
with `git checkout -B main <sha>` rather than overwriting files underneath it —
which would leave the server's `.git` out of step with its own working tree.
`scripts/vps-deploy.sh` is piped in over stdin rather than executed from the
checkout, so it is never the file it is updating.

### Required repository secrets

**Settings → Secrets and variables → Actions → `Secrets` tab → New repository secret**

> ⚠️ It must be the **Secrets** tab, not **Variables**. They sit on the same
> page as two tabs, and the workflow reads `${{ secrets.* }}`. Values added
> under Variables resolve to an empty string, which shows up as the job sitting
> pending for many minutes and then failing — `ssh` hanging on an empty
> hostname. The workflow now checks for this up front and fails in seconds with
> the missing names.

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

### Server-side state is preserved

These live only on the server and survive every deploy:

- `.env` — secrets, gitignored
- `budgets.json` — budget overrides made in the dashboard UI, gitignored
- `accounts.json` — ad accounts added from the UI, and every workspace's Slack channel, gitignored
- `users.json` — client logins (scrypt hashes, never plaintext), gitignored
- `logs/` — PM2 output, gitignored
- `node_modules/` — rebuilt from the lockfile on the server

`budgets.json` is deliberately **untracked**. It is runtime state written by
`/api/budget`, so a tracked copy would be reverted by every deploy the moment
someone edited a budget in the UI. The deploy script also snapshots it before
touching the working tree and restores it afterwards, so the commit that
untracked it could not delete it from the server.

### If someone edited directly on the VPS

Uncommitted changes on the server are **stashed, not discarded**, before the
checkout moves. To get them back:

```bash
cd /opt/ben-budget-dashboard
git stash list          # entries are named "pre-deploy <timestamp>"
git stash pop
```

Every run also prints a one-line rollback command naming the previous commit.

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



## Accounts (sidebar)

Each row in the sidebar is a **workspace** — one client or brand, owning its own
geo cards. Switching rows swaps the whole dashboard; the choice is remembered
per browser.

Workspaces are defined at the top of `config.js`:

```javascript
const WORKSPACES = [
  { id: "ben-adu",   name: "Ben ADU",   slackChannel: "C0123ABCD", dashboardUrl: "..." },
  { id: "perstrive", name: "Perstrive", slackChannel: null,        dashboardUrl: "..." },
];
```

Every geo carries a `workspace` field pointing at one of those ids. `GEOS`
stays a single flat list, because campaign categorization and the budget
overrides both key off `geo.id` — so **geo ids must be unique across
workspaces**.

Each workspace gets its own budget alert and daily/weekly summary, posted to
its own Slack channel and covering only that workspace's geos — one client
never sees another's spend or totals.

**Channel ids are not configured in code.** Every workspace's channel — seed
and UI-added alike — lives in one map in `accounts.json`:

```json
{ "workspaces": [ ... ],
  "channels": { "ben-adu": "C0BTHN6RC2J", "perstrive": "C0BUE1U7KCY" } }
```

Edit them from the dashboard: **Slack channels** in the sidebar lists every
account with its channel. Blank means that account is tracked but never posts,
so a client can be silenced without removing it.

`seedSlackChannel` in `config.js` is used **once**, to populate that map the
first time the server runs against an empty `accounts.json`. After that the
stored map is the only source of truth and editing the code line does nothing.
Delete `accounts.json` to re-seed from code.

Use the encoded channel ID (`C0123ABCD`), not `#name` — a rename silently
breaks name-based routing. The bot holds `chat:write.public`, so public
channels need no invite; a **private** channel needs `/invite @blendfold_bot`
run in it once.

Meta token-expiry warnings are infrastructure, not client news, so they go to
`SLACK_OPS_CHANNEL` in `.env` instead of any client channel.

### Adding an ad account from the dashboard

The sidebar's **+ Add ad account** button lists every ad account the Meta token
can reach (`/me/adaccounts`), searchable by name, account ID, or business.
Accounts already on the dashboard are shown greyed out so the same account
can't be added twice — a second workspace on one account would double-count its
spend in the portfolio totals.

Picking one asks for a display name, a monthly budget, the **username and
password** that account's client will sign in with, and an **optional** Slack
channel ID. Leave the channel blank and the account is tracked on the dashboard
but stays off Slack; add it later and messages start flowing.

The login is created in the same request as the account, and is scoped to it
alone — that client signs in to its own dashboard with no sidebar and no route
to anyone else's numbers. See *Authentication* below.

Accounts added this way are written to `accounts.json` (gitignored, like
`budgets.json` — the server copy is authoritative and deploys never overwrite
it). Each becomes one workspace owning one geo that covers **every** campaign in
the account.

Seed workspaces in `config.js` can't be edited or removed from the UI. They hold
hand-tuned rules the picker can't express — Ben ADU slices a single account
across three geos by campaign-name keywords — so they stay in code where those
rules are reviewable.

### Adding a workspace by hand

1. Add an entry to `WORKSPACES` (leave `slackChannel: null` until the client
   channel exists).
2. Add one or more geos with `workspace: "<that id>"`, each listing its
   `accountId`s.
3. Restart. The sidebar row appears automatically, and the account is included
   in the hourly refresh.

Set `monthlyBudget` to anything sensible — whoever uses the dashboard can edit
it via *Edit budget*, and that value is saved to `budgets.json` and wins over
the config.

> **Keep each geo single-currency.** Spend is summed as a raw number and
> rendered with a hardcoded `# Ben ADU — Budget Pacing Dashboard

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
**Run workflow**). It syntax-checks, updates the VPS checkout with git, runs
`npm ci --omit=dev`, reloads PM2 with zero downtime, and fails the run if the
app doesn't complete a Meta fetch afterwards.

The VPS is itself a git clone that people commit from, so the deploy moves it
with `git checkout -B main <sha>` rather than overwriting files underneath it —
which would leave the server's `.git` out of step with its own working tree.
`scripts/vps-deploy.sh` is piped in over stdin rather than executed from the
checkout, so it is never the file it is updating.

### Required repository secrets

**Settings → Secrets and variables → Actions → `Secrets` tab → New repository secret**

> ⚠️ It must be the **Secrets** tab, not **Variables**. They sit on the same
> page as two tabs, and the workflow reads `${{ secrets.* }}`. Values added
> under Variables resolve to an empty string, which shows up as the job sitting
> pending for many minutes and then failing — `ssh` hanging on an empty
> hostname. The workflow now checks for this up front and fails in seconds with
> the missing names.

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

### Server-side state is preserved

These live only on the server and survive every deploy:

- `.env` — secrets, gitignored
- `budgets.json` — budget overrides made in the dashboard UI, gitignored
- `accounts.json` — ad accounts added from the UI, and every workspace's Slack channel, gitignored
- `users.json` — client logins (scrypt hashes, never plaintext), gitignored
- `logs/` — PM2 output, gitignored
- `node_modules/` — rebuilt from the lockfile on the server

`budgets.json` is deliberately **untracked**. It is runtime state written by
`/api/budget`, so a tracked copy would be reverted by every deploy the moment
someone edited a budget in the UI. The deploy script also snapshots it before
touching the working tree and restores it afterwards, so the commit that
untracked it could not delete it from the server.

### If someone edited directly on the VPS

Uncommitted changes on the server are **stashed, not discarded**, before the
checkout moves. To get them back:

```bash
cd /opt/ben-budget-dashboard
git stash list          # entries are named "pre-deploy <timestamp>"
git stash pop
```

Every run also prints a one-line rollback command naming the previous commit.

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


; there is no FX conversion. Mixing a EUR or AUD
> account into a USD geo silently corrupts the totals and the 80/95% alerts.

---
## Authentication

The dashboard requires a sign-in. Nothing is served to an anonymous visitor
except `/login` itself.

### Two roles

| Role | Who | Sees | Can change |
|---|---|---|---|
| **admin** | one login, set in `.env` (`AUTH_USERNAME` / `AUTH_PASSWORD_HASH`) | every account, in the sidebar | everything — add/remove accounts, budgets, Slack routing, logins |
| **client** | one login per ad account, stored in `users.json` | only the account(s) its login is scoped to | nothing |

A client signs in to a page with **no sidebar at all**: no account list, no
*Add ad account*, no *Slack channels*, no *Edit budget*, and no way to reach
another client's numbers. Hiding the chrome is only the visible half — the
server refuses the routes regardless, so `?workspace=someone-else` serves the
client its own account rather than the one it asked for, and every write route
answers `403`.

The current logins:

| Username | Sees |
|---|---|
| `muddasir` | admin — every account |
| `ben` | Ben ADU |
| `perstrive` | Perstrive |

### How it works

| | |
|---|---|
| Password storage | scrypt hash — the admin's in `.env`, each client's in `users.json`. Plaintext is never stored or committed |
| Comparison | constant-time; the admin check and the client check both always run to completion, and an unknown username is hashed against a throwaway hash, so response time can't be used to discover a valid username |
| Session | stateless HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` behind SSL, 12h expiry |
| Revocation | the cookie carries only a username and a fingerprint of the password it was issued against. Role and scope are re-read on every request, so deleting a login, re-scoping it, or resetting its password ends its open sessions on the next request — not whenever the cookie expires |
| Rate limiting | 5 failed attempts per IP → 15 minute lockout |
| Coverage | the auth gate runs **before** `express.static`, so `index.html` is protected too — not just the API |

Nothing sensitive is kept in the browser: the session lives in an `HttpOnly`
cookie the page itself cannot read.

### Managing client logins

A login is created **together with its ad account** — *+ Add ad account* asks
for a username and password alongside the budget and Slack channel, so an
account never lands on the dashboard with no way for its owner to open it. The
login is validated before the account is written, so a rejected username or
password leaves nothing half-built behind.

Afterwards, the sidebar's **Dashboard logins** dialog (admin only) lists every
client login, and can reset a password or revoke one outright. Removing an ad
account also removes the login that existed only for it.

The admin login is deliberately **not** editable from the UI. It lives in
`.env`, so no session can delete or re-scope the account that governs every
other one.

### Changing the admin credentials

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
| GET | `/api/me` | Who is signed in: `{ username, role, workspaces }` |
| GET | `/api/workspaces` | Sidebar rows — scoped to what the caller may see |
| GET | `/api/dashboard` | Full dashboard data (geos, summary, meta) for one workspace |
| POST | `/api/refresh` | Force data refresh from Meta Ads |
| POST | `/api/budget` | Update budget `{ geoId, budget }` — **admin** |
| POST/PATCH/DELETE | `/api/accounts` | Add, edit, remove an ad account — **admin** |
| GET/POST/PATCH/DELETE | `/api/users` | List, add, reset, revoke client logins — **admin** |
| GET/PUT | `/api/channels` | Slack routing per workspace — **admin** |
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

Routes marked **admin** answer `403` for a client login. `/api/workspaces` and
`/api/dashboard` are not refused for a client — they are *scoped*: a client is
served its own account whatever it asks for.

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
| GET | `/api/me` | Who is signed in: `{ username, role, workspaces }` |
| GET | `/api/workspaces` | Sidebar rows — scoped to what the caller may see |
| GET | `/api/dashboard` | Full dashboard data (geos, summary, meta) for one workspace |
| POST | `/api/refresh` | Force data refresh from Meta Ads |
| POST | `/api/budget` | Update budget `{ geoId, budget }` — **admin** |
| POST/PATCH/DELETE | `/api/accounts` | Add, edit, remove an ad account — **admin** |
| GET/POST/PATCH/DELETE | `/api/users` | List, add, reset, revoke client logins — **admin** |
| GET/PUT | `/api/channels` | Slack routing per workspace — **admin** |
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

Routes marked **admin** answer `403` for a client login. `/api/workspaces` and
`/api/dashboard` are not refused for a client — they are *scoped*: a client is
served its own account whatever it asks for.

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
| GET | `/api/me` | Who is signed in: `{ username, role, workspaces }` |
| GET | `/api/workspaces` | Sidebar rows — scoped to what the caller may see |
| GET | `/api/dashboard` | Full dashboard data (geos, summary, meta) for one workspace |
| POST | `/api/refresh` | Force data refresh from Meta Ads |
| POST | `/api/budget` | Update budget `{ geoId, budget }` — **admin** |
| POST/PATCH/DELETE | `/api/accounts` | Add, edit, remove an ad account — **admin** |
| GET/POST/PATCH/DELETE | `/api/users` | List, add, reset, revoke client logins — **admin** |
| GET/PUT | `/api/channels` | Slack routing per workspace — **admin** |
| GET | `/api/health` | Health check (uptime, last fetch, errors, token expiry) |

Routes marked **admin** answer `403` for a client login. `/api/workspaces` and
`/api/dashboard` are not refused for a client — they are *scoped*: a client is
served its own account whatever it asks for.

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

---

## Creative performance tab

Every workspace listed in `creative/config/accounts.json` gets a second tab at the top of its page:
**Budget pacing** (this dashboard) and **Creative performance** (the creative tracker). Ben ADU is the
first one. Other workspaces show no tab until their accounts are added to that file.

What the tab shows, all pulled from the same `META_ACCESS_TOKEN`:

- **Angles / Hooks / Formats** — spend, leads, CPL, CTR, hook rate, hold rate and a verdict
  (winner / promising / testing / underperforming / loser) against the client's CPL target
  (`creative/config/accounts.json` → `clients`).
- **Counties** — the same geo rules as the budget cards (`config.js`), so LA / OC / SJ / Outdoor match.
- **Ads** — every ad with its tags, fatigue flags, thumbnail, primary text and a tag editor.
- **Pipeline** — creatives by stage (idea → production → live → paused → winning → retired), with a
  Drive link and the hypothesis each one is testing; planned creatives can be logged before launch and
  linked to the Meta ad afterwards.
- **Matrix** — any two dimensions as a CPL heatmap.

Tags are parsed from the ad name (`FORMAT | ANGLE ANGLE | HOOK LINE HOOK | Vn`) and can be corrected by
hand; hand edits win. Video hook rate = 25%-watched views ÷ impressions (Meta's API no longer returns
3-second plays), hold rate = ThruPlay ÷ hook views, graded against `video_benchmark` in the same file.

**Data**: `creative/data/tracker.db` (SQLite, gitignored, rebuilt by the sync). On the first boot with an
empty database the server backfills 180 days in the background; after that `CREATIVE_SYNC_CRON`
(default every 3 hours) refreshes the last `CREATIVE_SYNC_WINDOW_DAYS`. Admins can also press
**Sync Meta** on the tab. Clients see the tab read-only; tagging is admin-only.

**Code**: `creative/` (router, sync, analytics, name parser), `public/creative.js` + `public/creative.css`
(the tab's UI, generated from the standalone tracker in the Monitor Dashboard project — edit here, not there).

---

## Settings

The Settings button in the account panel at the bottom of the sidebar (admin only) opens a modal with
**dashboard logins** (set a client's password, revoke a login) and **Slack channels** (the channel each
account's alerts post to). Clients see the panel with Sign out only. Adding an ad account (which creates its
client login) lives in the sidebar under *Add ad account*.

---

## Live updates

There is no refresh button. The server publishes a server-sent event on `/api/events` whenever a Meta fetch
(`REFRESH_INTERVAL_MINUTES`, plus `POST /api/refresh`) or a creative sync completes, and every open page
reloads its data on that signal; the live indicator shows "Updating…" for the moment it takes. A 5-minute
poll remains as a fallback for proxies that drop long connections.

Behind Nginx the `/api/events` location must be proxied unbuffered — see `nginx.conf` (`proxy_buffering off`,
`proxy_read_timeout 1h`).

---

## Breakdown pages

County cards, the summary tiles and campaign rows all open a breakdown page (URL fragments
`#breakdown/geo/<id>`, `#breakdown/all`, `#breakdown/campaign/<id>`, so the browser back button and links
work). Charts first, then the written breakdown, then a table:

- **Spend per day** — bars, with the daily budget (campaign) or ideal daily spend (county) as a dashed line.
- **Budget pace** — cumulative spend against a straight even-pace line.
- **Leads per day** — bars, with cost per lead as dots on its own scale.
- **Click-through rate** — line with dots, impressions as faint bars behind.
- **Breakdown** — totals for the window plus a plain-language reading of spend pace, leads, click-through
  trend and month-to-date budget.
- **Table** — the county's (or all counties') campaigns this month, each clickable, or the day-by-day rows
  for a campaign.

Data comes from `GET /api/campaign/:id` (one campaign) and `GET /api/breakdown?geo=|workspace=` (daily
totals across the campaigns a county owns, using the same include/exclude rules as the cards), both scoped
to the login's workspaces and cached 15 minutes. Charts are canvas in the theme's text colour, no library.
A This month / 30 days / 90 days switch changes the window.
