// Klienttyperne. Nøglen er den, der gemmes som "type" i servers.json (og
// "Type" i den gamle servers.ini).
'use strict';

const TYPES = {
  rtorrent: { name: 'rTorrent (XML-RPC)', cls: require('./rtorrent'), example: '/RPC2', passOnly: false },
  qbittorrent: { name: 'qBittorrent', cls: require('./qbittorrent'), example: '/qbittorrent', passOnly: false },
  transmission: { name: 'Transmission', cls: require('./transmission'), example: '/transmission/rpc', passOnly: false },
  deluge: { name: 'Deluge (Web UI)', cls: require('./deluge'), example: '/deluge', passOnly: true },
};

const typeKey = (k) => (TYPES[String(k || '').toLowerCase()] ? String(k).toLowerCase() : 'rtorrent');
const create = (server) => new TYPES[typeKey(server.type)].cls({
  url: server.url, user: server.user || '', pass: server.pass || '', insecure: !!server.noSSL,
});
const normalizeUrl = (type, url) => TYPES[typeKey(type)].cls.normalizeUrl(url);

module.exports = { TYPES, typeKey, create, normalizeUrl };
