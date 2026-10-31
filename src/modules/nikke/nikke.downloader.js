import path from "path";
import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";
import { buildBrowserHeaders } from "../../shared/http.client.js";
import { parseSourceUrl, pickParams } from "../../shared/query.params.js";
import { print } from "../../shared/utils.js";
import {
  API_BASE,
  CONTENT_CLASS,
  CONTENT_ENDPOINT,
  GAME_ID,
  HOST_LANGUAGES,
  ORIENTATION_LABELS,
  PAGE_SIZE,
  PRIMARY_LABEL_ID,
  SEARCH_PARAMS,
  buildNikkeHeaders,
  cleanDownloadUrl,
  extractExtension,
  isNikkeUrl,
  resolveActiveCategories,
} from "./nikke.types.js";

export class NikkeDownloader extends BaseDownloader {
  /**
   * @param {object} searchConfig - entry from config.searches
   * @param {object} appConfig - full loaded app config
   */
  constructor(searchConfig, appConfig) {
    super(searchConfig, appConfig);

    const { host, query } = parseSourceUrl(searchConfig.url);
    this.host = host;

    const { params, unknown, invalid } = pickParams(query, SEARCH_PARAMS);

    if (unknown.length > 0) {
      print(
        `Ignoring unsupported NIKKE search parameters: ${unknown.join(", ")}`,
        "warning",
      );
    }
    if (invalid.length > 0) {
      print(
        `Ignoring NIKKE search parameters with unusable values: ${invalid.join(", ")}`,
        "warning",
      );
    }

    // Language priority: ?lang=... -> options.language -> host default -> "en"
    this.language =
      params.lang ||
      this.option("language") ||
      HOST_LANGUAGES[host.toLowerCase()] ||
      "en";

    // Categories to download: ?type=... -> options.type -> all categories
    const typeParam = params.type || this.option("type");
    this.activeCategories = resolveActiveCategories(typeParam);

    // Orientation filter (horizontal, vertical): ?orientation=... -> options.orientation
    const orientationParam =
      params.orientation || this.option("orientation");
    this.orientationLabel = orientationParam
      ? ORIENTATION_LABELS[orientationParam.toLowerCase()] || null
      : null;

    if (orientationParam && !this.orientationLabel) {
      print(
        `Unknown NIKKE orientation "${orientationParam}" - expected "horizontal" or "vertical"`,
        "warning",
      );
    }

    this.subfoldersEnabled = this.option("subfolders", true) !== false;
    this.downloadPreviews = this.option("downloadPreviews", true) !== false;

    // Execution plan state (lazily resolved)
    this.plan = null;
    this.planPromise = null;
    this.totalPages = 0;
  }

  /**
   * Lazily initializes the download plan by querying total item counts for
   * each active category. Enables deterministic, retry-safe pagination.
   */
  async _ensurePlan() {
    if (this.plan) return;
    if (this.planPromise) return this.planPromise;

    this.planPromise = (async () => {
      const headers = buildNikkeHeaders({
        language: this.language,
        referer: this.searchConfig.url,
      });

      const planEntries = await Promise.all(
        this.activeCategories.map(async (cat) => {
          const body = {
            gameid: GAME_ID,
            language: [this.language],
            offset: 0,
            get_num: 1,
            secondary_label_id: cat.id,
            primary_label_id: PRIMARY_LABEL_ID,
            content_class: CONTENT_CLASS,
          };

          if (cat.key === "wallpaper" && this.orientationLabel) {
            body.content_label_id_list = [this.orientationLabel];
          }

          try {
            const response = await this.http.post(
              `${API_BASE}${CONTENT_ENDPOINT}`,
              body,
              { headers },
            );

            const total = response.data?.data?.total_num ?? 0;
            const pages = Math.ceil(total / PAGE_SIZE);
            return { ...cat, total, pages };
          } catch (err) {
            print(
              `Failed to query total count for category "${cat.name}": ${err.message}`,
              "error",
            );
            return { ...cat, total: 0, pages: 0 };
          }
        }),
      );

      this.plan = planEntries.filter((entry) => entry.pages > 0);
      this.totalPages = this.plan.reduce((sum, entry) => sum + entry.pages, 0);

      const planSummary = this.plan
        .map((p) => `${p.name}: ${p.total} items (${p.pages} pgs)`)
        .join(", ");

      print(
        `[NIKKE] Initialized plan: ${this.totalPages} pages total [${planSummary}]`,
        "system",
      );
    })();

    await this.planPromise;
  }

  /**
   * Deterministically maps a global 1-based page number to its corresponding
   * category and pagination offset.
   * @param {number} pageNumber
   * @returns {{ category: object, offset: number, catPage: number }|null}
   */
  _mapPage(pageNumber) {
    if (!this.plan || pageNumber < 1 || pageNumber > this.totalPages) {
      return null;
    }

    let accumulatedPages = 0;
    for (const cat of this.plan) {
      if (pageNumber <= accumulatedPages + cat.pages) {
        const catPage = pageNumber - accumulatedPages;
        const offset = (catPage - 1) * PAGE_SIZE;
        return { category: cat, offset, catPage };
      }
      accumulatedPages += cat.pages;
    }

    return null;
  }

