import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import {
  ProcessJobSnapshot,
  ProcessQueueItem,
  buildProcessQueuesAsync,
  processRunner,
} from "../lib/processRunner";
import {
  ChatEntityHashMap,
  ChatEntityMap,
  EntityAggregate,
  entityStorageInfo,
  loadChatEntityHashes,
  saveChatEntityHashes,
} from "../lib/entities";
import {
  getPersistOutcomeVersion,
  lastPersistError,
  localStorageTotalKB,
  subscribePersistOutcome,
} from "../lib/compressedJson";
import { ThreadCategoryMap } from "../lib/categoryTags";
import { summarizeThreads } from "../lib/threads";

interface Props {
  uuid: string;
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  /** Shared App-level aggregation (same score floor), for the count readout. */
  mentionCandidates: EntityAggregate[];
  onEntitiesChange: (map: ChatEntityMap) => void;
  categoryMap: ThreadCategoryMap;
  onCategoriesChange: (map: ThreadCategoryMap) => void;
  /** Human-facing minimum chats per mention (default 4). */
  minChats?: number;
}

function readStorageInfo(uuid: string) {
  const totalKB = localStorageTotalKB();
  const ent = entityStorageInfo(uuid);
  const persistError = lastPersistError();
  return { totalKB, ent, persistError };
}

/**
 * Processing controls: NER (people, organizations, places) for mention
 * search, then one category tag per thread for Top Threads.
 */
