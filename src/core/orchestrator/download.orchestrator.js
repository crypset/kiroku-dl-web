import { resolveModule } from "./module.resolver.js";
import { print, sleep, ensureDir, saveToJson, retry } from "../../shared/utils.js";
import { metaPathFor } from "../../shared/download-path.js";
import { DownloadedItem } from "../teapot/models/index.js";

export class DownloadOrchestrator {
  /**
   * @param {object} config
   * @param {{ signal?: AbortSignal }} [options] - pass an AbortSignal to
   *   allow stopping the run early (e.g. on SIGINT). Already-started items
   *   are allowed to finish; only the next page/item/search is skipped.
   */
  constructor(config, { signal } = {}) {
    this.config = config;
    this.searches = config.searches ?? [];
    this.downloadConfig = config.download ?? {};
    this.databaseEnabled = Boolean(
      config.database?.enabled && this.downloadConfig.useDatabase,
    );
    this.signal = signal ?? new AbortController().signal;
  }

  async run() {
    await ensureDir(this.config.app?.downloadDir ?? "downloads");

    for (const searchConfig of this.searches) {
      if (this.signal.aborted) break;

      try {
        await this._runSearch(searchConfig);
      } catch (err) {
        // Last line of defence. Everything below reports its own failures and
        // keeps going, so reaching this means a module threw somewhere the
        // loop didn't anticipate - one broken source still must not stop the
        // others.
        print(`Search "${searchConfig.name}" failed: ${err.message}`, "error");
        if (!this.downloadConfig.skipErrors) throw err;
      }

      if (!this.signal.aborted && this.downloadConfig.searchDelay) {
        await sleep(this.downloadConfig.searchDelay);
      }
    }
  }

  async _runSearch(searchConfig) {
    let downloader;
    try {
      downloader = resolveModule(searchConfig.url, searchConfig, this.config);
    } catch (err) {
      // A module rejecting the URL outright (unknown section, malformed id) is a
      // config mistake rather than a transient failure - report it and move on to
      // the next search instead of taking the whole run down with it.
      print(`Cannot set up search "${searchConfig.name}": ${err.message}`, "error");
      if (!this.downloadConfig.skipErrors) throw err;
      return;
    }

    if (!downloader) {
      print(`No module matches search "${searchConfig.name}" (${searchConfig.url})`, "warning");
      return;
    }

    print(`Starting search "${searchConfig.name}"`, "system");

    let page = 1;
    while (!this.signal.aborted) {
      let pageData;
      try {
        pageData = await this._fetchPageWithRetry(downloader, searchConfig, page);
      } catch (err) {
        print(`Failed to fetch page ${page} for "${searchConfig.name}": ${err.message}`, "error");
        if (this.downloadConfig.skipErrors) break;
        throw err;
      }

      let items;
      try {
        items = await downloader.parseItems(pageData);
      } catch (err) {
        print(
          `Failed to parse page ${page} for "${searchConfig.name}": ${err.message}`,
          "error",
        );
        if (this.downloadConfig.skipErrors) break;
        throw err;
      }

      if (!items || items.length === 0) break;

      await this._downloadItems(downloader, searchConfig, items);

      if (this.signal.aborted) break;

      let morePages;
      try {
        morePages = downloader.hasNextPage(pageData, items);
      } catch (err) {
        print(
          `Could not work out the next page for "${searchConfig.name}": ${err.message}`,
          "error",
        );
        if (!this.downloadConfig.skipErrors) throw err;
        break;
      }

      if (!morePages) break;

      page += 1;
      if (this.downloadConfig.pageDelay) {
        await sleep(this.downloadConfig.pageDelay);
      }
    }

    print(`Finished search "${searchConfig.name}"`, "success");
  }

  async _fetchPageWithRetry(downloader, searchConfig, page) {
    return retry(() => downloader.fetchPage(page), {
      retries: this.downloadConfig.retries ?? 0,
      delay: this.downloadConfig.retryDelay ?? 0,
      onRetry: (err, attempt) =>
        print(
          `Retry ${attempt} fetching page ${page} for "${searchConfig.name}": ${err.message}`,
          "warning",
        ),
    });
  }

  async _downloadItems(downloader, searchConfig, items) {
    const concurrency = Math.max(1, this.downloadConfig.maxConcurrent ?? 1);
    const queue = [...items];

    const workers = Array.from({ length: concurrency }, () =>
      this._worker(downloader, searchConfig, queue),
    );

    await Promise.all(workers);
  }

  async _worker(downloader, searchConfig, queue) {
    while (queue.length > 0 && !this.signal.aborted) {
      const item = queue.shift();
      await this._downloadOne(downloader, searchConfig, item);

      if (this.downloadConfig.delay) {
        await sleep(this.downloadConfig.delay);
      }
    }
  }

  async _downloadOne(downloader, searchConfig, item) {
    let itemId;
    try {
      itemId = downloader.getItemId(item);
    } catch (err) {
      print(
        `Skipping an item of "${searchConfig.name}" - could not derive its id: ${err.message}`,
        "error",
      );
      if (!this.downloadConfig.skipErrors) throw err;
      return;
    }

    // From here on everything - the database lookup included - reports under
    // this item's id and leaves the rest of the queue alone.
    try {
      const skipDownloaded =
        this.downloadConfig.skipDownloaded && searchConfig.skipDownloaded !== false;

      if (skipDownloaded && (await this._alreadyDownloaded(searchConfig.name, itemId))) {
        print(`Skipping already downloaded: ${itemId}`, "info");
        return;
      }

      const filePath = await retry(() => downloader.downloadItem(item), {
        retries: this.downloadConfig.retries ?? 0,
        delay: this.downloadConfig.retryDelay ?? 0,
        onRetry: (err, attempt) =>
          print(`Retry ${attempt} downloading ${itemId}: ${err.message}`, "warning"),
      });
      await this._writeMetadata(searchConfig, item, itemId, filePath);
      await this._recordDownload(searchConfig.name, itemId, item, filePath);
      print(`Downloaded: ${itemId}`, "success");
    } catch (err) {
      print(`Failed to download ${itemId}: ${err.message}`, "error");
      if (!this.downloadConfig.skipErrors) throw err;
    }
  }

  async _writeMetadata(searchConfig, item, itemId, filePath) {
    if (!filePath) return;

    await saveToJson(metaPathFor(filePath), {
      searchName: searchConfig.name,
      itemId,
      title: item.title ?? null,
      url: item.url ?? null,
      filePath,
      downloadedAt: new Date().toISOString(),
      // Modules can attach richer, source-specific details as item.metadata;
      // they land in this same sidecar instead of a second file next to it.
      metadata: item.metadata ?? null,
    });
  }

  async _alreadyDownloaded(searchName, itemId) {
    if (!this.databaseEnabled) return false;
    const existing = await DownloadedItem.findOne({
      where: { searchName, itemId },
    });
    return Boolean(existing);
  }

  async _recordDownload(searchName, itemId, item, filePath) {
    if (!this.databaseEnabled) return;
    await DownloadedItem.findOrCreate({
      where: { searchName, itemId },
      defaults: {
        searchName,
        itemId,
        title: item.title ?? null,
        url: item.url ?? null,
        filePath: filePath ?? null,
      },
    });
  }
}
