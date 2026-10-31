import fs from "fs/promises";
import { createRequire } from "module";
import path from "path";
import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";
import { buildBrowserHeaders } from "../../shared/http.client.js";
import { parseSourceUrl, pickParams } from "../../shared/query.params.js";
import { print, sanitizeName } from "../../shared/utils.js";
import {
  GALLERY_BASE,
  HOST,
  POSE_LABELS,
  SEARCH_PARAMS,
  SPRITE_BASE,
  SPRITE_SUFFIX,
  getL2dPoseInfo,
  isNikkeDbUrl,
  parseAtlasTextures,
  resolvePoses,
} from "./nikkedb.types.js";

const require = createRequire(import.meta.url);
const l2dCatalog = require("./data/l2d.json");
const galleryCatalog = require("./data/gallery.json");

const DEFAULT_PAGE_SIZE = 15;

export class NikkeDbDownloader extends BaseDownloader {
  /**
   * @param {object} searchConfig - entry from config.searches
   * @param {object} appConfig - full app configuration
   */
  constructor(searchConfig, appConfig) {
    super(searchConfig, appConfig);

    const { pathname, query } = parseSourceUrl(searchConfig.url);
    const { params, unknown, invalid } = pickParams(query, SEARCH_PARAMS);

    if (unknown.length > 0) {
      print(
        `Ignoring unsupported Nikke-DB search parameters: ${unknown.join(", ")}`,
        "warning",
      );
    }
    if (invalid.length > 0) {
      print(
        `Ignoring Nikke-DB search parameters with unusable values: ${invalid.join(", ")}`,
        "warning",
      );
    }

    // Determine target mode: gallery vs visualiser (L2D)
    const normPath = pathname.toLowerCase();
    if (normPath.includes("gallery")) {
      this.mode = "gallery";
    } else if (normPath.includes("visualiser") || normPath.includes("/v")) {
      this.mode = "visualiser";
    } else {
      this.mode = this.option("mode", "visualiser");
    }

    this.pageSize = this.option("pageSize", DEFAULT_PAGE_SIZE);
    this.params = params;
    this.initialized = false;
    this.allItems = [];
    this.totalPages = 0;
  }

  /**
   * Ensures the catalog (l2d or gallery) is loaded.
   * Tries to fetch the latest catalog dynamically from nikke-db.pages.dev,
   * falling back to the bundled local snapshot if offline or unreachable.
   */
  async _ensureInitialized() {
    if (this.initialized) return;

    let catalog = null;
    const catalogFilename = this.mode === "gallery" ? "gallery.json" : "l2d.json";
    const liveCatalogUrl = `https://${HOST}/${catalogFilename}`;

    // 1. Attempt to fetch latest live catalog from nikke-db.pages.dev
    try {
      print(`[Nikke-DB] Checking live catalog from ${liveCatalogUrl}...`, "info");
      const res = await this.http.get(liveCatalogUrl, {
        timeout: 10000,
        headers: buildBrowserHeaders({ referer: `https://${HOST}/` }),
      });
      if (Array.isArray(res.data) && res.data.length > 0) {
        catalog = res.data;
        print(
          `[Nikke-DB] Successfully loaded live ${catalogFilename} (${catalog.length} entries)`,
          "success",
        );
        // Asynchronously update local cache file
        try {
          const localCachePath = path.resolve(
            path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
            "data",
            catalogFilename,
          );
          fs.writeFile(localCachePath, JSON.stringify(catalog, null, 2), "utf-8").catch(() => {});
        } catch {
          // Non-critical if write fails
        }
      }
    } catch (err) {
      print(
        `[Nikke-DB] Could not fetch live ${catalogFilename} (${err.message}), falling back to bundled data`,
        "warning",
      );
    }

    // 2. Fall back to bundled snapshot if live fetch failed or returned empty
    if (!catalog) {
      catalog = this.mode === "gallery" ? galleryCatalog : l2dCatalog;
      print(
        `[Nikke-DB] Using bundled ${catalogFilename} snapshot (${catalog.length} entries)`,
        "system",
      );
    }

    this.allItems = this._buildItemQueue(this.params, catalog);
    this.totalPages = Math.ceil(this.allItems.length / this.pageSize);
    this.initialized = true;

    print(
      `[Nikke-DB] Initialized mode "${this.mode}": ${this.allItems.length} items (${this.totalPages} pages)`,
      "system",
    );
  }

