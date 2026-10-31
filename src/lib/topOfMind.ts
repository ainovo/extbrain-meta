import { ChatEntityMap, expandEntityKeyGroups, normalizeEntityKey } from "./entities";
import { ThreadSummary, threadKeyOf } from "./threads";
import { ParsedActivityItem } from "./types";
import {
  CATEGORY_TAXONOMY,
  CategoryDef,
  CategoryId,
  ThreadCategoryMap,
  topCategory,
} from "./categoryTags";
import {
  TagDef,
  effectiveTagThreshold,
  taggedChatIds,
  tagVisibleIds,
} from "./tags";

export const TOP_OF_MIND_DAYS = 14;
export const TOP_LIST_LIMIT = 5;
/** Visible mentions per Top of Mind section (@ People, @ Places, @ Organizations). */
export const MENTION_LIST_LIMIT = 10;

export interface CategoryBreakdownRow {
  id: CategoryId | "untagged";
  chats: number;
  threads: number;
  durationMs: number;
}

export interface CategoryBreakdown {
  rows: CategoryBreakdownRow[];
  totalChats: number;
  totalThreads: number;
  totalDurationMs: number;
}

/**
 * Per-category shares over an explicit thread list (usually the threads in
 * the selected range). Verdicts come from the stored category map; threads
 * without one bucket into "untagged" so the shares always reconcile.
 * Duration is the sum of thread time spans (single-chat threads span
 * zero and contribute nothing there, by construction).
 */
export function buildCategoryBreakdown(
  threads: ThreadSummary[],
  categoryMap: ThreadCategoryMap,
  taxonomy: CategoryDef[] = CATEGORY_TAXONOMY
): CategoryBreakdown {
  const byId = new Map<CategoryId | "untagged", CategoryBreakdownRow>();
  const rowFor = (id: CategoryId | "untagged"): CategoryBreakdownRow => {
    let row = byId.get(id);
    if (!row) {
      row = { id, chats: 0, threads: 0, durationMs: 0 };
      byId.set(id, row);
    }
    return row;
  };
  let totalChats = 0;
  let totalDurationMs = 0;
  for (const t of threads) {
    const rec = categoryMap[t.key];
    const row = rowFor(rec ? topCategory(rec.scores, taxonomy) : "untagged");
    row.chats += t.chats.length;
    row.threads += 1;
    row.durationMs += threadDurationMs(t);
    totalChats += t.chats.length;
    totalDurationMs += threadDurationMs(t);
  }
  return {
    rows: [...byId.values()],
    totalChats,
    totalThreads: threads.length,
    totalDurationMs,
  };
}

export type ImportSource = "ChatGPT" | "Claude" | "Gemini" | "AI Mode" | "Obsidian" | "Other";

export const IMPORT_SOURCES: ImportSource[] = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "AI Mode",
  "Obsidian",
  "Other",
];

/** Canonical import origin for stacked stats (falls back to "Other"). */
export function sourceOfItem(it: ParsedActivityItem): ImportSource {
  const hay = `${it.header || ""} ${(it.products || []).join(" ")}`.toLowerCase();
  if (hay.includes("chatgpt")) return "ChatGPT";
  if (hay.includes("claude")) return "Claude";
  if (hay.includes("gemini")) return "Gemini";
  if (hay.includes("ai mode")) return "AI Mode";
  if (hay.includes("obsidian")) return "Obsidian";
  return "Other";
}

/** Local yyyy-mm-dd day key, or null when the timestamp is unusable. */
export function dayKeyOf(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return dayKeyOfDate(d);
}

/** Local yyyy-mm-dd day key for a Date (bucket edges are local noon). */
export function dayKeyOfDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface DailyStat {
  key: string;
  /** Local noon of the bucket day (for axis labels). */
  date: Date;
  chatsBySource: Record<ImportSource, number>;
  threadsBySource: Record<ImportSource, number>;
  totalChats: number;
  totalThreads: number;
}

