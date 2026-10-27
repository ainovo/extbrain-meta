import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  CompactIndexCard,
  MatchedItemResult,
  ModelEndpointConfig,
} from "../src/lib/types";
import {
  NerRawToken,
  groupNerWords,
  nerWordRuns,
  projectTextAlnum,
  recoverSpanText,
  truncateAtWordBoundary,
} from "../src/lib/entities";
import {
  MAX_API_BODY_BYTES,
  normalizeZeroShotBatch,
} from "../src/lib/retrievalEngine";
import {
  extractionConcurrencyFor,
  mapWithConcurrency,
  retryDelayMs,
} from "../src/lib/synthesize";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/** Meta Model API base URL. The key lives only in the server .env. */
const META_API_BASE_URL = "https://api.meta.ai/v1";

/**
 * Muse models emit private reasoning tokens before visible output, so the
 * default effort delays the first streamed token by seconds. Summaries,
 * extraction, and stitching don't need deep reasoning — "low" keeps
 * time-to-first-token (and cost) down. See
 * https://dev.meta.ai/docs/reasoning
 */
const REASONING_EFFORT = "low";

function metaApiKey(): string {
  return (process.env.MODEL_API_KEY || "").trim();
}

async function callLLM(
  config: ModelEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: { name: string; schema: Record<string, unknown> }
): Promise<string> {
  const apiKey = metaApiKey();
  const model = config.model.trim();
  if (!model) {
    throw new Error("No Meta model selected. Pick one in Settings → Models.");
  }
  if (!apiKey) {
    throw new Error(
      "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai)."
    );
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    reasoning_effort: REASONING_EFFORT,
    ...(jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: jsonSchema.name, schema: jsonSchema.schema },
          },
        }
      : {}),
  };

  // The rate-limit docs ask clients to retry 429s with exponential
  // backoff + jitter and to honor Retry-After.
  const MAX_429_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${META_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (data.choices?.[0]?.message?.content || "").trim();
    }

    const errText = await resp.text();
    if (resp.status !== 429 || attempt >= MAX_429_RETRIES) {
      throw new Error(
        `Meta Model API Error (${resp.status}): ${errText.slice(0, 400)}`
      );
    }
    const retryAfterSec = Number(resp.headers.get("retry-after"));
    const waitMs = retryDelayMs(
      attempt,
      Number.isFinite(retryAfterSec) ? retryAfterSec : null
    );
    console.log(
      `[meta] rate limited (429) on ${model}, retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 2}/${MAX_429_RETRIES + 1})`
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

let serverZeroShotClassifier: any = null;
let serverZeroShotLoadingPromise: Promise<any> | null = null;

async function getServerZeroShotClassifier() {
  if (serverZeroShotClassifier) return serverZeroShotClassifier;
  if (!serverZeroShotLoadingPromise) {
    serverZeroShotLoadingPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      serverZeroShotClassifier = await pipeline(
        "zero-shot-classification",
        "MoritzLaurer/ModernBERT-large-zeroshot-v2.0",
        { dtype: "q8" }
      );
      return serverZeroShotClassifier;
    })();
  }
  return serverZeroShotLoadingPromise;
}

let serverNerExtractor: any = null;
let serverNerTokenizer: any = null;
let serverNerLoadingPromise: Promise<any> | null = null;

/**
 * Bump whenever the entity reconstruction logic changes (1 = naive
 * aggregation join, 2 = span-fill recovery, 3 = word-atomic spans,
 * 4 = list coordination merge + hyphen-joined recovery,
 * 5 = coordinations enumerate distinct entities; only City, ST places merge,
 * 6 = span confidence scores recorded for the Settings score floor,
 * 7 = word scores average fragment support (untagged siblings dampen lone votes),
 * 8 = XLM-RoBERTa NER (quantized ONNX) with markerless word runs + DATE labels).
 * The Load page stores this per chat alongside its content hash and only
 * reprocesses chats whose record is missing, stale, or from an older version.
 */
