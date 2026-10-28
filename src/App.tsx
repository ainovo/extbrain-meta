import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MAX_TOKENS_PER_BATCH,
  DEFAULT_CONTRIBUTOR_MODEL,
  DualModelConfig,
  ParsedActivityItem,
} from "./lib/types";
import { normalizeModelConfig } from "./lib/exportData";
import { buildSearchIndex, fuzzyFilterIndexed } from "./lib/fuzzySearch";
import { getOrCreateUuid, saveHistories, loadHistories } from "./lib/storage";
import { Sidebar, SidebarHamburger, SidebarView } from "./components/Sidebar";
import { FileUploader } from "./components/FileUploader";
import { HistoriesView } from "./components/HistoriesView";
import { ThreadsView } from "./components/ThreadsView";
import { EntityProcessSection } from "./components/EntityProcessSection";
import { Tagging } from "./components/Tagging";
import {
  ChatEntityMap,
  loadChatEntities,
  saveChatEntities,
} from "./lib/entities";
import {
  ThreadCategoryMap,
  loadThreadCategories,
  saveThreadCategories,
} from "./lib/categoryTags";
import { SummaryGenerator } from "./components/SummaryGenerator";
import { ActionItemsView } from "./components/ActionItemsView";
import {
  DEFAULT_TAG_THRESHOLD,
  TagDef,
  effectiveTagThreshold,
  loadTags,
  saveTags,
  taggedChatIds,
} from "./lib/tags";
import { SettingsView } from "./components/SettingsView";
import {
  filterChatsByEntities,
  filterItemsByEntities,
  filterItemsByRange,
} from "./lib/topOfMind";
import { TopOfMind } from "./components/TopOfMind";
import { UrlPreviewLayer } from "./components/UrlPreviewLayer";

const MODEL_KEY = "takeout_summarizer_model_config_v1";