/** Earliest and latest chat day keys in the data, or null when dateless. */
export function dataDayBounds(
  items: ParsedActivityItem[]
): { minKey: string; maxKey: string } | null {
  let minKey: string | null = null;
  let maxKey: string | null = null;
  for (const it of items) {
    if (!it.timestamp) continue;
    const key = dayKeyOf(it.timestamp);
    if (!key) continue;
    if (minKey === null || key < minKey) minKey = key;
    if (maxKey === null || key > maxKey) maxKey = key;
  }
  if (minKey === null || maxKey === null) return null;
  return { minKey, maxKey };
}

/**
 * Canonical mention keys of one chat's spans passing the score floor.
 * Same floor as aggregation (unscored legacy spans count as 0):
 * otherwise badges hide low-confidence spans that search still matches,
 * and the count never drops.
 */
function chatMentionKeys(
  entityMap: ChatEntityMap,
  chatId: string,
  minScore = 0
): Set<string> {
  const out = new Set<string>();
  for (const e of entityMap[chatId] || []) {
    if (!e || typeof e.name !== "string") continue;
    if ((typeof e.score === "number" ? e.score : 0) < minScore) continue;
    out.add(normalizeEntityKey(e.name));
  }
  return out;
}

/**
 * True when the mention set covers EVERY wanted group (AND across picks).
 * Canonical on both sides: pill keys, typed text, and stored variants
 * ("Asif's") all meet as one key; folded siblings ("boy" under
 * "soldier boy") join through each pick's own group.
 */
function coversAllGroups(
  mentioned: Set<string>,
  groups: Set<string>[]
): boolean {
  return groups.every((g) => {
    for (const k of g) {
      if (mentioned.has(k)) return true;
    }
    return false;
  });
}

/** Chats mentioning EVERY wanted entity (no thread expansion). */
export function filterChatsByEntities(
  items: ParsedActivityItem[],
  entityMap: ChatEntityMap,
  keys: string[],
  keyExpansion?: ReadonlyMap<string, readonly string[]>,
  minScore = 0
): ParsedActivityItem[] {
  const groups = expandEntityKeyGroups(keys, keyExpansion);
  if (groups.length === 0) return [];
  return items.filter((it) =>
    coversAllGroups(chatMentionKeys(entityMap, it.id, minScore), groups)
  );
}

/**
 * Thread-expanding entity filter: keep every chat of each thread whose
 * chats collectively mention EVERY wanted entity (the picks may land in
 * different chats of the thread), so results read as whole conversations.
 * Keyless chats must mention every entity themselves — they belong to no
 * thread to expand.
 */
export function filterItemsByEntities(
  items: ParsedActivityItem[],
  entityMap: ChatEntityMap,
  keys: string[],
  keyExpansion?: ReadonlyMap<string, readonly string[]>,
  minScore = 0
): ParsedActivityItem[] {
  const groups = expandEntityKeyGroups(keys, keyExpansion);
  if (groups.length === 0) return [];
  const threadMentions = new Map<string, Set<string>>();
  const keylessHit = new Set<string>();
  for (const it of items) {
    const mentioned = chatMentionKeys(entityMap, it.id, minScore);
    const k = threadKeyOf(it);
    if (k) {
      let acc = threadMentions.get(k);
      if (!acc) {
        acc = new Set<string>();
        threadMentions.set(k, acc);
      }
      for (const m of mentioned) acc.add(m);
    } else if (coversAllGroups(mentioned, groups)) {
      keylessHit.add(it.id);
    }
  }
  const hitThreads = new Set<string>();
  for (const [k, mentioned] of threadMentions) {
    if (coversAllGroups(mentioned, groups)) hitThreads.add(k);
  }
  return items.filter((it) => {
    const k = threadKeyOf(it);
    return k ? hitThreads.has(k) : keylessHit.has(it.id);
  });
}

