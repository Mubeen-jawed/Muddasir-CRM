'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      ad_id            TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL,
      name             TEXT NOT NULL,
      campaign_id      TEXT,
      campaign_name    TEXT,
      adset_id         TEXT,
      adset_name       TEXT,
      status           TEXT,
      effective_status TEXT,
      created_time     TEXT,
      creative_id      TEXT,
      media_type       TEXT,          -- video | image | carousel | unknown (from the creative object)
      thumbnail_url    TEXT,
      body             TEXT,
      title            TEXT,
      link_url         TEXT,
      -- creative tags (auto-parsed from the ad name, or edited manually)
      format           TEXT,
      angle            TEXT,
      hook             TEXT,
      language         TEXT,
      version          INTEGER,
      tag_source       TEXT DEFAULT 'auto',   -- auto | manual
      tag_confidence   TEXT,
      notes            TEXT,
      first_seen       TEXT,
      last_synced      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ads_account ON ads(account_id);
    CREATE INDEX IF NOT EXISTS idx_ads_angle ON ads(angle);
    CREATE INDEX IF NOT EXISTS idx_ads_hook ON ads(hook);

    CREATE TABLE IF NOT EXISTS ad_daily (
      ad_id        TEXT NOT NULL,
      date         TEXT NOT NULL,
      account_id   TEXT NOT NULL,
      spend        REAL DEFAULT 0,
      impressions  INTEGER DEFAULT 0,
      reach        INTEGER DEFAULT 0,
      clicks       INTEGER DEFAULT 0,
      link_clicks  INTEGER DEFAULT 0,
      lpv          INTEGER DEFAULT 0,
      leads        REAL DEFAULT 0,
      video_plays  INTEGER DEFAULT 0,
      video_3s     INTEGER DEFAULT 0,     -- hook views (3s, or 2s-continuous fallback)
      video_p25    INTEGER DEFAULT 0,
      video_p50    INTEGER DEFAULT 0,
      video_p75    INTEGER DEFAULT 0,
      video_p100   INTEGER DEFAULT 0,
      thruplay     INTEGER DEFAULT 0,
      avg_watch    REAL,
      frequency    REAL,
      fetched_at   TEXT NOT NULL,
      PRIMARY KEY (ad_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_account_date ON ad_daily(account_id, date);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      source       TEXT,               -- graph | import
      ads_upserted INTEGER DEFAULT 0,
      rows_upserted INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'running',
      message      TEXT
    );

    -- Canonical names so "ADU Rent" and "Rent Angle" can be merged without renaming every ad by hand
    CREATE TABLE IF NOT EXISTS aliases (
      kind   TEXT NOT NULL,   -- angle | hook | format
      raw    TEXT NOT NULL,
      canonical TEXT NOT NULL,
      PRIMARY KEY (kind, raw)
    );
  `);
  const cols = new Set(db.prepare("PRAGMA table_info(ads)").all().map(c => c.name));
  const add = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE ads ADD COLUMN ${name} ${ddl}`); };
  add('drive_url', 'TEXT');        // Google Drive folder / file with the creative assets
  add('stage', 'TEXT');            // manual lifecycle stage: idea | production | live | winning | retired (null = derived)
  add('hypothesis', 'TEXT');       // what this creative is testing
  add('planned', 'INTEGER DEFAULT 0'); // 1 = logged here before it exists in Meta
}

// ── Ads ──────────────────────────────────────────────────────────────────────

const AD_COLS = ['ad_id', 'account_id', 'name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'status',
  'effective_status', 'created_time', 'creative_id', 'media_type', 'thumbnail_url', 'body', 'title', 'link_url',
  'format', 'angle', 'hook', 'language', 'version', 'tag_confidence'];

/**
 * Upsert an ad. Tags from the name parser are only written when the row is new or tag_source is 'auto'.
 */
