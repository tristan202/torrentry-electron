/* global I18N, api */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tr = (k, v) => I18N.t(k, v);
const plain = (k, v) => I18N.plain(I18N.t(k, v)); // uden "..." og ":" i enden

const POLL_MS = 3000;
// Kort navn og farve pr. klienttype (bruges som "avatar" i serverlisten)
const TYPE_STYLE = { rtorrent: ['rT', '#5b8def'], qbittorrent: ['qB', '#2bb3a3'], transmission: ['Tr', '#e5534b'], deluge: ['De', '#9b6cf0'] };
const STATUS = {
  downloading: 'StDownloading', seeding: 'StSeeding', checking: 'StChecking', finished: 'StFinished', stopped: 'StStopped',
  paused: 'StPaused', queued: 'StQueued', moving: 'StMoving', allocating: 'StAllocating', error: 'StError', metadata: 'StMetadata',
};
const FILTERS = [
  ['all', 'FltAll', () => true],
  ['downloading', 'FltDownloading', (t) => t.status === 'downloading'],
  ['seeding', 'FltSeeding', (t) => t.status === 'seeding'],
  ['completed', 'FltCompleted', (t) => t.complete],
  ['stopped', 'FltStopped', (t) => t.stopped],
  ['active', 'FltActive', (t) => t.down > 0 || t.up > 0],
  ['inactive', 'FltInactive', (t) => !t.down && !t.up],
  ['error', 'FltError', (t) => !!t.message],
];