/**
 * Threads-view combination of entity search with tag filters: whole
 * entity-hit threads are kept only when the thread also covers EVERY tag
 * (each tag matched by at least one of its chats); keyless chats must
 * satisfy both facets themselves. With no tags this behaves exactly like
 * filterItemsByEntities.
 */
export function filterThreadsByEntitiesAndTags(
  items: ParsedActivityItem[],
  entityMap: ChatEntityMap,
  keys: string[],
  tags: TagDef[],
  threshold: number,
  keyExpansion?: ReadonlyMap<string, readonly string[]>,
  minScore = 0
): ParsedActivityItem[] {
  const expanded = filterItemsByEntities(
    items,
    entityMap,
    keys,
    keyExpansion,
    minScore
  );
  if (tags.length === 0) return expanded;
  const perTagVisible = tags.map(
    (t) => new Set(taggedChatIds(t, effectiveTagThreshold(t, threshold)))
  );
  const threadChats = new Map<string, ParsedActivityItem[]>();
  for (const it of items) {
    const k = threadKeyOf(it);
    if (!k) continue;
    const list = threadChats.get(k);
    if (list) list.push(it);
    else threadChats.set(k, [it]);
  }
  const tagHitThreads = new Set<string>();
  for (const [k, chats] of threadChats) {
    if (
      perTagVisible.every((visible) => chats.some((c) => visible.has(c.id)))
    ) {
      tagHitThreads.add(k);
    }
  }
  const visibleAll = tagVisibleIds(tags, threshold);
  return expanded.filter((it) => {
    const k = threadKeyOf(it);
    return k ? tagHitThreads.has(k) : visibleAll.has(it.id);
  });
}

/**
 * Chats-page conjunction of the sticky tag facet with entity search: a
 * chat shows when it matches EVERY active tag (if any) AND mentions EVERY
 * wanted entity (if any is searched), so searching narrows tag-filtered
 * chats instead of replacing the filter. Either facet alone behaves as
 * before; with neither, every chat passes.
 */
export function filterChatsByTagsAndEntities(
  items: ParsedActivityItem[],
  tags: TagDef[],
  threshold: number,
  entityMap: ChatEntityMap,
  keys: string[],
  keyExpansion?: ReadonlyMap<string, readonly string[]>,
  minScore = 0
): ParsedActivityItem[] {
  let list = items;
  if (tags.length > 0) {
    const visible = tagVisibleIds(tags, threshold);
    list = list.filter((it) => visible.has(it.id));
  }
  if (keys.length > 0) {
    list = filterChatsByEntities(list, entityMap, keys, keyExpansion, minScore);
  }
  return list;
}

/**
 * Single-thread review keeps sticky tag filters: entity, text, and date
 * facets are bypassed there (a thread always reviews whole for those),
 * but tag filters persist across menu navigation, so dropping them the
 * moment a thread opens reads as "view filtered chats shows everything".
 * With no tags the whole thread reviews.
 */
export function filterThreadItemsByTags(
  threadItems: ParsedActivityItem[],
  tags: TagDef[],
  threshold: number
): ParsedActivityItem[] {
  if (tags.length === 0) return threadItems;
  const visible = tagVisibleIds(tags, threshold);
  return threadItems.filter((it) => visible.has(it.id));
}

/** Chats whose local day falls inside [startKey, endKey] (inclusive). */
export function filterItemsByRange(
  items: ParsedActivityItem[],
  startKey: string,
  endKey: string
): ParsedActivityItem[] {
  const lo = startKey <= endKey ? startKey : endKey;
  const hi = startKey <= endKey ? endKey : startKey;
  return items.filter((it) => {
    if (!it.timestamp) return false;
    const key = dayKeyOf(it.timestamp);
    return key !== null && key >= lo && key <= hi;
  });
}

function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

export interface RangeBucket {
  key: string;
  start: Date;
  end: Date;
  chatsBySource: Record<ImportSource, number>;
  threadsBySource: Record<ImportSource, number>;
  totalChats: number;
  totalThreads: number;
}

