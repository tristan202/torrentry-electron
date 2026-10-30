// qBittorrent via WebUI API v2 (.../api/v2/...) med cookie-login.
// Logger ind igen, hvis sessionen er udløbet (403).
'use strict';

const crypto = require('crypto');
const { request, cookieFrom, Serial, compute, num, str, pos, t } = require('./common');

// Basisadressen til WebUI, fx https://bruger.server.usbx.me/qbittorrent
function normalizeUrl(u) {
  u = String(u || '').trim();
  const p = u.toLowerCase().indexOf('/api/v2');
  if (p >= 0) u = u.slice(0, p);
  return u.replace(/\/+$/, '');
}

const form = (o) => new URLSearchParams(o).toString();
const hashList = (hashes) => hashes.map((h) => h.toLowerCase()).join('|');

class QBittorrent {
  static normalizeUrl = normalizeUrl;
  constructor(c) { this.c = c; this.q = new Serial(); this.cookie = ''; }

  // Rå forespørgsel: { status, text }
  async raw(path, body, contentType) {
    const headers = { Referer: this.c.url + '/' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body != null) headers['Content-Type'] = contentType;
    const r = await request(this.c.url + path, { method: body != null ? 'POST' : 'GET', headers, body, insecure: this.c.insecure });
    const text = r.body.toString('utf8');
    if (path === '/api/v2/auth/login' && r.status === 200 && text.trim() === 'Ok.') {
      this.cookie = cookieFrom(r.headers, (n) => n.toUpperCase().includes('SID'));
    }
    return { status: r.status, text };
  }

  async login() {
    this.cookie = '';
    const r = await this.raw('/api/v2/auth/login', form({ username: this.c.user, password: this.c.pass }), 'application/x-www-form-urlencoded');
    if (r.status === 200) { if (r.text.trim() !== 'Ok.') throw new Error(t('ErrQBBadLogin')); return; }
    if (r.status === 403) throw new Error(t('ErrQBBanned'));
    throw new Error(`HTTP ${r.status} ${t('ErrAtLogin')} - ` + t('ErrCheckUrl', { x: '.../qbittorrent' }));
  }

  // GET hvis body er null. Returnerer svarteksten eller kaster.
  call(path, body = null, contentType = 'application/x-www-form-urlencoded') {
    return this.q.run(async () => {
      for (let tries = 0; tries < 2; tries++) {
        if (!this.cookie) await this.login();
        const r = await this.raw(path, body, contentType);
        if (r.status === 403 && tries === 0) { this.cookie = ''; continue; }
        if (r.status === 200) return r.text;
        const e = new Error(r.status === 404 ? 'HTTP 404 - ' + t('ErrQB404') : `HTTP ${r.status} ${r.text.trim()}`);
        e.status = r.status;
        throw e;
      }
    });
  }
  async json(path) {
    const s = await this.call(path);
    try { return JSON.parse(s); } catch { throw new Error(t('ErrInvalidResponse', { x: 'qBittorrent' })); }
  }
  // Kommandoer svarer med tekst; "Fails." betyder afvist
  async cmd(path, body, contentType) {
    const s = await this.call(path, body, contentType);
    if (s.trim() === 'Fails.') throw new Error(t('ErrQBRejected'));
    return s;
  }

  async list() {
    const arr = await this.json('/api/v2/torrents/info');
    return (Array.isArray(arr) ? arr : []).map((o) => {
      const st = str(o.state);
      const sT = pos(o.num_complete);
      const x = compute({
        hash: str(o.hash).toUpperCase(), name: str(o.name), size: num(o.size), done: num(o.completed), left: num(o.amount_left),
        down: num(o.dlspeed), up: num(o.upspeed), ratio: pos(o.ratio),
        seeds: num(o.num_seeds), peers: num(o.num_seeds) + num(o.num_leechs),
        seedsTotal: sT, peersTotal: pos(o.num_incomplete) + sT, // forbundne peers inkluderer seeds
        upTotal: num(o.uploaded), downTotal: num(o.downloaded),
        dir: str(o.content_path) || str(o.save_path),
        label: str(o.category) || str(o.tags),
        message: st === 'error' ? t('MsgTorrentError') : st === 'missingFiles' ? t('MsgFilesMissing') : '',
        // qBittorrent 5 bruger stopped*, ældre versioner paused*
        state: !st.startsWith('stopped') && !st.startsWith('paused'),
        hashing: st.startsWith('checking'), active: 1,
        complete: num(o.progress) >= 1,
      });
      const s2 = { queuedDL: 'queued', queuedUP: 'queued', metaDL: 'metadata', moving: 'moving', error: 'error', missingFiles: 'error' }[st];
      if (s2) x.status = s2;
      if (x.complete) x.seedSecs = num(o.seeding_time);
      return x;
    });
  }

