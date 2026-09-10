#!/usr/bin/env node
'use strict';
// Re-runs the name parser over every ad that has not been tagged by hand.
const db = require('../db');
const { parseAdName } = require('../tagger');
const d = db.getDb();
const ads = d.prepare("SELECT ad_id, name FROM ads WHERE tag_source = 'auto' OR tag_source IS NULL").all();
let changed = 0;
for (const a of ads) {
  const p = parseAdName(a.name);
  const before = d.prepare('SELECT format, angle, hook, language, version FROM ads WHERE ad_id = ?').get(a.ad_id);
  db.resetAdTags(a.ad_id, p);
  if (JSON.stringify(before) !== JSON.stringify({ format: p.format, angle: p.angle, hook: p.hook, language: p.language, version: p.version })) changed++;
}
console.log(`Re-parsed ${ads.length} auto-tagged ads, ${changed} changed`);