/** Inclusive day-key span of an activity bucket. */
export function bucketDayKeys(b: RangeBucket): {
  startKey: string;
  endKey: string;
} {
  return { startKey: dayKeyOfDate(b.start), endKey: dayKeyOfDate(b.end) };
}

/** Compact "Oct 20, 2026" / "Oct 12 – Oct 20, 2026" day-range label. */
export function formatDayRangeLabel(lo: string, hi: string): string {
  const [ly, lm, ld] = lo.split("-").map(Number);
  const [hy, hm, hd] = hi.split("-").map(Number);
  const start = new Date(ly, lm - 1, ld);
  const end = new Date(hy, hm - 1, hd);
  const startStr = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const endStr = end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (lo === hi)
    return end.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  if (ly !== hy) {
    return `${start.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })} – ${endStr}`;
  }
  return `${startStr} – ${endStr}`;
}

const BUCKET_STEPS = [
  { days: 1, granularity: "day" },
  { days: 7, granularity: "week" },
  { days: 14, granularity: "fortnight" },
  { days: 30, granularity: "month" },
  { days: 91, granularity: "quarter" },
  { days: 365, granularity: "year" },
] as const;

export type RangeGranularity = (typeof BUCKET_STEPS)[number]["granularity"];

export const GRANULARITY_LABEL: Record<RangeGranularity, string> = {
  day: "Daily",
  week: "Weekly",
  fortnight: "Biweekly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

/**
 * Activity buckets for an explicit day range (inclusive, oldest first). The
 * bucket size adapts so the chart never exceeds ~31 bars; days merge from
 * the oldest day, so the live edge stays exact. Chats sum across merged
 * days (each chat sits in exactly one day), while threads union: a thread
 * active on several days of one bucket counts once, so every "threads"
 * number is a distinct-thread count.
 */
export function buildRangeStats(
  items: ParsedActivityItem[],
  startKey: string,
  endKey: string
): { buckets: RangeBucket[]; granularity: RangeGranularity } {
  const lo = startKey <= endKey ? startKey : endKey;
  const hi = startKey <= endKey ? endKey : startKey;
  const start = parseDayKey(lo);
  const end = parseDayKey(hi);
  if (!start || !end) return { buckets: [], granularity: "day" };
  const spanDays =
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const count = Math.max(1, Math.min(spanDays, 3660));
  const endNoon = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12);
  const { stats: daily, dayThreads, threadSource } = buildDailyDetails(
    items,
    endNoon,
    count
  );
  const toBucket = (d: DailyStat): RangeBucket => ({
    key: d.key,
    start: d.date,
    end: d.date,
    chatsBySource: { ...d.chatsBySource },
    threadsBySource: { ...d.threadsBySource },
    totalChats: d.totalChats,
    totalThreads: d.totalThreads,
  });
  const step =
    BUCKET_STEPS.find((s) => Math.ceil(count / s.days) <= 31) ??
    BUCKET_STEPS[BUCKET_STEPS.length - 1];
  if (step.days === 1) {
    return { buckets: daily.map(toBucket), granularity: step.granularity };
  }
  const merged: RangeBucket[] = [];
  for (let i = 0; i < daily.length; i += step.days) {
    const group = daily.slice(i, i + step.days);
    const first = group[0];
    const last = group[group.length - 1];
    const chats = zeroSources();
    const threads = zeroSources();
    let totalChats = 0;
    // Union, not sum: a thread active on N days of this bucket is one
    // thread active in the bucket, not N.
    const seenThreads = new Set<string>();
    for (const d of group) {
      for (const s of IMPORT_SOURCES) {
        chats[s] += d.chatsBySource[s];
      }
      totalChats += d.totalChats;
      for (const key of dayThreads.get(d.key) ?? []) {
        if (seenThreads.has(key)) continue;
        seenThreads.add(key);
        threads[threadSource.get(key) ?? "Other"] += 1;
      }
    }
    const totalThreads = seenThreads.size;
    merged.push({
      key: first.key,
      start: first.date,
      end: last.date,
      chatsBySource: chats,
      threadsBySource: threads,
      totalChats,
      totalThreads,
    });
  }
  return { buckets: merged, granularity: step.granularity };
}

