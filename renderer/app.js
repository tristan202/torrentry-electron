// Appens logik bag brugerfladen: servere, adgangskoder, klienter og hentning.
// Svarer til main.js i Electron-versionen og stiller det samme `api` til
// rådighed for renderer.js. Rust-siden (src-tauri) står for HTTP, filer og
// Windows' legitimationsadministrator.
/* global I18N */
import * as backends from './backends/index.js';

const { invoke } = window.__TAURI__.core;
const t = (k, v) => I18N.t(k, v);

// ---------- Lager (i %APPDATA%\Torrentry, samme mappe som før) ----------
const SERVERS = 'Torrentry/servers.v3.json'; // 2.x's servers.json røres ikke
const PREFS = 'Torrentry/prefs.json';
async function readJson(rel, fallback) {
  try { return JSON.parse(((await invoke('read_data', { rel })) ?? '').replace(/^﻿/, '')); } catch { return fallback; }
}
const writeJson = (rel, data) => invoke('write_data', { rel, text: JSON.stringify(data, null, 2) });
const readPrefs = () => readJson(PREFS, {});
const writePrefs = async (p) => writeJson(PREFS, { ...(await readPrefs()), ...p });
const readServers = () => readJson(SERVERS, []);
const writeServers = (s) => writeJson(SERVERS, s);

const getPass = async (id) => (await invoke('secret_get', { id })) || '';
const setPass = (id, pass) => invoke('secret_set', { id, pass });
const sanitize = async (s) => ({ ...s, hasPassword: !!(await getPass(s.id)) });

// Første start: hent serverne fra 2.x (servers.json, adgangskoder dekrypteres)
// eller ellers fra PureBasic-versionens servers.ini
async function migrate() {
  if ((await invoke('read_data', { rel: SERVERS })) != null) return;
  const old = await readJson('Torrentry/servers.json', null);
  if (Array.isArray(old)) {
    const pw = await invoke('electron_decrypt', { blobs: old.map((s) => s.pass || '') });
    for (const [i, s] of old.entries()) if (pw[i]) await setPass(s.id, pw[i]);
    await writeServers(old.map(({ pass, ...s }) => s));
    return;
  }
  for (const rel of ['Torrentry/servers.ini', 'rTorrentRemote/servers.ini']) {
    const text = await invoke('read_data', { rel });
    if (text != null) return importIni(text);
  }
}
async function importIni(text) {
  const ini = {};
  let sec = '';
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const s = line.match(/^\s*\[(.+)\]\s*$/);
    if (s) { sec = s[1]; ini[sec] = {}; continue; }
    const kv = line.match(/^\s*([^=;]+?)\s*=\s*(.*?)\s*$/);
    if (kv && sec) ini[sec][kv[1]] = kv[2];
  }
  // Den gamle tilsløring: hvert tegn som 4 hex-cifre
  const obfDec = (h) => (h.match(/.{4}/g) || []).map((x) => String.fromCharCode(parseInt(x, 16))).join('');
  const servers = [];
  for (let i = 0; i < (Number(ini.General?.Count) || 0); i++) {
    const g = ini['Server' + i];
    if (!g) continue;
    const s = { id: crypto.randomUUID(), name: g.Name || '', type: backends.typeKey(g.Type), url: g.Url || '', user: g.User || '', noSSL: g.NoSSL === '1' };
    await setPass(s.id, obfDec(g.Pass || ''));
    servers.push(s);
  }
  await writeServers(servers);
  const sel = servers[Number(ini.General?.Selected) || 0];
  const lang = String(ini.View?.Language || '').toLowerCase();
  await writePrefs({ selected: sel ? sel.id : null, ...(I18N.LANGS[lang] ? { lang } : {}) });
}

function fromInput(input) {
  const type = backends.typeKey(input.type);
  const s = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || '').trim(),
    type,
    url: backends.normalizeUrl(type, input.url),
    user: backends.TYPES[type].passOnly ? '' : String(input.user || ''),
    noSSL: !!input.noSSL,
  };
  if (!s.name || !/^https?:\/\/./i.test(s.url)) throw new Error(t('MsgFillNameUrl'));
  return s;
}

