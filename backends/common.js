// Fælles for alle klienter: HTTP, status-udregning og typer.
// Hver klient (rtorrent.js, transmission.js, ...) er en klasse med samme metoder:
//   list()                         -> [Torrent]
//   details(kind, hash)            -> trackers | peers | files (kind = navnet)
//   action(act, hashes)            -> act = 'start' | 'stop' | 'recheck'
//   remove(hashes, withData)       -> { warn } (kaster ved fejl)
//   addFile(buf, start, dir)       -> kaster ved fejl
//   addUrl(url, start, dir)        -> kaster ved fejl
//   test()                         -> tekst til "Test forbindelse"
// Fejl kastes som Error med en oversat besked, klar til at blive vist.
'use strict';

const http = require('http');
const https = require('https');
const { t } = require('../renderer/strings.js');

const TIMEOUT = 20000;

// Sender en forespørgsel og giver { status, headers, body (Buffer) } tilbage.
// insecure = ignorer certifikatfejl (feltet "Ignorer SSL-certifikatfejl").
function request(url, { method = 'GET', headers = {}, body = null, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(t('ErrConnect') + ` (${url})`)); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': 'Torrentry', ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
      rejectUnauthorized: !insecure,
      timeout: TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => reject(connErr(e)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(connErr(e)));
    if (data) req.write(data);
    req.end();
  });
}
function connErr(e) {
  return new Error(`${t('ErrConnect')} (${e.code || e.message})`);
}

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');

// Cookie "navn=værdi" fra Set-Cookie, hvis navnet opfylder test()
function cookieFrom(headers, test) {
  for (const c of [].concat(headers['set-cookie'] || [])) {
    const kv = c.split(';')[0].trim();
    if (test(kv.split('=')[0])) return kv;
  }
  return '';
}

// Ét kald ad gangen pr. klient – login og session-id deles mellem kaldene
class Serial {
  constructor() { this._q = Promise.resolve(); }
  run(fn) {
    const p = this._q.then(fn, fn);
    this._q = p.catch(() => {});
    return p;
  }
}

// Udleder forløb, ETA og status ud fra de rå felter. Felterne state/complete/
// active/hashing følger rTorrents betydning; de andre klienter sætter dem, så
// resultatet bliver det samme.
function compute(x) {
  const progress = x.complete ? 100 : x.size > 0 ? (x.done * 100) / x.size : 0;
  let status;
  if (x.hashing) status = 'checking';
  else if (!x.state) status = x.complete ? 'finished' : 'stopped';
  else if (!x.active) status = 'paused';
  else if (x.complete) status = 'seeding';
  else status = 'downloading';
  return {
    hash: x.hash, name: x.name, size: x.size, done: x.done, left: x.left,
    down: x.down, up: x.up, ratio: x.ratio, upTotal: x.upTotal, downTotal: x.downTotal,
    seeds: x.seeds, peers: x.peers, seedsTotal: x.seedsTotal || 0, peersTotal: x.peersTotal || 0,
    label: x.label || '', message: x.message || '', dir: x.dir || '',
    complete: !!x.complete,
    stopped: !x.state || !x.active,
    progress,
    eta: x.left > 0 && x.down > 0 ? Math.floor(x.left / x.down) : -1,
    seedSecs: 0,
    status,
  };
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const str = (v) => (typeof v === 'string' ? v : '');
const pos = (v) => Math.max(0, num(v));

module.exports = { request, basicAuth, cookieFrom, Serial, compute, num, str, pos, t };
