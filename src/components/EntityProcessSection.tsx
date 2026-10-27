import React, { useEffect, useMemo, useRef, useState } from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import { buildEntryClassificationText } from "../lib/retrievalEngine";
import { ProcessJobSnapshot, processRunner } from "../lib/processRunner";
import {
  ChatEntityHashMap,
  ChatEntityMap,
  aggregateEntities,
  chatNeedsProcessing,
  entityTextHash,
  loadChatEntityHashes,
  saveChatEntityHashes,
} from "../lib/entities";

interface Props {
  uuid: string;
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  onEntitiesChange: (map: ChatEntityMap) => void;
  minScore?: number;
}

/** NER processing controls: finds people, organizations, and places in chats. */
export const EntityProcessSection: React.FC<Props> = ({
  uuid,
  items,
  entityMap,
  onEntitiesChange,
  minScore = 0,
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
  // flagged instead of looking like fresh bugs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/health");
        if (!resp.ok) return;
        const data = await resp.json();
        if (!cancelled && typeof data?.nerExtractorVersion === "number") {
          setServerVersion(data.nerExtractorVersion);
        }
      } catch {
        // unreachable backend: processing will surface the error instead
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const processedCount = Object.keys(entityMap).length;
  // Chats still needing work: missing entities, changed text, or a record
  // from an older processor version. Versions are per chat, so an
  // interrupted run resumes where it stopped instead of restarting.
  const pendingCount = useMemo(() => {
    let n = 0;
    for (const it of items) {
      if (
        chatNeedsProcessing({
          hasEntities: it.id in entityMap,
          entry: hashes[it.id],
          hash: entityTextHash(buildEntryClassificationText(it, [])),
          serverVersion,
        })
      ) {
        n++;
      }
    }
    return n;
  }, [items, entityMap, hashes, serverVersion]);

  const outdatedCount = useMemo(() => {
    if (serverVersion === null) return 0;
    let n = 0;
    for (const it of items) {
      const e = hashes[it.id];
      if (it.id in entityMap && e && e.version < serverVersion) n++;
    }
    return n;
  }, [items, entityMap, hashes, serverVersion]);

  const entityCount = useMemo(
    () => aggregateEntities(entityMap, 3, minScore).length,
    [entityMap, minScore]
  );

  // The run lives in the shared processRunner (survives view switches);
  // this section only starts/stops and mirrors progress. Chats whose text
  // changed (re-import) or which predate the running processor version are
  // (re-)processed; unchanged chats keep their entities.
  const start = (
    baseMap: ChatEntityMap = entityMap,
    baseHashes: ChatEntityHashMap = hashes
  ) => {
    processRunner.start({
      uuid,
      items,
      baseMap,
      baseHashes,
      serverVersion,
      onBatch: (merged, batchHashes) => {
        onEntitiesChange(merged);
        setHashes((prev) => ({ ...prev, ...batchHashes }));
      },
    });
  };

  const stop = () => processRunner.stop();

  const clearAndRestart = () => {
    if (job.status === "running") return;
    const ok = window.confirm(
      "Discard all processed entities and reprocess every chat from scratch? " +
        "Use this after a processing upgrade (e.g. fixed entity spellings). " +
        "This takes a while for large histories."
    );
    if (!ok) return;
    onEntitiesChange({});
    setHashes({});
    start({}, {});
  };

  // A run for another dataset must not drive this section's UI (briefly
  // possible while a dataset switch stops the orphaned run).
  const active = job.status === "running" && job.uuid === uuid;
  const visibleError = job.uuid === uuid ? job.error : null;

  const progressPct =
    active && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h3 className="text-base sm:text-lg font-bold tracking-tight text-ink leading-tight">
          Process chats
        </h3>
        <p className="text-[13px] text-mention mt-1">
          Finds people, organizations, and places with XLM-RoBERTa NER for
          mention search and highlights. Chats process newest first and keep
          running when you switch pages.
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
              disabled={items.length === 0 || pendingCount === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
            >
              <Play className="w-4 h-4" />
              {processedCount === 0
                ? "Process chats"
                : pendingCount > 0
                  ? `Resume processing (${pendingCount} left)`
                  : "Processing complete"}
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
            {processedCount} of {items.length} chats processed
            {entityCount > 0 && (
              <>
                {" · "}
                <strong className="text-ink font-semibold">
                  {entityCount}
                </strong>{" "}
                entities in 4+ chats
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
              {job.done}/{job.total} chats ({progressPct}%)
            </div>
          </div>
        )}
        {visibleError && (
          <div className="mt-3 text-[13px] text-ink">Error: {visibleError}</div>
        )}
      </div>
    </div>
  );
};
