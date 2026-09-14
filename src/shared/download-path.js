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
 * and, when the search declares a `group`, one level deeper:
 *   downloads/<group>/<searchName>/<sanitized item name>_<timestamp>.<ext>
 *
 * The search name is the primary axis, so everything from one source/series
 * ends up together regardless of when it was downloaded; the group is an
 * optional shelf above it for keeping related searches side by side. The
 * timestamp suffix is what keeps two items with the same title (e.g.
 * re-uploads, identically named episodes across seasons) from overwriting
 * each other.
 *
 * A group only changes where files land - the already-downloaded check is
 * keyed on the search name, so moving a search into a group does not make
 * Kiroku fetch everything again.
 *
 * @param {{ downloadDir: string, searchName: string, itemName: string, extension: string, group?: string, timestamp?: Date }} opts
 * @returns {{ dir: string, filePath: string, metaPath: string }}
 */
export function buildItemPath({
  downloadDir,
  searchName,
  itemName,
  extension,
  group,
  timestamp = new Date(),
}) {
  // sanitizeName() strips separators, so a group can only ever add one level -
  // a value like "../elsewhere" cannot escape the download directory.
  const groupSegment = typeof group === "string" && group.trim() ? [sanitizeName(group)] : [];
  const dir = path.join(downloadDir, ...groupSegment, sanitizeName(searchName));
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
