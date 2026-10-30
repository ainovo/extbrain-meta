/**
 * Category taxonomy for thread classification. Each thread is scored ONCE
 * against the one-word category names with the zero-shot NLI endpoint
 * ("The user's task or goal in this conversation is related to {name}")
 * over its joined chat texts, and takes the
 * argmax category. One verdict per thread key persists per dataset
 * alongside entities; Top Threads reads it directly.
 *
 * The 9 built-ins below are the default taxonomy; users can remove any of
 * them and add their own on the Tags page (edits persist per dataset).
 * Every scoring/display helper takes the taxonomy in force and defaults to
 * the built-ins, so old verdicts and old backups keep working untouched.
 */
import {
  decodeStoredJson,
  encodeCompressedJson,
  setStoredItem,
} from "./compressedJson";
import { truncateAtWordBoundary } from "./entities";
import { NliBackendId, ParsedActivityItem } from "./types";

/**
 * A category id: one of the 9 built-in ids below, or a user-added slug
 * ("machine-learning"). Plain string: the taxonomy is user-editable, so no
 * closed union can enumerate it.
 */
export type CategoryId = string;

export interface CategoryDef {
  id: CategoryId;
  /** Display label ("Productivity"). */
  label: string;
  /** What the category covers (reference only; scoring uses the id). */
  description: string;
}

export const CATEGORY_TAXONOMY: CategoryDef[] = [
  {
    id: "productivity",
    label: "Productivity",
    description: "Task management, coding workflows, and text editing.",
  },
  {
    id: "finance",
    label: "Finance",
    description: "Banking, investing, and trading platforms.",
  },
  {
    id: "business",
    label: "Business",
    description: "Startups, monetization, and product growth.",
  },
  {
    id: "social",
    label: "Social",
    description: "Messaging, networking, and community platforms.",
  },
  {
    id: "entertainment",
    label: "Entertainment",
    description: "Streaming, gaming, and media consumption.",
  },
  {
    id: "health",
    label: "Health",
    description: "Workouts, medical, and wellness tracking.",
  },
  {
    id: "travel",
    label: "Travel",
    description: "Flights, bookings, and navigation.",
  },
  {
    id: "utilities",
    label: "Utilities",
    description: "System tools, calculators, and file management.",
  },
  {
    id: "education",
    label: "Education",
    description: "Learning, research, and reference materials.",
  },
];

/**
 * Zero-shot candidate labels for /api/classify-batch under the DEFAULT
 * (unedited) taxonomy. Scoring runs pass the taxonomy in force instead.
 */
export const CATEGORY_LABELS: string[] = CATEGORY_TAXONOMY.map((c) => c.id);

/** Bump to invalidate stored verdicts (taxonomy or scorer change). 5 = task-or-goal hypothesis template. */
export const THREAD_CATEGORY_VERSION = 5;

export type CategoryScores = Record<string, number>;

/** Per-thread category verdict: content hash plus the full score map. */
export interface ThreadCategoryRecord {
  hash: string;
  version: number;
  scores: CategoryScores;
  /** Backend that scored the verdict (absent = local, for legacy). */
  backend?: NliBackendId;
}

export type ThreadCategoryMap = Record<string, ThreadCategoryRecord>;

const zeroScores = (taxonomy: CategoryDef[]): CategoryScores => {
  const out: CategoryScores = {};
  for (const c of taxonomy) out[c.id] = 0;
  return out;
};

/**
 * Zero-shot label scores (one call, multi-label) to per-category scores:
 * each category reads its own one-word label, defaulting missing labels
 * to 0. Rounded to 4 decimals: full float precision would triple the
 * stored bytes across 16K chats for no ranking benefit.
 */
export function scoresToCategories(
  labelScores: Record<string, number>,
  taxonomy: CategoryDef[] = CATEGORY_TAXONOMY
): CategoryScores {
  const out = zeroScores(taxonomy);
  for (const c of taxonomy) {
    out[c.id] = Math.round((labelScores[c.id] ?? 0) * 10000) / 10000;
  }
  return out;
}

function firstSentence(text: string, maxLen = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const m = /^(.+?[.!?。！？])(\s|$)/.exec(flat);
  return truncateAtWordBoundary((m ? m[1] : flat).trim(), maxLen);
}

/**
 * Text scored for categories: user prompt plus the first sentence of the
 * AI response. Full-response classification text costs ~quadratic attention
 * over ~1,750 chars per chat; prompt + opening sentence keeps the topic
 * signal for 8 coarse buckets at a fraction of the compute.
 */
