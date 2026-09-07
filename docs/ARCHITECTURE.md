# Architecture

## Goal

Kiroku downloads media from many different websites/services. Each source
is different (pagination, auth, item formats, rate limits), but the
orchestration around it — walking pages, spacing out requests, running a
bounded number of downloads at once, skipping what's already downloaded,
and recording results — is the same every time.

The design splits that in two:

- **Orchestrator** (`src/core/orchestrator/`) — owns the generic loop.
  Knows nothing about any specific website.
- **Modules** (`src/modules/`) — one per service. Know nothing about
  pagination timing, concurrency, or the database; they only answer
  "what's on this page" and "how do I save this item."

A module is matched to a `config.json` search entry by URL, at runtime,
through a registry.

## Request flow

```
config.json
    │
    ▼
loadConfig()  ──────────────────────────────  src/config/app.config.js
    │  (validated config: app / download / database / searches[])
    ▼
DownloadOrchestrator.run()  ────────────────  src/core/orchestrator/download.orchestrator.js
    │
    │  for each entry in config.searches:
    │
    ├─▶ resolveModule(search.url) ──────────  src/core/orchestrator/module.resolver.js
    │       │  looks up the registry built by importing src/modules/index.js
    │       ▼
    │   an instance of a BaseDownloader subclass, or null
    │
    ├─▶ loop pages (stops early if the shutdown signal fires):
    │     downloader.fetchPage(page)          ─▶ retried up to `download.retries` times
    │     downloader.parseItems(pageData)  ─▶ [{ id, title, url, ... }, ...]
    │     downloader.hasNextPage(pageData, items)
    │     (sleep `download.pageDelay` between pages)
    │
    ├─▶ for each item (up to `download.maxConcurrent` at a time):
    │     skip if already in DownloadedItem table and skipDownloaded is on
    │     downloader.downloadItem(item)  ─▶ saved file path  (retried like fetchPage)
    │     write <file>.meta.json sidecar
    │     record { searchName, itemId, title, url, filePath } in DB
    │     (sleep `download.delay` between downloads)
    │
    └─▶ (sleep `download.searchDelay` between searches)
```

Errors during a page fetch or a single download are retried up to
`download.retries` times (with `download.retryDelay` between attempts)
before being treated as a failure; at that point `download.skipErrors`
decides whether the orchestrator logs and continues or aborts the whole run.

### Failure isolation

With `skipErrors: true` (the default), a failure is contained at the
narrowest level that still makes sense, and nothing above it is affected:

| Where it breaks | What survives |
|---|---|
| One item (`downloadItem`, metadata write, DB write) | The rest of the page, the rest of the search, every other search |
| `getItemId()` on one item | Same — that item is skipped |
| `fetchPage()` / `parseItems()` | The pages already downloaded; the search stops, other searches run |
| `hasNextPage()` | Everything already downloaded, including the current page; the search stops there |
| The module's constructor (a bad URL in config) | The search is skipped before it starts; other searches run |
| Anything unanticipated inside a search | Caught by the loop in `run()`, reported, next search starts |

In other words: one broken source cannot take the others down, and one
broken item cannot take its source down. Every call into module code is
wrapped, because a module is the part most likely to break when a site
changes underneath it.

`skipErrors: false` deliberately inverts this — the first failure that
survives its retries aborts the whole run, which is the point of the flag.

### Graceful shutdown

`src/index.js` creates an `AbortController` and passes its `signal` into
`DownloadOrchestrator`. On `SIGINT`/`SIGTERM` it calls `abort()` (a second
signal forces an immediate `process.exit`). The orchestrator checks
`signal.aborted` between searches, between pages, and before picking up
the next item off a worker's queue — an item that's already downloading is
allowed to finish, but nothing new is started. This only works from a real
Ctrl+C in the owning console: Windows has no POSIX signals, so
`kill -INT`/`child_process.kill('SIGINT')` won't trigger it there.

## The module contract

`src/core/modules/base.downloader.js` defines `BaseDownloader`. A concrete
module extends it and implements:

