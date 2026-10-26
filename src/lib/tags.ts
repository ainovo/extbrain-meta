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
  /** Per-chat ModernBERT scores, keyed by chat id. */
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
    const raw = localStorage.getItem(keyFor(uuid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TagDef[]) : [];
  } catch {
    return [];
  }
}

export function saveTags(uuid: string, tags: TagDef[]): void {
  try {
    localStorage.setItem(keyFor(uuid), JSON.stringify(tags));
  } catch {
    // Quota or privacy mode: scores stay in memory for the session.
  }
}

/** Chats passing the auto-tag rule, highest target score first. */
export function taggedChatIds(tag: TagDef, threshold: number): string[] {
  return Object.entries(tag.scores)
    .filter(([, s]) => s.t >= threshold && s.t > s.c)
    .sort((a, b) => b[1].t - a[1].t)
    .map(([id]) => id);
}

export function estimateSeconds(chatCount: number): number {
  // Rough server-side ModernBERT throughput (~3 chats/sec with micro-batches).
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
