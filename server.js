require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const {
  DEFAULT_WORKSPACE,
  getWorkspaces,
  getAllGeos,
  getAllAccountIds,
  getWorkspace,
  getGeos,
  getSlackWorkspaces,
  getUsedAccountIds,
  addAccount,
  updateAccount,
  removeAccount,
  setChannel,
  isEditable,
} = require("./config");
const auth = require("./auth");
const users = require("./users");

const app = express();
const PORT = process.env.PORT || 3500;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = process.env.META_API_VERSION || "v26.0";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
// System-level alerts (Meta token expiry) go here, never to a client channel —
// clients shouldn't see our infrastructure warnings.
const SLACK_OPS_CHANNEL = process.env.SLACK_OPS_CHANNEL;
const WARN_THRESHOLD = parseInt(process.env.ALERT_WARN_THRESHOLD || "80") / 100;
const DANGER_THRESHOLD = parseInt(process.env.ALERT_DANGER_THRESHOLD || "95") / 100;
const REFRESH_MINUTES = parseInt(process.env.REFRESH_INTERVAL_MINUTES || "60");
const TOKEN_WARN_DAYS = parseInt(process.env.TOKEN_WARN_DAYS || "7");


// ── In-memory data store ──
let cachedData = null;         // per-geo MTD (month-to-date) spend + leads
let cachedWeekData = null;     // per-geo trailing-7-day spend + leads (drives EOM projection)
let lastFetchTime = null;
let fetchError = null;
let tokenExpiry = null;      // {valid, expiresAt, daysLeft} from debug_token
let lastTokenWarnDate = null; // caps the Slack expiry warning at one per day

// ── Budget overrides (persisted to disk) ──
const BUDGET_FILE = path.join(__dirname, "budgets.json");

function loadBudgetOverrides() {
  try {
    if (fs.existsSync(BUDGET_FILE)) {
      return JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveBudgetOverrides(overrides) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(overrides, null, 2));
}

let budgetOverrides = loadBudgetOverrides();

function getEffectiveBudget(geoId) {
  if (budgetOverrides[geoId] !== undefined) return budgetOverrides[geoId];
  const geo = getAllGeos().find((g) => g.id === geoId);
  return geo ? geo.monthlyBudget : 0;
}

// ── Date helpers (anchored to client business timezone) ──
// Meta Ads reports data on the ad account's timezone (Pacific for Ben's accounts).
// The VPS runs UTC, so date rollover would be wrong without this — e.g. at 11:55 PM
// Pacific it's already 6:55 AM UTC next day, and getToday() would return tomorrow.
const CLIENT_TZ = "America/Los_Angeles";

function partsInTz(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
  };
}

function getMonthStart() {
  const { year, month } = partsInTz(CLIENT_TZ);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function getToday() {
  const { year, month, day } = partsInTz(CLIENT_TZ);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getDaysInMonth() {
  const { year, month } = partsInTz(CLIENT_TZ);
  // Day 0 of next month = last day of current month
  return new Date(year, month, 0).getDate();
}

function getDayOfMonth() {
  return partsInTz(CLIENT_TZ).day;
}

// ── Meta Graph API (Marketing API) insights ──
// Free: Meta charges nothing for API calls. Auth is a single access token —
// either a long-lived user token (~60 days) or a System User token (never
// expires). Both are read with the ads_read scope; neither changes this code.
const INSIGHT_FIELDS =
  "campaign_id,campaign_name,spend,impressions,clicks,reach,frequency,actions,cost_per_action_type";

function metaError(accountId, status, body) {
  const err = (body && body.error) || {};
  // 190 = expired or revoked OAuth token. This is the single most likely
  // failure mode for a long-lived user token, so name the fix in the message.
  if (err.code === 190) {
    return new Error(
      `Meta token expired or revoked (${accountId}): ${err.message} — ` +
        `regenerate at developers.facebook.com/tools/explorer, extend it in the ` +
        `Access Token Debugger, then update META_ACCESS_TOKEN in .env`
    );
  }
  return new Error(
    `Meta API error ${status} on ${accountId}: ` +
      (err.message || JSON.stringify(body || {}).slice(0, 200))
  );
}

// One account, following paging.next so accounts with many campaigns aren't
// silently truncated at the page limit.
async function fetchAccountInsights(accountId, since, until) {
  let url =
    `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?` +
    new URLSearchParams({
      time_range: JSON.stringify({ since, until }),
      level: "campaign",
      fields: INSIGHT_FIELDS,
      limit: "500",
      access_token: META_ACCESS_TOKEN,
    });

  const campaigns = [];
  while (url) {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);

    if (!response.ok || !body || body.error) {
      throw metaError(accountId, response.status, body);
    }
    if (Array.isArray(body.data)) campaigns.push(...body.data);
    url = (body.paging && body.paging.next) || null;
  }
  return campaigns;
}

// All accounts. Deliberately fails the whole fetch if any account errors:
// dropping one account would quietly under-report spend, and under-reporting
// is the dangerous direction for budget pacing and the 80/95% alerts.
async function fetchInsights(accountIds, since, until) {
  if (!META_ACCESS_TOKEN) {
    throw new Error("No Meta token configured — set META_ACCESS_TOKEN in .env");
  }
  return Promise.all(
    accountIds.map(async (accountId) => ({
      accountId,
      campaigns: await fetchAccountInsights(accountId, since, until),
    }))
  );
}

// ── Token expiry watch ──
// A dead token otherwise looks like a dashboard that simply stopped moving.
async function checkTokenExpiry() {
  if (!META_ACCESS_TOKEN) return;
  try {
    const url =
      `https://graph.facebook.com/${META_API_VERSION}/debug_token?` +
      new URLSearchParams({
        input_token: META_ACCESS_TOKEN,
        access_token: META_ACCESS_TOKEN,
      });
    const body = await (await fetch(url)).json();
    const info = body && body.data;

    // A fully dead token can't authenticate this call either, so Meta answers
    // with an error envelope instead of data.is_valid === false. Both mean dead.
    if (!info || !info.is_valid) {
      const why =
        (body && body.error && body.error.message) || "token rejected by Meta";
      tokenExpiry = { valid: false, expiresAt: null, daysLeft: null };
      console.error(`  [TOKEN] NOT valid (${why}) — regenerate META_ACCESS_TOKEN in .env`);
      await postTokenWarning();
      return;
    }
    // expires_at of 0 means a never-expiring System User token.
    if (!info.expires_at) {
      tokenExpiry = { valid: true, expiresAt: null, daysLeft: null };
      console.log("  [TOKEN] Valid, never expires (System User token)");
      return;
    }

    const expiresAt = new Date(info.expires_at * 1000);
    const daysLeft = Math.floor((expiresAt - Date.now()) / 86400000);
    tokenExpiry = {
      valid: true,
      expiresAt: expiresAt.toISOString(),
      daysLeft,
    };
    const line = `  [TOKEN] Valid, expires ${expiresAt.toISOString().slice(0, 10)} (${daysLeft} days left)`;
    if (daysLeft <= TOKEN_WARN_DAYS) {
      console.error(`${line} ** RENEW NOW **`);
      await postTokenWarning();
    } else {
      console.log(line);
    }
  } catch (err) {
    console.error(`  [TOKEN] Expiry check failed: ${err.message}`);
  }
}

// ── Slack transport ──
// One bot token posts to every channel; the channel is chosen per call. Unlike
// an incoming webhook, chat.postMessage reports WHY a post failed
// (channel_not_found, not_in_channel, invalid_auth) instead of failing quietly.
async function postToSlack(channel, payload, label = "SLACK") {
  if (!SLACK_BOT_TOKEN) return null;
  if (!channel) return null;
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, ...payload }),
    });
    const body = await r.json().catch(() => null);
    if (!body || !body.ok) {
      const why = (body && body.error) || `HTTP ${r.status}`;
      console.error(`  [${label}] post to ${channel} FAILED: ${why}`);
      if (why === "not_in_channel" || why === "channel_not_found") {
        console.error(`  [${label}] if ${channel} is private, run /invite @blendfold_bot in it`);
      }
      return body;
    }
    return body;
  } catch (err) {
    console.error(`  [${label}] post to ${channel} failed: ${err.message}`);
    return null;
  }
}