| Method | Required | Purpose |
|---|---|---|
| `fetchPage(pageNumber)` | yes | Fetch raw page data (HTML, JSON, ...) for a 1-based page number |
| `parseItems(pageData)` | yes | Turn raw page data into `[{ id, title, url, ... }]` |
| `downloadItem(item)` | yes | Save one item to disk, return the file path |
| `getItemId(item)` | no | Stable id for the skip-downloaded check (default: `item.id ?? item.url`) |
| `hasNextPage(pageData, items)` | no | Whether to fetch another page (default: stop on an empty page) |
| `resolveItemPath(item, ext)` | provided | Returns the standard `downloads/<search>/<item>` path — use it or build your own, the orchestrator only cares about the returned `filePath` |

`parseItems()` may put anything source-specific on an item's `metadata`
field; the orchestrator writes it into that item's `.meta.json` sidecar.

### Provided plumbing

Fetching over HTTP, streaming a file to disk without keeping a corrupt one,
and reading per-search settings are the same work in every module, so
`BaseDownloader` hands them over rather than letting each module reinvent
them. The implementations live in `src/shared/`; the methods are thin
delegations:

| Helper | Purpose |
|---|---|
| `this.http` | Lazily created axios client with browser-like defaults, configured from this search's `options` |
| `this.getJson(url, params)` | GET + parsed JSON; throws on any non-200 |
| `this.postForm(url, fields)` | POST `multipart/form-data` + parsed JSON |
| `this.downloadToFile(url, filePath, opts)` | Stream to disk, validated (see below) |
| `this.option(key, fallback)` | Read a per-search setting from `searches[].options` |
| `this.hasNextPageByTotal({ page, pageSize, total })` | Pagination when the API reports a total, `maxPages` applied |

`downloadToFile()` (`src/shared/http.client.js`) writes to `<filePath>.part`
and renames only once the response passes: HTTP 200, a `content-type` that
isn't an HTML error page, and — when the caller supplies them — the expected
size and sha256, hashed as the bytes stream past. On any failure the `.part`
file is removed. The guard matters: sites routinely answer a missing file
with 404 *and an HTML body*, which a naive stream would save as a `.png`.

`src/shared/query.params.js` covers the other recurring shape — a source URL
that carries the search itself. `parseSourceUrl()` splits it into host, path
segments and query; `pickParams()` whitelists that query against a declared
schema and converts each value to its type, handing back unknown and
unusable keys so the module can warn instead of silently downloading the
wrong thing.

A module registers itself as a side effect of being imported:

```js
// src/modules/<service>/<service>.downloader.js
import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";

export class ServiceDownloader extends BaseDownloader {
  async fetchPage(pageNumber) { /* ... */ }
  async parseItems(pageData)  { /* ... */ }
  async downloadItem(item)    { /* ... */ }
}

registerModule(
  (url) => url.includes("service.example"),
  (searchConfig, appConfig) => new ServiceDownloader(searchConfig, appConfig),
);
```

...and gets picked up once it's imported from `src/modules/index.js`. There
is no filesystem auto-discovery on purpose — an explicit import list keeps
it obvious which modules are active. `src/modules/_template/` is a
non-registered reference copy to start a new module from.

Nothing in the contract assumes plain HTTP requests. `fetchPage` can be
backed by `axios`, or later by a headless browser (Playwright) for
sources that need it — the orchestrator doesn't care how a module gets
its data.

## Config

`config.json` (gitignored; `config.example.json` is the tracked template):

```json
{
  "app": { "downloadDir": "downloads" },
  "download": {
    "delay": 4000,
    "pageDelay": 4000,
    "searchDelay": 6000,
    "maxConcurrent": 1,
    "skipErrors": true,
    "skipDownloaded": true,
    "useDatabase": true,
    "retries": 2,
    "retryDelay": 2000
  },
  "database": { "enabled": true },
  "searches": [
    { "name": "example", "url": "https://example.com", "skipDownloaded": true }
  ]
}
```

