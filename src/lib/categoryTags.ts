/**
 * Fixed category taxonomy for thread classification. Each thread is scored
 * ONCE against the 8 one-word category names with the zero-shot NLI
 * endpoint ("This text is about {name}.") over its joined chat texts, and
 * takes the argmax category. One verdict per thread key persists per
 * dataset alongside entities; Top Threads reads it directly.
 */
import {
  decodeStoredJson,
  encodeCompressedJson,
  setStoredItem,
} from "./compressedJson";
import { truncateAtWordBoundary } from "./entities";
import { ParsedActivityItem } from "./types";

export type CategoryId =
  | "productivity"
  | "finance"
  | "social"
  | "entertainment"
  | "health"
  | "travel"
  | "utilities"
  | "education";

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

/** Zero-shot candidate labels for /api/classify-batch (8 ids). */
export const CATEGORY_LABELS: string[] = CATEGORY_TAXONOMY.map((c) => c.id);

/** Bump to invalidate stored verdicts (taxonomy or scorer change). */
export const THREAD_CATEGORY_VERSION = 2;

export type CategoryScores = Record<CategoryId, number>;

/** Per-thread category verdict: content hash plus the full score map. */
export interface ThreadCategoryRecord {
  hash: string;
  version: number;
  scores: CategoryScores;
}

export type ThreadCategoryMap = Record<string, ThreadCategoryRecord>;

const zeroScores = (): CategoryScores => ({
  productivity: 0,
  finance: 0,
  social: 0,
  entertainment: 0,
  health: 0,
  travel: 0,
  utilities: 0,
  education: 0,
});

/**
 * Zero-shot label scores (one call, multi-label) to per-category scores:
 * each category reads its own one-word label, defaulting missing labels
 * to 0. Rounded to 4 decimals: full float precision would triple the
 * stored bytes across 16K chats for no ranking benefit.
 */
export function scoresToCategories(
  labelScores: Record<string, number>
): CategoryScores {
  const out = zeroScores();
  for (const c of CATEGORY_TAXONOMY) {
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
export function topCategory(scores: CategoryScores): CategoryId {
  let best: CategoryId = CATEGORY_TAXONOMY[0].id;
  let bestScore = -Infinity;
  for (const c of CATEGORY_TAXONOMY) {
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
export function buildThreadScoringText(chats: ParsedActivityItem[]): string {
  return truncateAtWordBoundary(
    chats.map((c) => buildCategoryScoringText(c)).join("\n\n"),
    800
  );
}

/** Display label for a category id ("productivity" → "Productivity"). */
export function categoryLabelFor(id: CategoryId): string {
  return CATEGORY_TAXONOMY.find((c) => c.id === id)?.label ?? id;
}

/**
 * True when a thread needs (re-)scoring: no verdict, changed text (new or
 * edited chats), or a verdict from before the current taxonomy/scorer
 * version.
 */
export function threadNeedsCategoryScoring(args: {
  entry: unknown;
  hash: string;
}): boolean {
  const rec = normalizeThreadCategoryRecord(args.entry);
  if (!rec) return true;
  if (rec.hash !== args.hash) return true;
  if (rec.version < THREAD_CATEGORY_VERSION) return true;
  return false;
}

function isCategoryId(v: unknown): v is CategoryId {
  return (
    typeof v === "string" &&
    (CATEGORY_TAXONOMY as Array<{ id: string }>).some((c) => c.id === v)
  );
}

function normalizeScores(raw: unknown): CategoryScores | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = zeroScores();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isCategoryId(k) && typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeThreadCategoryRecord(
  raw: unknown
): ThreadCategoryRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { hash?: unknown; version?: unknown; scores?: unknown };
  if (typeof r.hash !== "string") return null;
  const scores = normalizeScores(r.scores);
  if (!scores) return null;
  return {
    hash: r.hash,
    version: typeof r.version === "number" ? r.version : 0,
    scores,
  };
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