// ── Slack warning for a dying token ──
// Without this, an expired token looks identical to a quiet week: the numbers
// simply stop moving, and nobody notices until a budget has already blown past.
async function postTokenWarning() {
  if (!SLACK_OPS_CHANNEL || !tokenExpiry) return;

  // One warning per day, so a restart loop can't spam the channel.
  const today = getToday();
  if (lastTokenWarnDate === today) return;

  const dead = !tokenExpiry.valid || tokenExpiry.daysLeft <= 0;
  const days = tokenExpiry.daysLeft;
  const headline = dead
    ? ":rotating_light: *Meta API token has expired* — the budget dashboard has stopped updating."
    : `:warning: *Meta API token expires in ${days} day${days === 1 ? "" : "s"}* (${tokenExpiry.expiresAt.slice(0, 10)}).`;

  const lines = [
    headline,
    "",
    "*To renew:*",
    "1. developers.facebook.com/tools/explorer — generate a token with the `ads_read` scope",
    "2. developers.facebook.com/tools/debug/accesstoken — paste it, then *Extend Access Token*",
    "3. Update `META_ACCESS_TOKEN` in `.env` and restart the dashboard",
    "",
    "_A System User token from Business Settings never expires and retires this warning for good._",
  ];

  const res = await postToSlack(
    SLACK_OPS_CHANNEL,
    { text: lines.join("\n") },
    "TOKEN"
  );
  if (res && res.ok) {
    lastTokenWarnDate = today;
    console.log("  [TOKEN] Slack expiry warning sent");
  }
}

// ── Categorize campaigns into geos ──
function categorizeCampaigns(apiResults) {
  const geoData = {};
  getAllGeos().forEach((g) => {
    geoData[g.id] = { spent: 0, leads: 0, impressions: 0, clicks: 0, reach: 0, campaigns: [] };
  });

  // apiResults can be in different formats depending on API used
  // Normalize to array of { accountId, campaigns: [...] }
  const accountResults = normalizeResults(apiResults);

  accountResults.forEach(({ accountId, campaigns }) => {
    campaigns.forEach((camp) => {
      const name = camp.campaign_name || camp.name || "";
      const spend = parseFloat(camp.spend || 0);

      // Extract lead count from actions.
      // Meta returns several overlapping lead action types on the same campaign
      // (`lead`, `offsite_conversion.fb_pixel_lead`, `onsite_web_lead`, ...).
      // `lead` is Meta's aggregate across every lead source, so prefer it
      // explicitly — matching on whichever happened to come first in the array
      // made the count depend on Meta's undocumented field ordering.
      let leads = 0;
      if (Array.isArray(camp.actions)) {
        const byType = (t) => camp.actions.find((a) => a.action_type === t);
        const leadAction =
          byType("lead") || byType("offsite_conversion.fb_pixel_lead");
        if (leadAction) leads = parseInt(leadAction.value || 0, 10);
      }
      // Fallback: calculate from cost_per_action_type
      if (leads === 0 && camp.cost_per_action_type) {
        const leadCpa = camp.cost_per_action_type.find(
          (a) =>
            a.action_type === "offsite_conversion.fb_pixel_lead" ||
            a.action_type === "lead"
        );
        if (leadCpa && parseFloat(leadCpa.value) > 0) {
          leads = Math.round(spend / parseFloat(leadCpa.value));
        }
      }

      // Match campaign to geo based on config rules.
      // Tracked so a campaign that lands in zero geos (spend silently dropped
      // from every total, including Slack's) or in two geos (spend counted
      // twice) is visible in the logs instead of quietly skewing the numbers.
      const matchedGeos = [];
      getAllGeos().forEach((geo) => {
        geo.accounts.forEach((accConfig) => {
          if (accConfig.accountId !== accountId) return;

          // Check excludes first
          if (accConfig.excludeKeywords) {
            const excluded = accConfig.excludeKeywords.some((kw) =>
              name.toUpperCase().includes(kw.toUpperCase())
            );
            if (excluded) return;
          }

          // Check includes
          if (accConfig.includeKeywords) {
            const included = accConfig.includeKeywords.some((kw) =>
              name.toUpperCase().includes(kw.toUpperCase())
            );
            if (!included) return;
          }

          // This campaign belongs to this geo
          matchedGeos.push(geo.id);
          const impressions = parseInt(camp.impressions || 0, 10);
          const clicks = parseInt(camp.clicks || 0, 10);
          const reach = parseInt(camp.reach || 0, 10);
          const frequency = parseFloat(camp.frequency || 0);
          geoData[geo.id].spent += spend;
          geoData[geo.id].leads += leads;
          geoData[geo.id].impressions += impressions;
          geoData[geo.id].clicks += clicks;
          geoData[geo.id].reach += reach;
          geoData[geo.id].campaigns.push({
            name,
            spend,
            leads,
            impressions,
            clicks,
            reach,
            frequency,
            clickToLead: clicks > 0 ? (leads / clicks) * 100 : 0,
            ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
            account: accConfig.label,
            campaignId: camp.campaign_id || camp.id,
          });
        });
      });

      if (spend > 0 && matchedGeos.length !== 1) {
        const why =
          matchedGeos.length === 0
            ? "matched NO geo — its spend is missing from every total"
            : `matched ${matchedGeos.length} geos (${matchedGeos.join(", ")}) — its spend is counted ${matchedGeos.length}x`;
        console.warn(
          `  [CATEGORIZE] "${name}" (${accountId}, $${spend.toFixed(2)}) ${why} — check includeKeywords/excludeKeywords in config.js`
        );
      }
    });
  });

  // Sort campaigns by spend descending
  Object.values(geoData).forEach((g) => {
    g.campaigns.sort((a, b) => b.spend - a.spend);
  });

  return geoData;
}

// ── Normalize API response formats ──
function normalizeResults(apiResults) {
  // Legacy bulk-response shape with a results array
  if (apiResults.results && Array.isArray(apiResults.results)) {
    return apiResults.results.map((r) => ({
      accountId: r.account_id,
      campaigns: r.insights || r.campaigns || [],
    }));
  }

  // If it's a direct Meta response with data array
  if (apiResults.data && Array.isArray(apiResults.data)) {
    // Group by account
    const grouped = {};
    apiResults.data.forEach((row) => {
      const accId = row.account_id || "unknown";
      if (!grouped[accId]) grouped[accId] = [];
      grouped[accId].push(row);
    });
    return Object.entries(grouped).map(([accountId, campaigns]) => ({
      accountId,
      campaigns,
    }));
  }

  // If it's already normalized
  if (Array.isArray(apiResults)) {
    return apiResults;
  }

  return [];
}

