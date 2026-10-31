import fs from "fs/promises";
import path from "path";
import { Op } from "sequelize";
import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";
import { DownloadedItem } from "../../core/teapot/models/index.js";
import { buildBrowserHeaders } from "../../shared/http.client.js";
import { parseSourceUrl } from "../../shared/query.params.js";
import { print, sanitizeName } from "../../shared/utils.js";
import {
  HOST,
  PAGE_SIZE,
  isMmdaBooruUrl,
  isTstorageUrl,
  loadTstorageCookie,
  parseListPage,
  parseViewPage,
  resolveTstorageDownload,
} from "./mmdarchive.types.js";

export class MmdArchiveDownloader extends BaseDownloader {
  /**
   * @param {object} searchConfig
   * @param {object} appConfig
   */
  constructor(searchConfig, appConfig) {
    super(searchConfig, appConfig);

    const { query } = parseSourceUrl(searchConfig.url);

    // Check if URL is for a single post: ?page=post&s=view&id=2128
    const singleId = query.id || query["amp;id"];
    const viewMode = (query.s === "view" || query["amp;s"] === "view") && singleId;

    if (viewMode) {
      this.singlePostId = String(singleId);
      this.isSinglePost = true;
    } else {
      this.isSinglePost = false;
      this.singlePostId = null;
      // Extract search tags: from query or option
      const rawTags =
        query.tags ||
        query["amp;tags"] ||
        this.option("tags") ||
        "all";
      this.tags = String(rawTags).trim();
    }

    this.cookiePromise = loadTstorageCookie(this.searchConfig).then((cookie) => {
      this.tstorageCookie = cookie;
      if (cookie) {
        print(`[MMDArchive] Loaded tstorage cookies for search "${searchConfig.name}"`, "system");
      }
      return cookie;
    });

    print(
      `[MMDArchive] Initialized ${this.isSinglePost ? `single post #${this.singlePostId}` : `search tags="${this.tags}"`}`,
      "system",
    );
  }

  /**
   * Fetches a single page:
   * - Single post mode: loads the view page directly.
   * - List mode: loads page of 20 posts for given pageNumber.
   *
   * @param {number} pageNumber - 1-based page index
   * @returns {Promise<object>}
   */
  async fetchPage(pageNumber) {
    const headers = buildBrowserHeaders({ referer: `https://${HOST}/` });

    if (this.isSinglePost) {
      if (pageNumber > 1) {
        return { isSinglePost: true, posts: [], pageNumber };
      }
      const viewUrl = `https://${HOST}/index.php?page=post&s=view&id=${this.singlePostId}`;
      const res = await this.http.get(viewUrl, { headers });
      return {
        isSinglePost: true,
        singlePostId: this.singlePostId,
        html: res.data,
        pageNumber: 1,
      };
    }

    const pid = (pageNumber - 1) * PAGE_SIZE;
    const listUrl = `https://${HOST}/index.php?page=post&s=list&tags=${encodeURIComponent(this.tags)}&pid=${pid}`;
    const res = await this.http.get(listUrl, { headers });
    const { posts, hasNext, lastPid } = parseListPage(res.data);

    return {
      isSinglePost: false,
      posts,
      hasNext,
      lastPid,
      pageNumber,
    };
  }

