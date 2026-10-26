import { ParsedActivityItem } from "./types";

export function threadKeyOf(item: ParsedActivityItem): string | null {
  return item.threadUrl || item.titleUrl || null;
}

export interface ThreadSummary {
  key: string;
  /** First (oldest) prompt in the thread — the topic setter. */
  title: string;
  count: number;
  startIso: string;
  endIso: string;
  /** Chats oldest-first (conversation order). */
  chats: ParsedActivityItem[];
}

/**
 * Cluster every chat by source thread across the whole list (not just
 * adjacent items), so a thread resumed across dates appears once. Threads
 * sort by most recent activity; chats within a thread sort oldest-first.
 */
export function summarizeThreads(items: ParsedActivityItem[]): ThreadSummary[] {
  const map = new Map<string, ParsedActivityItem[]>();
  for (const it of items) {
    const key = threadKeyOf(it);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(it);
    else map.set(key, [it]);
  }
  const out: ThreadSummary[] = [];
  for (const [key, arr] of map) {
    arr.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const firstPrompt =
      arr[0].turns[0]?.prompt?.trim() ||
      arr[0].title?.trim() ||
      "Untitled thread";
    out.push({
      key,
      title: firstPrompt,
      count: arr.length,
      startIso: arr[0].timestamp,
      endIso: arr[arr.length - 1].timestamp,
      chats: arr,
    });
  }
  out.sort((a, b) => b.endIso.localeCompare(a.endIso));
  return out;
}