// ── Main data fetch ──
async function refreshData() {
  const since = getMonthStart();
  const until = getToday();
  // Trailing 7-day window (ends TODAY so it moves with the current pace)
  const weekSince = shiftDate(until, -6);
  const accountIds = getAllAccountIds();

  console.log(`[${new Date().toISOString()}] Fetching data: ${since} to ${until} (plus trailing 7d ${weekSince}→${until})`);
  console.log(`  Accounts: ${accountIds.join(", ")}`);

  try {
    // MTD and trailing-7d in parallel
    const [apiResults, weekApiResults] = await Promise.all([
      fetchInsights(accountIds, since, until),
      fetchInsights(accountIds, weekSince, until),
    ]);

    cachedData = categorizeCampaigns(apiResults);
    cachedWeekData = weekApiResults ? categorizeCampaigns(weekApiResults) : null;
    lastFetchTime = new Date().toISOString();
    fetchError = null;

    console.log(`  Success! Geo totals:`);
    getAllGeos().forEach((g) => {
      const d = cachedData[g.id];
      const budget = getEffectiveBudget(g.id);
      const pct = ((d.spent / budget) * 100).toFixed(1);
      console.log(`    ${g.name}: $${d.spent.toFixed(2)} / $${budget} (${pct}%) — ${d.leads} leads`);
    });

    // Check for overspend alerts
    await checkAlerts();
  } catch (err) {
    fetchError = err.message;
    console.error(`  FETCH ERROR: ${err.message}`);
  }
}

// ── Slack alerts ──
// One message per client, in that client's own channel. Geos are grouped by
// workspace, so a client never sees another client's spend or totals.
async function checkAlerts() {
  if (!SLACK_BOT_TOKEN || !cachedData) return;
  for (const ws of getSlackWorkspaces()) {
    await postWorkspaceAlert(ws);
  }
}

async function postWorkspaceAlert(ws) {
  const alerts = [];

  getGeos(ws.id).forEach((g) => {
    const d = cachedData[g.id];
    const budget = getEffectiveBudget(g.id);
    const pct = d.spent / budget;

    if (pct >= 1) {
      const over = d.spent - budget;
      alerts.push(
        `:rotating_light: *${g.name}* is *$${Math.round(over).toLocaleString()} OVER* the $${budget.toLocaleString()} budget (${Math.round(pct * 100)}% spent)`
      );
    } else if (pct >= DANGER_THRESHOLD) {
      alerts.push(
        `:warning: *${g.name}* is at *${Math.round(pct * 100)}%* of budget — $${Math.round(d.spent).toLocaleString()} of $${budget.toLocaleString()}`
      );
    } else if (pct >= WARN_THRESHOLD) {
      alerts.push(
        `:eyes: *${g.name}* approaching budget — *${Math.round(pct * 100)}%* ($${Math.round(d.spent).toLocaleString()} of $${budget.toLocaleString()})`
      );
    }
  });

  if (alerts.length > 0) {
    // Both sides of this total must cover the same geos as the alert lines above,
    // and only this workspace's geos - another client's spend must never be
    // folded into a total shown against this client's budget.
    const wsGeos = getGeos(ws.id);
    const totalSpent = wsGeos.reduce((a, g) => a + cachedData[g.id].spent, 0);
    const totalBudget = wsGeos.reduce((a, g) => a + getEffectiveBudget(g.id), 0);

    const message = {
      text: `:bar_chart: *${ws.name} Budget Alert*\n\n${alerts.join("\n")}\n\n_Total: $${Math.round(totalSpent).toLocaleString()} / $${totalBudget.toLocaleString()} | ${new Date().toLocaleString()}_`,
    };

    const res = await postToSlack(ws.slackChannel, message, "ALERT");
    if (res && res.ok) console.log(`  Slack alert sent — ${ws.name} → ${ws.slackChannel}`);
  }
}

// ── Daily end-of-day lead summary to Slack ──
async function postDailyLeadSummary() {
  if (!SLACK_BOT_TOKEN) return;

  const today = getToday();
  const accountIds = getAllAccountIds();

  try {
    // Fetch once, then slice per client - every workspace reads the same
    // categorized payload, so N clients still cost one Meta round-trip.
    const raw = await fetchInsights(accountIds, today, today);
    const geoData = categorizeCampaigns(raw);

    for (const ws of getSlackWorkspaces()) {
      await postWorkspaceDailySummary(ws, geoData, today);
    }
  } catch (err) {
    console.error(`[DAILY SUMMARY] failed: ${err.message}`);
  }
}

async function postWorkspaceDailySummary(ws, geoData, today) {
  const wsGeos = getGeos(ws.id);
  {
    const lines = wsGeos.map((g) => {
      const d = geoData[g.id];
      const cpl = d.leads > 0 ? (d.spent / d.leads).toFixed(2) : "—";
      return `• *${g.name}*: *${d.leads} leads*  |  $${d.spent.toFixed(2)} spent  |  CPL $${cpl}`;
    });

    // Same scope as `lines` above — otherwise another client inflates the total.
    const totalLeads = wsGeos.reduce((a, g) => a + geoData[g.id].leads, 0);
    const totalSpent = wsGeos.reduce((a, g) => a + geoData[g.id].spent, 0);
    const totalCpl = totalLeads > 0 ? (totalSpent / totalLeads).toFixed(2) : "—";

    const message = {
      text: `:calendar: *${ws.name} — Daily Lead Summary* (${today})\n\n${lines.join("\n")}\n\n_Total: *${totalLeads} leads* / $${totalSpent.toFixed(2)} spent / avg CPL $${totalCpl}_`,
    };

    const res = await postToSlack(ws.slackChannel, message, "DAILY SUMMARY");
    if (res && res.ok) {
      console.log(`[DAILY SUMMARY] ${ws.name} → ${ws.slackChannel} (${totalLeads} leads / $${totalSpent.toFixed(2)})`);
    }
  }
}

// ── Weekly pacing check to Slack ──
// Compares MTD spend vs expected linear pace (day/days_in_month * budget).
// Flags geos more than PACE_THRESHOLD off, projects EOM spend.
async function postWeeklyPacingCheck() {
  if (!SLACK_BOT_TOKEN) return;

  // Make sure we compare against fresh numbers
  await refreshData();
  if (!cachedData) {
    console.error("[WEEKLY PACING] no cached data — skipping");
    return;
  }

  for (const ws of getSlackWorkspaces()) {
    await postWorkspacePacingCheck(ws);
  }
}

