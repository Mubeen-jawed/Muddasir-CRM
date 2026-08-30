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
    // Slack destination for this client's alerts and daily/weekly summaries.
    // Having a channel IS the opt-in: a workspace with slackChannel: null is
    // never posted about, so adding a client can't start spamming someone
    // else's channel. Use the encoded channel ID (Cxxxxxxxx), not "#name" —
    // a rename silently breaks name-based routing.
    // Public channels need no invite (the bot holds chat:write.public);
    // a PRIVATE channel must have /invite @blendfold_bot run in it once.
    slackChannel: "C0BTHN6RC2J", // TEST channel - swap for the real Ben ADU channel
    dashboardUrl: "https://ben.blendfoldmedia.com",
  },
  {
    id: "perstrive",
    name: "Perstrive",
    slackChannel: "C0BUE1U7KCY", // TEST channel - swap for the real Perstrive channel, or null to stay silent
    dashboardUrl: "https://ben.blendfoldmedia.com",
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

// Workspaces with a Slack destination configured. Each one gets its own
// message in its own channel — routing is derived from geo.workspace, so a
// new client needs only its channel ID here, never a change in server.js.
function getSlackWorkspaces() {
  return WORKSPACES.filter((w) => w.slackChannel);
}

const DEFAULT_WORKSPACE = WORKSPACES[0].id;

module.exports = {
  WORKSPACES,
  GEOS,
  DEFAULT_WORKSPACE,
  getAllAccountIds,
  getWorkspace,
  getGeos,
  getSlackWorkspaces,
};
