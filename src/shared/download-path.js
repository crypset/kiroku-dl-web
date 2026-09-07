import path from "path";
import { sanitizeName } from "./utils.js";

/**
 * Formats a Date as a filesystem-safe, sortable timestamp: "2015-03-25_12-00-00".
 * Colons aren't valid in Windows filenames, so this deviates from a raw ISO
 * string - dashes everywhere instead.
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  return date
    .toISOString() // "2015-03-25T12:00:00.000Z"
    .replace("T", "_")
    .replace(/\.\d+Z$/, "")
    .replace(/:/g, "-"); // "2015-03-25_12-00-00"
}

/**
 * Builds the on-disk paths for a downloaded item:
 *   downloads/<searchName>/<sanitized item name>_<timestamp>.<ext>
 *   downloads/<searchName>/<sanitized item name>_<timestamp>.meta.json
 *
 * The search name is the primary axis, so everything from one source/series
 * ends up together regardless of when it was downloaded. The timestamp
 * suffix is what keeps two items with the same title (e.g. re-uploads,
 * identically named episodes across seasons) from overwriting each other.
 *
 * @param {{ downloadDir: string, searchName: string, itemName: string, extension: string, timestamp?: Date }} opts
 * @returns {{ dir: string, filePath: string, metaPath: string }}
 */
export function buildItemPath({
  downloadDir,
  searchName,
  itemName,
  extension,
  timestamp = new Date(),
}) {
  const dir = path.join(downloadDir, sanitizeName(searchName));
  const base = sanitizeName(`${itemName}_${formatTimestamp(timestamp)}`);
  const ext = extension.startsWith(".") ? extension : `.${extension}`;

  return {
    dir,
    filePath: path.join(dir, `${base}${ext}`),
    metaPath: path.join(dir, `${base}.meta.json`),
  };
}

/**
 * Derives the metadata sidecar path from a final downloaded file path,
 * e.g. downloads/foo/bar.mp4 -> downloads/foo/bar.meta.json
 * @param {string} filePath
 * @returns {string}
 */
export function metaPathFor(filePath) {
  const ext = path.extname(filePath);
  const withoutExt = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${withoutExt}.meta.json`;
}
