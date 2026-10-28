import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, CalendarDays, X } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import { MarkdownInline } from "./MarkdownView";
import { summarizeThreads, ThreadSummary } from "../lib/threads";
import { formatDayRangeLabel } from "../lib/topOfMind";
import {
  CategoryDef,
  categoryLabelFor,
  ThreadCategoryMap,
  topCategory,
} from "../lib/categoryTags";
import {
  ChatEntityMap,
  EntityAggregate,
  topEntitiesForChatIds,
} from "../lib/entities";
import MentionSearchBar from "./MentionSearchBar";

const PAGE_SIZE = 20;

interface ThreadsViewProps {
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  /** Shared App-level aggregation for the mention search bar. */
  mentionCandidates: EntityAggregate[];
  onOpenThread: (key: string) => void;
  activeDateRange?: { start: string; end: string } | null;
  onClearDateRange?: () => void;
  minScore?: number;
  /** Entity filter owned by App (pre-applied to items, thread-expanded). */
  activeEntities: string[];
  onSelectEntities: (keys: string[]) => void;
  /** Per-thread category verdicts; subtitle tag renders only when present. */
  categoryMap?: ThreadCategoryMap;
  /** Taxonomy in force for the subtitle tag. */
  taxonomy: CategoryDef[];
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Unknown date";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type SortMode = "chatted" | "recent";

/**
 * One rendered thread row; its top mentions fold only this thread's chats.
 * Previously every menu visit folded mentions for ALL threads up front
 * (one aggregateEntities per thread), stalling navigation on large
 * histories. Now only mounted (visible) rows pay, and the subset per row
 * is tiny.
 */
const ThreadRow = React.memo(function ThreadRow({
  thread,
  entityMap,
  minScore,
  onOpenThread,
  categoryMap,
  taxonomy,
}: {
  thread: ThreadSummary;
  entityMap: ChatEntityMap;
  minScore: number;
  onOpenThread: (key: string) => void;
  categoryMap: ThreadCategoryMap;
  taxonomy: CategoryDef[];
}) {
  const topMentions = useMemo(
    () =>
      topEntitiesForChatIds(
        thread.chats.map((c) => c.id),
        entityMap,
        3,
        minScore
      ),
    [thread, entityMap, minScore]
  );
  const range =
    localDayKey(thread.startIso) === localDayKey(thread.endIso)
      ? fmtDay(thread.startIso)
      : `${fmtDay(thread.startIso)} → ${fmtDay(thread.endIso)}`;
  const rec = categoryMap[thread.key];
  const tag = rec ? topCategory(rec.scores, taxonomy) : null;
  return (
    <li>
      <div className="flex items-start gap-3 px-1 py-3 group">
        <button
          type="button"
          onClick={() => onOpenThread(thread.key)}
          className="min-w-0 flex-1 text-left"
          title={`View ${thread.count} ${thread.count === 1 ? "chat" : "chats"} in this thread`}
        >
          <div className="text-sm font-medium text-ink group-hover:underline underline-offset-2 line-clamp-2">
            <MarkdownInline markdown={thread.title} />
          </div>
          <div className="text-[11px] text-mention mt-0.5 flex items-center gap-1.5">
            <span>
              {thread.count} {thread.count === 1 ? "chat" : "chats"} ·{" "}
              {range}
            </span>
            {tag && (
              <span
                title={`Top category: ${categoryLabelFor(tag, taxonomy)}`}
                className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention"
              >
                #{tag}
              </span>
            )}
          </div>
          {topMentions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {topMentions.map((m) => (
                <span
                  key={m.key}
                  title={`${m.display} — in ${m.chatCount} of this thread's chats`}
                  className="inline-flex items-center gap-1 rounded-full bg-mention px-2 py-0.5 text-[11px] font-medium text-white"
                >
                  {m.display}
                  <span className="font-mono text-white/70">
                    {m.chatCount}
                  </span>
                </span>
              ))}
            </div>
          )}
        </button>
      </div>
    </li>
  );
});