// Én klient pr. server, så login/session-id genbruges mellem kaldene
const clients = new Map();
async function client(id) {
  if (!clients.has(id)) {
    const s = (await readServers()).find((x) => x.id === id);
    if (!s) throw new Error(t('MsgNoServer'));
    clients.set(id, backends.create({ ...s, pass: await getPass(id) }));
  }
  return clients.get(id);
}

// Filvælger til .torrent-filer; giver [] hvis den lukkes uden valg
function pickFiles() {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.torrent' });
    inp.onchange = () => resolve([...inp.files]);
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

// Svar som { value } eller { error }, ligesom IPC'en i Electron-versionen
const wrap = (fn) => async (...args) => {
  try { return { value: await fn(...args) }; } catch (e) { return { error: String(e?.message || e) }; }
};

const ready = migrate();

window.api = {
  info: wrap(async () => {
    await ready;
    const p = await readPrefs();
    return {
      version: await window.__TAURI__.app.getVersion(),
      canEncrypt: true,
      lang: p.lang || I18N.detect(navigator.language),
      selected: p.selected || null,
      types: Object.fromEntries(Object.entries(backends.TYPES).map(([k, v]) => [k, { name: v.name, example: v.example, passOnly: v.passOnly }])),
    };
  }),
  setLang: wrap((l) => writePrefs({ lang: l })),
  setSelected: wrap((id) => writePrefs({ selected: id })),

  listServers: wrap(async () => Promise.all((await readServers()).map(sanitize))),
  saveServer: wrap(async (input) => {
    const list = await readServers();
    const s = fromInput(input);
    if (input.pass) await setPass(s.id, input.pass);
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = s; else list.push(s);
    await writeServers(list);
    clients.delete(s.id);
    return sanitize(s);
  }),
  deleteServer: wrap(async (id) => {
    await writeServers((await readServers()).filter((s) => s.id !== id));
    await setPass(id, '');
    clients.delete(id);
  }),
  // Tester med felterne fra formularen; er adgangskoden tom, bruges den gemte
  testServer: wrap(async (input) => {
    const s = fromInput(input);
    return backends.create({ ...s, pass: input.pass || (input.id ? await getPass(input.id) : '') }).test();
  }),

  // Listen og (hvis en torrent er valgt) den åbne detaljefane i ét kald
  poll: wrap(async (id, det) => {
    const c = await client(id);
    const torrents = await c.list();
    let details = null, detailsError = null;
    if (det && det.kind && det.hash) {
      try { details = await c.details(det.kind, det.hash); } catch (e) { detailsError = String(e.message || e); }
    }
    return { torrents, details, detailsError };
  }),
  action: wrap(async (id, act, hashes) => (await client(id)).action(act, hashes)),
  remove: wrap(async (id, hashes, withData) => (await client(id)).remove(hashes, withData)),

  // .torrent-filer som File-objekter; uden filer vises en filvælger
  addFiles: wrap(async (id, files, opts = {}) => {
    files ??= await pickFiles();
    const c = await client(id);
    let added = 0;
    const errors = [];
    for (const f of files) {
      try {
        if (f.size <= 0 || f.size > 30e6) throw new Error(t('MsgBadSize', { x: f.name }));
        await c.addFile(new Uint8Array(await f.arrayBuffer()), opts.start !== false, opts.dir || '');
        added++;
      } catch (e) {
        errors.push(t('MsgCouldNotAdd', { x: f.name }) + ' ' + e.message);
      }
    }
    return { added, errors };
  }),
  // Magnet-links og http(s)-links, ét pr. linje
  addUrls: wrap(async (id, text, opts = {}) => {
    const c = await client(id);
    let added = 0;
    const errors = [];
    for (const ln of String(text || '').split(/\r?\n|\r/).map((s) => s.trim())) {
      if (!/^(magnet:|https?:)/i.test(ln)) continue;
      try { await c.addUrl(ln, opts.start !== false, opts.dir || ''); added++; } catch (e) { errors.push(t('MsgAddError', { x: e.message })); }
    }
    return { added, errors };
  }),
};