const DEFAULT_MODEL_CONFIG: DualModelConfig = {
  useSameModel: false,
  discovery: { provider: "meta", model: DEFAULT_CONTRIBUTOR_MODEL },
  synthesis: { provider: "meta", model: DEFAULT_CONTRIBUTOR_MODEL },
  maxTokensPerSynthesisBatch: DEFAULT_MAX_TOKENS_PER_BATCH,
  zeroShotThreshold: 0.4,
  nerScoreFloor: 0,
  nerBackend: "local",
  nliBackend: "local",
  mentionMinChats: 4,
};

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Unknown date";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dayKey: string): string {
  if (dayKey === "Unknown date") return dayKey;
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export const App: React.FC = () => {
  const [uuid] = useState<string>(() => getOrCreateUuid());
  const [view, setView] = useState<SidebarView>("top");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [items, setItems] = useState<ParsedActivityItem[]>([]);
  const [query, setQuery] = useState("");
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [scrollReq, setScrollReq] = useState<{ day: string | null; nonce: number }>({ day: null, nonce: 0 });
  const [selectedIds] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<TagDef[]>(() => loadTags(uuid));
  const [chatEntities, setChatEntities] = useState<ChatEntityMap>(() => loadChatEntities(uuid));
  const [threadCategories, setThreadCategories] = useState<ThreadCategoryMap>(() => loadThreadCategories(uuid));
  const [activeEntities, setActiveEntities] = useState<string[]>([]);
  const [activeDateRange, setActiveDateRange] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);

  const [modelConfig, setModelConfig] = useState<DualModelConfig>(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY);
      if (saved) {
        // normalizeModelConfig also migrates pre-Meta stored configs
        return normalizeModelConfig({
          ...DEFAULT_MODEL_CONFIG,
          ...JSON.parse(saved),
        });
      }
    } catch { /* ignore */ }
    return DEFAULT_MODEL_CONFIG;
  });

  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "local";
    }
  }, []);

  // Hydrate persisted histories for this uuid (survives app updates)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadHistories(uuid);
      if (cancelled) return;
      if (stored && stored.itemsJson) {
        try {
          const parsed = JSON.parse(stored.itemsJson) as ParsedActivityItem[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            const sorted = [...parsed].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            setItems(sorted);
            setHydrated(true);
            return;
          }
        } catch { /* fall through to empty */ }
      }
      setItems([]);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [uuid]);

  // A restore writes storage itself; each echo re-persist is skipped once
  // so restored bytes (and file names) survive untouched. Model config is
  // excluded: restore never writes it, so its effect must persist the merge.
  const skipPersistRef = useRef({ items: false, tags: false, entities: false, categories: false });
  // Persist on change (debounced by effect)
  useEffect(() => {
    if (!hydrated) return;
    if (skipPersistRef.current.items) {
      skipPersistRef.current.items = false;
      return;
    }
    const t = setTimeout(() => {
      try {
        saveHistories(uuid, items, []);
      } catch { /* quota errors ignored */ }
    }, 600);
    return () => clearTimeout(t);
  }, [items, uuid, hydrated]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(modelConfig));
    } catch { /* ignore */ }
  }, [modelConfig]);

  const handleItemsLoaded = (newItems: ParsedActivityItem[], replace = false) => {
    setItems((prev) => {
      const combined = replace ? newItems : [...prev, ...newItems];
      const map = new Map<string, ParsedActivityItem>();
      for (const it of combined) {
        const key = `${it.timestamp}|${it.cleanTitle}`;
        map.set(key, it);
      }
      const unique = Array.from(map.values());
      unique.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return unique;
    });
  };

  const taggingThreshold = modelConfig.zeroShotThreshold ?? DEFAULT_TAG_THRESHOLD;

  useEffect(() => {
    if (skipPersistRef.current.tags) {
      skipPersistRef.current.tags = false;
      return;
    }
    saveTags(uuid, tags);
  }, [tags, uuid]);

  useEffect(() => {
    if (skipPersistRef.current.entities) {
      skipPersistRef.current.entities = false;
      return;
    }
    saveChatEntities(uuid, chatEntities);
  }, [chatEntities, uuid]);

  useEffect(() => {
    if (skipPersistRef.current.categories) {
      skipPersistRef.current.categories = false;
      return;
    }
    saveThreadCategories(uuid, threadCategories);
  }, [threadCategories, uuid]);

  // Search index builds only while a query is active (it lowercases the
  // full corpus, so building it on every load blocks restore/import); the
  // boolean dep keeps keystrokes from rebuilding it.
  const needIndex = query.trim() !== "";
  const indexed = useMemo(
    () => (needIndex ? buildSearchIndex(items) : []),
    [items, needIndex]
  );

  // Active tags in activation order; retagging on threshold change is
  // instant since scores are stored per chat.
  const activeTags = useMemo(
    () =>
      activeTagIds
        .map((id) => tags.find((t) => t.id === id))
        .filter((t): t is TagDef => Boolean(t)),
    [tags, activeTagIds]
  );

  // A chat shows if it matches ANY active tag or ANY active entity; tag,
  // entity and text filters are mutually exclusive, activating one clears
  // the others. Each tag uses its own threshold override, falling back to
  // the global one. The thread filter applies on top so sidebar days stay
  // aligned with the thread-filtered chats.
  const baseVisibleItems = useMemo(() => {
    if (activeDateRange) {
      return filterItemsByRange(
        items,
        activeDateRange.start,
        activeDateRange.end
      );
    }
    if (activeEntities.length > 0) {
      return filterChatsByEntities(items, chatEntities, activeEntities);
    }
    if (activeTags.length > 0) {
      const ids = new Set<string>();
      for (const tag of activeTags) {
        for (const id of taggedChatIds(tag, effectiveTagThreshold(tag, taggingThreshold))) ids.add(id);
      }
      return items.filter((it) => ids.has(it.id));
    }
    return query.trim() ? fuzzyFilterIndexed(indexed, query) : items;
  }, [indexed, items, query, activeTags, activeEntities, activeDateRange, chatEntities, taggingThreshold]);

  const visibleItems = useMemo(() => {
    if (!focusedThread) return baseVisibleItems;
    return baseVisibleItems.filter(
      (it) => (it.threadUrl || it.titleUrl || null) === focusedThread
    );
  }, [baseVisibleItems, focusedThread]);

  // Threads page: same filters, but entity matches expand to whole threads
  // (date range keeps precedence, as in baseVisibleItems).
  const threadVisibleItems = useMemo(() => {
    if (activeEntities.length > 0 && !activeDateRange) {
      return filterItemsByEntities(items, chatEntities, activeEntities);
    }
    return baseVisibleItems;
  }, [items, chatEntities, activeEntities, activeDateRange, baseVisibleItems]);

  const focusedThreadTitle = useMemo(() => {
    if (!focusedThread) return null;
    const inThread = items.filter(
      (it) => (it.threadUrl || it.titleUrl || null) === focusedThread
    );
    if (inThread.length === 0) return focusedThread;
    inThread.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return (
      inThread[0].turns[0]?.prompt?.trim() ||
      inThread[0].title?.trim() ||
      focusedThread
    );
  }, [items, focusedThread]);

  // Best passing {target, contrast} score per chat across the active tags,
  // so each card can show why it matched. Empty when no tag filter applies.
  const activeScores = useMemo(() => {
    if (activeTags.length === 0) return undefined;
    const best: Record<string, { t: number; c: number }> = {};
    for (const tag of activeTags) {
      const th = effectiveTagThreshold(tag, taggingThreshold);
      for (const [id, s] of Object.entries(tag.scores || {})) {
        if (!(s.t >= th && s.t > s.c)) continue;
        const cur = best[id];
        if (!cur || s.t > cur.t) best[id] = { t: s.t, c: s.c };
      }
    }
    return best;
  }, [activeTags, tags, taggingThreshold]);

  const days = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of visibleItems) {
      const k = localDayKey(it.timestamp);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, count]) => ({ key, label: formatDayLabel(key), count }));
  }, [visibleItems]);

  useEffect(() => {
    if (days.length === 0) {
      setSelectedDay(null);
    } else if (!selectedDay || !days.some((d) => d.key === selectedDay)) {
      setSelectedDay(days[0].key);
    }
  }, [days]);

  // Drop active tag filters whose tag was deleted.
  useEffect(() => {
    setActiveTagIds((prev) => {
      if (prev.length === 0) return prev;
      const kept = prev.filter((id) => tags.some((t) => t.id === id));
      return kept.length === prev.length ? prev : kept;
    });
  }, [tags]);

  const navigate = (v: SidebarView) => {
    // Entering the Threads list always shows every thread; entering Chats
    // from the menu always shows every chat. The thread filter only
    // applies within the Chat Histories view once opened from a thread.
    if (v === "threads" || v === "chat") setFocusedThread(null);
    setView(v);
    setMobileOpen(false);
  };

  // Opening a thread shows its newest-first history from the top.
  const openThread = (key: string) => {
    setFocusedThread(key);
    setView("chat");
    window.scrollTo(0, 0);
  };

  return (
    <div className="min-h-screen bg-canvas text-ink flex">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        view={view}
        onNavigate={navigate}
        historyCount={visibleItems.length}
        selectedCount={selectedIds.size}
        uuid={uuid}
        days={days}
        selectedDay={selectedDay}
        timeZone={timeZone}
        onSelectDay={(dayKey) => {
          setSelectedDay(dayKey);
          setScrollReq((r) => ({ day: dayKey, nonce: r.nonce + 1 }));
          setView("chat");
          setMobileOpen(false);
        }}
      />

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 flex items-center gap-1 px-2 py-2 border-b border-divider bg-canvas/95 backdrop-blur">
          <SidebarHamburger onClick={() => setMobileOpen(true)} />
          <span className="text-xl font-bold tracking-tight">ExtBrain</span>
        </div>

        <main className="flex-1 min-w-0 px-3 sm:px-6 py-5 w-full mx-auto space-y-4">
          {view === "top" && (
            <TopOfMind
              items={items}
              entityMap={chatEntities}
              categoryMap={threadCategories}
              minScore={modelConfig.nerScoreFloor ?? 0}
              uuid={uuid}
              onOpenThread={openThread}
              onViewChats={(keys) => {
                setQuery("");
                setActiveTagIds([]);
                setActiveEntities(keys);
                setActiveDateRange(null);
                setFocusedThread(null);
                setView("threads");
              }}
              onReadArchives={(start, end) => {
                setQuery("");
                setActiveTagIds([]);
                setActiveEntities([]);
                setFocusedThread(null);
                setActiveDateRange({ start, end });
                setView("chat");
                window.scrollTo(0, 0);
              }}
              onViewRangeThreads={(start, end) => {
                setQuery("");
                setActiveTagIds([]);
                setActiveEntities([]);
                setFocusedThread(null);
                setActiveDateRange({ start, end });
                setView("threads");
                window.scrollTo(0, 0);
              }}
              synthesisModel={modelConfig.synthesis}
              maxTokensPerBatch={modelConfig.maxTokensPerSynthesisBatch}
              onOpenModelSettings={() => navigate("settings")}
              onNavigate={navigate}
            />
          )}

          {view === "load" && (
            <div className="space-y-8">
              <FileUploader
                onItemsLoaded={handleItemsLoaded}
                uuid={uuid}
                onBackupRestored={(result) => {
                  skipPersistRef.current = {
                    items: true,
                    tags: true,
                    entities: true,
                    categories: true,
                  };
                  handleItemsLoaded(result.items, true);
                  setTags(result.tags);
                  setChatEntities(result.entities);
                  setThreadCategories(result.categories);
                  setModelConfig(result.modelConfig);
                }}
              />
              <EntityProcessSection
                uuid={uuid}
                items={items}
                entityMap={chatEntities}
                minScore={modelConfig.nerScoreFloor ?? 0}
                minChats={modelConfig.mentionMinChats ?? 4}
                onEntitiesChange={setChatEntities}
                categoryMap={threadCategories}
                onCategoriesChange={setThreadCategories}
              />
            </div>
          )}

          {view === "chat" && (
            <HistoriesView
              uuid={uuid}
              items={visibleItems}
              totalCount={items.length}
              entityMap={chatEntities}
              minScore={modelConfig.nerScoreFloor ?? 0}
              onSelectEntities={(keys) => {
                setQuery("");
                setActiveTagIds([]);
                setActiveEntities(keys);
                setActiveDateRange(null);
                setFocusedThread(null);
              }}
              activeEntities={activeEntities}
              onToggleEntity={(key) =>
                setActiveEntities((prev) => prev.filter((k) => k !== key))
              }
              activeDateRange={activeDateRange}
              onClearDateRange={() => setActiveDateRange(null)}
              scrollTarget={scrollReq}
              onVisibleDayChange={setSelectedDay}
              activeTags={activeTags.map((t) => ({
                id: t.id,
                name: t.name,
                threshold: effectiveTagThreshold(t, taggingThreshold),
              }))}
              onToggleTag={(id) =>
                setActiveTagIds((prev) => prev.filter((x) => x !== id))
              }
              onTagThresholdChange={(id, v) =>
                setTags((prev) =>
                  prev.map((t) => (t.id === id ? { ...t, threshold: v } : t))
                )
              }
              onOpenThread={openThread}
              activeThreadKey={focusedThread}
              activeThreadTitle={focusedThreadTitle}
              onShowAllThreads={() => {
                setFocusedThread(null);
                setView("threads");
              }}
              synthesisModel={modelConfig.synthesis}
              maxTokensPerBatch={modelConfig.maxTokensPerSynthesisBatch}
              onOpenModelSettings={() => navigate("settings")}
              matchScores={activeScores}
            />
          )}

          {view === "threads" && (
            <ThreadsView
              items={threadVisibleItems}
              entityMap={chatEntities}
              minScore={modelConfig.nerScoreFloor ?? 0}
              onOpenThread={openThread}
              activeDateRange={activeDateRange}
              onClearDateRange={() => setActiveDateRange(null)}
              activeEntities={activeEntities}
              onSelectEntities={(keys) => {
                setQuery("");
                setActiveTagIds([]);
                setActiveEntities(keys);
                setActiveDateRange(null);
                setFocusedThread(null);
              }}
            />
          )}

          {view === "actions" && (
            <ActionItemsView
              uuid={uuid}
              onOpenThread={openThread}
              onNavigate={navigate}
            />
          )}

          {view === "topics" && (
            <Tagging
              items={items}
              tags={tags}
              onTagsChange={setTags}
              discoveryModel={modelConfig.discovery}
              threshold={taggingThreshold}
              activeTagIds={activeTagIds}
              onOpenTag={(id) => {
                setQuery("");
                setActiveEntities([]);
                setActiveDateRange(null);
                setFocusedThread(null);
                setActiveTagIds((prev) =>
                  prev.includes(id) ? prev : [...prev, id]
                );
                setView("chat");
              }}
            />
          )}

          {view === "summary" && (
            <SummaryGenerator
              uuid={uuid}
              onOpenThread={openThread}
              onOpenTag={(id) => {
                setQuery("");
                setActiveEntities([]);
                setActiveDateRange(null);
                setFocusedThread(null);
                setActiveTagIds([id]);
                setView("chat");
              }}
            />
          )}

          {view === "settings" && (
            <SettingsView
              uuid={uuid}
              config={modelConfig}
              onChange={setModelConfig}
              entityMap={chatEntities}
            />
          )}
        </main>
      </div>

      <UrlPreviewLayer />
    </div>
  );
};
