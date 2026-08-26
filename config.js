// =====================================================
// WORKSPACE + GEO CONFIGURATION
// =====================================================
// A WORKSPACE is one client/brand shown as a row in the sidebar.
// Each workspace owns a set of geo cards. GEOS stays a single flat
// list — categorizeCampaigns() and the budget overrides both key off
// geo.id, so ids must stay unique across workspaces.
//
// Ben ADU:
//   LA County = FL account (ALL campaigns EXCEPT "Pacific")
//             + Pacific account (campaigns with "LA" in name)
//   OC        = Pacific account (campaigns with "OC" in name)
//   SJ        = Pacific account (campaigns with "SJ" in name)
//   Green V2  = Green V2 account (ALL campaigns)
// =====================================================

const WORKSPACES = [
  {
    id: "ben-adu",
    name: "Ben ADU",
    // Slack alerts and the daily/weekly summaries only cover workspaces
    // with this on, so adding a client can't start spamming Ben's channel.
    slackAlerts: true,
  },
  {
    id: "perstrive",
    name: "Perstrive",
    slackAlerts: false,
  },
];

const GEOS = [
  // ── Ben ADU ──────────────────────────────────────────
  {
    id: "la",
    workspace: "ben-adu",
    name: "ADU — LA County",
    monthlyBudget: 50000,
    color: "#e34948",
    accounts: [
      {
        accountId: "act_598233003217290",
        label: "FL",
        // Include ALL campaigns EXCEPT ones with "Pacific" in name
        excludeKeywords: ["Pacific"],
        includeKeywords: null, // null = include all (after excludes)
      },
      {
        accountId: "act_1423425976190315",
        label: "Pacific",
        excludeKeywords: null,
        // Only include campaigns with "LA" in name
        includeKeywords: ["LA"],
      },
    ],
  },
  {
    id: "oc",
    workspace: "ben-adu",
    name: "ADU — Orange County",
    monthlyBudget: 20000,
    color: "#eda100",
    accounts: [
      {
        accountId: "act_1423425976190315",
        label: "Pacific",
        excludeKeywords: null,
        includeKeywords: ["OC"],
      },
    ],
  },
  {
    id: "sj",
    workspace: "ben-adu",
    name: "ADU — San Jose",
    monthlyBudget: 20000,
    color: "#2a78d6",
    accounts: [
      {
        accountId: "act_1423425976190315",
        label: "Pacific",
        excludeKeywords: null,
        includeKeywords: ["SJ"],
      },
    ],
  },
  {
    id: "green",
    workspace: "ben-adu",
    name: "Outdoor Program — San Jose",
    monthlyBudget: 10000,
    color: "#1baf7a",
    accounts: [
      {
        accountId: "act_1281838446384778",
        label: "Green V2",
        excludeKeywords: null,
        includeKeywords: null, // null = include all
      },
    ],
  },

  // ── Perstrive ────────────────────────────────────────
  {
    id: "perstrive-main",
    workspace: "perstrive",
    name: "Perstrive — All campaigns",
    // Placeholder. Change it here, or edit it in the dashboard UI —
    // the UI value is saved to budgets.json and wins over this number.
    monthlyBudget: 5000,
    color: "#8b5cf6",
    accounts: [
      {
        accountId: "act_1810799009306944",
        label: "Perstrive",
        excludeKeywords: null,
        includeKeywords: null,
      },
    ],
  },
];

// Get all unique account IDs across all geos
function getAllAccountIds() {
  const ids = new Set();
  GEOS.forEach((geo) => {
    geo.accounts.forEach((acc) => ids.add(acc.accountId));
  });
  return Array.from(ids);
}

function getWorkspace(id) {
  return WORKSPACES.find((w) => w.id === id) || null;
}

function getGeos(workspaceId) {
  return GEOS.filter((g) => g.workspace === workspaceId);
}

// Geos belonging to workspaces that opted into Slack.
function getSlackGeos() {
  const on = new Set(WORKSPACES.filter((w) => w.slackAlerts).map((w) => w.id));
  return GEOS.filter((g) => on.has(g.workspace));
}

const DEFAULT_WORKSPACE = WORKSPACES[0].id;

module.exports = {
  WORKSPACES,
  GEOS,
  DEFAULT_WORKSPACE,
  getAllAccountIds,
  getWorkspace,
  getGeos,
  getSlackGeos,
};
