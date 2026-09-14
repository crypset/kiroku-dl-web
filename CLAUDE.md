# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Kiroku is a media downloader engine. It downloads content from many
different websites/services, each handled by its own pluggable module.
An orchestrator drives the generic download loop (pagination, delays,
concurrency, retry/skip behavior); modules only implement the
site-specific parts.

Everything user-facing is controlled by `config.json` (see
`config.example.json` for the shape) — `src/config/app.config.js` is the
single place that reads it; nothing else should hardcode a path or read
`config.json`/env vars directly. Downloaded files go into `downloads/`.
Runtime state (SQLite DB, JSON backups, and eventually session data like
cookies/tokens) lives in `data/`, which is gitignored — that kind of
per-source runtime state does NOT belong in `config.json`.

## Architecture

```
src/
  index.js                          entry point (CLI commands: download, backup:export, backup:import)
  config/app.config.js              loadConfig() - reads config.json, merges defaults, validates
                                     also exports DATA_DIR / DEFAULT_DB_STORAGE constants
  core/
    orchestrator/
      download.orchestrator.js      generic run loop: pagination, delays, concurrency, skip-logic
      module.resolver.js            registry: registerModule() / resolveModule(url)
    modules/
      base.downloader.js            BaseDownloader - the contract every module implements
    teapot/                         "teapot" = the database layer
      sqlite/sqlite_db.js           Sequelize instance + initializeDatabase()/closeDatabase()
      models/index.js               DownloadedItem model (searchName + itemId, unique)
      backup/downloaded_item.backup.js   export/import DownloadedItem table to/from JSON
  modules/
    index.js                        barrel: import every real module here to register it
    bepisdb/
      bepisdb.downloader.js         db.bepis.moe - the reference implementation
      bepisdb.types.js              that site's card-type map, search params, naming rules
    _template/template.downloader.js   copy this to scaffold a new module
  shared/
    utils.js                        print/banner/sleep/jitter/retry/saveToJson/sanitizeName/base64ToHex
    download-path.js                 buildItemPath()/metaPathFor() - downloads/<search>/<item> layout
    http.client.js                   axios client + getJson/postForm + validating downloadToFile()
    query.params.js                  parseSourceUrl()/pickParams() - URL and query-string handling
tools/
  config-editor/
    config.editor.js                zero-dependency local server (`npm run config`)
    config.editor.html              the editor page itself (single file, no CDN)
```

### Module contract

A module extends `BaseDownloader` (`src/core/modules/base.downloader.js`)
and implements:

- `fetchPage(pageNumber)` - fetch raw page data for a 1-based page number
- `parseItems(pageData)` - parse raw page data into `[{ id, title, url, ... }]`
- `downloadItem(item)` - download one item, return the saved file path
- `getItemId(item)` (optional) - stable id for skip-downloaded checks, defaults to `item.id ?? item.url`
- `hasNextPage(pageData, items)` (optional) - defaults to "stop when a page returns no items"

`BaseDownloader` also *provides* the plumbing every module would otherwise
rewrite, so a new module doesn't touch axios or fs directly:
`this.http`, `this.getJson()`, `this.postForm()`, `this.downloadToFile()`,
`this.resolveItemPath()`, `this.option()` and `this.hasNextPageByTotal()`.
The real code lives in `src/shared/http.client.js` and
`src/shared/query.params.js` — if something you need in a module isn't
specific to one site, it belongs there, not in the module.

`downloadToFile()` streams to a `.part` file and only renames it once the
response passes: status 200, a `content-type` that isn't an HTML error page,
and the expected size/sha256 when given. Never stream a response straight to
its final path - a site's 404 page saved as a `.png` is the classic failure.

The orchestrator owns pagination, `delay`/`pageDelay`/`searchDelay`,
`maxConcurrent` worker pool, `skipErrors`, `retries`/`retryDelay` (each
`fetchPage`/`downloadItem` call is retried on failure before `skipErrors`
kicks in), the already-downloaded check against the database, failure
isolation, and graceful shutdown (an `AbortSignal` passed into the
orchestrator, aborted on SIGINT/SIGTERM in `src/index.js` — in-flight items
finish, no new page/item/search is started). Modules should stay focused on
talking to their specific site/service and not reimplement any of that.

Every call into module code is wrapped by the orchestrator, so with
`skipErrors: true` a throw from `fetchPage`, `parseItems`, `getItemId`,
`hasNextPage`, `downloadItem` or a module constructor is reported and
contained: one broken item never stops its search, and one broken source
never stops the others. Keep it that way — if you add a new call into a
module, wrap it too (see "Failure isolation" in docs/ARCHITECTURE.md).

To add a new module: copy `src/modules/_template/` to
`src/modules/<service-name>/`, implement the three required methods, and
add an import for it in `src/modules/index.js` (registration happens as an
import side effect via `registerModule()`).

