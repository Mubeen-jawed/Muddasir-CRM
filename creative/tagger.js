'use strict';

/**
 * Parses a Meta ad name into structured creative tags.
 *
 * Conventions seen across Ben's accounts (all supported):
 *   "Heygen UGC | ADU RENT ANGLE | TENANTS PAYS OUR MORTGAGE | V5"
 *   "STATIC | STATE WILL PAY ANGLE"
 *   "V3. Everything you were told. Contractor overcharge angle. UGC . calculator-Vid.EN.v1 – – Copy"
 *   "V3/TEST/EMPTY-BACKYARD-COSTING/ENG"
 *   "Netflix's angle - VID 7"
 *   "VID – 4 Spanish", "IMG-15", "DIMG-2", "Static5", "S4", "DS4", "V5/Hook test"
 *
 * Output: { format, media_type, angle, hook, language, version, confidence, unparsed }
 *   format      raw creative format label, normalized (Heygen UGC, AI UGC, UGC, Static, Image, Video, ...)
 *   media_type  'video' | 'image' | 'carousel' | null (only from the name; sync overrides with the creative)
 *   angle       the core message / persona angle
 *   hook        the opening hook line
 *   language    'EN' | 'ES' | null
 *   version     integer or null
 *   confidence  'high' (angle found) | 'medium' (hook or format only) | 'low' (nothing useful)
 */

const FORMAT_MAP = [
  [/^heygen\s*ugc$/i, 'Heygen UGC', 'video'],
  [/^ai\s*ugc$/i, 'AI UGC', 'video'],
  [/^ai\s*hook$/i, 'AI Hook', 'video'],
  [/^ugc$/i, 'UGC', 'video'],
  [/^ai$/i, 'AI Video', 'video'],
  [/^(vid|video|v|dvid)$/i, 'Video', 'video'],
  [/^(img|image|dimg|static|s|ds|poster)$/i, 'Static', 'image'],
  [/^(carousel|car)$/i, 'Carousel', 'carousel'],
  [/^(sign\s*guy)$/i, 'Sign Guy', 'video'],
  [/^(testimonial)$/i, 'Testimonial', 'video'],
  [/^(reel|reels)$/i, 'Reel', 'video'],
];

const LANG_MAP = [
  [/^(en|eng|english)$/i, 'EN'],
  [/^(es|sp|spa|spanish|espanol|español)$/i, 'ES'],
];

const NOISE_SEGMENTS = /^(test|testing|copy|new|final|win|winner|lose|loser|calculator(-vid)?|lp\d*|broad|cold|retarget(ing)?|hook\s*test|new\s+leads?\s+ad|ad|ads|adu\s*-?\s*\d*)$/i;

function clean(s) {
  return s
    .replace(/[–—]/g, '-')          // en/em dashes -> hyphen
    .replace(/(\s*-)*\s*copy(\s*\d+)?\s*$/i, '')   // "– Copy", "– – Copy 2", "Copy 3"
    .replace(/(\s*-)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  const small = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'x', 'vs', 'my', 'our', 'your', 'but', 'until', 'from', 'with', 'at', 'by', 'is', 'it', 'be']);
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bAdu\b/g, 'ADU')
    .replace(/\bWfh\b/g, 'WFH')
    .replace(/\bA\/c\b/gi, 'A/C')
    .replace(/\bUgc\b/g, 'UGC')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bHoa\b/g, 'HOA')
    .replace(/\bRoi\b/g, 'ROI')
    .replace(/\bVo\b/g, 'VO')
    .replace(/\bCta\b/g, 'CTA')
    .replace(/\bDiy\b/g, 'DIY')
    .replace(/\bLa\b(?=\s*$|\s+(County|Homeowners?))/gi, 'LA');
}

function stripKeyword(seg, kw) {
  return seg.replace(new RegExp(`\\b${kw}s?\\b`, 'ig'), '').replace(/\s{2,}/g, ' ').replace(/^[\s\-:.]+|[\s\-:.]+$/g, '').trim();
}

/** Try to read a format label with optional trailing number, e.g. "VID 7", "IMG-15", "Static5", "Heygen UGC". */
function matchFormat(seg) {
  const m = seg.match(/^([a-z][a-z\s]*?)\s*-?\s*(\d+)?$/i);
  if (!m) return null;
  const label = m[1].trim();
  const num = m[2] ? parseInt(m[2], 10) : null;
  for (const [re, name, media] of FORMAT_MAP) {
    if (re.test(label)) return { format: name, media_type: media, version: num };
  }
  return null;
}

function matchLanguage(seg) {
  for (const [re, code] of LANG_MAP) if (re.test(seg.trim())) return code;
  return null;
}

