const REGISTRY = [];

/**
 * Registers a module. Called by each module file (see src/modules/) when it
 * is imported, so simply importing src/modules/index.js wires everything up.
 *
 * @param {(url: string) => boolean} match
 * @param {(searchConfig: object, appConfig: object) => import("../modules/base.downloader.js").BaseDownloader} createDownloader
 */
export function registerModule(match, createDownloader) {
  REGISTRY.push({ match, createDownloader });
}

/**
 * Returns an instantiated downloader for the given URL, or null if no
 * registered module matches.
 *
 * @param {string} url
 * @param {object} searchConfig - the matching entry from config.searches
 * @param {object} appConfig - full app config, passed down to the downloader
 * @returns {import("../modules/base.downloader.js").BaseDownloader|null}
 */
export function resolveModule(url, searchConfig, appConfig) {
  if (typeof url !== "string" || url.trim() === "") return null;

  const entry = REGISTRY.find((m) => m.match(url));
  return entry ? entry.createDownloader(searchConfig, appConfig) : null;
}
