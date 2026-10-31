import { NerBackendId, NliBackendId, ParsedActivityItem } from "./types";
import { buildEntryClassificationText } from "./retrievalEngine";
import {
  ChatEntityHashMap,
  ChatEntityMap,
  chatNeedsProcessing,
  entityTextHash,
  saveChatEntities,
  saveChatEntityHashes,
  stripMarkdownForNer,
} from "./entities";
import {
  CATEGORY_LABELS,
  CATEGORY_TAXONOMY,
  CategoryDef,
  THREAD_CATEGORY_VERSION,
  ThreadCategoryMap,
  buildThreadScoringText,
  saveThreadCategories,
  scoresToCategories,
  threadNeedsCategoryScoring,
} from "./categoryTags";
import { summarizeThreads, ThreadSummary } from "./threads";
import { apiPost } from "./api";

export interface ProcessQueueItem {
  id: string;
  text: string;
  hash: string;
}

export type ProcessPhase = "entities" | "categories";

export interface ProcessJobSnapshot {
  status: "idle" | "running";
  /** Which post-NER step the run is in (categories always run last). */
  phase: ProcessPhase;
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
  baseThreadCategories: ThreadCategoryMap;
  serverVersion: number | null;
  /** Taxonomy in force for category scoring (defaults to the built-ins). */
  taxonomy?: CategoryDef[];
  /** NER backend for this run (defaults to local). */
  nerBackend?: NerBackendId;
  /** NLI backend for category scoring (defaults to local). */
  nliBackend?: NliBackendId;
  microBatch?: number;
  onBatch: (merged: ChatEntityMap, batchHashes: ChatEntityHashMap) => void;
  onCategories: (merged: ThreadCategoryMap) => void;
}

type Listener = (snap: ProcessJobSnapshot) => void;

const MICRO_BATCH = 8;
/**
 * Category micro-batch: inputs are short (prompt + first sentence) and the
 * server scores the batch in one pipeline call, so bigger slices amortize
 * HTTP plus full-map re-save overhead. Callers may still override via
 * args.microBatch (tests do).
 */
const CATEGORY_MICRO_BATCH = 16;

/**
 * Exact text fed to NER for a chat: the classification text with markdown
 * stripped, so link URLs, code, and emphasis markers never reach the model.
 * Hashes cover this text — hash what you send.
 */