// ---------- Formatering ----------
const nf = (v, d) => v.toLocaleString(I18N.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${nf(v, i >= 2 ? 2 : 1)} ${u[i]}`;
}
const fmtSpeed = (b) => (b > 0 ? fmtSize(b) + '/s' : '');
function fmtEta(s) {
  if (s < 0) return '∞';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}${tr('UnitDay')} ${h}${tr('UnitHour')}`;
  if (h > 0) return `${h}${tr('UnitHour')} ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
// Forbundne + sværmens total i parentes, fx "3 (120)" – et hint om en død torrent
const fmtCount = (n, total) => (total > 0 ? `${n} (${total})` : `${n}`);
const pct = (p) => `${nf(p, 1)} %`;
const stLabel = (t) => plain(STATUS[t.status] || 'StStopped');
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

// ---------- Kolonner ----------
const barClass = (t) => (t.message ? 'bad' : t.complete ? 'ok' : t.stopped ? 'idle' : '');
const progCell = (p, cls) => `<div class="prog"><div class="m-bar"><i class="${cls}" style="width:${Math.min(100, Math.max(0, p)).toFixed(1)}%"></i></div><span>${pct(p)}</span></div>`;
const COLS = [
  { k: 'name', l: 'ColName', w: 200, v: (t) => t.name, cell: (t) => `<div class="tname">${t.message ? `<span class="err" title="${esc(t.message)}">!</span>` : ''}<span class="t" title="${esc(t.name)}">${esc(t.name)}</span></div>` },
  { k: 'size', l: 'ColSize', w: 85, num: true, v: (t) => t.size, cell: (t) => fmtSize(t.size) },
  { k: 'progress', l: 'ColProgress', w: 130, v: (t) => t.progress, cell: (t) => progCell(t.progress, barClass(t)) },
  { k: 'status', l: 'ColStatus', w: 125, v: (t) => stLabel(t), cell: (t) => `<span class="st st-${t.status}"><i></i>${esc(stLabel(t))}</span>` },
  // Sorteres efter det forbundne antal, ikke totalen
  { k: 'seeds', l: 'ColSeeds', w: 80, num: true, v: (t) => t.seeds, cell: (t) => fmtCount(t.seeds, t.seedsTotal) },
  { k: 'peers', l: 'ColPeers', w: 80, num: true, v: (t) => t.peers, cell: (t) => fmtCount(t.peers, t.peersTotal) },
  { k: 'down', l: 'ColDownSpeed', w: 110, num: true, v: (t) => t.down, cell: (t) => fmtSpeed(t.down) },
  { k: 'up', l: 'ColUpSpeed', w: 110, num: true, v: (t) => t.up, cell: (t) => fmtSpeed(t.up) },
  { k: 'eta', l: 'ColEta', w: 80, num: true, v: (t) => (t.complete ? -1 : t.eta < 0 ? 1e15 : t.eta), cell: (t) => (t.complete ? '' : fmtEta(t.eta)) },
  { k: 'seedtime', l: 'ColSeedTime', w: 90, num: true, v: (t) => t.seedSecs, cell: (t) => (t.seedSecs > 0 ? fmtEta(t.seedSecs) : '') },
  { k: 'ratio', l: 'ColRatio', w: 65, num: true, v: (t) => t.ratio, cell: (t) => nf(t.ratio, 2) },
  { k: 'label', l: 'ColLabel', w: 100, v: (t) => t.label, cell: (t) => esc(t.label) },
];

// ---------- Tilstand ----------
// Visningsvalg huskes i browserlageret (kolonner, sortering, filter, ...)
function loadUi() { try { return JSON.parse(localStorage.getItem('torrentry.ui')) || {}; } catch { return {}; } }
const ui = { filter: 'all', sort: null, desc: false, hidden: ['seedtime'], widths: {}, tab: 'general', detH: 260, sidebar: true, ...loadUi() };
function saveUi() { try { localStorage.setItem('torrentry.ui', JSON.stringify(ui)); } catch {} }

const state = {
  info: null,
  servers: [],
  current: null,      // id på den aktive server
  gen: 0,             // tælles op ved serverskift, så gamle svar ignoreres
  torrents: [],
  conn: 'idle',       // idle | connecting | ok | error
  error: '',
  sel: new Set(),
  anchor: null,       // udgangspunkt for Shift-markering
  cursor: null,       // række med tastaturfokus
  shown: [],          // [{ h, html }] – de viste rækker, så kun ændringer tegnes om
  search: '',
  busy: false, again: false, timer: null, spin: false,
  det: { kind: null, hash: null, data: null, error: null },
  detHtml: '',
  editing: null,
};

const visibleCols = () => COLS.filter((c) => c.k === 'name' || !ui.hidden.includes(c.k));
const currentServer = () => state.servers.find((s) => s.id === state.current) || null;
const unwrap = (r) => { if (r.error) throw new Error(r.error); return r.value; };

function shownTorrents() {
  const f = (FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0])[2];
  const q = state.search.trim().toLowerCase();
  let list = state.torrents.filter((t) => f(t) && (!q || t.name.toLowerCase().includes(q)));
  const c = ui.sort && COLS.find((x) => x.k === ui.sort);
  if (c) {
    const dir = ui.desc ? -1 : 1;
    const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(b, I18N.locale, { numeric: true, sensitivity: 'base' }) : a - b);
    list = list.map((t, i) => [t, i]).sort(([a, ia], [b, ib]) => cmp(c.v(a), c.v(b)) * dir || ia - ib).map((x) => x[0]);
  }
  return list;
}
function selectedHashes() {
  // i den viste rækkefølge
  const out = state.shown.filter((r) => state.sel.has(r.h)).map((r) => r.h);
  for (const h of state.sel) if (!out.includes(h)) out.push(h);
  return out;
}
const firstSel = () => selectedHashes()[0] || null;

// ---------- Tegning ----------
function renderAll() {
  renderServers();
  renderFilters();
  renderList();
  renderDetails();
  renderToolbar();
  renderStatus();
  renderBanner();
}

function avatar(type) {
  const [txt, color] = TYPE_STYLE[type] || ['?', '#6b7894'];
  return `<span class="avatar" style="background:${color}">${txt}</span>`;
}

function renderServers() {
  const dot = { ok: 'ok', error: 'bad', connecting: 'wait' }[state.conn] || '';
  $('#server-list').innerHTML = state.servers.map((s) => `
    <div class="host-item ${s.id === state.current ? 'selected' : ''}" data-id="${s.id}" tabindex="0">
      ${avatar(s.type)}
      <div class="meta"><div class="name">${esc(s.name)}</div><div class="sub">${esc(hostOf(s.url))}</div></div>
      ${s.id === state.current && dot ? `<span class="live-dot ${dot}"></span>` : ''}
      <button class="edit" data-edit="${s.id}" title="${esc(plain('BtnEdit'))}" aria-label="${esc(plain('BtnEdit'))}">✎</button>
    </div>`).join('') || `<div class="quick">${esc(plain('NoServersTitle'))}</div>`;
}

function renderFilters() {
  $('#filter-list').innerHTML = FILTERS.map(([k, l, f]) => `
    <div class="filter-item ${ui.filter === k ? 'selected' : ''}" data-filter="${k}">
      <span class="fdot fd-${k}"></span><span class="n">${esc(plain(l))}</span><span class="count">${state.torrents.filter(f).length}</span>
    </div>`).join('');
}

// Kolonnebredder: navnekolonnen fylder resten af pladsen
function sizeCols() {
  const cols = visibleCols();
  const w = (c) => ui.widths[c.k] || c.w;
  const other = cols.filter((c) => c.k !== 'name').reduce((s, c) => s + w(c), 0);
  const nameW = Math.max(w(COLS[0]), $('#list-wrap').clientWidth - other);
  $('#tlist colgroup').innerHTML = cols.map((c) => `<col style="width:${c.k === 'name' ? nameW : w(c)}px">`).join('');
  $('#tlist').style.width = nameW + other + 'px';
}
function renderHead() {
  $('#tlist thead').innerHTML = '<tr>' + visibleCols().map((c) => {
    const sorted = ui.sort === c.k;
    return `<th data-k="${c.k}" class="${c.num ? 'num' : ''} ${sorted ? 'sorted' : ''}" ${sorted ? `data-dir="${ui.desc ? '▼' : '▲'}"` : ''}>${esc(plain(c.l))}<span class="rz"></span></th>`;
  }).join('') + '</tr>';
  sizeCols();
  state.shown = []; // kolonnerne er ændret – alle rækker tegnes forfra
}

function rowHtml(t, cols) {
  return `<tr data-h="${t.hash}"${state.sel.has(t.hash) ? ' class="sel"' : ''}>` +
    cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.cell(t)}</td>`).join('') + '</tr>';
}

