import {
  decodeStoredJson,
  encodeCompressedJson,
  setStoredItem,
} from "./compressedJson";

export interface TagScores {
  /** Max score across the tag's target_labels. */
  t: number;
  /** Max score across the tag's contrast_labels. */
  c: number;
}

export interface TagDef {
  id: string;
  /** Short 2-4 word tag name, e.g. "paid acquisition". */
  name: string;
  /** The user's original one-line description. */
  description: string;
  targetLabels: string[];
  contrastLabels: string[];
  /** YYYY-MM-DD evaluation window bounds, or null for unbounded. */
  dateStart: string | null;
  dateEnd: string | null;
  /** Per-chat zero-shot NLI scores, keyed by chat id. */
  scores: Record<string, TagScores>;
  /** Per-tag match threshold override. Falls back to the global threshold when unset. */
  threshold?: number;
  /** How many chats were queued for scoring when the run started. */
  totalChats?: number;
  createdAt: string;
  /** Set when a run scores every queued chat. Null while running/interrupted. */
  completedAt: string | null;
}

export const DEFAULT_TAG_THRESHOLD = 0.4;

/** This tag's threshold, falling back to the global one when unset. */
export function effectiveTagThreshold(tag: TagDef, fallback: number): number {
  return typeof tag.threshold === "number" ? tag.threshold : fallback;
}

/** Intersection of chat ids matching EVERY tag at each tag's own threshold. */
export function tagVisibleIds(tags: TagDef[], threshold: number): Set<string> {
  if (tags.length === 0) return new Set<string>();
  let ids: Set<string> | null = null;
  for (const tag of tags) {
    const mine = new Set(
      taggedChatIds(tag, effectiveTagThreshold(tag, threshold))
    );
    if (ids === null) {
      ids = mine;
    } else {
      for (const id of ids) {
        if (!mine.has(id)) ids.delete(id);
      }
    }
    if (ids.size === 0) break;
  }
  return ids ?? new Set<string>();
}

const keyFor = (uuid: string) => `sb_tags_${uuid}`;

export function newTagId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `tag-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function loadTags(uuid: string): TagDef[] {
  try {
    const parsed = decodeStoredJson(localStorage.getItem(keyFor(uuid)));
    return Array.isArray(parsed) ? (parsed as TagDef[]) : [];
  } catch {
    return [];
  }
}

export function saveTags(uuid: string, tags: TagDef[]): boolean {
  const payload = encodeCompressedJson(tags);
  const ok = setStoredItem(keyFor(uuid), payload);
  if (!ok) {
    console.error(
      `[extbrain] failed to persist ${payload.length} bytes of tags`
    );
  }
  return ok;
}

/** Chats passing the auto-tag rule, highest target score first. */
export function taggedChatIds(tag: TagDef, threshold: number): string[] {
  return Object.entries(tag.scores)
    .filter(([, s]) => s.t >= threshold && s.t > s.c)
    .sort((a, b) => b[1].t - a[1].t)
    .map(([id]) => id);
}

export function estimateSeconds(chatCount: number): number {
  // Rough server-side zero-shot throughput (~3 chats/sec with micro-batches).
  return Math.ceil(chatCount * 0.35);
}

export interface ChatLike {
  id: string;
  timestamp: string;
}

/** Chats whose date falls inside [start, end] (inclusive, YYYY-MM-DD). */
export function inDateRange<T extends ChatLike>(
  items: T[],
  start: string | null,
  end: string | null
): T[] {
  return items.filter((it) => {
    const d = it.timestamp.slice(0, 10);
    if (!d) return true;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

export function formatEstimate(chatCount: number): string {
  if (chatCount === 0) return "0 chats";
  const secs = estimateSeconds(chatCount);
  if (secs < 60) return `~${chatCount} chats · ~${secs}s`;
  const mins = Math.round(secs / 60);
  return `~${chatCount} chats · ~${mins} min`;
}

/**
 * Display form of a tag name: "#name". Stored names stay bare (matching
 * and thresholds key off them), so the prefix applies at render only, and
 * names users already wrote with "#" are left alone.
 */
export function displayTagName(name: string): string {
  return name.startsWith("#") ? name : `#${name}`;
}

export interface TagFilterHeaderEntry {
  tagId: string;
  tagName: string;
  /** First target label, or null when the tag has none. */
  match: string | null;
  /** First contrast label, or null when the tag excludes nothing. */
  exclude: string | null;
  targetLabels: string[];
  contrastLabels: string[];
}

export interface TagFilterHeader {
  /** Page title for the filtered list: "" / "#a" / "#a + #b". */
  title: string;
  entries: TagFilterHeaderEntry[];
  /** Labels hidden behind the expander (total minus shown bullets). */
  hiddenCount: number;
}

/**
 * Header model for the tag-filtered chats page: the tag name(s) replace
 * the generic title, the subtitle shows one match/exclude bullet per tag,
 * and the expander count covers every leftover label.
 */
export function describeTagFilter(
  tags: Array<{
    id: string;
    name: string;
    targetLabels: string[];
    contrastLabels: string[];
  }>
): TagFilterHeader {
  const entries: TagFilterHeaderEntry[] = tags.map((t) => ({
    tagId: t.id,
    tagName: t.name,
    match: t.targetLabels.length > 0 ? t.targetLabels[0] : null,
    exclude: t.contrastLabels.length > 0 ? t.contrastLabels[0] : null,
    targetLabels: [...t.targetLabels],
    contrastLabels: [...t.contrastLabels],
  }));
  let shown = 0;
  let total = 0;
  for (const e of entries) {
    if (e.match !== null) shown++;
    if (e.exclude !== null) shown++;
    total += e.targetLabels.length + e.contrastLabels.length;
  }
  return {
    title: tags.map((t) => displayTagName(t.name)).join(" + "),
    entries,
    hiddenCount: Math.max(0, total - shown),
  };
}