async function postWorkspacePacingCheck(ws) {
  const PACE_THRESHOLD = 0.10; // ±10% is "on pace"
  const daysInMonth = getDaysInMonth();
  const dayOfMonth = getDayOfMonth();
  const monthProgress = dayOfMonth / daysInMonth;

  const items = getGeos(ws.id).map((g) => {
    const d = cachedData[g.id];
    const budget = getEffectiveBudget(g.id);
    const spent = d.spent;
    const expected = budget * monthProgress;
    const projectedEOM = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0;
    const pacePct = expected > 0 ? spent / expected - 1 : 0;

    let status, icon;
    if (spent > budget) {
      status = "OVER BUDGET";
      icon = ":rotating_light:";
    } else if (pacePct > PACE_THRESHOLD) {
      status = "overpacing";
      icon = ":warning:";
    } else if (pacePct < -PACE_THRESHOLD) {
      status = "underpacing";
      icon = ":turtle:";
    } else {
      status = "on pace";
      icon = ":white_check_mark:";
    }

    return { g, budget, spent, expected, projectedEOM, pacePct, status, icon };
  });

  const anyOff = items.some((i) => i.status !== "on pace");

  const lines = items.map((i) => {
    const paceStr = `${i.pacePct >= 0 ? "+" : ""}${(i.pacePct * 100).toFixed(0)}%`;
    const projDelta = i.projectedEOM - i.budget;
    const projStr = projDelta >= 0
      ? `projected EOM $${Math.round(i.projectedEOM).toLocaleString()} (*+$${Math.round(projDelta).toLocaleString()} over*)`
      : `projected EOM $${Math.round(i.projectedEOM).toLocaleString()} ($${Math.round(-projDelta).toLocaleString()} under)`;
    return (
      `${i.icon} *${i.g.name}* — ${i.status} (${paceStr})\n` +
      `    Spent $${Math.round(i.spent).toLocaleString()} of $${i.budget.toLocaleString()} — expected $${Math.round(i.expected).toLocaleString()} by day ${dayOfMonth}/${daysInMonth}\n` +
      `    ${projStr}`
    );
  });

  const header = anyOff
    ? `:warning: *${ws.name} — Weekly Pacing Check*`
    : `:bar_chart: *${ws.name} — Weekly Pacing Check*`;
  const subheader = `Day ${dayOfMonth}/${daysInMonth} (${Math.round(monthProgress * 100)}% through month)`;

  const message = {
    text: `${header}\n_${subheader}_\n\n${lines.join("\n\n")}`,
  };

  const res = await postToSlack(ws.slackChannel, message, "WEEKLY PACING");
  if (res && res.ok) {
    const off = items.filter((i) => i.status !== "on pace").length;
    console.log(`[WEEKLY PACING] ${ws.name} → ${ws.slackChannel} (${off} off-pace)`);
  }
}

// ── Weekly results summary to Slack (Mon-Sun trailing week vs. prior week) ──
// Compares last 7 days against the 7 days before that, per geo.
// Flags CPL spikes and lead drops so Ben can spot problems fast.
function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function postWeeklyResultsSummary() {
  if (!SLACK_BOT_TOKEN) return;

  // Trailing 7-day window ending YESTERDAY vs the 7 days before that
  const yesterday = shiftDate(getToday(), -1);
  const thisEnd = yesterday;
  const thisStart = shiftDate(thisEnd, -6);
  const priorEnd = shiftDate(thisEnd, -7);
  const priorStart = shiftDate(priorEnd, -6);

  const accountIds = getAllAccountIds();

  try {
    const [thisRaw, priorRaw] = await Promise.all([
      fetchInsights(accountIds, thisStart, thisEnd),
      fetchInsights(accountIds, priorStart, priorEnd),
    ]);
    const thisGeo = categorizeCampaigns(thisRaw);
    const priorGeo = categorizeCampaigns(priorRaw);

    // Refresh MTD cachedData for pacing
    await refreshData();

    // Both Meta windows are fetched once above and sliced per client below.
    for (const ws of getSlackWorkspaces()) {
      await postWorkspaceWeeklyResults(ws, {
        thisGeo, priorGeo, thisStart, thisEnd, priorStart, priorEnd,
      });
    }
  } catch (err) {
    console.error(`[WEEKLY RESULTS] failed: ${err.message}`);
  }
}

