import { readFile } from "fs/promises";
import { resolve } from "path";

// The one place config.json's location is decided. Tools that need to read or
// write the file (see tools/config-editor/) import this instead of building
// their own path.
export const CONFIG_PATH = resolve(process.cwd(), "config.json");

// Fixed runtime paths, not user-configurable via config.json - kept here so
// every other module reads them from this single source instead of
// hardcoding their own.
export const DATA_DIR = resolve(process.cwd(), "data");
export const DEFAULT_DB_STORAGE = resolve(DATA_DIR, "pot.sqlite");

/**
 * Values used for every key config.json leaves out. Exported so the config
 * editor can show them as placeholders instead of keeping its own copy.
 */
export const DEFAULTS = {
  app: {
    downloadDir: "downloads",
  },
  download: {
    delay: 4000,
    pageDelay: 4000,
    searchDelay: 6000,
    maxConcurrent: 1,
    skipErrors: true,
    skipDownloaded: true,
    useDatabase: true,
    retries: 2,
    retryDelay: 2000,
  },
  database: {
    enabled: true,
  },
  searches: [],
};

/**
 * Loads config.json, merges it over the defaults above, and validates it.
 * @param {string} [configPath]
 * @returns {Promise<object>}
 */
export async function loadConfig(configPath = CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read config file at ${configPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${err.message}`);
  }

  const config = {
    app: { ...DEFAULTS.app, ...parsed.app },
    download: { ...DEFAULTS.download, ...parsed.download },
    database: { ...DEFAULTS.database, ...parsed.database },
    searches: Array.isArray(parsed.searches) ? parsed.searches : DEFAULTS.searches,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!Array.isArray(config.searches)) {
    throw new Error("config.searches must be an array");
  }

  for (const search of config.searches) {
    if (!search.name || !search.url) {
      throw new Error(
        `Each entry in config.searches needs a "name" and a "url": ${JSON.stringify(search)}`,
      );
    }
  }
}