function upsertAd(ad) {
  const d = getDb();
  const now = new Date().toISOString();
  const row = {};
  for (const c of AD_COLS) row[c] = ad[c] === undefined ? null : ad[c];
  row.now = now;
  d.prepare(`
    INSERT INTO ads (${AD_COLS.join(', ')}, tag_source, first_seen, last_synced)
    VALUES (${AD_COLS.map(c => '@' + c).join(', ')}, 'auto', @now, @now)
    ON CONFLICT(ad_id) DO UPDATE SET
      name=@name, campaign_id=COALESCE(@campaign_id, campaign_id), campaign_name=COALESCE(@campaign_name, campaign_name),
      adset_id=COALESCE(@adset_id, adset_id), adset_name=COALESCE(@adset_name, adset_name),
      status=COALESCE(@status, status), effective_status=COALESCE(@effective_status, effective_status),
      created_time=COALESCE(@created_time, created_time), creative_id=COALESCE(@creative_id, creative_id),
      media_type=COALESCE(@media_type, media_type), thumbnail_url=COALESCE(@thumbnail_url, thumbnail_url),
      body=COALESCE(@body, body), title=COALESCE(@title, title), link_url=COALESCE(@link_url, link_url),
      format   = CASE WHEN tag_source='manual' THEN format   ELSE @format   END,
      angle    = CASE WHEN tag_source='manual' THEN angle    ELSE @angle    END,
      hook     = CASE WHEN tag_source='manual' THEN hook     ELSE @hook     END,
      language = CASE WHEN tag_source='manual' THEN language ELSE @language END,
      version  = CASE WHEN tag_source='manual' THEN version  ELSE @version  END,
      tag_confidence = CASE WHEN tag_source='manual' THEN tag_confidence ELSE @tag_confidence END,
      last_synced=@now
  `).run(row);
}

const META_FIELDS = ['drive_url', 'stage', 'hypothesis'];

function updateAdMeta(adId, meta) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
  if (!cur) return null;
  const next = { ad_id: adId };
  for (const k of META_FIELDS) {
    let v = meta[k] !== undefined ? meta[k] : cur[k];
    if (typeof v === 'string') v = v.trim() || null;
    next[k] = v;
  }
  d.prepare('UPDATE ads SET drive_url=@drive_url, stage=@stage, hypothesis=@hypothesis WHERE ad_id=@ad_id').run(next);
  return d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
}

function updateAdTags(adId, tags) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
  if (!cur) return null;
  const next = {
    format: tags.format !== undefined ? tags.format : cur.format,
    angle: tags.angle !== undefined ? tags.angle : cur.angle,
    hook: tags.hook !== undefined ? tags.hook : cur.hook,
    language: tags.language !== undefined ? tags.language : cur.language,
    version: tags.version !== undefined ? tags.version : cur.version,
    notes: tags.notes !== undefined ? tags.notes : cur.notes,
    media_type: tags.media_type !== undefined ? tags.media_type : cur.media_type,
    ad_id: adId,
  };
  for (const k of ['format', 'angle', 'hook', 'language', 'notes']) {
    if (typeof next[k] === 'string') next[k] = next[k].trim() || null;
  }
  d.prepare(`UPDATE ads SET format=@format, angle=@angle, hook=@hook, language=@language, version=@version,
             notes=@notes, media_type=@media_type, tag_source='manual', tag_confidence='manual' WHERE ad_id=@ad_id`).run(next);
  return d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
}

function resetAdTags(adId, parsed) {
  getDb().prepare(`UPDATE ads SET format=@format, angle=@angle, hook=@hook, language=@language, version=@version,
    tag_source='auto', tag_confidence=@confidence WHERE ad_id=@ad_id`).run({ ...parsed, ad_id: adId });
}

/** Rename a tag value across every ad of the given accounts (bulk merge). */
function renameTag(kind, from, to, accountIds) {
  if (!['angle', 'hook', 'format'].includes(kind)) throw new Error('bad kind');
  const d = getDb();
  const placeholders = accountIds.map(() => '?').join(',');
  const info = d.prepare(`UPDATE ads SET ${kind} = ?, tag_source='manual' WHERE ${kind} = ? AND account_id IN (${placeholders})`)
    .run(to, from, ...accountIds);
  return info.changes;
}

