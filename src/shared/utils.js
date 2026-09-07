import chalk       from 'chalk';
import gradient    from 'gradient-string';
import fs          from 'fs/promises';
import path        from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Palette (NieR Automata inspired) ───────────────────────────────────────

const colors = {
  primary:          '#F4F4F4',
  secondary:        '#C0C0C0',
  dark:             '#1A1A1A',
  accent:           '#FFFFFF',
  dim:              '#808080',
  system_core_grey: '#B8B8B8',
  data:             '#A7D6D6',
  muted_amber:      '#CBBFA4',
  aqua_screen:      '#9CC4B2',
  pale_green:       '#8FA98F',
  dark_gray:        '#2E2E2E',
  silver:           '#A6A6A6',
  warm_white:       '#F2F2F2',
  red_alert:        '#A62626',
  cool_grey:        '#555555',
};

const symbols = {
  android:   '■',
  pod:       '●',
  data:      '◆',
  system:    '▲',
  warning:   '▼',
  error:     '✕',
  success:   '◉',
  info:      '○',
  loading:   '◐',
  separator: '│',
  corner:    '└',
  line:      '─',
};

// ─── Log type config ─────────────────────────────────────────────────────────

const LOG_TYPES = {
  info: {
    symbol:     symbols.info,
    label:      '[INFO]',
    labelColor: chalk.hex(colors.aqua_screen),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  system: {
    symbol:     symbols.system,
    label:      '[SYSTEM]',
    labelColor: chalk.hex(colors.system_core_grey),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  data: {
    symbol:     symbols.data,
    label:      '[DATA]',
    labelColor: chalk.hex(colors.data),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  warning: {
    symbol:     symbols.warning,
    label:      '[WARN]',
    labelColor: chalk.hex(colors.muted_amber),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  success: {
    symbol:     symbols.success,
    label:      '[OK]',
    labelColor: chalk.hex(colors.pale_green),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  debug: {
    symbol:     symbols.error,
    label:      '[DEBUG]',
    labelColor: chalk.hex(colors.red_alert),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  error: {
    symbol:     symbols.error,
    label:      '[ERROR]',
    labelColor: chalk.hex(colors.red_alert),
    textColor:  chalk.hex(colors.system_core_grey),
  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Structured console logger.
 * @param {string} text
 * @param {'info'|'system'|'data'|'warning'|'success'|'debug'|'error'} type
 */
export function print(text, type = 'info') {
  const cfg       = LOG_TYPES[type] ?? LOG_TYPES.info;
  const timestamp = new Date().toISOString().replace('T', '_').substring(0, 19);
  const sep       = chalk.hex(colors.dim)(symbols.separator);
  const ts        = chalk.hex(colors.dim)(timestamp);

  console.log(
    `${cfg.symbol} ${sep} ${ts} ${sep} ${cfg.labelColor(cfg.label)} ${cfg.textColor(text)}`,
  );
}

/**
 * Print a styled banner with optional subtitle.
 */
export function banner(text, subtitle = null) {
  console.log('\n');
  console.log(
    gradient([colors.dark_gray, colors.silver, colors.warm_white])(text),
  );
  if (subtitle) console.log(chalk.hex(colors.cool_grey)(subtitle));
  console.log('\n');
}

/**
 * Async sleep.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random delay in [min, max] range — adds human-like timing jitter.
 * @param {number} minMs
 * @param {number} maxMs
 */
export function jitter(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
}

/**
 * Runs `fn`, retrying on failure up to `retries` additional times
 * (so `retries: 2` means up to 3 attempts total), with a fixed delay
 * between attempts.
 * If a thrown error carries `retryAfterMs`, that wait is used instead of
 * `delay` whenever it is longer.
 *
 * @param {(attempt: number) => Promise<*>} fn - attempt is 0 on the first try
 * @param {{ retries?: number, delay?: number, onRetry?: (err: Error, attempt: number) => void }} [options]
 */
export async function retry(fn, { retries = 0, delay = 0, onRetry } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries) throw err;
      onRetry?.(err, attempt + 1);
      // A server that told us how long to back off (Retry-After, surfaced as
      // err.retryAfterMs by shared/http.client.js) outranks the configured
      // delay - retrying sooner than asked just earns another rejection.
      const wait = Math.max(delay ?? 0, err?.retryAfterMs ?? 0);
      if (wait) await sleep(wait);
      attempt += 1;
    }
  }
}

/**
 * Write JSON to file (overwrites).
 * @param {string} filePath
 * @param {*} data
 */
export async function saveToJson(filePath, data) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    print(`saveToJson error: ${error.message}`, 'error');
  }
}

/**
 * Write text to file (overwrites).
 * @param {string} filePath
 * @param {string} text
 */
export async function saveToTxt(filePath, text) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf-8');
  } catch (error) {
    print(`saveToTxt error: ${error.message}`, 'error');
  }
}

/**
 * Append text to file (creates if missing).
 * @param {string} filePath
 * @param {string} text
 */
export async function appendToTxt(filePath, text) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, text + '\n', 'utf-8');
  } catch (error) {
    print(`appendToTxt error: ${error.message}`, 'error');
  }
}

/**
 * Ensure a directory exists (creates recursively).
 * @param {string} dirPath
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Strips characters that are illegal in file/folder names on Windows, macOS, and Linux,
 * then removes any trailing dots or spaces — both break folder access on Windows
 * and cause confusing behaviour on other systems.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "") // illegal chars + control codes
      .replace(/\.+$/, "")                      // trailing dots  ("Name." → "Name")
      .trim()                                   // trailing spaces
    || "Unknown"
  );
}

/**
 * Converts a base64-encoded digest to lowercase hex.
 *
 * APIs commonly publish checksums in base64 while hashing and verification
 * tools speak hex, so this sits between the two.
 *
 * @param {string} value
 * @returns {string}
 */
export function base64ToHex(value) {
  return Buffer.from(value, "base64").toString("hex");
}