export const ThreadsView: React.FC<ThreadsViewProps> = ({
  items,
  entityMap,
  mentionCandidates,
  onOpenThread,
  activeDateRange,
  onClearDateRange,
  minScore = 0,
  activeEntities,
  onSelectEntities,
  categoryMap = {},
  taxonomy,
}) => {
  const [sort, setSort] = useState<SortMode>("chatted");
  const [renderCount, setRenderCount] = useState(PAGE_SIZE);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const threads = useMemo(() => summarizeThreads(items), [items]);

  const sortedThreads = useMemo(() => {
    const list = [...threads];
    list.sort((a, b) => {
      if (sort === "chatted") {
        if (b.count !== a.count) return b.count - a.count;
      }
      return b.endIso.localeCompare(a.endIso);
    });
    return list;
  }, [threads, sort]);

  useEffect(() => {
    setRenderCount(PAGE_SIZE);
  }, [sort, threads]);

  const totalRef = useRef(sortedThreads.length);
  totalRef.current = sortedThreads.length;

  const setSentinel = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) return;
    const ob = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setRenderCount((c) => Math.min(c + PAGE_SIZE, totalRef.current));
        }
      },
      { rootMargin: "1000px" }
    );
    ob.observe(el);
    observerRef.current = ob;
  }, []);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  const sortBtn = (isActive: boolean) =>
    `inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium transition ${isActive ? "bg-action text-white" : "text-mention hover:text-ink"}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 px-1">
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
            Threads
          </h2>
          <p className="text-[13px] text-mention mt-1">
            {threads.length}{" "}
            {threads.length === 1 ? "thread" : "threads"}
            {Object.keys(entityMap).length === 0
              ? " · process chats on the Load page to see top mentions"
              : ""}
          </p>
        </div>
        <div className="flex-1" />
        {activeEntities.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeEntities.map((k) => {
              const display =
                mentionCandidates.find((c) => c.key === k)?.display ?? k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() =>
                    onSelectEntities(activeEntities.filter((x) => x !== k))
                  }
                  title={`Remove ${display}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-mention px-3 py-1 text-xs font-medium text-white hover:bg-ink transition"
                >
                  <span className="max-w-48 truncate">{display}</span>
                  <X className="w-3 h-3 opacity-70 shrink-0" />
                </button>
              );
            })}
          </div>
        )}
        <div
          className="flex items-center gap-0.5 rounded-full bg-tag p-0.5 shrink-0"
          role="group"
          aria-label="Sort threads"
        >
          <ArrowUpDown
            className="w-3.5 h-3.5 ml-2 text-mention/60 shrink-0"
            aria-hidden
          />
          <button
            type="button"
            onClick={() => setSort("chatted")}
            className={sortBtn(sort === "chatted")}
            title="Rank threads by chat count, most chatted first"
          >
            Most chatted
          </button>
          <button
            type="button"
            onClick={() => setSort("recent")}
            className={sortBtn(sort === "recent")}
            title="Sort threads by last chat timestamp, newest first"
          >
            Most recent
          </button>
        </div>
      </div>

      {activeDateRange && onClearDateRange && (
        <div className="flex items-center gap-1.5 px-1">
          <button
            type="button"
            onClick={onClearDateRange}
            title="Remove this date filter"
            className="inline-flex items-center gap-1.5 rounded-full bg-mention px-3 py-1 text-xs font-medium text-white hover:bg-ink transition-colors shrink-0 max-w-64"
          >
            <CalendarDays className="w-3.5 h-3.5 text-white/70 shrink-0" />
            <span className="truncate">
              {formatDayRangeLabel(activeDateRange.start, activeDateRange.end)}
            </span>
            <X className="w-3 h-3 opacity-60 shrink-0" />
          </button>
        </div>
      )}

      {(threads.length > 0 || activeEntities.length > 0) && (
        <MentionSearchBar
          key={activeEntities.join("\n")}
          candidates={mentionCandidates}
          hasEntities={Boolean(Object.keys(entityMap).length)}
          onViewChats={(keys) => {
            // Additive: a search narrows on top of the header filters
            // instead of replacing them; pills remove filters.
            const merged = [...activeEntities];
            for (const k of keys) {
              if (!merged.includes(k)) merged.push(k);
            }
            onSelectEntities(merged);
          }}
          excludeKeys={activeEntities}
          stagePicks
        />
      )}

       {sortedThreads.length === 0 ? (
        <div className="text-center text-sm text-mention/60 py-16">
          {activeEntities.length > 0
            ? "No threads mention the selected entities."
            : items.length === 0
            ? "No chats loaded yet."
            : "No threads here — none of these chats carry a source link."}
        </div>
      ) : (
        <>
        <ul className="divide-y divide-divider/70">
          {sortedThreads.slice(0, renderCount).map((t) => (
            <ThreadRow
              key={t.key}
              thread={t}
              entityMap={entityMap}
              minScore={minScore}
              onOpenThread={onOpenThread}
              categoryMap={categoryMap}
              taxonomy={taxonomy}
            />
          ))}
         </ul>
         {renderCount < sortedThreads.length && (
           <div ref={setSentinel} className="h-4" aria-hidden />
         )}
        </>
       )}

    </div>
  );
};