export function buildCategoryScoringText(item: ParsedActivityItem): string {
  const promptPart = truncateAtWordBoundary(item.allPromptsText, 400);
  const fullResp = item.turns
    .map((t) => t.responseMarkdown || t.responseSummary)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return `User Prompt:\n${promptPart}\n\nAI Response:\n${firstSentence(fullResp)}`.trim();
}

/** The single most appropriate category (ties break by taxonomy order). */
export function topCategory(
  scores: CategoryScores,
  taxonomy: CategoryDef[] = CATEGORY_TAXONOMY
): CategoryId {
  let best: CategoryId = taxonomy[0]?.id ?? "";
  let bestScore = -Infinity;
  for (const c of taxonomy) {
    const s = scores[c.id] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      best = c.id;
    }
  }
  return best;
}

/**
 * Thread scoring text: per-chat scoring texts joined oldest-first,
 * head-truncated. Early chats set the topic, so truncation keeps the most
 * topical content.
 */
/**
 * Per-chat category scoring text cache: buildCategoryScoringText is pure in
 * the item object, which the app keeps stable across navigations, so repeat
 * scans reuse it instead of re-joining full responses. WeakMap: entries die
 * with replaced items (imports/restores), so the cache can't go stale.
 */
const categoryTextCache = new WeakMap<ParsedActivityItem, string>();

function cachedCategoryScoringText(item: ParsedActivityItem): string {
  const cached = categoryTextCache.get(item);
  if (cached !== undefined) return cached;
  const text = buildCategoryScoringText(item);
  categoryTextCache.set(item, text);
  return text;
}

export function buildThreadScoringText(chats: ParsedActivityItem[]): string {
  return truncateAtWordBoundary(
    chats.map((c) => cachedCategoryScoringText(c)).join("\n\n"),
    800
  );
}

/** Display label for a category id ("productivity" → "Productivity"). */
export function categoryLabelFor(
  id: CategoryId,
  taxonomy: CategoryDef[] = CATEGORY_TAXONOMY
): string {
  return taxonomy.find((c) => c.id === id)?.label ?? id;
}

/**
 * True when a thread needs (re-)scoring: no verdict, changed text (new or
 * edited chats), a verdict from before the current taxonomy/scorer
 * version, or a verdict missing any current label (scored before that
 * label was added). Extra keys — labels since removed — are harmless:
 * argmax only reads current ids, so removal needs no rescore, and
 * re-adding a label reuses its still-valid score when the thread text is
 * unchanged.
 */
export function threadNeedsCategoryScoring(args: {
  entry: unknown;
  hash: string;
  taxonomyIds?: string[];
  backend?: NliBackendId;
}): boolean {
  const rec = normalizeThreadCategoryRecord(args.entry);
  if (!rec) return true;
  if (rec.hash !== args.hash) return true;
  if ((rec.backend ?? "local") !== (args.backend ?? "local")) return true;
  if (rec.version < THREAD_CATEGORY_VERSION) return true;
  for (const id of args.taxonomyIds ?? CATEGORY_LABELS) {
    if (typeof rec.scores[id] !== "number") return true;
  }
  return false;
}

function normalizeScores(
  raw: unknown,
  taxonomy: CategoryDef[] = CATEGORY_TAXONOMY
): CategoryScores | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = zeroScores(taxonomy);
  // Unknown keys are kept, not dropped: scores for removed or custom
  // labels stay valid across taxonomy edits (see threadNeedsCategoryScoring).
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeThreadCategoryRecord(
  raw: unknown
): ThreadCategoryRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as {
    hash?: unknown;
    version?: unknown;
    scores?: unknown;
    backend?: unknown;
  };
  if (typeof r.hash !== "string") return null;
  const scores = normalizeScores(r.scores);
  if (!scores) return null;
  const rec: ThreadCategoryRecord = {
    hash: r.hash,
    version: typeof r.version === "number" ? r.version : 0,
    scores,
  };
  // Legacy model-specific ids ("modal-bge-m3") are unrecognized, so
  // pre-XLM verdicts never pass as fresh under the Modal backend.
  if (r.backend === "local" || r.backend === "modal") {
    rec.backend = r.backend;
  }
  return rec;
}

/** Validate a whole map (localStorage and backups share this). */
export function normalizeThreadCategoryMap(raw: unknown): ThreadCategoryMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ThreadCategoryMap = {};
  for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
    const norm = normalizeThreadCategoryRecord(rec);
    if (norm) out[id] = norm;
  }
  return out;
}

