import path from "path";

export const HOST = "nikke-db.pages.dev";
export const LEGACY_CDN = "https://nikke-db-legacy.pages.dev";
export const GALLERY_BASE = `${LEGACY_CDN}/images/gallery/`;
export const L2D_BASE = `${LEGACY_CDN}/l2d/`;
export const SPRITE_BASE = `${LEGACY_CDN}/images/sprite/si_`;
export const SPRITE_SUFFIX = "_00_s.png";

export const POSES = ["fb", "aim", "cover"];

export const POSE_LABELS = {
  fb: "Full Body",
  aim: "Aim",
  cover: "Cover",
};

export const POSE_ALIASES = {
  fb: "fb",
  fullbody: "fb",
  "full-body": "fb",
  full_body: "fb",
  idle: "fb",
  aim: "aim",
  aiming: "aim",
  cover: "cover",
  covering: "cover",
};

export const SEARCH_PARAMS = {
  pose: "string",
  character: "string",
  name: "string",
  id: "string",
  collection: "string",
  category: "string",
  limit: "number",
};

/**
 * Checks whether the URL is handled by the Nikke-DB module.
 * @param {string} url
 * @returns {boolean}
 */
export function isNikkeDbUrl(url) {
  if (typeof url !== "string") return false;
  return url.toLowerCase().includes(HOST);
}

/**
 * Parses a pose name or alias into a canonical pose key.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizePose(raw) {
  if (!raw || typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return POSE_ALIASES[key] ?? null;
}

/**
 * Resolves a list of requested poses from user query.
 * @param {string|string[]} [poseParam]
 * @returns {string[]}
 */
export function resolvePoses(poseParam) {
  if (!poseParam) return [...POSES];

  const rawList = Array.isArray(poseParam)
    ? poseParam
    : String(poseParam).split(",");

  const set = new Set();
  for (const item of rawList) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "all" || trimmed === "*") return [...POSES];
    const normalized = normalizePose(trimmed);
    if (normalized) set.add(normalized);
  }

  return set.size > 0 ? [...set] : [...POSES];
}

/**
 * Returns URLs and folder names for a given character and pose.
 * @param {string} characterId
 * @param {string} pose - 'fb', 'aim', 'cover'
 * @returns {{ fileBase: string, baseUrl: string, skelUrl: string, atlasUrl: string }}
 */
export function getL2dPoseInfo(characterId, pose) {
  const normPose = normalizePose(pose) || "fb";
  let folder = `${L2D_BASE}${characterId}/`;
  let fileBase = `${characterId}_00`;

  switch (normPose) {
    case "aim":
      folder += "aim/";
      fileBase = `${characterId}_aim_00`;
      break;
    case "cover":
      folder += "cover/";
      fileBase = `${characterId}_cover_00`;
      break;
    default:
      break;
  }

  return {
    fileBase,
    baseUrl: folder,
    skelUrl: `${folder}${fileBase}.skel`,
    atlasUrl: `${folder}${fileBase}.atlas`,
  };
}

/**
 * Extracts referenced texture filenames from a Spine .atlas text.
 * @param {string} atlasContent
 * @param {string} fallbackBase
 * @returns {string[]}
 */
export function parseAtlasTextures(atlasContent, fallbackBase) {
  if (!atlasContent || typeof atlasContent !== "string") {
    return [`${fallbackBase}.png`];
  }

  const textures = atlasContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith(".png"));

  return textures.length > 0 ? [...new Set(textures)] : [`${fallbackBase}.png`];
}