export function buildNerInputText(item: ParsedActivityItem): string {
  return stripMarkdownForNer(buildEntryClassificationText(item, []));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Per-chat NER text+hash cache: buildNerInputText is pure in the item
 * object, which the app keeps stable across navigations, so repeat scans
 * (Load revisits, version-poll refires, per-batch refreshes) reuse text and
 * hash instead of re-running the full strip pipeline per chat. WeakMap:
 * entries die with replaced items (imports/restores), so the cache can't
 * go stale or leak across datasets.
 */
const nerInputCache = new WeakMap<
  ParsedActivityItem,
  { text: string; hash: string }
>();

function nerTextAndHash(it: ParsedActivityItem): {
  text: string;
  hash: string;
} {
  let cached = nerInputCache.get(it);
  if (!cached) {
    const text = buildNerInputText(it);
    cached = { text, hash: entityTextHash(text) };
    nerInputCache.set(it, cached);
  }
  return cached;
}

type QueuedChat = ProcessQueueItem & { ts: string };

/** Single-chat pending decision shared by the sync and async builders. */
function processQueueEntryFor(
  it: ParsedActivityItem,
  baseMap: ChatEntityMap,
  baseHashes: ChatEntityHashMap,
  serverVersion: number | null,
  nerBackend: NerBackendId = "local"
): QueuedChat | null {
  const { text, hash } = nerTextAndHash(it);
  if (
    !chatNeedsProcessing({
      hasEntities: it.id in baseMap,
      entry: baseHashes[it.id],
      hash,
      serverVersion,
      backend: nerBackend,
    })
  ) {
    return null;
  }
  return { id: it.id, text, hash, ts: it.timestamp ?? "" };
}

function sortQueueNewestFirst(queue: QueuedChat[]): void {
  queue.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

function stripQueueMeta(queue: QueuedChat[]): ProcessQueueItem[] {
  return queue.map(({ id, text, hash }) => ({ id, text, hash }));
}

/**
 * Chats needing (re-)processing, newest first: missing entities, changed
 * text, or a record from an older processor version. Sort is stable, so
 * ties and undated chats keep import order after all dated ones.
 */
export function buildProcessQueue(
  items: ParsedActivityItem[],
  baseMap: ChatEntityMap,
  baseHashes: ChatEntityHashMap,
  serverVersion: number | null,
  nerBackend: NerBackendId = "local"
): ProcessQueueItem[] {
  const queue: QueuedChat[] = [];
  for (const it of items) {
    const entry = processQueueEntryFor(
      it,
      baseMap,
      baseHashes,
      serverVersion,
      nerBackend
    );
    if (entry) queue.push(entry);
  }
  sortQueueNewestFirst(queue);
  return stripQueueMeta(queue);
}

/**
 * Threads queued for category scoring, newest first: one verdict per
 * thread key, independent of NER (keyless chats belong to no thread and
 * are never scored). A thread requeues only when its text changed or its
 * verdict predates the current taxonomy/scorer version.
 */
/** Single-thread pending decision shared by the sync and async builders. */
function categoryQueueEntryFor(
  t: ThreadSummary,
  baseThreadCategories: ThreadCategoryMap,
  taxonomyIds: string[],
  nliBackend: NliBackendId = "local"
): ProcessQueueItem | null {
  const text = buildThreadScoringText(t.chats);
  const hash = entityTextHash(text);
  if (
    !threadNeedsCategoryScoring({
      entry: baseThreadCategories[t.key],
      hash,
      taxonomyIds,
      backend: nliBackend,
    })
  ) {
    return null;
  }
  return { id: t.key, text, hash };
}

export function buildThreadCategoryQueue(
  items: ParsedActivityItem[],
  baseThreadCategories: ThreadCategoryMap,
  taxonomyIds: string[] = CATEGORY_LABELS,
  nliBackend: NliBackendId = "local"
): ProcessQueueItem[] {
  const queue: ProcessQueueItem[] = [];
  for (const t of summarizeThreads(items)) {
    const entry = categoryQueueEntryFor(
      t,
      baseThreadCategories,
      taxonomyIds,
      nliBackend
    );
    if (entry) queue.push(entry);
  }
  return queue;
}

export interface ProcessQueues {
  ner: ProcessQueueItem[];
  cats: ProcessQueueItem[];
}

/**
 * Pure gate for auto-starting processing after a fresh import. True only
 * when a new dataset arrived (hasChats), the runner is idle, the user did
 * not stop it, the backend version and pending queues resolved, work
 * remains, and this dataset was not already auto-started.
 */
export function shouldAutoStartProcessing(opts: {
  hasChats: boolean;
  active: boolean;
  userStopped: boolean;
  serverReady: boolean;
  blocked: boolean;
  queuesReady: boolean;
  pendingCount: number;
  alreadyStarted: boolean;
}): boolean {
  if (!opts.hasChats) return false;
  if (opts.active || opts.userStopped) return false;
  if (!opts.serverReady || opts.blocked) return false;
  if (!opts.queuesReady || opts.pendingCount === 0) return false;
  if (opts.alreadyStarted) return false;
  return true;
}

/**
 * Same pending-work result as buildProcessQueue + buildThreadCategoryQueue,
 * computed in chunks with yields to the event loop so mounting the Load
 * page never blocks navigation and paint on large histories. Returns empty
 * queues when isCancelled() trips (the caller discards stale results).
 */
export async function buildProcessQueuesAsync(
  items: ParsedActivityItem[],
  baseMap: ChatEntityMap,
  baseHashes: ChatEntityHashMap,
  serverVersion: number | null,
  baseThreadCategories: ThreadCategoryMap,
  opts?: {
    chunk?: number;
    isCancelled?: () => boolean;
    taxonomyIds?: string[];
    nerBackend?: NerBackendId;
    nliBackend?: NliBackendId;
  }
): Promise<ProcessQueues> {
  const empty: ProcessQueues = { ner: [], cats: [] };
  const chunk = Math.max(1, opts?.chunk ?? 500);
  const isCancelled = opts?.isCancelled ?? (() => false);
  const taxonomyIds = opts?.taxonomyIds ?? CATEGORY_LABELS;
  const nerBackend = opts?.nerBackend ?? "local";
  const nliBackend = opts?.nliBackend ?? "local";
  const nerQueue: QueuedChat[] = [];
  for (let i = 0; i < items.length; i += chunk) {
    if (isCancelled()) return empty;
    const end = Math.min(items.length, i + chunk);
    for (let j = i; j < end; j++) {
      const entry = processQueueEntryFor(
        items[j],
        baseMap,
        baseHashes,
        serverVersion,
        nerBackend
      );
      if (entry) nerQueue.push(entry);
    }
    await tick();
  }
  if (isCancelled()) return empty;
  sortQueueNewestFirst(nerQueue);
  const cats: ProcessQueueItem[] = [];
  const threads = summarizeThreads(items);
  for (let i = 0; i < threads.length; i += chunk) {
    if (isCancelled()) return empty;
    const end = Math.min(threads.length, i + chunk);
    for (let j = i; j < end; j++) {
      const entry = categoryQueueEntryFor(
        threads[j],
        baseThreadCategories,
        taxonomyIds,
        nliBackend
      );
      if (entry) cats.push(entry);
    }
    await tick();
  }
  if (isCancelled()) return empty;
  return { ner: stripQueueMeta(nerQueue), cats };
}

interface BatchResult {
  id: string;
  entities: Array<{ text: string; label: string; score: number }>;
}

interface CategoryBatchResult {
  id: string;
  scores: Record<string, number>;
}

/**
 * Singleton processing runner: NER extraction, then category scoring as a
 * post-NER step. The loop lives here instead of in the Load-view section
 * so runs survive view switches; UI subscribes for progress and
 * unsubscribes on unmount without stopping anything.
 *
 * Single-flight: at most one run exists, so Resume can never stack a second
 * run over the first. stop() invalidates synchronously, so a new run can
 * start immediately (a stale loop exits silently when its fetch settles).
 */
class EntityProcessRunner {
  private status: "idle" | "running" = "idle";
  private phase: ProcessPhase = "entities";
  private done = 0;
  private total = 0;
  private error: string | null = null;
  private uuid: string | null = null;
  private abort: AbortController | null = null;
  private runId = 0;
  /** Metering job id shared by every chunk of one run (single log row). */
  private meterJobId = "";
  private listeners = new Set<Listener>();

  getSnapshot(): ProcessJobSnapshot {
    return {
      status: this.status,
      phase: this.phase,
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
    const nerBackend = args.nerBackend ?? "local";
    const nliBackend = args.nliBackend ?? "local";
    const queue = buildProcessQueue(
      args.items,
      args.baseMap,
      args.baseHashes,
      args.serverVersion,
      nerBackend
    );
    // Thread verdicts are independent of NER: one scoring call per
    // thread, whatever its entity state.
    const taxonomy = args.taxonomy ?? CATEGORY_TAXONOMY;
    const catQueue = buildThreadCategoryQueue(
      args.items,
      args.baseThreadCategories,
      taxonomy.map((c) => c.id),
      nliBackend
    );
    this.error = null;
    if (queue.length === 0 && catQueue.length === 0) {
      this.notify();
      return true;
    }
    const id = ++this.runId;
    try {
      this.meterJobId = crypto.randomUUID();
    } catch {
      this.meterJobId = `job-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.status = "running";
    this.phase = queue.length > 0 ? "entities" : "categories";
    this.done = 0;
    this.total = queue.length + catQueue.length;
    this.uuid = args.uuid;
    this.notify();
    void this.loop(id, controller, args, queue, catQueue, taxonomy);
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
    queue: ProcessQueueItem[],
    catQueue: ProcessQueueItem[],
    taxonomy: CategoryDef[]
  ): Promise<void> {
    const alive = () => id === this.runId && this.status === "running";
    const batchSize = args.microBatch ?? MICRO_BATCH;
    let merged: ChatEntityMap = { ...args.baseMap };
    let hashes: ChatEntityHashMap = { ...args.baseHashes };
    let cats: ThreadCategoryMap = { ...args.baseThreadCategories };
    try {
      for (let i = 0; i < queue.length; i += batchSize) {
        if (!alive() || controller.signal.aborted) return;
        const slice = queue.slice(i, i + batchSize);
        const resp = await apiPost(
          "/api/extract-entities-batch",
          {
            items: slice,
            backend: args.nerBackend ?? "local",
            jobId: this.meterJobId,
            isLast: i + batchSize >= queue.length && catQueue.length === 0,
          },
          { signal: controller.signal }
        );
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
            backend: args.nerBackend ?? "local",
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
        // Persist both stores here (not only in the UI): the section may
        // be unmounted while a background run continues, and saving
        // hashes directly while leaving the map to a UI effect desyncs
        // the two under quota — hashes land, the map doesn't, and the
        // count resets on refresh.
        saveChatEntityHashes(args.uuid, hashes);
        saveChatEntities(args.uuid, merged);
        args.onBatch(merged, batchHashes);
        this.done += slice.length;
        this.notify();
      }
      // Phase 2: one verdict per thread. Slice ids are thread keys;
      // server results join back by id, unknown ids are ignored.
      this.phase = "categories";
      this.notify();
      const catBatchSize = args.microBatch ?? CATEGORY_MICRO_BATCH;
      for (let i = 0; i < catQueue.length; i += catBatchSize) {
        if (!alive() || controller.signal.aborted) return;
        const slice = catQueue.slice(i, i + catBatchSize);
        const hashById = new Map(slice.map((s) => [s.id, s.hash]));
        const resp = await apiPost(
          "/api/classify-batch",
          {
            items: slice.map((s) => ({ id: s.id, text: s.text })),
            labels: taxonomy.map((c) => c.id),
            // One category per thread: softmax the labels, don't score
            // each independently.
            multiLabel: false,
            backend: args.nliBackend ?? "local",
            jobId: this.meterJobId,
            isLast: i + catBatchSize >= catQueue.length,
          },
          { signal: controller.signal }
        );
        if (!alive()) return;
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          results?: CategoryBatchResult[];
        };
        if (!alive()) return;
        for (const r of data.results || []) {
          const hash = hashById.get(r.id);
          if (hash === undefined) continue;
          cats[r.id] = {
            hash,
            version: THREAD_CATEGORY_VERSION,
            scores: scoresToCategories(r.scores || {}, taxonomy),
            backend: args.nliBackend ?? "local",
          };
        }
        cats = { ...cats };
        saveThreadCategories(args.uuid, cats);
        args.onCategories(cats);
        this.done += slice.length;
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