function renderList() {
  const wrap = $('#list-wrap'), tbody = $('#tlist tbody'), msg = $('#list-msg');
  if (!state.servers.length) {
    wrap.classList.add('no-table');
    tbody.innerHTML = '';
    state.shown = [];
    msg.innerHTML = `<div class="empty"><img src="icon.png" alt="" /><h2>${esc(plain('NoServersTitle'))}</h2><p>${esc(plain('NoServersText'))}</p><button class="btn btn-primary" data-cmd="newServer">${esc(plain('AddServer'))}</button></div>`;
    msg.hidden = false;
    return;
  }
  wrap.classList.remove('no-table');
  const cols = visibleCols();
  const rows = shownTorrents().map((t) => ({ h: t.hash, html: rowHtml(t, cols) }));
  const same = rows.length === state.shown.length && tbody.rows.length === rows.length && rows.every((r, i) => r.h === state.shown[i].h);
  if (same) rows.forEach((r, i) => { if (r.html !== state.shown[i].html) tbody.rows[i].outerHTML = r.html; });
  else tbody.innerHTML = rows.map((r) => r.html).join('');
  state.shown = rows;

  let m = '';
  if (!rows.length) {
    const s = currentServer();
    if (state.torrents.length) m = plain('ListNoMatch');
    else if (state.conn === 'ok') m = plain('ListEmpty');
    else if (state.conn === 'connecting' && s) m = tr('StatusConnecting', { x: s.name });
  }
  msg.textContent = m;
  msg.hidden = !m;
}

function renderToolbar() {
  const any = state.sel.size > 0, srv = !!state.current;
  for (const b of $$('#toolbar [data-cmd]')) {
    const c = b.dataset.cmd;
    if (['start', 'stop', 'recheck', 'removeMenu'].includes(c)) b.disabled = !any;
    if (['addFile', 'addMagnet', 'refresh'].includes(c)) b.disabled = !srv;
  }
  $('#toolbar [data-cmd="refresh"]').classList.toggle('spin', state.spin);
}

function renderStatus() {
  const s = currentServer();
  let txt;
  if (!s) txt = tr('StatusNoServer', { x: plain('AddServer') });
  else if (state.conn === 'error') txt = `${plain('LblError')}: ${state.error}`;
  else if (state.conn === 'ok') txt = tr('StatusConnected', { x: s.name });
  else txt = tr('StatusConnecting', { x: s.name });
  const dot = { ok: 'ok', error: 'bad', connecting: 'wait' }[state.conn];
  $('#sb-status').innerHTML = (s && dot ? `<span class="live-dot ${dot}"></span>` : '') + `<span>${esc(txt)}</span>`;
  $('#sb-sel').textContent = state.sel.size ? tr('SelCount', { n: state.sel.size }) : '';
  const dl = state.torrents.reduce((a, t) => a + t.down, 0), ul = state.torrents.reduce((a, t) => a + t.up, 0);
  $('#sb-down').innerHTML = s ? `↓ <b>${esc(fmtSize(dl))}/s</b>` : '';
  $('#sb-up').innerHTML = s ? `↑ <b>${esc(fmtSize(ul))}/s</b>` : '';
  $('#sb-count').textContent = s ? tr('StatusTorrents', { x: state.torrents.length }) : '';
}

function renderBanner() {
  const b = $('#banner');
  b.hidden = state.conn !== 'error';
  if (!b.hidden) {
    b.innerHTML = `<span class="msg" title="${esc(state.error)}">${esc(tr('MsgListFailed'))} ${esc(state.error)}</span><button class="btn" data-cmd="test">${esc(plain('BtnTest'))}</button>`;
  }
}

function genRow(k, v, cls = '') {
  return `<div class="gen-row ${cls}"><span class="k">${esc(plain(k))}</span><span class="v ${cls.includes('mono') ? 'mono' : ''}" title="${esc(v)}">${esc(v)}</span></div>`;
}
function dtable(heads, rows) {
  // heads: [[nøgle, bredde, num]]
  return `<table class="dtable"><colgroup>${heads.map(([, w]) => `<col${w ? ` style="width:${w}px"` : ''}>`).join('')}</colgroup>
    <thead><tr>${heads.map(([k, , n]) => `<th class="${n ? 'num' : ''}">${esc(plain(k))}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}