  /**
   * Builds the full queue of downloadable items based on configuration & filters.
   * @param {Record<string, *>} params
   * @param {object[]} [catalog]
   * @returns {object[]}
   */
  _buildItemQueue(params, catalog) {
    if (this.mode === "gallery") {
      return this._buildGalleryQueue(params, catalog || galleryCatalog);
    }
    return this._buildVisualiserQueue(params, catalog || l2dCatalog);
  }

  /**
   * Builds queue for gallery images.
   * @param {Record<string, *>} params
   * @param {object[]} [catalog]
   * @returns {object[]}
   */
  _buildGalleryQueue(params, catalog = galleryCatalog) {
    const collectionFilter = (params.collection || this.option("collection") || "")
      .toLowerCase()
      .trim();
    const categoryFilter = (params.category || this.option("category") || "")
      .toLowerCase()
      .trim();

    let collections = catalog;

    if (collectionFilter) {
      collections = collections.filter(
        (col) =>
          col.id.toLowerCase().includes(collectionFilter) ||
          col.title.toLowerCase().includes(collectionFilter),
      );
    }

    if (categoryFilter) {
      collections = collections.filter((col) => {
        const id = col.id.toLowerCase();
        const p = col.path.toLowerCase();
        if (categoryFilter === "story") {
          return id.includes("story") || id.includes("chapter") || p.includes("story");
        }
        if (categoryFilter === "community") {
          return id.includes("4koma") || p.includes("4koma");
        }
        if (categoryFilter === "other") {
          return (
            id.includes("album") ||
            id.includes("bond") ||
            id.includes("bbq") ||
            id.includes("volt")
          );
        }
        return true;
      });
    }

    const items = [];
    for (const col of collections) {
      const colTitle = col.title || col.id;
      const subfolder = `gallery/${sanitizeName(colTitle)}`;

      for (const entry of col.items || []) {
        const filename = entry.name.includes(".") ? entry.name : `${entry.name}.png`;
        const ext = path.extname(filename).replace(/^\./, "").toLowerCase() || "png";
        const url = `${GALLERY_BASE}${col.path}${filename}`;
        const title = entry.text || path.parse(filename).name;

        items.push({
          type: "gallery",
          id: `nikkedb_gallery_${col.id}_${path.parse(filename).name}`,
          title: `${colTitle} - ${title}`,
          url,
          filename,
          extension: ext,
          subfolder,
          metadata: {
            collectionId: col.id,
            collectionTitle: colTitle,
            collectionPath: col.path,
            entryText: entry.text,
          },
        });
      }
    }

    const limit = params.limit || this.option("limit");
    return Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items;
  }

  /**
   * Builds queue for Live2D Spine models.
   * @param {Record<string, *>} params
   * @param {object[]} [catalog]
   * @returns {object[]}
   */
  _buildVisualiserQueue(params, catalog = l2dCatalog) {
    const requestedPoses = resolvePoses(params.pose || this.option("pose"));
    const charFilter = (
      params.character ||
      params.name ||
      params.id ||
      this.option("character") ||
      this.option("id") ||
      ""
    )
      .toLowerCase()
      .trim();

    let characters = catalog;
    if (charFilter) {
      characters = characters.filter(
        (c) =>
          c.id.toLowerCase().includes(charFilter) ||
          c.name.toLowerCase().includes(charFilter),
      );
    }

    const items = [];
    for (const char of characters) {
      for (const pose of requestedPoses) {
        const poseInfo = getL2dPoseInfo(char.id, pose);
        const poseLabel = POSE_LABELS[pose] || pose;

        items.push({
          type: "l2d",
          id: `nikkedb_l2d_${char.id}_${pose}`,
          characterId: char.id,
          characterName: char.name,
          pose,
          poseLabel,
          title: `${char.name} (${poseLabel})`,
          fileBase: poseInfo.fileBase,
          baseUrl: poseInfo.baseUrl,
          skelUrl: poseInfo.skelUrl,
          atlasUrl: poseInfo.atlasUrl,
          iconUrl: `${SPRITE_BASE}${char.id}${SPRITE_SUFFIX}`,
          subfolder: `visualiser/${sanitizeName(char.name)}_${sanitizeName(char.id)}/${pose}`,
          metadata: {
            characterId: char.id,
            characterName: char.name,
            pose,
            poseLabel,
            translations: {
              ko: char.ko,
              jp: char.jp,
              tw: char.tw,
              cn: char.cn,
              de: char.de,
              th: char.th,
              fr: char.fr,
            },
          },
        });
      }
    }

    const limit = params.limit || this.option("limit");
    return Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items;
  }

