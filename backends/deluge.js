// Deluge via Web UI'ens JSON-RPC (.../json) med cookie-login.
// Web UI'en logger kun ind med en adgangskode og skal være forbundet til en
// daemon; er den ikke det, forbindes der til den første daemon i listen.
'use strict';

const { request, cookieFrom, Serial, compute, num, str, pos, t } = require('./common');

// Accepterer fx https://host/deluge, https://host/deluge/ eller .../deluge/json
function normalizeUrl(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u.includes('://')) return u;
  if (!/\/json$/i.test(u)) u += '/json';
  return u;
}

const LIST_FIELDS = ['name', 'total_wanted', 'total_done', 'progress', 'download_payload_rate', 'upload_payload_rate', 'ratio', 'state', 'num_seeds', 'num_peers', 'total_seeds', 'total_peers', 'label', 'message', 'save_path', 'total_uploaded', 'all_time_download', 'completed_time', 'seeding_time', 'is_finished'];
const ids = (hashes) => hashes.map((h) => h.toLowerCase());

class Deluge {
  static normalizeUrl = normalizeUrl;
  constructor(c) { this.c = c; this.q = new Serial(); this.cookie = ''; this.id = 0; }

  // Sender ét kald og giver hele svaret ({ result, error }) tilbage
  async raw(method, params) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await request(this.c.url, { method: 'POST', headers, body: JSON.stringify({ method, params, id: ++this.id }), insecure: this.c.insecure });
    const ck = cookieFrom(r.headers, (n) => n.toLowerCase() === '_session_id');
    if (ck) this.cookie = ck;
    if (r.status === 401) throw new Error('HTTP 401 - ' + t('ErrDLProxyAuth'));
    if (r.status !== 200) throw new Error(`HTTP ${r.status} - ` + t('ErrCheckUrl', { x: '.../deluge' }));
    try { return JSON.parse(r.body.toString('utf8')); } catch { throw new Error(t('ErrInvalidResponse', { x: 'Deluge' })); }
  }
  static err(j) {
    if (j && j.error) {
      const e = new Error(str(j.error.message) || t('ErrUnknownFrom', { x: 'Deluge' }));
      e.code = num(j.error.code);
      return e;
    }
    return null;
  }

  // Logger ind og sørger for, at Web UI'en er forbundet til en daemon
  async login() {
    this.cookie = '';
    let j = await this.raw('auth.login', [this.c.pass]);
    if (Deluge.err(j)) throw Deluge.err(j);
    if (j.result !== true) throw new Error(t('ErrDLBadPass'));
    j = await this.raw('web.connected', []);
    if (!Deluge.err(j) && j.result === true) return;
    j = await this.raw('web.get_hosts', []);
    if (Deluge.err(j)) throw Deluge.err(j);
    const id = Array.isArray(j.result) && Array.isArray(j.result[0]) ? str(j.result[0][0]) : '';
    if (!id) throw new Error(t('ErrDLNoDaemon'));
    j = await this.raw('web.connect', [id]);
    if (Deluge.err(j)) throw new Error(t('ErrDLDaemon', { x: Deluge.err(j).message }));
  }

  // Sender et kald, logger ind (igen) ved behov og giver "result" tilbage
  call(method, params) {
    return this.q.run(async () => {
      for (let tries = 0; tries < 2; tries++) {
        if (!this.cookie) await this.login();
        const j = await this.raw(method, params);
        const e = Deluge.err(j);
        if (e && e.code === 1 && tries === 0) { this.cookie = ''; continue; } // "Not authenticated"
        if (e) throw e;
        return j.result;
      }
    });
  }

  async list() {
    const res = (await this.call('core.get_torrents_status', [{}, LIST_FIELDS])) || {};
    return Object.entries(res).map(([hash, o]) => {
      const st = str(o.state);
      const size = num(o.total_wanted), done = num(o.total_done);
      const sT = pos(o.total_seeds);
      const x = compute({
        hash: hash.toUpperCase(), name: str(o.name), size, done, left: Math.max(0, size - done),
        down: num(o.download_payload_rate), up: num(o.upload_payload_rate), ratio: pos(o.ratio),
        seeds: num(o.num_seeds), peers: num(o.num_seeds) + num(o.num_peers),
        seedsTotal: sT, peersTotal: pos(o.total_peers) + sT, // forbundne peers inkluderer seeds
        upTotal: num(o.total_uploaded), downTotal: num(o.all_time_download), dir: str(o.save_path),
        label: str(o.label), message: st === 'Error' ? str(o.message) : '',
        state: st !== 'Paused', hashing: st === 'Checking', active: 1,
        complete: !!o.is_finished || num(o.progress) >= 100,
      });
      const s2 = { Queued: 'queued', Moving: 'moving', Allocating: 'allocating', Error: 'error' }[st];
      if (s2) x.status = s2;
      if (x.complete) x.seedSecs = num(o.seeding_time);
      return x;
    });
  }

  async details(kind, hash) {
    const fields = { trackers: ['trackers'], peers: ['peers'], files: ['files', 'file_progress', 'file_priorities'] }[kind];
    if (!fields) return [];
    const o = (await this.call('core.get_torrent_status', [hash.toLowerCase(), fields])) || {};
    if (kind === 'trackers') {
      // Deluge giver ikke seeds/peers pr. tracker
      return (o.trackers || []).map((x) => ({ url: str(x.url), enabled: true, seeds: 0, peers: 0, downloads: 0 }));
    }
    if (kind === 'peers') {
      return (o.peers || []).map((x) => {
        // "1.2.3.4:6881" eller "[::1]:6881"
        let ip = str(x.ip), port = 0;
        const p = ip.lastIndexOf(':');
        if (p >= 0) { port = Number(ip.slice(p + 1)) || 0; ip = ip.slice(0, p); }
        return { ip: ip.replace(/[[\]]/g, ''), port, client: str(x.client), progress: num(x.progress) * 100, down: num(x.down_speed), up: num(x.up_speed) };
      });
    }
    const prog = o.file_progress || [], prio = o.file_priorities || [];
    // 0 = spring over, 1 = lav, 4 = normal, 7 = høj
    return (o.files || []).map((x, i) => ({
      path: str(x.path), size: num(x.size), progress: num(prog[i]) * 100,
      priority: i < prio.length ? (num(prio[i]) === 0 ? 0 : num(prio[i]) > 4 ? 2 : 1) : 1,
    }));
  }

  async action(act, hashes) {
    const m = { start: 'core.resume_torrents', stop: 'core.pause_torrents', recheck: 'core.force_recheck' }[act];
    if (m) await this.call(m, [ids(hashes)]);
  }

  // Deluge sletter selv data (remove_data), så der er ingen advarsler
  async remove(hashes, withData) {
    let res;
    try { res = await this.call('core.remove_torrents', [ids(hashes), !!withData]); } catch (e) {
      throw new Error(t('LblError') + ': ' + e.message);
    }
    // resultatet er en liste over de torrents, der ikke kunne fjernes
    if (Array.isArray(res) && res.length) throw new Error(t('LblError') + ': ' + t('ErrNotRemoved', { x: res.length }));
    return {};
  }

  options(start, dir) {
    const o = { add_paused: !start };
    if (dir) o.download_location = dir;
    return o;
  }
  async addFile(buf, start, dir) { await this.call('core.add_torrent_file', ['upload.torrent', buf.toString('base64'), this.options(start, dir)]); }
  async addUrl(url, start, dir) {
    const m = url.toLowerCase().startsWith('magnet:') ? 'core.add_torrent_magnet' : 'core.add_torrent_url';
    await this.call(m, [url, this.options(start, dir)]);
  }

  async test() {
    let msg = `URL: ${this.c.url}\n\n`;
    try {
      msg += `Deluge ${str(await this.call('daemon.info', []))}\n`;
      try { msg += `${t('TestDefaultDir')}: ${str(await this.call('core.get_config_value', ['download_location']))}`; } catch {}
    } catch (e) {
      msg += t('TestFailed', { x: 'daemon.info' }) + '\n' + e.message;
    }
    return msg;
  }
}

module.exports = Deluge;