function detailsHtml(t) {
  if (ui.tab === 'general') {
    return '<div class="gen">' + [
      genRow('ColName', t.name, 'wide'),
      genRow('GenSavedIn', t.dir, 'wide'),
      genRow('Hash', t.hash, 'wide mono'),
      genRow('ColSize', fmtSize(t.size)),
      genRow('GenDownloaded', fmtSize(t.done)),
      genRow('ColProgress', pct(t.progress)),
      genRow('ColStatus', stLabel(t)),
      genRow('ColSeeds', fmtCount(t.seeds, t.seedsTotal)),
      genRow('ColPeers', fmtCount(t.peers, t.peersTotal)),
      genRow('ColRatio', nf(t.ratio, 2)),
      genRow('GenUpTotal', fmtSize(t.upTotal)),
      genRow('GenDownTotal', fmtSize(t.downTotal)),
      genRow('ColLabel', t.label),
      genRow('GenSeededFor', t.seedSecs > 0 ? fmtEta(t.seedSecs) : ''),
      t.message ? genRow('GenMessage', t.message, 'wide bad') : '',
    ].join('') + '</div>';
  }
  const d = state.det;
  if (d.kind !== ui.tab || d.hash !== t.hash) return '<div class="det-msg">…</div>';
  if (d.error) return `<div class="det-msg bad">${esc(d.error)}</div>`;
  if (!d.data || !d.data.length) return `<div class="det-msg">${esc(plain('DetEmpty'))}</div>`;
  if (ui.tab === 'trackers') {
    return dtable([['URL'], ['ColStatus', 120], ['ColSeeds', 80, 1], ['ColPeers', 80, 1], ['ColDownloads', 100, 1]], d.data.map((x) =>
      `<tr><td title="${esc(x.url)}">${esc(x.url)}</td><td>${esc(plain(x.enabled ? 'TrkEnabled' : 'TrkDisabled'))}</td><td class="num">${x.seeds}</td><td class="num">${x.peers}</td><td class="num">${x.downloads}</td></tr>`));
  }
  if (ui.tab === 'peers') {
    return dtable([['IP', 260], ['ColPort', 70, 1], ['ColClient'], ['ColProgress', 90, 1], ['ColDown', 110, 1], ['ColUp', 110, 1]], d.data.map((x) =>
      `<tr><td class="mono">${esc(x.ip)}</td><td class="num">${x.port}</td><td>${esc(x.client)}</td><td class="num">${nf(x.progress, 0)} %</td><td class="num">${esc(fmtSpeed(x.down))}</td><td class="num">${esc(fmtSpeed(x.up))}</td></tr>`));
  }
  const prio = ['PrioSkip', 'PrioNormal', 'PrioHigh'];
  return dtable([['ColPath'], ['ColSize', 100, 1], ['ColProgress', 180], ['ColPriority', 110]], d.data.map((x) =>
    `<tr><td title="${esc(x.path)}">${esc(x.path)}</td><td class="num">${esc(fmtSize(x.size))}</td><td>${progCell(x.progress, x.progress >= 100 ? 'ok' : x.priority === 0 ? 'idle' : '')}</td><td class="prio-${x.priority}">${esc(plain(prio[x.priority]))}</td></tr>`));
}
function renderDetails() {
  for (const b of $$('#det-tabs button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  const h = firstSel();
  const t = h && state.torrents.find((x) => x.hash === h);
  $('#det-title').textContent = t ? t.name : '';
  const html = t ? detailsHtml(t) : `<div class="det-msg">${esc(plain('DetNone'))}</div>`;
  if (html !== state.detHtml) { $('#det-body').innerHTML = html; state.detHtml = html; }
}

function renderFoot() {
  $('#foot').innerHTML = `Torrentry ${esc(state.info.version)}` +
    (state.info.canEncrypt ? '' : `<br><span class="warn">${esc(plain('NoKeyring'))}</span>`);
}

// ---------- Hentning ----------
async function poll() {
  clearTimeout(state.timer);
  const id = state.current;
  if (!id) return;
  if (state.busy) { state.again = true; return; }
  state.busy = true;
  const gen = state.gen;
  const h = firstSel();
  const det = ui.tab !== 'general' && h ? { kind: ui.tab, hash: h } : null;
  const r = await api.poll(id, det);
  state.busy = false;
  if (gen === state.gen) {
    state.spin = false;
    if (r.error) {
      state.conn = 'error';
      state.error = r.error;
    } else {
      state.conn = 'ok';
      state.error = '';
      state.torrents = r.value.torrents;
      const have = new Set(state.torrents.map((t) => t.hash));
      for (const x of [...state.sel]) if (!have.has(x)) state.sel.delete(x);
      if (det) state.det = { kind: det.kind, hash: det.hash, data: r.value.details, error: r.value.detailsError };
    }
    renderAll();
  }
  if (state.again || gen !== state.gen) { state.again = false; poll(); return; }
  state.timer = setTimeout(poll, POLL_MS);
}

function selectServer(id) {
  state.current = id;
  state.gen++;
  state.torrents = [];
  state.sel.clear();
  state.anchor = state.cursor = null;
  state.det = { kind: null, hash: null, data: null, error: null };
  state.conn = id ? 'connecting' : 'idle';
  state.error = '';
  api.setSelected(id);
  renderAll();
  poll();
}

async function loadServers() {
  state.servers = unwrap(await api.listServers()) || [];
}

// ---------- Markering ----------
function onSelChange() {
  const before = state.det.hash;
  renderList();
  renderToolbar();
  renderStatus();
  renderDetails();
  const h = firstSel();
  if (h && ui.tab !== 'general' && h !== before) poll();
}
function selectRange(a, b, add) {
  const hs = state.shown.map((r) => r.h);
  let i = hs.indexOf(a), j = hs.indexOf(b);
  if (i < 0) i = j;
  if (!add) state.sel.clear();
  for (let k = Math.min(i, j); k <= Math.max(i, j); k++) state.sel.add(hs[k]);
}

// ---------- Kommandoer ----------
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

function needServer() {
  if (state.current) return true;
  toast(plain('MsgSelectServer'));
  return false;
}

function reportAdd(r) {
  if (r.error) { toast(r.error, 'error'); return; }
  const { added, errors } = r.value;
  if (added) toast(tr('MsgAdded', { n: added }), 'ok');
  if (errors.length) openModal({ title: plain('LblError'), body: `<p>${esc(errors.join('\n'))}</p>`, buttons: [{ label: plain('BtnClose'), v: 'ok', cls: 'btn-primary' }] });
  poll();
}

async function doAction(act, all = false) {
  const hashes = all ? state.torrents.map((t) => t.hash) : selectedHashes();
  if (!hashes.length) return;
  const r = await api.action(state.current, act, hashes);
  if (r.error) toast(`${plain('LblError')}: ${r.error}`, 'error');
  poll();
}

async function removeSelected(withData) {
  const hashes = selectedHashes();
  if (!hashes.length) return;
  if (withData) {
    const names = hashes.slice(0, 4).map((h) => (state.torrents.find((t) => t.hash === h) || {}).name || h);
    const more = hashes.length > 4 ? `<li>${esc(tr('DelMore', { x: hashes.length - 4 }))}</li>` : '';
    const ok = await openModal({
      title: plain('MenuDelData'),
      body: `<p>${esc(tr('DelConfirm', { x: hashes.length }))}</p><ul>${names.map((n) => `<li title="${esc(n)}">${esc(n)}</li>`).join('')}${more}</ul><p class="warn">${esc(tr('DelPermanent'))}</p>`,
      buttons: [{ label: plain('BtnCancel'), v: null }, { label: plain('BtnDelete'), v: 'del', cls: 'btn-danger' }],
    });
    if (ok !== 'del') return;
  }
  const r = await api.remove(state.current, hashes, withData);
  if (r.error) {
    if (withData) openModal({ title: plain('MenuDelData'), body: `<p>${esc(r.error)}</p>`, buttons: [{ label: plain('BtnClose'), v: 'ok', cls: 'btn-primary' }] });
    else toast(r.error, 'error');
  } else if (r.value && r.value.warn) {
    openModal({ title: plain('MenuDelData'), body: `<p class="warn">${esc(r.value.warn)}</p>`, buttons: [{ label: plain('BtnClose'), v: 'ok', cls: 'btn-primary' }] });
  }
  poll();
}

async function magnetDialog(prefill = '') {
  if (!needServer()) return;
  const v = await openModal({
    title: plain('MagTitle'),
    wide: true,
    body: `<div class="field">
      <label>${esc(plain('MagLinks'))}<textarea id="mag-text" spellcheck="false" placeholder="magnet:?xt=urn:btih:…">${esc(prefill)}</textarea></label>
      <label>${esc(plain('MagDir'))}<input id="mag-dir" spellcheck="false" /></label>
      <label class="check"><input type="checkbox" id="mag-start" checked /> ${esc(plain('MagStart'))}</label>
    </div>`,
    buttons: [{ label: plain('BtnCancel'), v: null }, { label: plain('BtnAdd'), v: 'add', cls: 'btn-primary' }],
    focus: '#mag-text',
  });
  if (v !== 'add') return;
  const text = $('#mag-text').value;
  const opts = { dir: $('#mag-dir').value.trim(), start: $('#mag-start').checked };
  reportAdd(await api.addUrls(state.current, text, opts));
}

async function testDialog(s) {
  const p = openModal({
    title: `${s.name || plain('SrvNew')} – ${plain('BtnTest')}`,
    wide: true,
    body: `<pre id="test-out">${esc(plain('Testing'))}</pre>`,
    buttons: [{ label: plain('BtnClose'), v: 'ok', cls: 'btn-primary' }],
  });
  const token = modalToken;
  const r = await api.testServer(s);
  if (token === modalToken && $('#test-out')) $('#test-out').textContent = r.error || r.value;
  return p;
}

function aboutDialog() {
  openModal({
    body: `<div class="about"><img src="icon.png" alt="" /><div><h3>Torrentry</h3><p>${esc(state.info.version)}</p></div></div>
      <p>${esc(tr('AboutText', { x: 'Torrentry' }))}\n${esc(tr('AboutWritten'))}</p>`,
    buttons: [{ label: plain('BtnClose'), v: 'ok', cls: 'btn-primary' }],
  });
}

function cmd(name, el) {
  switch (name) {
    case 'sidebar': ui.sidebar = !ui.sidebar; saveUi(); applyLayout(); break;
    case 'addFile': if (needServer()) api.addFiles(state.current, null, {}).then(reportAdd); break;
    case 'addMagnet': magnetDialog(); break;
    case 'start': case 'stop': case 'recheck': doAction(name); break;
    case 'startAll': doAction('start', true); break;
    case 'stopAll': doAction('stop', true); break;
    case 'removeMenu': {
      const r = el.getBoundingClientRect();
      showCtx([
        { label: plain('MenuDelTorrent'), run: () => removeSelected(false) },
        { label: plain('MenuDelData'), danger: true, run: () => removeSelected(true) },
      ], r.left, r.bottom + 4);
      break;
    }
    case 'refresh': if (state.current) { state.spin = true; renderToolbar(); poll(); } break;
    case 'test': { const s = currentServer(); if (s) testDialog(s); break; }
    case 'newServer': openEditor(null); break;
    case 'about': aboutDialog(); break;
  }
}

// ---------- Kontekstmenu ----------
function showCtx(items, x, y) {
  const el = $('#ctx');
  const checks = items.some((it) => it !== '-' && 'check' in it);
  el.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' :
    `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${checks ? `<span class="ck">${it.check ? '✓' : ''}</span>` : ''}${esc(it.label)}</button>`)).join('');
  el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
  el.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    hideCtx();
    items[b.dataset.i].run();
  };
}
const hideCtx = () => { $('#ctx').hidden = true; };

