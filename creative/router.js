'use strict';

// =====================================================
// CREATIVE TRACKER — API
// =====================================================
// Mounted at /api/creative by server.js, BEHIND the global auth gate, so
// req.user is already resolved. Every read takes ?workspace= and is refused
// for a workspace the login cannot see; every write is admin-only (tagging
// creative is agency work, and a client must never edit another's data).
// =====================================================

const express = require('express');
const db = require('./db');
const analytics = require('./analytics');
const { loadConfig, resolveScope, uiConfig, accountsForWorkspace } = require('./config');
const { geoList } = require('./geo');
const { parseAdName } = require('./tagger');
const { syncAll } = require('./sync');

function today() { return new Date().toISOString().slice(0, 10); }

function createCreativeRouter({ canSeeWorkspace, isAdmin, getWorkspace, visibleWorkspaces, DEFAULT_WORKSPACE }) {
  const r = express.Router();
  const syncState = { running: false, last: null };

  // Resolve ?workspace= the same way /api/dashboard does: a request, not a grant.
  function workspaceFor(req) {
    const requested = String(req.query.workspace || req.body?.workspace || '');
    if (getWorkspace(requested) && canSeeWorkspace(req, requested)) return requested;
    const fallback = canSeeWorkspace(req, DEFAULT_WORKSPACE) ? DEFAULT_WORKSPACE : (visibleWorkspaces(req)[0] || {}).id;
    return fallback || null;
  }

  function scopeOr404(req, res) {
    const ws = workspaceFor(req);
    if (!ws) { res.status(403).json({ error: 'This login has no accounts assigned to it.' }); return null; }
    const scope = resolveScope(ws, req.query.scope || 'all');
    if (!scope) { res.status(404).json({ error: 'No creative tracking configured for this workspace' }); return null; }
    return { ws, ...scope };
  }

  function rangeFrom(query, accountIds) {
    const bounds = db.dateBounds(accountIds);
    const until = query.until || bounds.max_date || today();
    let since = query.since;
    if (!since) {
      const days = parseInt(query.days || '30', 10);
      since = days > 0 ? analytics.shiftDate(until, -(days - 1)) : (bounds.min_date || until);
    }
    return { since, until, bounds };
  }

  function denyNonAdmin(req, res) {
    if (isAdmin(req)) return false;
    res.status(403).json({ error: 'Admin access required' });
    return true;
  }

  // An ad may only be touched through a workspace that owns its account.
  function adInScope(req, res, adId) {
    const ad = db.getAd(adId);
    if (!ad) { res.status(404).json({ error: 'not found' }); return null; }
    const ws = workspaceFor(req);
    if (!ws || !accountsForWorkspace(ws).some(a => a.id === ad.account_id)) { res.status(403).json({ error: 'Ad is outside this workspace' }); return null; }
    return ad;
  }

  // ── Config / status ──
  r.get('/config', (req, res) => {
    const ws = workspaceFor(req);
    if (!ws) return res.status(403).json({ error: 'This login has no accounts assigned to it.' });
    const accounts = accountsForWorkspace(ws);
    if (!accounts.length) return res.json({ enabled: false, workspace: ws });
    res.json({
      enabled: true, workspace: ws, ...uiConfig(ws), geos: geoList(ws),
      last_sync: db.lastRun() || null, sync_running: syncState.running,
      token_configured: !!process.env.META_ACCESS_TOKEN, admin: isAdmin(req),
    });
  });

  // ── Reads ──
  r.get('/overview', (req, res) => {
    try {
      const s = scopeOr404(req, res); if (!s) return;
      const { since, until, bounds } = rangeFrom(req.query, s.accountIds);
      const data = analytics.overview({ accountIds: s.accountIds, since, until, client: s.client, geo: req.query.geo || null, workspace: s.ws });
      data.bounds = bounds;
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const DIMS = ['angle', 'hook', 'format', 'language', 'media_type', 'geo'];
  r.get('/matrix', (req, res) => {
    try {
      const s = scopeOr404(req, res); if (!s) return;
      const { since, until } = rangeFrom(req.query, s.accountIds);
      const rows = DIMS.includes(req.query.rows) ? req.query.rows : 'angle';
      const cols = DIMS.includes(req.query.cols) ? req.query.cols : 'format';
      res.json({ since, until, rowKey: rows, colKey: cols,
        cells: analytics.matrix({ accountIds: s.accountIds, since, until, rowKey: rows, colKey: cols, geo: req.query.geo || null, workspace: s.ws }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/tags', (req, res) => {
    const s = scopeOr404(req, res); if (!s) return;
    const ads = db.listAds(s.accountIds);
    const uniq = (k) => [...new Set(ads.map(a => a[k]).filter(Boolean))].sort();
    res.json({ angles: uniq('angle'), hooks: uniq('hook'), formats: uniq('format'), languages: uniq('language') });
  });

  r.get('/ad/:id', (req, res) => {
    try {
      const ad = adInScope(req, res, req.params.id); if (!ad) return;
      const { since, until } = rangeFrom(req.query, [ad.account_id]);
      res.json(analytics.adDetail({ adId: ad.ad_id, since, until, workspace: workspaceFor(req) }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/export.csv', (req, res) => {
    const s = scopeOr404(req, res); if (!s) return;
    const { since, until } = rangeFrom(req.query, s.accountIds);
    const data = analytics.overview({ accountIds: s.accountIds, since, until, client: s.client, geo: req.query.geo || null, workspace: s.ws });
    const cols = ['ad_id', 'account_id', 'geo', 'name', 'campaign_name', 'effective_status', 'stage_effective', 'hypothesis', 'drive_url', 'media_type', 'format', 'angle', 'hook', 'language', 'version',
      'spend', 'impressions', 'link_clicks', 'lpv', 'leads', 'cpl', 'ctr', 'cpm', 'hook_rate', 'hold_rate', 'lead_rate', 'frequency', 'verdict'];
    const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const lines = [cols.join(',')].concat(data.ads.map(x => cols.map(c => esc(typeof x[c] === 'number' ? Math.round(x[c] * 100) / 100 : x[c])).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="creative-${s.ws}-${since}-${until}.csv"`);
    res.send(lines.join('\n'));
  });

  // ── Writes (admin) ──
  r.patch('/ad/:id/tags', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const ad = adInScope(req, res, req.params.id); if (!ad) return;
    const allowed = ['format', 'angle', 'hook', 'language', 'version', 'notes', 'media_type'];
    const metaAllowed = ['drive_url', 'stage', 'hypothesis'];
    const tags = {}, meta = {};
    for (const k of allowed) if (req.body[k] !== undefined) tags[k] = req.body[k];
    for (const k of metaAllowed) if (req.body[k] !== undefined) meta[k] = req.body[k];
    if (tags.version !== undefined && tags.version !== null) tags.version = parseInt(tags.version, 10) || null;
    if (meta.stage === '') meta.stage = null;
    if (meta.stage != null && !analytics.STAGES.includes(meta.stage)) return res.status(400).json({ error: 'bad stage' });
    if (meta.drive_url && !/^https?:\/\//i.test(meta.drive_url)) return res.status(400).json({ error: 'drive_url must be a link' });
    let row = ad;
    if (Object.keys(tags).length) row = db.updateAdTags(ad.ad_id, tags);
    if (Object.keys(meta).length) row = db.updateAdMeta(ad.ad_id, meta);
    res.json(row);
  });

  r.post('/ad/:id/tags/reset', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const ad = adInScope(req, res, req.params.id); if (!ad) return;
    db.resetAdTags(ad.ad_id, parseAdName(ad.name));
    res.json(db.getAd(ad.ad_id));
  });

  r.post('/tags/rename', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    try {
      const { kind, from, to } = req.body || {};
      if (!kind || !from || !to) return res.status(400).json({ error: 'kind, from, to required' });
      const s = scopeOr404(req, res); if (!s) return;
      res.json({ changed: db.renameTag(kind, from, String(to).trim(), s.accountIds) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/ads/planned', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const b = req.body || {};
    const ws = workspaceFor(req);
    if (!ws) return res.status(403).json({ error: 'no workspace' });
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name required' });
    if (!accountsForWorkspace(ws).some(a => a.id === b.account_id)) return res.status(400).json({ error: 'unknown account_id for this workspace' });
    if (b.stage && !['idea', 'production'].includes(b.stage)) return res.status(400).json({ error: 'planned ads start as idea or production' });
    if (b.drive_url && !/^https?:\/\//i.test(b.drive_url)) return res.status(400).json({ error: 'drive_url must be a link' });
    const parsed = parseAdName(b.name);
    res.json(db.createPlannedAd({
      ...b, name: String(b.name).trim(),
      angle: b.angle || parsed.angle, hook: b.hook || parsed.hook, format: b.format || parsed.format,
      media_type: b.media_type || parsed.media_type, language: b.language || parsed.language, version: b.version ?? parsed.version,
    }));
  });

  r.post('/ads/planned/:id/link', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const planned = adInScope(req, res, req.params.id); if (!planned) return;
    const target = adInScope(req, res, String((req.body || {}).ad_id || '')); if (!target) return;
    const row = db.linkPlannedAd(planned.ad_id, target.ad_id);
    if (!row) return res.status(404).json({ error: 'planned ad or target ad not found' });
    res.json(row);
  });

  r.delete('/ads/planned/:id', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const planned = adInScope(req, res, req.params.id); if (!planned) return;
    res.json({ deleted: db.deletePlannedAd(planned.ad_id) });
  });

  // ── Sync ──
  async function runSync(opts) {
    if (syncState.running) return syncState.last;
    syncState.running = true;
    try { syncState.last = await syncAll(opts); }
    catch (err) { syncState.last = { status: 'error', errors: [err.message] }; console.error(`[CREATIVE] sync failed: ${err.message}`); }
    finally { syncState.running = false; }
    return syncState.last;
  }

  r.post('/sync', (req, res) => {
    if (denyNonAdmin(req, res)) return;
    if (!process.env.META_ACCESS_TOKEN) return res.status(400).json({ error: 'META_ACCESS_TOKEN not set' });
    if (syncState.running) return res.status(409).json({ error: 'sync already running' });
    res.json({ started: true });
    runSync({ days: parseInt(req.body?.days || '0', 10) || undefined });
  });
  r.get('/sync', (req, res) => res.json({ running: syncState.running, last: syncState.last, last_run: db.lastRun() }));

  r.runSync = runSync;
  r.syncState = syncState;
  return r;
}

/** First boot on a fresh box: pull 180 days so the tab isn't empty. Later boots just top up the recent window. */
async function ensureSeeded(router) {
  if (!process.env.META_ACCESS_TOKEN) { console.log('[CREATIVE] META_ACCESS_TOKEN not set — creative sync disabled'); return; }
  const bounds = db.dateBounds(loadConfig().accounts.map(a => a.id));
  const empty = !bounds || !bounds.max_date;
  console.log(`[CREATIVE] ${empty ? 'empty database — backfilling 180 days' : 'refreshing recent window'} in the background`);
  setTimeout(() => router.runSync({ days: empty ? 180 : undefined }), empty ? 5000 : 60000);
}

module.exports = { createCreativeRouter, ensureSeeded };
