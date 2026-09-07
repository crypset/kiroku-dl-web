// Shared helpers for modules whose source URL carries the search itself, i.e.
// the URL a user copies out of the browser's address bar. Splitting the URL
// apart and turning its query string into a typed, whitelisted set of API
// parameters is the same work on every such site, so it lives here rather than
// in each module.

/**
 * Splits a source URL into the parts a module needs to route on.
 *
 * @param {string} url
 * @returns {{ origin: string, host: string, pathname: string, segments: string[], query: Record<string, string> }}
 */
export function parseSourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Invalid URL "${url}": ${err.message}`);
  }

  return {
    origin: parsed.origin,
    host: parsed.host,
    pathname: parsed.pathname,
    segments: parsed.pathname.split("/").filter(Boolean),
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

/**
 * Converts one raw query value according to a declared type.
 * Returns undefined for values that shouldn't be forwarded at all.
 * @param {string} value
 * @param {'string'|'number'|'boolean'|'array'} type
 * @returns {string|number|boolean|string[]|undefined}
 */
function coerce(value, type) {
  const raw = value.trim();
  if (raw === "") return undefined;

  switch (type) {
    case "number": {
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    }
    case "boolean": {
      if (/^(true|1)$/i.test(raw)) return true;
      if (/^(false|0)$/i.test(raw)) return false;
      return undefined;
    }
    case "array": {
      const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    default:
      return raw;
  }
}

/**
 * Filters a query object down to the parameters a site actually accepts,
 * converting each to its declared type.
 *
 * Keys the schema doesn't mention are returned separately instead of being
 * silently dropped, so a module can warn about a typo'd or unsupported filter
 * rather than quietly downloading the wrong thing.
 *
 * @param {Record<string, string>} query
 * @param {Record<string, 'string'|'number'|'boolean'|'array'>} schema
 * @returns {{ params: Record<string, *>, unknown: string[], invalid: string[] }}
 */
export function pickParams(query, schema) {
  const params = {};
  const unknown = [];
  const invalid = [];

  for (const [key, value] of Object.entries(query)) {
    const type = schema[key];
    if (!type) {
      unknown.push(key);
      continue;
    }

    const coerced = coerce(value, type);
    if (coerced === undefined) {
      invalid.push(key);
      continue;
    }

    params[key] = coerced;
  }

  return { params, unknown, invalid };
}

/**
 * Flattens typed parameters into the string map an HTTP client expects.
 * Arrays are comma-joined; undefined/null values are dropped.
 * @param {Record<string, *>} params
 * @returns {Record<string, string>}
 */
export function toQueryParams(params) {
  const flat = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      flat[key] = value.join(",");
      continue;
    }

    flat[key] = String(value);
  }

  return flat;
}

/**
 * Same as toQueryParams(), rendered as a query string (no leading "?").
 * @param {Record<string, *>} params
 * @returns {string}
 */
export function toQueryString(params) {
  return new URLSearchParams(toQueryParams(params)).toString();
}