function rowCtx(x, y) {
  const any = state.sel.size > 0, all = state.torrents.length > 0;
  showCtx([
    { label: plain('MenuStart'), disabled: !any, run: () => doAction('start') },
    { label: plain('MenuStop'), disabled: !any, run: () => doAction('stop') },
    { label: plain('MenuRecheck'), disabled: !any, run: () => doAction('recheck') },
    '-',
    { label: plain('MenuStartAll'), disabled: !all, run: () => doAction('start', true) },
    { label: plain('MenuStopAll'), disabled: !all, run: () => doAction('stop', true) },
    '-',
    { label: plain('MenuDelTorrent'), disabled: !any, run: () => removeSelected(false) },
    { label: plain('MenuDelData'), danger: true, disabled: !any, run: () => removeSelected(true) },
  ], x, y);
}

// ---------- Modal ----------
let modalResolve = null, modalToken = 0;
function openModal({ title = '', body = '', buttons = [], wide = false, focus = null }) {
  closeModal(null);
  const box = $('#modal-box');
  box.className = 'modal' + (wide ? ' wide' : '');
  box.innerHTML = (title ? `<h3>${esc(title)}</h3>` : '') + body +
    `<div class="modal-actions">${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  $('#modal').hidden = false;
  modalToken++;
  box.onclick = (e) => {
    const b = e.target.closest('[data-b]');
    if (b) closeModal(buttons[b.dataset.b].v);
  };
  box.onkeydown = (e) => {
    if (e.key !== 'Enter' || (e.target.tagName === 'TEXTAREA' && !e.ctrlKey)) return;
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const p = box.querySelector('.btn-primary');
    if (p) p.click();
  };
  (focus ? $(focus) : box.querySelector('.btn-primary'))?.focus();
  return new Promise((res) => { modalResolve = res; });
}
function closeModal(v) {
  $('#modal').hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(v);
}

// ---------- Server-editor ----------
function editorTypeChanged() {
  const f = $('#server-form');
  const ty = state.info.types[f.type.value];
  $('#url-label').textContent = plain(ty.passOnly ? 'UrlHintPassOnly' : 'UrlHint', { x: `https://${tr('ExampleUser')}.server.usbx.me${ty.example}` });
  $('#user-wrap').hidden = ty.passOnly;
}
function openEditor(s) {
  state.editing = s || {};
  const f = $('#server-form');
  $('#editor-title').textContent = plain(s ? 'SrvEdit' : 'SrvNew');
  f.type.innerHTML = Object.entries(state.info.types).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  f.type.value = s ? s.type : 'rtorrent';
  f.name.value = s ? s.name : '';
  f.url.value = s ? s.url : 'https://';
  f.user.value = s ? s.user : '';
  f.pass.value = '';
  f.pass.placeholder = s && s.hasPassword ? plain('PassKeep') : '';
  f.noSSL.checked = !!(s && s.noSSL);
  $('#btn-delete').hidden = !s;
  $('#encrypt-hint').hidden = state.info.canEncrypt;
  $('#form-error').hidden = true;
  editorTypeChanged();
  $('#editor').hidden = false;
  f.name.focus();
}
const closeEditor = () => { $('#editor').hidden = true; state.editing = null; };
function editorInput() {
  const f = $('#server-form');
  return { id: state.editing.id, type: f.type.value, name: f.name.value, url: f.url.value, user: f.user.value, pass: f.pass.value, noSSL: f.noSSL.checked };
}
async function saveEditor() {
  const r = await api.saveServer(editorInput());
  if (r.error) { $('#form-error').textContent = r.error; $('#form-error').hidden = false; return; }
  const saved = r.value;
  await loadServers();
  closeEditor();
  // Klienten er genskabt i hovedprocessen – hent forfra
  if (!state.current || saved.id === state.current) selectServer(saved.id);
  else renderServers();
}
async function deleteEditor() {
  const s = state.editing;
  if (!s || !s.id) return;
  const ok = await openModal({
    title: plain('SrvEdit'),
    body: `<p>${esc(tr('SrvConfirmDelete', { x: s.name }))}</p>`,
    buttons: [{ label: plain('BtnCancel'), v: null }, { label: plain('BtnDelete'), v: 'del', cls: 'btn-danger' }],
  });
  if (ok !== 'del') return;
  await api.deleteServer(s.id);
  await loadServers();
  closeEditor();
  if (s.id === state.current) selectServer(state.servers[0] ? state.servers[0].id : null);
  else renderAll();
}

