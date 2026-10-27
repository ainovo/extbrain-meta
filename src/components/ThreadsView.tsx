import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, CalendarDays, X } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import { MarkdownInline } from "./MarkdownView";
import { summarizeThreads, ThreadSummary } from "../lib/threads";
import { formatDayRangeLabel } from "../lib/topOfMind";
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
  onOpenThread: (key: string) => void;
  activeDateRange?: { start: string; end: string } | null;
  onClearDateRange?: () => void;
  minScore?: number;
  /** Entity filter owned by App (pre-applied to items, thread-expanded). */
  activeEntities: string[];
  onSelectEntities: (keys: string[]) => void;
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

interface ThreadWithMentions extends ThreadSummary {
  topMentions: EntityAggregate[];
}

type SortMode = "chatted" | "recent";

export const ThreadsView: React.FC<ThreadsViewProps> = ({
  items,
  entityMap,
  onOpenThread,
  activeDateRange,
  onClearDateRange,
  minScore = 0,
  activeEntities,
  onSelectEntities,
}) => {
  const [sort, setSort] = useState<SortMode>("chatted");
  const [renderCount, setRenderCount] = useState(PAGE_SIZE);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const threads = useMemo(() => summarizeThreads(items), [items]);

  const withMentions: ThreadWithMentions[] = useMemo(
    () =>
      threads.map((t) => ({
        ...t,
        topMentions: topEntitiesForChatIds(
          t.chats.map((c) => c.id),
          entityMap,
          3,
          minScore
        ),
      })),
    [threads, entityMap, minScore]
  );

  const sortedThreads = useMemo(() => {
    const list = [...withMentions];
    list.sort((a, b) => {
      if (sort === "chatted") {
        if (b.count !== a.count) return b.count - a.count;
      }
      return b.endIso.localeCompare(a.endIso);
    });
    return list;
  }, [withMentions, sort]);

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
          entityMap={entityMap}
          hasEntities={Boolean(Object.keys(entityMap).length)}
          onViewChats={onSelectEntities}
          minScore={minScore}
          initialKeys={activeEntities}
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
          {sortedThreads.slice(0, renderCount).map((t) => {
            const range =
              localDayKey(t.startIso) === localDayKey(t.endIso)
                ? fmtDay(t.startIso)
                : `${fmtDay(t.startIso)} → ${fmtDay(t.endIso)}`;
            return (
              <li key={t.key}>
                <div className="flex items-start gap-3 px-1 py-3 group">
                  <button
                    type="button"
                    onClick={() => onOpenThread(t.key)}
                    className="min-w-0 flex-1 text-left"
                    title={`View ${t.count} ${t.count === 1 ? "chat" : "chats"} in this thread`}
                  >
                    <div className="text-sm font-medium text-ink group-hover:underline underline-offset-2 line-clamp-2">
                      <MarkdownInline markdown={t.title} />
                    </div>
                    <div className="text-[11px] text-mention mt-0.5">
                      {t.count} {t.count === 1 ? "chat" : "chats"} ·{" "}
                      {range}
                    </div>
                    {t.topMentions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {t.topMentions.map((m) => (
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
           })}
         </ul>
         {renderCount < sortedThreads.length && (
           <div ref={setSentinel} className="h-4" aria-hidden />
         )}
        </>
       )}

    </div>
  );
};
