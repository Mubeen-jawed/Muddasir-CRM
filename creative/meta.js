'use strict';

/**
 * Thin Meta Graph API client for ads + ad-level daily insights.
 * Video fields differ between API versions, so insight fields degrade gracefully:
 * if Meta rejects a field (#100), it is dropped and the request retried.
 */

const https = require('https');

const API_VERSION = process.env.META_API_VERSION || 'v26.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;
const MAX_RETRIES = 4;

const LEAD_ACTIONS = ['lead', 'onsite_web_lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'];

const BASE_FIELDS = ['ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'spend', 'impressions', 'reach',
  'clicks', 'inline_link_clicks', 'frequency', 'actions'];

// Ordered by preference; the first that exists becomes the "hook view" metric.
const HOOK_FIELDS = ['video_3_sec_watched_actions', 'video_continuous_2_sec_watched_actions'];
const VIDEO_FIELDS = ['video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p100_watched_actions', 'video_thruplay_watched_actions', 'video_avg_time_watched_actions'];

let workingFields = null; // learned per process

function log(msg) { console.log(`[CREATIVE/meta] ${msg}`); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch (e) { return reject(new Error(`Bad JSON (${res.statusCode}): ${data.slice(0, 200)}`)); }
        if (res.statusCode >= 400 || body.error) {
          const err = new Error(body.error?.message || `HTTP ${res.statusCode}`);
          err.code = body.error?.code; err.subcode = body.error?.error_subcode; err.body = body;
          return reject(err);
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function apiGet(pathOrUrl, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${GRAPH_BASE}/${pathOrUrl}?${new URLSearchParams({ ...params, access_token: token })}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await httpGet(url); }
    catch (err) {
      lastErr = err;
      if ([4, 17, 32, 613, 80000, 80004].includes(err.code) && attempt < MAX_RETRIES) {
        const delay = 15000 * attempt;
        log(`Rate limited (code ${err.code}); retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function getAll(path, params) {
  const out = [];
  let page = await apiGet(path, params);
  out.push(...(page.data || []));
  while (page.paging?.next) {
    page = await apiGet(page.paging.next);
    out.push(...(page.data || []));
  }
  return out;
}

// Meta refuses big ad-level daily pulls ("Please reduce the amount of data you're asking for").
// When that happens the range is split in half and both halves fetched, down to single days.
function isTooMuchData(err) {
  // Code 1 "unknown error" and code 2 "temporary" are what Meta returns when an insights query times out on its side.
  return /reduce the amount of data/i.test(err.message || '') || err.code === 1 || err.code === 2;
}

// ── Ads + creatives ──────────────────────────────────────────────────────────

const AD_FIELDS = 'id,name,status,effective_status,created_time,campaign{id,name},adset{id,name},' +
  'creative{id,object_type,thumbnail_url,image_url,body,title,object_story_spec,asset_feed_spec{videos,images,bodies,titles,link_urls}}';

function mediaTypeFromCreative(c) {
  if (!c) return 'unknown';
  const t = (c.object_type || '').toUpperCase();
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  if (t === 'VIDEO' || oss.video_data || (afs.videos && afs.videos.length)) return 'video';
  if (oss.link_data?.child_attachments?.length > 1 || t === 'CAROUSEL') return 'carousel';
  if (t === 'PHOTO' || t === 'SHARE' || oss.photo_data || oss.link_data || (afs.images && afs.images.length)) return 'image';
  return 'unknown';
}

function creativeText(c) {
  if (!c) return {};
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  const body = c.body || oss.video_data?.message || oss.link_data?.message || afs.bodies?.[0]?.text || null;
  const title = c.title || oss.video_data?.title || oss.link_data?.name || afs.titles?.[0]?.text || null;
  const link = oss.video_data?.call_to_action?.value?.link || oss.link_data?.link || afs.link_urls?.[0]?.website_url || null;
  return { body, title, link };
}

async function fetchAds(accountId) {
  // The creative sub-fields make each ad heavy; Meta caps the response size, so step the page size down on "too much data".
  let raw = null;
  for (const limit of [200, 50, 20, 10]) {
    try { raw = await getAll(`${accountId}/ads`, { fields: AD_FIELDS, limit }); break; }
    catch (err) {
      if (isTooMuchData(err) && limit !== 10) { log(`${accountId}: /ads page of ${limit} too large; retrying smaller`); continue; }
      throw err;
    }
  }
  return raw.map(a => {
    const { body, title, link } = creativeText(a.creative);
    return {
      ad_id: a.id,
      account_id: accountId,
      name: a.name,
      campaign_id: a.campaign?.id, campaign_name: a.campaign?.name,
      adset_id: a.adset?.id, adset_name: a.adset?.name,
      status: a.status, effective_status: a.effective_status,
      created_time: a.created_time,
      creative_id: a.creative?.id,
      media_type: mediaTypeFromCreative(a.creative),
      thumbnail_url: a.creative?.thumbnail_url || a.creative?.image_url || null,
      body, title, link_url: link,
    };
  });
}

// ── Insights ─────────────────────────────────────────────────────────────────

function actionValue(list, type) {
  if (!Array.isArray(list)) return 0;
  const hit = list.find(a => a.action_type === type);
  return hit ? parseFloat(hit.value || 0) : 0;
}

function videoValue(list) {
  // video_* fields come back as [{action_type:'video_view', value:'123'}]
  if (!Array.isArray(list) || !list.length) return 0;
  return list.reduce((s, a) => s + parseFloat(a.value || 0), 0);
}

function leadsFrom(actions) {
  for (const t of LEAD_ACTIONS) {
    const v = actionValue(actions, t);
    if (v) return v;
  }
  return 0;
}

function parseInsightRow(r, accountId) {
  const hookViews = videoValue(r.video_3_sec_watched_actions) || videoValue(r.video_continuous_2_sec_watched_actions);
  return {
    ad_id: r.ad_id,
    date: r.date_start,
    account_id: accountId,
    spend: parseFloat(r.spend || 0),
    impressions: parseInt(r.impressions || 0, 10),
    reach: parseInt(r.reach || 0, 10),
    clicks: parseInt(r.clicks || 0, 10),
    link_clicks: parseInt(r.inline_link_clicks || 0, 10) || actionValue(r.actions, 'link_click'),
    lpv: actionValue(r.actions, 'landing_page_view'),
    leads: leadsFrom(r.actions),
    video_plays: videoValue(r.video_play_actions),
    video_3s: hookViews,
    video_p25: videoValue(r.video_p25_watched_actions),
    video_p50: videoValue(r.video_p50_watched_actions),
    video_p75: videoValue(r.video_p75_watched_actions),
    video_p100: videoValue(r.video_p100_watched_actions),
    thruplay: videoValue(r.video_thruplay_watched_actions),
    avg_watch: r.video_avg_time_watched_actions ? videoValue(r.video_avg_time_watched_actions) : null,
    frequency: r.frequency != null ? parseFloat(r.frequency) : null,
    // carried for ad metadata refresh
    _meta: { ad_name: r.ad_name, adset_id: r.adset_id, adset_name: r.adset_name, campaign_id: r.campaign_id, campaign_name: r.campaign_name },
  };
}

function invalidFieldFromError(err) {
  const m = (err.message || '').match(/\(#100\)\s*(.+?)\s+is\s+(?:an\s+)?invalid|field\s+'?([a-z0-9_]+)'?\s+is\s+(?:not\s+valid|invalid)/i);
  if (m) return (m[1] || m[2] || '').trim();
  // Common shape: "(#100) video_3_sec_watched_actions is not valid for fields param."
  const m2 = (err.message || '').match(/\(#100\)\s*([a-z0-9_]+)/i);
  return m2 ? m2[1] : null;
}

function midpoint(since, until) {
  const a = new Date(since + 'T00:00:00Z'), b = new Date(until + 'T00:00:00Z');
  const m = new Date((a.getTime() + b.getTime()) / 2);
  return m.toISOString().slice(0, 10);
}
function nextDay(d) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

async function fetchDailyInsights(accountId, since, until) {
  let fields = workingFields || [...BASE_FIELDS, ...HOOK_FIELDS, ...VIDEO_FIELDS];
  for (let tries = 0; tries < 8; tries++) {
    try {
      const rows = await getAll(`${accountId}/insights`, {
        level: 'ad',
        fields: fields.join(','),
        time_range: JSON.stringify({ since, until }),
        time_increment: '1',
        limit: 200,
      });
      workingFields = fields;
      return rows.map(r => parseInsightRow(r, accountId));
    } catch (err) {
      const bad = err.code === 100 ? invalidFieldFromError(err) : null;
      if (bad && fields.includes(bad) && !BASE_FIELDS.includes(bad)) {
        log(`Field "${bad}" rejected by API ${API_VERSION}; dropping it`);
        fields = fields.filter(f => f !== bad);
        continue;
      }
      if (isTooMuchData(err) && since < until) {
        const mid = midpoint(since, until);
        log(`${accountId}: ${since}→${until} too large for one request; splitting at ${mid}`);
        const left = await fetchDailyInsights(accountId, since, mid);
        const right = await fetchDailyInsights(accountId, nextDay(mid), until);
        return left.concat(right);
      }
      throw err;
    }
  }
  throw new Error('Could not find a working insights field set');
}

module.exports = { fetchAds, fetchDailyInsights, parseInsightRow, mediaTypeFromCreative, creativeText, leadsFrom, actionValue, LEAD_ACTIONS, log };