`loadConfig()` (`src/config/app.config.js`) is the *only* place that reads
`config.json` or resolves config-related paths — everything else (the
orchestrator, modules, the DB layer) receives the already-loaded config
object or a constant exported from this same file, never reads
`config.json`/env vars on its own. It merges the file over built-in
defaults and validates that every `searches[]` entry has a `name` and a
`url`. `name` doubles as the download folder name and the database key,
so it should be unique across entries. A per-search `skipDownloaded: false`
overrides the global default for just that entry.

Anything module-specific goes in a per-search `options` object, keeping it
clear of the generic keys:

```json
{
  "name": "bepisdb-twintails",
  "url": "https://db.bepis.moe/koikatsu?tags=twintails&orderType=leastRecent",
  "options": { "maxPages": 2, "verifyHash": true, "countDownload": false }
}
```

`loadConfig()` doesn't validate `options` — a module reads its own keys
through `this.option(key, fallback)` and supplies the defaults.

`retries` is the number of *additional* attempts after the first failure
(so `retries: 2` = up to 3 tries total) for both `fetchPage` and
`downloadItem`; `retryDelay` is the fixed wait between attempts.

Per-source runtime state that isn't a user-facing setting — cookies,
auth tokens, pagination cursors a module wants to remember between runs —
does **not** belong in `config.json`. It belongs under `data/` (e.g.
`data/sessions/<searchName>.json`), same as the database: `config.json` is
what the user *chooses*, `data/` is what the app *remembers*.

## Storage

### Downloads directory

```
downloads/<searchName>/<sanitized item name>_<timestamp>.<ext>
downloads/<searchName>/<sanitized item name>_<timestamp>.meta.json
```

Grouped by search, not by date — everything from one source stays
together no matter when it was downloaded. The `<timestamp>` suffix
(filesystem-safe, e.g. `2015-03-25_12-00-00` — see `formatTimestamp` in
`src/shared/download-path.js`) is what keeps two items with the same title
(re-uploads, identically-named episodes across seasons, etc.) from
overwriting each other; it's added automatically by `buildItemPath()` /
`BaseDownloader.resolveItemPath()`, a module doesn't need to think about
it. The `.meta.json` sidecar (`searchName`, `itemId`, `title`, `url`,
`filePath`, `downloadedAt`, plus whatever the module put on `item.metadata`)
is written automatically by the orchestrator, not by the module.

### Database ("teapot")

SQLite via Sequelize, file at `data/pot.sqlite`. The path comes from
`DEFAULT_DB_STORAGE`, exported by `src/config/app.config.js` (not
hardcoded in `sqlite_db.js`) - `data/` is gitignored, nothing in it is
tracked in git.

`DownloadedItem` (`src/core/teapot/models/index.js`), table
`downloaded_items`:

| column | notes |
|---|---|
| `searchName` | from `config.searches[].name` |
| `itemId` | from `downloader.getItemId(item)` |
| `title`, `url`, `filePath` | informational |
| `downloadedAt` | defaults to now |

Unique index on `(searchName, itemId)` — this table is the source of
truth for "already downloaded," checked before every download when
`skipDownloaded` is on. Files on disk are a side effect, not what's
consulted for the skip check.

`src/core/teapot/backup/downloaded_item.backup.js` exports/imports this
table as JSON at `data/backups/downloaded_items.json`, via
`node src/index.js backup:export` / `backup:import [--clean]`.

## Status

The first real module is in. `src/modules/bepisdb/` downloads from
`db.bepis.moe` and has been smoke-tested end to end: a single card by URL, a
tag search walked page by page, the skip-downloaded check on a second run,
sha256 verification against the API's published hashes, and `backup:export`.

Everything it needed that wasn't specific to that site was pushed down into
the shared layer, so the next module starts from `this.getJson()` /
`this.downloadToFile()` rather than from an empty file. `src/modules/_template/`
shows the shape.

No browser automation yet — the site answers plain HTTP requests, so there's
nothing for Playwright to do.
