// Local web UI for editing config.json - `npm run config`.
//
// A dependency-free http server (node:http only) that serves one HTML page and
// a small JSON API around the config file. It deliberately reuses the app's own
// pieces instead of reimplementing them:
//   - CONFIG_PATH / DEFAULTS / loadConfig() from src/config/app.config.js, so
//     the editor reads and validates exactly what the downloader will,
//   - resolveModule() from the orchestrator, so the UI can tell the user
//     whether a search URL is actually handled by a module.
//
// It binds to 127.0.0.1 only and never talks to the outside network.

import http from "node:http";
import { readFile, writeFile, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { CONFIG_PATH, DATA_DIR, DEFAULTS, loadConfig } from "../../src/config/app.config.js";
import { resolveModule } from "../../src/core/orchestrator/module.resolver.js";
import { print, banner } from "../../src/shared/utils.js";
import { WELCOME_MESSAGE } from "../../src/shared/messages.js";
import "../../src/modules/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(HERE, "config.editor.html");
const BACKUP_DIR = path.join(DATA_DIR, "config-backups");

const DEFAULT_PORT = 5174;
const PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const KEEP_BACKUPS = 20;

// Writes go through fetch() from our own page, which always sends this header.
// A browser cannot add it to a cross-origin request without a preflight this
// server never approves, so a random page in another tab cannot write here.
const GUARD_HEADER = "x-kiroku-editor";

// --- Request helpers --------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in request body: ${err.message}`);
  }
}

function isWriteAllowed(req) {
  return req.headers[GUARD_HEADER] === "1";
}

// --- Config file I/O --------------------------------------------------------

/**
 * Reads config.json as it is on disk - no defaults merged in, because the
 * editor edits the file, not the merged result. A missing file is not an
 * error: the UI starts from the defaults instead.
 */
async function readConfigFile() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { exists: false, config: null, raw: null, error: null };
    throw err;
  }

  try {
    return { exists: true, config: JSON.parse(raw), raw, error: null };
  } catch (err) {
    // A hand-edited file with a stray comma still has to be openable, so the
    // raw text goes back to the UI for the JSON view to fix.
    return { exists: true, config: null, raw, error: `Invalid JSON: ${err.message}` };
  }
}

/**
 * Runs the app's own loader against a candidate config, so the editor can only
 * ever save something `npm start` will accept.
 * @param {object} config
 */
async function validateCandidate(config) {
  await mkdir(BACKUP_DIR, { recursive: true });
  const probePath = path.join(BACKUP_DIR, ".validate.tmp.json");

  await writeFile(probePath, JSON.stringify(config, null, 2), "utf-8");
  try {
    await loadConfig(probePath);
  } finally {
    await rm(probePath, { force: true });
  }
}

/**
 * Copies the current config.json aside before it gets overwritten.
 * @returns {Promise<string|null>} backup path, or null on the very first save
 */
async function backupCurrentConfig() {
  await mkdir(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `config.${stamp}.json`);

  try {
    await copyFile(CONFIG_PATH, target);
  } catch (err) {
    if (err.code === "ENOENT") return null; // nothing to back up yet
    throw err;
  }

  await pruneBackups();
  return target;
}

async function pruneBackups() {
  const entries = (await readdir(BACKUP_DIR))
    .filter((name) => name.startsWith("config.") && name.endsWith(".json"))
    .sort();

  for (const name of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
    await rm(path.join(BACKUP_DIR, name), { force: true });
  }
}

// --- API routes -------------------------------------------------------------

async function handleGetConfig(res) {
  const file = await readConfigFile();
  sendJson(res, 200, { path: CONFIG_PATH, defaults: DEFAULTS, ...file });
}

async function handleSaveConfig(req, res) {
  const body = await readJsonBody(req);
  const config = body?.config;

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    sendJson(res, 400, { error: "Expected { config: { ... } }" });
    return;
  }

  try {
    await validateCandidate(config);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const backup = await backupCurrentConfig();
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  print(`Config saved from the editor (${config.searches?.length ?? 0} searches)`, "success");
  sendJson(res, 200, {
    ok: true,
    path: CONFIG_PATH,
    backup: backup ? path.relative(process.cwd(), backup) : null,
    savedAt: new Date().toISOString(),
  });
}

/**
 * Answers "will any module take this URL?" by asking the real registry.
 * resolveModule() builds the downloader, so a malformed URL a module rejects in
 * its constructor is reported here instead of at download time. Nothing is
 * fetched - this is offline URL parsing only.
 */
async function handleResolveUrl(req, res) {
  const { url } = await readJsonBody(req);

  if (typeof url !== "string" || !url.trim()) {
    sendJson(res, 200, { matched: false, module: null, error: "URL is empty" });
    return;
  }

  try {
    const downloader = resolveModule(url, { name: "config-editor-probe", url }, DEFAULTS);
    if (!downloader) {
      sendJson(res, 200, { matched: false, module: null, error: "No module handles this URL" });
      return;
    }
    sendJson(res, 200, { matched: true, module: downloader.constructor.name, error: null });
  } catch (err) {
    sendJson(res, 200, { matched: false, module: null, error: err.message });
  }
}

async function handleGetPage(res) {
  const html = await readFile(PAGE_PATH);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": html.length,
  });
  res.end(html);
}

// --- Server -----------------------------------------------------------------

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return handleGetPage(res);
  }
  if (req.method === "GET" && pathname === "/api/config") {
    return handleGetConfig(res);
  }
  if (req.method === "PUT" && pathname === "/api/config") {
    if (!isWriteAllowed(req)) return sendJson(res, 403, { error: "Forbidden" });
    return handleSaveConfig(req, res);
  }
  if (req.method === "POST" && pathname === "/api/resolve-url") {
    if (!isWriteAllowed(req)) return sendJson(res, 403, { error: "Forbidden" });
    return handleResolveUrl(req, res);
  }

  return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    print(`Editor request failed: ${err.message}`, "error");
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  });
});

/** Starts on the first free port, so a second editor instance still comes up. */
function listen(port, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      print(`Port ${port} is busy - trying ${port + 1}`, "warning");
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    print(`Config editor failed to start: ${err.message}`, "error");
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    print(`Config editor running at ${url}`, "success");
    print(`Editing ${CONFIG_PATH}`, "data");
    print("Press Ctrl+C to stop", "info");
    if (wantsOpen) openInBrowser(url);
  });
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch (err) {
    print(`Could not open a browser automatically: ${err.message}`, "warning");
  }
}

function parsePort(args) {
  const flagIndex = args.indexOf("--port");
  const raw = flagIndex !== -1 ? args[flagIndex + 1] : process.env.KIROKU_CONFIG_EDITOR_PORT;
  const port = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

const argv = process.argv.slice(2);
const wantsOpen = argv.includes("--open") || argv.includes("-o");

banner(WELCOME_MESSAGE, "Config Editor");
listen(parsePort(argv), PORT_ATTEMPTS);

process.on("SIGINT", () => {
  print("Config editor stopped", "system");
  server.close(() => process.exit(0));
});