async function postWorkspaceWeeklyResults(ws, ctx) {
  const { thisGeo, priorGeo, thisStart, thisEnd, priorStart, priorEnd } = ctx;
  {
    const daysInMonth = getDaysInMonth();
    const dayOfMonth = getDayOfMonth();
    const daysLeft = Math.max(0, daysInMonth - dayOfMonth);

    // ── Formatting helpers ──
    const $ = (n) => "$" + Math.round(n).toLocaleString();
    const $$ = (n) => "$" + n.toFixed(2);
    const pct = (cur, prev) => {
      if (prev > 0) return ((cur - prev) / prev) * 100;
      if (cur > 0) return 100;
      return 0;
    };
    const dateLabel = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${names[m - 1]} ${d}`;
    };
    const deltaText = (delta) => {
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
      const magnitude = Math.abs(delta).toFixed(0);
      return `${arrow} ${magnitude}%`;
    };

    // ── Per-geo analysis ──
    let totalThisSpend = 0, totalThisLeads = 0, totalPriorSpend = 0, totalPriorLeads = 0;
    const geoBlocks = [];

    for (const g of getGeos(ws.id)) {
      const t = thisGeo[g.id];
      const p = priorGeo[g.id];
      const tSpend = t.spent, tLeads = t.leads;
      const pSpend = p.spent, pLeads = p.leads;
      const tCpl = tLeads > 0 ? tSpend / tLeads : 0;
      const pCpl = pLeads > 0 ? pSpend / pLeads : 0;

      totalThisSpend += tSpend; totalThisLeads += tLeads;
      totalPriorSpend += pSpend; totalPriorLeads += pLeads;

      const leadDelta = pct(tLeads, pLeads);
      const cplDelta = pCpl > 0 && tCpl > 0 ? ((tCpl - pCpl) / pCpl) * 100 : 0;

      // Pacing math
      const budget = getEffectiveBudget(g.id);
      const mtdSpent = cachedData && cachedData[g.id] ? cachedData[g.id].spent : 0;
      const mtdPct = budget > 0 ? (mtdSpent / budget) * 100 : 0;
      // Project forward from what is ALREADY spent, at last week's daily rate.
      // Multiplying the weekly rate by the full month instead re-forecasts days
      // that have already happened — on day 29 of 31 that produced month-end
      // numbers the month could no longer arithmetically reach.
      const lastWeekDaily = tSpend / 7;
      const projectedEOM = mtdSpent + lastWeekDaily * daysLeft;

      // Verdict per geo — client wants to LAND on budget, so 95-105% is the sweet spot.
      // Under-spending is a problem (leaving money on the table) just like over-spending.
      let verdict;
      if (mtdSpent > budget) verdict = { icon: ":rotating_light:", label: "Over budget" };
      else if (projectedEOM > budget * 1.15) verdict = { icon: ":rotating_light:", label: "Over-pacing" };
      else if (projectedEOM > budget * 1.05) verdict = { icon: ":warning:", label: "Overshooting" };
      else if (projectedEOM < budget * 0.95) verdict = { icon: ":turtle:", label: "Under-spending" };
      else verdict = { icon: ":white_check_mark:", label: "On budget pace" };

      // Trend annotations (short, human)
      const trendLines = [];
      if (Math.abs(leadDelta) >= 3) {
        trendLines.push(`Leads ${deltaText(leadDelta)}` + (leadDelta < -20 && pLeads >= 5 ? " (needs attention)" : ""));
      } else {
        trendLines.push(`Leads steady (${tLeads} vs ${pLeads})`);
      }
      if (pCpl > 0 && tCpl > 0 && Math.abs(cplDelta) >= 3) {
        let cplNote = `Cost per lead ${deltaText(cplDelta)}`;
        if (cplDelta > 20) cplNote += " (spiked — investigate)";
        else if (cplDelta > 10) cplNote += " (creeping up)";
        else if (cplDelta < -10) cplNote += " (nice)";
        trendLines.push(cplNote);
      }

      const projRel = projectedEOM - budget;
      const projStr = projRel >= 0
        ? `projecting *${$(projectedEOM)}* EOM (${$(projRel)} over budget)`
        : `projecting *${$(projectedEOM)}* EOM (${$(-projRel)} under budget)`;

      const cplStr = tCpl > 0 ? `*${$$(tCpl)} per lead*` : "no leads yet";
      geoBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:round_pushpin: *${g.name}*   ${verdict.icon} _${verdict.label}_\n` +
            `*${tLeads} leads* · ${cplStr} · ${$(tSpend)} spent this week\n` +
            `${trendLines.join(" · ")}\n` +
            `_This month:_ ${$(mtdSpent)} / ${$(budget)} (${mtdPct.toFixed(0)}%) · ${projStr}`,
        },
      });
    }

    // ── Portfolio totals ──
    const totalCpl = totalThisLeads > 0 ? totalThisSpend / totalThisLeads : 0;
    const priorTotalCpl = totalPriorLeads > 0 ? totalPriorSpend / totalPriorLeads : 0;
    const totalLeadDelta = pct(totalThisLeads, totalPriorLeads);
    const totalCplDelta = priorTotalCpl > 0 && totalCpl > 0 ? ((totalCpl - priorTotalCpl) / priorTotalCpl) * 100 : 0;

    const wsGeos = getGeos(ws.id);
    const totalBudget = wsGeos.reduce((a, g) => a + getEffectiveBudget(g.id), 0);
    const totalMtd = wsGeos.reduce((a, g) => a + (cachedData && cachedData[g.id] ? cachedData[g.id].spent : 0), 0);
    const totalMtdPct = totalBudget > 0 ? (totalMtd / totalBudget) * 100 : 0;
    const totalProjectedEOM = totalMtd + (totalThisSpend / 7) * daysLeft;
    const totalProjDelta = totalProjectedEOM - totalBudget;

    // ── Headline verdict (plain English) ──
    // Priority order: budget-overshoot > under-spend > CPL spike > lead drop > lead surge > steady
    let headline, headlineIcon;
    if (totalProjDelta > totalBudget * 0.10) {
      headlineIcon = ":rotating_light:";
      headline = `Pacing hot — at last week's rate, month will land ${$(totalProjDelta)} over the ${$(totalBudget)} budget.`;
    } else if (totalProjDelta < -totalBudget * 0.10) {
      headlineIcon = ":turtle:";
      headline = `Under-spending — at last week's rate, month will finish ${$(-totalProjDelta)} short of the ${$(totalBudget)} budget. Room to scale up.`;
    } else if (totalCplDelta >= 25) {
      headlineIcon = ":rotating_light:";
      headline = `Cost per lead spiked ${totalCplDelta.toFixed(0)}% this week — needs attention.`;
    } else if (totalLeadDelta <= -15) {
      headlineIcon = ":warning:";
      headline = `Slow week — leads dropped ${Math.abs(totalLeadDelta).toFixed(0)}% vs last week. Worth reviewing creative or targeting.`;
    } else if (totalLeadDelta >= 10 && totalCplDelta <= 5) {
      headlineIcon = ":rocket:";
      headline = `Strong week — leads up ${totalLeadDelta.toFixed(0)}% with efficient cost per lead, and budget pacing is on target.`;
    } else if (totalLeadDelta >= 5 && totalCplDelta <= 15) {
      headlineIcon = ":white_check_mark:";
      headline = `Solid week — ${totalThisLeads} leads at ${$$(totalCpl)} each, up ${totalLeadDelta.toFixed(0)}% from last week. Budget on pace.`;
    } else {
      headlineIcon = ":white_check_mark:";
      headline = `On target — ${totalThisLeads} leads at ${$$(totalCpl)} each, and budget projected to land within 10% of ${$(totalBudget)}.`;
    }

    // Client wants to spend the FULL budget: 95-105% of budget is "landed on target",
    // >5% over is "will overshoot", <5% under is "under-spending" (money left on the table).
    let budgetStatus;
    if (totalProjDelta > totalBudget * 0.05) {
      budgetStatus = `Projecting *${$(totalProjectedEOM)}* by month-end — *${$(totalProjDelta)} over* the ${$(totalBudget)} budget. :warning:`;
    } else if (totalProjDelta < -totalBudget * 0.05) {
      budgetStatus = `Projecting *${$(totalProjectedEOM)}* by month-end — *${$(-totalProjDelta)} under* the ${$(totalBudget)} budget. Consider scaling to deploy the full budget.`;
    } else {
      budgetStatus = `Projecting *${$(totalProjectedEOM)}* by month-end — landing right on the ${$(totalBudget)} budget. :ok_hand:`;
    }

    // ── Build Slack blocks ──
    const blocks = [
      { type: "header", text: { type: "plain_text", text: `📊 ${ws.name} — Weekly Results — ${dateLabel(thisStart)} – ${dateLabel(thisEnd)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `_Compared to ${dateLabel(priorStart)} – ${dateLabel(priorEnd)}_` }] },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `${headlineIcon} *${headline}*` } },
      { type: "section", text: { type: "mrkdwn", text: `:moneybag: *Budget status*\n${$(totalMtd)} of ${$(totalBudget)} spent this month (${totalMtdPct.toFixed(0)}%, day ${dayOfMonth}/${daysInMonth}). ${budgetStatus}` } },
      { type: "divider" },
      ...geoBlocks,
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: `:bar_chart: Live dashboard: <${ws.dashboardUrl}|${ws.dashboardUrl.split("//").pop()}> · Next update: Monday 10 PM EST` }] },
    ];

    // Plain-text fallback for notifications and clients that don't render blocks
    const fallback = `${ws.name} Weekly Results ${dateLabel(thisStart)}-${dateLabel(thisEnd)}: ${totalThisLeads} leads @ ${$$(totalCpl)} · ${$(totalThisSpend)} spent · MTD ${totalMtdPct.toFixed(0)}% of budget`;

    const res = await postToSlack(ws.slackChannel, { text: fallback, blocks }, "WEEKLY RESULTS");
    if (res && res.ok) {
      console.log(`[WEEKLY RESULTS] ${ws.name} → ${ws.slackChannel} (${totalThisLeads} leads / $${totalThisSpend.toFixed(2)} vs ${totalPriorLeads} / $${totalPriorSpend.toFixed(2)})`);
    }
  }
}

// ── Middleware ──
// One proxy hop (Nginx). Without this req.ip is always 127.0.0.1 and the
// login rate limiter would lock out every visitor at once.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

// The dashboard is same-origin and loads no third-party assets, so a tight
// CSP costs nothing. 'unsafe-inline' is required only because index.html
// carries its script and styles inline.
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
});

// ── Auth gate ──
// Everything except these paths requires a valid session. This runs BEFORE
// express.static, so index.html itself is protected — previously the page was
// served to anyone and only /api was gated.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/login", "/favicon.ico"]);

app.use((req, res, next) => {
  if (!auth.AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  // CI smoke-tests /api/health over loopback, before any browser session exists.
  if (req.path === "/api/health" && auth.isLoopbackDirect(req)) return next();

  const user = auth.sessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }

  // API callers get a status they can act on; browsers get sent to the form.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect(302, "/login");
});

// ── Access scope ──
// req.user is { username, role, workspaces } — or undefined when auth is off
// entirely (local dev), which is treated as admin so nothing is gated away
// from a developer running without .env credentials.
//
// A client sees only the workspaces on its record. That is enforced HERE, on
// every read path, not in the UI: hiding the sidebar stops the honest visitor,
// but ?workspace=someone-else is one keystroke away, so the server refuses it.
function isAdmin(req) {
  return !req.user || req.user.role === "admin";
}

// null means "no restriction"; otherwise a Set of the workspace ids allowed.
function allowedWorkspaces(req) {
  if (isAdmin(req)) return null;
  return new Set(req.user.workspaces || []);
}

function canSeeWorkspace(req, workspaceId) {
  const allowed = allowedWorkspaces(req);
  return !allowed || allowed.has(workspaceId);
}

function visibleWorkspaces(req) {
  const allowed = allowedWorkspaces(req);
  return getWorkspaces().filter((w) => !allowed || allowed.has(w.id));
}

// Anything that CHANGES configuration — accounts, logins, budgets, Slack
// routing — is the admin's alone. Returns true when it has already answered.
function denyNonAdmin(req, res) {
  if (isAdmin(req)) return false;
  res.status(403).json({ error: "Admin access required" });
  return true;
}

app.get("/login", (req, res) => {
  if (auth.AUTH_ENABLED && auth.sessionUser(req)) return res.redirect(302, "/");
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // never cache HTML so UI updates take effect on the next page load, not after a manual hard-refresh
    if (filePath.endsWith(".html")) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
    }
  },
}));


// ── API Routes ──

// GET /api/workspaces — sidebar rows, with a live spend total per workspace.
// A client gets only its own row(s); it never learns another client exists.
app.get("/api/workspaces", (req, res) => {
  const visible = visibleWorkspaces(req);
  res.json({
    workspaces: visible.map((w) => {
      const geos = getGeos(w.id);
      const spent = geos.reduce(
        (a, g) => a + (cachedData && cachedData[g.id] ? cachedData[g.id].spent : 0),
        0
      );
      const budget = geos.reduce((a, g) => a + getEffectiveBudget(g.id), 0);
      return {
        id: w.id,
        name: w.name,
        geoCount: geos.length,
        spent,
        budget,
        pctSpent: budget > 0 ? (spent / budget) * 100 : 0,
        // Seed workspaces live in config.js and can't be edited from the UI;
        // only UI-added ones expose the edit/remove controls.
        editable: isAdmin(req) && isEditable(w.id),
        accountId: w.accountId || null,
        slackChannel: w.slackChannel || null,
      };
    }),
    // The client's own account, not the global default it cannot open.
    active: canSeeWorkspace(req, DEFAULT_WORKSPACE)
      ? DEFAULT_WORKSPACE
      : (visible[0] || {}).id || null,
    role: isAdmin(req) ? "admin" : "client",
  });
});

// GET /api/dashboard — main dashboard data
app.get("/api/dashboard", (req, res) => {
  const today = new Date();
  const daysInMonth = getDaysInMonth();
  const dayOfMonth = getDayOfMonth();
  const daysLeft = daysInMonth - dayOfMonth;

  // ?workspace= is a request, not a grant: a client asking for an account it
  // is not scoped to falls back to its own rather than seeing another's spend.
  const requested = String(req.query.workspace || "");
  const fallback = canSeeWorkspace(req, DEFAULT_WORKSPACE)
    ? DEFAULT_WORKSPACE
    : (visibleWorkspaces(req)[0] || {}).id;
  const wsId =
    getWorkspace(requested) && canSeeWorkspace(req, requested) ? requested : fallback;

  if (!wsId) {
    return res.status(403).json({ error: "This login has no accounts assigned to it." });
  }

  const geos = getGeos(wsId).map((g) => {
    const data = cachedData ? cachedData[g.id] : { spent: 0, leads: 0, campaigns: [] };
    const weekData = cachedWeekData ? cachedWeekData[g.id] : null;
    const budget = getEffectiveBudget(g.id);
    const remaining = Math.max(0, budget - data.spent);
    const dailyTarget = budget / daysInMonth;
    const actualDaily = dayOfMonth > 0 ? data.spent / dayOfMonth : 0;
    // "Your daily avg" now reflects the last 7 days' pace (matches Slack's forward-looking view).
    // Falls back to MTD average early in the month if week data unavailable yet.
    const weekDaily = weekData ? weekData.spent / 7 : actualDaily;
    // MTD actual + remaining days at last week's rate (see postWeeklyResultsSummary).
    const projectedEOM = data.spent + weekDaily * daysLeft;
    const recDaily = daysLeft > 0 ? remaining / daysLeft : 0;
    const cpl = data.leads > 0 ? data.spent / data.leads : 0;

    // Status matches the Slack weekly-results verdicts.
    // Client goal: spend the FULL budget — landing 95-105% is the sweet spot.
    // Under-spending (projected < 95%) is flagged just like over-spending.
    let status = "on_track";
    if (data.spent > budget) status = "over_budget";
    else if (projectedEOM > budget * 1.15) status = "over_budget";
    else if (projectedEOM > budget * 1.05) status = "at_risk";
    else if (projectedEOM < budget * 0.95) status = "under_pacing";

    return {
      id: g.id,
      name: g.name,
      color: g.color,
      budget,
      spent: data.spent,
      leads: data.leads,
      remaining,
      daysLeft,
      daysInMonth,
      dayOfMonth,
      dailyTarget,
      actualDaily,     // legacy: MTD average
      weekDaily,       // trailing-7-day average — what "Your daily avg" now shows
      projectedEOM,    // projected using weekDaily
      recDaily,
      cpl,
      // Landing-page + fatigue + creative-health metrics
      impressions: data.impressions || 0,
      clicks: data.clicks || 0,
      reach: data.reach || 0,
      frequency: (data.reach || 0) > 0 ? (data.impressions || 0) / data.reach : 0,
      ctr: (data.impressions || 0) > 0 ? ((data.clicks || 0) / data.impressions) * 100 : 0,
      clickToLead: (data.clicks || 0) > 0 ? (data.leads / data.clicks) * 100 : 0,
      // Trailing 7-day lead volume for velocity tracking
      weekLeads: weekData ? weekData.leads : 0,
      status,
      pctSpent: (data.spent / budget) * 100,
      campaigns: data.campaigns || [],
    };
  });

  const totalBudget = geos.reduce((a, g) => a + g.budget, 0);
  const totalSpent = geos.reduce((a, g) => a + g.spent, 0);
  const totalLeads = geos.reduce((a, g) => a + g.leads, 0);

  res.json({
    geos,
    summary: {
      totalBudget,
      totalSpent,
      totalOver: totalSpent - totalBudget,
      totalLeads,
      avgCpl: totalLeads > 0 ? totalSpent / totalLeads : 0,
    },
    meta: {
      lastFetched: lastFetchTime,
      error: fetchError,
      month: today.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      refreshIntervalMinutes: REFRESH_MINUTES,
      workspace: wsId,
      workspaceName: (getWorkspace(wsId) || {}).name || wsId,
    },
  });
});

// ── Meta ad-account discovery ──
// Lists every ad account the token can reach, so accounts are picked from a
// real list instead of typed from memory. Cached briefly: the list changes
// rarely and the picker re-queries on every keystroke-free open.
let adAccountCache = { at: 0, accounts: null };
const AD_ACCOUNT_TTL_MS = 5 * 60 * 1000;

async function fetchAdAccounts() {
  if (!META_ACCESS_TOKEN) {
    throw new Error("No Meta token configured — set META_ACCESS_TOKEN in .env");
  }
  if (adAccountCache.accounts && Date.now() - adAccountCache.at < AD_ACCOUNT_TTL_MS) {
    return adAccountCache.accounts;
  }

  let url =
    `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?` +
    new URLSearchParams({
      fields: "id,name,account_status,currency,timezone_name,business_name",
      limit: "200",
      access_token: META_ACCESS_TOKEN,
    });

  const accounts = [];
  while (url) {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) {
      throw metaError("me/adaccounts", response.status, body);
    }
    if (Array.isArray(body.data)) accounts.push(...body.data);
    url = (body.paging && body.paging.next) || null;
  }

  // 1 = ACTIVE. Everything else (closed, disabled, unsettled) still shows,
  // flagged, because a paused account is a legitimate thing to add early.
  const mapped = accounts.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    business: a.business_name || null,
    currency: a.currency || null,
    timezone: a.timezone_name || null,
    active: a.account_status === 1,
  }));
  mapped.sort((a, b) => a.name.localeCompare(b.name));
  adAccountCache = { at: Date.now(), accounts: mapped };
  return mapped;
}

// GET /api/meta/adaccounts?q= — searchable list for the account picker
app.get("/api/meta/adaccounts", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  try {
    const all = await fetchAdAccounts();
    const used = getUsedAccountIds();
    const q = String(req.query.q || "").trim().toLowerCase();
    const matches = q
      ? all.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.id.toLowerCase().includes(q) ||
            (a.business && a.business.toLowerCase().includes(q))
        )
      : all;
    res.json({
      accounts: matches.map((a) => ({ ...a, added: used.has(a.id) })),
      total: all.length,
      matched: matches.length,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Slack channel routing ──
// Every workspace's channel lives in one map in accounts.json, so seed and
// UI-added clients are read and written through the same two endpoints.

// GET /api/channels — the routing table behind the "Slack channels" dialog
app.get("/api/channels", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  res.json({
    channels: getWorkspaces().map((w) => ({
      id: w.id,
      name: w.name,
      slackChannel: w.slackChannel,
      geoCount: getGeos(w.id).length,
    })),
    botConfigured: Boolean(SLACK_BOT_TOKEN),
    opsChannel: SLACK_OPS_CHANNEL || null,
  });
});

// PUT /api/channels/:id — set or clear one workspace's Slack channel.
// An empty value clears it, which stops that client's messages without
// removing the account from the dashboard.
app.put("/api/channels/:id", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  try {
    const channel = setChannel(req.params.id, (req.body || {}).slackChannel);
    console.log(
      `[CHANNELS] ${req.params.id} → ${channel || "none (Slack off for this client)"}`
    );
    res.json({ success: true, id: req.params.id, slackChannel: channel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/accounts — add an ad account as a new workspace, plus the login
// that client will use to reach it. The two are created together so an
// account never exists on the dashboard with no way for its owner to see it.
app.post("/api/accounts", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  const { accountId, accountName, name, monthlyBudget, slackChannel, username, password } =
    req.body || {};

  // Validate the login BEFORE the workspace is written, so a rejected
  // username or password can't leave a half-built account behind.
  try {
    users.validateUsername(username, { reservedAdmin: auth.AUTH_USERNAME });
    users.validatePassword(password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let created;
  try {
    created = addAccount({ accountId, accountName, name, monthlyBudget, slackChannel });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let login;
  try {
    login = users.addUser({
      username,
      password,
      workspaces: [created.id],
      reservedAdmin: auth.AUTH_USERNAME,
    });
  } catch (err) {
    // Pre-validated above, so this is a genuine surprise (a failed write, say)
    // — undo the workspace rather than strand it without a login.
    removeAccount(created.id);
    return res.status(400).json({ error: err.message });
  }

  console.log(
    `[ACCOUNTS] added ${created.name} (${created.accountId}) — login "${login.username}"` +
      (created.slackChannel ? ` → Slack ${created.slackChannel}` : " — no Slack channel")
  );

  // Pull the new account's numbers straight away so its card isn't blank
  // until the next hourly refresh.
  await refreshData();
  res.json({ success: true, workspace: created, login: login.username });
});

// PATCH /api/accounts/:id — edit a UI-added account (Slack channel, name, budget)
app.patch("/api/accounts/:id", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  try {
    const updated = updateAccount(req.params.id, req.body || {});
    console.log(
      `[ACCOUNTS] updated ${updated.name} — Slack ${updated.slackChannel || "none"}`
    );
    res.json({ success: true, workspace: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id — remove a UI-added account
app.delete("/api/accounts/:id", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  try {
    const removed = removeAccount(req.params.id);
    // A login that existed only for this account goes with it — otherwise it
    // would survive as a session that can see nothing.
    const droppedLogins = users.detachWorkspace(req.params.id);
    console.log(
      `[ACCOUNTS] removed ${removed.name} (${removed.accountId})` +
        (droppedLogins.length ? ` — logins removed: ${droppedLogins.join(", ")}` : "")
    );
    await refreshData();
    res.json({ success: true, workspace: removed, removedLogins: droppedLogins });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/budget — update budget for a geo
app.post("/api/budget", (req, res) => {
  // Budgets drive pacing and the alert thresholds — a client views them, the
  // admin sets them.
  if (denyNonAdmin(req, res)) return;
  const { geoId, budget } = req.body;
  if (!geoId || budget === undefined) {
    return res.status(400).json({ error: "geoId and budget required" });
  }
  budgetOverrides[geoId] = parseFloat(budget);
  saveBudgetOverrides(budgetOverrides);
  res.json({ success: true, geoId, budget: budgetOverrides[geoId] });
});

// POST /api/refresh — manual refresh
app.post("/api/refresh", async (req, res) => {
  await refreshData();
  res.json({ success: true, lastFetched: lastFetchTime, error: fetchError });
});

// POST /api/daily-summary — manually trigger the daily Slack summary (for testing)
app.post("/api/daily-summary", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  await postDailyLeadSummary();
  res.json({ success: true });
});

// POST /api/pacing-check — manually trigger the weekly pacing Slack summary (for testing)
app.post("/api/pacing-check", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  await postWeeklyPacingCheck();
  res.json({ success: true });
});

// POST /api/weekly-results — manually trigger the weekly results summary (for testing)
app.post("/api/weekly-results", async (req, res) => {
  if (denyNonAdmin(req, res)) return;
  await postWeeklyResultsSummary();
  res.json({ success: true });
});

// GET /api/health — health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    lastFetched: lastFetchTime,
    error: fetchError,
    token: tokenExpiry,
    uptime: process.uptime(),
  });
});

// ── Auth routes ──
app.post("/api/login", (req, res) => {
  if (!auth.AUTH_ENABLED) return res.json({ success: true });

  const limit = auth.rateLimitStatus(req);
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfter));
    return res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`,
      retryAfter: limit.retryAfter,
    });
  }

  const { username, password } = req.body || {};

  // Returns the identity behind the credentials — the admin from .env, or a
  // client login from users.json — so the cookie is signed for whoever it is.
  const identity = auth.verifyCredentials(username, password);
  if (identity) {
    auth.recordSuccess(req);
    auth.setSessionCookie(req, res, auth.issueToken(identity.username));
    console.log(`[AUTH] Login OK — ${identity.username} (${identity.role}) from ${req.ip}`);
    return res.json({ success: true, role: identity.role });
  }

  const result = auth.recordFailure(req);
  console.warn(`[AUTH] Failed login from ${req.ip}${result.locked ? " — now locked out" : ""}`);
  // Deliberately vague: never reveal which half was wrong.
  return res.status(401).json({
    error: result.locked
      ? "Too many attempts. Locked out for 15 minutes."
      : "Incorrect username or password.",
    remaining: result.remaining,
  });
});