  async details(kind, hash) {
    hash = hash.toLowerCase();
    if (kind === 'trackers') {
      const arr = await this.json('/api/v2/torrents/trackers?hash=' + hash);
      return (arr || []).filter((o) => !str(o.url).startsWith('**')) // ** [DHT] **, ** [PeX] **, ** [LSD] **
        .map((o) => ({ url: str(o.url), enabled: num(o.status) !== 0, seeds: pos(o.num_seeds), peers: pos(o.num_leeches), downloads: pos(o.num_downloaded) }));
    }
    if (kind === 'peers') {
      // sync/torrentPeers giver et objekt med "ip:port" som nøgler
      const j = await this.json('/api/v2/sync/torrentPeers?rid=0&hash=' + hash);
      return Object.values(j.peers || {}).map((o) => ({ ip: str(o.ip), port: num(o.port), client: str(o.client), progress: num(o.progress) * 100, down: num(o.dl_speed), up: num(o.up_speed) }));
    }
    if (kind === 'files') {
      const arr = await this.json('/api/v2/torrents/files?hash=' + hash);
      // 0 = spring over, 1 = normal, 6/7 = høj/maks
      return (arr || []).map((o) => ({ path: str(o.name), size: num(o.size), progress: num(o.progress) * 100, priority: num(o.priority) === 0 ? 0 : num(o.priority) > 1 ? 2 : 1 }));
    }
    return [];
  }

  async action(act, hashes) {
    const body = form({ hashes: hashList(hashes) });
    // qBittorrent 4.x hedder det resume/pause
    const tryBoth = async (a, b) => {
      try { await this.cmd(a, body); } catch (e) { if (e.status === 404) await this.cmd(b, body); else throw e; }
    };
    if (act === 'start') await tryBoth('/api/v2/torrents/start', '/api/v2/torrents/resume');
    else if (act === 'stop') await tryBoth('/api/v2/torrents/stop', '/api/v2/torrents/pause');
    else if (act === 'recheck') await this.cmd('/api/v2/torrents/recheck', body);
  }

  // qBittorrent sletter selv data (deleteFiles), så der er ingen advarsler
  async remove(hashes, withData) {
    try { await this.cmd('/api/v2/torrents/delete', form({ hashes: hashList(hashes), deleteFiles: withData ? 'true' : 'false' })); } catch (e) {
      throw new Error(t('LblError') + ': ' + e.message);
    }
    return {};
  }

  // torrents/add kræver multipart/form-data
  async add({ urls, file }, start, dir) {
    const bnd = '----Torrentry' + crypto.randomBytes(8).toString('hex');
    const parts = [];
    const field = (name, value) => parts.push(Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    if (urls) field('urls', urls);
    // "stopped" er navnet i qBittorrent 5, "paused" i ældre versioner
    field('stopped', start ? 'false' : 'true');
    field('paused', start ? 'false' : 'true');
    if (dir) field('savepath', dir);
    if (file) {
      parts.push(Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="torrents"; filename="upload.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`, 'utf8'));
      parts.push(file, Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${bnd}--\r\n`));
    await this.cmd('/api/v2/torrents/add', Buffer.concat(parts), 'multipart/form-data; boundary=' + bnd);
  }
  addFile(buf, start, dir) { return this.add({ file: buf }, start, dir); }
  addUrl(url, start, dir) { return this.add({ urls: url }, start, dir); }

  async test() {
    let msg = `URL: ${this.c.url}\n${t('TestUser')}: ${this.c.user}\n\n`;
    try {
      const v = await this.call('/api/v2/app/version');
      const api = await this.call('/api/v2/app/webapiVersion').catch(() => '?');
      const sp = await this.call('/api/v2/app/defaultSavePath').catch(() => '?');
      msg += `qBittorrent ${v} (WebUI API ${api})\n${t('TestDefaultDir')}: ${sp}`;
    } catch (e) {
      msg += t('TestFailed', { x: 'app/version' }) + '\n' + e.message;
    }
    return msg;
  }
}

module.exports = QBittorrent;
