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

const SEED_WORKSPACES = [
  {
    id: "ben-adu",
    name: "Ben ADU",
    // seedSlackChannel is used ONCE, to populate accounts.json the first time
    // this runs. After that the stored channel map is the only source of
    // truth and editing this line does nothing — change the channel in the
    // dashboard (Slack channels) instead. Delete accounts.json to re-seed.
    seedSlackChannel: "C0BN4JP2AFM",
    dashboardUrl: "https://ben.blendfoldmedia.com",
  },
  {
    id: "perstrive",
    name: "Perstrive",
    seedSlackChannel: "C0BUE1U7KCY",
    dashboardUrl: "https://ben.blendfoldmedia.com",
  },
];

const SEED_GEOS = [
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

// ─────────────────────────────────────────────────────────────────────
// RUNTIME-ADDED ACCOUNTS
// ─────────────────────────────────────────────────────────────────────
// Accounts added from the dashboard UI are persisted here instead of in
// code, the same way budgets.json holds budget overrides. Seed entries
// above stay authoritative for the hand-tuned Ben ADU geo rules (which
// slice ONE account across several geos by campaign name) — those can't
// be expressed by "add an account" and must not be editable from the UI.
//
// A UI-added account is always one workspace owning one geo that covers
// every campaign in it. That's the only shape the picker can produce.
const fs = require("fs");
const path = require("path");
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

let store = loadStore();

function loadStore() {
  const empty = { workspaces: [], channels: {} };
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
      return {
        workspaces: Array.isArray(parsed && parsed.workspaces) ? parsed.workspaces : [],
        channels: parsed && parsed.channels && typeof parsed.channels === "object"
          ? parsed.channels
          : {},
      };
    }
  } catch (err) {
    // A corrupt file must not take the dashboard down — the seed config
    // still serves every hand-configured client.
    console.error(`[CONFIG] accounts.json unreadable, ignoring it: ${err.message}`);
  }
  return empty;
}

function saveStore() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2));
}

// First run only: lift the seed channels out of code and into the store, so
// from then on every channel id — seed or UI-added — lives in one place and
// is edited the same way.
function seedChannelsOnce() {
  let changed = false;
  SEED_WORKSPACES.forEach((w) => {
    if (!(w.id in store.channels)) {
      store.channels[w.id] = w.seedSlackChannel || null;
      changed = true;
    }
  });
  if (changed) {
    saveStore();
    console.log("[CONFIG] seeded Slack channels into accounts.json");
  }
}
seedChannelsOnce();

function geoForAdded(w) {
  return {
    id: w.geoId,
    workspace: w.id,
    name: w.name,
    monthlyBudget: w.monthlyBudget,
    color: w.color,
    accounts: [
      {
        accountId: w.accountId,
        label: w.accountName || w.name,
        excludeKeywords: null,
        includeKeywords: null, // every campaign in the account
      },
    ],
  };
}

// The stored channel map is the single source of truth for every workspace's
// Slack destination, so seed and UI-added clients are edited identically.
function withChannel(w) {
  return Object.assign({}, w, { slackChannel: store.channels[w.id] || null });
}

function getWorkspaces() {
  return SEED_WORKSPACES.concat(store.workspaces).map(withChannel);
}

function getAllGeos() {
  return SEED_GEOS.concat(store.workspaces.map(geoForAdded));
}

// Get all unique account IDs across all geos
function getAllAccountIds() {
  const ids = new Set();
  getAllGeos().forEach((geo) => {
    geo.accounts.forEach((acc) => ids.add(acc.accountId));
  });
  return Array.from(ids);
}

function getWorkspace(id) {
  return getWorkspaces().find((w) => w.id === id) || null;
}

function getGeos(workspaceId) {
  return getAllGeos().filter((g) => g.workspace === workspaceId);
}

// Workspaces with a Slack destination configured. Each one gets its own
// message in its own channel — routing is derived from geo.workspace, so a
// new client needs only its channel ID here, never a change in server.js.
function getSlackWorkspaces() {
  return getWorkspaces().filter((w) => w.slackChannel);
}

