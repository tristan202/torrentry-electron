# Torrentry

A remote control for rTorrent, qBittorrent, Transmission and Deluge. Built with Electron and shares its look with [Skal](../Skal). Version 2 replaces the original PureBasic version.

## Getting started

Requires Node.js 18 or newer.

```
npm install
npm start
```

Build an installable app:

```
npm run dist:win        # Windows installer (recommended)
npm run dist:zip        # Windows: zip that can be extracted and run directly
npm run dist:portable   # Windows: a single portable .exe (starts slowly)
npm run dist            # current platform
```

## Features

- Several servers in the sidebar; click one to switch. rTorrent (XML-RPC), qBittorrent (WebUI API v2), Transmission (RPC) and Deluge (Web UI) are supported.
- Torrent list with sortable, resizable columns. Right-click a column header to show or hide columns.
- Seeds and peers show the swarm total in parentheses, e.g. `3 (120)`, which hints whether a torrent is dead. Sorting uses the connected number.
- Filters with counts: all, downloading, seeding, completed, stopped, active, inactive, error. Search by name.
- Details for the selected torrent: general info, trackers, peers and files.
- Add .torrent files (Ctrl+O, or drag them onto the window) and magnet links (Ctrl+U, drag, or paste anywhere).
- Start, stop, recheck, remove, or remove with data (with confirmation).
- Test connection from the server editor or the error banner.
- Passwords are encrypted with the operating system's keyring (DPAPI on Windows).
- 7 languages: Danish, English, German, French, Italian, Spanish and Swedish.

On first start, servers and language are imported from the PureBasic version's `%APPDATA%\Torrentry\servers.ini` (or the older `rTorrentRemote` folder). The ini file is left untouched.

| Key | Action |
|---|---|
| Ctrl+O | Add .torrent files |
| Ctrl+U | Add magnet links |
| F5 | Refresh now |
| Ctrl+F | Search |
| Ctrl+B | Show/hide sidebar |
| Ctrl+A, arrows, Shift/Ctrl+click | Select torrents |
| Right-click | Torrent actions |

## Layout

- `main.js` – window, storage (`servers.json`, `prefs.json` in the user data folder) and IPC
- `backends/` – one file per client, all with the same methods (see `backends/common.js`)
- `renderer/` – the user interface; `strings.js` holds all texts
