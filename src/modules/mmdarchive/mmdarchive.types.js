import fs from "fs/promises";
import { createWriteStream } from "fs";
import https from "https";
import path from "path";
import { pipeline } from "stream/promises";
import { print } from "../../shared/utils.js";

export const HOST = "mmda.booru.org";
export const PAGE_SIZE = 20;

/**
 * Dedicated HTTPS agent with disabled leaf signature validation for tstorage.info,
 * which commonly serves an incomplete intermediate certificate chain causing
 * Node.js UNABLE_TO_VERIFY_LEAF_SIGNATURE errors.
 */
export const tstorageAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

/**
 * Validates whether a URL belongs to mmda.booru.org (or other booru.org subdomains).
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isMmdaBooruUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === HOST ||
      parsed.hostname === "booru.org" ||
      parsed.hostname.endsWith(".booru.org")
    );
  } catch {
    return false;
  }
}

/**
 * Validates whether a URL belongs to tstorage.info.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isTstorageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === "tstorage.info" || parsed.hostname.endsWith(".tstorage.info");
  } catch {
    return false;
  }
}

/**
 * Extracts all HTTP/HTTPS URLs from arbitrary text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map((u) => u.replace(/[.,;!)]+$/, "")))];
}

/**
 * Extracts password hints or passcodes frequently left in comment bodies.
 * @param {string} text
 * @returns {string[]}
 */
export function extractPasswordHints(text) {
  if (!text) return [];
  const hints = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/(?:password|pass|pw|passcode|passphrase|鍵|パス|パスワード)/i.test(line)) {
      hints.push(line.trim());
    }
  }
  return [...new Set(hints)];
}

/**
 * Loads tstorage authentication cookies from configured paths or default locations.
 * Supports:
 * - Direct cookie string (options.cookie)
 * - Custom cookie file (options.cookieFile)
 * - JSON array format from browser extensions ([{ name: "...", value: "..." }])
 * - JSON object format ({ "xfss": "..." } or { "cookie": "..." })
 * - Netscape cookies.txt or standard "name=value; name2=value2" header format
 *
 * @param {object} searchConfig
 * @returns {Promise<string|null>}
 */
export async function loadTstorageCookie(searchConfig) {
  // 1. Direct cookie string in options
  if (typeof searchConfig?.options?.cookie === "string" && searchConfig.options.cookie.trim()) {
    return searchConfig.options.cookie.trim();
  }

  // 2. Candidate cookie files
  const candidateFiles = [];
  if (searchConfig?.options?.cookieFile) {
    candidateFiles.push(searchConfig.options.cookieFile);
  }
  candidateFiles.push(
    path.resolve(process.cwd(), "data", "cookies", "tstorage.json"),
    path.resolve(process.cwd(), "data", "cookies", "tstorage.txt"),
  );

  for (const filePath of candidateFiles) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseCookieContent(content);
      if (parsed) {
        return parsed;
      }
    } catch {
      // File does not exist, check next
    }
  }

  return null;
}

/**
 * Parses raw file content into a standard Cookie header string.
 * @param {string} rawContent
 * @returns {string|null}
 */
