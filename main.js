const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const I18N = require('./renderer/strings.js');
const backends = require('./backends');
const t = I18N.t;

let win;

// ---------- Lager ----------
const dataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const readPrefs = () => readJson(dataFile('prefs.json'), {});
const writePrefs = (p) => writeJson(dataFile('prefs.json'), { ...readPrefs(), ...p });
const readServers = () => readJson(dataFile('servers.json'), []);
const writeServers = (s) => writeJson(dataFile('servers.json'), s);

// Adgangskoder krypteres med OS'ets nøglering (DPAPI / Keychain / libsecret).
// Er det ikke tilgængeligt, gemmes de slet ikke.
function enc(s) {
  if (!s || !safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.encryptString(s).toString('base64');
}
function dec(s) {
  if (!s) return '';
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
}
function sanitize(s) {
  const { pass, ...rest } = s;
  return { ...rest, hasPassword: !!pass };
}

// Første start: hent serverne fra PureBasic-versionens servers.ini, hvis den findes
function importFromIni() {
  if (fs.existsSync(dataFile('servers.json'))) return;
  const candidates = [
    path.join(app.getPath('appData'), 'Torrentry', 'servers.ini'),
    path.join(app.getPath('appData'), 'rTorrentRemote', 'servers.ini'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  const ini = {};
  let sec = '';
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const s = line.match(/^\s*\[(.+)\]\s*$/);
    if (s) { sec = s[1]; ini[sec] = {}; continue; }
    const kv = line.match(/^\s*([^=;]+?)\s*=\s*(.*?)\s*$/);
    if (kv && sec) ini[sec][kv[1]] = kv[2];
  }
  // Den gamle tilsløring: hvert tegn som 4 hex-cifre
  const obfDec = (h) => (h.match(/.{4}/g) || []).map((x) => String.fromCharCode(parseInt(x, 16))).join('');
  const n = Number(ini.General?.Count) || 0;
  const servers = [];
  for (let i = 0; i < n; i++) {
    const g = ini['Server' + i];
    if (!g) continue;
    servers.push({
      id: crypto.randomUUID(), name: g.Name || '', type: backends.typeKey(g.Type),
      url: g.Url || '', user: g.User || '', pass: enc(obfDec(g.Pass || '')), noSSL: g.NoSSL === '1',
    });
  }
  writeServers(servers);
  const sel = servers[Number(ini.General?.Selected) || 0];
  const lang = String(ini.View?.Language || '').toLowerCase();
  writePrefs({ selected: sel ? sel.id : null, ...(I18N.LANGS[lang] ? { lang } : {}) });
}

// ---------- Vindue ----------
function createWindow() {
  const b = readPrefs().window || {};
  const onScreen = b.width && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 40 >= a.x && b.x + 40 < a.x + a.width && b.y + 20 >= a.y && b.y + 20 < a.y + a.height;
  });
  // Standardstørrelsen er bred nok til alle standardkolonnerne, hvis skærmen er
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, wa.width), height: Math.min(880, wa.height), minWidth: 900, minHeight: 520,
    ...(onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : {}),
    backgroundColor: '#171a26',
    autoHideMenuBar: true,
    title: `Torrentry ${app.getVersion()}`,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    show: false, // vis først når siden er tegnet – ingen hvid/tom ramme
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => { if (b.maximized) win.maximize(); win.show(); });
  // Behold versionsnummeret i titellinjen (ellers overskriver sidens <title> det)
  win.on('page-title-updated', (e) => e.preventDefault());
  // Husk den normale position/størrelse, også når vinduet er maksimeret
  win.on('close', () => writePrefs({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } }));
  // En fil, der slippes uden for drop-zonen, må ikke åbnes som side
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Kun én instans ad gangen – en ny start henter det kørende vindue frem
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    const prefs = readPrefs();
    I18N.setLang(prefs.lang || I18N.detect(app.getLocale()));
    importFromIni();
    // Electrons standardmenu har genveje som Ctrl+R (genindlæs) og Ctrl+W (luk vindue)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// Svar til brugerfladen som { value } eller { error }, så fejlteksten kommer
// igennem uden Electrons "Error invoking remote method"-præfiks
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
  try { return { value: await fn(...args) }; } catch (e) { return { error: String(e?.message || e) }; }
});