  /**
   * Fetches raw page data from the NIKKE CMS API.
   * @param {number} pageNumber - 1-based page number
   * @returns {Promise<{ rawItems: object[], category: object|null, pageNumber: number }>}
   */
  async fetchPage(pageNumber) {
    await this._ensurePlan();

    const mapping = this._mapPage(pageNumber);
    if (!mapping) {
      return { rawItems: [], category: null, pageNumber };
    }

    const { category, offset } = mapping;
    const headers = buildNikkeHeaders({
      language: this.language,
      referer: this.searchConfig.url,
    });

    const body = {
      gameid: GAME_ID,
      language: [this.language],
      offset,
      get_num: PAGE_SIZE,
      secondary_label_id: category.id,
      primary_label_id: PRIMARY_LABEL_ID,
      content_class: CONTENT_CLASS,
    };

    if (category.key === "wallpaper" && this.orientationLabel) {
      body.content_label_id_list = [this.orientationLabel];
    }

    const response = await this.http.post(
      `${API_BASE}${CONTENT_ENDPOINT}`,
      body,
      { headers },
    );

    if (response.status !== 200 || response.data?.code !== 0) {
      throw new Error(
        `NIKKE API returned error (HTTP ${response.status}): ${response.data?.msg || "Unknown error"}`,
      );
    }

    const rawItems = response.data?.data?.info_content || [];
    return { rawItems, category, pageNumber };
  }

  /**
   * Parses raw CMS feed data into normalized item descriptors.
   * @param {{ rawItems: object[], category: object, pageNumber: number }} pageData
   * @returns {Promise<object[]>}
   */
  async parseItems(pageData) {
    const { rawItems, category } = pageData;
    if (!Array.isArray(rawItems) || !category) return [];

    const items = [];

    for (const raw of rawItems) {
      if (!raw.content_id) continue;

      let downloadUrl = "";
      if (raw.ext_info) {
        try {
          const parsedExt = JSON.parse(raw.ext_info);
          downloadUrl =
            parsedExt.download_url || parsedExt["download url"] || "";
        } catch {}
      }

      if (!downloadUrl && raw.jump_link_info?.jump_url) {
        downloadUrl = raw.jump_link_info.jump_url;
      }

      if (!downloadUrl && Array.isArray(raw.pic_urls) && raw.pic_urls.length > 0) {
        downloadUrl = raw.pic_urls[0];
      }

      downloadUrl = cleanDownloadUrl(downloadUrl);
      if (!downloadUrl) continue;

      const extension = extractExtension(
        downloadUrl,
        category.defaultExtension,
      );

      const firstPic = raw.pic_urls?.[0] || null;
      const previewUrl =
        firstPic && firstPic !== downloadUrl ? firstPic : null;

      const title =
        raw.title?.trim() ||
        raw.content_desc?.trim() ||
        `item_${raw.content_id}`;

      items.push({
        id: String(raw.content_id),
        title,
        url: downloadUrl,
        previewUrl,
        extension,
        category: category.key,
        subfolder: category.subfolder,
        metadata: {
          category: category.name,
          categoryKey: category.key,
          contentDesc: raw.content_desc ?? null,
          pubTimestamp: raw.pub_timestamp ?? null,
          previewUrl,
        },
      });
    }

    return items;
  }

  /**
   * Determines whether more pages are available.
   * @param {{ pageNumber: number }} pageData
   * @returns {boolean}
   */
  hasNextPage(pageData) {
    const maxPages = this.option("maxPages");
    if (maxPages && pageData.pageNumber >= maxPages) return false;

    return pageData.pageNumber < this.totalPages;
  }

  /**
   * Returns a stable item ID for already-downloaded checks.
   * @param {object} item
   * @returns {string}
   */
  getItemId(item) {
    return String(item.id);
  }

  /**
   * Downloads one item to disk and downloads its preview image if present.
   * @param {object} item
   * @returns {Promise<string>}
   */
  async downloadItem(item) {
    const subfolder = this.subfoldersEnabled ? item.subfolder : undefined;
    const { filePath } = this.resolveItemPath(item, item.extension, {
      subfolder,
    });

    const headers = buildBrowserHeaders({ referer: this.searchConfig.url });

    // Download primary file (e.g. .zip model or .png wallpaper)
    await this.downloadToFile(item.url, filePath, { headers });

    // Download preview image (especially for MMD models & live wallpapers)
    if (item.previewUrl && this.downloadPreviews) {
      try {
        const previewExt = extractExtension(item.previewUrl, "png");
        const parsed = path.parse(filePath);
        const previewPath = path.join(
          parsed.dir,
          `${parsed.name}_preview.${previewExt}`,
        );

        await this.downloadToFile(item.previewUrl, previewPath, { headers });
      } catch (err) {
        print(
          `Could not download preview image for "${item.title}": ${err.message}`,
          "warning",
        );
      }
    }

    return filePath;
  }
}

// Register with orchestrator module registry
registerModule(
  (url) => isNikkeUrl(url),
  (searchConfig, appConfig) => new NikkeDownloader(searchConfig, appConfig),
);