export function parseCookieContent(rawContent) {
  const trimmed = rawContent.trim();
  if (!trimmed) return null;

  // Try JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);

      // Array export from Cookie-Editor / EditThisCookie: [{ name: "xfss", value: "..." }]
      if (Array.isArray(json)) {
        const pairs = json
          .filter((item) => item && typeof item.name === "string" && item.value !== undefined)
          .map((item) => `${item.name}=${item.value}`);
        return pairs.length > 0 ? pairs.join("; ") : null;
      }

      // Single object: { "xfss": "..." } or { "cookie": "xfss=..." }
      if (typeof json === "object" && json !== null) {
        if (typeof json.cookie === "string" && json.cookie.trim()) {
          return json.cookie.trim();
        }
        const pairs = Object.entries(json)
          .filter(([k, v]) => typeof k === "string" && v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${v}`);
        return pairs.length > 0 ? pairs.join("; ") : null;
      }
    } catch {
      // Fall through to plain text parsing
    }
  }

  // Netscape cookies.txt format (tab-separated)
  const lines = trimmed.split(/\r?\n/);
  const cookiePairs = [];

  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;

    const parts = l.split("\t");
    if (parts.length >= 7) {
      const name = parts[5].trim();
      const value = parts[6].trim();
      if (name) cookiePairs.push(`${name}=${value}`);
    } else if (l.includes("=")) {
      // Line is standard name=value or multiple pairs
      cookiePairs.push(l.replace(/;\s*$/, ""));
    }
  }

  return cookiePairs.length > 0 ? cookiePairs.join("; ") : trimmed;
}

/**
 * Parses a Booru list page HTML into post stubs and pagination information.
 * @param {string} html
 * @returns {{ posts: object[], hasNext: boolean, lastPid: number|null }}
 */
export function parseListPage(html) {
  const posts = [];

  // Match embedded javascript posts metadata:
  // posts[2452] = {'tags':'...'.split(/ /g), 'rating':'Safe', 'score':10, 'user':'yraaa'}
  const scriptData = new Map();
  const scriptMatches = [
    ...html.matchAll(
      /posts\[(\d+)\]\s*=\s*\{'tags':['"]([^'"]*)['"]\.split\(\/[^/]+\/g\),\s*'rating':['"]([^'"]*)['"],\s*'score':(-?\d+),\s*'user':['"]([^'"]*)['"]\}/g,
    ),
  ];
  for (const match of scriptMatches) {
    const id = match[1];
    const rawTags = match[2] || "";
    scriptData.set(id, {
      tags: rawTags.split(/\s+/).filter(Boolean),
      rating: match[3] || "Unknown",
      score: parseInt(match[4], 10) || 0,
      user: match[5] || "anonymous",
    });
  }

  // Match post anchors: <span class="thumb"><a id="p2452" href="index.php?page=post&amp;s=view&amp;id=2452"><img src="..." .../></a></span>
  const anchorMatches = [
    ...html.matchAll(
      /<a[^>]*id=['"]?p(\d+)['"]?[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];

  for (const match of anchorMatches) {
    const id = match[1];
    const rawHref = match[2].replace(/&amp;/g, "&");
    const innerHtml = match[3];

    const thumbMatch = innerHtml.match(/src=['"]([^'"]+)['"]/i);
    const thumbUrl = thumbMatch ? thumbMatch[1] : null;

    const extra = scriptData.get(id) || {
      tags: [],
      rating: "Unknown",
      score: 0,
      user: "anonymous",
    };

    posts.push({
      id,
      viewUrl: rawHref.startsWith("http")
        ? rawHref
        : `https://${HOST}/${rawHref.replace(/^\/+/, "")}`,
      thumbUrl,
      ...extra,
    });
  }

  // Check pagination
  const paginatorMatch = html.match(/<div id=['"]?paginator['"]?[^>]*>([\s\S]*?)<\/div>/i);
  let hasNext = false;
  let lastPid = null;

  if (paginatorMatch) {
    const pBody = paginatorMatch[1];
    // Check next page arrow
    if (/alt=['"]next['"]/i.test(pBody) || /&gt;<\/a>/i.test(pBody)) {
      hasNext = true;
    }
    const lastPidMatch = pBody.match(/pid=(\d+)[^'"]*['"]\s+alt=['"]last page['"]/i);
    if (lastPidMatch) {
      lastPid = parseInt(lastPidMatch[1], 10);
    }
  }

  return { posts, hasNext, lastPid };
}

/**
 * Parses a Booru view page HTML into full item details.
 * @param {string} html
 * @param {string} postId
 * @returns {object}
 */
export function parseViewPage(html, postId) {
  // Title
  const titleMatch = html.match(/<input[^>]*id=['"]?title['"]?[^>]*value=['"]([^'"]*)['"]/i);
  const title = (titleMatch ? titleMatch[1] : "").trim();

  // Full image URL
  const imgMatch =
    html.match(/<img[^>]+id=['"]image['"][^>]*>/i) ||
    html.match(/<img[^>]+src=['"]([^'"]+)['"][^>]*id=['"]image['"]/i);
  let imageUrl = null;
  if (imgMatch) {
    const srcMatch = imgMatch[0].match(/src=['"]([^'"]+)['"]/i);
    imageUrl = srcMatch ? srcMatch[1] : null;
  }

  // Source URL
  const srcInputMatch = html.match(/<input[^>]*id=['"]?source['"]?[^>]*value=['"]([^'"]*)['"]/i);
  const srcLinkMatch = html.match(/Source:\s*<a[^>]*href=['"]([^'"]+)['"]/i);
  const srcTextMatch = html.match(/Source:\s*([^\s<]+)/i);
  const source = (
    (srcInputMatch ? srcInputMatch[1] : null) ||
    (srcLinkMatch ? srcLinkMatch[1] : null) ||
    (srcTextMatch ? srcTextMatch[1] : null) ||
    ""
  ).trim();

  // Tags
  const tagsMatch = html.match(/<textarea[^>]*id=['"]?tags['"]?[^>]*>([\s\S]*?)<\/textarea>/i);
  const tags = tagsMatch ? tagsMatch[1].trim().split(/\s+/).filter(Boolean) : [];

  // Comments (<div id="c49971" ...> ... </div>)
  const commentBlocks = [...html.matchAll(/<div[^>]*id=['"](c\d+)['"][^>]*>([\s\S]*?)<\/div>/gi)];
  const comments = [];
  const allCandidateUrls = new Set();
  const allPasswordHints = new Set();

  if (source && /^https?:\/\//i.test(source)) {
    allCandidateUrls.add(source);
  }

  for (const match of commentBlocks) {
    const cId = match[1].replace(/^c/, "");
    const block = match[2];

    const authorMatch = block.match(/uname=([^'">]+)/i) || block.match(/<a[^>]*>([^<]+)<\/a>/i);
    const author = authorMatch ? authorMatch[1] : "anonymous";

    const dateMatch = block.match(/Posted on ([^<\n\r]+?)(?:\s+Score:|$)/i);
    const postedAt = dateMatch ? dateMatch[1].trim() : null;

    const scoreMatch = block.match(/<a id=['"]sc\d+['"]>(\d+)<\/a>/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    // Separate header from comment body using the last </b> closing tag
    const lastHeaderClose = block.lastIndexOf("</b>");
    const rawBody = lastHeaderClose !== -1 ? block.slice(lastHeaderClose + 4) : block;

    const text = rawBody
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();

    const urls = extractUrls(text);
    urls.forEach((u) => allCandidateUrls.add(u));

    const pwHints = extractPasswordHints(text);
    pwHints.forEach((h) => allPasswordHints.add(h));

    comments.push({
      id: cId,
      author,
      postedAt,
      score,
      text,
      urls,
      passwordHints: pwHints,
    });
  }

  return {
    id: postId,
    title,
    imageUrl,
    source,
    tags,
    comments,
    candidateLinks: [...allCandidateUrls],
    passwordHints: [...allPasswordHints],
  };
}

/**
 * Lightweight cookie jar for tracking session cookies and handling
 * intermediate Set-Cookie headers across multi-hop redirects.
 */
export class CookieJar {
  constructor(initialCookieHeader = "") {
    this.cookies = new Map();
    if (initialCookieHeader) {
      this.addFromHeader(initialCookieHeader);
    }
  }

  addFromHeader(headerStr) {
    if (!headerStr) return;
    const parts = headerStr.split(";");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key) this.cookies.set(key, val);
      }
    }
  }

  addFromSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const item of list) {
      const cookiePart = item.split(";")[0].trim();
      const eqIdx = cookiePart.indexOf("=");
      if (eqIdx !== -1) {
        const key = cookiePart.slice(0, eqIdx).trim();
        const val = cookiePart.slice(eqIdx + 1).trim();
        if (key) this.cookies.set(key, val);
      }
    }
  }

  toHeaderString() {
    const pairs = [];
    for (const [k, v] of this.cookies) {
      pairs.push(`${k}=${v}`);
    }
    return pairs.join("; ");
  }
}

/**
 * Executes an HTTP request following redirects manually while collecting and
 * forwarding Set-Cookie headers at every hop. Crucial for hosts like tstorage.info
 * which set intermediate session cookies (e.g. file_code=...) during 302 redirects.
 *
 * @param {import("axios").AxiosInstance} client
 * @param {object} config
 * @param {CookieJar} jar
 * @param {number} [maxRedirects=5]
 * @returns {Promise<import("axios").AxiosResponse & { finalUrl: string }>}
 */
export async function requestWithCookieJar(client, config, jar, maxRedirects = 5) {
  let currentUrl = config.url;
  let currentMethod = config.method || "GET";
  let currentData = config.data;
  let currentHeaders = { ...config.headers };

  for (let hop = 0; hop < maxRedirects; hop++) {
    currentHeaders["Cookie"] = jar.toHeaderString();
    const res = await client.request({
      ...config,
      url: currentUrl,
      method: currentMethod,
      data: currentData,
      headers: currentHeaders,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (res.headers["set-cookie"]) {
      jar.addFromSetCookie(res.headers["set-cookie"]);
    }

    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers["location"]) {
      const nextUrl = new URL(res.headers["location"], currentUrl).toString();
      currentHeaders["Referer"] = currentUrl;
      currentUrl = nextUrl;
      if (res.status === 302 || res.status === 303) {
        currentMethod = "GET";
        currentData = undefined;
        delete currentHeaders["Content-Type"];
      }
      continue;
    }

    return { ...res, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

/**
 * Cleans and fixes potential latin1-to-utf8 mojibake in filenames from servers.
 * @param {string} rawName
 * @returns {string}
 */
export function cleanFilename(rawName) {
  if (!rawName) return "model_archive.zip";
  try {
    let decoded = decodeURIComponent(rawName);
    // Fix ISO-8859-1 (binary) encoded UTF-8 strings common in Apache/XFilesharing headers
    if (/[\xC0-\xFF]/.test(decoded)) {
      try {
        const fixed = Buffer.from(decoded, "binary").toString("utf8");
        if (fixed && !fixed.includes("\uFFFD")) {
          decoded = fixed;
        }
      } catch {
        // Fall back to decoded
      }
    }
    // Remove characters illegal in Windows filenames
    return (
      decoded.replace(/[\x00-\x1f\x7f:*?"<>|]/g, "_").trim() || "model_archive.zip"
    );
  } catch {
    return rawName.replace(/[\x00-\x1f\x7f:*?"<>|]/g, "_").trim() || "model_archive.zip";
  }
}

/**
 * Resolves and downloads an archive file from tstorage.info using authenticated session cookies.
 * Handles the multi-hop 302 redirect cycle with Set-Cookie preservation, submits Form F1,
 * and streams the direct download archive to disk.
 *
 * @param {string} rawUrl
 * @param {string|null} cookieHeader
 * @param {string} destinationDir
 * @param {import("axios").AxiosInstance} httpClient
 * @returns {Promise<{ status: string, filename?: string, filePath?: string, bytes?: number, reason?: string }>}
 */
export async function resolveTstorageDownload(
  rawUrl,
  cookieHeader,
  destinationDir,
  httpClient,
) {
  try {
    const jar = new CookieJar(cookieHeader);
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    // 1. Initial page GET through redirect loop
    // Captures intermediate Set-Cookie (e.g. file_code=...)
    const pageRes = await requestWithCookieJar(
      httpClient,
      {
        url: rawUrl,
        method: "GET",
        headers,
        httpsAgent: tstorageAgent,
      },
      jar,
    );

    const bodyText = typeof pageRes.data === "string" ? pageRes.data : "";

    // Check for expired or removed file
    if (
      bodyText.includes("File Not Found") ||
      bodyText.includes("No such file") ||
      bodyText.includes("File has been removed") ||
      bodyText.includes("file was deleted")
    ) {
      return { status: "not_found", reason: "File expired or removed on tstorage.info" };
    }

    // Check if initial response was already a direct file stream
    const contentType = pageRes.headers?.["content-type"] || "";
    const disposition = pageRes.headers?.["content-disposition"] || "";

    if (
      contentType.includes("application/") &&
      !contentType.includes("html") &&
      !contentType.includes("json")
    ) {
      const filename = cleanFilename(
        extractFilenameFromDisposition(disposition) ||
          path.basename(new URL(pageRes.finalUrl).pathname),
      );
      const filePath = path.join(destinationDir, filename);
      await fs.writeFile(filePath, Buffer.from(pageRes.data));
      const stats = await fs.stat(filePath);
      return { status: "downloaded", filename, filePath, bytes: stats.size };
    }

    // 2. Parse XFilesharing download form (name="F1" or method="POST")
    const formMatch =
      bodyText.match(/<form[^>]*name=['"]F1['"][^>]*>([\s\S]*?)<\/form>/i) ||
      bodyText.match(/<form[^>]*action=['"][^'"]*['"][^>]*>([\s\S]*?)<\/form>/i);

    let directDownloadUrl = null;

    if (formMatch) {
      const formHtml = formMatch[0];
      const formActionMatch = formHtml.match(/action=['"]([^'"]*)['"]/i);
      const postUrl =
        formActionMatch && formActionMatch[1]
          ? new URL(formActionMatch[1], pageRes.finalUrl).toString()
          : pageRes.finalUrl;

      // Extract hidden inputs
      const fields = {};
      const inputMatches = [...formHtml.matchAll(/<input[^>]+name=['"]([^'"]+)['"][^>]*>/gi)];
      for (const input of inputMatches) {
        const tag = input[0];
        const name = input[1];
        const valMatch = tag.match(/value=['"]([^'"]*)['"]/i);
        fields[name] = valMatch ? valMatch[1] : "";
      }

      fields.op = "download2";
      if (!fields.id) {
        const codeMatch = rawUrl.match(/tstorage\.info\/([a-z0-9]+)/i);
        if (codeMatch) fields.id = codeMatch[1];
      }
      fields.referer = rawUrl;

      const formBody = new URLSearchParams(fields).toString();
      const postRes = await httpClient.post(postUrl, formBody, {
        headers: {
          ...headers,
          Cookie: jar.toHeaderString(),
          Referer: pageRes.finalUrl,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        httpsAgent: tstorageAgent,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      if (postRes.headers["set-cookie"]) {
        jar.addFromSetCookie(postRes.headers["set-cookie"]);
      }

      if ([301, 302, 303, 307, 308].includes(postRes.status) && postRes.headers["location"]) {
        directDownloadUrl = postRes.headers["location"];
      } else {
        const postHtml = String(postRes.data);
        const directLinkMatch =
          postHtml.match(
            /<a[^>]*href=['"](https?:\/\/[^'"]*tstorage\.info:\d+\/d\/[^'"]+)['"]/i,
          ) ||
          postHtml.match(
            /<a[^>]*href=['"](https?:\/\/[^'"]+\.(?:zip|rar|7z|tar|gz)[^'"]*)['"]/i,
          ) ||
          postHtml.match(/<a[^>]*class=['"]btn_download['"][^>]*href=['"]([^'"]+)['"]/i);
        if (directLinkMatch) {
          directDownloadUrl = directLinkMatch[1];
        }
      }
    }

    if (!directDownloadUrl) {
      return {
        status: "unresolved",
        reason: "Could not obtain direct download link from tstorage.info page",
      };
    }

    // 3. Stream download directly to .part file, then rename
    const parsedDlUrl = new URL(directDownloadUrl);
    const rawNameFromUrl = path.basename(parsedDlUrl.pathname);
    let resolvedFilename = cleanFilename(rawNameFromUrl);

    const partPath = path.join(destinationDir, `${resolvedFilename}.part`);

    const dlStreamRes = await httpClient.get(directDownloadUrl, {
      headers: {
        ...headers,
        Cookie: jar.toHeaderString(),
        Referer: pageRes.finalUrl,
      },
      httpsAgent: tstorageAgent,
      responseType: "stream",
      validateStatus: () => true,
    });

    if (dlStreamRes.status !== 200) {
      return {
        status: "error",
        reason: `HTTP ${dlStreamRes.status} downloading file stream from ${directDownloadUrl}`,
      };
    }

    const streamDisposition = dlStreamRes.headers?.["content-disposition"] || "";
    const dispName = extractFilenameFromDisposition(streamDisposition);
    if (dispName) {
      resolvedFilename = cleanFilename(dispName);
    }

    const finalPath = path.join(destinationDir, resolvedFilename);

    await pipeline(dlStreamRes.data, createWriteStream(partPath));
    await fs.rename(partPath, finalPath);

    const stats = await fs.stat(finalPath);
    return {
      status: "downloaded",
      filename: resolvedFilename,
      filePath: finalPath,
      bytes: stats.size,
    };
  } catch (err) {
    return {
      status: "error",
      reason: err.message,
    };
  }
}

/**
 * Extracts a filename from a Content-Disposition header.
 * @param {string} disposition
 * @returns {string|null}
 */
export function extractFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const match =
    disposition.match(/filename\*=UTF-8''([^;]+)/i) ||
    disposition.match(/filename=['"]?([^'";]+)['"]?/i);
  return match ? decodeURIComponent(match[1].trim()) : null;
}