// ---------- App ----------
handle('app:info', () => {
  const p = readPrefs();
  return {
    version: app.getVersion(),
    canEncrypt: safeStorage.isEncryptionAvailable(),
    lang: p.lang || I18N.detect(app.getLocale()),
    selected: p.selected || null,
    types: Object.fromEntries(Object.entries(backends.TYPES).map(([k, v]) => [k, { name: v.name, example: v.example, passOnly: v.passOnly }])),
  };
});
// Brugerfladen fortæller hvilket sprog der er valgt, så fejl fra klienterne følger med
handle('app:setLang', (l) => { I18N.setLang(l); writePrefs({ lang: I18N.lang }); return I18N.lang; });
handle('app:setSelected', (id) => writePrefs({ selected: id }));

// ---------- Servere ----------
handle('servers:list', () => readServers().map(sanitize));

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

handle('servers:save', (input) => {
  const list = readServers();
  const i = list.findIndex((s) => s.id === input.id);
  const prev = i >= 0 ? list[i] : {};
  const s = fromInput(input);
  s.pass = input.pass ? enc(input.pass) : prev.pass || '';
  if (i >= 0) list[i] = s; else list.push(s);
  writeServers(list);
  dropClient(s.id);
  return sanitize(s);
});

handle('servers:delete', (id) => {
  writeServers(readServers().filter((s) => s.id !== id));
  dropClient(id);
});

// Tester med felterne fra formularen; er adgangskoden tom, bruges den gemte
handle('servers:test', async (input) => {
  const prev = readServers().find((s) => s.id === input.id) || {};
  const s = fromInput(input);
  s.pass = input.pass || dec(prev.pass);
  return backends.create(s).test();
});

// ---------- Torrents ----------
// Én klient pr. server, så login/session-id genbruges mellem kaldene
const clients = new Map();
function dropClient(id) { clients.delete(id); }
function client(id) {
  if (!clients.has(id)) {
    const s = readServers().find((x) => x.id === id);
    if (!s) throw new Error(t('MsgNoServer'));
    clients.set(id, backends.create({ ...s, pass: dec(s.pass) }));
  }
  return clients.get(id);
}

// Listen og (hvis en torrent er valgt) den åbne detaljefane i ét kald
handle('torrents:poll', async (id, det) => {
  const c = client(id);
  const torrents = await c.list();
  let details = null, detailsError = null;
  if (det && det.kind && det.hash) {
    try { details = await c.details(det.kind, det.hash); } catch (e) { detailsError = String(e.message || e); }
  }
  return { torrents, details, detailsError };
});

handle('torrents:action', (id, act, hashes) => client(id).action(act, hashes));
handle('torrents:remove', (id, hashes, withData) => client(id).remove(hashes, withData));

// Tilføjer .torrent-filer. Uden stier vises en filvælger.
handle('torrents:addFiles', async (id, paths, opts = {}) => {
  if (!paths) {
    const r = await dialog.showOpenDialog(win, {
      title: t('DlgSelectFiles'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('FilterTorrents'), extensions: ['torrent'] }, { name: t('FilterAll'), extensions: ['*'] }],
    });
    if (r.canceled) return { added: 0, errors: [] };
    paths = r.filePaths;
  }
  const c = client(id);
  let added = 0;
  const errors = [];
  for (const p of paths) {
    const name = path.basename(p);
    try {
      const st = fs.statSync(p);
      if (st.size <= 0 || st.size > 30e6) throw new Error(t('MsgBadSize', { x: name }));
      await c.addFile(fs.readFileSync(p), opts.start !== false, opts.dir || '');
      added++;
    } catch (e) {
      errors.push(t('MsgCouldNotAdd', { x: name }) + ' ' + (e.code === 'ENOENT' ? t('MsgCantOpen') : e.message));
    }
  }
  return { added, errors };
});

// Magnet-links og http(s)-links, ét pr. linje
handle('torrents:addUrls', async (id, text, opts = {}) => {
  const c = client(id);
  let added = 0;
  const errors = [];
  for (const ln of String(text || '').split(/\r?\n|\r/).map((s) => s.trim())) {
    if (!/^(magnet:|https?:)/i.test(ln)) continue;
    try { await c.addUrl(ln, opts.start !== false, opts.dir || ''); added++; } catch (e) { errors.push(t('MsgAddError', { x: e.message })); }
  }
  return { added, errors };
});
