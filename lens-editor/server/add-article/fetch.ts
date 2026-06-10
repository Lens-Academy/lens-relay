import { assertPublicUrl } from "./ssrf";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_REDIRECTS = 5;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Fetch the raw HTML of an article page. Throws on non-OK or oversized
 * responses. Redirects are followed manually so the SSRF guard re-runs on
 * every hop — `redirect: 'follow'` would let an allowed page bounce to an
 * internal host without re-validation.
 */
export async function fetchRawHtml(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const resp = await fetch(current, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(`Redirect ${resp.status} with no Location header`);
      }
      current = new URL(location, current).href; // resolve relative redirects
      continue;
    }

    if (!resp.ok) {
      throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) {
      throw new Error(`Page too large: ${buf.byteLength} bytes`);
    }
    return new TextDecoder("utf-8").decode(buf);
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`);
}

export interface JinaResult {
  markdown: string;
  title: string;
  published: string; // YYYY-MM-DD or ''
}

/**
 * Extract article markdown via the Jina Reader API (r.jina.ai).
 * Response format (text/plain):
 *   Title: ...
 *   URL Source: ...
 *   Published Time: ... (optional)
 *   Markdown Content:
 *   ...
 */
export async function fetchJina(url: string): Promise<JinaResult> {
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Jina fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return parseJinaResponse(await resp.text());
}

export function parseJinaResponse(text: string): JinaResult {
  const result: JinaResult = { markdown: "", title: "", published: "" };
  const lines = text.split("\n");
  const contentLines: string[] = [];
  let inContent = false;

  for (const line of lines) {
    if (inContent) {
      contentLines.push(line);
    } else if (line.startsWith("Title:")) {
      result.title = line.slice(6).trim();
    } else if (line.startsWith("Published Time:")) {
      const dateStr = line.slice(15).trim();
      // ISO timestamp → date part only
      const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) result.published = match[1];
    } else if (line.startsWith("Markdown Content:")) {
      inContent = true;
    }
  }

  result.markdown = contentLines.join("\n").trim();
  return result;
}

export interface HtmlMeta {
  title: string;
  author: string[];
  published: string;
  description: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/** Find <meta property|name="key" content="..."> regardless of attribute order */
function metaContent(html: string, key: string): string {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`,
      "i",
    ),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return "";
}

/**
 * Best-effort metadata extraction from HTML meta tags and JSON-LD.
 * Claude refines this later with full page context — this only seeds meta.json.
 */
export function extractHtmlMeta(html: string): HtmlMeta {
  const meta: HtmlMeta = {
    title: "",
    author: [],
    published: "",
    description: "",
  };

  meta.title =
    metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (!meta.title) {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m) meta.title = decodeEntities(m[1].trim());
  }

  const author =
    metaContent(html, "author") || metaContent(html, "article:author");
  if (author && !author.startsWith("http")) {
    meta.author = author
      .split(/,| and /)
      .map((a) => a.trim())
      .filter(Boolean);
  }

  const published =
    metaContent(html, "article:published_time") ||
    metaContent(html, "datePublished") ||
    metaContent(html, "date");
  const dateMatch = published.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) meta.published = dateMatch[1];

  meta.description =
    metaContent(html, "og:description") || metaContent(html, "description");

  // JSON-LD often has the most reliable author/date info
  const jsonLdBlocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const type = String(node["@type"] ?? "");
        if (!/Article|BlogPosting|NewsArticle/i.test(type)) continue;
        if (meta.author.length === 0 && node.author) {
          const authors = Array.isArray(node.author)
            ? node.author
            : [node.author];
          meta.author = authors
            .map((a: unknown) =>
              typeof a === "string"
                ? a
                : ((a as { name?: string })?.name ?? ""),
            )
            .filter(Boolean);
        }
        if (!meta.published && typeof node.datePublished === "string") {
          const m = node.datePublished.match(/^(\d{4}-\d{2}-\d{2})/);
          if (m) meta.published = m[1];
        }
        if (!meta.title && typeof node.headline === "string") {
          meta.title = node.headline;
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }

  return meta;
}