const NER_EXTRACTOR_VERSION = 8;

async function getServerNerExtractor() {
  if (serverNerExtractor) return serverNerExtractor;
  if (!serverNerLoadingPromise) {
    serverNerLoadingPromise = (async () => {
      const { pipeline, env, AutoTokenizer } = await import(
        "@huggingface/transformers"
      );
      env.allowLocalModels = false;
      serverNerExtractor = await pipeline(
        "token-classification",
        "tjruesch/xlm-roberta-base-ner-hrl-onnx",
        { dtype: "q8" }
      );
      serverNerTokenizer = await AutoTokenizer.from_pretrained(
        "tjruesch/xlm-roberta-base-ner-hrl-onnx"
      );
      return serverNerExtractor;
    })();
  }
  return serverNerLoadingPromise;
}

app.post("/api/extract-entities-batch", async (req, res) => {
  try {
    const { items } = req.body as {
      items: Array<{ id: string; text: string }>;
    };
    if (!items || items.length === 0) {
      res.json({ results: [] });
      return;
    }

    await getServerNerExtractor();
    const extractor = serverNerExtractor;
    const tokenizer = serverNerTokenizer;
    const results: Array<{
      id: string;
      entities: Array<{ text: string; label: string; score: number }>;
    }> = [];

    for (const entry of items) {
      const text = truncateAtWordBoundary(entry.text || "", 2000);
      if (!text.trim()) {
        results.push({ id: entry.id, entities: [] });
        continue;
      }
      // Raw per-token output (no aggregation): transformers.js "simple"
      // aggregation joins only the tagged token surfaces and silently drops
      // O-tagged fragments in the middle, fabricating strings that never
      // appeared ("myhoros" -> "MHOROS"). Rebuild each entity from its full
      // token span instead, filling skipped fragments from our own
      // tokenization of the same text.
      const out: any = await extractor(text);
      const tokens: NerRawToken[] = Array.isArray(out) ? out : [];
      let surfaces: string[] | null = null;
      try {
        const tokOut: any = await tokenizer(text);
        // Token ids can come back as BigInts (XLM-R uses int64); decode
        // needs plain numbers.
        const ids: number[] = Array.from(
          tokOut.input_ids?.data ?? tokOut.input_ids ?? []
        ).map((v) => Number(v));
        surfaces = ids.map((id) => {
          try {
            return tokenizer.decode([id]);
          } catch {
            return "";
          }
        });
      } catch {
        surfaces = null;
      }
      const proj = projectTextAlnum(text);
      const entities: Array<{ text: string; label: string; score: number }> =
        [];
      if (surfaces) {
        // Word-atomic spans: fragments can never stand alone, so trailing or
        // mid-word O-tagged pieces are recovered as part of their word
        // instead of being dropped into fabrications. The XLM-R per-id
        // decodes carry no continuation markers, so words group by
        // source-text adjacency (nerWordRuns takes the same text).
        for (const g of groupNerWords(nerWordRuns(surfaces, tokens, text))) {
          const name = recoverSpanText(text, proj, surfaces, g.lo, g.hi);
          if (!name) continue;
          entities.push({ text: name, label: g.type, score: g.score });
        }
      }
      results.push({ id: entry.id, entities });
    }

    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/generate-nli-labels", async (req, res) => {
  try {
    const { projectQuery, modelConfig } = req.body as {
      projectQuery: string;
      modelConfig: ModelEndpointConfig;
    };

    if (!projectQuery || !projectQuery.trim()) {
      res.status(400).json({ error: "Missing project description." });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You generate NLI zero-shot evaluation labels for ModernBERT-large-zeroshot-v2.0.
CRITICAL NLI RULE: If the user names a specific project, brand, or domain, the FIRST target_label MUST include that exact name (e.g. "user acquisition optimization for myhoros.com"), because chats explicitly about the project should match strongly. ALSO include 1-2 broader functional/topic phrases WITHOUT the brand/domain name, so follow-up turns that omit the name still match (scoring takes the best match across all labels).
Return strict JSON only with "tag_name", "target_labels", "contrast_labels", "date_start", and "date_end".`;

    const userPrompt = `The user wants to find chat logs about: "${projectQuery.trim()}".
Today is ${today}.

Generate a JSON object with:
- "tag_name": a short 2 to 4 word tag name for this topic (no hashtags; keep the project/domain name if the user named one, e.g. "myhoros acquisition").
- "target_labels": 3 descriptive phrases capturing the target intent (use rich semantic context, not single words). The FIRST label must include the exact project/brand/domain name when the user named one; the remaining labels must be broader functional phrases WITHOUT the name, so follow-up turns that omit it still match.
- "contrast_labels": 2 to 3 plausible distractor topics that might share keywords but represent different intents to exclude.
- "date_start" / "date_end": the evaluation window as YYYY-MM-DD dates inferred from the description relative to today (e.g. "in the last month" means the past 30 days). Use null when the description implies no time bound.

Output strict JSON only:
{
  "tag_name": "myhoros acquisition",
  "target_labels": [
    "user acquisition optimization for myhoros.com",
    "paid user acquisition, marketing spend, and ad campaigns",
    "conversion tracking, CAC, and ad performance optimization"
  ],
  "contrast_labels": [
    "website monetization, displaying ads for revenue, and ad network scripts",
    "general software bugs and server infrastructure setup",
    "casual everyday chat"
  ],
  "date_start": null,
  "date_end": null
}`;

    const raw = await callLLM(modelConfig, systemPrompt, userPrompt, {
      name: "nli_labels",
      schema: {
        type: "object",
        properties: {
          tag_name: { type: "string" },
          target_labels: { type: "array", items: { type: "string" } },
          contrast_labels: { type: "array", items: { type: "string" } },
          date_start: { type: ["string", "null"] },
          date_end: { type: ["string", "null"] },
        },
        required: [
          "tag_name",
          "target_labels",
          "contrast_labels",
          "date_start",
          "date_end",
        ],
        additionalProperties: false,
      },
    });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM did not return valid JSON for NLI labels.");
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      tag_name?: string;
      target_labels?: string[];
      contrast_labels?: string[];
      date_start?: string | null;
      date_end?: string | null;
    };

    const cleanDate = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const s = v.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const d = new Date(s + "T00:00:00Z");
      return isNaN(d.getTime()) ? null : s;
    };
    let dateStart = cleanDate(parsed.date_start);
    let dateEnd = cleanDate(parsed.date_end);
    if (dateStart && dateEnd && dateEnd < dateStart) {
      [dateStart, dateEnd] = [dateEnd, dateStart];
    }

    res.json({
      tag_name: (parsed.tag_name || "").trim() || "untagged topic",
      target_labels: (parsed.target_labels || [])
        .map((s) => s.trim())
        .filter(Boolean),
      contrast_labels: (parsed.contrast_labels || [])
        .map((s) => s.trim())
        .filter(Boolean),
      date_start: dateStart,
      date_end: dateEnd,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/classify-entry", async (req, res) => {
  try {
    const { text, labels } = req.body as { text: string; labels: string[] };
    const cleanLabels = (labels || []).map((l) => l.trim()).filter(Boolean);
    if (!text || cleanLabels.length === 0) {
      res.json({ scores: {} });
      return;
    }
    const clf = await getServerZeroShotClassifier();
    const out: any = await clf(text, cleanLabels, {
      multi_label: true,
      hypothesis_template: "This text is about {}.",
    });
    const single = Array.isArray(out) ? out[0] : out;
    const scoreMap: Record<string, number> = {};
    if (single && Array.isArray(single.labels) && Array.isArray(single.scores)) {
      for (let i = 0; i < single.labels.length; i++) {
        scoreMap[single.labels[i]] = single.scores[i];
      }
    }
    res.json({ scores: scoreMap });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/classify-batch", async (req, res) => {
  try {
    const { items, labels, multiLabel } = req.body as {
      items: Array<{ id: string; text: string }>;
      labels: string[];
      multiLabel?: boolean;
    };
    const cleanLabels = (labels || []).map((l) => l.trim()).filter(Boolean);
    if (!items || items.length === 0 || cleanLabels.length === 0) {
      res.json({ results: [] });
      return;
    }
    // Tags score target/contrast labels independently (multi-label); the
    // category taxonomy picks exactly one label (softmaxed single-label).
    const multi = multiLabel !== false;

    const clf = await getServerZeroShotClassifier();
    const opts = {
      multi_label: multi,
      hypothesis_template: "This text is about {}.",
    };
    const scoreOne = async (text: string): Promise<Record<string, number>> => {
      const out: any = await clf(text, cleanLabels, opts);
      const single = Array.isArray(out) ? out[0] : out;
      const scoreMap: Record<string, number> = {};
      if (
        single &&
        Array.isArray(single.labels) &&
        Array.isArray(single.scores)
      ) {
        for (let i = 0; i < single.labels.length; i++) {
          scoreMap[single.labels[i]] = single.scores[i];
        }
      }
      return scoreMap;
    };

    const results: Array<{ id: string; scores: Record<string, number> }> = [];
    // One pipeline call for the whole micro-batch lets the model batch
    // internally instead of paying per-chat overhead N times. If the
    // output shape ever mismatches, fall back to one call per chat —
    // slower, but scores can never misalign to the wrong chat.
    const batched = normalizeZeroShotBatch(
      await clf(
        items.map((e) => e.text),
        cleanLabels,
        opts
      ),
      items.length
    );
    if (batched) {
      for (let i = 0; i < items.length; i++) {
        results.push({ id: items[i].id, scores: batched[i] });
      }
    } else {
      console.log(
        `[meta] zero-shot batch shape mismatch, falling back to sequential (${items.length} chats)`
      );
      for (const entry of items) {
        results.push({ id: entry.id, scores: await scoreOne(entry.text) });
      }
    }

    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    nerExtractorVersion: NER_EXTRACTOR_VERSION,
    hasServerMetaKey: Boolean(process.env.MODEL_API_KEY),
  });
});

/**
 * Link metadata (favicon / title / description) for URL preview chips and
 * hover cards. The browser can't read cross-origin pages, so the server
 * fetches the page, extracts <head> metadata, and caches the result.
 */
interface UrlMetadataPayload {
  url: string;
  host: string;
  title: string;
  description: string;
  favicon: string;
  error?: string;
}

const URL_META_CACHE = new Map<
  string,
  { value: UrlMetadataPayload; expires: number }
>();
const URL_META_TTL_MS = 30 * 60 * 1000;
const URL_META_CACHE_MAX = 500;
const URL_FETCH_TIMEOUT_MS = 8000;
const URL_FETCH_CAP_BYTES = 400 * 1024;

/** Only public http(s) targets; blocks loopback/private/link-local hosts. */
function safeFetchTarget(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h.includes(":")) return null; // any IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null; // any IPv4 literal
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return null;
  }
  return u;
}

function safeHostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Follows redirects manually so every hop is re-validated by safeFetchTarget. */
async function fetchWithRedirectGuard(
  target: URL,
  signal: AbortSignal
): Promise<Response> {
  let current = target;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(current.href, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ExtBrainPreview/1.0; +link metadata)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      let next: URL;
      try {
        next = new URL(loc, current.href);
      } catch {
        return resp;
      }
      const safe = safeFetchTarget(next.href);
      if (!safe) throw new Error("Blocked redirect target.");
      current = safe;
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects.");
}

/** Reads at most `capBytes` of the body (metadata lives in <head>, early on). */
async function readCappedText(
  resp: Response,
  capBytes: number
): Promise<string> {
  const body = resp.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let received = 0;
  try {
    while (received < capBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(
      /&([a-z][a-z0-9]*);/gi,
      (m: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m
    );
}

function cleanMetaText(s: string, cap: number): string {
  const t = decodeHtmlEntities(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > cap ? t.slice(0, cap - 1).trimEnd() + "…" : t;
}

function firstMatch(s: string, re: RegExp): string {
  const m = s.match(re);
  return m?.[1] ?? "";
}

/** content= of the first <meta> whose name/property matches `keys`. */
function metaTagContent(html: string, keys: string[]): string {
  const keyRe = new RegExp(
    `(?:name|property)\\s*=\\s*["']\\s*(?:${keys.join("|")})\\s*["']`,
    "i"
  );
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!keyRe.test(tag)) continue;
    const content = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (content) return content[1] ?? content[2] ?? "";
  }
  return "";
}

/** First <link rel~icon> href, resolved absolute against the final URL. */
function pageFavicon(html: string, base: string): string {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tag.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const relVal = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase();
    if (!relVal.includes("icon")) continue;
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const hrefVal = href?.[1] ?? href?.[2];
    if (!hrefVal) continue;
    try {
      return new URL(hrefVal, base).href;
    } catch {
      // skip invalid href
    }
  }
  return "";
}

app.get("/api/url-metadata", async (req, res) => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  const target = safeFetchTarget(raw);
  if (!target) {
    res.status(400).json({ error: "Invalid or disallowed URL." });
    return;
  }
  const key = target.href;
  const hit = URL_META_CACHE.get(key);
  if (hit && hit.expires > Date.now()) {
    res.json(hit.value);
    return;
  }

  let payload: UrlMetadataPayload;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchWithRedirectGuard(target, ctrl.signal);
      const finalUrl = resp.url || target.href;
      const host = safeHostOf(finalUrl) || safeHostOf(target.href);
      const ctype = (resp.headers.get("content-type") || "").toLowerCase();
      if (!resp.ok) {
        payload = {
          url: finalUrl,
          host,
          title: host,
          description: "",
          favicon: "",
          error: `HTTP ${resp.status}`,
        };
      } else if (
        ctype !== "" &&
        !ctype.includes("html") &&
        !ctype.includes("xml") &&
        !ctype.startsWith("text/")
      ) {
        // Not a page (PDF, image, JSON, …): nothing to preview beyond the host.
        payload = { url: finalUrl, host, title: host, description: "", favicon: "" };
      } else {
        const body = await readCappedText(resp, URL_FETCH_CAP_BYTES);
        const title = cleanMetaText(
          firstMatch(body, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
            metaTagContent(body, ["og:title", "twitter:title"]),
          160
        );
        const description = cleanMetaText(
          metaTagContent(body, [
            "description",
            "og:description",
            "twitter:description",
          ]),
          400
        );
        payload = {
          url: finalUrl,
          host,
          title: title || host,
          description,
          favicon: pageFavicon(body, finalUrl),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const host = safeHostOf(target.href);
    payload = {
      url: target.href,
      host,
      title: host,
      description: "",
      favicon: "",
      error: message,
    };
  }

  URL_META_CACHE.set(key, {
    value: payload,
    expires: Date.now() + URL_META_TTL_MS,
  });
  if (URL_META_CACHE.size > URL_META_CACHE_MAX) {
    const oldest = URL_META_CACHE.keys().next().value;
    if (oldest !== undefined) URL_META_CACHE.delete(oldest);
  }
  res.json(payload);
});

/**
 * STAGE 1: Project Discovery & Multi-Week Entity Stitching
 */
app.post("/api/discover", async (req, res) => {
  try {
    const {
      projectQuery,
      compactCards,
      localSeedMatches,
      localDiscoveredEntities,
      modelConfig,
    } = req.body as {
      projectQuery: string;
      compactCards: CompactIndexCard[];
      localSeedMatches: MatchedItemResult[];
      localDiscoveredEntities: string[];
      modelConfig: ModelEndpointConfig;
    };

    const apiKey = metaApiKey();

    // If no API key is configured, return the local two-hop entity snowball result immediately
    if (!apiKey) {
      res.json({
        mode: "local_snowball",
        matches: localSeedMatches,
        discoveredEntities: localDiscoveredEntities,
        notice:
          "Used local 2-Hop Entity Snowballing (set MODEL_API_KEY in the server .env to enable LLM semantic stitching).",
      });
      return;
    }

    const systemPrompt = `You are an expert Project Thread Stitcher for Google Takeout AI chat histories.
Your job is to identify ALL activity entries belonging to the user's target project across weeks or months, even when follow-up chats omit the project name.

HOW TO STITCH RELEVANT CHATS ACROSS WEEKS:
1. ANCHOR DISCOVERY (Hop 1): Find entries that directly mention the project name, domain, or core topic in either the user's prompt OR the AI's key points.
2. ENTITY SNOWBALLING (Hop 2): From the anchor entries, identify the specific platforms, ad networks, tools, or sub-problems being used for that project (e.g., "ChatGPT Ads", "OpenAI Ads", "Maximize Results", "oCPC", "ChatGPT Go tier"). Include all entries across ANY date that research or troubleshoot those connected entities for the project.
3. SESSION CONTINUITY (Hop 3): Include immediate follow-up prompts from the same session if they continue the same thread, but EXCLUDE unrelated topic switches (e.g., shipping carriers, movies, recipes) even if they happened on the same day.

Return ONLY valid JSON with this exact structure:
{
  "discoveredEntities": ["entity1", "entity2"],
  "matches": [
    {
      "id": "entry_id",
      "matchType": "anchor" | "entity_snowball" | "session_stitch",
      "reason": "Short 1-line explanation of why this entry belongs to the project"
    }
  ]
}`;

    const userPrompt = `TARGET PROJECT DESCRIPTION:
"${projectQuery}"

LOCAL 2-HOP SEED ENTITIES DETECTED:
${JSON.stringify(localDiscoveredEntities)}

COMPACT ACTIVITY INDEX (${compactCards.length} entries, ordered oldest to newest):
${JSON.stringify(compactCards, null, 2)}`;

    const rawResponse = await callLLM(modelConfig, systemPrompt, userPrompt, {
      name: "discovery_matches",
      schema: {
        type: "object",
        properties: {
          discoveredEntities: { type: "array", items: { type: "string" } },
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                matchType: {
                  type: "string",
                  enum: ["anchor", "entity_snowball", "session_stitch"],
                },
                reason: { type: "string" },
              },
              required: ["id", "matchType", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["discoveredEntities", "matches"],
        additionalProperties: false,
      },
    });

    // Extract JSON block safely
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Model did not return valid JSON during discovery.");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      discoveredEntities?: string[];
      matches?: MatchedItemResult[];
    };

    // Merge LLM matches with any strong local anchor matches so nothing is dropped
    const mergedMap = new Map<string, MatchedItemResult>();
    for (const m of localSeedMatches) {
      if (m.matchType === "anchor") {
        mergedMap.set(m.id, m);
      }
    }
    for (const m of parsed.matches || []) {
      if (m && m.id) {
        mergedMap.set(m.id, {
          id: m.id,
          matchType: m.matchType || "entity_snowball",
          reason: m.reason || "Matched by LLM discovery",
        });
      }
    }

    const entitySet = new Set<string>([
      ...(parsed.discoveredEntities || []),
      ...(localDiscoveredEntities || []),
    ]);

    res.json({
      mode: "llm",
      matches: Array.from(mergedMap.values()),
      discoveredEntities: Array.from(entitySet).slice(0, 20),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * STAGE 2: Asymmetric Context Synthesis (Single-Call or Adaptive Multi-Batch Merge)
 */
app.post("/api/synthesize", async (req, res) => {
  try {
    const {
      projectQuery,
      batches,
      systemInstruction,
      modelConfig,
    } = req.body as {
      projectQuery: string;
      batches: string[];
      systemInstruction: string;
      modelConfig: ModelEndpointConfig;
    };

    if (!batches || batches.length === 0) {
      res.status(400).json({ error: "No packed chat batches provided." });
      return;
    }

    // Case 1: Single batch (typical for 1 - 150 chats with Asymmetric Packing) -> 1 LLM Call
    if (batches.length === 1) {
      const userPrompt = `PROJECT TOPIC: "${projectQuery}"

CHRONOLOGICAL ASYMMETRICALLY-PACKED PROJECT CHATS (100% verbatim user prompts + condensed AI context):
${batches[0]}

Generate the requested project summary in clean Obsidian Markdown.`;

      const markdown = await callLLM(
        modelConfig,
        systemInstruction,
        userPrompt
      );

      res.json({
        markdown,
        llmCallsMade: 1,
        batchCount: 1,
      });
      return;
    }

    // Case 2: Huge project (>150 chats) -> Extract chronological milestones per batch, then 1 final synthesis merge
    const intermediateExtractions: string[] = [];
    for (let i = 0; i < batches.length; i++) {
      const batchExtractSystem = `You are extracting factual chronological project notes from Batch ${
        i + 1
      } of ${batches.length} for the project "${projectQuery}".
Preserve all exact timestamps, user-shared metrics, campaign names, errors, config snippets, and decisions verbatim.`;

      const batchExtractUser = `Extract all chronological events, user prompts, metrics, and outcomes from Batch ${
        i + 1
      }:\n\n${batches[i]}`;

      const partial = await callLLM(
        modelConfig,
        batchExtractSystem,
        batchExtractUser
      );
      intermediateExtractions.push(
        `### Extracted Chronological Notes (Batch ${i + 1}/${batches.length})\n${partial}`
      );
    }

    const finalMergeUser = `PROJECT TOPIC: "${projectQuery}"

Below are the chronological milestone extractions across ${batches.length} batches of chat history.
Synthesize them into a single unified project summary following the system instructions:\n\n${intermediateExtractions.join(
      "\n\n---\n\n"
    )}`;

    const finalMarkdown = await callLLM(
      modelConfig,
      systemInstruction,
      finalMergeUser
    );

    res.json({
      markdown: finalMarkdown,
      llmCallsMade: batches.length + 1,
      batchCount: batches.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Streams one completion over the Responses API. Visible text goes to
 * onDelta; the model's reasoning summary (requested, so it arrives before
 * output) accumulates into onStatus for live progress display.
 */
async function streamLLMToSSE(
  config: ModelEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  onDelta: (text: string) => void,
  onStatus: (text: string) => void
): Promise<void> {
  const apiKey = metaApiKey();
  const model = config.model.trim();
  if (!model) {
    throw new Error("No Meta model selected. Pick one in Settings → Models.");
  }
  if (!apiKey) {
    throw new Error(
      "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai)."
    );
  }
  const resp = await fetch(`${META_API_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: userPrompt,
      temperature: 0.2,
      reasoning: { effort: REASONING_EFFORT, summary: "auto" },
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Meta Model API Error (${resp.status}): ${errText.slice(0, 400)}`
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let statusAcc = "";
  let textDeltas = 0;
  let statusDeltas = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore partial frames
      }
      if (
        json?.type === "response.output_text.delta" &&
        typeof json.delta === "string" &&
        json.delta
      ) {
        textDeltas++;
        onDelta(json.delta);
      } else if (
        json?.type === "response.reasoning_summary_text.delta" &&
        typeof json.delta === "string" &&
        json.delta
      ) {
        statusDeltas++;
        statusAcc += json.delta;
        onStatus(statusAcc);
      } else if (json?.type === "response.failed") {
        const msg =
          json.response?.error?.message ||
          json.error?.message ||
          "Meta response failed during streaming.";
        throw new Error(`Meta Model API Error: ${String(msg).slice(0, 400)}`);
      }
    }
  }
  console.log(
    `[meta] stream done model=${model} textDeltas=${textDeltas} statusDeltas=${statusDeltas}` +
      (statusAcc ? ` status=${JSON.stringify(statusAcc.slice(0, 120))}` : "")
  );
}

/**
 * Streaming thread summary: single-batch threads stream directly; large
 * multi-batch threads extract notes per batch (non-streaming) then stream
 * the final merge so long threads still show progressive output.
 */
app.post("/api/synthesize-thread-stream", async (req, res) => {
  try {
    const { projectQuery, batches, systemInstruction, modelConfig } = req.body as {
      projectQuery: string;
      batches: string[];
      systemInstruction: string;
      modelConfig: ModelEndpointConfig;
    };
    if (!batches || batches.length === 0) {
      res.status(400).json({ error: "No packed chat batches provided." });
      return;
    }
    // Defense in depth: the packer caps bodies client-side, but a stale
    // client could still send a batch the API would truncate mid-JSON
    // (cryptic 400 hex-escape error). Fail fast with a clear message.
    const biggest = Math.max(
      ...batches.map((b) => Buffer.byteLength(b || "", "utf8"))
    );
    if (biggest > MAX_API_BODY_BYTES) {
      res.status(400).json({
        error: `Packed batch too large (${(biggest / 1024).toFixed(0)}KB > ${MAX_API_BODY_BYTES / 1024}KB per request). Narrow the range or lower Max Packed Tokens in Settings → Models.`,
      });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // Flush headers and announce immediately so the UI shows life within
    // milliseconds (and no proxy buffers the stream) while the model works
    // toward its first token.
    res.flushHeaders();
    const inputBytes = batches.reduce(
      (n, b) => n + Buffer.byteLength(b || "", "utf8"),
      0
    );
    console.log(
      `[meta] synthesize start batches=${batches.length} model=${modelConfig?.model} input≈${(inputBytes / 1024).toFixed(0)}kb`
    );
    send({ progress: "Contacting Meta model…" });

    let finalSystem = systemInstruction;
    let finalUser: string;
    let batchCount = batches.length;
    if (batches.length === 1) {
      finalUser = `PROJECT TOPIC: "${projectQuery}"\n\nCHRONOLOGICAL ASYMMETRICALLY-PACKED PROJECT CHATS (100% verbatim user prompts + condensed AI context):\n${batches[0]}\n\nGenerate the requested project summary in clean Obsidian Markdown.`;
    } else {
      // Batches are independent: extract them concurrently instead of
      // sequentially, so a 3-batch run takes ~1 extraction instead of ~3.
      // Fan-out follows the model's rate-limit tier so a huge selection
      // can't burst past the per-team TPM budget; results keep order and
      // join chronologically.
      const fanOut = extractionConcurrencyFor(modelConfig?.model ?? "");
      const capped =
        batches.length > fanOut ? ` (up to ${fanOut} at a time)` : "";
      send({ progress: `Extracting ${batches.length} batches in parallel${capped}…` });
      const partials = await mapWithConcurrency(
        batches,
        fanOut,
        (batch, i) =>
          callLLM(
            modelConfig,
            `You are extracting factual chronological project notes from Batch ${i + 1} of ${batches.length} for the project "${projectQuery}". Preserve all exact timestamps, user-shared metrics, campaign names, errors, config snippets, and decisions verbatim.`,
            `Extract all chronological events, user prompts, metrics, and outcomes from Batch ${i + 1}:\n\n${batch}`
          )
      );
      const intermediateExtractions = partials.map(
        (partial, i) =>
          `### Extracted Chronological Notes (Batch ${i + 1}/${batches.length})\n${partial}`
      );
      finalUser = `PROJECT TOPIC: "${projectQuery}"\n\nBelow are the chronological milestone extractions across ${batches.length} batches of chat history.\nSynthesize them into a single unified project summary following the system instructions:\n\n${intermediateExtractions.join("\n\n---\n\n")}`;
    }

    send({ batchCount });
    await streamLLMToSSE(
      modelConfig,
      finalSystem,
      finalUser,
      (delta) => send({ delta }),
      (status) => send({ progress: status })
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  }
});

// Serve static frontend in production (Google Cloud Run)
const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) next();
  });
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
