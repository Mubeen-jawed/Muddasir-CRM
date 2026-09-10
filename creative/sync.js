'use strict';

/**
 * Pulls ads + daily ad-level insights from Meta for every active account and stores them.
 * Used by the scheduled cron in server.js and by `npm run sync`.
 */

const db = require('./db');
const meta = require('./meta');
const { parseAdName } = require('./tagger');
const { loadConfig } = require('./config');

function log(msg) { console.log(`[CREATIVE] ${msg}`); }

function windows(since, until, days) {
  const out = [];
  let cur = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');
  while (cur <= end) {
    const stop = new Date(cur); stop.setUTCDate(stop.getUTCDate() + days - 1);
    const u = stop > end ? end : stop;
    out.push([cur.toISOString().slice(0, 10), u.toISOString().slice(0, 10)]);
    cur = new Date(u); cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

async function syncAccount(account, { since, until }) {
  const ads = await meta.fetchAds(account.id);
  let adCount = 0;
  for (const ad of ads) {
    const tags = parseAdName(ad.name);
    db.upsertAd({
      ...ad,
      format: tags.format, angle: tags.angle, hook: tags.hook, language: tags.language, version: tags.version,
      tag_confidence: tags.confidence,
      // the creative object is authoritative for media type; fall back to what the name implies
      media_type: ad.media_type && ad.media_type !== 'unknown' ? ad.media_type : (tags.media_type || 'unknown'),
    });
    adCount++;
  }

  // Pull insights in windows of at most 30 days — big ad-level daily queries time out on Meta's side.
  const rows = [];
  for (const [s, u] of windows(since, until, 30)) {
    const part = await meta.fetchDailyInsights(account.id, s, u);
    rows.push(...part);
    log(`  ${account.name}: ${s} → ${u}: ${part.length} rows`);
  }
  // Insights can reference ads the /ads listing didn't return (deleted/archived) — create stubs so nothing is lost.
  const known = new Set(ads.map(a => a.ad_id));
  for (const r of rows) {
    if (!known.has(r.ad_id)) {
      const tags = parseAdName(r._meta.ad_name);
      db.upsertAd({ ad_id: r.ad_id, account_id: account.id, name: r._meta.ad_name, campaign_id: r._meta.campaign_id,
        campaign_name: r._meta.campaign_name, adset_id: r._meta.adset_id, adset_name: r._meta.adset_name,
        status: 'ARCHIVED', effective_status: 'ARCHIVED', format: tags.format, angle: tags.angle, hook: tags.hook,
        language: tags.language, version: tags.version, tag_confidence: tags.confidence, media_type: tags.media_type || 'unknown' });
      known.add(r.ad_id);
      adCount++;
    }
  }
  const stored = db.upsertDailyBatch(rows.map(({ _meta, ...rest }) => rest));
  return { ads: adCount, rows: stored };
}

async function syncAll({ days } = {}) {
  const cfg = loadConfig();
  const windowDays = days || parseInt(process.env.CREATIVE_SYNC_WINDOW_DAYS || process.env.SYNC_WINDOW_DAYS || '14', 10);
  const range = { since: daysAgo(windowDays), until: today() };
  const accounts = cfg.accounts.filter(a => a.active !== false);
  log(`Syncing ${accounts.length} accounts, ${range.since} → ${range.until}`);
  const runId = db.startRun('graph');
  let ads = 0, rows = 0, failed = 0;
  const errors = [];
  for (const acc of accounts) {
    try {
      const r = await syncAccount(acc, range);
      ads += r.ads; rows += r.rows;
      log(`OK ${acc.name}: ${r.ads} ads, ${r.rows} daily rows`);
    } catch (err) {
      failed++;
      errors.push(`${acc.name}: ${err.message}`);
      log(`FAIL ${acc.name}: ${err.message}`);
    }
  }
  const status = failed === 0 ? 'ok' : failed === accounts.length ? 'error' : 'partial';
  db.finishRun(runId, { ads, rows, status, message: errors.join(' | ') || null });
  log(`Sync complete: ${ads} ads, ${rows} rows, ${failed} failed (${status})`);
  return { ads, rows, failed, status, errors };
}

module.exports = { syncAll, syncAccount, log };
