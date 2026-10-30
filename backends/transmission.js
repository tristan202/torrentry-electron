// Transmission via JSON-RPC (.../transmission/rpc) med Basic-auth.
// Serveren svarer 409 med et session-id, som skal sendes med igen.
'use strict';

const { request, basicAuth, Serial, compute, num, str, pos, t } = require('./common');

// Accepterer fx https://host, https://host/transmission eller .../transmission/web/
function normalizeUrl(u) {
  u = String(u || '').trim();
  const p = u.indexOf('://');
  if (p < 0) return u;
  if (!u.slice(p + 3).includes('/')) return u + '/transmission/rpc';
  u = u.replace(/\/$/, '');
  if (/\/web$/i.test(u)) u = u.slice(0, -4);
  if (/\/transmission$/i.test(u)) u += '/rpc';
  return u;
}

const LIST_FIELDS = ['hashString', 'name', 'sizeWhenDone', 'leftUntilDone', 'percentDone', 'rateDownload', 'rateUpload', 'uploadRatio', 'status', 'error', 'errorString', 'peersSendingToUs', 'peersConnected', 'trackerStats', 'labels', 'downloadDir', 'uploadedEver', 'downloadedEver', 'doneDate', 'secondsSeeding'];
const ids = (hashes) => hashes.map((h) => h.toLowerCase());

class Transmission {
  static normalizeUrl = normalizeUrl;
  constructor(c) { this.c = c; this.q = new Serial(); this.session = ''; }

  // Returnerer "arguments" fra svaret; kaster hvis result ikke er "success"
  rpc(method, args) {
    return this.q.run(async () => {
      const body = JSON.stringify(args ? { method, arguments: args } : { method });
      for (let tries = 0; tries < 2; tries++) {
        const headers = { Authorization: basicAuth(this.c.user, this.c.pass), 'Content-Type': 'application/json' };
        if (this.session) headers['X-Transmission-Session-Id'] = this.session;
        const r = await request(this.c.url, { method: 'POST', headers, body, insecure: this.c.insecure });
        if (r.status === 409) {
          this.session = String(r.headers['x-transmission-session-id'] || '');
          if (this.session) continue;
          break;
        }
        if (r.status === 401) throw new Error('HTTP 401 - ' + t('ErrBadLogin'));
        if (r.status !== 200) throw new Error(`HTTP ${r.status} - ` + t('ErrCheckUrl', { x: '.../transmission/rpc' }));
        let j;
        try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error(t('ErrInvalidResponse', { x: 'Transmission' })); }
        if (j.result !== 'success') throw new Error(j.result || t('ErrInvalidResponse', { x: 'Transmission' }));
        return j.arguments || {};
      }
      throw new Error('HTTP 409 - ' + t('ErrTR409'));
    });
  }

  async list() {
    const a = await this.rpc('torrent-get', { fields: LIST_FIELDS });
    return (a.torrents || []).map((o) => {
      // svarmens total = største tal over trackerne
      let sT = 0, pT = 0;
      for (const tk of o.trackerStats || []) { sT = Math.max(sT, num(tk.seederCount)); pT = Math.max(pT, num(tk.leecherCount)); }
      const size = num(o.sizeWhenDone), left = num(o.leftUntilDone);
      const st = num(o.status); // 0 stoppet, 1/2 tjek (i kø), 3/4 hent (i kø), 5/6 seed (i kø)
      const x = compute({
        hash: str(o.hashString).toUpperCase(), name: str(o.name), size, left, done: size - left,
        down: num(o.rateDownload), up: num(o.rateUpload), ratio: pos(o.uploadRatio), // -1 = ukendt, -2 = uendelig
        seeds: num(o.peersSendingToUs), peers: num(o.peersConnected),
        seedsTotal: sT, peersTotal: pT + sT, // forbundne peers inkluderer seeds
        upTotal: num(o.uploadedEver), downTotal: num(o.downloadedEver), dir: str(o.downloadDir),
        message: num(o.error) ? str(o.errorString) : '',
        label: (o.labels || []).join(', '),
        state: st !== 0, hashing: st === 1 || st === 2, active: 1,
        complete: num(o.percentDone) >= 1 && left === 0,
      });
      if (st === 3 || st === 5) x.status = 'queued';
      if (x.complete) x.seedSecs = num(o.secondsSeeding);
      return x;
    });
  }

  async details(kind, hash) {
    const fields = { trackers: ['trackerStats'], peers: ['peers'], files: ['files', 'fileStats'] }[kind];
    if (!fields) return [];
    const a = await this.rpc('torrent-get', { ids: [hash.toLowerCase()], fields });
    const o = (a.torrents || [])[0] || {};
    if (kind === 'trackers') {
      return (o.trackerStats || []).map((x) => ({ url: str(x.announce), enabled: true, seeds: pos(x.seederCount), peers: pos(x.leecherCount), downloads: pos(x.downloadCount) }));
    }
    if (kind === 'peers') {
      return (o.peers || []).map((x) => ({ ip: str(x.address), port: num(x.port), client: str(x.clientName), progress: num(x.progress) * 100, down: num(x.rateToClient), up: num(x.rateToPeer) }));
    }
    const stats = o.fileStats || [];
    return (o.files || []).map((x, i) => {
      const s = stats[i];
      const size = num(x.length);
      return {
        path: str(x.name), size,
        progress: size > 0 ? (num(x.bytesCompleted) * 100) / size : 0,
        priority: s ? (!s.wanted ? 0 : num(s.priority) > 0 ? 2 : 1) : 1,
      };
    });
  }

  async action(act, hashes) {
    const m = { start: 'torrent-start', stop: 'torrent-stop', recheck: 'torrent-verify' }[act];
    if (m) await this.rpc(m, { ids: ids(hashes) });
  }

  // Transmission sletter selv data (delete-local-data), så der er ingen advarsler
  async remove(hashes, withData) {
    try { await this.rpc('torrent-remove', { ids: ids(hashes), 'delete-local-data': !!withData }); } catch (e) {
      throw new Error(t('LblError') + ': ' + e.message);
    }
    return {};
  }

  addArgs(key, value, start, dir) {
    const a = { [key]: value, paused: !start };
    if (dir) a['download-dir'] = dir;
    return a;
  }
  async addFile(buf, start, dir) { await this.rpc('torrent-add', this.addArgs('metainfo', buf.toString('base64'), start, dir)); }
  async addUrl(url, start, dir) { await this.rpc('torrent-add', this.addArgs('filename', url, start, dir)); }

  async test() {
    let msg = `URL: ${this.c.url}\n${t('TestUser')}: ${this.c.user}\n\n`;
    try {
      const a = await this.rpc('session-get', { fields: ['version', 'rpc-version', 'download-dir'] });
      msg += `Transmission ${str(a.version)} (${t('TestRpcVersion')} ${num(a['rpc-version'])})\n`;
      msg += `${t('TestDefaultDir')}: ${str(a['download-dir'])}`;
    } catch (e) {
      msg += t('TestFailed', { x: 'session-get' }) + '\n' + e.message;
    }
    return msg;
  }
}

module.exports = Transmission;
