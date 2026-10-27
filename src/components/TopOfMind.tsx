import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  Sparkles,
  Square,
  SquareCheck,
  X,
} from "lucide-react";
import {
  ModelEndpointConfig,
  ParsedActivityItem,
  PromptTemplate,
} from "../lib/types";
import {
  BUILTIN_TEMPLATES,
  loadCustomThreadTemplates,
} from "../lib/promptTemplates";
import { ChatEntityMap } from "../lib/entities";
import { summarizeThreads, ThreadSummary } from "../lib/threads";
import {
  SavedSummary,
  loadSavedSummaries,
  updateSavedSummaryMarkdown,
} from "../lib/savedSummaries";
import {
  ActionItem,
  actionItemsDueBetween,
  collectActionItems,
  collectCompletedActionItems,
  formatDeadlineChip,
  googleCalendarTemplateUrl,
  toggleActionItemInMarkdown,
} from "../lib/actionItems";
import { MarkdownView } from "./MarkdownView";
import MentionSearchBar from "./MentionSearchBar";
import { RangeSummaryBox } from "./RangeSummaryBox";
import {
  IMPORT_SOURCES,
  ImportSource,
  RangeBucket,
  RangeGranularity,
  ThreadRankMode,
  bucketDayKeys,
  buildRangeStats,
  countThreadsBySource,
  dataDayBounds,
  filterItemsByRange,
  formatDayRangeLabel,
  formatDuration,
  retitleThreads,
  threadDurationMs,
  topMentionsByThreads,
  topThreads,
  TOP_LIST_LIMIT,
} from "../lib/topOfMind";
import { SidebarView } from "./Sidebar";
import { Block, BlockHeader, BlockPad, EmptyState, GhostButton } from "./ui";

const SOURCE_BAR: Record<ImportSource, string> = {
  ChatGPT: "bg-ink",
  Gemini: "bg-mention",
  "AI Mode": "bg-divider",
  Obsidian: "bg-tag ring-1 ring-inset ring-divider",
  Other: "bg-white ring-1 ring-inset ring-divider",
};

type RangePreset = "14d" | "30d" | "90d" | "all" | "custom";

const STORE_KEYS = {
  preset: "extbrain:topmind:preset",
  customStart: "extbrain:topmind:customStart",
  customEnd: "extbrain:topmind:customEnd",
  activityMode: "extbrain:topmind:activityMode",
  threadRankMode: "extbrain:topmind:threadRankMode",
  summaryTemplate: "extbrain:topmind:summaryTemplate",
} as const;

function loadStored(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** useState mirrored to localStorage so toggle choices survive reloads. */
function usePersistentState<T extends string>(
  key: string,
  initial: T,
  allowed?: readonly T[]
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = loadStored(key, initial);
    return allowed && !allowed.includes(stored as T) ? initial : (stored as T);
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — state just stays ephemeral */
    }
  }, [key, value]);
  return [value, setValue];
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-full bg-tag p-0.5 shrink-0"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition ${
            value === o.value
              ? "bg-action text-white"
              : "text-mention hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function bucketAxisLabel(
  b: RangeBucket,
  granularity: RangeGranularity,
  multiYear: boolean
): string {
  if (granularity === "year") return String(b.start.getFullYear());
  const base = `${b.start.getMonth() + 1}/${b.start.getDate()}`;
  return multiYear
    ? `${base}/${String(b.start.getFullYear()).slice(2)}`
    : base;
}

function bucketTitle(
  b: RangeBucket,
  granularity: RangeGranularity,
  total: number,
  noun: string,
  parts: string[]
): string {
  const span =
    granularity === "day"
      ? dayLabel(b.start)
      : `${dayLabel(b.start)} – ${dayLabel(b.end)}`;
  return `${span}: ${total} ${noun}${
    parts.length > 0 ? ` (${parts.join(", ")})` : ""
  }`;
}

