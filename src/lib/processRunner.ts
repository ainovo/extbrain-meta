import { ParsedActivityItem } from "./types";
import { buildEntryClassificationText } from "./retrievalEngine";
import {
  ChatEntityHashMap,
  ChatEntityMap,
  chatNeedsProcessing,
  entityTextHash,
  saveChatEntityHashes,
} from "./entities";

export interface ProcessQueueItem {
  id: string;
  text: string;
  hash: string;
}

export interface ProcessJobSnapshot {
  status: "idle" | "running";
  done: number;
  total: number;
  error: string | null;
  /** Dataset the current/last run belongs to (null before the first run). */
  uuid: string | null;
}

export interface ProcessStartArgs {
  uuid: string;
  items: ParsedActivityItem[];
  baseMap: ChatEntityMap;
  baseHashes: ChatEntityHashMap;
  serverVersion: number | null;
  microBatch?: number;
  onBatch: (merged: ChatEntityMap, batchHashes: ChatEntityHashMap) => void;
}

type Listener = (snap: ProcessJobSnapshot) => void;

const MICRO_BATCH = 8;

/**
 * Chats needing (re-)processing, newest first: missing entities, changed
 * text, or a record from an older processor version. Sort is stable, so
 * ties and undated chats keep import order after all dated ones.
 */
export function buildProcessQueue(
  items: ParsedActivityItem[],
  baseMap: ChatEntityMap,
  baseHashes: ChatEntityHashMap,
  serverVersion: number | null
): ProcessQueueItem[] {
  const queue: Array<ProcessQueueItem & { ts: string }> = [];
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
    queue.push({ id: it.id, text, hash, ts: it.timestamp ?? "" });
  }
  queue.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return queue.map(({ id, text, hash }) => ({ id, text, hash }));
}

interface BatchResult {
  id: string;
  entities: Array<{ text: string; label: string; score: number }>;
}

/**
 * Singleton NER processing runner. The loop lives here instead of in the
 * Load-view section so runs survive view switches; UI subscribes for
 * progress and unsubscribes on unmount without stopping anything.
 *
 * Single-flight: at most one run exists, so Resume can never stack a second
 * run over the first. stop() invalidates synchronously, so a new run can
 * start immediately (a stale loop exits silently when its fetch settles).
 */
class EntityProcessRunner {
  private status: "idle" | "running" = "idle";
  private done = 0;
  private total = 0;
  private error: string | null = null;
  private uuid: string | null = null;
  private abort: AbortController | null = null;
  private runId = 0;
  private listeners = new Set<Listener>();

  getSnapshot(): ProcessJobSnapshot {
    return {
      status: this.status,
      done: this.done,
      total: this.total,
      error: this.error,
      uuid: this.uuid,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  }

  /** False when a run is already active (caller should stop it first). */
  start(args: ProcessStartArgs): boolean {
    if (this.status === "running") return false;
    const queue = buildProcessQueue(
      args.items,
      args.baseMap,
      args.baseHashes,
      args.serverVersion
    );
    this.error = null;
    if (queue.length === 0) {
      this.notify();
      return true;
    }
    const id = ++this.runId;
    const controller = new AbortController();
    this.abort = controller;
    this.status = "running";
    this.done = 0;
    this.total = queue.length;
    this.uuid = args.uuid;
    this.notify();
    void this.loop(id, controller, args, queue);
    return true;
  }

  stop(): void {
    if (this.status !== "running") return;
    this.runId++; // invalidate the loop synchronously; its finally no-ops
    this.abort?.abort();
    this.abort = null;
    this.status = "idle";
    this.notify();
  }

  private async loop(
    id: number,
    controller: AbortController,
    args: ProcessStartArgs,
    queue: ProcessQueueItem[]
  ): Promise<void> {
    const alive = () => id === this.runId && this.status === "running";
    const batchSize = args.microBatch ?? MICRO_BATCH;
    let merged: ChatEntityMap = { ...args.baseMap };
    let hashes: ChatEntityHashMap = { ...args.baseHashes };
    try {
      for (let i = 0; i < queue.length; i += batchSize) {
        if (!alive() || controller.signal.aborted) return;
        const slice = queue.slice(i, i + batchSize);
        const resp = await fetch("/api/extract-entities-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: slice }),
          signal: controller.signal,
        });
        if (!alive()) return;
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { results?: BatchResult[] };
        if (!alive()) return;
        const batchHashes: ChatEntityHashMap = {};
        for (const s of slice) {
          batchHashes[s.id] = {
            hash: s.hash,
            version:
              args.serverVersion ?? args.baseHashes[s.id]?.version ?? 0,
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
        hashes = { ...hashes, ...batchHashes };
        // Persist here (not only in the UI): the section may be unmounted
        // while a background run continues.
        saveChatEntityHashes(args.uuid, hashes);
        args.onBatch(merged, batchHashes);
        this.done = Math.min(queue.length, i + slice.length);
        this.notify();
      }
    } catch (err: unknown) {
      if (!alive()) return; // superseded or stopped: stay silent
      if (
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return; // stopped by user: keep partial progress, no error
      }
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!alive()) return;
      this.abort = null;
      this.status = "idle";
      this.notify();
    }
  }
}

export const processRunner = new EntityProcessRunner();