### Downloads layout

`downloads/<searchName>/<sanitized item name>_<timestamp>.<ext>` plus a
sidecar `<same basename>.meta.json` (title, url, itemId, searchName, group,
downloadedAt), written automatically by the orchestrator after every
successful download. The search name is the primary axis so everything
from one source stays together; the timestamp suffix (filesystem-safe,
e.g. `2015-03-25_12-00-00`, see `formatTimestamp` in
`shared/download-path.js`) is what stops two items with the same title
from overwriting each other on disk.

A search may set an optional `group`, which adds one folder above the
search name: `downloads/<group>/<searchName>/...`. `buildItemPath()` in
`shared/download-path.js` is the only place that decides this - modules get
it for free through `resolveItemPath()` and must not join paths themselves.
`sanitizeName()` strips separators, so a group can only ever add a single
level and cannot escape the download directory.

A group is a disk-layout concern only: the already-downloaded check is keyed
on `searchName` + `itemId`, so moving a search into a group (or renaming the
group) does not make Kiroku re-fetch anything. Renaming the *search* does.

### Database

SQLite via Sequelize, file at `data/pot.sqlite` (path comes from
`DEFAULT_DB_STORAGE` in `app.config.js`, not hardcoded in `sqlite_db.js`).
The `DownloadedItem` table (`searchName` + `itemId`, unique) is the source
of truth for "already downloaded" - the orchestrator checks it before
downloading and records a row after. File paths on disk are
secondary/informational.

### Config editor

`npm run config` starts a local, dependency-free web UI for editing
`config.json` at http://127.0.0.1:5174 (`--port N` / `--open` to open a
browser; the port is also read from `KIROKU_CONFIG_EDITOR_PORT`). It is a
tool around the config file, not a second source of truth:

- it reads and writes the path `CONFIG_PATH` in `app.config.js` exports, and
  shows `DEFAULTS` from the same file as placeholders, so no key list is
  duplicated in the UI,
- a save is validated by running the app's own `loadConfig()` against the
  candidate first - the editor cannot write a config `npm start` would reject,
- the previous file is copied to `data/config-backups/` (last 20 kept) on
  every save,
- `POST /api/resolve-url` asks the real `resolveModule()` whether a search URL
  is handled by a module, which is what the per-search badge shows. Nothing is
  fetched from the network.

Groups have first-class support in the UI: searches are drawn under collapsible
group headers (a collapsed group builds no cards at all), a search can be moved
between groups by dropping its card on a header, and a group can be renamed or
dissolved across every search in it at once. Typing in the name/URL/group inputs
only re-renders the card header - re-rendering the list under a focused input
would take the focus with it, which is a bug worth not reintroducing.

The server binds to `127.0.0.1` only and requires an `x-kiroku-editor` header
on writes, so another page in the browser cannot drive it. Keys the form does
not model (unknown top-level keys, unknown per-search keys) are preserved
verbatim - adding a config key does not require touching the editor, though
adding it to `GLOBAL_SECTIONS` / `OPTION_HINTS` in the HTML gives it a proper
field.

## Conventions

- ESM (`"type": "module"`) throughout, Node 22.
- All code, comments, and commit messages: English.
- File naming follows the existing `word.word.js` style
  (`download.orchestrator.js`, `module.resolver.js`, `base.downloader.js`).
- Logging goes through `print(text, type)` from `shared/utils.js`
  (types: `info`, `system`, `data`, `warning`, `success`, `debug`, `error`) -
  don't use raw `console.log` for user-facing output.
- `config.json` is gitignored (local/machine-specific); keep
  `config.example.json` in sync with any new config keys you introduce.
- Module-specific per-search settings go under `searches[].options` and are
  read with `this.option(key, fallback)`; the generic keys (`name`, `url`,
  `group`, `skipDownloaded`) stay at the top level.
- Anything a module puts on an item's `metadata` field lands in that item's
  `.meta.json` sidecar - one file per download, no second sidecar.
- This project is not anime-specific - avoid anime-flavored naming in
  shared/core code (model, folder, and variable names should read as
  generic "item"/"media", not "episode").

## Status

One real module is implemented and smoke-tested end to end: `bepisdb`
(db.bepis.moe) - single card by URL, tag/uploader searches with pagination,
skip-downloaded on re-runs, sha256 verification, backup export. The shared
HTTP/query layer was built alongside it, so the next module should be mostly
site-specific code.

No Playwright/browser-automation dependency; add one only when a module
actually needs it to get past a site's protections (bepisdb doesn't - its
API answers plain HTTP requests).

## Commands

```bash
npm start                 # runs `node src/index.js` -> download command
node src/index.js download
node src/index.js backup:export
node src/index.js backup:import [--clean|-c]

npm run config             # config.json editor at http://127.0.0.1:5174
npm run config -- --open   # ...and open it in a browser
```

No test suite yet.
