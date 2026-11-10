# Torrentry

A remote control for rTorrent, qBittorrent, Transmission and Deluge. Built with [Tauri](https://tauri.app) and shares its look with [Skal](../Skal). Version 3 replaces the Electron-based 2.x, which replaced the original PureBasic version.

## Getting started

Requires Node.js 18 or newer, Rust, and on Windows the Visual Studio C++ build tools.

```
npm install
npm start
```

Build the Windows installer (ends up in `src-tauri/target/release/bundle/nsis/`):

```
npm run dist
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
- Passwords are stored in Windows Credential Manager.
- 7 languages: Danish, English, German, French, Italian, Spanish and Swedish.

On first start, servers, passwords and language are taken from 2.x (`%APPDATA%\Torrentry\servers.json`), or else from the PureBasic version's `servers.ini`. The old files are left untouched, so 2.x keeps working.

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

- `src-tauri/` – the Rust side: HTTP requests, files in `%APPDATA%\Torrentry`, passwords, and reading 2.x's encrypted passwords
- `renderer/app.js` – servers, migration and polling (the `api` the interface uses)
- `renderer/backends/` – one file per client, all with the same methods (see `common.js`)
- `renderer/renderer.js` – the user interface; `strings.js` holds all texts