// ---------- Sprog og layout ----------
function applyI18n() {
  document.documentElement.lang = I18N.lang;
  for (const el of $$('[data-i18n]')) el.textContent = plain(el.dataset.i18n);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = plain(el.dataset.i18nPh);
  for (const el of $$('[data-i18n-title]')) { el.title = plain(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); }
  for (const el of $$('[data-tip]')) {
    el.title = plain(el.dataset.tip) + (el.dataset.key ? ` (${el.dataset.key})` : '');
    el.setAttribute('aria-label', el.title);
  }
}
async function setLanguage(lang) {
  I18N.setLang(lang);
  $('#lang-select').value = I18N.lang;
  await api.setLang(I18N.lang); // fejl fra klienterne følger med
  applyI18n();
  renderHead();
  renderFoot();
  if (state.editing) { $('#editor-title').textContent = plain(state.editing.id ? 'SrvEdit' : 'SrvNew'); editorTypeChanged(); }
  renderAll();
}
function applyLayout() {
  $('#app').classList.toggle('no-sidebar', !ui.sidebar);
  $('#details').style.height = ui.detH + 'px';
  sizeCols();
}

// ---------- Hændelser ----------
function wire() {
  $('#lang-select').innerHTML = Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#lang-select').onchange = (e) => setLanguage(e.target.value);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctx')) hideCtx();
    const c = e.target.closest('[data-cmd]');
    if (c && !c.disabled) cmd(c.dataset.cmd, c);
  });
  $('#btn-new-server').onclick = () => openEditor(null);
  $('#btn-about').onclick = () => aboutDialog();

  // Servere
  $('#server-list').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { openEditor(state.servers.find((s) => s.id === ed.dataset.edit)); return; }
    const it = e.target.closest('.host-item');
    if (it && it.dataset.id !== state.current) selectServer(it.dataset.id);
  });
  $('#server-list').addEventListener('keydown', (e) => {
    const it = e.target.closest('.host-item');
    if (it && e.key === 'Enter' && it.dataset.id !== state.current) selectServer(it.dataset.id);
  });
  $('#server-list').addEventListener('contextmenu', (e) => {
    const it = e.target.closest('.host-item');
    if (!it) return;
    e.preventDefault();
    const s = state.servers.find((x) => x.id === it.dataset.id);
    showCtx([
      { label: plain('BtnEdit'), run: () => openEditor(s) },
      { label: plain('BtnTest'), run: () => testDialog(s) },
      '-',
      { label: plain('BtnDelete'), danger: true, run: () => { openEditor(s); deleteEditor(); } },
    ], e.clientX, e.clientY);
  });

  // Filtre og søgning
  $('#filter-list').addEventListener('click', (e) => {
    const it = e.target.closest('[data-filter]');
    if (!it) return;
    ui.filter = it.dataset.filter;
    saveUi();
    renderFilters();
    renderList();
  });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });

  // Kolonneoverskrifter: klik sorterer, træk i kanten ændrer bredde, højreklik vælger kolonner
  let resized = false;
  $('#tlist thead').addEventListener('mousedown', (e) => {
    const rz = e.target.closest('.rz');
    if (!rz) return;
    e.preventDefault();
    const k = rz.parentElement.dataset.k, x0 = e.clientX, w0 = rz.parentElement.offsetWidth;
    const move = (ev) => { ui.widths[k] = Math.max(40, w0 + ev.clientX - x0); sizeCols(); resized = true; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); saveUi(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  $('#tlist thead').addEventListener('click', (e) => {
    if (resized) { resized = false; return; }
    const th = e.target.closest('th');
    if (!th || e.target.closest('.rz')) return;
    if (ui.sort === th.dataset.k) ui.desc = !ui.desc;
    else { ui.sort = th.dataset.k; ui.desc = false; }
    saveUi();
    renderHead();
    renderList();
  });
  $('#tlist thead').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtx(COLS.slice(1).map((c) => ({
      label: plain(c.l), check: !ui.hidden.includes(c.k),
      run: () => {
        ui.hidden = ui.hidden.includes(c.k) ? ui.hidden.filter((x) => x !== c.k) : [...ui.hidden, c.k];
        saveUi();
        renderHead();
        renderList();
      },
    })), e.clientX, e.clientY);
  });

  // Rækker: klik, Ctrl+klik, Shift+klik og højreklik
  const wrap = $('#list-wrap');
  wrap.addEventListener('mousedown', (e) => {
    if (e.target.closest('thead') || e.target.closest('#list-msg .empty')) return;
    const row = e.target.closest('tbody tr');
    if (!row) { if (e.button === 0 && state.sel.size) { state.sel.clear(); onSelChange(); } return; }
    const h = row.dataset.h;
    if (e.button === 2 && state.sel.has(h)) return;
    if (e.shiftKey && state.anchor) selectRange(state.anchor, h, e.ctrlKey);
    else if (e.ctrlKey || e.metaKey) { if (state.sel.has(h)) state.sel.delete(h); else state.sel.add(h); state.anchor = h; }
    else { state.sel = new Set([h]); state.anchor = h; }
    state.cursor = h;
    onSelChange();
  });
  wrap.addEventListener('contextmenu', (e) => {
    if (e.target.closest('thead') || !state.current) return;
    e.preventDefault();
    rowCtx(e.clientX, e.clientY);
  });
  wrap.addEventListener('keydown', (e) => {
    const hs = state.shown.map((r) => r.h);
    if (!hs.length) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.sel = new Set(hs);
      onSelChange();
      return;
    }
    const page = Math.max(1, Math.floor(wrap.clientHeight / 31) - 2);
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 };
    if (!(e.key in steps)) return;
    e.preventDefault();
    let i = hs.indexOf(state.cursor);
    i = i < 0 ? 0 : Math.max(0, Math.min(hs.length - 1, i + steps[e.key]));
    const h = hs[i];
    if (e.shiftKey && state.anchor) selectRange(state.anchor, h, false);
    else { state.sel = new Set([h]); state.anchor = h; }
    state.cursor = h;
    onSelChange();
    $('#tlist tbody').rows[i]?.scrollIntoView({ block: 'nearest' });
  });
  new ResizeObserver(() => sizeCols()).observe(wrap);

  // Detaljer
  $('#det-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.dataset.tab === ui.tab) return;
    ui.tab = b.dataset.tab;
    saveUi();
    renderDetails();
    if (ui.tab !== 'general' && firstSel()) poll();
  });
  $('#splitter').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = $('#details').offsetHeight, sp = $('#splitter');
    const max = $('#main').clientHeight - 200;
    sp.classList.add('drag');
    const move = (ev) => { ui.detH = Math.max(90, Math.min(max, h0 - (ev.clientY - y0))); $('#details').style.height = ui.detH + 'px'; };
    const up = () => { sp.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); saveUi(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  // Server-editor
  const f = $('#server-form');
  f.type.onchange = editorTypeChanged;
  f.onsubmit = (e) => { e.preventDefault(); saveEditor(); };
  $('#editor-close').onclick = closeEditor;
  $('#btn-delete').onclick = deleteEditor;
  $('#btn-test').onclick = () => testDialog(editorInput());

  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(null); });

  // Tastatur
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#ctx').hidden) hideCtx();
      else if (!$('#modal').hidden) closeModal(null);
      else if (!$('#editor').hidden) closeEditor();
      return;
    }
    if (!$('#modal').hidden) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'o') { e.preventDefault(); cmd('addFile'); }
    else if (mod && k === 'u') { e.preventDefault(); cmd('addMagnet'); }
    else if (mod && k === 'b') { e.preventDefault(); cmd('sidebar'); }
    else if (mod && k === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
    else if (e.key === 'F5') { e.preventDefault(); cmd('refresh'); }
  });

  // Indsæt et magnet-link hvor som helst (uden for tekstfelter)
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const text = e.clipboardData.getData('text');
    if (/magnet:\?|^https?:\/\/\S+\.torrent/im.test(text)) { e.preventDefault(); magnetDialog(text.trim()); }
  });

  // Træk .torrent-filer eller magnet-links ind i vinduet
  let depth = 0;
  const payload = (e) => [...e.dataTransfer.types].some((x) => x === 'Files' || x === 'text/plain' || x === 'text/uri-list');
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!payload(e)) return;
    depth++;
    $('#drop').hidden = !state.current;
  });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#drop').hidden = true; } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('#drop').hidden = true;
    if (!needServer()) return;
    const files = [...e.dataTransfer.files].filter((f) => /\.torrent$/i.test(f.name)).map((f) => api.pathForFile(f));
    if (files.length) { api.addFiles(state.current, files, {}).then(reportAdd); return; }
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (/^(magnet:|https?:)/im.test(text)) api.addUrls(state.current, text, {}).then(reportAdd);
  });
}

// ---------- Start ----------
async function init() {
  state.info = unwrap(await api.info());
  I18N.setLang(state.info.lang);
  wire();
  $('#lang-select').value = I18N.lang;
  applyI18n();
  applyLayout();
  renderHead();
  renderFoot();
  await loadServers();
  const s = state.servers.find((x) => x.id === state.info.selected) || state.servers[0];
  if (s) selectServer(s.id);
  else { renderAll(); openEditor(null); }
}
init();
