/**
 * Shared URL helpers + client-side link-metadata cache.
 *
 * Rules every URL touchpoint follows:
 * - A bare URL at the end of a sentence is followed by sentence punctuation
 *   ("https://luma.com/b1ii8quj." etc.). The punctuation must never end up
 *   inside the href (invalid URL), but it must also never disappear from
 *   the message text — it is kept outside the link.
 * - Display: URLs render as favicon + title chips; metadata (title,
 *   description, favicon) is fetched once through /api/url-metadata and
 *   cached for the session.
 */

export interface UrlMetadata {
  url: string;
  host: string;
  title: string;
  description: string;
  favicon: string;
}

/** Sentence punctuation that may trail a bare URL in prose. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** Strips trailing sentence punctuation from a bare-URL match. */
export function stripTrailingUrlPunct(url: string): string {
  return url.replace(TRAILING_PUNCT_RE, "");
}

/** Bare http(s) URL that still has something left after the scheme. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S/i.test(url);
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Google's favicon service: synchronous, works for any host, and serves a
 * generic globe for unknown domains — used until (or instead of) real
 * metadata. Returns "" when no host can be derived.
 */
export function faviconForUrl(url: string): string {
  const host = hostOfUrl(url);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/**
 * Distinct http(s) URLs in a text blob, with trailing sentence punctuation
 * stripped so hrefs stay valid. Deduped, order-preserving, capped at `limit`.
 */
export function extractUrlsFromText(text: string, limit = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s)\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const u = stripTrailingUrlPunct(m[0]);
    if (!isHttpUrl(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string; trail: string };

/**
 * Splits prose on bare http(s) URLs, preserving position so callers can
 * render links inline. Each URL segment carries a clean href plus any
 * trailing sentence punctuation to emit after the link (same rule as
 * extractUrlsFromText, but nothing is dropped or deduped).
 */
export function splitTextWithUrls(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const re = /https?:\/\/[^\s)\]]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: text.slice(last, m.index) });
    }
    const clean = stripTrailingUrlPunct(m[0]);
    if (!isHttpUrl(clean)) {
      out.push({ kind: "text", text: m[0] });
    } else {
      out.push({ kind: "url", url: clean, trail: m[0].slice(clean.length) });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

const metadataCache = new Map<string, Promise<UrlMetadata | null>>();
const METADATA_CACHE_MAX = 2000;

/**
 * Fetches favicon/title/description for a URL via the local server
 * (cross-origin pages can't be read from the browser). Concurrent callers
 * share one request; results are cached for the session.
 */
export function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  const clean = stripTrailingUrlPunct(url.trim());
  if (!isHttpUrl(clean)) return Promise.resolve(null);
  const cached = metadataCache.get(clean);
  if (cached) return cached;
  const pending = fetch(
    `/api/url-metadata?url=${encodeURIComponent(clean)}`
  )
    .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
    .then((data): UrlMetadata | null => {
      if (!data || typeof data !== "object") return null;
      const d = data as Record<string, unknown>;
      return {
        url: typeof d.url === "string" ? d.url : clean,
        host: typeof d.host === "string" ? d.host : hostOfUrl(clean),
        title: typeof d.title === "string" ? d.title : "",
        description: typeof d.description === "string" ? d.description : "",
        favicon: typeof d.favicon === "string" ? d.favicon : "",
      };
    })
    .catch(() => null);
  metadataCache.set(clean, pending);
  if (metadataCache.size > METADATA_CACHE_MAX) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  return pending;
}
