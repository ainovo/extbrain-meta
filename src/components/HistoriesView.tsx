import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MessagesSquare,
  ExternalLink,
  CalendarDays,
  ChevronDown,
  X,
} from "lucide-react";
import { describeTagFilter, displayTagName } from "../lib/tags";
import {
  DEFAULT_MAX_TOKENS_PER_BATCH,
  ModelEndpointConfig,
  ParsedActivityItem,
} from "../lib/types";
import {
  ChatEntityMap,
  EntityAggregate,
  topEntitiesForChatIds,
} from "../lib/entities";
import { formatDayRangeLabel } from "../lib/topOfMind";
import { splitTextWithUrls } from "../lib/urlPreview";
import { MarkdownInline, MarkdownView } from "./MarkdownView";
import { UrlChip } from "./UrlChip";
import MentionSearchBar from "./MentionSearchBar";
import {
  ThreadSummaryButton,
  ThreadSummaryPanel,
  useThreadSummary,
} from "./ThreadSummary";

const PAGE_SIZE = 10;
const EMPTY_TOKENS: string[] = [];
/** Most subtitle pills ever shown collapsed; narrow rows fit fewer. */
const MAX_VISIBLE_PILLS = 6;
/** Fallback pill-row gap in px when it can't be measured (gap-1.5). */
const PILL_GAP_FALLBACK = 6;

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Unknown date";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function highlightText(text: string, tokens: string[]): React.ReactNode {
  if (!text || tokens.length === 0) return text;
  const escaped = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  let re: RegExp;
  try {
    re = new RegExp(`(${escaped.join("|")})`, "gi");
  } catch {
    return text;
  }
  const lowered = new Set(tokens.map((t) => t.toLowerCase()));
  return (
    <>
      {text.split(re).map((p, i) =>
        p && lowered.has(p.toLowerCase()) ? (
          <mark key={i} className="bg-divider/50 text-inherit rounded-sm px-px">
            {p}
          </mark>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  );
}

export interface ActiveTagInfo {
  id: string;
  name: string;
  targetLabels: string[];
  contrastLabels: string[];
}

interface Props {
  items: ParsedActivityItem[];
  totalCount: number;
  /** List-mode heading (thread mode always shows the thread title). */
  title?: string;
  /** Extra controls at the end of the sticky header row (e.g. date range). */
  headerExtra?: React.ReactNode;
  /** List mode: summarize the visible chats from the header (Archive). */
  archiveSummary?: boolean;
  entityMap: ChatEntityMap;
  /** Shared App-level aggregation for the mention search bar. */
  mentionCandidates: EntityAggregate[];
  onSelectEntities: (keys: string[]) => void;
  scrollTarget: { day: string | null; nonce: number };
  onVisibleDayChange: (dayKey: string) => void;
  activeTags: ActiveTagInfo[];
  onToggleTag: (id: string) => void;
  activeEntities: string[];
  onToggleEntity: (key: string) => void;
  activeDateRange?: { start: string; end: string } | null;
  onClearDateRange?: () => void;
  onOpenThread: (key: string) => void;
  activeThreadKey?: string | null;
  activeThreadTitle?: string | null;
  onShowAllThreads?: () => void;
  uuid?: string;
  synthesisModel?: ModelEndpointConfig;
  maxTokensPerBatch?: number;
  onOpenModelSettings?: () => void;
  minScore?: number;
}

function formatDayLabel(dayKey: string): string {
  if (dayKey === "Unknown date") return dayKey;
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Renders a user prompt with bare URLs as inline sneak-peek pills (hover
 * cards come from the global UrlPreviewLayer). Search highlighting applies
 * to the surrounding prose; link pills keep their title/host label.
 */
function renderPromptText(text: string, tokens: string[]): React.ReactNode {
  if (!text || !/https?:\/\//.test(text)) return highlightText(text, tokens);
  return (
    <>
      {splitTextWithUrls(text).map((seg, i) =>
        seg.kind === "url" ? (
          <React.Fragment key={i}>
            <UrlChip url={seg.url} variant="inline" maxLabelWidth="max-w-48" />
            {seg.trail}
          </React.Fragment>
        ) : (
          <React.Fragment key={i}>
            {highlightText(seg.text, tokens)}
          </React.Fragment>
        )
      )}
    </>
  );
}

function scrollToChat(id: string) {
  requestAnimationFrame(() => {
    let el: HTMLElement | null = null;
    try {
      el = document.getElementById(`chat-${CSS.escape(id)}`);
    } catch {
      el = document.getElementById(`chat-${id}`);
    }
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function ThreadEntityPill({
  display,
  chatCount,
}: {
  display: string;
  chatCount: number;
}) {
  return (
    <span
      title={`${display} — ${chatCount} ${chatCount === 1 ? "chat" : "chats"}`}
      className="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] text-ink whitespace-nowrap shrink-0"
    >
      <span className="max-w-48 truncate">{display}</span>
      <span className="text-mention/70 font-mono shrink-0">{chatCount}</span>
    </span>
  );
}

export const ChatCard = React.memo(function ChatCard({
  item,
  highlightTokens,
  thread,
  onOpenThread,
}: {
  item: ParsedActivityItem;
  highlightTokens: string[];
  thread?: { key: string; size: number };
  onOpenThread?: (key: string) => void;
}) {
  return (
    <div id={`chat-${item.id}`} className="space-y-3 scroll-mt-48 md:scroll-mt-4">
      <div className="flex items-center justify-center gap-2">
        <span className="inline-block rounded-full bg-tag px-3 py-1 text-[11px] text-mention font-mono">
          {formatLocalTime(item.timestamp)} • {item.header}
        </span>
        {thread && thread.size > 1 && onOpenThread && (
          <button
            type="button"
            onClick={() => onOpenThread(thread.key)}
            title={`View thread (${thread.size} chats)`}
            aria-label={`View thread (${thread.size} chats)`}
            className="p-1.5 rounded-full text-mention/60 hover:text-ink hover:bg-tag transition"
          >
            <MessagesSquare className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* threadUrl provides grouping; resume link removed */}
      {item.turns.map((t, idx) => (
        <div key={idx} className="space-y-4">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-tag px-4 py-2.5 text-[13.5px] leading-relaxed text-ink whitespace-pre-wrap break-words">
              {renderPromptText(t.prompt, highlightTokens)}
            </div>
          </div>
          {t.responseMarkdown && (
            <div className="flex justify-start">
              <MarkdownView
                markdown={t.responseMarkdown.slice(0, 8000)}
                className="w-full text-[13.5px] leading-relaxed text-ink ai-rich min-w-0 break-words"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

export const HistoriesView: React.FC<Props> = ({
  items,
  totalCount,
  title = "Chats",
  headerExtra,
  archiveSummary = false,
  entityMap,
  mentionCandidates,
  onSelectEntities,
  scrollTarget,
  onVisibleDayChange,
  activeTags,
  onToggleTag,
  activeEntities,
  onToggleEntity,
  activeDateRange,
  onClearDateRange,
  onOpenThread,
  activeThreadKey,
  activeThreadTitle,
  onShowAllThreads,
  uuid,
  synthesisModel,
  maxTokensPerBatch,
  onOpenModelSettings,
  minScore = 0,
}) => {
  const [renderCount, setRenderCount] = useState(PAGE_SIZE);
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const [showAllThreadEntities, setShowAllThreadEntities] = useState(false);
  const [showTagDetails, setShowTagDetails] = useState(false);
  const [pillFitCount, setPillFitCount] = useState(MAX_VISIBLE_PILLS);
  const pillRowRef = useRef<HTMLDivElement | null>(null);
  const pillMeasureRef = useRef<HTMLDivElement | null>(null);
  const pillPanelRef = useRef<HTMLDivElement | null>(null);
  const tagPanelRef = useRef<HTMLDivElement | null>(null);
  const tagToggleRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Same ordering everywhere: newest first, matching the history view.
  const ordered = useMemo(() => {
    return [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [items]);

  // Reset the render window whenever the list changes (new filter, new load, delete).
  useEffect(() => {
    setRenderCount(PAGE_SIZE);
    setPendingScrollId(null);
  }, [items]);

  const rendered = useMemo(
    () => ordered.slice(0, renderCount),
    [ordered, renderCount]
  );

  // How many filtered chats share each source thread; chats in a
  // multi-chat thread get an indicator that jumps to the Threads view.
  const threadSizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of ordered) {
      const k = it.threadUrl || it.titleUrl || null;
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [ordered]);

  // Total for the sentinel closure; kept in a ref so the observer callback
  // never goes stale regardless of when it fires.
  const totalRef = useRef(ordered.length);
  totalRef.current = ordered.length;

  // Infinite scroll: callback ref owns the observer's lifecycle, so it can't
  // desync from the sentinel element the way an effect can.
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

  // Sidebar day click → expand window if needed, then scroll to the chat.
  useEffect(() => {
    if (!scrollTarget.day) return;
    const idx = ordered.findIndex(
      (it) => localDayKey(it.timestamp) === scrollTarget.day
    );
    if (idx === -1) return;
    const id = ordered[idx].id;
    if (idx >= renderCount) {
      setRenderCount(idx + 5);
      setPendingScrollId(id);
      return;
    }
    scrollToChat(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);

  useEffect(() => {
    if (!pendingScrollId) return;
    scrollToChat(pendingScrollId);
    setPendingScrollId(null);
  }, [renderCount, pendingScrollId]);

  // Scroll-spy: highlight the sidebar day for whichever day divider
  // currently sits near the top of the viewport.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const dividers = Array.from(
      root.querySelectorAll<HTMLElement>("[data-day-divider]")
    );
    if (dividers.length === 0) return;
    const ob = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const key = (e.target as HTMLElement).dataset.dayDivider;
            if (key) onVisibleDayChange(key);
          }
        }
      },
      { rootMargin: "-120px 0px -75% 0px", threshold: 0 }
    );
    dividers.forEach((d) => ob.observe(d));
    return () => ob.disconnect();
  }, [rendered, onVisibleDayChange]);

  let lastDay = "";
  const hasMore = renderCount < ordered.length;

  const isThreadView = !!activeThreadKey;

  // A new thread starts collapsed, showing only its top mentions.
  useEffect(() => {
    setShowAllThreadEntities(false);
  }, [activeThreadKey]);

  // Thread view only: every entity mentioned in the thread's chats with
  // its thread-local chat count, for the subtitle pills below.
  const threadEntities = useMemo(
    () =>
      isThreadView
        ? topEntitiesForChatIds(
            ordered.map((it) => it.id),
            entityMap,
            Number.MAX_SAFE_INTEGER,
            minScore
          )
        : [],
    [isThreadView, ordered, entityMap, minScore]
  );

  // The all-entities panel floats over the list: any page scroll (or
  // Escape) dismisses it, while scrolling inside the panel itself does
  // not (overscroll-contain stops the chain; capture sees the target).
  useEffect(() => {
    if (!showAllThreadEntities) return;
    const onScroll = (e: Event) => {
      if (pillPanelRef.current?.contains(e.target as Node)) return;
      setShowAllThreadEntities(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAllThreadEntities(false);
    };
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("keydown", onKey);
    };
  }, [showAllThreadEntities]);

  // Tag-filtered list header: the tag name(s) replace the generic title,
  // with one match/exclude bullet per tag in the subtitle.
  const tagHeader = useMemo(() => describeTagFilter(activeTags), [activeTags]);
  // Details dropdown shows one merged Match/Exclude list across every
  // active tag (deduped, first-seen order).
  const tagDetailLabels = useMemo(() => {
    const targets: string[] = [];
    const contrasts: string[] = [];
    for (const e of tagHeader.entries) {
      for (const l of e.targetLabels) {
        if (!targets.includes(l)) targets.push(l);
      }
      for (const l of e.contrastLabels) {
        if (!contrasts.includes(l)) contrasts.push(l);
      }
    }
    return { targets, contrasts };
  }, [tagHeader]);
  // Stable identity for the filter set (the activeTags array itself is
  // rebuilt every render): keys the summary scope and the details panel.
  const tagFilterKey = useMemo(
    () =>
      activeTags
        .map((t) => t.id)
        .sort()
        .join("\n"),
    [activeTags]
  );
  // The tag-details dropdown floats over the list too: outside taps, page
  // scroll, and Escape dismiss it; scrolling inside it does not.
  useEffect(() => {
    if (!showTagDetails) return;
    const onDown = (e: MouseEvent) => {
      if (tagPanelRef.current?.contains(e.target as Node)) return;
      if (tagToggleRef.current?.contains(e.target as Node)) return;
      setShowTagDetails(false);
    };
    const onScroll = (e: Event) => {
      if (tagPanelRef.current?.contains(e.target as Node)) return;
      setShowTagDetails(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowTagDetails(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("keydown", onKey);
    };
  }, [showTagDetails]);

  // A changed filter set closes the details dropdown: stale bullets must
  // not linger over the new list.
  useEffect(() => {
    setShowTagDetails(false);
  }, [tagFilterKey]);

  // The subtitle pill row always stays one line: pills keep full width
  // and hide from the right one by one as the row narrows. A hidden
  // measurer sizes every pill, then the row shows the largest fitting
  // prefix plus the toggle. Layout effect so the count settles before
  // paint (no clip flash on thread open).
  useLayoutEffect(() => {
    if (!isThreadView) return;
    const row = pillRowRef.current;
    const meas = pillMeasureRef.current;
    if (!row || !meas) return;
    const measured = (el: Element | null, fallback: number): number =>
      el instanceof HTMLElement && el.offsetWidth > 0
        ? el.offsetWidth
        : fallback;
    const compute = () => {
      const avail = row.clientWidth;
      if (avail <= 0) return;
      const pillEls = Array.from(meas.querySelectorAll("[data-pill]"));
      const widths = pillEls.map((el) => measured(el, 0));
      const first = pillEls[0];
      const second = pillEls[1];
      const gap =
        first instanceof HTMLElement && second instanceof HTMLElement
          ? Math.max(
              0,
              second.offsetLeft - (first.offsetLeft + first.offsetWidth)
            ) || PILL_GAP_FALLBACK
          : PILL_GAP_FALLBACK;
      const total = threadEntities.length;
      const toggleFor = (hidden: number): number =>
        measured(
          meas.querySelector(
            hidden < 10
              ? "[data-toggle-1]"
              : hidden < 100
                ? "[data-toggle-2]"
                : "[data-toggle-3]"
          ),
          72
        );
      const cap = Math.min(total, MAX_VISIBLE_PILLS, widths.length);
      for (let n = cap; n >= 0; n--) {
        const hidden = total - n;
        let need = 0;
        for (let i = 0; i < n; i++) need += widths[i] ?? 0;
        if (n > 1) need += gap * (n - 1);
        if (hidden > 0) need += (n > 0 ? gap : 0) + toggleFor(hidden);
        if (need <= avail) {
          setPillFitCount(n);
          return;
        }
      }
      setPillFitCount(0);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(row);
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(() => compute()).catch(() => {});
    }
    return () => ro.disconnect();
  }, [isThreadView, threadEntities]);

  const threadSummary = useThreadSummary({
    threadKey: activeThreadKey ?? "",
    threadTitle: activeThreadTitle,
    uuid: uuid ?? "local",
    items: ordered,
    synthesisModel: synthesisModel ?? {
      provider: "meta",
      model: "",
    },
    maxTokensPerBatch: maxTokensPerBatch ?? DEFAULT_MAX_TOKENS_PER_BATCH,
    onOpenModelSettings: onOpenModelSettings ?? (() => {}),
  });

  // Archive copy of the thread summary: same button/panel UX over the
  // visible list, scoped under a synthetic source key no chat carries.
  const archiveSummaryApi = useThreadSummary({
    threadKey: "archive",
    threadTitle: "Archive",
    uuid: uuid ?? "local",
    items: ordered,
    synthesisModel: synthesisModel ?? {
      provider: "meta",
      model: "",
    },
    maxTokensPerBatch: maxTokensPerBatch ?? DEFAULT_MAX_TOKENS_PER_BATCH,
    onOpenModelSettings: onOpenModelSettings ?? (() => {}),
  });

  // Tag-filter copy of the thread summary: same button/panel UX over the
  // filtered list, scoped under the sorted filter set.
  const tagSummaryApi = useThreadSummary({
    threadKey: `tag:${tagFilterKey.replace(/\n/g, "+")}`,
    threadTitle: tagHeader.title || "Tag",
    uuid: uuid ?? "local",
    items: ordered,
    synthesisModel: synthesisModel ?? {
      provider: "meta",
      model: "",
    },
    maxTokensPerBatch: maxTokensPerBatch ?? DEFAULT_MAX_TOKENS_PER_BATCH,
    onOpenModelSettings: onOpenModelSettings ?? (() => {}),
  });

  return (
    <div>
      <div className="sticky top-12 md:top-0 z-10 bg-canvas/95 backdrop-blur px-1 py-2 -mt-2 flex flex-wrap items-center gap-3">
        {/* min-w-48 (not min-w-0): a zero-basis flex-1 never triggers a
            wrap, so the title squeezed instead of dropping controls below. */}
        <div className="min-w-48 flex-1">
          {isThreadView ? (
            <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight truncate">
              <MarkdownInline markdown={activeThreadTitle || "Thread"} />
            </h2>
          ) : (
            <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight truncate">
              {activeTags.length > 0 ? tagHeader.title : title}
            </h2>
          )}
          <div className="flex items-center gap-2 mt-1 min-w-0 relative overflow-hidden">
            <p className="text-[13px] text-mention shrink-0">
              {ordered.length} of {totalCount} chats
            </p>
            {!isThreadView && activeTags.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 min-w-0 text-[13px] text-mention overflow-hidden">
                  {tagHeader.entries.map((e, ei) => (
                    <React.Fragment key={e.tagId}>
                      {ei > 0 && (
                        <span aria-hidden className="text-mention/40 select-none shrink-0">·</span>
                      )}
                      {tagHeader.entries.length > 1 && (
                        <span className="font-medium text-ink whitespace-nowrap shrink-0">
                          {displayTagName(e.tagName)}
                        </span>
                      )}
                      {e.match !== null && (
                        <span className="inline-flex items-center gap-1 min-w-0 shrink-0">
                          <span className="font-medium text-ink">Match</span>
                          <span aria-hidden className="text-mention/60 select-none">•</span>
                          <span className="truncate max-w-40" title={e.match}>
                            {e.match}
                          </span>
                        </span>
                      )}
                      {e.match !== null && e.exclude !== null && (
                        <span aria-hidden className="text-mention/40 select-none shrink-0">·</span>
                      )}
                      {e.exclude !== null && (
                        <span className="inline-flex items-center gap-1 min-w-0 shrink-0">
                          <span className="font-medium">Exclude</span>
                          <span aria-hidden className="text-mention/60 select-none">•</span>
                          <span className="truncate max-w-40" title={e.exclude}>
                            {e.exclude}
                          </span>
                        </span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
                {/* Sibling of the clipping row above (not inside it): only
                    the bullets truncate on narrow screens, the expander
                    itself always stays visible. */}
                {tagHeader.hiddenCount > 0 && (
                  <button
                    ref={tagToggleRef}
                    type="button"
                    onClick={() => setShowTagDetails((v) => !v)}
                    aria-expanded={showTagDetails}
                    className="inline-flex items-center gap-0.5 rounded-full bg-tag px-2 py-0.5 text-[11px] text-mention hover:text-ink hover:bg-divider transition whitespace-nowrap shrink-0"
                  >
                    {showTagDetails
                      ? "Show less"
                      : `+${tagHeader.hiddenCount} more`}
                    <ChevronDown
                      className={`w-3 h-3 transition-transform ${showTagDetails ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
              </>
            )}
            {isThreadView && threadEntities.length > 0 && (
              <div
                ref={pillRowRef}
                className="flex flex-1 items-center gap-1.5 min-w-0 overflow-hidden"
              >
                {threadEntities.slice(0, pillFitCount).map((a) => (
                  <ThreadEntityPill
                    key={a.key}
                    display={a.display}
                    chatCount={a.chatCount}
                  />
                ))}
                {threadEntities.length > pillFitCount && (
                  <button
                    type="button"
                    onClick={() => setShowAllThreadEntities((v) => !v)}
                    aria-expanded={showAllThreadEntities}
                    className="inline-flex items-center rounded-full bg-tag px-2 py-0.5 text-[11px] text-mention hover:text-ink hover:bg-divider transition whitespace-nowrap shrink-0"
                  >
                    {showAllThreadEntities
                      ? "Show less"
                      : `+${threadEntities.length - pillFitCount} more`}
                  </button>
                )}
              </div>
            )}
            {isThreadView && threadEntities.length > 0 && (
              <div
                ref={pillMeasureRef}
                aria-hidden="true"
                className="absolute left-0 top-0 invisible flex w-max items-center gap-1.5 whitespace-nowrap pointer-events-none"
              >
                {threadEntities.slice(0, MAX_VISIBLE_PILLS).map((a) => (
                  <span
                    key={a.key}
                    data-pill="true"
                    className="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] whitespace-nowrap shrink-0"
                  >
                    <span className="max-w-48 truncate">{a.display}</span>
                    <span className="font-mono shrink-0">{a.chatCount}</span>
                  </span>
                ))}
                <span
                  data-toggle-1="true"
                  className="inline-flex items-center rounded-full bg-tag px-2 py-0.5 text-[11px] whitespace-nowrap shrink-0"
                >
                  +8 more
                </span>
                <span
                  data-toggle-2="true"
                  className="inline-flex items-center rounded-full bg-tag px-2 py-0.5 text-[11px] whitespace-nowrap shrink-0"
                >
                  +88 more
                </span>
                <span
                  data-toggle-3="true"
                  className="inline-flex items-center rounded-full bg-tag px-2 py-0.5 text-[11px] whitespace-nowrap shrink-0"
                >
                  +888 more
                </span>
              </div>
            )}
          </div>
        </div>
        {isThreadView && activeThreadKey ? (
          <div className="flex items-center gap-2 shrink-0">
            {synthesisModel && <ThreadSummaryButton api={threadSummary} />}
            {onShowAllThreads && (
              <button
                type="button"
                onClick={onShowAllThreads}
                title="Back to all threads"
                className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
              >
                <MessagesSquare className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">All threads</span>
              </button>
            )}
            <a
              href={activeThreadKey}
              target="_blank"
              rel="noreferrer"
              title="Resume source thread"
              className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
            >
              <span className="hidden sm:inline">Resume</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        ) : (
          <>
            {activeEntities.length > 0 && (
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto shrink-0">
                {activeEntities.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onToggleEntity(key)}
                    title="Remove this entity from the filter"
                    className="inline-flex items-center gap-1.5 rounded-full bg-mention px-3 py-1 text-xs font-medium text-white hover:bg-ink transition-colors shrink-0"
                  >
                    {key}
                    <X className="w-3 h-3 opacity-60" />
                  </button>
                ))}
              </div>
            )}
            {activeDateRange && onClearDateRange && (
              <div className="flex items-center gap-1.5 min-w-0 shrink-0">
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
          </>
        )}
        {/* Tag filters are sticky: they narrow the thread review too, so
            the pills stay visible (and removable) in the thread view, whose
            title belongs to the thread. In the list the tag name is the
            title instead, so no pills. Thresholds live in Settings now. */}
        {isThreadView && activeTags.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto shrink-0">
            {activeTags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onToggleTag(t.id)}
                title="Remove this tag from the filter"
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-action px-3 py-1 text-xs font-medium text-white hover:bg-action-hover transition-colors shrink-0"
              >
                {displayTagName(t.name)}
                <X className="w-3 h-3 opacity-60" />
              </button>
            ))}
          </div>
        )}
        {headerExtra}
        {archiveSummary && !isThreadView && synthesisModel && (
          // Right-aligned so the right-anchored template dropdown stays
          // on-screen when the button wraps to its own row.
          <div className="ml-auto shrink-0">
            <ThreadSummaryButton api={archiveSummaryApi} />
          </div>
        )}
        {!isThreadView && activeTags.length > 0 && synthesisModel && (
          // Same right-aligned placement as the archive summary button.
          <div className="ml-auto shrink-0">
            <ThreadSummaryButton api={tagSummaryApi} />
          </div>
        )}
        {isThreadView &&
          showAllThreadEntities &&
          threadEntities.length > 0 && (
            <div
              ref={pillPanelRef}
              className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl border border-divider bg-white shadow-lg p-3 max-h-64 overflow-y-auto overscroll-contain"
            >
              <div className="flex flex-wrap gap-1.5">
                {threadEntities.map((a) => (
                  <ThreadEntityPill
                    key={a.key}
                    display={a.display}
                    chatCount={a.chatCount}
                  />
                ))}
              </div>
            </div>
          )}
        {!isThreadView && showTagDetails && activeTags.length > 0 && (
          <div
            ref={tagPanelRef}
            className="absolute left-0 top-full z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-divider bg-white shadow-lg p-4 max-h-80 overflow-y-auto overscroll-contain space-y-4"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-ink">
                Tag details
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setShowTagDetails(false)}
                title="Close tag details"
                aria-label="Close tag details"
                className="rounded-md p-1 text-mention/60 hover:text-mention hover:bg-tag shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-mention/60">
                Match
              </div>
              <ul className="mt-1 space-y-1">
                {tagDetailLabels.targets.length > 0 ? (
                  tagDetailLabels.targets.map((label, i) => (
                    <li
                      key={`${i}-${label}`}
                      className="flex gap-1.5 text-xs leading-snug text-mention"
                    >
                      <span aria-hidden className="text-mention/60 select-none">•</span>
                      <span>{label}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-xs text-mention/60">—</li>
                )}
              </ul>
            </div>
            {tagDetailLabels.contrasts.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-mention/60">
                  Exclude
                </div>
                <ul className="mt-1 space-y-1">
                  {tagDetailLabels.contrasts.map((label, i) => (
                    <li
                      key={`${i}-${label}`}
                      className="flex gap-1.5 text-xs leading-snug text-mention"
                    >
                      <span aria-hidden className="text-mention/60 select-none">•</span>
                      <span>{label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {!isThreadView && activeTags.length === 0 && (
        <div className="px-1 sm:px-4 pt-3">
          <MentionSearchBar
            key={activeEntities.join("\n")}
            candidates={mentionCandidates}
            hasEntities={Object.keys(entityMap).length > 0}
            onViewChats={onSelectEntities}
            noun="chats"
            stagePicks
            requireSelection
            excludeKeys={activeEntities}
          />
        </div>
      )}

      {isThreadView && activeThreadKey && synthesisModel && (
        <div className="px-1 sm:px-4 pt-3">
          <ThreadSummaryPanel api={threadSummary} />
        </div>
      )}

      {!isThreadView && archiveSummary && synthesisModel && (
        <div className="px-1 sm:px-4 pt-3">
          <ThreadSummaryPanel api={archiveSummaryApi} />
        </div>
      )}

      {!isThreadView && activeTags.length > 0 && synthesisModel && (
        <div className="px-1 sm:px-4 pt-3">
          <ThreadSummaryPanel api={tagSummaryApi} />
        </div>
      )}

      <div className="px-1 sm:px-4 py-4">
        <div ref={listRef} className="w-full space-y-7">
          {rendered.map((item) => {
            const dayKey = localDayKey(item.timestamp);
            const showDivider = dayKey !== lastDay;
            lastDay = dayKey;
            const tkey = item.threadUrl || item.titleUrl || null;
            const tsize = tkey ? threadSizes.get(tkey) ?? 0 : 0;
            return (
              <React.Fragment key={item.id}>
                {showDivider && (
                  <div id={`day-${dayKey}`} data-day-divider={dayKey} className="scroll-mt-48 md:scroll-mt-16 flex items-center gap-3 pt-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-mention/60">
                      {formatDayLabel(dayKey)}
                    </div>
                    <div className="flex-1 h-px bg-tag/70" />
                  </div>
                )}
                  <ChatCard
                    item={item}
                    highlightTokens={EMPTY_TOKENS}
                    thread={!isThreadView && tkey && tsize > 1 ? { key: tkey, size: tsize } : undefined}
                    onOpenThread={onOpenThread}
                  />
              </React.Fragment>
            );
          })}
            {hasMore && <div ref={setSentinel} className="h-4" aria-hidden />}
            {!hasMore && ordered.length > PAGE_SIZE && (
              <div className="text-center text-[11px] text-mention/60 py-6">
                End of chats — all {ordered.length} chats shown
              </div>
            )}
          {ordered.length === 0 && (
            <div className="text-center text-sm text-mention/60 py-16">
              {totalCount === 0 ? (
                <>No chats loaded yet.</>
              ) : (
                <>No chats match the current filters.</>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
