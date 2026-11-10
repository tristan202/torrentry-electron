// Klienttyperne. Nøglen er den, der gemmes som "type" i servers.json (og
// "Type" i den gamle servers.ini).
import RTorrent from './rtorrent.js';
import QBittorrent from './qbittorrent.js';
import Transmission from './transmission.js';
import Deluge from './deluge.js';

export const TYPES = {
  rtorrent: { name: 'rTorrent (XML-RPC)', cls: RTorrent, example: '/RPC2', passOnly: false },
  qbittorrent: { name: 'qBittorrent', cls: QBittorrent, example: '/qbittorrent', passOnly: false },
  transmission: { name: 'Transmission', cls: Transmission, example: '/transmission/rpc', passOnly: false },
  deluge: { name: 'Deluge (Web UI)', cls: Deluge, example: '/deluge', passOnly: true },
};

export const typeKey = (k) => (TYPES[String(k || '').toLowerCase()] ? String(k).toLowerCase() : 'rtorrent');
export const create = (server) => new TYPES[typeKey(server.type)].cls({
  url: server.url, user: server.user || '', pass: server.pass || '', insecure: !!server.noSSL,
});
export const normalizeUrl = (type, url) => TYPES[typeKey(type)].cls.normalizeUrl(url);

