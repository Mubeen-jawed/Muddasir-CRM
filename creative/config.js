'use strict';

// =====================================================
// CREATIVE TRACKER — ACCOUNT CONFIGURATION
// =====================================================
// Which ad accounts the creative tracker follows, grouped two ways:
//   workspace — the CRM workspace (sidebar row) the accounts belong to.
//               The Creative tab only appears for workspaces listed here.
//   client    — a sub-group inside the workspace with its own CPL target
//               (Ben ADU vs Ben Outdoor share one workspace but not one target).
// County (geo) rules are NOT duplicated here — they come from ../config.js,
// the same rules the budget dashboard uses.
// =====================================================

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CREATIVE_CONFIG_PATH || path.join(__dirname, 'config', 'accounts.json');

let cache = null;
let mtime = 0;

function loadConfig() {
  const stat = fs.statSync(CONFIG_PATH);
  if (!cache || stat.mtimeMs !== mtime) {
    cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    mtime = stat.mtimeMs;
    for (const a of cache.accounts) {
      if (!cache.clients[a.client]) throw new Error(`[CREATIVE] account ${a.id} references unknown client "${a.client}"`);
      if (!a.workspace) throw new Error(`[CREATIVE] account ${a.id} has no workspace`);
    }
  }
  return cache;
}

function accountsForWorkspace(workspaceId) {
  return loadConfig().accounts.filter(a => a.workspace === workspaceId && a.active !== false);
}

function workspacesWithCreative() {
  return [...new Set(loadConfig().accounts.filter(a => a.active !== false).map(a => a.workspace))];
}

/**
 * Resolve a scope key inside a workspace into { client, accountIds }.
 *   key = 'all' | <client key> | <act_ id>
 */
function resolveScope(workspaceId, key) {
  const cfg = loadConfig();
  const accounts = accountsForWorkspace(workspaceId);
  if (!accounts.length) return null;
  const clientsHere = [...new Set(accounts.map(a => a.client))].map(k => ({ key: k, ...cfg.clients[k] }));

  if (!key || key === 'all') {
    if (clientsHere.length === 1) return { client: clientsHere[0], accountIds: accounts.map(a => a.id) };
    return {
      client: { key: 'all', name: 'All accounts', short: 'All',
        cpl_target: Math.max(...clientsHere.map(c => c.cpl_target)),
        min_spend_for_verdict: Math.min(...clientsHere.map(c => c.min_spend_for_verdict)) },
      accountIds: accounts.map(a => a.id),
    };
  }
  const client = clientsHere.find(c => c.key === key);
  if (client) return { client, accountIds: accounts.filter(a => a.client === key).map(a => a.id) };
  const acc = accounts.find(a => a.id === key);
  if (acc) return { client: { key: acc.client, ...cfg.clients[acc.client], account_name: acc.name }, accountIds: [acc.id] };
  return null;
}

/** Everything the UI needs to draw the scope chips for one workspace. */
function uiConfig(workspaceId) {
  const cfg = loadConfig();
  const accounts = accountsForWorkspace(workspaceId);
  const clientKeys = [...new Set(accounts.map(a => a.client))];
  const clients = {};
  for (const k of clientKeys) clients[k] = cfg.clients[k];
  return { clients, accounts, video_benchmark: cfg.video_benchmark || null };
}

module.exports = { loadConfig, accountsForWorkspace, workspacesWithCreative, resolveScope, uiConfig, CONFIG_PATH };