function matchVersion(seg) {
  const m = seg.match(/^v\.?\s*(\d+)$/i) || seg.match(/^v(\d+)\s*[.\-]/i);
  return m ? parseInt(m[1], 10) : null;
}

function splitSegments(name) {
  // Prefer the most explicit delimiter present.
  if (name.includes('|')) return name.split('|');
  if ((name.match(/\//g) || []).length >= 2) return name.split('/');
  if (/\s-\s/.test(name)) return name.split(/\s-\s/);
  if (name.includes('/')) return name.split('/');
  // Dot-delimited (Pacific style): only if it yields several word-bearing segments.
  const dotParts = name.split(/\.(?!\d)/);
  if (dotParts.filter(p => /[a-z]{2,}/i.test(p)).length >= 2) return dotParts;
  return [name];
}

function parseAdName(rawName) {
  const name = clean(rawName || '');
  const out = { format: null, media_type: null, angle: null, hook: null, language: null, version: null, confidence: 'low', unparsed: [] };
  if (!name) return out;

  // Whole-name quick wins: "VID – 4 Spanish", "IMG-1 4"
  const langInName = name.match(/\b(spanish|espanol|español)\b/i);
  if (langInName) out.language = 'ES';

  const bare = name.match(/^v\s*-?\s*(\d+)$/i);
  if (bare) { out.format = 'Video'; out.media_type = 'video'; out.version = parseInt(bare[1], 10); out.confidence = 'medium'; return out; }

  const segments = splitSegments(name).map(s => s.trim()).filter(Boolean);
  const residual = [];

  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i].replace(/\b(spanish|espanol|español)\b/i, '').trim();
    if (!seg) continue;

    // Trailing "/v1", ".v1", "V3." style version tokens glued to segment
    const glued = seg.match(/^(.*?)[\s.]*\bv(\d+)$/i);
    if (glued && glued[1] && !/^v$/i.test(glued[1].trim())) {
      out.version = out.version ?? parseInt(glued[2], 10);
      seg = glued[1].trim();
    }

    if (/\bangle\b/i.test(seg)) {
      const a = stripKeyword(seg, 'angle');
      if (a) out.angle = out.angle || titleCase(a);
      continue;
    }
    if (NOISE_SEGMENTS.test(seg)) continue;
    if (/\bhook\b/i.test(seg) && i > 0) {
      const h = stripKeyword(seg, 'hook');
      if (h) out.hook = out.hook || titleCase(h);
      continue;
    }
    const lang = matchLanguage(seg);
    if (lang) { out.language = out.language || lang; continue; }

    const ver = matchVersion(seg);
    if (ver != null && /^v\.?\s*\d+$/i.test(seg)) { out.version = out.version ?? ver; continue; }

    const fmt = matchFormat(seg.replace(/[\s-]*(test|new|copy)$/i, '').trim());
    if (fmt) {
      out.format = out.format || fmt.format;
      out.media_type = out.media_type || fmt.media_type;
      if (fmt.version != null) out.version = out.version ?? fmt.version;
      continue;
    }

    if (NOISE_SEGMENTS.test(seg)) continue;

    // Segment starting with "V3." (Pacific) — extract version, keep the rest
    const lead = seg.match(/^v(\d+)\s*[.\-]\s*(.*)$/i);
    if (lead) { out.version = out.version ?? parseInt(lead[1], 10); seg = lead[2].trim(); if (!seg) continue; }

    // First segment that is a format with extra words, e.g. "AI Hook", "VID5 - AI"
    if (i === 0 && /^(ai|heygen|ugc|vid|img|static)\b/i.test(seg) && seg.split(' ').length <= 3) {
      const f = matchFormat(seg.replace(/\d+/g, '').trim());
      if (f) { out.format = out.format || f.format; out.media_type = out.media_type || f.media_type; const n = seg.match(/(\d+)/); if (n) out.version = out.version ?? parseInt(n[1], 10); continue; }
    }

    residual.push(seg.replace(/-/g, ' ').trim());
  }

  // Residual text: the longest phrase is the angle (unless one was explicit), the next becomes the hook.
  const usable = residual.filter(r => /[a-z]{3,}/i.test(r)).sort((a, b) => b.split(' ').length - a.split(' ').length);
  for (const r of usable) {
    if (!out.angle) out.angle = titleCase(r);
    else if (!out.hook && r.split(' ').length >= 2) out.hook = titleCase(r);
    else out.unparsed.push(r);
  }

  if (!out.language && (out.angle || out.hook)) out.language = 'EN';

  out.confidence = out.angle ? 'high' : (out.hook || out.format) ? 'medium' : 'low';
  return out;
}

module.exports = { parseAdName, titleCase };
