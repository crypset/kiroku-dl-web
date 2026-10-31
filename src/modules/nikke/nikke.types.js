import path from "path";

export const API_BASE = "https://na-community.playerinfinite.com";
export const CONTENT_ENDPOINT =
  "/api/gpts.information_feeds_svr.InformationFeedsSvr/GetContentByLabel";

export const PRIMARY_LABEL_ID = 4114; // "official_art_gallery"
export const CONTENT_CLASS = 1;
export const GAME_ID = "16";
export const SOURCE_TYPE = "pc_web";
export const PAGE_SIZE = 10;

export const SUPPORTED_HOSTS = [
  "nikke-en.com",
  "nikke-jp.com",
  "nikke-kr.com",
  "nikke-sea.com",
];

export const HOST_LANGUAGES = {
  "nikke-jp.com": "ja",
  "nikke-kr.com": "ko",
  "nikke-en.com": "en",
  "nikke-sea.com": "en",
};

/**
 * Supported art gallery categories.
 */
export const CATEGORIES = {
  wallpaper: {
    id: 1864,
    key: "wallpaper",
    name: "Wallpapers",
    subfolder: "wallpapers",
    defaultExtension: "png",
  },
  avatar: {
    id: 1865,
    key: "avatar",
    name: "Avatars",
    subfolder: "avatars",
    defaultExtension: "png",
  },
  live_wallpaper: {
    id: 1866,
    key: "live_wallpaper",
    name: "Live Wallpapers",
    subfolder: "live_wallpapers",
    defaultExtension: "zip",
  },
  mmd: {
    id: 1867,
    key: "mmd",
    name: "MMD 3D Models",
    subfolder: "mmd",
    defaultExtension: "zip",
  },
};

const CATEGORY_ALIASES = {
  wallpapers: "wallpaper",
  wallpaper: "wallpaper",
  avatars: "avatar",
  avatar: "avatar",
  live_wallpapers: "live_wallpaper",
  live_wallpaper: "live_wallpaper",
  livewallpaper: "live_wallpaper",
  live: "live_wallpaper",
  poster: "live_wallpaper",
  banner: "live_wallpaper",
  banners: "live_wallpaper",
  mmd: "mmd",
  models: "mmd",
  model: "mmd",
  "3d": "mmd",
};

export const ORIENTATION_LABELS = {
  horizontal: "2626",
  vertical: "2627",
  vertical1080: "2650",
};

export const SEARCH_PARAMS = {
  type: "string",
  orientation: "string",
  lang: "string",
};

/**
 * Checks whether the URL is a supported Goddess of Victory: NIKKE website URL.
 * @param {string} url
 * @returns {boolean}
 */
export function isNikkeUrl(url) {
  if (typeof url !== "string") return false;
  return SUPPORTED_HOSTS.some((host) => url.toLowerCase().includes(host));
}

/**
 * Resolves category key from an alias/name.
 * @param {string} name
 * @returns {string|null}
 */
export function resolveCategoryKey(name) {
  if (!name || typeof name !== "string") return null;
  const normalized = name.toLowerCase().trim();
  return CATEGORY_ALIASES[normalized] ?? null;
}

/**
 * Parses user-supplied type parameter into a list of resolved category objects.
 * If null, empty, or 'all', returns all available categories.
 * @param {string|string[]} [typeParam]
 * @returns {Array<typeof CATEGORIES[keyof typeof CATEGORIES]>}
 */
export function resolveActiveCategories(typeParam) {
  if (!typeParam) return Object.values(CATEGORIES);

  const rawList = Array.isArray(typeParam)
    ? typeParam
    : String(typeParam).split(",");

  const resolvedKeys = new Set();
  for (const item of rawList) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "all" || trimmed === "*") {
      return Object.values(CATEGORIES);
    }
    const resolved = resolveCategoryKey(trimmed);
    if (resolved && CATEGORIES[resolved]) {
      resolvedKeys.add(resolved);
    }
  }

  if (resolvedKeys.size === 0) {
    return Object.values(CATEGORIES);
  }

  return [...resolvedKeys].map((key) => CATEGORIES[key]);
}

/**
 * Cleans download URLs, fixing known CMS typos (like .zipo).
 * @param {string} url
 * @returns {string}
 */
export function cleanDownloadUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/\.zipo$/i, ".zip");
}

/**
 * Extracts a lowercase file extension from a URL (e.g. "zip", "png", "jpg").
 * @param {string} url
 * @param {string} [fallback="png"]
 * @returns {string}
 */
export function extractExtension(url, fallback = "png") {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).replace(/^\./, "").toLowerCase();
    if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {}
  return fallback;
}

/**
 * Builds request headers required by the PlayerInfinite / Level Infinite CMS API.
 * @param {{ language: string, areaId?: string, referer?: string }} options
 * @returns {Record<string, string>}
 */
export function buildNikkeHeaders({ language, areaId = "na", referer }) {
  const ref = referer || "https://nikke-en.com/";
  let origin = "https://nikke-en.com";
  try {
    origin = new URL(ref).origin;
  } catch {}

  return {
    "X-GameId": GAME_ID,
    "X-AreaId": areaId,
    "X-Source": SOURCE_TYPE,
    "X-Language": language || "en",
    "Content-Type": "application/json;charset=utf-8",
    Referer: ref,
    Origin: origin,
  };
}