export const EntityProcessSection: React.FC<Props> = ({
  uuid,
  items,
  entityMap,
  mentionCandidates,
  onEntitiesChange,
  categoryMap,
  onCategoriesChange,
  minChats = 4,
}) => {
  const [job, setJob] = useState<ProcessJobSnapshot>(() =>
    processRunner.getSnapshot()
  );
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [hashes, setHashes] = useState<ChatEntityHashMap>(() =>
    loadChatEntityHashes(uuid)
  );
  const uuidRef = useRef(uuid);

  // Subscribe to the shared runner: unmounting only unsubscribes, so runs
  // continue in the background across view switches. A dataset switch stops
  // the orphaned run so its batches can't land in the wrong dataset's
  // stores. (The runner is single-flight, so Resume can never stack runs.)
  useEffect(() => {
    if (uuidRef.current !== uuid) {
      uuidRef.current = uuid;
      processRunner.stop();
    }
    return processRunner.subscribe(setJob);
  }, [uuid]);

  useEffect(() => {
    saveChatEntityHashes(uuid, hashes);
  }, [hashes, uuid]);

  // Ask the backend which processor logic it runs so stale entities can be
  // flagged instead of looking like fresh bugs. Polls until it succeeds:
  // a single failed fetch (e.g. mid-restart) must never pin the version to
  // null for the session — runs stamped version 0 would all requeue on the
  // next load, looking exactly like lost progress.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const resp = await fetch("/api/health");
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled && typeof data?.nerExtractorVersion === "number") {
            setServerVersion(data.nerExtractorVersion);
            return;
          }
        }
      } catch {
        // backend down: retry below
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const processedCount = Object.keys(entityMap).length;
  const categorizedCount = Object.keys(categoryMap).length;
  const threadTotal = useMemo(() => summarizeThreads(items).length, [items]);
  // Work still pending, per phase: NER per chat (missing entities, changed
  // text, older processor), then one category verdict per thread (missing
  // verdict, changed thread text, older taxonomy). Records are per unit,
  // so an interrupted run resumes where it stopped instead of restarting.
  // Computed off the render path in chunks: the full-corpus text+hash scan
  // blocks navigation for seconds on large histories when run synchronously
  // in render (and refires when the health poll resolves the processor
  // version). While a run is active the runner's own progress drives the
  // UI, so queues recompute only when it settles.
  const [pendingQueues, setPendingQueues] = useState<{
    ner: ProcessQueueItem[];
    cats: ProcessQueueItem[];
  } | null>(null);
  useEffect(() => {
    if (job.status === "running" && job.uuid === uuid) return;
    let cancelled = false;
    setPendingQueues(null);
    void buildProcessQueuesAsync(
      items,
      entityMap,
      hashes,
      serverVersion,
      categoryMap,
      { isCancelled: () => cancelled }
    ).then((queues) => {
      if (!cancelled) setPendingQueues(queues);
    });
    return () => {
      cancelled = true;
    };
  }, [items, entityMap, hashes, serverVersion, categoryMap, uuid, job.status, job.uuid]);
  const pendingCount =
    (pendingQueues?.ner.length ?? 0) + (pendingQueues?.cats.length ?? 0);
  // Name each phase: a combined "N left" can exceed the chat count (every
  // chat needs both steps), which reads as a bug.
  const resumeLabel = (() => {
    if (!pendingQueues) return "Checking…";
    if (processedCount === 0) return "Process chats";
    if (pendingCount === 0) return "Processing complete";
    const parts: string[] = [];
    if (pendingQueues.ner.length > 0) {
      parts.push(`${pendingQueues.ner.length.toLocaleString()} entities`);
    }
    if (pendingQueues.cats.length > 0) {
      parts.push(`${pendingQueues.cats.length.toLocaleString()} tags`);
    }
    return `Resume processing (${parts.join(" · ")} left)`;
  })();

  const outdatedCount = useMemo(() => {
    if (serverVersion === null) return 0;
    let n = 0;
    for (const it of items) {
      const e = hashes[it.id];
      if (it.id in entityMap && e && e.version < serverVersion) n++;
    }
    return n;
  }, [items, entityMap, hashes, serverVersion]);

  // Count readout off the shared aggregation: aggregateEntities keeps
  // entries with chats.size > minChats, so filtering the minChats=0
  // candidates by chatCount >= minChats is the identical set, without a
  // second full fold on every Load visit.
  const entityCount = useMemo(
    () => mentionCandidates.filter((c) => c.chatCount >= minChats).length,
    [mentionCandidates, minChats]
  );

  // The run lives in the shared processRunner (survives view switches);
  // this section only starts/stops and mirrors progress. Chats whose text
  // changed (re-import) or which predate the running processor version are
  // (re-)processed; unchanged chats keep their entities and category tags.
  const start = (
    baseMap: ChatEntityMap = entityMap,
    baseHashes: ChatEntityHashMap = hashes,
    baseThreadCategories: ThreadCategoryMap = categoryMap
  ) => {
    // NER needs the backend anyway; never start unversioned (null stamps
    // version-0 records that requeue on the next load).
    if (serverVersion === null) return;
    processRunner.start({
      uuid,
      items,
      baseMap,
      baseHashes,
      baseThreadCategories,
      serverVersion,
      onBatch: (merged, batchHashes) => {
        onEntitiesChange(merged);
        setHashes((prev) => ({ ...prev, ...batchHashes }));
      },
      onCategories: (merged) => {
        onCategoriesChange(merged);
      },
    });
  };

  const stop = () => processRunner.stop();

  const clearAndRestart = () => {
    if (job.status === "running") return;
    const ok = window.confirm(
      "Discard all processed entities and category tags, then reprocess every chat from scratch? " +
        "Use this after a processing upgrade (e.g. fixed entity spellings). " +
        "This takes a while for large histories."
    );
    if (!ok) return;
    onEntitiesChange({});
    setHashes({});
    onCategoriesChange({});
    start({}, {}, {});
  };

  // A run for another dataset must not drive this section's UI (briefly
  // possible while a dataset switch stops the orphaned run).
  const active = job.status === "running" && job.uuid === uuid;
  const visibleError = job.uuid === uuid ? job.error : null;

  const progressPct =
    active && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  // Every completed save bumps this, so the readout below re-reads the
  // recorded error even when the save ran in an effect with no state
  // change after it (previously those failures stayed invisible).
  const persistOutcome = useSyncExternalStore(
    subscribePersistOutcome,
    getPersistOutcomeVersion,
    getPersistOutcomeVersion
  );
  // Storage readout: localStorageTotalKB serializes the whole store, so
  // refresh it after paint and at most once per 2s — per-batch saves during
  // a run must not each pay a full-store stringify. A recorded save failure
  // still names the error, so stuck persistence stays visible.
  const [storageInfo, setStorageInfo] = useState(() => readStorageInfo(uuid));
  const lastStorageRead = useRef(0);
  useEffect(() => {
    if (Date.now() - lastStorageRead.current < 2000) return;
    lastStorageRead.current = Date.now();
    const t = setTimeout(() => setStorageInfo(readStorageInfo(uuid)), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, job.done, entityMap, categoryMap, persistOutcome]);

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h3 className="text-base sm:text-lg font-bold tracking-tight text-ink leading-tight">
          Process chats
        </h3>
        <p className="text-[13px] text-mention mt-1">
          Finds people, organizations, and places with RoBERTa-large NER for
          mention search and highlights, then tags each thread with one of
          9 categories for Top Threads. Newest first, keeps running when
          you switch pages.
        </p>
      </div>

      {serverVersion !== null && outdatedCount > 0 && !active && (
        <div className="rounded-xl border border-divider bg-tag px-4 py-3 text-[13px] text-ink">
          {outdatedCount} {outdatedCount === 1 ? "chat was" : "chats were"}{" "}
          processed with an older version — the current processor (v
          {serverVersion}) fixes truncated spellings like “servin” or “MHOROS”
          and records calibrated confidence scores for the Settings floor.{" "}
          <button
            type="button"
            onClick={() => void start()}
            className="underline font-medium hover:text-ink"
          >
            Process outdated chats
          </button>{" "}
          to apply the fixes.
          </div>
        )}

      <div className="rounded-xl border border-divider bg-canvas p-4">
        <div className="flex items-center gap-3 flex-wrap">
          {active ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action-hover transition"
            >
              <Square className="w-4 h-4" />
              Stop processing
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={
                items.length === 0 ||
                pendingCount === 0 ||
                serverVersion === null
              }
              title={
                serverVersion === null
                  ? "Connecting to the backend…"
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
            >
              <Play className="w-4 h-4" />
              {serverVersion === null ? "Connecting…" : resumeLabel}
            </button>
          )}
          {processedCount > 0 && !active && (
            <button
              type="button"
              onClick={clearAndRestart}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action-hover transition"
            >
              <RotateCcw className="w-4 h-4" />
              Reprocess all
            </button>
          )}
          <span className="text-[12px] text-mention">
            Entities: {processedCount.toLocaleString()}/
            {items.length.toLocaleString()} chats · Categories:{" "}
            {categorizedCount.toLocaleString()}/{threadTotal.toLocaleString()}{" "}
            threads
            {entityCount > 0 && (
              <>
                {" · "}
                <strong className="text-ink font-semibold">
                  {entityCount}
                </strong>{" "}
                entities in {minChats}+ chats
              </>
            )}
          </span>
        </div>
        {active && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-tag overflow-hidden">
              <div
                className="h-full bg-action transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-mention font-mono">
              {job.phase === "categories"
                ? "Scoring categories"
                : "Extracting entities"}{" "}
              · {job.done}/{job.total} steps ({progressPct}%)
            </div>
          </div>
        )}
        {visibleError && (
          <div className="mt-3 text-[13px] text-ink">Error: {visibleError}</div>
        )}
        {storageInfo.totalKB !== null && (
          <div
            className="mt-3 text-[11px] text-mention font-mono"
            title="Browser storage used by this origin (cap ~5MB). Entities flip from raw to gz on the first save after the compression update."
          >
            Storage {storageInfo.totalKB.toLocaleString()}KB · entities{" "}
            {storageInfo.ent.format} {storageInfo.ent.kb.toLocaleString()}KB{" "}
            {/* Marker: only builds with the quota-retry persist path render
                this, so its absence proves a stale tab/server. Bump the tag
                when the persist path changes. */}
            <span title="persistence layer: quota-retry + dual-save + reactive errors">
              · store v3
            </span>
            {storageInfo.persistError && (
              <span
                className="font-semibold text-ink"
                title={`${storageInfo.persistError.key}: ${storageInfo.persistError.message}`}
              >
                {" "}
                · SAVE FAILED ({storageInfo.persistError.name})
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
