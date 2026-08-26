require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const { GEOS, getAllAccountIds } = require("./config");

const app = express();
const PORT = process.env.PORT || 3500;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = process.env.META_API_VERSION || "v26.0";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const WARN_THRESHOLD = parseInt(process.env.ALERT_WARN_THRESHOLD || "80") / 100;
const DANGER_THRESHOLD = parseInt(process.env.ALERT_DANGER_THRESHOLD || "95") / 100;
const REFRESH_MINUTES = parseInt(process.env.REFRESH_INTERVAL_MINUTES || "60");
const TOKEN_WARN_DAYS = parseInt(process.env.TOKEN_WARN_DAYS || "7");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

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
  const geo = GEOS.find((g) => g.id === geoId);
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

// ── Slack warning for a dying token ──
// Without this, an expired token looks identical to a quiet week: the numbers
// simply stop moving, and nobody notices until a budget has already blown past.
async function postTokenWarning() {
  if (!SLACK_WEBHOOK || !tokenExpiry) return;

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

  try {
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
    lastTokenWarnDate = today;
    console.log("  [TOKEN] Slack expiry warning sent");
  } catch (err) {
    console.error(`  [TOKEN] Slack warning failed: ${err.message}`);
  }
}

// ── Categorize campaigns into geos ──
function categorizeCampaigns(apiResults) {
  const geoData = {};
  GEOS.forEach((g) => {
    geoData[g.id] = { spent: 0, leads: 0, impressions: 0, clicks: 0, reach: 0, campaigns: [] };
  });

  // apiResults can be in different formats depending on API used
  // Normalize to array of { accountId, campaigns: [...] }
  const accountResults = normalizeResults(apiResults);

  accountResults.forEach(({ accountId, campaigns }) => {
    campaigns.forEach((camp) => {
      const name = camp.campaign_name || camp.name || "";
      const spend = parseFloat(camp.spend || 0);

      // Extract lead count from actions
      let leads = 0;
      if (camp.actions) {
        const leadAction = camp.actions.find(
          (a) =>
            a.action_type === "offsite_conversion.fb_pixel_lead" ||
            a.action_type === "lead"
        );
        if (leadAction) leads = parseInt(leadAction.value || 0);
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

      // Match campaign to geo based on config rules
      GEOS.forEach((geo) => {
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
    GEOS.forEach((g) => {
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
async function checkAlerts() {
  if (!SLACK_WEBHOOK || !cachedData) return;

  const alerts = [];

  GEOS.forEach((g) => {
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
    const totalSpent = Object.values(cachedData).reduce((a, d) => a + d.spent, 0);
    const totalBudget = GEOS.reduce((a, g) => a + getEffectiveBudget(g.id), 0);

    const message = {
      text: `:bar_chart: *Ben ADU Budget Alert*\n\n${alerts.join("\n")}\n\n_Total: $${Math.round(totalSpent).toLocaleString()} / $${totalBudget.toLocaleString()} | ${new Date().toLocaleString()}_`,
    };

    try {
      await fetch(SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      console.log("  Slack alert sent");
    } catch (err) {
      console.error(`  Slack alert failed: ${err.message}`);
    }
  }
}

// ── Daily end-of-day lead summary to Slack ──
async function postDailyLeadSummary() {
  if (!SLACK_WEBHOOK) return;

  const today = getToday();
  const accountIds = getAllAccountIds();

  try {
    const raw = await fetchInsights(accountIds, today, today);
    const geoData = categorizeCampaigns(raw);

    const lines = GEOS.map((g) => {
      const d = geoData[g.id];
      const cpl = d.leads > 0 ? (d.spent / d.leads).toFixed(2) : "—";
      return `• *${g.name}*: *${d.leads} leads*  |  $${d.spent.toFixed(2)} spent  |  CPL $${cpl}`;
    });

    const totalLeads = Object.values(geoData).reduce((a, d) => a + d.leads, 0);
    const totalSpent = Object.values(geoData).reduce((a, d) => a + d.spent, 0);
    const totalCpl = totalLeads > 0 ? (totalSpent / totalLeads).toFixed(2) : "—";

    const message = {
      text: `:calendar: *Ben ADU — Daily Lead Summary* (${today})\n\n${lines.join("\n")}\n\n_Total: *${totalLeads} leads* / $${totalSpent.toFixed(2)} spent / avg CPL $${totalCpl}_`,
    };

    const r = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    console.log(`[DAILY SUMMARY] posted (${totalLeads} leads / $${totalSpent.toFixed(2)}) — Slack ${r.status}`);
  } catch (err) {
    console.error(`[DAILY SUMMARY] failed: ${err.message}`);
  }
}

// ── Weekly pacing check to Slack ──
// Compares MTD spend vs expected linear pace (day/days_in_month * budget).
// Flags geos more than PACE_THRESHOLD off, projects EOM spend.
async function postWeeklyPacingCheck() {
  if (!SLACK_WEBHOOK) return;

  // Make sure we compare against fresh numbers
  await refreshData();
  if (!cachedData) {
    console.error("[WEEKLY PACING] no cached data — skipping");
    return;
  }

  const PACE_THRESHOLD = 0.10; // ±10% is "on pace"
  const daysInMonth = getDaysInMonth();
  const dayOfMonth = getDayOfMonth();
  const monthProgress = dayOfMonth / daysInMonth;

  const items = GEOS.map((g) => {
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
    ? ":warning: *Ben ADU — Weekly Pacing Check*"
    : ":bar_chart: *Ben ADU — Weekly Pacing Check*";
  const subheader = `Day ${dayOfMonth}/${daysInMonth} (${Math.round(monthProgress * 100)}% through month)`;

  const message = {
    text: `${header}\n_${subheader}_\n\n${lines.join("\n\n")}`,
  };

  try {
    const r = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    console.log(`[WEEKLY PACING] posted (${items.filter((i) => i.status !== "on pace").length} off-pace) — Slack ${r.status}`);
  } catch (err) {
    console.error(`[WEEKLY PACING] failed: ${err.message}`);
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
  if (!SLACK_WEBHOOK) return;

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
    const daysInMonth = getDaysInMonth();
    const dayOfMonth = getDayOfMonth();

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

    for (const g of GEOS) {
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
      const lastWeekDaily = tSpend / 7;
      const projectedEOM = lastWeekDaily * daysInMonth;

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

    const totalBudget = GEOS.reduce((a, g) => a + getEffectiveBudget(g.id), 0);
    const totalMtd = GEOS.reduce((a, g) => a + (cachedData && cachedData[g.id] ? cachedData[g.id].spent : 0), 0);
    const totalMtdPct = totalBudget > 0 ? (totalMtd / totalBudget) * 100 : 0;
    const totalProjectedEOM = (totalThisSpend / 7) * daysInMonth;
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
      { type: "header", text: { type: "plain_text", text: `📊 Weekly Results — ${dateLabel(thisStart)} – ${dateLabel(thisEnd)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `_Compared to ${dateLabel(priorStart)} – ${dateLabel(priorEnd)}_` }] },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `${headlineIcon} *${headline}*` } },
      { type: "section", text: { type: "mrkdwn", text: `:moneybag: *Budget status*\n${$(totalMtd)} of ${$(totalBudget)} spent this month (${totalMtdPct.toFixed(0)}%, day ${dayOfMonth}/${daysInMonth}). ${budgetStatus}` } },
      { type: "divider" },
      ...geoBlocks,
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: `:bar_chart: Live dashboard: <https://ben.blendfoldmedia.com|ben.blendfoldmedia.com> · Next update: Monday 10 PM EST` }] },
    ];

    // Plain-text fallback for notifications and clients that don't render blocks
    const fallback = `Ben ADU Weekly Results ${dateLabel(thisStart)}-${dateLabel(thisEnd)}: ${totalThisLeads} leads @ ${$$(totalCpl)} · ${$(totalThisSpend)} spent · MTD ${totalMtdPct.toFixed(0)}% of budget`;

    const r = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fallback, blocks }),
    });
    console.log(`[WEEKLY RESULTS] posted (${totalThisLeads} leads / $${totalThisSpend.toFixed(2)} vs ${totalPriorLeads} / $${totalPriorSpend.toFixed(2)}) — Slack ${r.status}`);
  } catch (err) {
    console.error(`[WEEKLY RESULTS] failed: ${err.message}`);
  }
}

// ── Middleware ──
app.use(express.json());
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

// Optional password protection
if (DASHBOARD_PASSWORD) {
  app.use("/api", (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${DASHBOARD_PASSWORD}`) return next();
    // Allow if session cookie matches
    if (req.headers.cookie && req.headers.cookie.includes(`dash_auth=${DASHBOARD_PASSWORD}`)) return next();
    res.status(401).json({ error: "Unauthorized" });
  });
}

// ── API Routes ──

// GET /api/dashboard — main dashboard data
app.get("/api/dashboard", (req, res) => {
  const today = new Date();
  const daysInMonth = getDaysInMonth();
  const dayOfMonth = getDayOfMonth();
  const daysLeft = daysInMonth - dayOfMonth;

  const geos = GEOS.map((g) => {
    const data = cachedData ? cachedData[g.id] : { spent: 0, leads: 0, campaigns: [] };
    const weekData = cachedWeekData ? cachedWeekData[g.id] : null;
    const budget = getEffectiveBudget(g.id);
    const remaining = Math.max(0, budget - data.spent);
    const dailyTarget = budget / daysInMonth;
    const actualDaily = dayOfMonth > 0 ? data.spent / dayOfMonth : 0;
    // "Your daily avg" now reflects the last 7 days' pace (matches Slack's forward-looking view).
    // Falls back to MTD average early in the month if week data unavailable yet.
    const weekDaily = weekData ? weekData.spent / 7 : actualDaily;
    const projectedEOM = weekDaily * daysInMonth;
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
    },
  });
});

// POST /api/budget — update budget for a geo
app.post("/api/budget", (req, res) => {
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
  await postDailyLeadSummary();
  res.json({ success: true });
});

// POST /api/pacing-check — manually trigger the weekly pacing Slack summary (for testing)
app.post("/api/pacing-check", async (req, res) => {
  await postWeeklyPacingCheck();
  res.json({ success: true });
});

// POST /api/weekly-results — manually trigger the weekly results summary (for testing)
app.post("/api/weekly-results", async (req, res) => {
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

// Auth endpoint for password-protected dashboards
app.post("/api/auth", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ success: true });
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.setHeader("Set-Cookie", `dash_auth=${DASHBOARD_PASSWORD}; HttpOnly; Path=/; Max-Age=86400`);
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Wrong password" });
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
  console.log(`  Slack alerts: ${SLACK_WEBHOOK ? "enabled" : "disabled"}`);
  console.log(`  Password: ${DASHBOARD_PASSWORD ? "enabled" : "disabled"}`);
  console.log(`========================================\n`);

  await checkTokenExpiry();

  // Initial data fetch
  await refreshData();
});