  /**
   * Parses fetched page into full items with metadata, source, and candidate links.
   * @param {object} pageData
   * @returns {Promise<object[]>}
   */
  async parseItems(pageData) {
    if (pageData.isSinglePost) {
      if (!pageData.html) return [];
      const item = parseViewPage(pageData.html, pageData.singlePostId);
      item.url = `https://${HOST}/index.php?page=post&s=view&id=${pageData.singlePostId}`;
      item.title = item.title || item.tags.slice(0, 3).join("_") || `model_${pageData.singlePostId}`;
      item.metadata = this._buildItemMetadata(item);
      return [item];
    }

    const posts = pageData.posts || [];
    if (posts.length === 0) return [];

    // Pre-check if any posts are already downloaded to avoid unnecessary HTTP view-page requests
    const skipDownloaded =
      this.appConfig?.download?.skipDownloaded && this.searchConfig?.skipDownloaded !== false;
    let alreadySavedIds = new Set();

    if (skipDownloaded && this.appConfig?.database?.enabled && this.appConfig?.download?.useDatabase) {
      try {
        const candidateIds = posts.map((p) => this.getItemId(p));
        const rows = await DownloadedItem.findAll({
          where: {
            searchName: this.searchConfig.name,
            itemId: { [Op.in]: candidateIds },
          },
          attributes: ["itemId"],
          raw: true,
        });
        alreadySavedIds = new Set(rows.map((r) => r.itemId));
      } catch {
        // Fall back to standard fetching if DB query fails
      }
    }

    const headers = buildBrowserHeaders({ referer: `https://${HOST}/` });
    const fullItems = [];
    const postsToFetch = [];

    for (const post of posts) {
      if (alreadySavedIds.has(this.getItemId(post))) {
        // Return lightweight stub - orchestrator will skip it immediately without download
        fullItems.push({
          id: post.id,
          url: post.viewUrl,
          title: post.tags.slice(0, 3).join("_") || `model_${post.id}`,
          tags: post.tags || [],
          rating: post.rating || "Unknown",
          score: post.score ?? 0,
          author: post.user || "anonymous",
          thumbUrl: post.thumbUrl,
        });
      } else {
        postsToFetch.push(post);
      }
    }

    // Fetch view pages only for new posts with concurrency limit
    const BATCH_SIZE = 3;
    for (let i = 0; i < postsToFetch.length; i += BATCH_SIZE) {
      const batch = postsToFetch.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (post) => {
          try {
            const res = await this.http.get(post.viewUrl, { headers });
            const item = parseViewPage(res.data, post.id);

            // Merge details
            item.url = post.viewUrl;
            item.title =
              item.title ||
              post.tags.slice(0, 3).join("_") ||
              `model_${post.id}`;
            item.rating = item.rating || post.rating;
            item.score = item.score ?? post.score;
            item.author = item.author || post.user;
            if ((!item.tags || item.tags.length === 0) && post.tags?.length > 0) {
              item.tags = post.tags;
            }
            item.thumbUrl = post.thumbUrl;
            item.metadata = this._buildItemMetadata(item);

            return item;
          } catch (err) {
            print(
              `[MMDArchive] Failed to fetch view page for post #${post.id}: ${err.message}`,
              "warning",
            );
            return null;
          }
        }),
      );

