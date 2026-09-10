'use strict';

/**
 * Turns raw ad rows + daily metrics into the numbers the dashboard shows:
 * per-ad KPIs, groupings by angle / hook / format / language, verdicts and fatigue flags.
 */

const db = require('./db');
const { assignGeos, geoList } = require('./geo');

function safeDiv(a, b) { return b > 0 ? a / b : null; }

// Video benchmarks (config/accounts.json → video_benchmark): >= good is green, >= near is amber, below is red.
const { loadConfig } = require('./config');
function videoBench() {
  const b = loadConfig().video_benchmark || {};
  return { hook_good: b.hook_good ?? 30, hook_near: b.hook_near ?? 25, hold_good: b.hold_good ?? 30, hold_near: b.hold_near ?? 25 };
}
function videoGrade(pct, kind) {
  if (pct == null) return null;
  const b = videoBench();
  const good = kind === 'hold' ? b.hold_good : b.hook_good, near = kind === 'hold' ? b.hold_near : b.hook_near;
  if (pct >= good) return 'good';
  if (pct >= near) return 'near';
  return 'poor';
}
const VIDEO_BENCH = videoBench();
// An ad only gets hook/hold numbers when it actually delivered as video (plays on at least 20% of impressions).
const MIN_VIDEO_PLAY_SHARE = 0.2;

function metrics(sum) {
  const spend = sum.spend || 0;
  const imps = sum.impressions || 0;
  const leads = sum.leads || 0;
  const linkClicks = sum.link_clicks || 0;
  const lpv = sum.lpv || 0;
  const hookViews = sum.video_3s || 0;
  const p25 = sum.video_p25 || 0;
  const thruplay = sum.thruplay || 0;
  const plays = sum.video_plays || 0;
  const isVideoDelivery = imps > 0 && plays / imps >= MIN_VIDEO_PLAY_SHARE;
  // Denominator for hook rate: only impressions that were served as video (so image ads don't dilute a rollup).
  const vidImps = sum.video_impressions !== undefined ? sum.video_impressions : (isVideoDelivery ? imps : 0);
  // Hook views = 3s plays when the API provides them, else 25%-watched views (Meta removed 3s plays from the API).
  const hookBase = vidImps > 0 ? (hookViews || p25) : 0;
  return {
    spend, impressions: imps, reach: sum.reach || 0, clicks: sum.clicks || 0, link_clicks: linkClicks, lpv, leads,
    video_3s: hookViews, video_p25: p25, video_p50: sum.video_p50 || 0, video_p75: sum.video_p75 || 0, video_p100: sum.video_p100 || 0,
    thruplay, video_plays: sum.video_plays || 0,
    cpl: safeDiv(spend, leads),
    cpm: safeDiv(spend, imps) != null ? spend / imps * 1000 : null,
    ctr: safeDiv(linkClicks, imps) != null ? linkClicks / imps * 100 : null,
    cpc: safeDiv(spend, linkClicks),
    cost_per_lpv: safeDiv(spend, lpv),
    lpv_rate: safeDiv(lpv, linkClicks) != null ? lpv / linkClicks * 100 : null,
    lead_rate: safeDiv(leads, lpv) != null ? leads / lpv * 100 : null,            // LPV -> lead
    click_to_lead: safeDiv(leads, linkClicks) != null ? leads / linkClicks * 100 : null,
    hook_rate: hookBase > 0 && vidImps > 0 ? hookBase / vidImps * 100 : null,   // hook views / video impressions
    hold_rate: safeDiv(thruplay, hookBase) != null ? thruplay / hookBase * 100 : null, // thruplay / hook views
    completion_rate: hookBase > 0 ? (sum.video_p100 || 0) / hookBase * 100 : null,
    frequency: sum.frequency || null,
    hook_grade: videoGrade(hookBase > 0 && vidImps > 0 ? hookBase / vidImps * 100 : null, 'hook'),
    hold_grade: videoGrade(safeDiv(thruplay, hookBase) != null ? thruplay / hookBase * 100 : null, 'hold'),
    hook_source: vidImps <= 0 ? null : hookViews ? '3s' : p25 ? 'p25' : null,
    video_play_share: imps > 0 ? plays / imps * 100 : null,
    video_impressions: vidImps,
  };
}