function ActivityChart({
  buckets,
  granularity,
  items,
  uuid,
  onOpenThread,
  onNavigate,
  onReadArchives,
  onViewRangeThreads,
  synthesisModel,
  maxTokensPerBatch,
  onOpenModelSettings,
}: {
  buckets: RangeBucket[];
  granularity: RangeGranularity;
  items: ParsedActivityItem[];
  uuid: string;
  onOpenThread: (key: string) => void;
  onNavigate: (v: SidebarView) => void;
  onReadArchives: (startKey: string, endKey: string) => void;
  onViewRangeThreads: (startKey: string, endKey: string) => void;
  synthesisModel: ModelEndpointConfig;
  maxTokensPerBatch: number;
  onOpenModelSettings: () => void;
}) {
  const [mode, setMode] = usePersistentState<"chats" | "threads">(
    STORE_KEYS.activityMode,
    "chats",
    ["chats", "threads"]
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [retroOpen, setRetroOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [genNonce, setGenNonce] = useState(0);
  const [sumsNonce, setSumsNonce] = useState(0);
  const [panelMode, setPanelMode] = useState<"read" | "generate">("generate");
  const [panelStatus, setPanelStatus] = useState<
    "idle" | "generating" | "done" | "error"
  >("idle");
  const [panelProgress, setPanelProgress] = useState<string | null>(null);
  const panelControls = useRef<{
    stop: () => void;
    regenerate: () => void;
  } | null>(null);
  const [templateId, setTemplateId] = usePersistentState<string>(
    STORE_KEYS.summaryTemplate,
    "retrospective"
  );
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(() =>
    loadCustomThreadTemplates()
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...customTemplates],
    [customTemplates]
  );
  const selectedTemplate = useMemo(
    () =>
      allTemplates.find((t) => t.id === templateId) ??
      allTemplates.find((t) => t.id === "retrospective") ??
      allTemplates[0],
    [allTemplates, templateId]
  );

  // Close the template menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // Escape closes the summary panel (and menu) without leaving the page.
  useEffect(() => {
    if (!retroOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRetroOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [retroOpen, menuOpen]);
  const { maxTotal, grandTotal } = useMemo(() => {
    let max = 0;
    let grand = 0;
    for (const b of buckets) {
      const total = mode === "chats" ? b.totalChats : b.totalThreads;
      max = Math.max(max, total);
      grand += total;
    }
    return { maxTotal: max, grandTotal: grand };
  }, [buckets, mode]);

  /**
   * Legend totals. Chats sum across buckets (each chat sits in exactly
   * one), but threads are distinct per source over the whole range: a
   * thread active in two buckets must not count twice, and the legend
   * must reconcile with the range subtitle.
   */
  const legendTotals = useMemo(() => {
    const totals = new Map<ImportSource, number>();
    if (mode === "chats") {
      for (const b of buckets) {
        for (const s of IMPORT_SOURCES) {
          totals.set(s, (totals.get(s) ?? 0) + b.chatsBySource[s]);
        }
      }
    } else {
      const bySource = countThreadsBySource(summarizeThreads(items));
      for (const s of IMPORT_SOURCES) totals.set(s, bySource[s]);
    }
    return totals;
  }, [buckets, mode, items]);

  const noun = mode === "chats" ? "chats" : "threads";
  const multiYear =
    buckets.length > 0 &&
    buckets[0].start.getFullYear() !==
      buckets[buckets.length - 1].end.getFullYear();
  // Label every Nth bucket so long ranges stay legible (last always labeled).
  const stride = Math.max(1, Math.ceil(buckets.length / 14));
  const gap = buckets.length > 14 ? "gap-px" : "gap-1 sm:gap-2";

  const selected = useMemo(
    () => buckets.find((b) => b.key === selectedKey) ?? null,
    [buckets, selectedKey]
  );
  const selKeys = useMemo(
    () => (selected ? bucketDayKeys(selected) : null),
    [selected]
  );
  const rangeItems = useMemo(
    () =>
      selKeys
        ? filterItemsByRange(items, selKeys.startKey, selKeys.endKey)
        : [],
    [items, selKeys]
  );
  // Saved summaries, reloaded after each generation so bars and the
  // Read/Generate button reflect what exists (bumped via sumsNonce).
  const summaries = useMemo(
    () => loadSavedSummaries(uuid),
    [uuid, selectedKey, sumsNonce]
  );
  const openActionItems = useMemo(
    () => collectActionItems(summaries, new Date(), Infinity),
    [summaries]
  );
  /** Day-key ranges with at least one saved range summary, any template. */
  const summarizedRanges = useMemo(() => {
    const set = new Set<string>();
    for (const s of summaries) {
      if (s.range) set.add(`${s.range.start}|${s.range.end}`);
    }
    return set;
  }, [summaries]);
  const dueItems = useMemo(
    () =>
      selKeys
        ? actionItemsDueBetween(
            openActionItems,
            selKeys.startKey,
            selKeys.endKey
          )
        : [],
    [openActionItems, selKeys]
  );
  const dueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of buckets) {
      const { startKey, endKey } = bucketDayKeys(b);
      let n = 0;
      for (const a of openActionItems) {
        if (
          a.deadline !== null &&
          a.deadline >= startKey &&
          a.deadline <= endKey
        ) {
          n++;
        }
      }
      if (n > 0) counts.set(b.key, n);
    }
    return counts;
  }, [openActionItems, buckets]);
  const retroThreads = useMemo(
    () =>
      summarizeThreads(rangeItems).map((t) => ({
        key: t.key,
        title: t.title,
        count: t.count,
      })),
    [rangeItems]
  );
  // Footer count: chats sum, but threads are distinct within the bucket —
  // the same thread list the summary drawer shows.
  const selTotal =
    !selected
      ? 0
      : mode === "chats"
        ? selected.totalChats
        : retroThreads.length;
  /** Latest saved summary for the selected range + template, if any. */
  const existingForSelection = useMemo(
    () =>
      selKeys
        ? summaries.find(
            (s) =>
              s.range &&
              s.templateId === selectedTemplate.id &&
              s.range.start === selKeys.startKey &&
              s.range.end === selKeys.endKey
          ) ?? null
        : null,
    [summaries, selKeys, selectedTemplate.id]
  );

  const selectBucket = (key: string) => {
    setSelectedKey((prev) => (prev === key ? null : key));
    setRetroOpen(false);
    setMenuOpen(false);
  };

  const pickTemplate = (tpl: PromptTemplate) => {
    setTemplateId(tpl.id);
    setMenuOpen(false);
    // The picker always generates, even when a summary already exists.
    setPanelMode("generate");
    // Bump so the panel remounts into generate mode even for the same key.
    setGenNonce((n) => n + 1);
    setRetroOpen(true);
  };

  return (
    <Block>
      <BlockPad>
        <BlockHeader
          title="Activity"
          right={
            <Segmented
              label="Activity metric"
              value={mode}
              onChange={setMode}
              options={[
                { value: "chats", label: "Chats" },
                { value: "threads", label: "Threads" },
              ]}
            />
          }
        />
        {grandTotal === 0 ? (
          <p className="text-[13px] text-mention/60 py-6 text-center">
            No {noun} in this range.
          </p>
        ) : (
          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
              {IMPORT_SOURCES.filter((s) => (legendTotals.get(s) ?? 0) > 0).map(
                (s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1.5 text-[11px] text-mention"
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-[4px] ${SOURCE_BAR[s]}`}
                    />
                    {s}
                    <span className="font-mono text-mention/60">
                      {legendTotals.get(s)}
                    </span>
                  </span>
                )
              )}
            </div>
            <div className="mt-7">
              <div className="relative">
                <div className="absolute inset-x-0 top-0 border-t border-divider/40" />
                <div className="absolute right-0 -top-5 text-[10px] font-mono text-mention/60">
                  {maxTotal}
                </div>
                <div className={`flex items-end h-36 pt-3 ${gap}`}>
                  {buckets.map((b) => {
                    const by =
                      mode === "chats" ? b.chatsBySource : b.threadsBySource;
                    const total =
                      mode === "chats" ? b.totalChats : b.totalThreads;
                    const parts = IMPORT_SOURCES.filter(
                      (s) => by[s] > 0
                    ).map((s) => `${s} ${by[s]}`);
                    const isSel = selected?.key === b.key;
                    const dueCount = dueCounts.get(b.key) ?? 0;
                    const { startKey, endKey } = bucketDayKeys(b);
                    const hasSummary = summarizedRanges.has(
                      `${startKey}|${endKey}`
                    );
                    const stackPct = Math.min(
                      IMPORT_SOURCES.filter((s) => by[s] > 0).reduce(
                        (acc, s) =>
                          acc + Math.max((by[s] / maxTotal) * 100, 4),
                        0
                      ),
                      100
                    );
                    const tip = bucketTitle(b, granularity, total, noun, parts);
                    const fullTip = [
                      tip,
                      dueCount > 0
                        ? `${dueCount} action item${
                            dueCount === 1 ? "" : "s"
                          } due`
                        : null,
                      hasSummary ? "has a saved summary" : null,
                    ]
                      .filter(Boolean)
                      .join(" — ");
                    return (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => selectBucket(b.key)}
                        title={fullTip}
                        aria-pressed={isSel}
                        className={`relative flex-1 min-w-0 h-full flex flex-col justify-end cursor-pointer rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-action/40 transition ${
                          selected && !isSel ? "opacity-35" : ""
                        }`}
                      >
                        {dueCount > 0 && (
                          <span
                            aria-hidden
                            style={{ bottom: `calc(${stackPct}% + 4px)` }}
                            className="absolute left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-ink"
                          />
                        )}
                        {total === 0 ? (
                          <div className="w-full max-w-7 mx-auto h-px bg-divider/50" />
                        ) : (
                          <div className="w-full max-w-7 mx-auto h-full flex flex-col justify-end">
                            {[...IMPORT_SOURCES]
                              .reverse()
                              .filter((s) => by[s] > 0)
                              .map((s, si) => (
                                <div
                                  key={s}
                                  style={{
                                    height: `${Math.max(
                                      (by[s] / maxTotal) * 100,
                                      4
                                    )}%`,
                                  }}
                                  className={`w-full shrink-0 ${
                                    isSel ? "bg-action" : SOURCE_BAR[s]
                                  } ${
                                    si === 0 ? "rounded-t-[3px]" : ""
                                  }`}
                                />
                              ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="border-t border-divider/70 mt-3" />
              <div className={`flex mt-3 ${gap}`} aria-hidden>
                  {buckets.map((b, i) => {
                    const isLast = i === buckets.length - 1;
                    const showLabel = i % stride === 0 || isLast;
                    return (
                      <div
                        key={b.key}
                        className={`flex-1 min-w-0 text-center text-[9px] sm:text-[10px] tabular-nums whitespace-nowrap ${
                          !showLabel || (i % 2 === 1 && !isLast)
                            ? "invisible"
                            : ""
                        } ${
                          isLast ? "font-semibold text-ink" : "text-mention/60"
                        }`}
                      >
                        {bucketAxisLabel(b, granularity, multiYear)}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {selected && selKeys && (
              <div className="mt-4 border-t border-divider/70 pt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="shrink-0 whitespace-nowrap text-sm font-semibold text-ink">
                    {formatDayRangeLabel(selKeys.startKey, selKeys.endKey)}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      mode === "chats"
                        ? onReadArchives(selKeys.startKey, selKeys.endKey)
                        : onViewRangeThreads(selKeys.startKey, selKeys.endKey)
                    }
                    title={
                      mode === "chats"
                        ? "View these chats in Chat Histories"
                        : "View these threads in Threads"
                    }
                    className="shrink-0 whitespace-nowrap rounded-full bg-tag px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-divider transition"
                  >
                    {selTotal} {noun}
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate("actions")}
                    title="View all action items"
                    className="shrink-0 whitespace-nowrap rounded-full bg-tag px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-divider transition"
                  >
                    {dueItems.length}{" "}
                    {dueItems.length === 1 ? "action item" : "action items"}
                  </button>
                  <div className="flex-1" />
                  <div
                    ref={wrapRef}
                    className="relative flex shrink-0 items-stretch"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        if (retroOpen) {
                          setRetroOpen(false);
                        } else {
                          // Read opens the saved summary; Generate starts a
                          // fresh request so it never reuses stale state.
                          setPanelMode(
                            existingForSelection ? "read" : "generate"
                          );
                          setGenNonce((n) => n + 1);
                          setRetroOpen(true);
                        }
                      }}
                      title={
                        existingForSelection && !retroOpen
                          ? `Read the saved ${selectedTemplate.name} for this range`
                          : `Generate a ${selectedTemplate.name} for this range`
                      }
                      className="inline-flex items-center gap-1.5 rounded-l-lg bg-action pl-3 pr-2 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
                    >
                      <Sparkles className="w-3.5 h-3.5" />{" "}
                      {retroOpen
                        ? `Hide ${selectedTemplate.name}`
                        : existingForSelection
                          ? `Read ${selectedTemplate.name}`
                          : `Generate ${selectedTemplate.name}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomTemplates(loadCustomThreadTemplates());
                        setMenuOpen((v) => !v);
                      }}
                      title="Pick a summary template"
                      aria-label="Pick a summary template"
                      aria-expanded={menuOpen}
                      className="inline-flex items-center justify-center rounded-r-lg border-l border-white/20 bg-action px-1.5 text-white hover:bg-action-hover transition shrink-0"
                    >
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {menuOpen && (
                      <div className="absolute left-0 top-full mt-2 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-divider bg-canvas shadow-lg overflow-hidden">
                        <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
                          {allTemplates.map((tpl) => {
                            const active = tpl.id === selectedTemplate.id;
                            return (
                              <button
                                key={tpl.id}
                                type="button"
                                onClick={() => pickTemplate(tpl)}
                                className={`w-full text-left rounded-lg px-3 py-2 transition ${
                                  active ? "bg-tag" : "hover:bg-tag/60"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-[13px] font-medium text-ink truncate">
                                    {tpl.name}
                                  </span>
                                  <span className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention shrink-0">
                                    {tpl.badge}
                                  </span>
                                  {active && (
                                    <Check className="w-3.5 h-3.5 text-mention ml-auto shrink-0" />
                                  )}
                                </div>
                                <p className="text-[11px] text-mention mt-0.5 line-clamp-2">
                                  {tpl.description}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {retroOpen && (
                  <aside
                    aria-label={`${selectedTemplate.name} panel`}
                    className="fixed top-0 right-0 bottom-0 z-40 w-full sm:w-[480px] lg:w-[560px] bg-canvas border-l border-divider shadow-2xl flex flex-col min-h-0"
                  >
                    <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-divider/70 shrink-0 flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-mention/60">
                          {selectedTemplate.name}
                        </div>
                        <div className="text-[15px] font-semibold tracking-tight text-ink truncate">
                          {formatDayRangeLabel(selKeys.startKey, selKeys.endKey)}
                        </div>
                        {panelStatus === "generating" && (
                          <div className="text-[12px] text-mention truncate mt-0.5">
                            {panelProgress ?? "Contacting model…"}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {panelStatus === "generating" ? (
                          <button
                            type="button"
                            onClick={() => panelControls.current?.stop()}
                            title="Stop generating"
                            aria-label="Stop generating"
                            className="p-1.5 rounded-lg hover:bg-tag text-mention hover:text-ink transition"
                          >
                            <Square className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setPanelMode("generate");
                              setGenNonce((n) => n + 1);
                            }}
                            title="Regenerate"
                            aria-label="Regenerate"
                            className="p-1.5 rounded-lg hover:bg-tag text-mention hover:text-ink transition"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onNavigate("summary")}
                          title="See all summaries"
                          aria-label="See all summaries"
                          className="p-1.5 rounded-lg hover:bg-tag text-mention hover:text-ink transition"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRetroOpen(false)}
                          title="Close panel"
                          aria-label="Close panel"
                          className="p-1.5 rounded-lg hover:bg-tag text-mention hover:text-ink transition"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4">
                      <RangeSummaryBox
                        key={`${selected.key}:${selectedTemplate.id}:${genNonce}`}
                        uuid={uuid}
                        template={selectedTemplate}
                        title={`${selectedTemplate.name}: ${formatDayRangeLabel(
                          selKeys.startKey,
                          selKeys.endKey
                        )}`}
                        items={rangeItems}
                        threads={retroThreads}
                        synthesisModel={synthesisModel}
                        maxTokensPerBatch={maxTokensPerBatch}
                        onOpenModelSettings={onOpenModelSettings}
                        onDone={() => setSumsNonce((n) => n + 1)}
                        variant="panel"
                        range={selKeys}
                        existing={existingForSelection}
                        initialMode={panelMode}
                        chrome={false}
                        controlsRef={panelControls}
                        onStatusChange={setPanelStatus}
                        onProgressChange={setPanelProgress}
                      />
                    </div>
                  </aside>
                )}
              </div>
            )}
          </div>
        )}
      </BlockPad>
    </Block>
  );
}

function TopThreadsSection({
  threads,
  onOpenThread,
}: {
  threads: ThreadSummary[];
  onOpenThread: (key: string) => void;
}) {
  const [mode, setMode] = usePersistentState<ThreadRankMode>(
    STORE_KEYS.threadRankMode,
    "duration",
    ["duration", "chats"]
  );
  const top = useMemo(() => topThreads(threads, mode), [threads, mode]);
  return (
    <Block className="h-full">
      <BlockPad className="h-full flex flex-col">
        <BlockHeader
          title="Top Threads"
          right={
            <Segmented
              label="Thread ranking"
              value={mode}
              onChange={setMode}
              options={[
                { value: "duration", label: "Duration" },
                { value: "chats", label: "Chats" },
              ]}
            />
          }
        />
        {top.length === 0 ? (
          <p className="text-[13px] text-mention/60 py-4">
            No linked threads in this range.
          </p>
        ) : (
          <div className="mt-2 -mx-2 flex-1">
            {top.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onOpenThread(t.key)}
                title={t.title}
                className="w-full flex items-baseline gap-2 px-2 py-2 rounded-lg hover:bg-tag text-left transition group"
              >
                <span className="flex-1 min-w-0 break-words text-[13px] font-medium text-ink leading-snug line-clamp-3">
                  {t.title}
                </span>
                <span className="shrink-0 text-[11px] font-mono text-mention">
                  {mode === "duration"
                    ? formatDuration(threadDurationMs(t))
                    : `${t.count} ${t.count === 1 ? "chat" : "chats"}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </BlockPad>
    </Block>
  );
}

function localTodayKey(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate()
  ).padStart(2, "0")}`;
}

/** Flatten markdown links for tooltips so raw URLs never show. */
function plainActionTitle(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function ActionItemsSection({
  uuid,
  onOpenThread,
  onNavigate,
}: {
  uuid: string;
  onOpenThread: (key: string) => void;
  onNavigate: (v: SidebarView) => void;
}) {
  const [summaries, setSummaries] = useState<SavedSummary[]>(() =>
    loadSavedSummaries(uuid)
  );
  useEffect(() => {
    setSummaries(loadSavedSummaries(uuid));
  }, [uuid]);
  const openItems = useMemo(
    () => collectActionItems(summaries),
    [summaries]
  );
  const doneItems = useMemo(
    () => collectCompletedActionItems(summaries),
    [summaries]
  );
  const [showDone, setShowDone] = useState(false);
  const today = localTodayKey();

  const toggle = (item: ActionItem, done: boolean) => {
    const target = summaries.find((s) => s.id === item.summaryId);
    if (!target) return;
    const markdown = toggleActionItemInMarkdown(target.markdown, item, done);
    if (markdown === target.markdown) return;
    setSummaries(updateSavedSummaryMarkdown(uuid, target.id, markdown));
  };

  const renderRow = (a: ActionItem, done: boolean) => {
    const overdue = !done && a.deadline !== null && a.deadline < today;
    const plain = plainActionTitle(a.text);
    const chip = a.deadline
      ? formatDeadlineChip(a.deadline)
      : a.deadlineText;
    const BoxIcon = done ? SquareCheck : Square;
    return (
      <div
        key={a.id}
        onClick={(e) => {
          // Let embedded links (chips) open normally.
          if ((e.target as HTMLElement).closest("a")) return;
          if (a.threadKey) onOpenThread(a.threadKey);
          else onNavigate("summary");
        }}
        title={`${plain}${
          chip ? ` (${chip})` : ""
        } — from ${a.summaryTitle}`}
        className="w-full flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-tag text-left transition cursor-pointer"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle(a, !done);
          }}
          title={done ? "Mark open" : "Mark done"}
          className="shrink-0 mt-0.5 text-mention/60 hover:text-ink transition"
        >
          <BoxIcon className="w-3.5 h-3.5" />
        </button>
        <div className="flex-1 min-w-0">
          <MarkdownView
            markdown={a.text}
            className={`text-[13px] font-medium text-ink leading-snug line-clamp-2 ${
              done ? "line-through opacity-60" : ""
            }`}
          />
          <div className="truncate text-[11px] text-mention/60 mt-0.5">
            {a.summaryTitle}
          </div>
        </div>
        {chip && (
          <span
            title={chip}
            className={`shrink-0 text-[11px] font-mono mt-0.5 max-w-36 truncate ${
              overdue
                ? "font-semibold text-ink"
                : "text-mention"
            }`}
          >
            {overdue ? "Overdue " : ""}
            {chip}
          </span>
        )}
        {!done && (
          <a
            href={googleCalendarTemplateUrl({
              text: plain,
              deadline: a.deadline,
              deadlineText: a.deadlineText,
              summaryTitle: a.summaryTitle,
            })}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Add to Google Calendar"
            className="shrink-0 mt-1 text-mention/40 hover:text-ink transition"
          >
            <CalendarPlus className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    );
  };

  return (
    <Block className="h-full">
      <BlockPad className="h-full flex flex-col">
        <BlockHeader
          title="Action Items"
          right={
            <button
              type="button"
              onClick={() => onNavigate("actions")}
              title="View all action items"
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition"
            >
              View all <ArrowRight className="w-3.5 h-3.5" />
            </button>
          }
        />
        {openItems.length === 0 && doneItems.length === 0 ? (
          <div className="py-4 space-y-1">
            <p className="text-[13px] text-mention/60">
              No action items in saved summaries.
            </p>
            <p className="text-xs text-mention/60">
              Checklists and Next Actions sections feed this list — the Action
              Items template formats them best.
            </p>
          </div>
        ) : (
          <div className="mt-2 -mx-2 flex-1">
            {openItems.length === 0 ? (
              <p className="text-[13px] text-mention/60 px-2 py-2">
                All caught up.
              </p>
            ) : (
              openItems.map((a) => renderRow(a, false))
            )}
            {doneItems.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="flex items-center gap-1 px-2 py-2 text-xs text-mention/60 hover:text-ink transition"
              >
                {showDone ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                Completed ({doneItems.length})
              </button>
            )}
            {showDone && doneItems.map((a) => renderRow(a, true))}
          </div>
        )}
      </BlockPad>
    </Block>
  );
}

function MentionSection({
  title,
  nerType,
  entityMap,
  items,
  hasEntities,
  onViewChats,
  onNavigate,
  minScore = 0,
}: {
  title: string;
  nerType: string;
  entityMap: ChatEntityMap;
  items: ParsedActivityItem[];
  hasEntities: boolean;
  onViewChats: (keys: string[]) => void;
  onNavigate: (v: SidebarView) => void;
  minScore?: number;
}) {
  const highlights = useMemo(
    () => topMentionsByThreads(entityMap, items, nerType, TOP_LIST_LIMIT, minScore),
    [entityMap, items, nerType, minScore]
  );
  return (
    <Block className="h-full">
      <BlockPad className="h-full flex flex-col">
        <BlockHeader title={title} />
        {!hasEntities ? (
          <div className="py-4 space-y-2">
            <p className="text-[13px] text-mention/60">
              Process chats to see mentions.
            </p>
            <GhostButton onClick={() => onNavigate("load")}>
              Process chats <ArrowRight className="w-3.5 h-3.5" />
            </GhostButton>
          </div>
        ) : highlights.length === 0 ? (
          <p className="text-[13px] text-mention/60 py-4">
            None mentioned in this range.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5 flex-1 content-start">
            {highlights.map((h) => (
              <button
                key={h.key}
                type="button"
                onClick={() => onViewChats([h.key])}
                title={`${h.display} — view chats`}
                className="inline-flex items-center gap-1.5 rounded-full bg-mention px-3 py-1 text-[13px] font-medium text-white hover:bg-ink transition max-w-full"
              >
                <span className="truncate min-w-0">{h.display}</span>
                <span className="font-mono text-white/70 shrink-0">
                  {h.threadCount}
                </span>
              </button>
            ))}
          </div>
        )}
      </BlockPad>
    </Block>
  );
}

export const TopOfMind: React.FC<{
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  uuid: string;
  onOpenThread: (key: string) => void;
  onViewChats: (keys: string[]) => void;
  onNavigate: (v: SidebarView) => void;
  onReadArchives: (startKey: string, endKey: string) => void;
  onViewRangeThreads: (startKey: string, endKey: string) => void;
  synthesisModel: ModelEndpointConfig;
  maxTokensPerBatch: number;
  onOpenModelSettings: () => void;
  minScore?: number;
}> = ({
  items,
  entityMap,
  uuid,
  onOpenThread,
  onViewChats,
  onNavigate,
  onReadArchives,
  onViewRangeThreads,
  synthesisModel,
  maxTokensPerBatch,
  onOpenModelSettings,
  minScore = 0,
}) => {
  const [preset, setPreset] = usePersistentState<RangePreset>(
    STORE_KEYS.preset,
    "14d",
    ["14d", "30d", "90d", "all", "custom"]
  );
  const [customStart, setCustomStart] = usePersistentState<string>(
    STORE_KEYS.customStart,
    ""
  );
  const [customEnd, setCustomEnd] = usePersistentState<string>(
    STORE_KEYS.customEnd,
    ""
  );

  const bounds = useMemo(() => dataDayBounds(items), [items]);
  const range = useMemo(() => {
    if (!bounds) return null;
    if (preset === "all") return { lo: bounds.minKey, hi: bounds.maxKey };
    if (preset === "custom") {
      const s = customStart || addDaysToKey(bounds.maxKey, -13);
      const e = customEnd || bounds.maxKey;
      const lo = s <= e ? s : e;
      const hi = s <= e ? e : s;
      const clamp = (k: string) =>
        k < bounds.minKey ? bounds.minKey : k > bounds.maxKey ? bounds.maxKey : k;
      return { lo: clamp(lo), hi: clamp(hi) };
    }
    const n = preset === "14d" ? 14 : preset === "30d" ? 30 : 90;
    return { lo: addDaysToKey(bounds.maxKey, -(n - 1)), hi: bounds.maxKey };
  }, [bounds, preset, customStart, customEnd]);

  const rangedItems = useMemo(
    () => (range ? filterItemsByRange(items, range.lo, range.hi) : []),
    [items, range]
  );
  const chart = useMemo(
    () =>
      range
        ? buildRangeStats(items, range.lo, range.hi)
        : { buckets: [], granularity: "day" as const },
    [items, range]
  );
  const threads = useMemo(() => summarizeThreads(rangedItems), [rangedItems]);
  // Rankings reflect the range, but titles always come from the whole thread.
  const allThreads = useMemo(() => summarizeThreads(items), [items]);
  const titledThreads = useMemo(
    () => retitleThreads(threads, allThreads),
    [threads, allThreads]
  );
  const totalThreads = allThreads.length;
  const hasEntities = Object.keys(entityMap).length > 0;

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
          Top of Mind
        </h2>
        <EmptyState
          title="Nothing here yet"
          sub="Load your chat exports and this page will surface your recent activity, top threads, and most-mentioned people, places, and organizations."
          action={
            <GhostButton onClick={() => onNavigate("load")}>
              Load chats <ArrowRight className="w-3.5 h-3.5" />
            </GhostButton>
          }
        />
      </div>
    );
  }

  if (!bounds || !range) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
          Top of Mind
        </h2>
        <EmptyState
          title="No dated chats"
          sub="Your chats have no usable timestamps, so there is nothing to place on the timeline."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
            Top of Mind
          </h2>
          <p className="text-[13px] text-mention mt-1">
            {formatDayRangeLabel(range.lo, range.hi)} ·{" "}
            <button
              type="button"
              onClick={() => onViewRangeThreads(range.lo, range.hi)}
              title="View these threads in Threads"
              className="hover:text-ink hover:underline underline-offset-2 transition"
            >
              {threads.length.toLocaleString()} of {totalThreads.toLocaleString()}{" "}
              {totalThreads === 1 ? "thread" : "threads"}
              {totalThreads > 0
                ? ` (${Math.round((threads.length / totalThreads) * 100)}%)`
                : ""}
            </button>{" "}
            ·{" "}
            <button
              type="button"
              onClick={() => onReadArchives(range.lo, range.hi)}
              title="View these chats in Chat Histories"
              className="hover:text-ink hover:underline underline-offset-2 transition"
            >
              {rangedItems.length.toLocaleString()} of {items.length.toLocaleString()}{" "}
              {items.length === 1 ? "chat" : "chats"}
              {items.length > 0
                ? ` (${Math.round((rangedItems.length / items.length) * 100)}%)`
                : ""}
            </button>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Segmented
            label="Date range"
            value={preset}
            onChange={setPreset}
            options={[
              { value: "14d", label: "14D" },
              { value: "30d", label: "30D" },
              { value: "90d", label: "90D" },
              { value: "all", label: "All" },
              { value: "custom", label: "Custom" },
            ]}
          />
          {preset === "custom" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-mention">
              <input
                type="date"
                aria-label="Range start"
                value={customStart || addDaysToKey(bounds.maxKey, -13)}
                min={bounds.minKey}
                max={bounds.maxKey}
                onChange={(e) => setCustomStart(e.target.value)}
                className="rounded-lg border border-divider bg-white px-2 py-1 text-xs text-ink"
              />
              <span aria-hidden>→</span>
              <input
                type="date"
                aria-label="Range end"
                value={customEnd || bounds.maxKey}
                min={bounds.minKey}
                max={bounds.maxKey}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="rounded-lg border border-divider bg-white px-2 py-1 text-xs text-ink"
              />
            </span>
          )}
        </div>
      </div>

      <ActivityChart
        buckets={chart.buckets}
        granularity={chart.granularity}
        items={rangedItems}
        uuid={uuid}
        onOpenThread={onOpenThread}
        onNavigate={onNavigate}
        onReadArchives={onReadArchives}
        onViewRangeThreads={onViewRangeThreads}
        synthesisModel={synthesisModel}
        maxTokensPerBatch={maxTokensPerBatch}
        onOpenModelSettings={onOpenModelSettings}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TopThreadsSection threads={titledThreads} onOpenThread={onOpenThread} />
        <ActionItemsSection
          uuid={uuid}
          onOpenThread={onOpenThread}
          onNavigate={onNavigate}
        />
      </div>

      <MentionSearchBar
        entityMap={entityMap}
        hasEntities={hasEntities}
        onViewChats={onViewChats}
        minScore={minScore}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MentionSection
          title="@ People"
          nerType="PER"
          entityMap={entityMap}
          items={rangedItems}
          hasEntities={hasEntities}
          onViewChats={onViewChats}
          onNavigate={onNavigate}
          minScore={minScore}
        />
        <MentionSection
          title="@ Places"
          nerType="LOC"
          entityMap={entityMap}
          items={rangedItems}
          hasEntities={hasEntities}
          onViewChats={onViewChats}
          onNavigate={onNavigate}
          minScore={minScore}
        />
        <MentionSection
          title="@ Organizations"
          nerType="ORG"
          entityMap={entityMap}
          items={rangedItems}
          hasEntities={hasEntities}
          onViewChats={onViewChats}
          onNavigate={onNavigate}
          minScore={minScore}
        />
      </div>
    </div>
  );
};