// Accounts already covered by ANY workspace, seed or added — so the picker
// can mark them and refuse a duplicate. A second workspace on the same
// account would double-count its spend in the portfolio totals.
function getUsedAccountIds() {
  return new Set(getAllAccountIds());
}

// Slack channel IDs: C=public/private channel, D=DM, G=legacy group.
const CHANNEL_RE = /^[CDG][A-Z0-9]{6,}$/;
const ACCOUNT_RE = /^act_\d+$/;

const PALETTE = ["#e34948", "#eda100", "#2a78d6", "#1baf7a", "#8b5cf6", "#e0699f", "#14b8a6", "#f97316"];

// Empty string / null both mean "no Slack" — an account can be tracked on the
// dashboard without ever posting.
function normalizeChannel(raw) {
  const channel = String(raw == null ? "" : raw).trim().toUpperCase();
  if (channel && !CHANNEL_RE.test(channel)) {
    throw new Error(
      `Invalid Slack channel id "${channel}" — expected the encoded id (e.g. C0BTHN6RC2J), not a #name`
    );
  }
  return channel || null;
}

// The one write path for every workspace's Slack channel, seed or added.
function setChannel(workspaceId, raw) {
  if (!getWorkspaces().some((w) => w.id === workspaceId)) {
    throw new Error(`Unknown workspace "${workspaceId}"`);
  }
  const channel = normalizeChannel(raw);
  store.channels[workspaceId] = channel;
  saveStore();
  return channel;
}

function addAccount({ accountId, accountName, name, monthlyBudget, slackChannel, dashboardUrl }) {
  accountId = String(accountId || "").trim();
  if (!ACCOUNT_RE.test(accountId)) {
    throw new Error(`Invalid ad account id "${accountId}" — expected act_<digits>`);
  }
  if (getUsedAccountIds().has(accountId)) {
    throw new Error(`${accountId} is already on the dashboard`);
  }

  const displayName = String(name || accountName || accountId).trim();
  if (!displayName) throw new Error("A display name is required");

  const budget = Number(monthlyBudget);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error("Monthly budget must be a positive number");
  }

  const channel = normalizeChannel(slackChannel);

  // act_123 -> 123, so ids stay readable and stable across renames.
  const numeric = accountId.replace(/^act_/, "");
  const workspace = {
    id: `ws-${numeric}`,
    geoId: `geo-${numeric}`,
    name: displayName,
    accountId,
    accountName: String(accountName || "").trim() || displayName,
    monthlyBudget: budget,
    dashboardUrl: dashboardUrl || SEED_WORKSPACES[0].dashboardUrl,
    color: PALETTE[getWorkspaces().length % PALETTE.length],
    addedAt: new Date().toISOString(),
  };

  store.workspaces = store.workspaces.concat(workspace);
  // Channel goes in the shared map, not on the record, so there is exactly
  // one place any channel id is read from or written to.
  store.channels[workspace.id] = channel;
  saveStore();
  return withChannel(workspace);
}

function updateAccount(workspaceId, patch) {
  const w = store.workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`${workspaceId} is not a UI-added account`);

  // Channel is editable on ANY workspace, so it routes through setChannel.
  if (patch.slackChannel !== undefined) setChannel(workspaceId, patch.slackChannel);
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("A display name is required");
    w.name = n;
  }
  if (patch.monthlyBudget !== undefined) {
    const b = Number(patch.monthlyBudget);
    if (!Number.isFinite(b) || b <= 0) throw new Error("Monthly budget must be a positive number");
    w.monthlyBudget = b;
  }
  saveStore();
  return withChannel(w);
}

function removeAccount(workspaceId) {
  const w = store.workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`${workspaceId} is not a UI-added account`);
  store.workspaces = store.workspaces.filter((x) => x.id !== workspaceId);
  delete store.channels[workspaceId];
  saveStore();
  return w;
}

// Seed workspaces are defined in code: their geo rules can't be edited or
// removed from the UI. Their Slack channel still can — that lives in the
// shared channel map like everyone else's.
function isEditable(workspaceId) {
  return store.workspaces.some((w) => w.id === workspaceId);
}

const DEFAULT_WORKSPACE = SEED_WORKSPACES[0].id;

module.exports = {
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
};
