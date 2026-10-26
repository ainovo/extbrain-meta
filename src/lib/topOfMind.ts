import { ChatEntityMap, normalizeEntityKey } from "./entities";
import { ThreadSummary, threadKeyOf } from "./threads";
import { ParsedActivityItem } from "./types";

export const TOP_OF_MIND_DAYS = 14;
export const TOP_LIST_LIMIT = 5;

export type ImportSource = "ChatGPT" | "Gemini" | "AI Mode" | "Obsidian" | "Other";

export const IMPORT_SOURCES: ImportSource[] = [
  "ChatGPT",
  "Gemini",
  "AI Mode",
  "Obsidian",
  "Other",
];

/** Canonical import origin for stacked stats (falls back to "Other"). */
export function sourceOfItem(it: ParsedActivityItem): ImportSource {
  const hay = `${it.header || ""} ${(it.products || []).join(" ")}`.toLowerCase();
  if (hay.includes("chatgpt")) return "ChatGPT";
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
 * the oldest day, so the live edge stays exact.
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
  const daily = buildDailyStats(items, endNoon, count);
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
    let totalThreads = 0;
    for (const d of group) {
      for (const s of IMPORT_SOURCES) {
        chats[s] += d.chatsBySource[s];
        threads[s] += d.threadsBySource[s];
      }
      totalChats += d.totalChats;
      totalThreads += d.totalThreads;
    }
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
  return [...buckets.values()];
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
