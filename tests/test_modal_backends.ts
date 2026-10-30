import {
  buildModalNerBody,
  buildModalNliBody,
  mapModalEntities,
  mapModalScores,
  normalizeModalResults,
} from "../src/lib/modalBackend";
import {
  chatNeedsProcessing,
  entityTextHash,
} from "../src/lib/entities";
import {
  buildThreadScoringText,
  threadNeedsCategoryScoring,
} from "../src/lib/categoryTags";
import { normalizeModelConfig } from "../src/lib/exportData";
import {
  buildNerInputText,
  buildProcessQueue,
  buildThreadCategoryQueue,
  processRunner,
} from "../src/lib/processRunner";
import type { ParsedActivityItem } from "../src/lib/types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function mkItem(
  id: string,
  prompt: string,
  threadUrl: string | null,
  ts = "2026-10-20T12:00:00.000Z"
): ParsedActivityItem {
  return {
    id,
    timestamp: ts,
    header: "ChatGPT",
    title: prompt,
    cleanTitle: prompt,
    allPromptsText: prompt,
    condensedResponseText: "",
    fullMarkdown: "",
    threadUrl,
    titleUrl: null,
    turns: [{ prompt, responseMarkdown: "ok", responseSummary: "" }],
  } as unknown as ParsedActivityItem;
}