      for (const res of batchResults) {
        if (res) fullItems.push(res);
      }
    }

    return fullItems;
  }

  /**
   * Evaluates if more pages exist.
   * @param {object} pageData
   * @param {object[]} items
   * @returns {boolean}
   */
  hasNextPage(pageData, items) {
    if (this.isSinglePost) return false;

    const maxPages = this.option("maxPages");
    if (maxPages && pageData.pageNumber >= maxPages) return false;

    return Boolean(pageData.hasNext && items.length > 0);
  }

  /**
   * Unique item identifier for skip-downloaded tracking.
   * @param {object} item
   * @returns {string}
   */
  getItemId(item) {
    return `booru_${item.id}`;
  }

  /**
   * Downloads one MMD item:
   * 1. Creates folder downloads/[<group>/]<searchName>/<Title>_<id>/
   * 2. Saves preview.<ext>
   * 3. If candidate link points to tstorage.info, resolves and downloads model archive
   * 4. Returns previewPath; orchestrator saves preview.meta.json alongside it.
   *
   * @param {object} item
   * @returns {Promise<string>}
   */
  async downloadItem(item) {
    await this.cookiePromise;

    const groupSegment =
      typeof this.searchConfig.group === "string" && this.searchConfig.group.trim()
        ? [sanitizeName(this.searchConfig.group)]
        : [];
    const downloadDir = this.appConfig.app?.downloadDir ?? "downloads";

    const titlePart = sanitizeName(item.title || "model").slice(0, 80).trim() || "model";
    const folderName = `${titlePart}_${item.id}`;
    const itemDir = path.join(
      downloadDir,
      ...groupSegment,
      sanitizeName(this.searchConfig.name),
      folderName,
    );

    await fs.mkdir(itemDir, { recursive: true });

    // 1. Download preview image
    const headers = buildBrowserHeaders({ referer: item.url });
    let ext = ".jpg";
    if (item.imageUrl) {
      try {
        const parsedUrl = new URL(item.imageUrl);
        const parsedExt = path.extname(parsedUrl.pathname);
        if (parsedExt) ext = parsedExt;
      } catch {
        // Fallback to .jpg
      }
    }

    const previewPath = path.join(itemDir, `preview${ext}`);

    if (item.imageUrl) {
      await this.downloadToFile(item.imageUrl, previewPath, { headers });
    } else {
      // Create a dummy preview file so orchestrator sidecar is always generated
      await fs.writeFile(
        previewPath,
        `Post #${item.id} preview was not available on booru.`,
        "utf-8",
      );
    }

    // 2. Check for tstorage.info model archive download
    const tstorageLink = item.candidateLinks?.find((link) => isTstorageUrl(link));
    if (tstorageLink) {
      print(`[MMDArchive] Found tstorage link for #${item.id}: ${tstorageLink}`, "info");
      const result = await resolveTstorageDownload(
        tstorageLink,
        this.tstorageCookie,
        itemDir,
        this.http,
      );

      if (result.status === "downloaded") {
        print(
          `[MMDArchive] Downloaded model archive for #${item.id}: ${result.filename} (${result.bytes} bytes)`,
          "success",
        );
        item.metadata.archive = {
          status: "downloaded",
          filename: result.filename,
          filePath: result.filePath,
          bytes: result.bytes,
          sourceUrl: tstorageLink,
        };
      } else if (result.status === "not_found") {
        print(
          `[MMDArchive] Model file expired on tstorage for #${item.id}: ${tstorageLink}`,
          "warning",
        );
        item.metadata.archive = {
          status: "expired",
          sourceUrl: tstorageLink,
          reason: result.reason,
        };
      } else {
        print(
          `[MMDArchive] Could not download from tstorage for #${item.id}: ${result.reason}`,
          "warning",
        );
        item.metadata.archive = {
          status: result.status,
          sourceUrl: tstorageLink,
          reason: result.reason,
        };
      }
    } else {
      item.metadata.archive = {
        status: "external",
        candidateLinks: item.candidateLinks,
        reason: "No tstorage.info mirror found; check candidateLinks in metadata",
      };
    }

    return previewPath;
  }

  /**
   * Prepares the rich metadata object to be stored in the sidecar .meta.json file.
   * @param {object} item
   * @returns {object}
   */
  _buildItemMetadata(item) {
    return {
      booruId: item.id,
      title: item.title,
      postUrl: item.url,
      imageUrl: item.imageUrl,
      thumbUrl: item.thumbUrl ?? null,
      source: item.source || null,
      author: item.author || null,
      rating: item.rating || "Unknown",
      score: item.score ?? 0,
      tags: item.tags || [],
      candidateLinks: item.candidateLinks || [],
      passwordHints: item.passwordHints || [],
      comments: (item.comments || []).map((c) => ({
        id: c.id,
        author: c.author,
        postedAt: c.postedAt,
        score: c.score,
        text: c.text,
        urls: c.urls,
        passwordHints: c.passwordHints,
      })),
      archive: item.metadata?.archive ?? null,
    };
  }
}

// Register module for mmda.booru.org
registerModule(
  (url) => isMmdaBooruUrl(url),
  (searchConfig, appConfig) => new MmdArchiveDownloader(searchConfig, appConfig),
);
