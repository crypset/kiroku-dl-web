// BepisDB (https://db.bepis.moe) - character cards, scenes and clothing for
// Koikatsu and the other games the site hosts.
//
// The site is a Svelte SPA with no official API; the endpoints used here were
// read out of its frontend bundle and verified against the live service. See
// docs/services/db.bepis.moe/API.md.
//
// The one thing worth knowing up front: the site's own search page reads its
// filters straight out of window.location.search using the same names the API
// takes, so a URL copied from the browser is forwarded to the API almost
// as-is - only `cardType` (from the path) and `page` (owned by the
// orchestrator) are filled in by this module.

import { BaseDownloader } from "../../core/modules/base.downloader.js";
import { registerModule } from "../../core/orchestrator/module.resolver.js";
import { buildBrowserHeaders } from "../../shared/http.client.js";
import { parseSourceUrl, pickParams, toQueryParams } from "../../shared/query.params.js";
import { base64ToHex, print } from "../../shared/utils.js";
import {
  API_BASE,
  CARD_TYPES,
  HOST,
  ORDER_TYPES,
  ORIGIN,
  PAGE_SIZE,
  SEARCH_PARAMS,
  cardDownloadUrl,
  cardFileName,
  cardFileUrl,
  cardPageUrl,
  cardTitle,
  cardTypeBySlug,
  extensionForCardType,
} from "./bepisdb.types.js";

// A handful of card types ship as .zip packages rather than .png. The type map
// covers the ones we know of; this is the "the map was wrong" fallback.
const FALLBACK_EXTENSION = "zip";

/**
 * Works out what a config.searches URL is actually asking for.
 *
 * Three shapes are supported, all of them URLs a user can copy out of the
 * browser:
 *   /koikatsu?tags=a,b        - a search, walked page by page
 *   /koikatsu/view/367885     - one specific card
 *   /user/1645                - everything one uploader posted
 *
 * @param {string} url
 * @returns {{ mode: 'search'|'single', cardType: string|null, cardId?: number, params: object }}
 */
function parseTarget(url) {
  const { host, segments, query } = parseSourceUrl(url);

  if (host !== HOST) {
    throw new Error(`Expected a ${HOST} URL, got "${host}"`);
  }

  const { params, unknown, invalid } = pickParams(query, SEARCH_PARAMS);

  if (unknown.length > 0) {
    print(`Ignoring unsupported BepisDB search parameters: ${unknown.join(", ")}`, "warning");
  }
  if (invalid.length > 0) {
    print(`Ignoring BepisDB search parameters with unusable values: ${invalid.join(", ")}`, "warning");
  }
  if (params.orderType && !ORDER_TYPES.includes(params.orderType)) {
    throw new Error(
      `Unknown orderType "${params.orderType}" - expected one of: ${ORDER_TYPES.join(", ")}`,
    );
  }

  const [first, second, third] = segments;

  if (first === "user") {
    const uploaderId = Number(second);
    if (!Number.isInteger(uploaderId)) {
      throw new Error(
        `A BepisDB user URL needs the numeric user id (e.g. ${ORIGIN}/user/1645); ` +
          `"${second}" is a vanity name this module cannot resolve`,
      );
    }
    // No cardType: an uploader's page spans every section, and each card in the
    // response says which type it is.
    return { mode: "search", cardType: null, params: { ...params, uploaderId } };
  }

  const cardType = cardTypeBySlug(first ?? "");
  if (!cardType) {
    throw new Error(
      `Unknown BepisDB section "${first ?? ""}" - expected one of: ${Object.keys(CARD_TYPES).join(", ")}`,
    );
  }

  if (second === "view") {
    const cardId = Number(third);
    if (!Number.isInteger(cardId)) {
      throw new Error(`Invalid card id "${third}" in ${url}`);
    }
    return { mode: "single", cardType: cardType.code, cardId, params: {} };
  }

  return { mode: "search", cardType: cardType.code, params };
}

export class BepisDbDownloader extends BaseDownloader {
  constructor(searchConfig, appConfig) {
    super(searchConfig, appConfig);

    this.target = parseTarget(searchConfig.url);
    this.currentPage = 0;
    this.orderingWarned = false;
  }

  /**
   * One page of search results, or the single card the URL points at. Both are
   * normalised to { cards, total } so the rest of the module doesn't care which
   * mode it is in.
   * @param {number} pageNumber
   * @returns {Promise<{ cards: object[], total: number|undefined }>}
   */
  async fetchPage(pageNumber) {
    this.currentPage = pageNumber;

    if (this.target.mode === "single") {
      if (pageNumber > 1) return { cards: [], total: 1 };

      const card = await this.requestApi(`${API_BASE}/card`, {
        cardType: this.target.cardType,
        id: this.target.cardId,
      });
      return { cards: [card], total: 1 };
    }

    this.warnAboutOrdering(pageNumber);

    const data = await this.requestApi(
      `${API_BASE}/search`,
      toQueryParams({
        ...this.target.params,
        ...(this.target.cardType ? { cardType: this.target.cardType } : {}),
        // The site's own frontend leaves `page` off for the first page; sending
        // the identical request keeps us on the same cached responses it uses.
        ...(pageNumber > 1 ? { page: pageNumber } : {}),
      }),
    );

    return { cards: data.cards ?? [], total: data.searchHitCount };
  }