  /**
   * Returns a 1-based page of items.
   * @param {number} pageNumber
   * @returns {Promise<{ items: object[], pageNumber: number }>}
   */
  async fetchPage(pageNumber) {
    await this._ensureInitialized();
    const start = (pageNumber - 1) * this.pageSize;
    const end = start + this.pageSize;
    const items = this.allItems.slice(start, end);

    return { items, pageNumber, totalPages: this.totalPages };
  }

  /**
   * Parses items for the current page.
   * @param {{ items: object[] }} pageData
   * @returns {Promise<object[]>}
   */
  async parseItems(pageData) {
    return pageData.items || [];
  }

  /**
   * Checks if there are subsequent pages.
   * @param {{ pageNumber: number }} pageData
   * @returns {boolean}
   */
  hasNextPage(pageData) {
    const maxPages = this.option("maxPages");
    if (maxPages && pageData.pageNumber >= maxPages) return false;

    return pageData.pageNumber < this.totalPages;
  }

  /**
   * Unique ID for skipDownloaded tracking.
   * @param {object} item
   * @returns {string}
   */
  getItemId(item) {
    return String(item.id);
  }

  /**
   * Downloads one item:
   * - Gallery: downloads single image into collection subfolder.
   * - Live2D: downloads .skel, .atlas, and all atlas textures into character pose directory (Option A).
   * @param {object} item
   * @returns {Promise<string>} primary saved file path
   */
  async downloadItem(item) {
    const headers = buildBrowserHeaders({ referer: this.searchConfig.url });

    if (item.type === "gallery") {
      const { filePath } = this.resolveItemPath(item, item.extension, {
        subfolder: item.subfolder,
      });
      await this.downloadToFile(item.url, filePath, { headers });
      return filePath;
    }

    // ─── Live2D Spine Option A (Directory with exact filenames) ─────────────
    const groupSegment =
      typeof this.searchConfig.group === "string" && this.searchConfig.group.trim()
        ? [sanitizeName(this.searchConfig.group)]
        : [];
    const downloadDir = this.appConfig.app?.downloadDir ?? "downloads";

    const charFolderName = `${sanitizeName(item.characterName)}_${sanitizeName(item.characterId)}`;
    const charDir = path.join(
      downloadDir,
      ...groupSegment,
      sanitizeName(this.searchConfig.name),
      "visualiser",
      charFolderName,
    );
    const poseDir = path.join(charDir, sanitizeName(item.pose));

    await fs.mkdir(poseDir, { recursive: true });

    // 1. Download .atlas
    const atlasPath = path.join(poseDir, `${item.fileBase}.atlas`);
    await this.downloadToFile(item.atlasUrl, atlasPath, { headers });

    // 2. Parse referenced texture images from .atlas text
    let textureNames = [`${item.fileBase}.png`];
    try {
      const atlasText = await fs.readFile(atlasPath, "utf-8");
      textureNames = parseAtlasTextures(atlasText, item.fileBase);
    } catch (err) {
      print(
        `Could not parse atlas textures for ${item.id}, falling back to default: ${err.message}`,
        "warning",
      );
    }

    // 3. Download each referenced texture page
    for (const texName of textureNames) {
      const texUrl = `${item.baseUrl}${texName}`;
      const texPath = path.join(poseDir, texName);
      await this.downloadToFile(texUrl, texPath, { headers });
    }

    // 4. Download .skel skeleton
    const skelPath = path.join(poseDir, `${item.fileBase}.skel`);
    await this.downloadToFile(item.skelUrl, skelPath, { headers });

    // 5. Download character preview icon (once per character folder)
    const iconPath = path.join(charDir, "icon_preview.png");
    try {
      await fs.access(iconPath);
    } catch {
      try {
        await this.downloadToFile(item.iconUrl, iconPath, { headers });
      } catch {
        // Non-critical if icon fails
      }
    }

    // Return the primary .skel path as the item's main artifact
    return skelPath;
  }
}

// Register module for nikke-db.pages.dev
registerModule(
  (url) => isNikkeDbUrl(url),
  (searchConfig, appConfig) => new NikkeDbDownloader(searchConfig, appConfig),
);
