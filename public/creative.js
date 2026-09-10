(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const fmtN = (n, d = 0) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtM = (n, d = 0) => n == null || isNaN(n) ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtP = (n, d = 1) => n == null || isNaN(n) ? '—' : Number(n).toFixed(d) + '%';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STAGE_LABELS = { idea: 'Idea', production: 'In production', live: 'Live', paused: 'Paused', winning: 'Winning batch', retired: 'Retired' };
  const ICONS = {
    download: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    refresh: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  };
  const SPINNER_HTML = '<span class="ios-spinner" aria-hidden="true">' + Array.from({ length: 12 }, (_, i) => `<i style="transform:rotate(${i * 30}deg);animation-delay:${(-(11 - i) / 12).toFixed(3)}s"></i>`).join('') + '</span>';
  const skLine = (w, h) => `<span class="sk" style="width:${w};height:${h || 12}px"></span>`;
  // Page shape while the first load (or a scope change) is in flight.
  function renderSkeleton() {
    $('#cr_kpiRow').innerHTML = Array.from({ length: 8 }, () => `<div class="kpi-card"><div class="kpi-label">${skLine('55%', 10)}</div><div class="kpi-value">${skLine('70%', 22)}</div></div>`).join('');
    const rows = (n, cols) => `<tbody>${Array.from({ length: n }, () => `<tr>${Array.from({ length: cols }, () => `<td>${skLine('80%')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    for (const [id, cols] of [['#cr_anglesTable', 8], ['#cr_hooksTable', 8], ['#cr_countiesTable', 8], ['#cr_adsTable', 9]]) { const el = $(id); if (el && !el.querySelector('tbody tr[data-key], tbody tr[data-ad], tbody tr[data-geo]')) el.innerHTML = rows(6, cols); }
  }
  function setBusy(on) { const b = $('#cr_crBusy'); if (b) b.classList.toggle('hidden', !on); }

  const state = { workspace: null, enabled: false, scope: 'all', geo: '', days: 30, tab: 'angles', data: null, config: null, sort: {}, adFilter: { q: '', status: '', verdict: '', untagged: false, angle: null, hook: null, format: null }, drawerAd: null, tags: null };

  // ── API ──
  function withWs(url) {
    const u = url.replace(/^\/api\//, '/api/creative/');
    return u + (u.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(state.workspace || '');
  }
  async function api(url, opts) {
    const res = await fetch(withWs(url), Object.assign({ credentials: 'same-origin' }, opts || {}));
    if (res.status === 401) { window.location.replace('/login'); throw new Error('unauthorized'); }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }


  function toast(msg, ms = 2500) { const t = $('#cr_toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }

  // ── Loading ──
  async function loadConfig() {
    state.config = await api('/api/config');
    state.enabled = !!state.config.enabled;
    if (!state.enabled) return;
    $('#cr_dashboard').classList.toggle('cr-client', !state.config.admin);
    const seg = $('#cr_scopeSeg');
    const btn = (key, label) => `<button data-scope="${esc(key)}" class="${state.scope === key ? 'cr-active' : ''}">${esc(label)}</button>`;
    let html = btn('all', 'All');
    for (const [k, c] of Object.entries(state.config.clients)) html += btn(k, c.short || c.name);
    for (const a of state.config.accounts.filter(a => a.active !== false)) html += btn(a.id, a.name);
    seg.innerHTML = html;
    seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.scope = b.dataset.scope; refresh(); };
    const gseg = $('#cr_geoSeg');
    gseg.innerHTML = `<button data-geo="" class="${state.geo === '' ? 'cr-active' : ''}">All counties</button>` +
      (state.config.geos || []).map(g => `<button data-geo="${esc(g.id)}" class="${state.geo === g.id ? 'cr-active' : ''}">${esc(g.short)}</button>`).join('');
    gseg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.geo = b.dataset.geo; refresh(); };
    $('#cr_plannedAccount').innerHTML = state.config.accounts.filter(a => a.active !== false).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    const last = state.config.last_sync;
    const syncBtn = $('#cr_syncBtn');
    syncBtn.title = state.config.token_configured ? `Scheduled: ${state.config.cron || 'off'}` : 'Add META_ACCESS_TOKEN to .env to enable';
    syncBtn.disabled = !state.config.token_configured;
    const hs = $('#headerSub'); if (hs) hs.textContent = last ? `Last data ${last.source === 'import' ? 'import' : 'sync'}: ${new Date(last.finished_at || last.started_at).toLocaleString()} (${last.status})` : 'No data yet — run a sync or import';
  }

  async function refresh() {
    if (!state.data) renderSkeleton();
    setBusy(true);
    $$('#cr_scopeSeg button').forEach(b => b.classList.toggle('cr-active', b.dataset.scope === state.scope));
    $$('#cr_rangeSeg button').forEach(b => b.classList.toggle('cr-active', parseInt(b.dataset.days, 10) === state.days));
    $$('#cr_geoSeg button').forEach(b => b.classList.toggle('cr-active', b.dataset.geo === state.geo));
    try {
      const [data, tags] = await Promise.all([
        api(`/api/overview?scope=${encodeURIComponent(state.scope)}&days=${state.days}&geo=${encodeURIComponent(state.geo)}`),
        api(`/api/tags?scope=${encodeURIComponent(state.scope)}`),
      ]);
      state.data = data; state.tags = tags;
      fillDatalists();
      renderAll();
    } catch (err) { if (err.message !== 'unauthorized') toast('Error: ' + err.message); }
    finally { setBusy(false); }
  }

  function fillDatalists() {
    const fill = (id, list) => { $(id).innerHTML = list.map(v => `<option value="${esc(v)}">`).join(''); };
    fill('#cr_angleList', state.tags.angles); fill('#cr_hookList', state.tags.hooks); fill('#cr_formatList', state.tags.formats);
  }

  // ── Rendering helpers ──
  function trend(cur, prior, invert = true) {
    if (cur == null || prior == null || prior === 0) return '';
    const pct = (cur - prior) / prior * 100;
    if (Math.abs(pct) < 1) return `<span class="trend neutral">→</span>`;
    const good = invert ? pct < 0 : pct > 0;
    return `<span class="trend ${good ? 'good' : 'bad'}" title="vs prior period">${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}%</span>`;
  }
  const badge = (v) => `<span class="cr-badge ${esc(v)}">${esc(v.replace('-', ' '))}</span>`;
  const tagHtml = (v, manual) => v ? `<span class="tag ${manual ? 'manual' : ''}" title="${esc(v)}">${esc(v)}</span>` : `<span class="tag none">untagged</span>`;

  // Hook / hold rate: green ≥ 30%, amber 25–30%, red below. "—" when no video data has been synced.
  function vidCell(pct, grade, source, kind = 'hook') {
    if (pct == null) return '<span class="muted">—</span>';
    const b = (state.data && state.data.video_benchmark) || { hook_good: 30, hook_near: 25, hold_good: 30, hold_near: 25 };
    const good = kind === 'hold' ? b.hold_good : b.hook_good, near = kind === 'hold' ? b.hold_near : b.hook_near;
    const cls = grade === 'good' ? 'good' : grade === 'near' ? 'cr-warn' : 'bad';
    const label = grade === 'good' ? `Good (≥${good}%)` : grade === 'near' ? `Near benchmark (${near}–${good}%)` : `Below benchmark (<${near}%)`;
    const base = kind === 'hold' ? 'ThruPlay ÷ hook views' : (source === '3s' ? '3-second plays ÷ impressions' : '25%-watched views ÷ impressions');
    return `<span class="cell vid ${cls}" title="${label} · ${base}">${fmtP(pct)}</span>`;
  }

  function cplClass(cpl, target) {
    if (cpl == null) return 'none';
    if (cpl <= target) return 'good';
    if (cpl <= target * 1.5) return 'cr-warn';
    return 'bad';
  }

  function renderKpis() {
    const t = state.data.totals, p = t.prior || {};
    const cards = [
      ['Spend', fmtM(t.spend), trend(t.spend, p.spend, false)],
      ['Leads', fmtN(t.leads), trend(t.leads, p.leads, false)],
      ['CPL', fmtM(t.cpl, 2), trend(t.cpl, p.cpl) + ` <span class="muted">target ${fmtM(state.data.client.cpl_target)}</span>`],
      ['Link CTR', fmtP(t.ctr, 2), trend(t.ctr, p.ctr, false)],
      ['Hook rate', vidCell(t.hook_rate, t.hook_grade, t.hook_source), trend(t.hook_rate, p.hook_rate, false) + ' <span class="muted">≥30% good</span>'],
      ['Hold rate', vidCell(t.hold_rate, t.hold_grade, t.hook_source, 'hold'), '<span class="muted">ThruPlay ÷ hook views</span>'],
      ['LPV → Lead', fmtP(t.lead_rate), ''],
      ['Ads with spend', fmtN(t.ads_with_spend), `<span class="muted">${t.active_ads} active</span>`],
      ['Untagged', fmtN(t.untagged), t.untagged ? `<a href="#" id="kpiUntagged">tag them →</a>` : '<span class="muted">all tagged</span>'],
    ];
    $('#cr_kpiRow').innerHTML = cards.map(([l, v, c]) => `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-change neutral">${c}</div></div>`).join('');
    const u = $('#kpiUntagged');
    if (u) u.onclick = (e) => { e.preventDefault(); state.adFilter = { q: '', status: '', verdict: '', untagged: true, angle: null, hook: null, format: null }; syncFilterInputs(); switchTab('ads'); };
    const r = state.data.range;
    $('#cr_rangeLabel').textContent = `${r.since} → ${r.until} · ${r.days} days · prior ${r.prior_since} → ${r.prior_until}`;
    $('#cr_exportBtn').href = withWs(`/api/export.csv?scope=${encodeURIComponent(state.scope)}&days=${state.days}&geo=${encodeURIComponent(state.geo)}`);
  }

  // Generic sortable group table (angles / hooks / formats)
  function groupTable(el, rows, label, key, opts = {}) {
    const target = state.data.client.cpl_target;
    const sortKey = state.sort[key]?.k || 'spend', dir = state.sort[key]?.d || -1;
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
    const cols = [
      [label, 'label', false], ['Verdict', 'verdict', false], ['Ads', 'ads', true], ['Spend', 'spend', true], ['Leads', 'leads', true],
      ['CPL', 'cpl', true], ['CTR', 'ctr', true], ['CPM', 'cpm', true],
      ...(opts.video !== false ? [['Hook %', 'hook_rate', true], ['Hold %', 'hold_rate', true]] : []),
      ['LPV→Lead', 'lead_rate', true], ['Best ad', 'best', false],
    ];
    const th = cols.map(([l, k, num]) => `<th class="${num ? 'num' : ''} ${sortKey === k ? 'sorted' : ''}" data-k="${k}">${l}${sortKey === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('');
    const tr = sorted.map(g => `<tr data-key="${esc(g.key ?? '')}" data-kind="${key}">
      <td class="name"><b>${esc(g.label)}</b><span class="cr-sub">${g.active_ads} active · ${g.winners} winner${g.winners === 1 ? '' : 's'} · ${g.losers} loser${g.losers === 1 ? '' : 's'}</span></td>
      <td>${badge(g.verdict)}</td>
      <td class="num">${g.ads}</td>
      <td class="num">${fmtM(g.spend)}${trend(g.spend, g.prior?.spend, false)}</td>
      <td class="num">${fmtN(g.leads)}</td>
      <td class="num"><span class="cell ${cplClass(g.cpl, target)}">${fmtM(g.cpl, 2)}</span>${trend(g.cpl, g.prior?.cpl)}</td>
      <td class="num">${fmtP(g.ctr, 2)}</td>
      <td class="num">${fmtM(g.cpm, 2)}</td>
      ${opts.video !== false ? `<td class="num">${vidCell(g.hook_rate, g.hook_grade, g.hook_source)}</td><td class="num">${vidCell(g.hold_rate, g.hold_grade, g.hook_source, 'hold')}</td>` : ''}
      <td class="num">${fmtP(g.lead_rate)}</td>
      <td class="name">${g.best_ad ? `<span class="small">${esc(g.best_ad.name)}</span><span class="cr-sub">${fmtM(g.best_ad.cpl, 2)} · ${g.best_ad.leads} leads</span>` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
    el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" class="empty">No ads with spend in this range</td></tr>`}</tbody>`;
    el.querySelector('thead').onclick = (e) => { const t = e.target.closest('th'); if (!t) return; const k = t.dataset.k; state.sort[key] = { k, d: state.sort[key]?.k === k ? -state.sort[key].d : -1 }; renderAll(); };
    el.querySelector('tbody').onclick = (e) => {
      const r = e.target.closest('tr'); if (!r || r.dataset.key === undefined) return;
      state.adFilter = { q: '', status: '', verdict: '', untagged: false, angle: null, hook: null, format: null };
      state.adFilter[key === 'angles' ? 'angle' : key === 'hooks' ? 'hook' : 'format'] = r.dataset.key === '' ? '__none__' : r.dataset.key;
      syncFilterInputs(); switchTab('ads');
    };
  }

  function renderCounties() {
    const d = state.data, target = d.client.cpl_target;
    const rows = [...d.geos].sort((a, b) => b.spend - a.spend);
    const cols = ['County', 'Verdict', 'Ads', 'Spend', 'Leads', 'CPL', 'CTR', 'CPM', 'Hook %', 'LPV→Lead', 'Top angle (by CPL)', 'Best ad'];
    const tr = rows.map(g => `<tr data-geo="${esc(g.key ?? 'none')}">
      <td class="name"><b>${esc(g.label)}</b><span class="cr-sub">${g.active_ads} active · ${g.winners} winner${g.winners === 1 ? '' : 's'} · ${g.losers} loser${g.losers === 1 ? '' : 's'}</span></td>
      <td>${badge(g.key ? g.verdict : 'untagged')}</td>
      <td class="num">${g.ads}</td>
      <td class="num">${fmtM(g.spend)}${trend(g.spend, g.prior?.spend, false)}</td>
      <td class="num">${fmtN(g.leads)}</td>
      <td class="num"><span class="cell ${cplClass(g.cpl, target)}">${fmtM(g.cpl, 2)}</span>${trend(g.cpl, g.prior?.cpl)}</td>
      <td class="num">${fmtP(g.ctr, 2)}</td>
      <td class="num">${fmtM(g.cpm, 2)}</td>
      <td class="num">${vidCell(g.hook_rate, g.hook_grade, g.hook_source)}</td>
      <td class="num">${fmtP(g.lead_rate)}</td>
      <td class="name">${g.top_angle ? `<span class="tag">${esc(g.top_angle.angle)}</span><span class="cr-sub">${fmtM(g.top_angle.cpl, 2)} · ${g.top_angle.leads} leads · ${fmtM(g.top_angle.spend)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="name">${g.best_ad ? `<span class="small">${esc(g.best_ad.name)}</span><span class="cr-sub">${fmtM(g.best_ad.cpl, 2)} · ${g.best_ad.leads} leads</span>` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
    const el = $('#cr_countiesTable');
    el.innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${i >= 2 && i <= 9 ? 'num' : ''}">${c}</th>`).join('')}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" class="empty">No spend in this range</td></tr>`}</tbody>`;
    el.querySelector('tbody').onclick = (e) => { const r = e.target.closest('tr'); if (!r) return; state.geo = r.dataset.geo === 'none' ? 'none' : r.dataset.geo; refresh(); };
  }

  function renderGroups() {
    const d = state.data;
    groupTable($('#cr_anglesTable'), d.angles, 'Angle', 'angles');
    groupTable($('#cr_hooksTable'), d.hooks, 'Hook', 'hooks');
    groupTable($('#cr_formatsTable'), d.formats, 'Format', 'formats');
    groupTable($('#cr_mediaTable'), d.media_types.map(g => ({ ...g, label: g.key || 'unknown' })), 'Media', 'media');
    groupTable($('#cr_langTable'), d.languages.map(g => ({ ...g, label: g.key || 'unset' })), 'Language', 'langs', { video: false });
  }

  function filteredAds() {
    const f = state.adFilter, q = f.q.trim().toLowerCase();
    return state.data.ads.filter(a => {
      if (f.untagged && a.angle) return false;
      if (f.status === 'ACTIVE' && a.effective_status !== 'ACTIVE') return false;
      if (f.status === 'PAUSED' && !/PAUSED/.test(a.effective_status || '')) return false;
      if (f.status === 'other' && (a.effective_status === 'ACTIVE' || /PAUSED/.test(a.effective_status || ''))) return false;
      if (f.verdict && a.verdict !== f.verdict) return false;
      for (const k of ['angle', 'hook', 'format']) {
        if (f[k] === '__none__' && a[k]) return false;
        if (f[k] && f[k] !== '__none__' && a[k] !== f[k]) return false;
      }
      if (q && ![a.name, a.angle, a.hook, a.format, a.campaign_name, a.adset_name].some(v => (v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderAds() {
    const target = state.data.client.cpl_target;
    const rows = filteredAds();
    const sortKey = state.sort.ads?.k || 'spend', dir = state.sort.ads?.d || -1;
    rows.sort((a, b) => { const av = a[sortKey], bv = b[sortKey]; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return (av > bv ? 1 : av < bv ? -1 : 0) * dir; });
    $('#cr_adsCount').textContent = rows.length;
    const cols = [['', null, false], ['Ad', 'name', false], ['Angle', 'angle', false], ['Hook', 'hook', false], ['Format', 'format', false], ['Status', 'effective_status', false],
      ['Spend', 'spend', true], ['Leads', 'leads', true], ['CPL', 'cpl', true], ['CTR', 'ctr', true], ['Hook %', 'hook_rate', true], ['Hold %', 'hold_rate', true], ['Freq', 'frequency', true], ['Verdict', 'verdict', false]];
    const th = cols.map(([l, k, num]) => `<th class="${num ? 'num' : ''} ${sortKey === k ? 'sorted' : ''}" ${k ? `data-k="${k}"` : ''}>${l}${sortKey === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('');
    const accName = (id) => (state.config.accounts.find(a => a.id === id) || {}).name || id;
    const geoShort = (id) => ((state.config.geos || []).find(g => g.id === id) || {}).short || id;
    const tr = rows.map(a => `<tr data-ad="${a.ad_id}">
      <td>${a.thumbnail_url ? `<img class="thumb" src="${esc(a.thumbnail_url)}" loading="lazy" alt="">` : `<div class="thumb ph">${a.media_type === 'video' ? 'VID' : a.media_type === 'image' ? 'IMG' : '?'}</div>`}</td>
      <td class="name"><b>${esc(a.name)}</b> ${driveLink(a.drive_url)}<span class="cr-sub">${esc(accName(a.account_id))}${a.geo ? ' · ' + esc(geoShort(a.geo)) : ''} · ${esc(a.campaign_name || '')}${a.version ? ' · v' + a.version : ''}${a.language ? ' · ' + esc(a.language) : ''}</span>${a.hypothesis ? `<span class="cr-sub" style="font-style:italic">${esc(a.hypothesis)}</span>` : ''}</td>
      <td>${tagHtml(a.angle, a.tag_source === 'manual')}</td>
      <td>${tagHtml(a.hook, a.tag_source === 'manual')}</td>
      <td>${a.format ? `<span class="tag">${esc(a.format)}</span>` : `<span class="tag none">${esc(a.media_type || '?')}</span>`}</td>
      <td><span class="status ${esc(a.effective_status || '')}">${esc((a.effective_status || '—').replace(/_/g, ' '))}</span> ${a.stage ? stagePill(a.stage_effective) : ''}${a.fatigue.length ? `<span class="cr-sub fatigue" title="${esc(a.fatigue.join('\n'))}">Fatigue: ${esc(a.fatigue[0])}</span>` : ''}</td>
      <td class="num">${fmtM(a.spend)}</td>
      <td class="num">${fmtN(a.leads)}</td>
      <td class="num"><span class="cell ${cplClass(a.cpl, target)}">${fmtM(a.cpl, 2)}</span>${trend(a.cpl, a.prior?.cpl)}</td>
      <td class="num">${fmtP(a.ctr, 2)}</td>
      <td class="num">${vidCell(a.hook_rate, a.hook_grade, a.hook_source)}</td>
      <td class="num">${vidCell(a.hold_rate, a.hold_grade, a.hook_source, 'hold')}</td>
      <td class="num">${fmtN(a.frequency, 2)}</td>
      <td>${badge(a.verdict)}</td>
    </tr>`).join('');
    const el = $('#cr_adsTable');
    el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" class="empty">No ads match these filters</td></tr>`}</tbody>`;
    el.querySelector('thead').onclick = (e) => { const t = e.target.closest('th'); if (!t || !t.dataset.k) return; const k = t.dataset.k; state.sort.ads = { k, d: state.sort.ads?.k === k ? -state.sort.ads.d : -1 }; renderAds(); };
    el.querySelector('tbody').onclick = (e) => { const r = e.target.closest('tr'); if (r?.dataset.ad) openDrawer(r.dataset.ad); };
  }

  async function renderMatrix() {
    const rows = $('#cr_matrixRows').value, cols = $('#cr_matrixCols').value;
    const target = state.data.client.cpl_target;
    let m;
    try { m = await api(`/api/matrix?scope=${encodeURIComponent(state.scope)}&days=${state.days}&rows=${rows}&cols=${cols}&geo=${encodeURIComponent(state.geo)}`); } catch (e) { return; }
    const geoName = (id) => (state.config.geos.find(g => g.id === id) || {}).short || id;
    if (rows === 'geo') m.cells.forEach(c => { c.row = geoName(c.row); });
    if (cols === 'geo') m.cells.forEach(c => { c.col = geoName(c.col); });
    const rowKeys = [...new Set(m.cells.map(c => c.row))];
    const colKeys = [...new Set(m.cells.map(c => c.col))];
    const spendBy = (k, f) => m.cells.filter(c => c[f] === k).reduce((s, c) => s + c.spend, 0);
    rowKeys.sort((a, b) => spendBy(b, 'row') - spendBy(a, 'row'));
    colKeys.sort((a, b) => spendBy(b, 'col') - spendBy(a, 'col'));
    const idx = new Map(m.cells.map(c => [c.row + ' ' + c.col, c]));
    const th = `<th>${esc(rows)}</th>` + colKeys.map(k => `<th>${esc(k)}</th>`).join('');
    const tr = rowKeys.map(r => `<tr><td class="rowhead">${esc(r)}</td>` + colKeys.map(c => {
      const cell = idx.get(r + ' ' + c);
      if (!cell || !cell.spend) return '<td><span class="muted">·</span></td>';
      return `<td><span class="cell ${cell.leads ? cplClass(cell.cpl, target) : 'none'}" title="${cell.ads} ads · ${fmtM(cell.spend)} spend">${cell.leads ? fmtM(cell.cpl, 2) : fmtM(cell.spend)}<small>${cell.leads ? cell.leads + ' leads' : 'no leads'}</small></span></td>`;
    }).join('') + '</tr>').join('');
    $('#cr_matrixTable').innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tr || '<tr><td class="empty">No data</td></tr>'}</tbody>`;
  }

  function stagePill(st) { return `<span class="stage-pill ${esc(st)}">${esc(STAGE_LABELS[st] || st)}</span>`; }
  function driveLink(url) { return url ? `<a class="drive" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Drive</a>` : ''; }

  function renderPipeline() {
    const d = state.data, target = d.client.cpl_target;
    const accName = (id) => (state.config.accounts.find(a => a.id === id) || {}).name || id;
    const geoShort = (id) => ((state.config.geos || []).find(g => g.id === id) || {}).short || '';
    const LIMIT = 40;
    let total = 0;
    const cols = d.stages.map(st => {
      const list = d.pipeline[st] || [];
      total += list.length;
      const cards = list.slice(0, LIMIT).map(c => `<div class="card ${c.planned ? 'planned' : ''}" data-ad="${esc(c.ad_id)}">
        <div class="ttl">${esc(c.name)}</div>
        <div class="meta">${esc(accName(c.account_id))}${c.geo ? ' · ' + esc(geoShort(c.geo)) : ''}${c.planned ? ' · <span class="stage-pill idea">planned</span>' : ''}${driveLink(c.drive_url)}</div>
        <div class="tags">${c.angle ? `<span class="tag">${esc(c.angle)}</span>` : '<span class="tag none">no angle</span>'}${c.hook ? `<span class="tag">${esc(c.hook)}</span>` : ''}${c.format ? `<span class="tag">${esc(c.format)}</span>` : ''}</div>
        ${c.hypothesis ? `<div class="hyp" title="${esc(c.hypothesis)}">${esc(c.hypothesis)}</div>` : ''}
        ${c.spend ? `<div class="nums"><span>Spend <b>${fmtM(c.spend)}</b></span><span>Leads <b>${fmtN(c.leads)}</b></span><span>CPL <b class="cell ${cplClass(c.cpl, target)}" style="padding:0 4px">${fmtM(c.cpl, 2)}</b></span></div>` : ''}
        ${c.spend ? `<div>${badge(c.verdict)}${c.fatigue && c.fatigue.length ? ` <span class="fatigue">Fatigue: ${esc(c.fatigue[0])}</span>` : ''}</div>` : ''}
      </div>`).join('');
      return `<div class="col ${st}"><div class="col-head"><span>${esc(STAGE_LABELS[st])}</span><span class="pill">${list.length}</span></div>${cards || '<div class="more">—</div>'}${list.length > LIMIT ? `<div class="more">+${list.length - LIMIT} more (use the Ads tab)</div>` : ''}</div>`;
    });
    $('#cr_pipelineBoard').innerHTML = cols.join('');
    $('#cr_pipelineCount').textContent = total;
    $('#cr_pipelineBoard').onclick = (e) => { const c = e.target.closest('.card'); if (c) openDrawer(c.dataset.ad); };
  }

  function renderAll() { renderKpis(); renderCounties(); renderGroups(); renderAds(); renderPipeline(); if (state.tab === 'matrix') renderMatrix(); }

  function switchTab(tab) {
    state.tab = tab;
    $$('#cr_tabs button').forEach(b => b.classList.toggle('cr-active', b.dataset.tab === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
    if (tab === 'matrix') renderMatrix();
  }

  function syncFilterInputs() {
    $('#cr_adSearch').value = state.adFilter.q; $('#cr_adStatus').value = state.adFilter.status; $('#cr_adVerdict').value = state.adFilter.verdict; $('#cr_adUntagged').checked = state.adFilter.untagged;
    const active = ['angle', 'hook', 'format'].filter(k => state.adFilter[k]).map(k => `${k}: ${state.adFilter[k] === '__none__' ? '(none)' : state.adFilter[k]}`);
    $('#cr_clearFilters').textContent = active.length ? `Clear · ${active.join(' · ')}` : 'Clear';
  }

  // ── Drawer ──
  async function openDrawer(adId) {
    // Open at once with a skeleton; the ad's numbers and chart fill in when the fetch lands.
    $('#cr_drawerTitle').textContent = ''; $('#cr_drawerAccount').textContent = ''; $('#cr_drawerMeta').textContent = '';
    $('#cr_drawerThumb').innerHTML = skLine('100%', 140);
    $('#cr_drawerKpis').innerHTML = Array.from({ length: 9 }, () => `<div><div class="kpi-label">${skLine('60%', 8)}</div><div class="kpi-value">${skLine('70%', 16)}</div></div>`).join('');
    $('#cr_drawerCopy').innerHTML = skLine('90%', 12) + skLine('75%', 12);
    const cv = $('#cr_drawerChart'); const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
    let chartSk = $('#drawerChartSkel'); if (!chartSk) { chartSk = document.createElement('div'); chartSk.id = 'drawerChartSkel'; chartSk.className = 'chart-skel drawer-skel'; cv.parentNode.insertBefore(chartSk, cv.nextSibling); }
    chartSk.innerHTML = Array.from({ length: 14 }, (_, i) => `<span class="sk" style="height:${30 + ((i * 37) % 60)}%"></span>`).join(''); chartSk.hidden = false;
    $('#cr_drawer').classList.remove('hidden');
    let d;
    try { d = await api(`/api/ad/${adId}?days=${state.days}`); } catch (e) { toast(e.message); chartSk.hidden = true; return; }
    chartSk.hidden = true;
    state.drawerAd = d.ad;
    const a = d.ad, t = d.total, target = state.data.client.cpl_target;
    const accName = (state.config.accounts.find(x => x.id === a.account_id) || {}).name || a.account_id;
    const geoShort = ((state.config.geos || []).find(g => g.id === a.geo) || {}).short;
    $('#cr_drawerAccount').textContent = `${accName}${geoShort ? ' · ' + geoShort : ''} · ${a.campaign_name || ''} · ${a.adset_name || ''}`;
    $('#cr_drawerTitle').textContent = a.name;
    $('#cr_drawerMeta').innerHTML = `${a.planned ? '<span class="stage-pill idea">planned — not in Meta yet</span>' : esc((a.effective_status || '').replace(/_/g, ' '))} ${stagePill(a.stage_effective)} · created ${a.created_time ? a.created_time.slice(0, 10) : '?'} · ${esc(a.media_type || '?')}${a.planned ? '' : ' · id ' + esc(a.ad_id)} ${driveLink(a.drive_url)}`;
    $('#cr_drawerThumb').innerHTML = a.thumbnail_url ? `<img src="${esc(a.thumbnail_url)}" alt="">` : 'no preview';
    const k = (l, v) => `<div><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`;
    $('#cr_drawerKpis').innerHTML = k('Spend', fmtM(t.spend)) + k('Leads', fmtN(t.leads)) + k('CPL', `<span class="cell ${cplClass(t.cpl, target)}">${fmtM(t.cpl, 2)}</span>`)
      + k('Link CTR', fmtP(t.ctr, 2)) + k('Hook rate', vidCell(t.hook_rate, t.hook_grade, t.hook_source)) + k('Hold rate', vidCell(t.hold_rate, t.hold_grade, t.hook_source, 'hold'))
      + k('LPV→Lead', fmtP(t.lead_rate)) + k('Frequency', fmtN(t.frequency, 2)) + k('Lifetime CPL', fmtM(d.lifetime.cpl, 2));
    drawChart(d.daily);
    const f = $('#cr_tagForm');
    for (const n of ['angle', 'hook', 'format', 'language', 'notes', 'hypothesis', 'drive_url']) f.elements[n].value = a[n] || '';
    f.elements.stage.value = a.stage || '';
    $('#cr_linkPlanned').classList.toggle('hidden', !a.planned);
    $('#cr_deletePlanned').classList.toggle('hidden', !a.planned);
    $('#cr_tagReset').classList.toggle('hidden', !!a.planned);
    f.elements.version.value = a.version ?? '';
    f.elements.media_type.value = a.media_type || 'unknown';
    $('#cr_tagSource').textContent = a.tag_source === 'manual' ? 'manually tagged' : `auto-parsed from name (${a.tag_confidence || '?'} confidence)`;
    $('#cr_tagStatus').textContent = '';
    $('#cr_drawerCopy').innerHTML = (a.title ? `<b>${esc(a.title)}</b>` : '') + (a.body ? esc(a.body) : '<span class="muted">Primary text not synced yet — add a Meta token and run a sync to pull creative copy.</span>');
    $('#cr_drawer').classList.remove('hidden');
  }
  function closeDrawer() { $('#cr_drawer').classList.add('hidden'); state.drawerAd = null; }

  function drawChart(daily) {
    const c = $('#cr_drawerChart'); const ctx = c.getContext('2d');
    const W = c.width = c.clientWidth * devicePixelRatio, H = c.height = 120 * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    if (!daily.length) { ctx.fillStyle = (getComputedStyle(c).getPropertyValue('--text-muted') || '#6a6a7a').trim(); ctx.font = `${12 * devicePixelRatio}px sans-serif`; ctx.fillText('No daily data in range', 12 * devicePixelRatio, H / 2); return; }
    const cs = getComputedStyle(c);
    const tone = (v, fb) => (cs.getPropertyValue(v) || '').trim() || fb;
    const spendColor = tone('--border', '#2a2a36'), leadColor = tone('--accent', '#3b82f6'), cplColor = tone('--text-primary', '#f0f0f5');
    const pad = 8 * devicePixelRatio, n = daily.length, bw = (W - pad * 2) / n;
    const maxSpend = Math.max(...daily.map(d => d.spend), 1), maxLeads = Math.max(...daily.map(d => d.leads), 1);
    const cpls = daily.map(d => d.cpl).filter(v => v != null), maxCpl = Math.max(...cpls, 1);
    daily.forEach((d, i) => {
      const h = (d.spend / maxSpend) * (H - pad * 2);
      ctx.fillStyle = spendColor; ctx.fillRect(pad + i * bw + 1, H - pad - h, Math.max(bw - 2, 1), h);
      const lh = (d.leads / maxLeads) * (H - pad * 2);
      ctx.fillStyle = leadColor; ctx.fillRect(pad + i * bw + bw * 0.3, H - pad - lh, Math.max(bw * 0.4, 1), lh);
    });
    ctx.strokeStyle = cplColor; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.beginPath(); let started = false;
    daily.forEach((d, i) => { if (d.cpl == null) { started = false; return; } const x = pad + i * bw + bw / 2, y = H - pad - (d.cpl / maxCpl) * (H - pad * 2); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
    ctx.stroke();
  }

  async function saveTags(e) {
    e.preventDefault();
    if (!state.drawerAd) return;
    const f = $('#cr_tagForm');
    const body = {};
    for (const n of ['angle', 'hook', 'format', 'language', 'notes', 'media_type', 'hypothesis', 'drive_url', 'stage']) body[n] = f.elements[n].value;
    body.version = f.elements.version.value === '' ? null : parseInt(f.elements.version.value, 10);
    if (body.language) body.language = body.language.toUpperCase();
    try {
      await api(`/api/ad/${state.drawerAd.ad_id}/tags`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('#cr_tagStatus').textContent = 'Saved'; toast('Tags saved'); await refresh();
    } catch (err) { $('#cr_tagStatus').textContent = err.message; }
  }

  async function resetTags() {
    if (!state.drawerAd) return;
    try { await api(`/api/ad/${state.drawerAd.ad_id}/tags/reset`, { method: 'POST' }); toast('Re-parsed from ad name'); await refresh(); openDrawer(state.drawerAd.ad_id); }
    catch (err) { toast(err.message); }
  }

  async function runSync() {
    const sb = $('#cr_syncBtn'); if (sb) sb.innerHTML = SPINNER_HTML + 'Syncing';
    try { await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('Sync started — refreshing in a bit'); }
    catch (err) { toast(err.message, 5000); return; }
    const poll = setInterval(async () => {
      try { const s = await api('/api/sync'); if (!s.running) { clearInterval(poll); toast(`Sync ${s.last?.status || 'done'}: ${s.last?.rows ?? 0} rows`); await loadConfig(); await refresh(); if (sb) sb.innerHTML = ICONS.refresh + 'Sync'; } } catch { clearInterval(poll); if (sb) sb.innerHTML = ICONS.refresh + 'Sync'; }
    }, 4000);
  }

  // ── Pipeline: planned creatives ──
  function openPlanned() { $('#cr_plannedForm').reset(); $('#cr_plannedStatus').textContent = ''; $('#cr_plannedModal').classList.remove('hidden'); $('#cr_plannedForm').elements.name.focus(); }
  function closePlanned() { $('#cr_plannedModal').classList.add('hidden'); }
  async function savePlanned(e) {
    e.preventDefault();
    const f = $('#cr_plannedForm'); const body = {};
    for (const el of f.elements) if (el.name) body[el.name] = el.value;
    if (body.version === '') delete body.version; else body.version = parseInt(body.version, 10);
    if (body.language) body.language = body.language.toUpperCase();
    try {
      await api('/api/ads/planned', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closePlanned(); toast('Added to pipeline'); await refresh(); switchTab('pipeline');
    } catch (err) { $('#cr_plannedStatus').textContent = err.message; }
  }
  async function linkPlanned() {
    const a = state.drawerAd; if (!a || !a.planned) return;
    const candidates = [...state.data.ads, ...state.data.idle_ads].filter(x => x.account_id === a.account_id && !x.planned);
    const answer = window.prompt(`Paste the Meta ad ID or the exact ad name to link "${a.name}" to. Recent ads in this account:\n\n` +
      candidates.sort((x, y) => String(y.created_time || '').localeCompare(String(x.created_time || ''))).slice(0, 12).map(x => `${x.name}  (${x.ad_id})`).join('\n'));
    if (!answer) return;
    const q = answer.trim();
    const target = candidates.find(x => x.ad_id === q) || candidates.find(x => x.name === q) || candidates.find(x => x.name.toLowerCase() === q.toLowerCase());
    if (!target) { toast('No ad in this account matches that id or name', 4000); return; }
    try { await api(`/api/ads/planned/${a.ad_id}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ad_id: target.ad_id }) }); toast('Linked — tags, Drive link and hypothesis carried over'); closeDrawer(); await refresh(); }
    catch (err) { toast(err.message, 4000); }
  }
  async function deletePlanned() {
    const a = state.drawerAd; if (!a || !a.planned) return;
    if (!window.confirm(`Delete planned creative "${a.name}"?`)) return;
    try { await api(`/api/ads/planned/${a.ad_id}`, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); await refresh(); } catch (err) { toast(err.message); }
  }

  // ── Wiring ──
  $('#cr_rangeSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.days = parseInt(b.dataset.days, 10); refresh(); };
  $('#cr_tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };
  $('#cr_adSearch').oninput = (e) => { state.adFilter.q = e.target.value; renderAds(); };
  $('#cr_adStatus').onchange = (e) => { state.adFilter.status = e.target.value; renderAds(); };
  $('#cr_adVerdict').onchange = (e) => { state.adFilter.verdict = e.target.value; renderAds(); };
  $('#cr_adUntagged').onchange = (e) => { state.adFilter.untagged = e.target.checked; renderAds(); };
  $('#cr_clearFilters').onclick = () => { state.adFilter = { q: '', status: '', verdict: '', untagged: false, angle: null, hook: null, format: null }; syncFilterInputs(); renderAds(); };
  $('#cr_matrixRows').onchange = renderMatrix; $('#cr_matrixCols').onchange = renderMatrix;
  $('#cr_drawerClose').onclick = closeDrawer; $('#cr_drawerBackdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#cr_tagForm').addEventListener('submit', saveTags);
  $('#cr_tagReset').onclick = resetTags;
  $('#cr_addPlannedBtn').onclick = openPlanned; $('#cr_plannedClose').onclick = closePlanned; $('#cr_plannedBackdrop').onclick = closePlanned;
  $('#cr_plannedForm').addEventListener('submit', savePlanned);
  $('#cr_linkPlanned').onclick = linkPlanned; $('#cr_deletePlanned').onclick = deletePlanned;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlanned(); });
  $('#cr_syncBtn').onclick = runSync;

  const ex = $('#cr_exportBtn'); if (ex) ex.innerHTML = ICONS.download + 'Export';
  const sy = $('#cr_syncBtn'); if (sy) sy.innerHTML = ICONS.refresh + 'Sync';
  // ── Public API used by the CRM page ──
  // Creative.setWorkspace(id) -> resolves to true when the workspace has creative tracking, false otherwise.
  let loadedFor = null;
  window.Creative = {
    async setWorkspace(id) {
      state.workspace = id;
      if (loadedFor === id && state.enabled) return true;
      try { await loadConfig(); } catch (err) { state.enabled = false; return false; }
      loadedFor = id;
      if (!state.enabled) return false;
      state.scope = 'all'; state.geo = '';
      await refresh();
      return true;
    },
    isEnabled() { return state.enabled; },
    refresh,
  };
})();