const keyFor = (uuid: string) => `sb_threadcats_${uuid}`;

export function loadThreadCategories(uuid: string): ThreadCategoryMap {
  try {
    return normalizeThreadCategoryMap(
      decodeStoredJson(localStorage.getItem(keyFor(uuid)))
    );
  } catch {
    return {};
  }
}

export function saveThreadCategories(
  uuid: string,
  map: ThreadCategoryMap
): boolean {
  const payload = encodeCompressedJson(map);
  const ok = setStoredItem(keyFor(uuid), payload);
  if (!ok) {
    console.error(
      `[extbrain] failed to persist ${payload.length} bytes of thread categories`
    );
  }
  return ok;
}

/** Cap on user-added categories: zero-shot scores every label per thread. */
export const MAX_CUSTOM_CATEGORIES = 16;

/**
 * Reserved id: the activity breakdown buckets verdict-less threads under
 * "untagged", so no category may take that id.
 */
const RESERVED_CATEGORY_ID = "untagged";

/**
 * Normalize a user-typed category name to a scoring id ("Machine Learning"
 * → "machine-learning"). Null when nothing usable remains or the id is
 * reserved. Ids stay template-safe for "The user's task or goal in this
 * conversation is related to {id}": lowercase alphanumerics plus dashes.
 */
export function normalizeCategoryId(raw: string): string | null {
  const slug = raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  if (!slug || slug === RESERVED_CATEGORY_ID) return null;
  return slug;
}

/** Display label derived from an id ("machine-learning" → "Machine Learning"). */
export function displayLabelForCategoryId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** User edits to the built-in taxonomy, persisted per dataset. */
export interface TaxonomyEdits {
  /** Built-in ids the user removed. */
  removed: string[];
  /** User-added categories, in add order. */
  added: CategoryDef[];
}

/** Validate stored or restored edits (localStorage and backups share this). */
export function normalizeTaxonomyEdits(raw: unknown): TaxonomyEdits {
  const builtinIds = new Set(CATEGORY_TAXONOMY.map((c) => c.id));
  const empty: TaxonomyEdits = { removed: [], added: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const r = raw as { removed?: unknown; added?: unknown };
  const removed: string[] = [];
  if (Array.isArray(r.removed)) {
    for (const v of r.removed) {
      if (typeof v === "string" && builtinIds.has(v) && !removed.includes(v)) {
        removed.push(v);
      }
    }
  }
  const added: CategoryDef[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.added)) {
    for (const v of r.added) {
      if (added.length >= MAX_CUSTOM_CATEGORIES) break;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const d = v as { id?: unknown; label?: unknown; description?: unknown };
      const id = typeof d.id === "string" ? normalizeCategoryId(d.id) : null;
      // Built-ins can only be removed/restored, never redefined.
      if (!id || builtinIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      added.push({
        id,
        label:
          typeof d.label === "string" && d.label.trim()
            ? d.label.trim().slice(0, 64)
            : displayLabelForCategoryId(id),
        description:
          typeof d.description === "string"
            ? d.description.trim().slice(0, 280)
            : "",
      });
    }
  }
  return { removed, added };
}

/**
 * The taxonomy in force: built-ins minus removals, plus customs in add
 * order. Floors to the built-ins when edits would leave nothing — scoring
 * and argmax always have at least one label.
 */
export function effectiveTaxonomy(edits: TaxonomyEdits): CategoryDef[] {
  const norm = normalizeTaxonomyEdits(edits);
  const removed = new Set(norm.removed);
  const out = CATEGORY_TAXONOMY.filter((c) => !removed.has(c.id));
  const seen = new Set(out.map((c) => c.id));
  for (const c of norm.added) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out.length > 0 ? out : [...CATEGORY_TAXONOMY];
}

const taxonomyKeyFor = (uuid: string) => `sb_taxonomy_${uuid}`;

export function loadTaxonomyEdits(uuid: string): TaxonomyEdits {
  try {
    return normalizeTaxonomyEdits(
      decodeStoredJson(localStorage.getItem(taxonomyKeyFor(uuid)))
    );
  } catch {
    return { removed: [], added: [] };
  }
}

export function saveTaxonomyEdits(
  uuid: string,
  edits: TaxonomyEdits
): boolean {
  const payload = encodeCompressedJson(normalizeTaxonomyEdits(edits));
  const ok = setStoredItem(taxonomyKeyFor(uuid), payload);
  if (!ok) {
    console.error(
      `[extbrain] failed to persist ${payload.length} bytes of taxonomy edits`
    );
  }
  return ok;
}
