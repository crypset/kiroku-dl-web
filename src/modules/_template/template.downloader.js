// Template for a new service module.
//
// 1. Copy this folder to src/modules/<service-name>/, rename the file.
// 2. Implement fetchPage / parseItems / downloadItem below.
// 3. Register it in src/modules/index.js:
//      import "./<service-name>/<service-name>.downloader.js";
//
// The orchestrator handles pagination, delays, concurrency, retries and the
// skip-already-downloaded check. BaseDownloader hands you the plumbing every
// module would otherwise rewrite:
//
//   this.http                    a configured axios client (lazy)
//   this.getJson(url, params)    GET + JSON, throws on any non-200
//   this.postForm(url, fields)   POST multipart/form-data + JSON
//   this.downloadToFile(...)     stream to disk, validated (see below)
//   this.resolveItemPath(...)    downloads/<search>/<item>_<timestamp>.<ext>
//   this.option(key, fallback)   per-search settings from searches[].options
//   this.hasNextPageByTotal(...) pagination when the API reports a total
//
// So this class only has to know how to talk to its own site.
//
// See src/modules/bepisdb/ for a real implementation of all of this.

import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";
import { buildBrowserHeaders } from "../../shared/http.client.js";
import { parseSourceUrl, pickParams, toQueryParams } from "../../shared/query.params.js";

// How many items the site returns per page - used for the "do we have another
// page" arithmetic below.
const PAGE_SIZE = 20;

// The query parameters this site accepts, and the type each is sent as. If the
// source URL carries the search (the usual case for sites whose filters live in
// the address bar), pickParams() whitelists it against this.
const SEARCH_PARAMS = {
  // tags: "array",
  // sort: "string",
};

export class TemplateDownloader extends BaseDownloader {
  constructor(searchConfig, appConfig) {
    super(searchConfig, appConfig);

    // Parse the config URL once, up front: a bad URL should fail with a clear
    // message before any request goes out.
    const { segments, query } = parseSourceUrl(searchConfig.url);
    const { params, unknown } = pickParams(query, SEARCH_PARAMS);

    this.segments = segments;
    this.params = params;
    this.unknownParams = unknown;
    this.currentPage = 0;
  }

  async fetchPage(pageNumber) {
    // Remember the page: hasNextPage() isn't told which one it's judging.
    this.currentPage = pageNumber;

    return this.getJson(
      "https://template-service.example/api/search",
      toQueryParams({ ...this.params, page: pageNumber }),
      { headers: buildBrowserHeaders({ referer: this.searchConfig.url }) },
    );
  }

  async parseItems(pageData) {
    // Shape items as { id, title, url, ... }. Anything you put on `metadata`
    // is written into the item's .meta.json sidecar by the orchestrator, so
    // this is where rich source data (tags, author, checksums) belongs.
    return (pageData?.results ?? []).map((entry) => ({
      id: String(entry.id),
      title: entry.title,
      url: entry.fileUrl,
      metadata: entry,
    }));
  }

  hasNextPage(pageData) {
    return this.hasNextPageByTotal({
      page: this.currentPage,
      pageSize: PAGE_SIZE,
      total: pageData?.totalCount,
    });
  }

  async downloadItem(item) {
    const { filePath } = this.resolveItemPath(item, "mp4");

    // Streams to <filePath>.part and only renames once the response passes:
    // status 200, a content-type that isn't an HTML error page, and - when you
    // pass them - the expected size and sha256. Cleans up after itself on
    // failure, so a rejected download never leaves a bogus file behind.
    await this.downloadToFile(item.url, filePath, {
      headers: buildBrowserHeaders({ referer: item.pageUrl }),
      // expectedSize: item.size,
      // sha256: item.sha256,
    });

    return filePath;
  }
}

registerModule(
  (url) => url.includes("template-service.example"),
  (searchConfig, appConfig) => new TemplateDownloader(searchConfig, appConfig),
);
