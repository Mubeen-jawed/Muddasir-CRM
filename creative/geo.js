'use strict';

// County assignment for ads, using the SAME geo rules as the budget dashboard
// (config.js → getGeos). An ad belongs to the first geo whose account rule
// matches its campaign name, with the same case-insensitive substring test the
// budget dashboard applies to campaigns.

const crmConfig = require('../config');

function matches(name, kw) {
  return String(name || '').toUpperCase().includes(String(kw).toUpperCase());
}

function geoForAd(ad, geos) {
  for (const g of geos) {
    for (const acc of g.accounts) {
      if (acc.accountId !== ad.account_id) continue;
      if (acc.excludeKeywords && acc.excludeKeywords.some(k => matches(ad.campaign_name, k))) continue;
      if (acc.includeKeywords && !acc.includeKeywords.some(k => matches(ad.campaign_name, k))) continue;
      return g.id;
    }
  }
  return null;
}

function shortName(name) {
  return String(name || '').replace(/^ADU\s*[—-]\s*/i, '').replace(/^Outdoor Program\s*[—-]\s*/i, 'Outdoor ').trim();
}

function geoList(workspaceId) {
  return crmConfig.getGeos(workspaceId).map(g => ({ id: g.id, name: g.name, short: shortName(g.name), color: g.color || null }));
}

function assignGeos(ads, workspaceId) {
  const geos = crmConfig.getGeos(workspaceId);
  for (const a of ads) a.geo = geoForAd(a, geos);
  return ads;
}

module.exports = { assignGeos, geoForAd, geoList };