const zeroSources = (): Record<ImportSource, number> => ({
  ChatGPT: 0,
  Claude: 0,
  Gemini: 0,
  "AI Mode": 0,
  Obsidian: 0,
  Other: 0,
});

/**
 * Per-day activity for the last `days` local days ending today (oldest
 * first). Chats bucket by their own timestamp and source; threads bucket by
 * the days they were active in, attributed to the source of the thread's
 * earliest chat (threads don't cross import products in practice).
 * Chats with unusable timestamps are excluded from both modes.
 */
export function buildDailyStats(
  items: ParsedActivityItem[],
  now = new Date(),
  days = TOP_OF_MIND_DAYS
): DailyStat[] {
  return buildDailyDetails(items, now, days).stats;
}

interface DailyDetails {
  stats: DailyStat[];
  /** Distinct thread keys active per day key. */
  dayThreads: Map<string, Set<string>>;
  /** Thread key → source of its earliest chat (whole history). */
  threadSource: Map<string, ImportSource>;
}

/** Daily stats plus the thread identity behind the counts (for merging). */
function buildDailyDetails(
  items: ParsedActivityItem[],
  now: Date,
  days: number
): DailyDetails {
  const buckets = new Map<string, DailyStat>();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const key = dayKeyOf(date.toISOString());
    // dayKeyOf(local noon ISO) can't fail, but stay total either way.
    const safeKey =
      key ??
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
    buckets.set(safeKey, {
      key: safeKey,
      date: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12),
      chatsBySource: zeroSources(),
      threadsBySource: zeroSources(),
      totalChats: 0,
      totalThreads: 0,
    });
  }

  // Thread source = source of the thread's earliest chat (whole history, so
  // the attribution is stable regardless of the visible window).
  const threadSource = new Map<string, ImportSource>();
  const threadFirstSeen = new Map<string, string>();
  for (const it of items) {
    const key = threadKeyOf(it);
    if (!key || !it.timestamp) continue;
    const prev = threadFirstSeen.get(key);
    if (prev === undefined || it.timestamp.localeCompare(prev) < 0) {
      threadFirstSeen.set(key, it.timestamp);
      threadSource.set(key, sourceOfItem(it));
    }
  }

  const dayThreads = new Map<string, Set<string>>();
  for (const it of items) {
    const day = it.timestamp ? dayKeyOf(it.timestamp) : null;
    const bucket = day ? buckets.get(day) : undefined;
    if (!bucket) continue;
    bucket.chatsBySource[sourceOfItem(it)] += 1;
    bucket.totalChats += 1;
    const key = threadKeyOf(it);
    if (!key) continue;
    let set = dayThreads.get(day!);
    if (!set) {
      set = new Set();
      dayThreads.set(day!, set);
    }
    set.add(key);
  }
  for (const [day, keys] of dayThreads) {
    const bucket = buckets.get(day);
    if (!bucket) continue;
    for (const key of keys) {
      bucket.threadsBySource[threadSource.get(key) ?? "Other"] += 1;
      bucket.totalThreads += 1;
    }
  }
  return { stats: [...buckets.values()], dayThreads, threadSource };
}

/**
 * Distinct threads per import source over whole thread summaries. A thread
 * is attributed to its oldest chat (summaries sort chats oldest-first),
 * matching the earliest-chat rule in buildDailyStats. The counts sum to
 * summaries.length, so the Threads-mode legend reconciles with the range
 * subtitle — unlike per-bucket sums, where a thread active in two buckets
 * would count twice.
 */
