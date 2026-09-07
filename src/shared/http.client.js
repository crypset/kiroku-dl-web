import axios from "axios";
import { createHash } from "crypto";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";

// Shared HTTP layer for service modules: a browser-shaped axios client, a JSON
// GET helper, and a validating stream-to-disk downloader. Nothing here knows
// about any specific site - modules pass URLs in, files come out.

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT = 30000;

// A server asking us to back off for longer than this is treated as "too long
// to sit and wait" - the attempt fails and the orchestrator's own retry/skip
// logic takes over instead of blocking a worker for minutes.
const MAX_RETRY_AFTER_MS = 60000;

/**
 * Error carrying the HTTP status of a failed request, plus the server's
 * requested back-off (from Retry-After) when it sent one.
 */
export class HttpError extends Error {
  constructor(message, { status, url, retryAfterMs } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Creates an axios instance with browser-like defaults.
 *
 * Status codes are never thrown by axios itself (`validateStatus` always
 * passes) - the helpers below decide what counts as a failure, so a module can
 * inspect an error response instead of losing it inside an exception.
 *
 * @param {{ userAgent?: string, timeout?: number, headers?: object }} [options]
 * @returns {import("axios").AxiosInstance}
 */
export function createHttpClient({ userAgent, timeout, headers } = {}) {
  return axios.create({
    timeout: timeout ?? DEFAULT_TIMEOUT,
    maxRedirects: 5,
    headers: {
      "user-agent": userAgent ?? DEFAULT_USER_AGENT,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      ...headers,
    },
    validateStatus: () => true,
  });
}

/**
 * Per-request headers that make a call look like it came from a page on the
 * site rather than from a bare script.
 * @param {{ referer?: string, accept?: string }} [options]
 * @returns {object}
 */
export function buildBrowserHeaders({ referer, accept } = {}) {
  const headers = {};
  if (referer) headers.referer = referer;
  if (accept) headers.accept = accept;
  return headers;
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * @param {string|undefined} value
 * @returns {number|undefined}
 */
function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}

/**
 * Throws an HttpError unless the response came back 200.
 * @param {import("axios").AxiosResponse} response
 * @param {string} url
 */
function throwForStatus(response, url) {
  if (response.status === 200) return;

  const retryAfterMs = parseRetryAfter(response.headers?.["retry-after"]);
  throw new HttpError(`HTTP ${response.status} for ${url}`, {
    status: response.status,
    url,
    retryAfterMs:
      retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS
        ? retryAfterMs
        : undefined,
  });
}

/**
 * GETs a URL and returns the parsed JSON body.
 * @param {import("axios").AxiosInstance} client
 * @param {string} url
 * @param {object} [params] - query parameters
 * @param {{ headers?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<*>}
 */
export async function getJson(client, url, params = {}, { headers, signal } = {}) {
  const response = await client.get(url, { params, headers, signal });
  throwForStatus(response, url);
  return response.data;
}

/**
 * POSTs multipart/form-data and returns the parsed JSON body. Plenty of SPA
 * backends expect FormData rather than a JSON body.
 * @param {import("axios").AxiosInstance} client
 * @param {string} url
 * @param {Record<string, string|number|boolean>} [fields]
 * @param {{ headers?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<*>}
 */
export async function postForm(client, url, fields = {}, { headers, signal } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }

  const response = await client.post(url, form, { headers, signal });
  throwForStatus(response, url);
  return response.data;
}

/**
 * Streams a URL to disk, validating the response before anything is kept.
 *
 * Writes to `<filePath>.part` and renames only after every check passes, so an
 * interrupted or rejected download never leaves a half-written or bogus file
 * where a real one is expected. The usual failure this guards against: a site
 * answering a missing file with 404 and an HTML error page, which a naive
 * stream would happily save as a ".png".
 *
 * @param {import("axios").AxiosInstance} client
 * @param {string} url
 * @param {string} filePath - final destination
 * @param {{
 *   headers?: object,
 *   signal?: AbortSignal,
 *   expectedSize?: number,
 *   sha256?: string,
 *   rejectContentTypes?: RegExp[],
 * }} [options]
 * @returns {Promise<{ filePath: string, bytes: number, sha256: string|null }>}
 */
export async function downloadToFile(
  client,
  url,
  filePath,
  {
    headers,
    signal,
    expectedSize,
    sha256,
    rejectContentTypes = [/^text\/html/i],
  } = {},
) {
  const partPath = `${filePath}.part`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const response = await client.get(url, {
    responseType: "stream",
    headers,
    signal,
  });

  try {
    throwForStatus(response, url);

    const contentType = String(response.headers?.["content-type"] ?? "");
    if (rejectContentTypes.some((pattern) => pattern.test(contentType))) {
      throw new HttpError(
        `Expected a file at ${url} but got content-type "${contentType}"`,
        { status: response.status, url },
      );
    }
  } catch (err) {
    response.data?.destroy?.();
    throw err;
  }

  const hash = sha256 ? createHash("sha256") : null;
  let bytes = 0;

  try {
    await pipeline(
      response.data,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          hash?.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partPath),
      { signal },
    );

    if (expectedSize !== undefined && bytes !== expectedSize) {
      throw new Error(
        `Size mismatch for ${url}: expected ${expectedSize} bytes, got ${bytes}`,
      );
    }

    const digest = hash ? hash.digest("hex") : null;
    if (digest && digest !== sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for ${url}: expected sha256 ${sha256}, got ${digest}`,
      );
    }

    await fs.rename(partPath, filePath);
    return { filePath, bytes, sha256: digest };
  } catch (err) {
    response.data?.destroy?.();
    await fs.rm(partPath, { force: true });
    throw err;
  }
}
