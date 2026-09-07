// Site-specific facts about db.bepis.moe (BepisDB), kept apart from the
// downloader itself: this is the part that breaks if the site changes, so it is
// all in one place and free of I/O.
//
// Everything below was read out of the site's frontend bundle (main-*.js) and
// verified against the live API - see docs/services/db.bepis.moe/API.md.

export const HOST = "db.bepis.moe";
export const ORIGIN = `https://${HOST}`;
export const API_BASE = `${ORIGIN}/api/frontend`;

/** Cards returned per page by /api/frontend/search. */
export const PAGE_SIZE = 24;

/** Extension used by every card type that doesn't declare its own. */
export const DEFAULT_EXTENSION = "png";

/**
 * URL slug -> card type, for the sections hosted on db.bepis.moe.
 * (The Sims 4 and SillyTavern sections of the same codebase live on other
 * domains, so they're deliberately absent.)
 */
export const CARD_TYPES = {
  koikatsu:   { code: "KK",         name: "Koikatsu" },
  kkscenes:   { code: "KKSCENE",    name: "Koikatsu Scenes" },
  kkclothing: { code: "KKCLOTHING", name: "Koikatsu Clothing" },
  aa2:        { code: "AA2",        name: "Artificial Academy 2" },
  aa2scenes:  { code: "AA2SCENE",   name: "Artificial Academy 2 Scenes" },
  honeyselect:{ code: "HS",         name: "Honey Select" },
  playhome:   { code: "PH",         name: "Play Home" },
  aishoujo:   { code: "AI",         name: "AI Shoujo / Honey Select 2" },
  aiscenes:   { code: "AISCENE",    name: "AI Shoujo Scenes" },
  com3d2:     { code: "COM3D2",     name: "Custom Order Maid 3D 2", extension: "preset" },
  summerheat: { code: "SH",         name: "Summer Heat" },
  honeycome:  { code: "HC",         name: "Honey Come" },
  svs:        { code: "SVS",        name: "Summer Vacation Scramble" },
  aicomi:     { code: "AC",         name: "Aicomi" },
  roomgirl:   { code: "RG",         name: "Room Girl" },
  koidays:    { code: "KD",         name: "Koi Days" },
};

/**
 * Query parameters /api/frontend/search accepts, with the type each one is
 * sent as. These are exactly the keys the site's own frontend reads out of
 * window.location.search, which is why a URL copied from the browser can be
 * forwarded to the API as-is.
 *
 * `cardType` is absent on purpose (it comes from the URL path) and so is
 * `page` (the orchestrator's pagination loop owns it).
 */
export const SEARCH_PARAMS = {
  tags: "array",
  name: "string",
  cardAuthor: "string",
  personality: "number",
  gender: "string",
  gameType: "number",
  sceneMaleCount: "string",
  sceneFemaleCount: "string",
  uploaderId: "number",
  isModded: "boolean",
  simName: "string",
  bathroomCount: "string",
  bedroomCount: "string",
  lotSize: "string",
  isFeatured: "boolean",
  includeHidden: "boolean",
  orderType: "string",
  seed: "number",
};

/** Accepted values for the `orderType` search parameter. */
export const ORDER_TYPES = [
  "mostRecent",
  "leastRecent",
  "mostPopular",
  "mostPopularWeek",
  "mostPopularMonth",
  "highestVoted",
  "lowestVoted",
  "random",
];

// Card types whose display name is built from the character's name fields.
const NAME_FROM_FIRST_LAST = new Set(["KK", "AA2", "HC", "SVS", "AC"]);
const NAME_FROM_NAME = new Set(["HS", "AI", "KKCLOTHING", "KD", "RG"]);

/**
 * Looks up a card type by its URL slug (e.g. "koikatsu").
 * @param {string} slug
 * @returns {{ code: string, name: string, extension?: string }|null}
 */
export function cardTypeBySlug(slug) {
  return CARD_TYPES[String(slug).toLowerCase()] ?? null;
}

/**
 * The URL slug for a card type code (e.g. "KK" -> "koikatsu").
 * @param {string} code
 * @returns {string|null}
 */
export function slugForCardType(code) {
  const entry = Object.entries(CARD_TYPES).find(([, type]) => type.code === code);
  return entry ? entry[0] : null;
}

/**
 * File extension used by a card type's full download.
 * @param {string} code
 * @returns {string}
 */
export function extensionForCardType(code) {
  const entry = Object.values(CARD_TYPES).find((type) => type.code === code);
  return entry?.extension ?? DEFAULT_EXTENSION;
}

/**
 * The site's own file naming: "KK_367885" - card type code, then the id
 * zero-padded to six digits.
 * @param {{ cardType: string, id: number }} card
 * @returns {string}
 */
export function cardFileName(card) {
  return `${card.cardType}_${String(card.id).padStart(6, "0")}`;
}

/**
 * Direct download URL for a card file, by name and extension. Kept separate
 * from cardDownloadUrl() because the extension isn't always the mapped one -
 * see the .zip fallback in the downloader.
 * @param {string} fileName - e.g. "KK_367885"
 * @param {string} extension
 * @returns {string}
 */
export function cardFileUrl(fileName, extension) {
  return `${ORIGIN}/card/full/${fileName}.${extension}`;
}

/**
 * Direct download URL for a card's full file.
 * @param {{ cardType: string, id: number }} card
 * @returns {string}
 */
export function cardDownloadUrl(card) {
  return cardFileUrl(cardFileName(card), extensionForCardType(card.cardType));
}

/**
 * The human-facing page for a card, useful as a Referer and in metadata.
 * @param {{ cardType: string, id: number }} card
 * @returns {string}
 */
export function cardPageUrl(card) {
  const slug = slugForCardType(card.cardType);
  return slug ? `${ORIGIN}/${slug}/view/${card.id}` : `${ORIGIN}/card/${card.id}`;
}

/**
 * The name the site would show for a card. Scenes carry no name at all, and
 * plenty of cards leave their name fields empty, so this falls back to the
 * file name ("KKSCENE_079732") rather than inventing something.
 * @param {object} card
 * @returns {string}
 */
export function cardTitle(card) {
  const custom = card.customName?.trim();
  if (custom) return custom;

  const data = card.cardData ?? {};

  if (NAME_FROM_FIRST_LAST.has(card.cardType)) {
    const name = `${data.lastName ?? ""} ${data.firstName ?? ""}`.trim();
    if (name) return name;
  } else if (NAME_FROM_NAME.has(card.cardType)) {
    const name = data.name?.trim();
    if (name) return name;
  }

  return cardFileName(card);
}