  async parseItems(pageData) {
    return (pageData?.cards ?? []).map((card) => this.toItem(card));
  }

  getItemId(item) {
    return item.id;
  }

  hasNextPage(pageData) {
    if (this.target.mode === "single") return false;

    return this.hasNextPageByTotal({
      page: this.currentPage,
      pageSize: PAGE_SIZE,
      total: pageData?.total,
    });
  }

  /**
   * Saves one card. The download URL needs no auth and no session - it is a
   * plain GET on a CDN-backed path built from the card's type and id.
   * @param {object} item
   * @returns {Promise<string>} the saved file path
   */
  async downloadItem(item) {
    if (this.option("countDownload", false)) {
      await this.incrementDownloadCounter(item);
    }

    try {
      return await this.streamCard(item, item.extension);
    } catch (err) {
      // The type map says .png for almost everything; if a card turns out to be
      // a package instead, the .png simply is not there. Worth one more try.
      if (err.status === 404 && item.extension !== FALLBACK_EXTENSION) {
        print(
          `No .${item.extension} for ${item.id}, retrying as .${FALLBACK_EXTENSION}`,
          "warning",
        );
        return await this.streamCard(item, FALLBACK_EXTENSION);
      }
      throw err;
    }
  }

  // -- Internals --------------------------------------------------------------

  /**
   * Calls an /api/frontend endpoint and unwraps its { type, data } envelope.
   * A rejected request comes back as HTTP 200 with type "rejected", so the
   * envelope - not the status code - is what says whether it worked.
   * @param {string} url
   * @param {object} params
   * @returns {Promise<*>}
   */
  async requestApi(url, params) {
    const body = await this.getJson(url, params, {
      headers: buildBrowserHeaders({ referer: this.searchConfig.url }),
    });

    if (body?.type !== "success") {
      throw new Error(
        `BepisDB rejected the request: ${body?.error ?? body?.type ?? "unknown error"}`,
      );
    }

    return body.data;
  }

  /**
   * Turns an API card object into an orchestrator item. The full card object
   * rides along as `metadata`, which the orchestrator writes into the
   * .meta.json sidecar next to the downloaded file.
   * @param {object} card
   * @returns {object}
   */
  toItem(card) {
    const downloadUrl = cardDownloadUrl(card);
    const pageUrl = cardPageUrl(card);

    return {
      id: cardFileName(card),
      cardId: card.id,
      cardType: card.cardType,
      title: cardTitle(card),
      url: downloadUrl,
      pageUrl,
      extension: extensionForCardType(card.cardType),
      expectedSize: card.fileSize,
      // The API publishes the checksum in base64; hex is what a locally
      // computed digest can be compared against.
      sha256: card.sha256CardHash ? base64ToHex(card.sha256CardHash) : undefined,
      metadata: { ...card, pageUrl, downloadUrl },
    };
  }

  /**
   * Streams a card's file to disk under the given extension.
   * @param {object} item
   * @param {string} extension
   * @returns {Promise<string>}
   */
  async streamCard(item, extension) {
    const sha256 = this.option("verifyHash", true) ? item.sha256 : undefined;

    // The id in the file name keeps two cards with the same character name
    // apart at a glance; the timestamp buildItemPath() appends is what actually
    // guarantees they do not collide. Unnamed cards (scenes, presets) already
    // fall back to the id as their title - don't repeat it.
    const fileName = item.title === item.id ? item.id : `${item.title}_${item.id}`;

    const { filePath } = this.resolveItemPath({ ...item, title: fileName }, extension);

    await this.downloadToFile(cardFileUrl(item.id, extension), filePath, {
      headers: buildBrowserHeaders({ referer: item.pageUrl }),
      sha256,
      // A checksum already covers the length, so the size check only earns its
      // keep when there is no hash to verify against.
      expectedSize: sha256 ? undefined : item.expectedSize,
    });

    return filePath;
  }

  /**
   * Bumps the card's public download counter, the way the site's own Download
   * button does. Off by default; the file is served regardless, so a failure
   * here must never cost us the download.
   * @param {object} item
   */
  async incrementDownloadCounter(item) {
    try {
      await this.postForm(
        `${ORIGIN}/card/count`,
        { cardType: item.cardType, cardId: item.cardId },
        { headers: buildBrowserHeaders({ referer: item.pageUrl }) },
      );
    } catch (err) {
      print(
        `Could not increment the download counter for ${item.id}: ${err.message}`,
        "warning",
      );
    }
  }

  /**
   * Ordering that puts new uploads first makes a multi-page walk unstable:
   * anything uploaded mid-run shifts the remaining results down a slot and a
   * card can slip past unseen. Warn once, when it starts to matter.
   * @param {number} pageNumber
   */
  warnAboutOrdering(pageNumber) {
    if (this.orderingWarned || pageNumber < 2) return;

    const { orderType } = this.target.params;
    if (orderType && orderType !== "mostRecent" && orderType !== "random") return;

    this.orderingWarned = true;
    print(
      `"${this.searchConfig.name}" is paging through results ordered by ` +
        `${orderType ?? "the site default (mostRecent)"} - uploads made during the run ` +
        `shift results between pages, so a card can be missed. Add ` +
        `orderType=leastRecent to the URL for a stable walk.`,
      "warning",
    );
  }
}

registerModule(
  (url) => url.includes(HOST),
  (searchConfig, appConfig) => new BepisDbDownloader(searchConfig, appConfig),
);
