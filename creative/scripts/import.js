#!/usr/bin/env node
'use strict';

/**
 * Imports data without a Meta token, from JSON dumps produced by the Meta Ads MCP connector
 * (or any file holding raw Graph API insight rows).
 *
 *   node scripts/import.js <file.json> [more files...]
 *
 * Accepted shapes (auto-detected, files may be wrapped as {"result": "<json string>"}):
 *   1. MCP get_insights with time_breakdown=day: { object_id, segmented_metrics: [{ period, metrics: {...} }] }
 *   2. Raw Graph insights page: { data: [{ ad_id, date_start, spend, ... }] }   (needs --account act_X if rows lack account_id)
 *   3. MCP get_ads: { data: [{ id, name, status, effective_status, created_time, adset_id, campaign_id, creative }] } (needs --account)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { parseAdName } = require('../tagger');
const { parseInsightRow, mediaTypeFromCreative } = require('../meta');
const { loadConfig } = require('../config');

const args = process.argv.slice(2);
let forcedAccount = null;
let videoOnly = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--account') forcedAccount = args[++i];
  else if (args[i] === '--video-only') videoOnly = true;   // merge only video columns (rows from a video-fields pull have no actions)
  else files.push(args[i]);
}
if (!files.length) { console.error('usage: node scripts/import.js [--account act_X] <file.json> ...'); process.exit(1); }

function unwrap(raw) {
  let d = JSON.parse(raw);
  if (d && typeof d.result === 'string') d = JSON.parse(d.result);
  return d;
}

function normAccount(id) {
  if (!id) return null;
  return id.startsWith('act_') ? id : 'act_' + id;
}

function upsertAdFromInsight(r, accountId, seen) {
  if (seen.has(r.ad_id)) return;
  seen.add(r.ad_id);
  const tags = parseAdName(r._meta.ad_name);
  db.upsertAd({
    ad_id: r.ad_id, account_id: accountId, name: r._meta.ad_name,
    campaign_id: r._meta.campaign_id, campaign_name: r._meta.campaign_name,
    adset_id: r._meta.adset_id, adset_name: r._meta.adset_name,
    format: tags.format, angle: tags.angle, hook: tags.hook, language: tags.language, version: tags.version,
    tag_confidence: tags.confidence, media_type: tags.media_type || null,
  });
}

function importInsightRows(rawRows, accountId, label) {
  const seen = new Set();
  const rows = [];
  for (const raw of rawRows) {
    const acc = normAccount(raw.account_id) || accountId || forcedAccount;
    if (!acc) throw new Error(`${label}: rows have no account_id; pass --account act_X`);
    const r = parseInsightRow(raw, acc);
    if (!r.ad_id || !r.date) continue;
    if (!videoOnly && r._meta.ad_name) upsertAdFromInsight(r, acc, seen); else seen.add(r.ad_id);
    const { _meta, ...rest } = r;
    rows.push(rest);
  }
  if (videoOnly) {
    const { updated, inserted } = db.upsertDailyVideoBatch(rows);
    console.log(`${label}: ${seen.size} ads, video metrics merged into ${updated} rows (${inserted} new)`);
    return { ads: 0, rows: updated + inserted };
  }
  const n = db.upsertDailyBatch(rows);
  console.log(`${label}: ${seen.size} ads, ${n} daily rows`);
  return { ads: seen.size, rows: n };
}

/** Rows from the bulk connector: {results:[{account_id, segmented_metrics:[{period, metrics|ads|data}]}]} or {results:[{ads:[...]}]} */
function rowsFromBulk(d) {
  const out = [];
  for (const r of d.results || []) {
    if (r.status && r.status !== 'success' && r.status !== 'ok' && !r.segmented_metrics && !r.ads && !r.data) continue;
    const acc = normAccount(r.account_id);
    const push = (m, date) => out.push({ ...m, account_id: m.account_id || acc, date_start: m.date_start || date });
    for (const seg of r.segmented_metrics || []) {
      const date = seg.period_start || seg.period || seg.date_start;
      if (Array.isArray(seg.metrics)) seg.metrics.forEach(m => push(m, date));
      else if (Array.isArray(seg.ads)) seg.ads.forEach(m => push(m, date));
      else if (Array.isArray(seg.data)) seg.data.forEach(m => push(m, date));
      else if (seg.metrics) push(seg.metrics, date);
    }
    for (const m of r.ads || r.data || []) push(m, m.date_start);
  }
  return out;
}

function importAdsList(list, accountId, label) {
  const acc = accountId || forcedAccount;
  if (!acc) throw new Error(`${label}: ads list needs --account act_X`);
  let n = 0;
  for (const a of list) {
    const tags = parseAdName(a.name);
    const media = mediaTypeFromCreative(a.creative);
    db.upsertAd({
      ad_id: a.id, account_id: acc, name: a.name, campaign_id: a.campaign_id || a.campaign?.id, campaign_name: a.campaign?.name,
      adset_id: a.adset_id || a.adset?.id, adset_name: a.adset?.name, status: a.status, effective_status: a.effective_status,
      created_time: a.created_time, creative_id: a.creative?.id, media_type: media !== 'unknown' ? media : (tags.media_type || null),
      thumbnail_url: a.creative?.thumbnail_url || null,
      format: tags.format, angle: tags.angle, hook: tags.hook, language: tags.language, version: tags.version, tag_confidence: tags.confidence,
    });
    n++;
  }
  console.log(`${label}: ${n} ads (metadata only)`);
  return { ads: n, rows: 0 };
}

const runId = db.startRun('import');
let totAds = 0, totRows = 0;
try {
  loadConfig();
  for (const f of files) {
    const label = path.basename(f);
    const d = unwrap(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(d.results) && d.results.length) {
      const rawRows = rowsFromBulk(d);
      if (!rawRows.length) { console.warn(`${label}: bulk result had no rows (${JSON.stringify(d.results.map(r => r.status || r.error?.message)).slice(0, 200)})`); continue; }
      const r = importInsightRows(rawRows, null, label); totAds += r.ads; totRows += r.rows;
    } else if (Array.isArray(d.segmented_metrics)) {
      const acc = normAccount(d.object_id);
      const rawRows = d.segmented_metrics.map(s => ({ ...s.metrics, date_start: s.metrics.date_start || s.period_start || s.period }));
      const r = importInsightRows(rawRows, acc, label); totAds += r.ads; totRows += r.rows;
    } else if (Array.isArray(d.data) && d.data.length && d.data[0].date_start) {
      const r = importInsightRows(d.data, null, label); totAds += r.ads; totRows += r.rows;
    } else if (Array.isArray(d.data) && d.data.length && d.data[0].name !== undefined) {
      const r = importAdsList(d.data, null, label); totAds += r.ads;
    } else if (Array.isArray(d) && d.length && d[0].date_start) {
      const r = importInsightRows(d, null, label); totAds += r.ads; totRows += r.rows;
    } else {
      console.warn(`${label}: unrecognized shape, skipped`);
    }
  }
  db.finishRun(runId, { ads: totAds, rows: totRows, status: 'ok' });
  console.log(`Import done: ${totAds} ads, ${totRows} daily rows`);
} catch (err) {
  db.finishRun(runId, { ads: totAds, rows: totRows, status: 'error', message: err.message });
  console.error('Import failed:', err.message);
  process.exit(1);
}
