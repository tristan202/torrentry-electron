const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Alle kald giver { value } eller { error } tilbage (se handle() i main.js)
const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  setLang: (l) => call('app:setLang', l),
  setSelected: (id) => call('app:setSelected', id),

  listServers: () => call('servers:list'),
  saveServer: (s) => call('servers:save', s),
  deleteServer: (id) => call('servers:delete', id),
  testServer: (s) => call('servers:test', s),

  poll: (id, det) => call('torrents:poll', id, det),
  action: (id, act, hashes) => call('torrents:action', id, act, hashes),
  remove: (id, hashes, withData) => call('torrents:remove', id, hashes, withData),
  addFiles: (id, paths, opts) => call('torrents:addFiles', id, paths, opts),
  addUrls: (id, text, opts) => call('torrents:addUrls', id, text, opts),

  pathForFile: (file) => webUtils.getPathForFile(file), // filer trukket ind fra Stifinder
});
