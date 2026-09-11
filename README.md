# kiroku-dl-web

Kiroku is a media downloader engine. Each site/service it supports is a
pluggable module; a shared orchestrator drives the generic download loop
(pagination, delays, concurrency, retries, skip-already-downloaded), so a
module only implements the site-specific parts.

Requires Node 22+.

```bash
npm install
cp config.example.json config.json   # then edit it - see below
npm start
```

Downloads land in `downloads/<search name>/`, each file next to a
`.meta.json` sidecar. Runtime state (the SQLite database, backups) lives in
`data/`. Both are gitignored, as is `config.json` itself.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Runs every search in `config.json` (same as `node src/index.js download`) |
| `npm run config` | Opens the config editor - see below |
| `node src/index.js backup:export` | Writes the downloaded-items table to `data/backups/` |
| `node src/index.js backup:import [--clean\|-c]` | Reads that backup back in; `--clean` replaces the table instead of merging |

Stopping a run with `Ctrl+C` is graceful: in-flight downloads finish, then
Kiroku stops without starting anything new. Pressing it twice forces an exit.

## Config editor

Everything Kiroku does is driven by `config.json`. Instead of editing that
file by hand, run:

```bash
npm run config
```

It starts a small local web UI and prints its address
(`http://127.0.0.1:5174` by default). Open that in a browser, make your
changes, press **Save** - the file on disk is updated immediately, and the
previous version is kept in `data/config-backups/` (the last 20 saves).

Useful variants:

```bash
npm run config -- --open        # start it and open a browser automatically
npm run config -- --port 8080   # use a different port
```

If the port is busy the editor moves to the next free one and prints the
address it actually used, so it is safe to start twice. Stop it with
`Ctrl+C`. The port can also come from the `KIROKU_CONFIG_EDITOR_PORT`
environment variable.

Note the `--` in those commands: it is what tells npm the flags belong to
Kiroku and not to npm itself. Running the file directly works too:

```bash
node tools/config-editor/config.editor.js --open
```

### What the editor gives you

- **Left panel - global settings.** Delays, concurrency, retries, database.
  Every field shows the default it falls back to; clearing a field removes
  the key from the file and goes back to that default.
- **Right side - your searches.** Each search is a card: name, URL,
  skip-downloaded, and its module options. Cards open one at a time, so a
  config with hundreds of searches stays fast.
- **Filter box** (`Ctrl+F`) matches names, URLs and options. The counter
  shows totals and warns about duplicate search names - the name is the key
  Kiroku uses for the already-downloaded check, so two searches sharing one
  name share that state.
- **A badge per search** tells you which module handles that URL, or warns
  that none does. **Check URLs** runs that test over every search at once.
- **Reorder** with the drag handle or the arrow buttons, **duplicate** a
  search with the copy button, **Sort…** to order the whole list.
- **JSON view** shows the whole file as text with live validation - handy for
  pasting a block of searches in. *Apply to form* brings it back.
- **Import / Export** move a config file in and out of the editor without
  touching `config.json` until you press Save.
- `Ctrl+S` saves, `Esc` clears the filter. The editor warns you before you
  close the tab with unsaved changes.

A save is checked by Kiroku's own config loader first, so the editor cannot
write a `config.json` that `npm start` would then refuse to load. If a search
is missing a name or URL, the editor says so instead of saving.

The server listens on `127.0.0.1` only - nothing is exposed to your network,
and it never fetches anything from the internet (the module badge is worked
out locally, from the URL alone).

## Adding a module

Copy `src/modules/_template/` to `src/modules/<service-name>/`, implement
`fetchPage()`, `parseItems()` and `downloadItem()`, and import the new file in
`src/modules/index.js`. See `CLAUDE.md` and `docs/ARCHITECTURE.md` for the
full contract.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