app.post("/api/logout", (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ success: true });
});

app.get("/api/me", (req, res) => {
  // With auth off there is no session at all; the UI treats that as admin,
  // which matches what the API already allows in that mode.
  res.json({
    username: req.user ? req.user.username : null,
    role: isAdmin(req) ? "admin" : "client",
    workspaces: req.user && req.user.workspaces ? req.user.workspaces : null,
    authEnabled: auth.AUTH_ENABLED,
  });
});

// ── Dashboard logins (admin only) ──
// One login per client, scoped to the ad account(s) it may open. The admin's
// own credentials are not here — they live in .env and cannot be edited from
// the UI, so no session can ever remove or re-scope the account that governs
// every other one.

// GET /api/users — the rows behind the "Dashboard logins" dialog
app.get("/api/users", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  const names = new Map(getWorkspaces().map((w) => [w.id, w.name]));
  res.json({
    admin: auth.AUTH_USERNAME || null,
    minPassword: users.MIN_PASSWORD,
    users: users.listUsers().map((u) => ({
      ...u,
      // A workspace can be deleted straight out of config.js, so resolve the
      // label defensively rather than assuming every id still exists.
      workspaceNames: u.workspaces.map((id) => names.get(id) || id),
    })),
    workspaces: getWorkspaces().map((w) => ({ id: w.id, name: w.name })),
  });
});