function sumRows(rows) {
  const acc = {};
  const keys = ['spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'lpv', 'leads', 'video_plays', 'video_3s', 'video_p25', 'video_p50', 'video_p75', 'video_p100', 'thruplay'];
  for (const k of keys) acc[k] = 0;
  let freqW = 0, freqSum = 0;
  acc.video_impressions = 0;
  const VIDEO_KEYS = new Set(['video_plays', 'video_3s', 'video_p25', 'video_p50', 'video_p75', 'video_p100', 'thruplay']);
  for (const r of rows) {
    const vi = r.video_impressions !== undefined ? r.video_impressions
      : (r.impressions > 0 && (r.video_plays || 0) / r.impressions >= MIN_VIDEO_PLAY_SHARE ? r.impressions : 0);
    // Video counters only come from rows that actually delivered as video, so the numerator and denominator match.
    for (const k of keys) if (!VIDEO_KEYS.has(k) || vi > 0) acc[k] += r[k] || 0;
    if (r.frequency && r.impressions) { freqSum += r.frequency * r.impressions; freqW += r.impressions; }
    acc.video_impressions += vi;
  }
  acc.frequency = freqW ? freqSum / freqW : null;
  return acc;
}

/**
 * Verdict per group, relative to the client's CPL target.
 *   winner   spend >= min && cpl <= target
 *   promising spend >= min*0.5 && cpl <= target*1.15
 *   loser    spend >= min && (no leads || cpl > target*1.6)
 *   testing  otherwise (not enough spend to call)
 */
function verdict(m, target, minSpend) {
  if (!m.spend) return 'no-spend';
  if (m.spend >= minSpend && m.leads > 0 && m.cpl <= target) return 'winner';
  if (m.spend >= minSpend * 0.5 && m.leads > 0 && m.cpl <= target * 1.15) return 'promising';
  if (m.spend >= minSpend && (m.leads === 0 || m.cpl > target * 1.6)) return 'loser';
  if (m.spend >= minSpend && m.cpl > target) return 'underperforming';
  return 'testing';
}

const STAGES = ['idea', 'production', 'live', 'paused', 'winning', 'retired'];

/** Manual stage wins; otherwise derive from Meta status / delivery. */
function effectiveStage(ad, hasSpend) {
  if (ad.stage && STAGES.includes(ad.stage)) return ad.stage;
  if (ad.planned) return 'idea';
  if (ad.effective_status === 'ACTIVE') return 'live';
  if (['ARCHIVED', 'DELETED'].includes(ad.effective_status)) return 'retired';
  return hasSpend ? 'paused' : 'paused';
}

function buildAdIndex(ads) {
  const idx = new Map();
  for (const a of ads) idx.set(a.ad_id, a);
  return idx;
}

function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Main entry: everything for a client/account set within [since, until].
 */
function overview({ accountIds, since, until, client, geo = null, workspace }) {
  const ads = assignGeos(db.listAds(accountIds), workspace).filter(a => !geo || (geo === 'none' ? !a.geo : a.geo === geo));
  const adIdx = buildAdIndex(ads);
  const inScope = new Set(ads.map(a => a.ad_id));
  const cur = db.aggregateByAd(accountIds, since, until).filter(r => inScope.has(r.ad_id));

  // Prior period of the same length, for trend arrows.
  const len = daysBetween(since, until) + 1;
  const priorSince = shiftDate(since, -len);
  const priorUntil = shiftDate(since, -1);
  const prior = db.aggregateByAd(accountIds, priorSince, priorUntil).filter(r => inScope.has(r.ad_id));
  const priorIdx = new Map(prior.map(r => [r.ad_id, r]));

  // Recent 7d vs the 7d before that — fatigue signal per ad.
  const r7Since = shiftDate(until, -6);
  const r7 = new Map(db.aggregateByAd(accountIds, r7Since, until).map(r => [r.ad_id, r]));
  const p7 = new Map(db.aggregateByAd(accountIds, shiftDate(r7Since, -7), shiftDate(r7Since, -1)).map(r => [r.ad_id, r]));

  const target = client.cpl_target;
  const minSpend = client.min_spend_for_verdict;

  const adRows = cur.map(sum => {
    const a = adIdx.get(sum.ad_id) || { ad_id: sum.ad_id, name: '(unknown ad)', account_id: sum.account_id };
    const m = metrics(sum);
    const pm = priorIdx.has(sum.ad_id) ? metrics(priorIdx.get(sum.ad_id)) : null;
    const recent = r7.has(sum.ad_id) ? metrics(r7.get(sum.ad_id)) : null;
    const before = p7.has(sum.ad_id) ? metrics(p7.get(sum.ad_id)) : null;
    const fatigue = [];
    if (recent && before && recent.spend >= 50 && before.spend >= 50) {
      if (recent.cpl && before.cpl && recent.cpl > before.cpl * 1.3) fatigue.push('CPL up ' + Math.round((recent.cpl / before.cpl - 1) * 100) + '% vs prior 7d');
      if (recent.ctr && before.ctr && recent.ctr < before.ctr * 0.75) fatigue.push('CTR down ' + Math.round((1 - recent.ctr / before.ctr) * 100) + '%');
      if (recent.leads === 0 && before.leads > 0 && recent.spend >= 100) fatigue.push('No leads in last 7d');
    }
    if (recent && recent.frequency && recent.frequency >= 3) fatigue.push('Frequency ' + recent.frequency.toFixed(1));
    return {
      ...a,
      ...m,
      first_date: sum.first_date, last_date: sum.last_date, days_active: sum.days_active,
      prior: pm ? { spend: pm.spend, leads: pm.leads, cpl: pm.cpl, ctr: pm.ctr, hook_rate: pm.hook_rate } : null,
      last7: recent ? { spend: recent.spend, leads: recent.leads, cpl: recent.cpl, ctr: recent.ctr, frequency: recent.frequency } : null,
      fatigue,
      verdict: verdict(m, target, minSpend),
      stage_effective: effectiveStage(a, true),
      tagged: !!(a.angle && (a.hook || a.media_type !== 'video')),
    };
  });

  // Ads with no delivery in window (still listed so they can be tagged ahead of launch)
  const seen = new Set(adRows.map(r => r.ad_id));
  const idle = ads.filter(a => !seen.has(a.ad_id)).map(a => ({ ...a, ...metrics({}), verdict: 'no-spend', fatigue: [], tagged: !!a.angle, prior: null, last7: null, stage_effective: effectiveStage(a, false) }));

  // Pipeline: every ad (with or without delivery) grouped by lifecycle stage
  const pipeline = {};
  for (const st of STAGES) pipeline[st] = [];
  for (const r of [...adRows, ...idle]) pipeline[r.stage_effective].push({
    ad_id: r.ad_id, name: r.name, account_id: r.account_id, geo: r.geo || null, planned: !!r.planned, angle: r.angle, hook: r.hook, format: r.format,
    media_type: r.media_type, hypothesis: r.hypothesis, drive_url: r.drive_url, stage: r.stage, stage_effective: r.stage_effective,
    effective_status: r.effective_status, created_time: r.created_time, spend: r.spend, leads: r.leads, cpl: r.cpl, verdict: r.verdict, fatigue: r.fatigue,
    thumbnail_url: r.thumbnail_url,
  });
  for (const st of STAGES) pipeline[st].sort((a, b) => (b.spend - a.spend) || String(b.created_time || '').localeCompare(String(a.created_time || '')));

  const groupBy = (key, rows) => {
    const groups = new Map();
    for (const r of rows) {
      const k = r[key] || null;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const out = [];
    for (const [k, list] of groups) {
      const m = metrics(sumRows(list));
      const priorList = list.map(r => priorIdx.get(r.ad_id)).filter(Boolean);
      const pm = priorList.length ? metrics(sumRows(priorList)) : null;
      const withLeads = list.filter(r => r.leads > 0).sort((x, y) => x.cpl - y.cpl);
      const credible = withLeads.filter(r => r.spend >= minSpend * 0.5 && r.leads >= 3);
      const best = (credible.length ? credible : withLeads)[0] || null;
      out.push({
        key: k, label: k || 'Untagged', ads: list.length, active_ads: list.filter(r => r.effective_status === 'ACTIVE').length,
        ...m,
        prior: pm ? { spend: pm.spend, leads: pm.leads, cpl: pm.cpl, ctr: pm.ctr, hook_rate: pm.hook_rate } : null,
        verdict: k ? verdict(m, target, minSpend) : 'untagged',
        best_ad: best ? { ad_id: best.ad_id, name: best.name, cpl: best.cpl, leads: best.leads } : null,
        ad_ids: list.map(r => r.ad_id),
        winners: list.filter(r => r.verdict === 'winner').length,
        losers: list.filter(r => r.verdict === 'loser').length,
      });
    }
    return out.sort((a, b) => (b.spend - a.spend));
  };

  const totals = metrics(sumRows(cur));
  const priorTotals = prior.length ? metrics(sumRows(prior)) : null;

  const videoRows = adRows.filter(r => r.media_type === 'video');

  return {
    range: { since, until, days: len, prior_since: priorSince, prior_until: priorUntil },
    client: { ...client, accounts: accountIds },
    totals: { ...totals, ads_with_spend: cur.length, active_ads: adRows.filter(r => r.effective_status === 'ACTIVE').length,
      untagged: adRows.filter(r => !r.angle).length, prior: priorTotals },
    angles: groupBy('angle', adRows),
    hooks: groupBy('hook', videoRows.length ? adRows.filter(r => r.hook || r.media_type === 'video') : adRows),
    formats: groupBy('format', adRows),
    media_types: groupBy('media_type', adRows),
    languages: groupBy('language', adRows),
    geos: (() => {
      const names = new Map(geoList(workspace).map(g => [g.id, g]));
      return groupBy('geo', adRows).map(g => {
        const meta = names.get(g.key);
        const all = groupBy('angle', adRows.filter(r => (r.geo || null) === g.key)).filter(x => x.key && x.leads > 0);
        const solid = all.filter(x => x.spend >= minSpend && x.leads >= 3);
        const angles = (solid.length ? solid : all).sort((a, b) => a.cpl - b.cpl);
        return { ...g, label: meta ? meta.name : 'Unassigned', short: meta ? meta.short : 'Unassigned', color: meta ? meta.color : null,
          top_angle: angles[0] ? { angle: angles[0].key, cpl: angles[0].cpl, leads: angles[0].leads, spend: angles[0].spend } : null };
      });
    })(),
    geo_list: geoList(workspace),
    video_benchmark: videoBench(),
    ads: adRows.sort((a, b) => b.spend - a.spend),
    idle_ads: idle,
    pipeline, stages: STAGES,
  };
}

/** Angle × Hook matrix (spend, leads, cpl per cell) for the heatmap. */
function matrix({ accountIds, since, until, rowKey = 'angle', colKey = 'hook', geo = null, workspace }) {
  const ads = assignGeos(db.listAds(accountIds), workspace).filter(a => !geo || (geo === 'none' ? !a.geo : a.geo === geo));
  const adIdx = buildAdIndex(ads);
  const cur = db.aggregateByAd(accountIds, since, until).filter(r => adIdx.has(r.ad_id));
  const cells = new Map();
  for (const sum of cur) {
    const a = adIdx.get(sum.ad_id); if (!a) continue;
    const rk = a[rowKey] || 'Untagged', ck = a[colKey] || 'Untagged';
    const key = rk + ' ' + ck;
    if (!cells.has(key)) cells.set(key, { row: rk, col: ck, rows: [] });
    cells.get(key).rows.push(sum);
  }
  return [...cells.values()].map(c => ({ row: c.row, col: c.col, ads: c.rows.length, ...metrics(sumRows(c.rows)) }));
}

function adDetail({ adId, since, until, workspace }) {
  const ad = db.getAd(adId);
  if (!ad) return null;
  assignGeos([ad], workspace);
  const daily = db.dailyForAd(adId, since, until).map(r => ({ date: r.date, ...metrics(r) }));
  const total = metrics(sumRows(db.dailyForAd(adId, since, until)));
  const lifetime = metrics(sumRows(db.dailyForAd(adId, '2000-01-01', '2100-01-01')));
  ad.stage_effective = effectiveStage(ad, lifetime.spend > 0);
  return { ad, daily, total, lifetime };
}

module.exports = { overview, matrix, adDetail, metrics, sumRows, verdict, shiftDate, effectiveStage, STAGES, videoGrade, VIDEO_BENCH };