/** Log a creative that does not exist in Meta yet. Returns the new row. */
function createPlannedAd(fields) {
  const d = getDb();
  const id = 'planned_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO ads (ad_id, account_id, name, status, effective_status, created_time, media_type, format, angle, hook, language, version,
      tag_source, tag_confidence, notes, drive_url, stage, hypothesis, planned, first_seen, last_synced)
    VALUES (@ad_id, @account_id, @name, 'PLANNED', 'PLANNED', @now, @media_type, @format, @angle, @hook, @language, @version,
      'manual', 'manual', @notes, @drive_url, @stage, @hypothesis, 1, @now, @now)`).run({
    ad_id: id, now, account_id: fields.account_id, name: fields.name, media_type: fields.media_type || null, format: fields.format || null,
    angle: fields.angle || null, hook: fields.hook || null, language: fields.language || null, version: fields.version ?? null,
    notes: fields.notes || null, drive_url: fields.drive_url || null, stage: fields.stage || 'idea', hypothesis: fields.hypothesis || null,
  });
  return d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(id);
}

/** Copy a planned row's tags/meta onto the real Meta ad, then remove the planned row. */
function linkPlannedAd(plannedId, adId) {
  const d = getDb();
  const p = d.prepare('SELECT * FROM ads WHERE ad_id = ? AND planned = 1').get(plannedId);
  const a = d.prepare('SELECT * FROM ads WHERE ad_id = ? AND planned = 0').get(adId);
  if (!p || !a) return null;
  d.prepare(`UPDATE ads SET format=COALESCE(@format, format), angle=COALESCE(@angle, angle), hook=COALESCE(@hook, hook),
      language=COALESCE(@language, language), version=COALESCE(@version, version), notes=COALESCE(@notes, notes),
      drive_url=COALESCE(@drive_url, drive_url), stage=@stage, hypothesis=COALESCE(@hypothesis, hypothesis),
      tag_source='manual', tag_confidence='manual' WHERE ad_id=@ad_id`)
    .run({ ...p, stage: p.stage && p.stage !== 'idea' && p.stage !== 'production' ? p.stage : null, ad_id: adId });
  d.prepare('DELETE FROM ads WHERE ad_id = ?').run(plannedId);
  return d.prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
}

function deletePlannedAd(plannedId) {
  return getDb().prepare('DELETE FROM ads WHERE ad_id = ? AND planned = 1').run(plannedId).changes;
}

function getAd(adId) {
  return getDb().prepare('SELECT * FROM ads WHERE ad_id = ?').get(adId);
}

function listAds(accountIds) {
  const placeholders = accountIds.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM ads WHERE account_id IN (${placeholders}) ORDER BY created_time DESC`).all(...accountIds);
}

// ── Daily rows ───────────────────────────────────────────────────────────────

const DAILY_COLS = ['ad_id', 'date', 'account_id', 'spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'lpv', 'leads',
  'video_plays', 'video_3s', 'video_p25', 'video_p50', 'video_p75', 'video_p100', 'thruplay', 'avg_watch', 'frequency'];

function upsertDailyBatch(rows) {
  const d = getDb();
  const now = new Date().toISOString();
  const stmt = d.prepare(`
    INSERT INTO ad_daily (${DAILY_COLS.join(', ')}, fetched_at)
    VALUES (${DAILY_COLS.map(c => '@' + c).join(', ')}, @now)
    ON CONFLICT(ad_id, date) DO UPDATE SET
      ${DAILY_COLS.filter(c => !['ad_id', 'date'].includes(c)).map(c => `${c}=@${c}`).join(', ')}, fetched_at=@now
  `);
  const tx = d.transaction((list) => {
    for (const r of list) {
      const row = { now };
      for (const c of DAILY_COLS) row[c] = r[c] === undefined ? (c === 'avg_watch' || c === 'frequency' ? null : 0) : r[c];
      stmt.run(row);
    }
  });
  tx(rows);
  return rows.length;
}