// POST /api/users — add a login for an account that already exists
app.post("/api/users", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  const { username, password, workspaces } = req.body || {};
  const scope = Array.isArray(workspaces) ? workspaces : [workspaces].filter(Boolean);
  const known = new Set(getWorkspaces().map((w) => w.id));
  const unknown = scope.filter((id) => !known.has(id));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown account: ${unknown.join(", ")}` });
  }
  try {
    const created = users.addUser({
      username,
      password,
      workspaces: scope,
      reservedAdmin: auth.AUTH_USERNAME,
    });
    console.log(`[USERS] added login "${created.username}" → ${created.workspaces.join(", ")}`);
    res.json({ success: true, user: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/users/:username — reset the password, or re-scope which
// accounts the login can open
app.patch("/api/users/:username", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  const { password, workspaces } = req.body || {};
  try {
    let result = null;
    if (workspaces !== undefined) {
      const scope = Array.isArray(workspaces) ? workspaces : [workspaces].filter(Boolean);
      const known = new Set(getWorkspaces().map((w) => w.id));
      const unknown = scope.filter((id) => !known.has(id));
      if (unknown.length) {
        return res.status(400).json({ error: `Unknown account: ${unknown.join(", ")}` });
      }
      result = users.setWorkspaces(req.params.username, scope);
    }
    if (password !== undefined && password !== "") {
      result = users.setPassword(req.params.username, password);
    }
    if (!result) return res.status(400).json({ error: "Nothing to change" });
    console.log(`[USERS] updated login "${result.username}"`);
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/users/:username — revoke a login. The next request on its
// cookie resolves to nobody, so an open tab is signed out immediately.
app.delete("/api/users/:username", (req, res) => {
  if (denyNonAdmin(req, res)) return;
  try {
    const removed = users.removeUser(req.params.username);
    console.log(`[USERS] removed login "${removed.username}"`);
    res.json({ success: true, user: removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Cron: auto-refresh ──
const cronExpr = `*/${REFRESH_MINUTES} * * * *`;
cron.schedule(cronExpr, () => {
  console.log(`[CRON] Auto-refresh triggered`);
  refreshData();
});

// ── Cron: daily lead summary at 11:55 PM Pacific (end of Ben's business day) ──
cron.schedule(
  "55 23 * * *",
  () => {
    console.log(`[CRON] Daily lead summary triggered`);
    postDailyLeadSummary();
  },
  { timezone: "America/Los_Angeles" }
);

// ── Cron: weekly pacing check every Monday 9 AM EST ──
cron.schedule(
  "0 9 * * 1",
  () => {
    console.log(`[CRON] Weekly pacing check triggered`);
    postWeeklyPacingCheck();
  },
  { timezone: "America/New_York" }
);

// ── Cron: weekly results summary every Monday 10 PM EST ──
cron.schedule(
  "0 22 * * 1",
  () => {
    console.log(`[CRON] Weekly results summary triggered`);
    postWeeklyResultsSummary();
  },
  { timezone: "America/New_York" }
);

// ── Cron: token expiry check daily at 9 AM Pacific ──
cron.schedule(
  "0 9 * * *",
  () => {
    console.log(`[CRON] Token expiry check triggered`);
    checkTokenExpiry();
  },
  { timezone: "America/Los_Angeles" }
);

// ── Start server ──
app.listen(PORT, async () => {
  console.log(`\n========================================`);
  console.log(`  Ben ADU Budget Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Auto-refresh: every ${REFRESH_MINUTES} minutes`);
  if (SLACK_BOT_TOKEN) {
    const routed = getSlackWorkspaces();
    const all = getWorkspaces();
    console.log(`  Slack: bot token set — ${routed.length} of ${all.length} workspace(s) routed`);
    all.forEach((w) => {
      const dest = w.slackChannel ? w.slackChannel : "no channel — silent";
      console.log(`    ${w.name}: ${dest}`);
    });
    console.log(`    [ops alerts]: ${SLACK_OPS_CHANNEL || "no channel — token warnings disabled"}`);
  } else {
    console.log("  Slack: disabled (no SLACK_BOT_TOKEN)");
  }
  if (auth.AUTH_ENABLED) {
    const clients = users.listUsers();
    console.log(
      `  Login: required — admin "${auth.AUTH_USERNAME}" + ${clients.length} client login(s)` +
        `, ${auth.SESSION_HOURS}h sessions`
    );
    clients.forEach((u) => console.log(`    ${u.username} → ${u.workspaces.join(", ") || "(no account)"}`));
  } else {
    console.warn(`  Login: DISABLED — anyone who can reach this port sees the dashboard.`);
    console.warn(`         Set AUTH_USERNAME, AUTH_PASSWORD_HASH and SESSION_SECRET in .env.`);
  }
  console.log(`========================================\n`);

  await checkTokenExpiry();

  // Initial data fetch
  await refreshData();
});