async function runTests() {
  // --- Modal request builders ---
  const nerBody = buildModalNerBody(["hello", "world"]);
  assert(
    Array.isArray(nerBody.texts) &&
      nerBody.texts.join("|") === "hello|world" &&
      Array.isArray(nerBody.categories) &&
      nerBody.categories.length > 0 &&
      Array.isArray(nerBody.exclude_categories) &&
      nerBody.exclude_categories.length === 0 &&
      nerBody.ner_labels.join(",") === "PER,ORG,LOC,MISC,DATE" &&
      nerBody.ner_threshold === 0,
    "NER body sends texts with a placeholder category and no score prefilter"
  );
  const nliBody = buildModalNliBody(["t"], ["finance", "health"], false);
  assert(
    nliBody.texts.join("|") === "t" &&
      nliBody.categories.join("|") === "finance|health" &&
      nliBody.multi_label === false,
    "NLI body sends texts with the caller's labels and mode"
  );

  // --- Modal result mapping ---
  assert(
    normalizeModalResults(
      { results: [{ scores: { a: 1 }, entities: [] }] },
      1
    ) === null &&
      normalizeModalResults([{ scores: {}, entities: [] }], 2) === null &&
      normalizeModalResults([{ scores: {}, entities: [] }], 1)?.length === 1,
    "Modal results reject wrapper/mismatch shapes, accept aligned arrays"
  );
  const mapped = mapModalEntities([
    { text: "Ada Lovelace", label: "PER", score: 0.9 },
    { text: "298-7775", label: "LOC", score: 0.9 },
    { text: "However", label: "PER", score: 0.9 },
    { text: "", label: "ORG", score: 0.5 },
    { text: "OpenAI", label: "ORG", score: NaN },
  ]);
  assert(
    mapped.length === 2 &&
      mapped[0].text === "Ada Lovelace" &&
      mapped[0].label === "PER" &&
      mapped[0].score === 0.9 &&
      mapped[1].text === "OpenAI" &&
      mapped[1].label === "ORG" &&
      mapped[1].score === 0,
    "Modal entities keep typed spans, drop junk, and coerce bad scores"
  );
  const scores = mapModalScores(
    { finance: 0.9, health: Number.NaN },
    ["finance", "health", "travel"]
  );
  assert(
    scores.finance === 0.9 && scores.health === 0 && scores.travel === 0,
    "Modal scores pick requested labels with 0 for missing/non-finite"
  );

  // --- Backend-aware staleness: NER ---
  const h = "abc123";
  assert(
    chatNeedsProcessing({
      hasEntities: true,
      entry: { hash: h, version: 18, backend: "modal" },
      hash: h,
      serverVersion: 1,
      backend: "modal",
    }) === false,
    "current modal NER record is fresh under the modal backend"
  );
  assert(
    chatNeedsProcessing({
      hasEntities: true,
      entry: { hash: h, version: 18, backend: "modal" },
      hash: h,
      serverVersion: 18,
      backend: "local",
    }) === true &&
      chatNeedsProcessing({
        hasEntities: true,
        entry: { hash: h, version: 18 },
        hash: h,
        serverVersion: 1,
        backend: "modal",
      }) === true,
    "switching backends requeues even when text and version match"
  );
  assert(
    chatNeedsProcessing({
      hasEntities: true,
      entry: { hash: h, version: 18 },
      hash: h,
      serverVersion: 18,
    }) === false,
    "legacy records without a backend still read as local"
  );
  assert(
    chatNeedsProcessing({
      hasEntities: true,
      entry: { hash: h, version: 1, backend: "modal-gliner" },
      hash: h,
      serverVersion: 1,
      backend: "modal",
    }) === true &&
      threadNeedsCategoryScoring({
        entry: {
          hash: h,
          version: 3,
          scores: { finance: 1 },
          backend: "modal-bge-m3",
        },
        hash: h,
        taxonomyIds: ["finance"],
        backend: "modal",
      }) === true,
    "pre-XLM modal records reprocess under the modal backend"
  );

  // --- Backend-aware staleness: categories ---
  const catEntry = (backend?: string) => ({
    hash: h,
    version: 3,
    scores: { finance: 1 },
    ...(backend === undefined ? {} : { backend }),
  });
  assert(
    threadNeedsCategoryScoring({
      entry: catEntry("modal"),
      hash: h,
      taxonomyIds: ["finance"],
      backend: "modal",
    }) === false,
    "current modal category verdict is fresh under the modal backend"
  );
  assert(
    threadNeedsCategoryScoring({
      entry: catEntry("modal"),
      hash: h,
      taxonomyIds: ["finance"],
      backend: "local",
    }) === true &&
      threadNeedsCategoryScoring({
        entry: catEntry(undefined),
        hash: h,
        taxonomyIds: ["finance"],
        backend: "modal",
      }) === true,
    "switching NLI backends rescores even when text and version match"
  );

  // --- Config normalization ---
  assert(
    normalizeModelConfig({ nliBackend: "modal" } as never).nliBackend ===
      "modal" &&
      normalizeModelConfig({ nerBackend: "modal" } as never).nerBackend ===
        "modal" &&
      normalizeModelConfig({ nliBackend: "modal-tbd" } as never).nliBackend ===
        "local" &&
      normalizeModelConfig({ nerBackend: "nope" } as never).nerBackend ===
        "local" &&
      normalizeModelConfig({ nerBackend: "modal-gliner" } as never).nerBackend ===
        "modal" &&
      normalizeModelConfig({ nliBackend: "modal-bge-m3" } as never).nliBackend ===
        "modal",
    "config keeps modal, migrates legacy model ids forward, fails the rest to local"
  );

  // --- Runner: backend flows into requests and stamped records ---
  const items = [
    mkItem("c1", "Shopify ads budget?", "thread-a"),
    mkItem("c2", "Annual plan pricing?", "thread-b"),
  ];
  const nerHash1 = entityTextHash(buildNerInputText(items[0]));
  const qLocal = buildProcessQueue(items, {}, {}, 18, "local");
  assert(
    qLocal.length === 2,
    "queue builder defaults keep missing chats queued"
  );
  const qSkip = buildProcessQueue(
    items,
    { c1: [{ name: "x", type: "PER" }], c2: [{ name: "y", type: "ORG" }] },
    {
      c1: { hash: nerHash1, version: 1, backend: "modal" },
      c2: {
        hash: entityTextHash(buildNerInputText(items[1])),
        version: 1,
        backend: "modal",
      },
    },
    1,
    "modal"
  );
  assert(qSkip.length === 0, "queue builder skips modal-current chats");
  const qSwitch = buildProcessQueue(
    items,
    { c1: [{ name: "x", type: "PER" }], c2: [{ name: "y", type: "ORG" }] },
    {
      c1: { hash: nerHash1, version: 1, backend: "modal" },
      c2: {
        hash: entityTextHash(buildNerInputText(items[1])),
        version: 1,
        backend: "modal",
      },
    },
    18,
    "local"
  );
  assert(
    qSwitch.length === 2,
    "queue builder requeues modal records after switching to local"
  );
  const tHashA = entityTextHash(
    buildThreadScoringText([items[0]])
  );
  const cq = buildThreadCategoryQueue(
    items,
    {
      "thread-a": {
        hash: tHashA,
        version: 3,
        scores: { finance: 1 },
        backend: "local",
      },
    },
    ["finance"],
    "modal"
  );
  assert(
    cq.map((q) => q.id).join(",") === "thread-b,thread-a" ||
      cq.map((q) => q.id).join(",") === "thread-a,thread-b",
    "category queue requeues local verdicts after switching NLI backend"
  );

  const realFetch = (globalThis as Record<string, unknown>).fetch;
  const seenBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  (globalThis as Record<string, unknown>).fetch = async (
    url: unknown,
    init?: { body?: unknown }
  ) => {
    const body = JSON.parse(String((init?.body as string) ?? "{}")) as Record<
      string,
      unknown
    >;
    seenBodies.push({ url: String(url), body });
    const bodyItems = (body.items as Array<{ id: string }>) ?? [];
    if (String(url).includes("classify-batch")) {
      return {
        ok: true,
        json: async () => ({
          results: bodyItems.map((it) => ({
            id: it.id,
            scores: { finance: 0.9 },
          })),
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        results: bodyItems.map((it) => ({
          id: it.id,
          entities: [{ text: "X", label: "PER", score: 1 }],
        })),
      }),
    };
  };
  const memStore = new Map<string, string>();
  const realLS = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      memStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStore.delete(k);
    },
  };
  try {
    let lastHashes: Record<string, { backend?: unknown }> = {};
    let lastCats: Record<string, { backend?: unknown }> = {};
    processRunner.start({
      uuid: "u-modal",
      items,
      baseMap: {},
      baseHashes: {},
      baseThreadCategories: {},
      serverVersion: 1,
      nerBackend: "modal",
      nliBackend: "modal",
      taxonomy: [{ id: "finance", label: "Finance", description: "" }],
      onBatch: (_m, bh) => {
        lastHashes = bh as Record<string, { backend?: unknown }>;
      },
      onCategories: (m) => {
        lastCats = m as Record<string, { backend?: unknown }>;
      },
    });
    for (let i = 0; i < 200 && processRunner.isRunning(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const snap = processRunner.getSnapshot();
    const nerCall = seenBodies.find((c) => c.url.includes("extract-entities"));
    const nliCall = seenBodies.find((c) => c.url.includes("classify-batch"));
    assert(
      snap.status === "idle" &&
        snap.error === null &&
        nerCall?.body.backend === "modal" &&
        nliCall?.body.backend === "modal",
      "runner sends the configured backends to both endpoints"
    );
    assert(
      lastHashes.c1?.backend === "modal" &&
        lastCats["thread-a"]?.backend === "modal",
      "runner stamps records with the backend that produced them"
    );
  } finally {
    (globalThis as Record<string, unknown>).fetch = realFetch;
    if (realLS === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      (globalThis as Record<string, unknown>).localStorage = realLS;
    }
  }

  console.log("=== All modal backend tests passed! ===");
}

void runTests();
