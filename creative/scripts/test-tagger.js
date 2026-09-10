'use strict';
const { parseAdName } = require('../tagger');

const samples = [
  'Heygen UGC |  ADU RENT ANGLE | TENANTS PAYS OUR MORTGAGE | V5',
  'AI UGC | HOMEOWNER UGC ANGLE | I ALMOST PAID HOOK | V4',
  'AI Hook | DIVORCE X RENT ANGLE | CHECKS THE BECKYARD BEFORE EVEN SAYING GOOD MORNING HOOK | V3',
  'STATIC |  STATE WILL PAY ANGLE',
  'Heygen UGC | PARENTS ANGLE | MOM NEED HER OWN SPACE HOOK | V2',
  'Heygen UGC |  EXTRA SPACE ANGLE | NEED MORE SPACE BUT DONT WANNA MOVE  | V9 – Copy',
  'V3. Everything you were told. Contractor overcharge angle. UGC . calculator-Vid.EN.v1 – – Copy',
  'V1. ADU cost angle. UGC . calculator-Vid.EN.v1 – – Copy',
  'V3/TEST/EMPTY-BACKYARD-COSTING/ENG',
  'V5/Hook test',
  "Netflix's angle - VID 7",
  'Backyard costing angle - VID 8',
  'You dont need a pool angle - VID 11',
  'outdoor kitchen & dining angle - VID 15',
  'VID – 4 Spanish',
  'IMG-15', 'IMG-1 4', 'DIMG-2', 'Static5', 'S4', 'DS4', 'VID5 - AI', 'VID', 'V12', 'IMG6 – Copy', 'New Leads Ad', 'IMG-7 – Copy',
];

for (const s of samples) {
  const p = parseAdName(s);
  console.log(`\n${s}\n  → format=${p.format} media=${p.media_type} angle=${p.angle} hook=${p.hook} lang=${p.language} v=${p.version} conf=${p.confidence}${p.unparsed.length ? ' unparsed=' + JSON.stringify(p.unparsed) : ''}`);
}
