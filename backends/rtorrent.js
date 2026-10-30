// rTorrent via XML-RPC over HTTP(S) med Basic-auth (typisk .../RPC2)
'use strict';

const { request, basicAuth, Serial, compute, num, str, t } = require('./common');

function normalizeUrl(u) {
  u = String(u || '').trim();
  const p = u.indexOf('://');
  if (p >= 0 && !u.slice(p + 3).includes('/')) u += '/RPC2';
  return u;
}

// ---------- XML-RPC ----------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[k];
});

function encValue(v) {
  if (Buffer.isBuffer(v)) return `<value><base64>${v.toString('base64')}</base64></value>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `<value><i8>${v}</i8></value>` : `<value><double>${v}</double></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encValue).join('')}</data></array></value>`;
  if (v && typeof v === 'object') {
    return `<value><struct>${Object.entries(v).map(([k, x]) => `<member><name>${xmlEsc(k)}</name>${encValue(x)}</member>`).join('')}</struct></value>`;
  }
  return `<value><string>${xmlEsc(v ?? '')}</string></value>`;
}
const encCall = (method, params) =>
  `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map((p) => `<param>${encValue(p)}</param>`).join('')}</params></methodCall>`;

// Lille rekursiv parser til XML-RPC-svar
function decResponse(xml) {
  const toks = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) toks.push({ k: 'text', v: m[4] });
    else toks.push({ k: m[1] ? 'close' : m[3] ? 'self' : 'open', n: m[2] });
  }
  let i = 0;
  const skipWs = () => { while (toks[i] && toks[i].k === 'text' && !toks[i].v.trim()) i++; };
  const tag = () => { skipWs(); return toks[i++]; };
  const bad = () => new Error(t('ErrInvalidResponse', { x: 'rTorrent' }));

  function value() {
    const o = tag();
    if (!o || o.n !== 'value') throw bad();
    if (o.k === 'self') return '';
    // <value>tekst</value> uden type er en streng
    if (toks[i] && toks[i].k === 'text' && toks[i + 1] && toks[i + 1].k === 'close') { const s = xmlUnesc(toks[i].v); i += 2; return s; }
    skipWs();
    if (toks[i] && toks[i].k === 'close' && toks[i].n === 'value') { i++; return ''; }
    const ty = tag();
    let r;
    if (ty.k === 'self') r = ty.n === 'array' ? [] : ty.n === 'struct' ? {} : '';
    else if (ty.n === 'array') {
      r = [];
      const d = tag();
      if (d.k === 'open') {
        for (;;) { skipWs(); if (toks[i].k === 'close') { i++; break; } r.push(value()); }
      }
      tag(); // </array>
    } else if (ty.n === 'struct') {
      r = {};
      for (;;) {
        const mm = tag();
        if (mm.k === 'close') break;
        tag(); // <name>
        const name = toks[i].k === 'text' ? xmlUnesc(toks[i++].v) : '';
        tag(); // </name>
        r[name] = value();
        tag(); // </member>
      }
    } else {
      let s = '';
      if (toks[i].k === 'text') s = toks[i++].v;
      tag(); // </type>
      s = xmlUnesc(s);
      if (['i4', 'i8', 'i2', 'int', 'double'].includes(ty.n)) r = Number(s);
      else if (ty.n === 'boolean') r = s.trim() === '1';
      else if (ty.n === 'base64') r = Buffer.from(s, 'base64');
      else r = s;
    }
    tag(); // </value>
    return r;
  }

  for (; i < toks.length; i++) {
    const k = toks[i];
    if (k.k !== 'open') continue;
    if (k.n === 'fault') {
      i++;
      const f = value();
      throw new Error((f && f.faultString) || t('ErrRTUnknown'));
    }
    if (k.n === 'param') { i++; return value(); }
  }
  throw bad();
}

// Ekstra sikkerhedstjek før der slettes noget på serveren
function safeDataPath(path, name) {
  path = path.replace(/\/+$/, '');
  if (!name || !path.startsWith('/')) return false;
  if (path.includes('..')) return false;
  if (!path.endsWith('/' + name)) return false;
  return (path.match(/\//g) || []).length >= 4;
}

const LIST_FIELDS = ['d.hash=', 'd.name=', 'd.size_bytes=', 'd.completed_bytes=', 'd.down.rate=', 'd.up.rate=', 'd.ratio=', 'd.state=', 'd.complete=', 'd.is_active=', 'd.peers_complete=', 'd.peers_accounted=', 'd.custom1=', 'd.message=', 'd.hashing=', 'd.left_bytes=', 'd.up.total=', 'd.down.total=', 'd.directory=', 'd.timestamp.finished=',
  // Scrape-tal for alle trackere, adskilt af '#' (største tal bruges)
  'cat="$t.multicall=d.hash=,t.scrape_complete=,cat={#}"',
  'cat="$t.multicall=d.hash=,t.scrape_incomplete=,cat={#}"'];
const maxField = (s) => String(s).split('#').reduce((m, v) => Math.max(m, Number(v) || 0), 0);
const urlDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

class RTorrent {
  static normalizeUrl = normalizeUrl;
  constructor(c) { this.c = c; this.q = new Serial(); }

  rpc(method, params = []) {
    return this.q.run(async () => {
      const r = await request(this.c.url, {
        method: 'POST',
        headers: { Authorization: basicAuth(this.c.user, this.c.pass), 'Content-Type': 'text/xml' },
        body: encCall(method, params),
        insecure: this.c.insecure,
      });
      if (r.status === 401) throw new Error('HTTP 401 - ' + t('ErrBadLogin'));
      if (r.status !== 200) throw new Error(`HTTP ${r.status} - ` + t('ErrCheckUrl', { x: '.../RPC2' }));
      return decResponse(r.body.toString('utf8'));
    });
  }

  // Flere kommandoer pr. torrent i ét kald. Første fejl kastes.
  async multi(methods, hashes) {
    const calls = [];
    for (const h of hashes) for (const m of methods) calls.push({ methodName: m, params: [h] });
    const res = await this.rpc('system.multicall', [calls]);
    for (const r of res || []) if (r && !Array.isArray(r) && r.faultString) throw new Error(r.faultString);
    return (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
  }

  async list() {
    const rows = await this.rpc('d.multicall2', ['', 'main', ...LIST_FIELDS]);
    let srvT = 0;
    try { srvT = num(await this.rpc('system.time')); } catch {}
    return (rows || []).map((f) => {
      const x = compute({
        hash: str(f[0]), name: str(f[1]), size: num(f[2]), done: num(f[3]), down: num(f[4]), up: num(f[5]),
        ratio: num(f[6]) / 1000, state: num(f[7]), complete: num(f[8]), active: num(f[9]),
        seeds: num(f[10]), peers: num(f[11]), label: urlDecode(str(f[12])), message: str(f[13]),
        hashing: num(f[14]), left: num(f[15]), upTotal: num(f[16]), downTotal: num(f[17]), dir: str(f[18]),
        seedsTotal: maxField(f[20]), peersTotal: maxField(f[21]),
      });
      const fin = num(f[19]);
      if (x.complete && fin > 0 && srvT > fin) x.seedSecs = srvT - fin;
      return x;
    });
  }

  async details(kind, hash) {
    if (kind === 'trackers') {
      const r = await this.rpc('t.multicall', [hash, '', 't.url=', 't.is_enabled=', 't.scrape_complete=', 't.scrape_incomplete=', 't.scrape_downloaded=']);
      return r.map((f) => ({ url: str(f[0]), enabled: num(f[1]) === 1, seeds: num(f[2]), peers: num(f[3]), downloads: num(f[4]) }));
    }
    if (kind === 'peers') {
      const r = await this.rpc('p.multicall', [hash, '', 'p.address=', 'p.port=', 'p.client_version=', 'p.completed_percent=', 'p.down_rate=', 'p.up_rate=']);
      return r.map((f) => ({ ip: str(f[0]), port: num(f[1]), client: str(f[2]), progress: num(f[3]), down: num(f[4]), up: num(f[5]) }));
    }
    if (kind === 'files') {
      const r = await this.rpc('f.multicall', [hash, '', 'f.path=', 'f.size_bytes=', 'f.completed_chunks=', 'f.size_chunks=', 'f.priority=']);
      return r.map((f) => ({
        path: str(f[0]), size: num(f[1]),
        progress: num(f[3]) > 0 ? (num(f[2]) * 100) / num(f[3]) : 0,
        priority: num(f[4]) === 0 ? 0 : num(f[4]) === 2 ? 2 : 1,
      }));
    }
    return [];
  }

  async action(act, hashes) {
    const m = { start: ['d.start', 'd.resume'], stop: ['d.stop', 'd.close'], recheck: ['d.check_hash'] }[act];
    if (m) await this.multi(m, hashes);
  }

  // Med withData stoppes torrents, data slettes på serveren (rm -rf), og
  // derefter fjernes torrenten. Kaster hvis intet er slettet; ellers { warn }.
  async remove(hashes, withData) {
    if (!withData) {
      try { await this.multi(['d.erase'], hashes); } catch (e) { throw new Error(t('LblError') + ': ' + e.message); }
      return {};
    }
    let info;
    try { info = await this.multi(['d.base_path', 'd.name'], hashes); } catch (e) {
      throw new Error(t('ErrRTNoPath') + '\n' + e.message + '\n' + t('MsgNothingDeleted'));
    }
    if (info.length !== hashes.length * 2) throw new Error(t('ErrRTBadPath') + '\n' + t('MsgNothingDeleted'));
    try { await this.multi(['d.stop', 'd.close'], hashes); } catch {}
    let failed = '', skipped = 0;
    for (let i = 0; i < info.length; i += 2) {
      const path = str(info[i]), name = str(info[i + 1]);
      if (!safeDataPath(path, name)) { skipped++; continue; }
      try { await this.rpc('execute.nothrow.bg', ['', 'rm', '-rf', '--', path]); } catch (e) { failed = e.message; }
    }
    try { await this.multi(['d.erase'], hashes); } catch {}
    if (failed) return { warn: t('WarnRTRmFailed') + '\n' + failed + '\n' + t('WarnRTLeftBehind') };
    if (skipped) return { warn: t('WarnRTSkipped', { x: skipped }) + '\n' + t('WarnRTRemovedAnyway') };
    return {};
  }

  load(method, payload, dir) {
    const p = ['', payload];
    if (dir) p.push(`d.directory.set="${dir}"`);
    return this.rpc(method, p);
  }
  async addFile(buf, start, dir) { await this.load(start ? 'load.raw_start' : 'load.raw', buf, dir); }
  async addUrl(url, start, dir) { await this.load(start ? 'load.start' : 'load.normal', url, dir); }

  async test() {
    let msg = `URL: ${this.c.url}\n${t('TestUser')}: ${this.c.user}\n\n`;
    try {
      msg += `rTorrent ${await this.rpc('system.client_version')}`;
      try { msg += ` (libtorrent ${await this.rpc('system.library_version')})`; } catch {}
      const rows = await this.rpc('d.multicall2', ['', 'main', 'd.hash=']);
      msg += `\n${t('StatusTorrents', { x: rows.length })}`;
      try { msg += `\n${t('TestDefaultDir')}: ${await this.rpc('directory.default')}`; } catch {}
    } catch (e) {
      msg += t('TestFailed', { x: 'system.client_version' }) + '\n' + e.message;
    }
    return msg;
  }
}

module.exports = RTorrent;
