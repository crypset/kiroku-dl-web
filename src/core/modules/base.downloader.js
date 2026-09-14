import { buildItemPath } from "../../shared/download-path.js";
import {
  createHttpClient,
  downloadToFile,
  getJson,
  postForm,
} from "../../shared/http.client.js";

/**
 * Contract every service module must implement.
 *
 * The orchestrator owns pagination, delays, concurrency, retries and the
 * skip-downloaded check — a module only needs to know how to talk to its
 * specific site: fetch a page, parse items out of it, and download one item.
 *
 * Everything under "Provided helpers" below is shared plumbing every module
 * would otherwise rewrite (an HTTP client, streaming a validated file to disk,
 * reading per-search options, page-count arithmetic). The real implementations
 * live in src/shared/ — these are thin delegations so a module can just call
 * `this.getJson(...)` / `this.downloadToFile(...)` without wiring anything up.
 */
export class BaseDownloader {
  /**
   * @param {object} searchConfig - the matching entry from config.searches
   * @param {object} appConfig - the full loaded app config
   */
  constructor(searchConfig, appConfig) {
    this.searchConfig = searchConfig;
    this.appConfig = appConfig;
    this._http = null;
  }

  // ── Contract ───────────────────────────────────────────────────────────────

  /**
   * Fetch raw page data (HTML, JSON, whatever the site returns) for a given
   * 1-based page number.
   * @param {number} pageNumber
   * @returns {Promise<*>}
   */
  async fetchPage(pageNumber) {
    throw new Error(`${this.constructor.name}.fetchPage() is not implemented`);
  }

  /**
   * Parse raw page data into a flat array of items.
   * Each item should at minimum carry enough info to identify and download it,
   * e.g. { id, title, url }. An optional `metadata` field is written into the
   * item's .meta.json sidecar by the orchestrator.
   * @param {*} pageData
   * @returns {Promise<object[]>}
   */
  async parseItems(pageData) {
    throw new Error(`${this.constructor.name}.parseItems() is not implemented`);
  }

  /**
   * Download a single item to disk.
   * @param {object} item
   * @returns {Promise<string>} the saved file path
   */
  async downloadItem(item) {
    throw new Error(`${this.constructor.name}.downloadItem() is not implemented`);
  }

  /**
   * Stable unique id for an item, used for the skip-already-downloaded check.
   * Override if `item.id` / `item.url` isn't a good fit.
   * @param {object} item
   * @returns {string}
   */
  getItemId(item) {
    return String(item.id ?? item.url);
  }

  /**
   * Whether the orchestrator should fetch the next page.
   * Default: stop once a page comes back with no items.
   * @param {*} pageData
   * @param {object[]} items
   * @returns {boolean}
   */
  hasNextPage(pageData, items) {
    return items.length > 0;
  }

  // ── Provided helpers ───────────────────────────────────────────────────────

  /**
   * Per-search module options: the `options` object on a config.searches entry.
   * Generic keys (name, url, skipDownloaded) stay at the top level; anything
   * module-specific lives under `options` so the two never collide.
   * @param {string} key
   * @param {*} [fallback]
   * @returns {*}
   */
  option(key, fallback) {
    return this.searchConfig?.options?.[key] ?? fallback;
  }

  /**
   * Lazily created HTTP client, configured from this search's options
   * (`userAgent`, `timeout`, `headers`).
   * @returns {import("axios").AxiosInstance}
   */
  get http() {
    if (!this._http) {
      this._http = createHttpClient({
        userAgent: this.option("userAgent"),
        timeout: this.option("timeout"),
        headers: this.option("headers"),
      });
    }
    return this._http;
  }

  /**
   * GET a URL and return the parsed JSON body. Throws on any non-200.
   * @param {string} url
   * @param {object} [params]
   * @param {{ headers?: object, signal?: AbortSignal }} [options]
   * @returns {Promise<*>}
   */
  getJson(url, params, options) {
    return getJson(this.http, url, params, options);
  }

  /**
   * POST multipart/form-data and return the parsed JSON body.
   * @param {string} url
   * @param {Record<string, string|number|boolean>} [fields]
   * @param {{ headers?: object, signal?: AbortSignal }} [options]
   * @returns {Promise<*>}
   */
  postForm(url, fields, options) {
    return postForm(this.http, url, fields, options);
  }

  /**
   * Stream a URL to disk, validating status, content-type, size and checksum
   * before the file is kept. See shared/http.client.js for the details.
   * @param {string} url
   * @param {string} filePath
   * @param {object} [options]
   * @returns {Promise<{ filePath: string, bytes: number, sha256: string|null }>}
   */
  downloadToFile(url, filePath, options) {
    return downloadToFile(this.http, url, filePath, options);
  }

  /**
   * Pagination for the common "API tells us the total hit count" case, with the
   * per-search `maxPages` cap applied on top.
   *
   * An unknown total means "keep going" — the orchestrator still stops on the
   * first empty page.
   *
   * @param {{ page: number, pageSize: number, total?: number }} args - `page` is
   *   the 1-based page that was just fetched
   * @returns {boolean}
   */
  hasNextPageByTotal({ page, pageSize, total }) {
    const maxPages = this.option("maxPages");
    if (maxPages && page >= maxPages) return false;

    if (!Number.isFinite(total) || !pageSize) return true;
    return page * pageSize < total;
  }

  /**
   * Convenience: resolves where an item should be saved on disk, following
   * the shared downloads/[<group>/]<searchName>/<item>.<ext> layout - the
   * group folder appears when the search config names one. Modules can use
   * this in downloadItem() instead of building paths by hand, or ignore it
   * and return their own path — the orchestrator only cares about the
   * returned filePath.
   * @param {object} item
   * @param {string} extension - e.g. "mp4", ".jpg"
   * @returns {{ dir: string, filePath: string, metaPath: string }}
   */
  resolveItemPath(item, extension) {
    return buildItemPath({
      downloadDir: this.appConfig.app?.downloadDir ?? "downloads",
      searchName: this.searchConfig.name,
      itemName: item.title ?? this.getItemId(item),
      extension,
      group: this.searchConfig.group,
    });
  }
}
