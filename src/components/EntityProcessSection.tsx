import React, { useEffect, useMemo, useRef, useState } from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import { buildEntryClassificationText } from "../lib/retrievalEngine";
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

const MICRO_BATCH = 8;

/** NER processing controls: finds people, organizations, and places in chats. */
export const EntityProcessSection: React.FC<Props> = ({
  uuid,
  items,
  entityMap,
  onEntitiesChange,
  minScore = 0,
}) => {
  const [run, setRun] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [hashes, setHashes] = useState<ChatEntityHashMap>(() =>
    loadChatEntityHashes(uuid)
  );
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page stops the run: otherwise the loop keeps processing
  // headless and a later "Resume" press would stack a second run over it.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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

  // Chats whose text changed (re-import) or which predate the running
  // processor version are (re-)processed; unchanged chats keep their entities.
  const start = async (
    baseMap: ChatEntityMap = entityMap,
    baseHashes: ChatEntityHashMap = hashes
  ) => {
    if (run) return;
    const queue: Array<{ id: string; text: string; hash: string }> = [];
    for (const it of items) {
      const text = buildEntryClassificationText(it, []);
      const hash = entityTextHash(text);
      if (
        !chatNeedsProcessing({
          hasEntities: it.id in baseMap,
          entry: baseHashes[it.id],
          hash,
          serverVersion,
        })
      ) {
        continue;
      }
      queue.push({ id: it.id, text, hash });
    }
    if (queue.length === 0) {
      setError(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ done: 0, total: queue.length });
    setError(null);
    try {
      let merged: ChatEntityMap = { ...baseMap };
      for (let i = 0; i < queue.length; i += MICRO_BATCH) {
        if (controller.signal.aborted) {
          break;
        }
        const slice = queue.slice(i, i + MICRO_BATCH);
        const resp = await fetch("/api/extract-entities-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: slice }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          results: Array<{
            id: string;
            entities: Array<{ text: string; label: string; score: number }>;
          }>;
        };
        const batchHashes: ChatEntityHashMap = {};
        for (const s of slice) {
          batchHashes[s.id] = {
            hash: s.hash,
            version: serverVersion ?? baseHashes[s.id]?.version ?? 0,
          };
        }
        for (const r of data.results || []) {
          merged[r.id] = (r.entities || []).map((e) => ({
            name: e.text,
            type: e.label,
            score: e.score,
          }));
        }
        merged = { ...merged };
        onEntitiesChange(merged);
        setHashes((prev) => ({ ...prev, ...batchHashes }));
        setRun({
          done: Math.min(queue.length, i + slice.length),
          total: queue.length,
        });
      }
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === "AbortError") {
        // Stopped by user: keep partial progress, no error.
      } else {
        setError(err?.message || String(err));
      }
    } finally {
      setRun(null);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const clearAndRestart = () => {
    if (run) return;
    const ok = window.confirm(
      "Discard all processed entities and reprocess every chat from scratch? " +
        "Use this after a processing upgrade (e.g. fixed entity spellings). " +
        "This takes a while for large histories."
    );
    if (!ok) return;
    onEntitiesChange({});
    setHashes({});
    void start({}, {});
  };

  const progressPct =
    run && run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h3 className="text-base sm:text-lg font-bold tracking-tight text-ink leading-tight">
          Process chats
        </h3>
        <p className="text-[13px] text-mention mt-1">
          Finds people, organizations, and places with bert-base-NER for
          mention search and highlights.
        </p>
      </div>

      {serverVersion !== null && outdatedCount > 0 && !run && (
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
          {run ? (
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
          {processedCount > 0 && !run && (
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
        {run && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-tag overflow-hidden">
              <div
                className="h-full bg-action transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-mention font-mono">
              {run.done}/{run.total} chats ({progressPct}%)
            </div>
          </div>
        )}
        {error && (
          <div className="mt-3 text-[13px] text-ink">Error: {error}</div>
        )}
      </div>
    </div>
  );
};