export function countThreadsBySource(
  summaries: ThreadSummary[]
): Record<ImportSource, number> {
  const counts = zeroSources();
  for (const t of summaries) {
    const first = t.chats[0];
    counts[first ? sourceOfItem(first) : "Other"] += 1;
  }
  return counts;
}

/** First-to-last-chat span of a thread in milliseconds (0 when unknown). */
export function threadDurationMs(t: ThreadSummary): number {
  const s = Date.parse(t.startIso);
  const e = Date.parse(t.endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.max(0, e - s);
}

/** Compact human span: "45m", "5h", "3d 4h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

export type ThreadRankMode = "duration" | "chats";

/**
 * Re-points thread titles at the whole-thread first chat. Rankings are
 * computed on a ranged subset, but a thread's title must not shift when the
 * range clips its beginning.
 */
export function retitleThreads(
  threads: ThreadSummary[],
  all: ThreadSummary[]
): ThreadSummary[] {
  const titles = new Map(all.map((t) => [t.key, t.title]));
  return threads.map((t) => ({ ...t, title: titles.get(t.key) ?? t.title }));
}

/** Top threads by duration (default) or chat count. */
export function topThreads(
  threads: ThreadSummary[],
  mode: ThreadRankMode = "duration",
  limit = TOP_LIST_LIMIT
): ThreadSummary[] {
  const arr = [...threads];
  if (mode === "chats") {
    arr.sort(
      (a, b) => b.count - a.count || b.endIso.localeCompare(a.endIso)
    );
  } else {
    arr.sort(
      (a, b) =>
        threadDurationMs(b) - threadDurationMs(a) || b.count - a.count
    );
  }
  return arr.slice(0, Math.max(0, limit));
}

export interface MentionHighlight {
  key: string;
  display: string;
  /** Distinct linked threads mentioning this entity. */
  threadCount: number;
}

/**
 * Top entities of one NER type ranked by DISTINCT LINKED THREADS (a thread
 * counts once however many of its chats mention the entity). Keyless chats
 * are skipped: without a thread key there is nothing to count toward.
 */
export function topMentionsByThreads(
  entityMap: ChatEntityMap,
  items: ParsedActivityItem[],
  nerType: string,
  limit = TOP_LIST_LIMIT,
  minScore = 0
): MentionHighlight[] {
  const want = (nerType || "").toUpperCase();
  const chatThread = new Map<string, string>();
  for (const it of items) {
    const key = threadKeyOf(it);
    if (key) chatThread.set(it.id, key);
  }
  const acc = new Map<
    string,
    {
      forms: Map<string, number>;
      threads: Set<string>;
    }
  >();
  for (const [chatId, ents] of Object.entries(entityMap)) {
    const threadKey = chatThread.get(chatId);
    if (!threadKey) continue;
    const seen = new Set<string>();
    for (const e of ents || []) {
      if (!e || typeof e.name !== "string") continue;
      if ((e.type || "").toUpperCase() !== want) continue;
      if ((typeof e.score === "number" ? e.score : 0) < minScore) continue;
      const key = normalizeEntityKey(e.name);
      if (key.length < 2 || seen.has(key)) continue;
      seen.add(key);
      let a = acc.get(key);
      if (!a) {
        a = { forms: new Map(), threads: new Set() };
        acc.set(key, a);
      }
      const form = e.name.trim();
      a.forms.set(form, (a.forms.get(form) || 0) + 1);
      a.threads.add(threadKey);
    }
  }
  const out: MentionHighlight[] = [];
  for (const [key, a] of acc) {
    if (a.threads.size === 0) continue;
    out.push({
      key,
      display:
        [...a.forms.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? key,
      threadCount: a.threads.size,
    });
  }
  out.sort(
    (a, b) => b.threadCount - a.threadCount || a.display.localeCompare(b.display)
  );
  return out.slice(0, Math.max(0, limit));
}