const VIDEO_COLS = ['video_plays', 'video_3s', 'video_p25', 'video_p50', 'video_p75', 'video_p100', 'thruplay', 'avg_watch'];

/**
 * Merge video metrics into existing daily rows without touching spend/leads/etc.
 * Rows for (ad_id, date) pairs that don't exist yet are inserted with just the video numbers (+ spend/impressions when given).
 */
function upsertDailyVideoBatch(rows) {
  const d = getDb();
  const now = new Date().toISOString();
  const upd = d.prepare(`UPDATE ad_daily SET ${VIDEO_COLS.map(c => `${c}=@${c}`).join(', ')}, fetched_at=@now WHERE ad_id=@ad_id AND date=@date`);
  const ins = d.prepare(`INSERT INTO ad_daily (ad_id, date, account_id, spend, impressions, ${VIDEO_COLS.join(', ')}, fetched_at)
    VALUES (@ad_id, @date, @account_id, @spend, @impressions, ${VIDEO_COLS.map(c => '@' + c).join(', ')}, @now)`);
  let updated = 0, inserted = 0;
  const tx = d.transaction((list) => {
    for (const r of list) {
      const row = { now, ad_id: r.ad_id, date: r.date, account_id: r.account_id, spend: r.spend || 0, impressions: r.impressions || 0 };
      for (const c of VIDEO_COLS) row[c] = r[c] === undefined ? (c === 'avg_watch' ? null : 0) : r[c];
      if (upd.run(row).changes) updated++; else { ins.run(row); inserted++; }
    }
  });
  tx(rows);
  return { updated, inserted };
}

/** Aggregate metrics per ad for a date window (inclusive, YYYY-MM-DD). */
function aggregateByAd(accountIds, since, until) {
  const placeholders = accountIds.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT ad_id,
      SUM(spend) spend, SUM(impressions) impressions, SUM(reach) reach, SUM(clicks) clicks,
      SUM(link_clicks) link_clicks, SUM(lpv) lpv, SUM(leads) leads,
      SUM(video_plays) video_plays, SUM(video_3s) video_3s, SUM(video_p25) video_p25, SUM(video_p50) video_p50,
      SUM(video_p75) video_p75, SUM(video_p100) video_p100, SUM(thruplay) thruplay,
      AVG(NULLIF(frequency,0)) frequency,
      MIN(date) first_date, MAX(date) last_date, COUNT(*) days_active
    FROM ad_daily
    WHERE account_id IN (${placeholders}) AND date >= ? AND date <= ? AND (spend > 0 OR impressions > 0)
    GROUP BY ad_id
  `).all(...accountIds, since, until);
}

function dailyForAd(adId, since, until) {
  return getDb().prepare(`SELECT * FROM ad_daily WHERE ad_id = ? AND date >= ? AND date <= ? ORDER BY date`).all(adId, since, until);
}

function dateBounds(accountIds) {
  const placeholders = accountIds.map(() => '?').join(',');
  return getDb().prepare(`SELECT MIN(date) min_date, MAX(date) max_date FROM ad_daily WHERE account_id IN (${placeholders})`).get(...accountIds);
}

// ── Sync runs ────────────────────────────────────────────────────────────────

function startRun(source) {
  return getDb().prepare(`INSERT INTO sync_runs (started_at, source) VALUES (?, ?)`).run(new Date().toISOString(), source).lastInsertRowid;
}
function finishRun(id, { ads = 0, rows = 0, status = 'ok', message = null }) {
  getDb().prepare(`UPDATE sync_runs SET finished_at=?, ads_upserted=?, rows_upserted=?, status=?, message=? WHERE id=?`)
    .run(new Date().toISOString(), ads, rows, status, message, id);
}
function lastRun() {
  return getDb().prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).get();
}

module.exports = {
  getDb, upsertAd, updateAdTags, updateAdMeta, resetAdTags, renameTag, getAd, listAds,
  createPlannedAd, linkPlannedAd, deletePlannedAd,
  upsertDailyBatch, upsertDailyVideoBatch, aggregateByAd, dailyForAd, dateBounds,
  startRun, finishRun, lastRun,
};
