import { htmlFragmentToMarkdown, parseChatGptJson, parseTakeoutJson } from "../src/lib/takeoutParser";
import { renderRichText, stripLinkMarkup } from "../src/lib/richText";
import {
  actionItemsDueBetween,
  collectActionItems,
  collectCompletedActionItems,
  ensureActionItemCheckboxes,
  extractActionItems,
  formatDeadlineChip,
  googleCalendarTemplateUrl,
  listChecklistItems,
  parseExplicitDeadline,
  setActionItemDeadline,
  stripActionItemPrefix,
  toggleActionItemInMarkdown,
} from "../src/lib/actionItems";
import {
  IMPORT_SOURCES,
  bucketDayKeys,
  buildDailyStats,
  buildRangeStats,
  countThreadsBySource,
  dataDayBounds,
  filterChatsByEntities,
  filterItemsByEntities,
  filterItemsByRange,
  formatDayRangeLabel,
  formatDuration,
  retitleThreads,
  sourceOfItem,
  threadDurationMs,
  topMentionsByThreads,
  topThreads,
  type RangeBucket,
} from "../src/lib/topOfMind";
import {
  extractUrlsFromText,
  hostOfUrl,
  splitTextWithUrls,
  stripTrailingUrlPunct,
} from "../src/lib/urlPreview";
import { summarizeThreads } from "../src/lib/threads";
import { inDateRange, taggedChatIds, type TagDef } from "../src/lib/tags";
import { aggregateEntities, chatNeedsProcessing, cleanEntityText, entityStorageInfo, entityTextHash, entityTypeLabel, entityTypeRank, filterMentionCandidates, groupNerWords, loadChatEntities, loadChatEntityHashes, nerWordRuns, normalizeEntityKey, projectTextAlnum, recoverSpanText, saveChatEntities, topEntitiesForChatIds, truncateAtWordBoundary, type ChatEntityMap } from "../src/lib/entities";
import {
  buildEntryClassificationText,
  classifySingleTextWithModernBert,
  filterAndRankByTargetContrast,
  normalizeZeroShotBatch,
  packItemsIntoBatches,
} from "../src/lib/retrievalEngine";
import { ParsedActivityItem, RawTakeoutEntry } from "../src/lib/types";
import {
  SYNTHESIS_WARN_BYTES,
  extractionConcurrencyFor,
  formatBytes,
  formatSynthesisWarning,
  mapWithConcurrency,
  planSynthesis,
  retryDelayMs,
  synthesisNeedsConfirm,
} from "../src/lib/synthesize";
import {
  decodeStoredJson,
  encodeCompressedJson,
  getPersistOutcomeVersion,
  lastPersistError,
  setStoredItem,
  subscribePersistOutcome,
} from "../src/lib/compressedJson";
import { SavedSummary } from "../src/lib/savedSummaries";
import JSZip from "jszip";
import {
  buildExportZip,
  exportFileName,
  normalizeModelConfig,
  parseExportZip,
  restoreBackup,
  type ExportPayload,
} from "../src/lib/exportData";
import {
  buildProcessQueue,
  buildThreadCategoryQueue,
  processRunner,
} from "../src/lib/processRunner";
import {
  CATEGORY_LABELS,
  CATEGORY_TAXONOMY,
  THREAD_CATEGORY_VERSION,
  ThreadCategoryMap,
  CategoryId,
  ThreadCategoryRecord,
  buildCategoryScoringText,
  buildThreadScoringText,
  categoryLabelFor,
  loadThreadCategories,
  normalizeThreadCategoryMap,
  saveThreadCategories,
  scoresToCategories,
  threadNeedsCategoryScoring,
  topCategory,
} from "../src/lib/categoryTags";
import { loadTags } from "../src/lib/tags";
import { loadCustomThreadTemplates } from "../src/lib/promptTemplates";
import { loadSavedSummaries } from "../src/lib/savedSummaries";
import { BUILTIN_TEMPLATES } from "../src/lib/promptTemplates";
import {
  encodeHistoriesChunk,
  HISTORIES_CHUNK_SIZE,
  joinHistoriesChunks,
} from "../src/lib/storage";

const FIXTURE_ENTRIES: RawTakeoutEntry[] = [
  {
    header: "AI Mode",
    title: "Searched for how do ad credit match offers work?",
    time: "2026-09-19T01:24:35.383Z",
    products: ["AI Mode"],
    safeHtmlItem: [
      {
        html: "<p><strong>Your prompt:</strong><br>how do ad credit match offers work?</p><p><strong>Search's response:</strong><br>Some ad platforms offer a matching credit once you reach a spend threshold.</p>",
      },
    ],
  },
  {
    header: "AI Mode",
    title: "Searched for carrier package delivery delays",
    time: "2026-09-22T14:59:48.531Z",
    products: ["AI Mode"],
    safeHtmlItem: [
      {
        html: "<p><strong>Your prompt:</strong><br>why is my package delayed at the shipping hub?</p><p><strong>Search's response:</strong><br>Carrier hubs can queue packages for several business days during peak volume.</p>",
      },
    ],
  },
  {
    header: "AI Mode",
    title: "Searched for does pacing burn through daily budgets",
    time: "2026-09-24T19:36:50.723Z",
    products: ["AI Mode"],
    safeHtmlItem: [
      {
        html: "<p><strong>Your prompt:</strong><br>does automated pacing burn through daily ad campaign budgets?</p><p><strong>Search's response:</strong><br>Most ad platforms pace advertising spend across the day instead of spending the whole campaign budget in the morning.</p>",
      },
    ],
  },
  {
    header: "Gemini Apps",
    title: "Prompted paywall conversion follow-up",
    time: "2026-09-30T22:08:40.433Z",
    products: ["Gemini Apps"],
    safeHtmlItem: [
      {
        html: "<p>This is the exact signal you needed. <strong>Fourteen engaged users</strong> repeated the core action, which proves the content is sticky.</p><p>Dropping the free limit exposes the paywall to that same cohort, a large increase in monetization opportunities from the exact same ad spend.</p><p>If just one of those users converts at the paywall, the ad campaign immediately begins paying for itself.</p>",
      },
    ],
  },
];

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Each <li>'s own text (nested sub-lists excluded, block boundaries
 * spaced), mirroring InteractiveSummaryMarkdown's match input without a DOM.
 */
function liOwnTexts(html: string): { text: string; hasBox: boolean }[] {
  const out: { text: string; hasBox: boolean }[] = [];
  const stack: { buf: string; hasBox: boolean }[] = [];
  for (const tok of html.split(/(<[^>]*>)/g)) {
    if (!tok.startsWith("<")) {
      if (stack.length > 0) stack[stack.length - 1].buf += tok;
      continue;
    }
    const tag = tok.slice(1, -1).trim().toLowerCase();
    const name = tag.replace(/^\//, "").split(/[\s/]/)[0];
    if (name === "li" && !tag.startsWith("/")) {
      stack.push({ buf: "", hasBox: false });
    } else if (name === "li") {
      const li = stack.pop();
      if (li) out.push({ text: decodeEntities(li.buf), hasBox: li.hasBox });
    } else if (name === "input" && tag.includes('type="checkbox"')) {
      if (stack.length > 0) stack[stack.length - 1].hasBox = true;
    } else if (
      (tag.startsWith("/") || name === "hr") &&
      ["p", "div", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "hr"].includes(name)
    ) {
      if (stack.length > 0) stack[stack.length - 1].buf += " ";
    }
  }
  return out;
}

function normWired(s: string): string {
  return stripActionItemPrefix(
    stripLinkMarkup(s).replace(/\s+/g, " ").trim()
  ).trim();
}

/**
 * True when every rendered checkbox matches a backing record under the
 * same longest-first predicate the component uses (unmatched boxes render
 * greyed out and disabled).
 */
function renderedBoxesWired(markdown: string, ref: Date): boolean {
  const display = ensureActionItemCheckboxes(markdown, ref);
  const records = listChecklistItems(display, ref);
  const boxes = liOwnTexts(renderRichText(display))
    .filter((li) => li.hasBox)
    .map((li) => normWired(li.text));
  if (boxes.length === 0) return false;
  const used = new Set<number>();
  return boxes.every((t) => {
    let best = -1;
    records.forEach((r, i) => {
      if (used.has(i)) return;
      const rt = normWired(r.text);
      if (!rt || !t) return;
      const follows = t.length === rt.length ? "" : t[rt.length] ?? "";
      if (
        (t === rt || (t.startsWith(rt) && /[\s.]/.test(follows))) &&
        (best === -1 || rt.length > normWired(records[best].text).length)
      ) {
        best = i;
      }
    });
    if (best === -1) return false;
    used.add(best);
    return true;
  });
}

async function runTests() {
  console.log("=== Running Takeout Parser & ModernBERT Target vs. Contrast NLI Tests ===");

  const items = parseTakeoutJson(JSON.stringify(FIXTURE_ENTRIES), "Fixture.json");
  assert(
    items.length === FIXTURE_ENTRIES.length,
    `Parsed all ${items.length} fixture entries cleanly`
  );

  const target_labels = [
    "running ad campaigns, advertising spend, or promotional ad credits",
    "ad targeting, audience subscription tiers, or conversion tracking",
  ];
  const contrast_labels = [
    "publisher website monetization or ad network scripts",
    "software engineering bugs, containers, or server configuration",
    "shipping carriers, package delivery, or everyday errands",
  ];
  const allLabels = [...target_labels, ...contrast_labels];

  const scoresMap = new Map<string, Record<string, number>>();
  for (const item of items) {
    const text = buildEntryClassificationText(item, allLabels);
    const scores = await classifySingleTextWithModernBert(text, allLabels);
    scoresMap.set(item.id, scores);
  }

  const kept = filterAndRankByTargetContrast(
    items,
    scoresMap,
    target_labels,
    contrast_labels,
    0.4
  );

  console.log(
    `Kept ${kept.length} / ${items.length} chats (max_target >= 0.40 && max_target > max_contrast):`
  );
  for (const k of kept) {
    console.log(
      `  - [${k.item.dateStr.slice(0, 10)}] ${k.item.cleanTitle.slice(0, 48)} (maxTarget=${k.maxTargetScore.toFixed(3)}, maxContrast=${k.maxContrastScore.toFixed(3)})`
    );
  }

  const keptTitles = kept.map((k) => k.item.cleanTitle);

  assert(
    keptTitles.some((t) => t.includes("ad credit match")),
    "Kept ad-credit research chat"
  );
  assert(
    keptTitles.some((t) => t.includes("pacing burn")),
    "Kept budget pacing chat"
  );
  assert(
    keptTitles.some((t) => t.includes("paywall conversion")),
    "Kept paywall conversion follow-up chat"
  );
  assert(
    !keptTitles.some((t) => t.includes("carrier package")),
    "Filtered out unrelated shipping chat (max_contrast > max_target)"
  );

  const zsBatch = normalizeZeroShotBatch(
    [
      { labels: ["a", "b"], scores: [0.9, 0.1] },
      { labels: ["a", "b"], scores: [0.2, 0.8] },
    ],
    2
  );
  assert(
    zsBatch !== null &&
      zsBatch.length === 2 &&
      zsBatch[0].a === 0.9 &&
      zsBatch[1].b === 0.8,
    "normalizeZeroShotBatch maps one score map per input, in order"
  );
  const zsSingle = normalizeZeroShotBatch(
    { labels: ["a"], scores: [0.5] },
    1
  );
  assert(
    zsSingle !== null &&
      zsSingle.length === 1 &&
      zsSingle[0].a === 0.5 &&
      normalizeZeroShotBatch([], 0)?.length === 0,
    "normalizeZeroShotBatch accepts single and empty outputs"
  );
  assert(
    normalizeZeroShotBatch([{ labels: ["a"], scores: [1] }], 2) === null &&
      normalizeZeroShotBatch({ labels: ["a"], scores: [1] }, 3) === null,
    "normalizeZeroShotBatch rejects shape mismatches so callers fall back"
  );

  const packed = packItemsIntoBatches(
    kept.map((r) => r.item),
    45000
  );
  assert(
    packed.batches.length === 1 &&
      packed.batches[0].includes("USER PROMPT (VERBATIM)"),
    "Asymmetric context packer preserves verbatim user prompts"
  );

  console.log("=== Tag helper tests ===");

  const tagFixture: TagDef = {
    id: "tag-test",
    name: "paid acquisition",
    description: "test",
    targetLabels: ["paid ads"],
    contrastLabels: ["shipping"],
    dateStart: null,
    dateEnd: null,
    scores: {
      a: { t: 0.9, c: 0.1 }, // keep
      b: { t: 0.4, c: 0.1 }, // keep (>= threshold)
      c: { t: 0.39, c: 0.1 }, // drop: below threshold
      d: { t: 0.9, c: 0.95 }, // drop: contrast wins
      e: { t: 0.5, c: 0.5 }, // drop: must strictly beat contrast
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };

  const tagged = taggedChatIds(tagFixture, 0.4);
  assert(
    tagged.length === 2 && tagged[0] === "a" && tagged[1] === "b",
    "taggedChatIds keeps only chats with t >= threshold and t > c, ranked by t"
  );
  const retagged = taggedChatIds(tagFixture, 0.9);
  assert(
    retagged.length === 1 && retagged[0] === "a",
    "Raising the threshold retags instantly from stored scores"
  );

  const dated = [
    { id: "x", timestamp: "2026-09-19T01:24:35.383Z" },
    { id: "y", timestamp: "2026-09-22T14:59:48.531Z" },
    { id: "z", timestamp: "2026-09-24T19:36:50.723Z" },
    { id: "w", timestamp: "" },
  ];
  assert(
    inDateRange(dated, "2026-09-20", "2026-09-24").map((d) => d.id).join(",") === "y,z,w",
    "inDateRange keeps chats inside the inclusive window (undated chats are kept)"
  );
  assert(
    inDateRange(dated, null, null).length === 4,
    "inDateRange with null bounds keeps everything"
  );
  assert(
    inDateRange(dated, "2026-10-01", null).map((d) => d.id).join(",") === "w",
    "inDateRange with only a start bound keeps undated chats"
  );

  const entityMap: ChatEntityMap = {
    c1: [{ name: "Google", type: "ORG" }, { name: "Paris", type: "LOC" }],
    c2: [{ name: "google", type: "ORG" }, { name: "Paris", type: "LOC" }],
    c3: [{ name: "Google", type: "ORG" }, { name: "Paris", type: "LOC" }],
    c4: [{ name: "Google", type: "ORG" }, { name: "Paris", type: "LOC" }],
    c5: [{ name: "Google", type: "ORG" }, { name: "7", type: "MISC" }],
  };
  const agg = aggregateEntities(entityMap, 3);
  const keys = agg.map((a) => a.key);
  assert(
    keys.includes("google") && keys.includes("paris"),
    "aggregateEntities keeps entities in more than 3 different chats, merging case variants"
  );
  assert(
    !keys.includes("7"),
    "aggregateEntities drops junk entities (single char / numeric)"
  );
  const google = agg.find((a) => a.key === "google")!;
  assert(
    google.chatCount === 5 && google.display === "Google" && google.type === "ORG",
    "aggregateEntities counts distinct chats and picks the most frequent form/type"
  );
  assert(
    aggregateEntities({ c1: [{ name: "Solo", type: "PER" }] }, 3).length === 0,
    "aggregateEntities drops entities in 3 or fewer chats"
  );
  assert(
    cleanEntityText("San Fran ##cisco") === "San Francisco" &&
      cleanEntityText("My ##ho ##ros") === "Myhoros",
    "cleanEntityText strips WordPiece ## continuation markers"
  );
  const subwordMap: ChatEntityMap = {
    c1: [{ name: "San Fran ##cisco", type: "LOC" }],
    c2: [{ name: "San Francisco", type: "LOC" }],
    c3: [{ name: "San Francisco", type: "LOC" }],
    c4: [{ name: "San Francisco", type: "LOC" }],
  };
  const sub = aggregateEntities(subwordMap, 3);
  assert(
    sub.length === 1 && sub[0].key === "san francisco" && sub[0].chatCount === 4,
    "aggregateEntities merges ##-split forms with their clean form"
  );
  const scoredMap: ChatEntityMap = {
    c1: [
      { name: "Sure Thing", type: "PER", score: 0.99 },
      { name: "Maybe Not", type: "PER", score: 0.42 },
      { name: "Legacy Span", type: "ORG" },
    ],
    c2: [
      { name: "Sure Thing", type: "PER", score: 0.97 },
      { name: "Maybe Not", type: "PER", score: 0.51 },
      { name: "Legacy Span", type: "ORG" },
    ],
  };
  assert(
    aggregateEntities(scoredMap, 0, 0.9).map((a) => a.key).join(",") ===
      "sure thing" &&
      aggregateEntities(scoredMap, 0, 0).length === 3,
    "aggregateEntities floor drops low-confidence and unscored spans only"
  );
  assert(
    topEntitiesForChatIds(["c1", "c2"], scoredMap, 5, 0.9).map((a) => a.key).join(",") ===
      "sure thing",
    "topEntitiesForChatIds passes the score floor through"
  );
  const needs = (entry: unknown, hasEntities = true, hash = "h1", serverVersion: number | null = 6) =>
    chatNeedsProcessing({ hasEntities, entry, hash, serverVersion });
  assert(
    needs(undefined, false) === true &&
      needs(undefined) === true &&
      needs({ hash: "other", version: 6 }) === true &&
      needs("h1") === true &&
      needs({ hash: "h1", version: 5 }) === true &&
      needs({ hash: "h1", version: 6 }) === false &&
      needs({ hash: "h1", version: 5 }, true, "h1", null) === false,
    "chatNeedsProcessing requeues missing, changed, legacy, or outdated chats only"
  );

  const cxMap: ChatEntityMap = {
    c1: [
      { name: "Ada Lovelace", type: "PER" },
      { name: "Paris", type: "LOC" },
    ],
    c2: [{ name: "Ada Lovelace", type: "PER" }],
    c3: [{ name: "OpenAI", type: "ORG" }],
  };
  const cxAll = aggregateEntities(cxMap, 0);
  const cxHits = filterMentionCandidates(cxAll, "a");
  assert(
    cxHits.length === 3 && cxHits[0].display === "Ada Lovelace",
    "filterMentionCandidates matches substrings keeping rank order"
  );
  const cxEx = filterMentionCandidates(cxAll, "a", [cxAll[0].key]);
  assert(
    cxEx.length === 2 && !cxEx.some((c) => c.display === "Ada Lovelace"),
    "filterMentionCandidates excludes already-picked keys"
  );
  assert(
    filterMentionCandidates(cxAll, "zzz").length === 0 &&
      filterMentionCandidates(cxAll, "  ").length === 0 &&
      filterMentionCandidates(cxAll, "a", [], 2).length === 2,
    "filterMentionCandidates blanks on no match, caps results"
  );

  // Real bert-base-NER output shape for "MYHOROS.COM": the "##Y" (idx 10)
  // and "." (idx 14) come back O-tagged and are omitted. Word-atomic spans
  // must recover the exact source text, not the fabricated "MHOROS COM".
  const rawTokens = [
    { entity: "B-ORG", score: 0.96, index: 9, word: "M" },
    { entity: "I-ORG", score: 0.98, index: 11, word: "##H" },
    { entity: "I-ORG", score: 0.96, index: 12, word: "##OR" },
    { entity: "I-ORG", score: 0.97, index: 13, word: "##OS" },
    { entity: "I-ORG", score: 0.88, index: 15, word: "CO" },
    { entity: "I-ORG", score: 0.64, index: 16, word: "##M" },
  ];
  const surfaces = ["[CLS]", "the", "my", "##hor", "##os", "acquisition", "strategy", "for", "the", "M", "##Y", "##H", "##OR", "##OS", ".", "CO", "##M", "website", "[SEP]"];
  const source = "the myhoros acquisition strategy for the MYHOROS.COM website";
  const proj = projectTextAlnum(source);
  const groups = groupNerWords(nerWordRuns(surfaces, rawTokens));
  assert(
    groups.length === 1 && groups[0].type === "ORG" && groups[0].lo === 9 && groups[0].hi === 16,
    "groupNerWords merges the brand mention into one whole-word span"
  );
  assert(
    recoverSpanText(source, proj, surfaces, groups[0].lo, groups[0].hi) === "MYHOROS.COM",
    "recoverSpanText recovers the exact source span with punctuation"
  );

  // "Xiaoyin Qu": mid-word type flip (I-ORG 0.43 on "##n") must not split the
  // word, and trailing O-tagged "##u" must be absorbed: no "Xiaoyi Q".
  const quTokens = [
    { entity: "B-PER", score: 0.97, index: 1, word: "Xiao" },
    { entity: "I-PER", score: 0.82, index: 2, word: "##yi" },
    { entity: "I-ORG", score: 0.43, index: 3, word: "##n" },
    { entity: "I-PER", score: 0.97, index: 4, word: "Q" },
  ];
  const quSurfaces = ["[CLS]", "Xiao", "##yi", "##n", "Q", "##u", "updated", "[SEP]"];
  const quSource = "Xiaoyin Qu updated";
  const quGroups = groupNerWords(nerWordRuns(quSurfaces, quTokens));
  assert(
    quGroups.length === 1 && quGroups[0].type === "PER",
    "groupNerWords keeps a word with a noisy mid-word tag flip as one PER entity"
  );
  assert(
    recoverSpanText(quSource, projectTextAlnum(quSource), quSurfaces, quGroups[0].lo, quGroups[0].hi) === "Xiaoyin Qu",
    "word-atomic spans recover trailing fragments: Xiaoyin Qu, not Xiaoyi Q"
  );

  // "funko": trailing O-tagged "##o" is absorbed into the word, not dropped.
  const funTokens = [{ entity: "B-MISC", score: 0.9, index: 3, word: "funk" }];
  const funSurfaces = ["[CLS]", "I", "collect", "funk", "##o", "figures", "[SEP]"];
  const funSource = "I collect funko figures";
  const funGroups = groupNerWords(nerWordRuns(funSurfaces, funTokens));
  assert(
    funGroups.length === 1 &&
      recoverSpanText(funSource, projectTextAlnum(funSource), funSurfaces, funGroups[0].lo, funGroups[0].hi) === "funko",
    "word-atomic spans recover trailing fragments: funko, not funk"
  );
  const funWord = nerWordRuns(funSurfaces, funTokens).find((w) => w.lo === 3)!;
  const quWord = nerWordRuns(quSurfaces, quTokens).find((w) => w.lo === 1)!;
  const soloWord = nerWordRuns(
    ["[CLS]", "Paris", "[SEP]"],
    [{ entity: "B-LOC", score: 0.99, index: 1 }]
  ).find((w) => w.lo === 1)!;
  assert(
    funWord.type === "MISC" &&
      Math.abs(funWord.score - 0.45) < 1e-9 &&
      quWord.type === "PER" &&
      Math.abs(quWord.score - (0.97 + 0.82) / 3) < 1e-9 &&
      Math.abs(soloWord.score - 0.99) < 1e-9,
    "word scores average fragment support: untagged and disagreeing siblings dampen lone votes"
  );

  // XLM-RoBERTa (markerless BPE) output shape, copied from the real quantized
  // pipeline: per-id decodes carry no ## markers, so "Ber"+"ke"+"ley" group
  // by source-text adjacency while "," splits on its punctuation boundary.
  const spTokens = [
    { entity: "B-PER", score: 0.9996, index: 4, word: "Clara" },
    { entity: "I-PER", score: 0.9997, index: 5, word: "Os" },
    { entity: "I-PER", score: 0.9996, index: 6, word: "wald" },
    { entity: "B-LOC", score: 0.999, index: 11, word: "Ber" },
    { entity: "I-LOC", score: 0.9953, index: 12, word: "ke" },
    { entity: "I-LOC", score: 0.9976, index: 13, word: "ley" },
    { entity: "B-LOC", score: 0.9995, index: 15, word: "California" },
  ];
  const spSurfaces = ["<s>", "My", "name", "is", "Clara", "Os", "wald", "and", "I", "live", "in", "Ber", "ke", "ley", ",", "California", ".", "</s>"];
  const spSource = "My name is Clara Oswald and I live in Berkeley, California.";
  const spProj = projectTextAlnum(spSource);
  const spGroups = groupNerWords(nerWordRuns(spSurfaces, spTokens, spSource));
  assert(
    spGroups.length === 3 &&
      spGroups[0].type === "PER" &&
      recoverSpanText(spSource, spProj, spSurfaces, spGroups[0].lo, spGroups[0].hi) === "Clara Oswald" &&
      recoverSpanText(spSource, spProj, spSurfaces, spGroups[1].lo, spGroups[1].hi) === "Berkeley" &&
      recoverSpanText(spSource, spProj, spSurfaces, spGroups[2].lo, spGroups[2].hi) === "California",
    "markerless BPE runs recover multi-fragment words: Clara Oswald, Berkeley, California"
  );

  // Markerless analog of "funko": an untagged mid-word fragment is absorbed
  // and dampens the word score instead of truncating the span.
  const spTokens2 = [
    { entity: "B-LOC", score: 0.99, index: 11, word: "Ber" },
    { entity: "I-LOC", score: 0.99, index: 13, word: "ley" },
  ];
  const spGroups2 = groupNerWords(nerWordRuns(spSurfaces, spTokens2, spSource));
  const spWord = nerWordRuns(spSurfaces, spTokens2, spSource).find((w) => w.lo === 11)!;
  assert(
    spGroups2.length === 1 &&
      recoverSpanText(spSource, spProj, spSurfaces, spGroups2[0].lo, spGroups2[0].hi) === "Berkeley" &&
      Math.abs(spWord.score - (0.99 + 0.99) / 3) < 1e-9,
    "markerless runs absorb untagged mid-word fragments: Berkeley, not Ber"
  );

  // RoBERTa (byte-level BPE) output shape: per-id decodes carry Ġ
  // word-start markers (except possibly the text-initial word), so runs
  // break before Ġ, unmarked fragments ("ke", "ley", ",") glue onto the
  // open word, and recovery strips Ġ before matching source text.
  const rbSource = "Clara Oswald visited Berkeley, CA";
  const rbSurfaces = ["<s>", "Clara", "ĠOswald", "Ġvisited", "ĠBer", "ke", "ley", ",", "ĠCA", "</s>"];
  const rbTokens = [
    { entity: "B-PER", score: 0.99, index: 1, word: "Clara" },
    { entity: "I-PER", score: 0.98, index: 2, word: "ĠOswald" },
    { entity: "B-LOC", score: 0.97, index: 4, word: "ĠBer" },
    { entity: "I-LOC", score: 0.96, index: 5, word: "ke" },
    { entity: "I-LOC", score: 0.95, index: 6, word: "ley" },
    { entity: "B-LOC", score: 0.9, index: 8, word: "ĠCA" },
  ];
  const rbProj = projectTextAlnum(rbSource);
  const rbWords = nerWordRuns(rbSurfaces, rbTokens, rbSource);
  const rbGroups = groupNerWords(rbWords);
  assert(
    rbWords.length === 5 &&
      rbWords[3].lo === 4 &&
      rbWords[3].hi === 7 &&
      rbWords[3].text === "berkeley,",
    "RoBERTa runs break on Ġ and glue unmarked fragments onto the open word"
  );
  assert(
    rbGroups.length === 2 &&
      rbGroups[0].type === "PER" &&
      rbGroups[0].lo === 1 &&
      rbGroups[0].hi === 2 &&
      recoverSpanText(rbSource, rbProj, rbSurfaces, rbGroups[0].lo, rbGroups[0].hi) === "Clara Oswald" &&
      rbGroups[1].type === "LOC" &&
      recoverSpanText(rbSource, rbProj, rbSurfaces, rbGroups[1].lo, rbGroups[1].hi) === "Berkeley, CA",
    "RoBERTa spans recover across Ġ fragments: Clara Oswald, Berkeley, CA"
  );
  // Single-word texts carry no Ġ at all: grouping falls back to
  // source-text adjacency instead of degrading.
  const rbSoloWords = nerWordRuns(
    ["<s>", "Clara", "</s>"],
    [{ entity: "B-PER", score: 1, index: 1 }],
    "Clara"
  );
  assert(
    rbSoloWords.length === 1 &&
      rbSoloWords[0].type === "PER" &&
      recoverSpanText(
        "Clara",
        projectTextAlnum("Clara"),
        ["<s>", "Clara", "</s>"],
        rbSoloWords[0].lo,
        rbSoloWords[0].hi
      ) === "Clara",
    "RoBERTa single-word input without Ġ still groups by adjacency"
  );

  assert(
    entityTypeLabel("DATE") === "Dates" &&
      entityTypeRank("DATE") === 4 &&
      entityTypeRank("ZZZ") === 5,
    "DATE entities label and rank after the core types"
  );

  assert(
    recoverSpanText("nothing related here", proj, surfaces, 9, 16) === null,
    "recoverSpanText returns null when the span cannot be located"
  );

  // Closing brackets are absorbed so names never end up unbalanced.
  const parenSurfaces = ["[CLS]", "San", "Francisco", "(", "CA", ")", "is", "nice", "[SEP]"];
  const parenSource = "San Francisco (CA) is nice";
  const parenProj = projectTextAlnum(parenSource);
  assert(
    recoverSpanText(parenSource, parenProj, parenSurfaces, 1, 4) === "San Francisco (CA)",
    "recoverSpanText absorbs the closing paren into the span"
  );
  assert(
    recoverSpanText(parenSource, parenProj, parenSurfaces, 4, 5) === "CA",
    "recoverSpanText leaves clean bracket-free names alone even when brackets are tagged"
  );
  assert(
    recoverSpanText("San Francisco (CA is nice", projectTextAlnum("San Francisco (CA is nice"), parenSurfaces, 1, 4) === "San Francisco (CA",
    "recoverSpanText leaves genuinely unbalanced source text alone"
  );
  assert(
    recoverSpanText(parenSource, parenProj, parenSurfaces, 1, 2) === "San Francisco",
    "recoverSpanText leaves bracket-free names untouched"
  );
  assert(
    truncateAtWordBoundary("spending money on ads", 8) === "spending",
    "truncateAtWordBoundary backs off to the previous space instead of leaving a dangling fragment"
  );
  assert(
    truncateAtWordBoundary("short", 100) === "short",
    "truncateAtWordBoundary leaves short text untouched"
  );
  const farSurfaces = [...surfaces];
  while (farSurfaces.length <= 40) farSurfaces.push("pad");
  farSurfaces[40] = "Ann";
  const split = groupNerWords(
    nerWordRuns(farSurfaces, [
      ...rawTokens,
      { entity: "B-PER", score: 0.9, index: 40, word: "Ann" },
    ])
  );
  assert(
    split.length === 2 && split[1].type === "PER",
    "groupNerWords splits on large gaps and type changes"
  );

  // "Braden Hi Braden": a real untagged word between same-type mentions
  // splits the group — greetings must not fuse mentions into phantom entities.
  const bradenSurfaces = ["[CLS]", "to", "Braden", "Hi", "Braden", ",", "how", "[SEP]"];
  const bradenSource = "to Braden Hi Braden, how";
  const bradenTokens = [
    { entity: "B-PER", score: 0.99, index: 2, word: "Braden" },
    { entity: "B-PER", score: 0.98, index: 4, word: "Braden" },
  ];
  const bradenGroups = groupNerWords(nerWordRuns(bradenSurfaces, bradenTokens));
  const bradenProj = projectTextAlnum(bradenSource);
  assert(
    bradenGroups.length === 2 &&
      recoverSpanText(bradenSource, bradenProj, bradenSurfaces, bradenGroups[0].lo, bradenGroups[0].hi) === "Braden" &&
      recoverSpanText(bradenSource, bradenProj, bradenSurfaces, bradenGroups[1].lo, bradenGroups[1].hi) === "Braden",
    "groupNerWords splits same-type mentions joined by a real word"
  );

  // Bare conjunctions split; conjunctions inside comma-separated lists merge.
  const conjSurfaces = ["[CLS]", "Apple", "and", "Microsoft", "[SEP]"];
  const conjTokens = [
    { entity: "B-ORG", score: 0.99, index: 1, word: "Apple" },
    { entity: "B-ORG", score: 0.99, index: 3, word: "Microsoft" },
  ];
  assert(
    groupNerWords(nerWordRuns(conjSurfaces, conjTokens)).length === 2,
    "groupNerWords does not merge across a bare conjunction"
  );
  const listSurfaces = ["[CLS]", "Max", ",", "Alex", ",", "and", "Teo", "[SEP]"];
  const listSource = "Max, Alex, and Teo went hiking";
  const listTokens = [
    { entity: "B-PER", score: 0.99, index: 1, word: "Max" },
    { entity: "B-PER", score: 0.99, index: 3, word: "Alex" },
    { entity: "B-PER", score: 0.99, index: 6, word: "Teo" },
  ];
  const listGroups = groupNerWords(nerWordRuns(listSurfaces, listTokens));
  const listProj = projectTextAlnum(listSource);
  assert(
    listGroups.length === 3 &&
      listGroups.map((g) => recoverSpanText(listSource, listProj, listSurfaces, g.lo, g.hi)).join("|") === "Max|Alex|Teo",
    "groupNerWords splits person coordinations into distinct entities"
  );

  // Places are the exception: "City, ST" reads as one reference.
  const placeSurfaces = ["[CLS]", "Sunnyvale", ",", "CA", "[SEP]"];
  const placeSource = "Sunnyvale, CA";
  const placeTokens = [
    { entity: "B-LOC", score: 0.99, index: 1, word: "Sunnyvale" },
    { entity: "B-LOC", score: 0.99, index: 3, word: "CA" },
  ];
  const placeGroups = groupNerWords(nerWordRuns(placeSurfaces, placeTokens));
  assert(
    placeGroups.length === 1 &&
      recoverSpanText(placeSource, projectTextAlnum(placeSource), placeSurfaces, placeGroups[0].lo, placeGroups[0].hi) === "Sunnyvale, CA",
    "groupNerWords keeps City, ST places as one entity"
  );

  // ...but distinct place enumerations still split, as do org lists.
  const citiesSurfaces = ["[CLS]", "Paris", ",", "London", "[SEP]"];
  const citiesTokens = [
    { entity: "B-LOC", score: 0.99, index: 1, word: "Paris" },
    { entity: "B-LOC", score: 0.99, index: 3, word: "London" },
  ];
  assert(
    groupNerWords(nerWordRuns(citiesSurfaces, citiesTokens)).length === 2,
    "groupNerWords splits place enumerations that are not qualifiers"
  );
  const orgSurfaces = ["[CLS]", "USPS", ",", "FedEx", "[SEP]"];
  const orgTokens = [
    { entity: "B-ORG", score: 0.99, index: 1, word: "USPS" },
    { entity: "B-ORG", score: 0.99, index: 3, word: "FedEx" },
  ];
  assert(
    groupNerWords(nerWordRuns(orgSurfaces, orgTokens)).length === 2,
    "groupNerWords splits org coordinations into distinct entities"
  );

  // Hyphen-joined names recover whole: trailing ("SP-API") and leading
  // ("state-of-the-art") fragments, but not spaced hyphens.
  const hySurfaces = ["[CLS]", "use", "SP", "-", "API", "daily", "[SEP]"];
  const hySource = "use SP-API daily";
  assert(
    recoverSpanText(hySource, projectTextAlnum(hySource), hySurfaces, 2, 2) === "SP-API",
    "recoverSpanText absorbs hyphen-joined suffixes"
  );
  const leadSurfaces = ["[CLS]", "a", "state", "-", "of", "-", "the", "-", "art", "[SEP]"];
  const leadSource = "a state-of-the-art model";
  assert(
    recoverSpanText(leadSource, projectTextAlnum(leadSource), leadSurfaces, 8, 8) === "state-of-the-art",
    "recoverSpanText absorbs hyphen-joined prefixes"
  );
  assert(
    recoverSpanText("Apple - Microsoft", projectTextAlnum("Apple - Microsoft"), ["[CLS]", "Apple", "-", "Microsoft", "[SEP]"], 1, 1) === "Apple",
    "recoverSpanText does not cross spaced hyphens"
  );
  const dotSurfaces = ["[CLS]", "San", "Francisco", ".", "CA", "[SEP]"];
  const dotTokens = [
    { entity: "B-LOC", score: 0.99, index: 1, word: "San" },
    { entity: "I-LOC", score: 0.99, index: 2, word: "Francisco" },
    { entity: "B-LOC", score: 0.99, index: 4, word: "CA" },
  ];
  assert(
    groupNerWords(nerWordRuns(dotSurfaces, dotTokens)).length === 1,
    "groupNerWords still merges across punctuation gaps"
  );

  assert(
    entityTextHash("hello world") === entityTextHash("hello world") &&
      entityTextHash("hello world") !== entityTextHash("hello world!"),
    "entityTextHash is stable and changes with the text"
  );

  // Threads cluster globally by source link (even non-adjacent resumes),
  // unlinked chats are skipped, titles come from the oldest prompt.
  const t = (id: string, key: string | null, ts: string, prompt = "hello") =>
    ({
      id,
      threadUrl: key ?? undefined,
      timestamp: ts,
      turns: [{ prompt, responseMarkdown: "", responseSummary: "", extractedEntities: [] }],
    } as unknown as ParsedActivityItem);
  const summaries = summarizeThreads([
    t("a", "https://x/thread/1", "2026-03-03T10:00:00Z", "first question"),
    t("b", null, "2026-03-04T10:00:00Z"),
    t("c", "https://x/thread/2", "2026-03-05T10:00:00Z", "other topic"),
    t("d", "https://x/thread/1", "2026-03-09T10:00:00Z", "follow-up later"),
  ]);
  assert(
    summaries.length === 2,
    "summarizeThreads groups by thread across dates and skips unlinked chats"
  );
  const th1 = summaries.find((s) => s.key === "https://x/thread/1")!;
  assert(
    th1.count === 2 &&
      th1.title === "first question" &&
      th1.startIso < th1.endIso &&
      th1.chats[0].id === "a",
    "summarizeThreads titles from the oldest prompt and orders chats oldest-first"
  );
  assert(
    summaries[0].endIso >= summaries[1].endIso,
    "summarizeThreads sorts threads by most recent activity"
  );

  // Block-level tags must break lines: stripping <div> with "" glued
  // "...to Braden</div><div>Hi Braden," into the phantom token "BradenHi".
  const divGlued = htmlFragmentToMarkdown(
    "<div>Final Suggested Reply to Braden</div><div>Hi Braden,</div>"
  );
  assert(
    divGlued === "Final Suggested Reply to Braden\n\nHi Braden,",
    "htmlFragmentToMarkdown keeps block-level line breaks instead of gluing words"
  );
  const spanGlued = htmlFragmentToMarkdown("<span>Open</span><span>Code</span>");
  assert(
    spanGlued === "OpenCode",
    "htmlFragmentToMarkdown still glues inline spans (no break implied)"
  );

  // === URL trailing punctuation: message text stays verbatim ===

  const lumaPrompt =
    "If you haven't, please register your attendance through https://luma.com/b1ii8quj. We will use your same email.";
  const chatgptJson = JSON.stringify({
    conversations: [
      {
        title: "Event registration",
        create_time: 1763730000,
        mapping: {
          u: {
            message: {
              author: { role: "user" },
              content: { content_type: "text", parts: [lumaPrompt] },
              create_time: 1763730000,
            },
          },
          a: {
            message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Registered."] },
              create_time: 1763730060,
            },
          },
        },
      },
    ],
  });
  const chatgptItems = parseChatGptJson(chatgptJson);
  assert(
    chatgptItems.length === 1 &&
      chatgptItems[0].turns[0].prompt === lumaPrompt,
    "parseChatGptJson preserves message text verbatim (full stop after URL kept)"
  );

  const lumaHtml = renderRichText(lumaPrompt);
  assert(
    lumaHtml.includes('href="https://luma.com/b1ii8quj"') &&
      !lumaHtml.includes('href="https://luma.com/b1ii8quj."'),
    "renderRichText excludes the sentence full stop from the URL href"
  );
  assert(
    /<\/a>\. We will use/.test(lumaHtml),
    "renderRichText keeps the full stop in the message text, right after the link"
  );
  assert(
    lumaHtml.includes('data-link-preview="chip"') &&
      lumaHtml.includes("data-url-chip-icon") &&
      lumaHtml.includes("data-url-chip-label") &&
      lumaHtml.includes(">luma.com</span>"),
    "renderRichText bare URLs render as sneak-peek pill chips (favicon + host label)"
  );

  const mdLinkHtml = renderRichText("[Guide](https://example.com/guide) here");
  assert(
    mdLinkHtml.includes('href="https://example.com/guide"') &&
      mdLinkHtml.includes('data-link-preview="chip"') &&
      mdLinkHtml.includes(">Guide</span>"),
    "renderRichText markdown links render as pills keeping their custom label"
  );
  const mdBoldLinkHtml = renderRichText("[**Bold**](https://example.com/b)");
  assert(
    mdBoldLinkHtml.includes("<strong") && !mdBoldLinkHtml.includes("**"),
    "renderRichText pill labels format emphasis instead of showing raw markers"
  );

  const dashHtml = renderRichText("- top item");
  assert(
    dashHtml.includes("<ul>") && dashHtml.includes("<li>top item</li>"),
    "renderRichText renders dash bullets"
  );

  const dotHtml = renderRichText("• dotted item");
  assert(
    dotHtml.includes("<ul>") && dotHtml.includes("<li>dotted item</li>"),
    "renderRichText renders • bullets as list items"
  );

  const boldParaHtml = renderRichText("**Bold line**");
  assert(
    boldParaHtml.includes("<strong>Bold line</strong>") &&
      !boldParaHtml.includes("<ul>"),
    "renderRichText keeps **bold** paragraphs out of bullet lists"
  );

  const starSubHtml = renderRichText("- parent\n** child");
  assert(
    (starSubHtml.match(/<ul>/g) || []).length === 2 &&
      starSubHtml.includes("<li>child</li>") &&
      !starSubHtml.includes("**"),
    "renderRichText renders ** lines as nested sub-bullets"
  );

  const indentSubHtml = renderRichText("- parent\n  - nested child");
  assert(
    (indentSubHtml.match(/<ul>/g) || []).length === 2 &&
      indentSubHtml.includes("<li>nested child</li>"),
    "renderRichText renders indented dashes as nested sub-bullets"
  );

  const numberedHtml = renderRichText("1. first\n2. second");
  assert(
    numberedHtml.includes("<ol>") &&
      numberedHtml.includes("<li>first</li>") &&
      numberedHtml.includes("<li>second</li>"),
    "renderRichText renders numbered lists"
  );

  const tableHtml = renderRichText("| A | B |\n|---|---|\n| 1 | 2 |");
  assert(
    tableHtml.includes("<table>") &&
      tableHtml.includes("<th>A</th>") &&
      tableHtml.includes("<td>2</td>"),
    "renderRichText renders GFM tables"
  );

  const unsafeHtml = renderRichText('<script>alert("x")</script>');
  assert(
    !unsafeHtml.includes("<script>") && unsafeHtml.includes("&lt;script&gt;"),
    "renderRichText escapes raw HTML"
  );

  const rawAnchorHtml = renderRichText(
    'Go <a href="https://example.com/a">here</a> now'
  );
  assert(
    rawAnchorHtml.includes('data-link-preview="chip"') &&
      rawAnchorHtml.includes(">here</span>"),
    "renderRichText restores raw anchors as chips"
  );

  const wwwHtml = renderRichText("see www.example.com/a next");
  assert(
    wwwHtml.includes('href="http://www.example.com/a"') &&
      wwwHtml.includes("data-url-chip-label"),
    "renderRichText upgrades bare www links to title chips"
  );

  assert(
    stripTrailingUrlPunct("https://x.com/a.") === "https://x.com/a" &&
      stripTrailingUrlPunct("https://x.com/a") === "https://x.com/a" &&
      stripTrailingUrlPunct("https://x.com/a!?.;") === "https://x.com/a",
    "stripTrailingUrlPunct strips only trailing sentence punctuation"
  );

  assert(
    JSON.stringify(
      extractUrlsFromText("go https://a.com/x. and https://a.com/x plus https://b.com/y! ok")
    ) === JSON.stringify(["https://a.com/x", "https://b.com/y"]),
    "extractUrlsFromText strips trailing punctuation and dedupes"
  );

  assert(
    hostOfUrl("https://www.luma.com/x") === "luma.com" &&
      hostOfUrl("not a url") === "",
    "hostOfUrl derives the host and strips www"
  );

  assert(
    JSON.stringify(
      splitTextWithUrls("go https://a.com/x. and https://b.com/y! ok")
    ) ===
      JSON.stringify([
        { kind: "text", text: "go " },
        { kind: "url", url: "https://a.com/x", trail: "." },
        { kind: "text", text: " and " },
        { kind: "url", url: "https://b.com/y", trail: "!" },
        { kind: "text", text: " ok" },
      ]),
    "splitTextWithUrls keeps URL positions with trailing punctuation outside the href"
  );

  assert(
    JSON.stringify(splitTextWithUrls("no links here")) ===
      JSON.stringify([{ kind: "text", text: "no links here" }]),
    "splitTextWithUrls returns plain text untouched when there are no URLs"
  );

  // === Top of Mind aggregations ===

  const mkItem = (
    id: string,
    timestamp: string,
    threadUrl: string | undefined,
    header: string,
    prompt: string
  ): ParsedActivityItem =>
    ({
      id,
      timestamp,
      threadUrl,
      header,
      products: [header],
      turns: [{ prompt, responseMarkdown: "", responseSummary: "" }],
    } as unknown as ParsedActivityItem);

  // Local-noon timestamps: deterministic under any machine timezone.
  const isoDaysAgo = (n: number): string =>
    new Date(2026, 9, 24 - n, 12, 0, 0).toISOString();
  const refNow = new Date(2026, 9, 24, 18, 0, 0);

  assert(
    sourceOfItem(mkItem("x", isoDaysAgo(0), "t", "ChatGPT", "p")) === "ChatGPT" &&
      sourceOfItem(mkItem("x", isoDaysAgo(0), "t", "Gemini Apps", "p")) === "Gemini" &&
      sourceOfItem(mkItem("x", isoDaysAgo(0), "t", "AI Mode", "p")) === "AI Mode" &&
      sourceOfItem(mkItem("x", isoDaysAgo(0), "t", "Obsidian Note", "p")) === "Obsidian" &&
      sourceOfItem(mkItem("x", isoDaysAgo(0), "t", "Something Else", "p")) === "Other",
    "sourceOfItem normalizes import sources"
  );

  const trendItems = [
    mkItem("c-today-1", isoDaysAgo(0), "thread-a", "ChatGPT", "today one"),
    mkItem("c-today-2", isoDaysAgo(0), "thread-b", "ChatGPT", "today two"),
    mkItem("c-yday", isoDaysAgo(1), "thread-a", "Gemini Apps", "yesterday"),
    mkItem("c-edge", isoDaysAgo(13), "thread-c", "AI Mode", "edge of window"),
    mkItem("c-old", isoDaysAgo(14), "thread-c", "AI Mode", "outside window"),
    mkItem("c-bad", "", "thread-c", "AI Mode", "no timestamp"),
  ];
  const daily = buildDailyStats(trendItems, refNow, 14);
  assert(
    daily.length === 14 &&
      daily[0].totalChats === 1 &&
      daily[13].totalChats === 2,
    "buildDailyStats returns 14 oldest-first buckets ending today"
  );
  assert(
    daily[13].chatsBySource.ChatGPT === 2 &&
      daily[12].chatsBySource.Gemini === 1 &&
      daily[13].totalThreads === 2 &&
      daily[12].totalThreads === 1,
    "buildDailyStats splits chats by source and counts distinct daily threads"
  );
  assert(
    daily[0].threadsBySource["AI Mode"] === 1 &&
      daily.every((d) => d.totalChats >= d.totalThreads),
    "buildDailyStats attributes threads to their earliest-chat source"
  );

  const threadItems = [
    mkItem("t1-a", isoDaysAgo(3), "thread-long", "ChatGPT", "long thread"),
    mkItem("t1-b", isoDaysAgo(1), "thread-long", "ChatGPT", "long reply"),
    mkItem("t2-a", isoDaysAgo(0), "thread-solo", "ChatGPT", "solo chat"),
  ];
  const threadSums = summarizeThreads(threadItems);
  assert(
    threadDurationMs(threadSums.find((t) => t.key === "thread-long")!) ===
      2 * 24 * 3600 * 1000,
    "threadDurationMs spans first to last chat of the thread"
  );
  assert(
    topThreads(threadSums, "duration")[0].key === "thread-long" &&
      topThreads(threadSums, "chats")[0].key === "thread-long",
    "topThreads ranks the longest, chattiest thread first in both modes"
  );
  assert(
    formatDuration(0) === "0m" &&
      formatDuration(45 * 60000) === "45m" &&
      formatDuration(5 * 3600000) === "5h" &&
      formatDuration((3 * 24 + 4) * 3600000) === "3d 4h",
    "formatDuration compacts milliseconds to m/h/d"
  );

  const mentionItems = [
    mkItem("m1", isoDaysAgo(2), "thread-m1", "ChatGPT", "alice twice"),
    mkItem("m2", isoDaysAgo(1), "thread-m1", "ChatGPT", "alice again"),
    mkItem("m3", isoDaysAgo(0), "thread-m2", "ChatGPT", "alice elsewhere"),
    mkItem("m4", isoDaysAgo(0), undefined, "ChatGPT", "keyless bob"),
  ];
  const mentionMap: ChatEntityMap = {
    m1: [
      { name: "Alice", type: "PER" },
      { name: "alice", type: "PER" },
      { name: "Paris", type: "LOC" },
    ],
    m2: [{ name: "Alice", type: "PER" }],
    m3: [
      { name: "Alice", type: "PER" },
      { name: "Acme", type: "ORG" },
    ],
    m4: [{ name: "Bob", type: "PER" }],
  };
  const people = topMentionsByThreads(mentionMap, mentionItems, "PER");
  assert(
    people.length === 1 &&
      people[0].display === "Alice" &&
      people[0].threadCount === 2,
    "topMentionsByThreads counts one per thread however many chats mention it"
  );
  const places = topMentionsByThreads(mentionMap, mentionItems, "LOC");
  assert(
    places.length === 1 &&
      places[0].display === "Paris" &&
      places[0].threadCount === 1,
    "topMentionsByThreads filters by NER type"
  );
  const orgs = topMentionsByThreads(mentionMap, mentionItems, "ORG");
  assert(
    orgs.length === 1 && orgs[0].display === "Acme",
    "topMentionsByThreads finds organizations"
  );

  // === Date-range helpers ===

  const rangeItems = [
    mkItem("r1", isoDaysAgo(40), "thread-r", "ChatGPT", "old"),
    mkItem("r2", isoDaysAgo(5), "thread-r", "ChatGPT", "mid"),
    mkItem("r3", isoDaysAgo(0), "thread-r", "ChatGPT", "new"),
    mkItem("r-bad", "", "thread-r", "ChatGPT", "dateless"),
  ];
  const bounds = dataDayBounds(rangeItems);
  assert(
    bounds !== null &&
      bounds.minKey === "2026-09-14" &&
      bounds.maxKey === "2026-10-24",
    "dataDayBounds spans earliest to latest chat day"
  );
  assert(
    dataDayBounds([]) === null &&
      dataDayBounds([mkItem("x", "", "t", "ChatGPT", "p")]) === null,
    "dataDayBounds is null without dated chats"
  );

  const filtered = filterItemsByRange(rangeItems, "2026-10-01", "2026-10-24");
  assert(
    filtered.length === 2 &&
      filtered.every((it) => it.id === "r2" || it.id === "r3"),
    "filterItemsByRange keeps only in-window chats"
  );

  const short = buildRangeStats(rangeItems, "2026-10-20", "2026-10-24");
  assert(
    short.granularity === "day" &&
      short.buckets.length === 5 &&
      short.buckets[4].totalChats === 1 &&
      short.buckets[0].totalChats === 0,
    "buildRangeStats buckets short ranges daily"
  );
  const long = buildRangeStats(rangeItems, "2026-09-14", "2026-10-24");
  assert(
    long.granularity === "week" &&
      long.buckets.length === 6 &&
      long.buckets.reduce((n, b) => n + b.totalChats, 0) === 3,
    "buildRangeStats buckets long ranges weekly without losing chats"
  );
  const wide = buildRangeStats(rangeItems, "2025-09-20", "2026-10-24");
  assert(
    wide.granularity === "fortnight" &&
      wide.buckets.length <= 31 &&
      wide.buckets.reduce((n, b) => n + b.totalChats, 0) === 3,
    "buildRangeStats coarsens very long ranges to keep bars readable"
  );
  // thread-dupe is active Oct 20 AND Oct 21 (same week bucket): the merged
  // bucket must count it once while both chats still sum.
  const dupeItems = [
    mkItem("d1", isoDaysAgo(4), "thread-dupe", "ChatGPT", "day one"),
    mkItem("d2", isoDaysAgo(3), "thread-dupe", "ChatGPT", "day two"),
    mkItem("d3", isoDaysAgo(3), "thread-solo", "Gemini Apps", "other"),
  ];
  const merged = buildRangeStats(dupeItems, "2026-09-14", "2026-10-24");
  const dupeBucket = merged.buckets.find((b) => {
    const { startKey, endKey } = bucketDayKeys(b);
    return startKey <= "2026-10-20" && endKey >= "2026-10-21";
  });
  assert(
    merged.granularity === "week" &&
      dupeBucket !== undefined &&
      dupeBucket.totalChats === 3 &&
      dupeBucket.totalThreads === 2 &&
      dupeBucket.threadsBySource.ChatGPT === 1 &&
      dupeBucket.threadsBySource.Gemini === 1,
    "buildRangeStats unions threads on merge: a two-day thread counts once per bucket while chats sum"
  );
  // thread-cross starts in ChatGPT and continues in Gemini: the legend
  // attributes it once (oldest chat) and sums to the thread count.
  const legendItems = [
    mkItem("l1", isoDaysAgo(10), "thread-cross", "ChatGPT", "starts here"),
    mkItem("l2", isoDaysAgo(1), "thread-cross", "Gemini Apps", "continues"),
    mkItem("l3", isoDaysAgo(0), "thread-g", "Gemini Apps", "gemini only"),
  ];
  const legendSums = summarizeThreads(legendItems);
  const legendCounts = countThreadsBySource(legendSums);
  assert(
    legendSums.length === 2 &&
      legendCounts.ChatGPT === 1 &&
      legendCounts.Gemini === 1 &&
      IMPORT_SOURCES.reduce((n, s) => n + legendCounts[s], 0) ===
        legendSums.length,
    "countThreadsBySource counts each thread once under its oldest chat so the legend reconciles with the subtitle"
  );
  // e2 shares thread-hit with e1 but mentions nothing: expansion must keep
  // it anyway. e4 is a keyless direct hit; e3/e5 match nothing.
  const expItems = [
    mkItem("e1", isoDaysAgo(2), "thread-hit", "ChatGPT", "alice here"),
    mkItem("e2", isoDaysAgo(1), "thread-hit", "ChatGPT", "no entity here"),
    mkItem("e3", isoDaysAgo(0), "thread-miss", "ChatGPT", "nothing"),
    mkItem("e4", isoDaysAgo(0), undefined, "ChatGPT", "keyless alice"),
    mkItem("e5", isoDaysAgo(0), undefined, "ChatGPT", "keyless nothing"),
  ];
  const expMap: ChatEntityMap = {
    e1: [{ name: "Alice", type: "PER" }],
    e4: [{ name: "Alice", type: "PER" }],
  };
  const aliceKey = normalizeEntityKey("Alice");
  const expanded = filterItemsByEntities(expItems, expMap, [aliceKey]);
  assert(
    expanded.length === 3 &&
      expanded.some((it) => it.id === "e1") &&
      expanded.some((it) => it.id === "e2") &&
      expanded.some((it) => it.id === "e4"),
    "filterItemsByEntities keeps whole hit threads plus keyless hits, drops the rest"
  );
  const expMap2: ChatEntityMap = {
    ...expMap,
    e3: [{ name: "Bob", type: "PER" }],
  };
  const expandedOr = filterItemsByEntities(expItems, expMap2, [
    aliceKey,
    normalizeEntityKey("Bob"),
  ]);
  assert(
    expandedOr.length === 4 &&
      expandedOr.every((it) => it.id !== "e5") &&
      filterItemsByEntities(expItems, expMap2, []).length === 0,
    "filterItemsByEntities matches ANY of several entities and selects nothing for no keys"
  );
  // Chat-level mirror: e2 shares the hit thread but mentions nothing, so
  // the chats page drops it while keeping the direct hits.
  const chatLevel = filterChatsByEntities(expItems, expMap, [aliceKey]);
  assert(
    chatLevel.length === 2 &&
      chatLevel.some((it) => it.id === "e1") &&
      chatLevel.some((it) => it.id === "e4"),
    "filterChatsByEntities keeps only chats that mention the entity"
  );
  // Tiny token budget forces one batch per chat; the production budget
  // packs the same chats into a single small batch.
  const bigPlan = planSynthesis(expItems, 1);
  const smallPlan = planSynthesis(expItems, 1e9);
  assert(
    bigPlan.batchCount === expItems.length &&
      bigPlan.totalBytes > 0 &&
      bigPlan.totalTokens === smallPlan.totalTokens &&
      smallPlan.batchCount === 1,
    "planSynthesis reports batch count, bytes, and tokens up front"
  );
  assert(
    synthesisNeedsConfirm(bigPlan) === true &&
      synthesisNeedsConfirm(smallPlan) === false &&
      synthesisNeedsConfirm({
        batches: ["x"],
        batchCount: 1,
        totalBytes: SYNTHESIS_WARN_BYTES,
        totalTokens: 1,
      }) === false &&
      synthesisNeedsConfirm({
        batches: ["x"],
        batchCount: 1,
        totalBytes: SYNTHESIS_WARN_BYTES + 1,
        totalTokens: 1,
      }) === true,
    "synthesisNeedsConfirm fires on multi-batch runs or >512KB singles"
  );
  assert(
    formatBytes(2875 * 1024) === "2.8 MB" &&
      formatBytes(960 * 1024) === "960 KB" &&
      formatBytes(512) === "512 B",
    "formatBytes compacts byte counts to B/KB/MB"
  );
  const warnPlan = {
    batches: ["a", "b", "c"],
    batchCount: 3,
    totalBytes: 2875 * 1024,
    totalTokens: 720000,
  };
  assert(
    formatSynthesisWarning(warnPlan) ===
      "Large selection: ~2.8 MB in 3 requests (~720K tokens). This may take several minutes." &&
      formatSynthesisWarning(warnPlan, { noun: "thread" }).startsWith(
        "Large thread: ~2.8 MB in 3 requests"
      ) &&
      formatSynthesisWarning(
        { batches: ["a"], batchCount: 1, totalBytes: 600 * 1024, totalTokens: 150000 },
        { tip: "Narrow it." }
      ) ===
        "Large selection: ~600 KB in 1 request (~150K tokens). This may take several minutes. Narrow it.",
    "formatSynthesisWarning states real size, requests, and tokens"
  );
  // Varying delays finish out of order; results must still line up with
  // inputs while never exceeding 2 in flight.
  let inFlight = 0;
  let maxInFlight = 0;
  const ordered = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms, i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return `r${i}`;
  });
  const emptyPool = await mapWithConcurrency([], 3, async () => 1);
  assert(
    ordered.join(",") === "r0,r1,r2,r3" &&
      maxInFlight === 2 &&
      emptyPool.length === 0,
    "mapWithConcurrency keeps input order and caps in-flight work"
  );
  assert(
    extractionConcurrencyFor("muse-spark-1.3-contributor") === 3 &&
      extractionConcurrencyFor("muse-spark-1.2-contributor") === 3 &&
      extractionConcurrencyFor("muse-spark-1.3") === 4 &&
      extractionConcurrencyFor("muse-wonder-1.0") === 4,
    "extraction fan-out follows the model's rate-limit tier"
  );
  const backoff0 = retryDelayMs(0, null);
  const backoff1 = retryDelayMs(1, null);
  assert(
    backoff0 >= 500 &&
      backoff0 < 1000 &&
      backoff1 >= 1000 &&
      backoff1 < 1500 &&
      retryDelayMs(0, 5) === 5000 &&
      retryDelayMs(2, 1) >= 2000,
    "retryDelayMs doubles 500ms with jitter and honors Retry-After"
  );

  const spanItems = [
    mkItem("span-old", isoDaysAgo(60), "thread-span", "ChatGPT", "very first"),
    mkItem("span-new", isoDaysAgo(1), "thread-span", "ChatGPT", "recent reply"),
  ];
  const rangedOnly = summarizeThreads([spanItems[1]]);
  const retitled = retitleThreads(rangedOnly, summarizeThreads(spanItems));
  assert(
    rangedOnly[0].title === "recent reply" &&
      retitled[0].title === "very first",
    "retitleThreads restores the whole-thread first chat as title"
  );

  // === Action items from saved summaries ===

  const actionMd = [
    "# Weekly Review",
    "",
    "## Open Questions & Next Actions",
    "- Ship the report by 2026-11-05",
    "- [ ] Call Alice before Oct 30",
    "- [x] Done thing Oct 1",
    "- Plain follow-up without date",
    "",
    "## Actions & Troubleshooting Timeline",
    "- Attempt 1: restarted server Oct 2",
    "",
    "- [ ] Top-level task due October 12, 2026",
    "",
    "- **Next Steps**",
    "  - Nested subtask",
  ].join("\n");
  assert(
    JSON.stringify(extractActionItems(actionMd)) ===
      JSON.stringify([
        "Ship the report by 2026-11-05",
        "Call Alice before Oct 30",
        "Plain follow-up without date",
        "Top-level task due October 12, 2026",
        "Nested subtask",
      ]),
    "extractActionItems finds checkboxes and action-section bullets only"
  );

  const refDate = new Date(2026, 9, 24, 12, 0, 0);
  assert(
    parseExplicitDeadline("Ship it by 2026-11-05", refDate) === "2026-11-05" &&
      parseExplicitDeadline("Call before Oct 30", refDate) === "2026-10-30" &&
      parseExplicitDeadline("Due October 12, 2026", refDate) === "2026-10-12" &&
      parseExplicitDeadline("Kick off Jan 5", refDate) === "2027-01-05" &&
      parseExplicitDeadline("Meet Feb 30", refDate) === null &&
      parseExplicitDeadline("No date here", refDate) === null,
    "parseExplicitDeadline reads ISO and month-name dates with year rollover"
  );
  assert(
    parseExplicitDeadline("From Oct 1 to Oct 30", refDate) === "2026-10-30",
    "parseExplicitDeadline prefers the date near a deadline keyword"
  );

  const summaryA = {
    id: "s1",
    createdAt: "2026-10-20T00:00:00.000Z",
    title: "Thread A",
    markdown: "## Next Actions\n- Late item by 2026-11-05\n- Undated item",
    threads: [{ key: "thread-a", title: "Thread A" }],
  } as unknown as SavedSummary;
  const summaryB = {
    id: "s2",
    createdAt: "2026-10-21T00:00:00.000Z",
    title: "Thread B",
    markdown: "- [ ] Early item due Oct 28",
    threads: [],
  } as unknown as SavedSummary;
  const ranked = collectActionItems([summaryA, summaryB], refDate);
  assert(
    ranked.length === 3 &&
      ranked[0].text === "Early item due Oct 28" &&
      ranked[0].deadline === "2026-10-28" &&
      ranked[0].threadKey === null &&
      ranked[1].deadline === "2026-11-05" &&
      ranked[1].threadKey === "thread-a" &&
      ranked[2].deadline === null,
    "collectActionItems ranks dated first, undated after"
  );

  const labeled = {
    id: "s3",
    createdAt: "2026-10-22T00:00:00.000Z",
    title: "Thread C",
    markdown: [
      "## Next Actions",
      "- Verify the symbolic link",
      "- Deadline: 2026-08-16",
      "- Action: Test container execution",
      "- Deadline: next session",
    ].join("\n"),
    threads: [{ key: "thread-c", title: "Thread C" }],
  } as unknown as SavedSummary;
  const assembled = collectActionItems([labeled], refDate);
  assert(
    assembled.length === 2 &&
      assembled[0].text === "Verify the symbolic link" &&
      assembled[0].deadline === "2026-08-16" &&
      assembled[1].text === "Test container execution" &&
      assembled[1].deadline === null &&
      assembled[1].deadlineText === "next session",
    "collectActionItems attaches Deadline lines and strips Action prefixes"
  );

  const templateFmt = {
    id: "s4",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread D",
    markdown: [
      "## Action Items",
      "- [ ] Ship the report. Deadline: 2026-11-05.",
      "- [ ] Review the draft. Deadline: Before next upgrade.",
      "- [ ] Optional polish. Deadline: None.",
    ].join("\n"),
    threads: [{ key: "thread-d", title: "Thread D" }],
  } as unknown as SavedSummary;
  const templated = collectActionItems([templateFmt], refDate);
  assert(
    templated.length === 3 &&
      templated[0].text === "Ship the report." &&
      templated[0].deadline === "2026-11-05" &&
      templated[1].text === "Review the draft." &&
      templated[1].deadline === null &&
      templated[1].deadlineText === "Before next upgrade" &&
      templated[2].text === "Optional polish." &&
      templated[2].deadline === null &&
      templated[2].deadlineText === null,
    "collectActionItems splits trailing Deadline values incl. text and None"
  );

  const boiler = {
    id: "s5",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread E",
    markdown: [
      "## Action Items",
      "- [ ] Add Reminder to Google Calendar",
      "- [ ] Add a reminder to Google Calendar.",
      "- [ ] Add Q3 review to Google Calendar",
      "- [ ] Ship the report",
    ].join("\n"),
    threads: [],
  } as unknown as SavedSummary;
  const deBoilered = collectActionItems([boiler], refDate);
  assert(
    deBoilered.length === 2 &&
      deBoilered.some((a) => a.text === "Add Q3 review to Google Calendar") &&
      deBoilered.some((a) => a.text === "Ship the report"),
    "collectActionItems drops generic reminder boilerplate, keeps real calendar tasks"
  );

  const calLink = {
    id: "s6",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread F",
    markdown: [
      "## Action Items",
      "- [ ] [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Verify+Signal-CLI&dates=20260814T100000Z/20260814T110000Z)",
      "- [ ] [Add to Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=x)",
      "- Action: [Add Reminder to Google Calendar](https://example.com/other)",
      "- [ ] Read the [release notes](https://example.com/notes)",
    ].join("\n"),
    threads: [],
  } as unknown as SavedSummary;
  const delinked = collectActionItems([calLink], refDate);
  assert(
    delinked.length === 1 &&
      delinked[0].text ===
        "Read the [release notes](https://example.com/notes)",
    "collectActionItems drops bare reminder/calendar-link bullets, keeps linked tasks"
  );

  const toggleMd = [
    "## Action Items",
    "- [ ] Ship the report. Deadline: 2026-11-05.",
    "- Action: Test container execution",
    "- Verify the symbolic link",
    "- [x] Already done",
  ].join("\n");
  const tSum = {
    id: "s7",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread G",
    markdown: toggleMd,
    threads: [],
  } as unknown as SavedSummary;
  const openBefore = collectActionItems([tSum], refDate);
  const doneBefore = collectCompletedActionItems([tSum], refDate);
  assert(
    openBefore.length === 3 &&
      !openBefore.some((a) => a.text === "Already done") &&
      doneBefore.length === 1 &&
      doneBefore[0].text === "Already done",
    "completed boxes live in collectCompletedActionItems, not the open list"
  );

  const ship = openBefore.find((a) => a.text === "Ship the report.");
  assert(!!ship, "toggle fixture finds the Ship item");
  const flipped = toggleActionItemInMarkdown(toggleMd, ship!, true, refDate);
  assert(
    flipped.includes("- [x] Ship the report. Deadline: 2026-11-05."),
    "toggling done flips the matching checkbox line"
  );
  const flippedSum = { ...tSum, markdown: flipped } as SavedSummary;
  const openAfter = collectActionItems([flippedSum], refDate);
  const doneAfter = collectCompletedActionItems([flippedSum], refDate);
  const shipDone = doneAfter.find((a) => a.text === "Ship the report.");
  assert(
    !openAfter.some((a) => a.text === "Ship the report.") &&
      !!shipDone &&
      shipDone.deadline === "2026-11-05",
    "done items leave the open list keeping their deadline"
  );
  assert(
    toggleActionItemInMarkdown(flipped, shipDone!, false, refDate) ===
      toggleMd,
    "toggling open restores the markdown byte-identical"
  );

  const verify = openBefore.find(
    (a) => a.text === "Verify the symbolic link"
  );
  assert(!!verify, "toggle fixture finds the plain-bullet item");
  const vDone = toggleActionItemInMarkdown(toggleMd, verify!, true, refDate);
  assert(
    vDone.includes("- [x] Verify the symbolic link"),
    "toggling done converts plain bullets to checked boxes"
  );
  const vDoneItem = collectCompletedActionItems(
    [{ ...tSum, markdown: vDone } as SavedSummary],
    refDate
  ).find((a) => a.text === "Verify the symbolic link");
  assert(
    !!vDoneItem &&
      toggleActionItemInMarkdown(vDone, vDoneItem, false, refDate).includes(
        "- [ ] Verify the symbolic link"
      ),
    "toggling open converts back to an unchecked box"
  );
  assert(
    toggleActionItemInMarkdown(
      toggleMd,
      { text: "No such task", deadline: null, deadlineText: null },
      true,
      refDate
    ) === toggleMd,
    "toggling an unknown item leaves the markdown untouched"
  );

  const attachedMd = [
    "## Next Actions",
    "- Verify the symbolic link",
    "- Deadline: 2026-08-16",
  ].join("\n");
  const aSum = {
    id: "s8",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread H",
    markdown: attachedMd,
    threads: [],
  } as unknown as SavedSummary;
  const attachedOpen = collectActionItems([aSum], refDate);
  assert(
    attachedOpen.length === 1 &&
      attachedOpen[0].text === "Verify the symbolic link" &&
      attachedOpen[0].deadline === "2026-08-16",
    "attached-deadline fixture assembles one dated item"
  );
  const aDone = toggleActionItemInMarkdown(
    attachedMd,
    attachedOpen[0],
    true,
    refDate
  );
  assert(
    aDone.includes("- [x] Verify the symbolic link") &&
      aDone.includes("- [x] Deadline: 2026-08-16"),
    "toggling done flips the item and its attached Deadline line"
  );
  const aDoneSum = { ...aSum, markdown: aDone } as SavedSummary;
  const aOpenAfter = collectActionItems([aDoneSum], refDate);
  const aDoneAfter = collectCompletedActionItems([aDoneSum], refDate);
  assert(
    aOpenAfter.length === 0 &&
      aDoneAfter.length === 1 &&
      aDoneAfter[0].text === "Verify the symbolic link" &&
      aDoneAfter[0].deadline === "2026-08-16",
    "completing leaves no orphan Deadline row and keeps the deadline"
  );
  const aReopen = toggleActionItemInMarkdown(
    aDone,
    aDoneAfter[0],
    false,
    refDate
  );
  const aOpenAgain = collectActionItems(
    [{ ...aSum, markdown: aReopen } as SavedSummary],
    refDate
  );
  assert(
    aOpenAgain.length === 1 &&
      aOpenAgain[0].text === "Verify the symbolic link" &&
      aOpenAgain[0].deadline === "2026-08-16",
    "reopening restores the attached deadline"
  );

  const dlMd = [
    "## Action Items",
    "- [ ] Ship it",
    "- [ ] Review it. Deadline: Next session.",
    "- [ ] Polish it. Deadline: None.",
    "- [x] Done thing",
  ].join("\n");
  const dlSum = {
    id: "s10",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread J",
    markdown: dlMd,
    threads: [],
  } as unknown as SavedSummary;
  const dlOpen = collectActionItems([dlSum], refDate, Infinity);
  const shipIt = dlOpen.find((a) => a.text === "Ship it");
  assert(!!shipIt, "deadline fixture finds the undated item");
  const withDate = setActionItemDeadline(dlMd, shipIt!, "2026-11-05", refDate);
  assert(
    withDate.includes("- [ ] Ship it. Deadline: 2026-11-05."),
    "setActionItemDeadline appends a trailing deadline"
  );
  const repinned = collectActionItems(
    [{ ...dlSum, markdown: withDate } as SavedSummary],
    refDate,
    Infinity
  ).find((a) => a.text === "Ship it.");
  assert(
    repinned?.deadline === "2026-11-05",
    "pinned deadlines re-parse as explicit dates"
  );
  const reviewIt = dlOpen.find((a) => a.text === "Review it.");
  assert(!!reviewIt, "deadline fixture finds the text-deadline item");
  const replaced = setActionItemDeadline(
    dlMd,
    reviewIt!,
    "2026-11-06",
    refDate
  );
  assert(
    replaced.includes("- [ ] Review it. Deadline: 2026-11-06."),
    "setActionItemDeadline replaces a text deadline"
  );
  const followMd = [
    "## Next Actions",
    "- Verify links",
    "- Deadline: next session",
  ].join("\n");
  const followSum = {
    id: "s11",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread K",
    markdown: followMd,
    threads: [],
  } as unknown as SavedSummary;
  const followItem = collectActionItems([followSum], refDate, Infinity)[0];
  assert(
    followItem?.text === "Verify links" &&
      followItem.deadline === null &&
      followItem.deadlineText === "next session",
    "deadline fixture assembles the attached text deadline"
  );
  const followSet = setActionItemDeadline(
    followMd,
    followItem!,
    "2026-11-07",
    refDate
  );
  assert(
    followSet.split("\n")[1] === "- Verify links" &&
      followSet.includes("- Deadline: 2026-11-07."),
    "setActionItemDeadline rewrites the attached Deadline line"
  );
  const doneThing = collectCompletedActionItems([dlSum], refDate).find(
    (a) => a.text === "Done thing"
  );
  assert(!!doneThing, "deadline fixture finds the completed item");
  assert(
    setActionItemDeadline(dlMd, doneThing!, "2026-11-08", refDate).includes(
      "- [x] Done thing. Deadline: 2026-11-08."
    ),
    "setActionItemDeadline preserves the checkbox state"
  );
  assert(
    setActionItemDeadline(
      dlMd,
      { text: "No such task", deadline: null, deadlineText: null },
      "2026-11-05",
      refDate
    ) === dlMd &&
      setActionItemDeadline(dlMd, shipIt!, "soon", refDate) === dlMd,
    "setActionItemDeadline leaves markdown untouched without match or date"
  );

  const calDated = new URL(
    googleCalendarTemplateUrl({
      text: "Ship the report",
      deadline: "2026-11-05",
      deadlineText: null,
      summaryTitle: "Weekly",
    })
  );
  assert(
    calDated.hostname === "calendar.google.com" &&
      calDated.searchParams.get("action") === "TEMPLATE" &&
      calDated.searchParams.get("text") === "Ship the report" &&
      calDated.searchParams.get("dates") === "20261105/20261106" &&
      (calDated.searchParams.get("details") ?? "").includes("Weekly"),
    "googleCalendarTemplateUrl prefills title, all-day deadline span, source"
  );

  const calText = new URL(
    googleCalendarTemplateUrl({
      text: "Review the draft",
      deadline: null,
      deadlineText: "Next session",
      summaryTitle: "Weekly",
    })
  );
  assert(
    calText.searchParams.get("dates") === null &&
      (calText.searchParams.get("details") ?? "").includes("Next session"),
    "googleCalendarTemplateUrl keeps text deadlines in details without dates"
  );

  const dayBucket = {
    start: new Date(2026, 9, 20, 12),
    end: new Date(2026, 9, 20, 12),
  } as RangeBucket;
  const dayKeys = bucketDayKeys(dayBucket);
  assert(
    dayKeys.startKey === "2026-10-20" && dayKeys.endKey === "2026-10-20",
    "bucketDayKeys formats single-day buckets"
  );
  const weekBucket = {
    start: new Date(2026, 9, 12, 12),
    end: new Date(2026, 9, 18, 12),
  } as RangeBucket;
  const weekKeys = bucketDayKeys(weekBucket);
  assert(
    weekKeys.startKey === "2026-10-12" && weekKeys.endKey === "2026-10-18",
    "bucketDayKeys formats multi-day buckets"
  );

  const singleLabel = formatDayRangeLabel("2026-10-20", "2026-10-20");
  const sameYearLabel = formatDayRangeLabel("2026-10-12", "2026-10-20");
  const crossYearLabel = formatDayRangeLabel("2025-12-30", "2026-01-02");
  assert(
    !singleLabel.includes("–") &&
      singleLabel.includes("20") &&
      singleLabel.includes("2026") &&
      sameYearLabel.includes("–") &&
      sameYearLabel.includes("2026") &&
      crossYearLabel.includes("2025") &&
      crossYearLabel.includes("2026"),
    "formatDayRangeLabel renders single days and same/cross-year ranges"
  );

  const dueSum = {
    id: "s9",
    createdAt: "2026-10-23T00:00:00.000Z",
    title: "Thread I",
    markdown: [
      "## Action Items",
      "- [ ] Late item. Deadline: 2026-10-25.",
      "- [ ] Early item. Deadline: 2026-10-18.",
      "- [ ] Phrased item. Deadline: Next session.",
    ].join("\n"),
    threads: [],
  } as unknown as SavedSummary;
  const duePool = collectActionItems([dueSum], refDate, Infinity);
  const dueNarrow = actionItemsDueBetween(duePool, "2026-10-18", "2026-10-20");
  assert(
    dueNarrow.length === 1 && dueNarrow[0].text === "Early item.",
    "actionItemsDueBetween keeps dated items in range, drops phrases"
  );
  const dueWide = actionItemsDueBetween(duePool, "2026-10-18", "2026-10-25");
  assert(
    dueWide.length === 2 &&
      dueWide[0].text === "Early item." &&
      dueWide[1].text === "Late item.",
    "actionItemsDueBetween sorts by deadline"
  );

  const chipOutYear = formatDeadlineChip("2099-11-05");
  assert(
    chipOutYear.includes("5") && chipOutYear.includes("99"),
    "formatDeadlineChip renders day and out-of-year dates"
  );

  assert(
    exportFileName("abc123") === "extbrain_abc123.zip",
    "exportFileName uses the extbrain_userid.zip shape"
  );
  const exportFixture: ExportPayload = {
    userid: "u1",
    exportedAt: "2026-10-24T00:00:00.000Z",
    histories: [{ id: "c1", turns: [] }],
    fileNames: ["takeout.json"],
    summaries: [
      {
        id: "s1",
        createdAt: "2026-10-24T00:00:00.000Z",
        templateId: "t1",
        templateName: "T",
        title: "S",
        abstract: "A",
        markdown: "# hi",
        threads: [],
        tags: [],
        chatCount: 1,
      },
    ],
    tags: [
      {
        id: "t1",
        name: "Tag",
        description: "D",
        targetLabels: [],
        contrastLabels: [],
        dateStart: null,
        dateEnd: null,
        scores: {},
        createdAt: "2026-10-24T00:00:00.000Z",
        completedAt: null,
      },
    ],
    entities: { c1: [{ name: "Ada", type: "PER" }] },
    categories: {
      "thread-a": {
        hash: "h1",
        version: 1,
        scores: {
          productivity: 0.9,
          finance: 0,
          social: 0,
          entertainment: 0,
          health: 0,
          travel: 0,
          utilities: 0,
          education: 0,
        },
      },
    },
    templates: [
      {
        id: "ct1",
        name: "Custom",
        badge: "Custom",
        description: "D",
        systemInstruction: "Do it.",
      },
    ],
    modelConfig: {
      useSameModel: true,
      discovery: { provider: "meta", model: "muse-spark-1.3" },
      synthesis: { provider: "meta", model: "muse-wonder-1.0" },
      maxTokensPerSynthesisBatch: 45000,
      zeroShotThreshold: 0.4,
    },
  };
  const exportBlob = await buildExportZip(exportFixture);
  const exportZip = await JSZip.loadAsync(exportBlob);
  const exportFiles = Object.keys(exportZip.files).sort();
  assert(
    JSON.stringify(exportFiles) ===
      JSON.stringify(
        [
          "thread-categories.json",
          "custom-templates.json",
          "entities.json",
          "histories.json",
          "manifest.json",
          "model-config.json",
          "summaries.json",
          "tags.json",
        ].sort()
      ),
    "buildExportZip packs every store plus a manifest"
  );
  const manifest = JSON.parse(
    await (exportZip.file("manifest.json")?.async("string") ?? "{}")
  );
  assert(
    manifest.userid === "u1" &&
      manifest.counts?.histories === 1 &&
      manifest.counts?.summaries === 1 &&
      manifest.counts?.categories === 1 &&
      Array.isArray(manifest.fileNames),
    "export manifest records the user, counts, and source files"
  );
  const exportedConfig = JSON.parse(
    await (exportZip.file("model-config.json")?.async("string") ?? "{}")
  );
  assert(
    !("apiKey" in (exportedConfig.discovery ?? {})) &&
      !("apiKey" in (exportedConfig.synthesis ?? {})) &&
      exportedConfig.discovery?.provider === "meta" &&
      exportedConfig.discovery?.model === "muse-spark-1.3" &&
      exportedConfig.synthesis?.model === "muse-wonder-1.0",
    "export carries Meta model picks with no API key field"
  );

  const roundTrip = await parseExportZip(exportBlob);
  assert(
    roundTrip.manifest.userid === "u1" &&
      roundTrip.histories.length === 1 &&
      roundTrip.histories[0].id === "c1" &&
      roundTrip.summaries.length === 1 &&
      roundTrip.tags.length === 1 &&
      Object.keys(roundTrip.entities).length === 1 &&
      Object.keys(roundTrip.categories).length === 1 &&
      roundTrip.templates.length === 1 &&
      roundTrip.modelConfig.discovery.provider === "meta" &&
      roundTrip.modelConfig.discovery.model === "muse-spark-1.3" &&
      roundTrip.modelConfig.synthesis.model === "muse-wonder-1.0",
    "parseExportZip round-trips every store"
  );
  const junkParsed = await parseExportZip(
    await buildExportZip({
      ...exportFixture,
      histories: [{ nope: true }, { id: "c9", turns: [] }],
      summaries: [{ bogus: 1 }] as unknown as ExportPayload["summaries"],
    })
  );
  assert(
    junkParsed.histories.length === 1 &&
      junkParsed.histories[0].id === "c9" &&
      junkParsed.summaries.length === 0,
    "parseExportZip drops malformed entries per store"
  );
  assert(
    typeof roundTrip.historiesJson === "string" &&
      JSON.parse(roundTrip.historiesJson).length === 1 &&
      junkParsed.historiesJson === null,
    "parseExportZip keeps verbatim JSON only when nothing was dropped"
  );
  const failMsg = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => "",
      (e) => (e instanceof Error ? e.message : String(e))
    );
  const emptyZip = await new JSZip().generateAsync({ type: "blob" });
  const wrongApp = await new JSZip()
    .file("manifest.json", JSON.stringify({ app: "other" }))
    .generateAsync({ type: "blob" });
  assert(
    (await failMsg(parseExportZip(new Blob(["not a zip"])))) !== "" &&
      (await failMsg(parseExportZip(emptyZip))).includes("manifest.json") &&
      (await failMsg(parseExportZip(wrongApp))).includes("Not an ExtBrain backup"),
    "parseExportZip rejects non-zips, partial zips, and foreign manifests"
  );

  const memStore = new Map<string, string>();
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
    const restored = await restoreBackup("u9", roundTrip);
    assert(
      restored.modelConfig.discovery.provider === "meta" &&
        restored.modelConfig.discovery.model === "muse-spark-1.3" &&
        restored.modelConfig.synthesis.model === "muse-wonder-1.0" &&
        restored.items.length === 1 &&
        loadSavedSummaries("u9").length === 1 &&
        loadTags("u9").length === 1 &&
        Object.keys(loadChatEntities("u9")).length === 1 &&
        Object.keys(loadThreadCategories("u9")).length === 1 &&
        loadCustomThreadTemplates().length === 1,
      "restoreBackup replaces every store and takes the backup model config"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }

  const legacyMigrated = normalizeModelConfig({
    useSameModel: false,
    discovery: {
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "secret-1",
    },
    synthesis: {
      provider: "openai_compatible",
      model: "muse-wonder-1.0",
      apiKey: "secret-2",
      baseUrl: "https://api.openai.com/v1",
    },
    maxTokensPerSynthesisBatch: 45000,
    zeroShotThreshold: 0.4,
  });
  assert(
    legacyMigrated.discovery.provider === "meta" &&
      legacyMigrated.discovery.model === "muse-spark-1.3" &&
      !("apiKey" in legacyMigrated.discovery) &&
      legacyMigrated.synthesis.provider === "meta" &&
      legacyMigrated.synthesis.model === "muse-wonder-1.0",
    "normalizeModelConfig migrates pre-Meta configs to Meta-only endpoints"
  );
  assert(
    normalizeModelConfig({}).maxTokensPerSynthesisBatch === 1000000 &&
      normalizeModelConfig({ maxTokensPerSynthesisBatch: 45000 })
        .maxTokensPerSynthesisBatch === 1000000 &&
      normalizeModelConfig({ maxTokensPerSynthesisBatch: 50000 })
        .maxTokensPerSynthesisBatch === 50000 &&
      normalizeModelConfig({ maxTokensPerSynthesisBatch: 99999999 })
        .maxTokensPerSynthesisBatch === 1048576,
    "normalizeModelConfig defaults batches to 1M and migrates the legacy 45k default"
  );

  const procItem = (
    id: string,
    timestamp: string,
    threadUrl?: string
  ): ParsedActivityItem => ({
    id,
    sourceFile: "f.json",
    header: "h",
    title: "t",
    cleanTitle: "t",
    timestamp,
    dateStr: timestamp.slice(0, 16),
    products: [],
    turns: [],
    allPromptsText: `prompt ${id}`,
    condensedResponseText: "",
    fullMarkdown: "",
    extractedEntities: [],
    estimatedFullTokens: 0,
    estimatedPackedTokens: 0,
    threadUrl,
  });
  const procItems = [
    procItem("old", "2024-01-01T00:00:00Z", "thread-a"),
    procItem("new", "2025-06-01T00:00:00Z", "thread-b"),
    procItem("mid", "2024-06-01T00:00:00Z", "thread-a"),
    procItem("undated", ""),
  ];
  assert(
    buildProcessQueue(procItems, {}, {}, null)
      .map((q) => q.id)
      .join(",") === "new,mid,old,undated",
    "buildProcessQueue orders pending chats newest first, undated last"
  );
  const newText = buildEntryClassificationText(procItems[1], []);
  const resumeQueue = buildProcessQueue(
    procItems,
    { new: [{ name: "x", type: "PER", score: 1 }] },
    { new: { hash: entityTextHash(newText), version: 0 } },
    null
  );
  assert(
    resumeQueue.map((q) => q.id).join(",") === "mid,old,undated",
    "buildProcessQueue skips chats whose stored record is current"
  );

  // === Category taxonomy ===
  assert(
    CATEGORY_TAXONOMY.length === 8 &&
      new Set(CATEGORY_TAXONOMY.map((c) => c.id)).size === 8 &&
      CATEGORY_LABELS.length === 8 &&
      CATEGORY_LABELS.every((l) => !l.includes(" ")) &&
      CATEGORY_TAXONOMY.every((c) => c.description.length > 0),
    "taxonomy stores 8 one-word category labels with descriptions"
  );
  const catScores = scoresToCategories({
    productivity: 0.9,
    finance: 0.95,
  });
  assert(
    catScores.productivity === 0.9 &&
      catScores.finance === 0.95 &&
      catScores.social === 0 &&
      topCategory(catScores) === "finance" &&
      scoresToCategories({ finance: 0.123456 }).finance === 0.1235,
    "scoresToCategories reads each one-word label; topCategory picks the argmax"
  );
  assert(
    topCategory(scoresToCategories({})) === "productivity",
    "topCategory breaks all-zero ties by taxonomy order"
  );
  const csItem: ParsedActivityItem = {
    ...procItem("cs", "2025-01-01T00:00:00Z"),
    turns: [
      {
        prompt: "how do I move money",
        responseMarkdown:
          "Open your banking app to start. Then confirm the transfer on the next screen.",
        responseSummary: "",
        extractedEntities: [],
      },
    ],
  };
  const csText = buildCategoryScoringText(csItem);
  assert(
    csText.includes("prompt cs") &&
      csText.includes("Open your banking app to start.") &&
      !csText.includes("confirm the transfer"),
    "buildCategoryScoringText keeps the prompt plus the first response sentence only"
  );
  const csEmpty: ParsedActivityItem = {
    ...procItem("cse", "2025-01-01T00:00:00Z"),
    turns: [
      {
        prompt: "hi",
        responseMarkdown: "",
        responseSummary: "",
        extractedEntities: [],
      },
    ],
  };
  const csLong: ParsedActivityItem = {
    ...procItem("csl", "2025-01-01T00:00:00Z"),
    turns: [
      {
        prompt: "hi",
        responseMarkdown: `Is this ok? ${"word ".repeat(200)}`,
        responseSummary: "",
        extractedEntities: [],
      },
    ],
  };
  assert(
    buildCategoryScoringText(csEmpty).includes("prompt cse") &&
      buildCategoryScoringText(csLong).includes("Is this ok?") &&
      !buildCategoryScoringText(csLong).includes("word word word") &&
      buildCategoryScoringText(csLong).length < 800,
    "buildCategoryScoringText tolerates empty responses and caps run-ons"
  );
  const threadRec = (
    part: Partial<Record<CategoryId, number>>,
    hash = "h"
  ): ThreadCategoryRecord => ({
    hash,
    version: THREAD_CATEGORY_VERSION,
    scores: {
      productivity: 0,
      finance: 0,
      social: 0,
      entertainment: 0,
      health: 0,
      travel: 0,
      utilities: 0,
      education: 0,
      ...part,
    },
  });
  const catThreadSums = summarizeThreads(procItems);
  const threadText = buildThreadScoringText(
    catThreadSums.find((t) => t.key === "thread-a")!.chats
  );
  assert(
    catThreadSums.map((t) => t.key).join(",") === "thread-b,thread-a" &&
      threadText.includes("prompt old") &&
      threadText.includes("prompt mid") &&
      threadText.length <= 800 &&
      categoryLabelFor("finance") === "Finance",
    "buildThreadScoringText joins thread chats oldest-first under the cap"
  );
  assert(
    threadNeedsCategoryScoring({ entry: undefined, hash: "h" }) === true &&
      threadNeedsCategoryScoring({ entry: threadRec({}, "h"), hash: "h" }) ===
        false &&
      threadNeedsCategoryScoring({
        entry: { ...threadRec({}, "h"), version: 0 },
        hash: "h",
      }) === true &&
      threadNeedsCategoryScoring({
        entry: threadRec({}, "other"),
        hash: "h",
      }) === true,
    "threadNeedsCategoryScoring refires on missing, stale-text, or outdated verdicts"
  );
  const normCats = normalizeThreadCategoryMap({
    good: threadRec({ finance: 0.7 }),
    bad: { nope: 1 },
    sloppy: { hash: "h", version: 1, scores: { finance: "high" } },
  });
  assert(
    Object.keys(normCats).join(",") === "good,sloppy" &&
      normCats.good.scores.finance === 0.7 &&
      normCats.sloppy.scores.finance === 0 &&
      Object.keys(normalizeThreadCategoryMap(undefined)).length === 0,
    "normalizeThreadCategoryMap drops malformed verdicts and tolerates old backups"
  );
  const catStore = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (catStore.has(k) ? catStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      catStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      catStore.delete(k);
    },
  };
  try {
    saveThreadCategories("uc", { "thread-a": threadRec({ finance: 0.7 }) });
    assert(
      loadThreadCategories("uc")["thread-a"]?.scores.finance === 0.7 &&
        Object.keys(loadThreadCategories("other")).length === 0,
      "thread verdicts persist per dataset"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  // === Compressed storage ===
  const rtPayload = {
    text: "héllo wörld 🎉",
    list: Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      name: "Ada Lovelace",
      type: "PER",
      score: 0.98765,
    })),
  };
  const rtEncoded = encodeCompressedJson(rtPayload);
  assert(
    rtEncoded.startsWith("gz1:") &&
      rtEncoded.length < JSON.stringify(rtPayload).length / 2 &&
      JSON.stringify(decodeStoredJson(rtEncoded)) ===
        JSON.stringify(rtPayload),
    "compressedJson round-trips unicode and shrinks repetitive JSON 2x+"
  );
  assert(
    JSON.stringify(decodeStoredJson(JSON.stringify({ a: 1 }))) ===
      '{"a":1}' &&
      decodeStoredJson(null) === null &&
      decodeStoredJson("not json{{{") === null &&
      decodeStoredJson("gz1:!!!invalid!!!") === null,
    "decodeStoredJson reads legacy raw JSON and fails soft on garbage"
  );
  // Peak-accounting quota: the old value still counts during the check,
  // so a shrinking replacement throws unless the old value goes first.
  const quotaStore = new Map<string, string>();
  const QUOTA_CAP = 5000;
  const quotaTotal = () =>
    [...quotaStore.values()].reduce((n, v) => n + v.length, 0);
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (quotaStore.has(k) ? quotaStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      const s = String(v);
      if (quotaTotal() + s.length > QUOTA_CAP) {
        throw { name: "QuotaExceededError" };
      }
      quotaStore.set(k, s);
    },
    removeItem: (k: string) => {
      quotaStore.delete(k);
    },
  };
  try {
    quotaStore.set("other", "x".repeat(4000));
    quotaStore.set("big", "y".repeat(3000));
    assert(
      setStoredItem("big", "z".repeat(900)) === true &&
        quotaStore.get("big") === "z".repeat(900) &&
        quotaTotal() === 4900,
      "setStoredItem clears a larger value to fit a shrinking write at quota"
    );
    assert(
      setStoredItem("fresh", "w".repeat(200)) === false &&
        !quotaStore.has("fresh"),
      "setStoredItem fails clean on fresh keys over quota"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  let removed = false;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => "old-big-value",
    setItem: () => {
      throw new TypeError("denied");
    },
    removeItem: () => {
      removed = true;
    },
  };
  try {
    assert(
      setStoredItem("k", "small") === false && removed === false,
      "setStoredItem never deletes on non-quota errors"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  // Legacy Firefox quota shape retries like the modern one and a success
  // clears the recorded error.
  const ffQuotaStore = new Map<string, string>();
  const ffQuotaTotal = () =>
    [...ffQuotaStore.values()].reduce((n, v) => n + v.length, 0);
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (ffQuotaStore.has(k) ? ffQuotaStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (ffQuotaTotal() + String(v).length > 1000) {
        throw { name: "NS_ERROR_DOM_QUOTA_REACHED", code: 1014 };
      }
      ffQuotaStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      ffQuotaStore.delete(k);
    },
  };
  try {
    ffQuotaStore.set("other", "x".repeat(800));
    ffQuotaStore.set("big", "y".repeat(500));
    assert(
      setStoredItem("big", "z".repeat(100)) === true &&
        lastPersistError() === null,
      "legacy quota errors retry and successes clear the recorded error"
    );
    assert(
      setStoredItem("fresh", "w".repeat(500)) === false &&
        lastPersistError()?.key === "fresh" &&
        lastPersistError()?.name === "NS_ERROR_DOM_QUOTA_REACHED",
      "failed persists record the key and error name"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  // Outcome subscription: UI re-reads the recorded error after every save,
  // including saves from effects with no state change after them.
  let notes = 0;
  const unsubOutcome = subscribePersistOutcome(() => {
    notes++;
  });
  const outcomeBase = getPersistOutcomeVersion();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    assert(
      setStoredItem("s", "v") === true &&
        notes === 1 &&
        getPersistOutcomeVersion() === outcomeBase + 1,
      "successful persists notify outcome subscribers"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {
      throw { name: "QuotaExceededError" };
    },
    removeItem: () => {},
  };
  try {
    assert(
      setStoredItem("s", "v") === false &&
        notes === 2 &&
        getPersistOutcomeVersion() === outcomeBase + 2,
      "failed persists notify outcome subscribers too"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  unsubOutcome();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    setStoredItem("s", "v");
    assert(
      notes === 2 && getPersistOutcomeVersion() === outcomeBase + 3,
      "unsubscribed listeners stop firing but the version keeps moving"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  const legacyStore = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (legacyStore.has(k) ? legacyStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      legacyStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      legacyStore.delete(k);
    },
  };
  try {
    // Pre-compression raw value, as already sitting in user browsers.
    legacyStore.set(
      "sb_entities_uu",
      JSON.stringify({ c1: [{ name: "Ada", type: "PER" }] })
    );
    assert(
      loadChatEntities("uu").c1?.[0]?.name === "Ada",
      "entity store reads pre-compression values"
    );
    saveChatEntities("uu", { c2: [{ name: "Bob", type: "PER" }] });
    assert(
      (legacyStore.get("sb_entities_uu") ?? "").startsWith("gz1:") &&
        loadChatEntities("uu").c2?.[0]?.name === "Bob",
      "entity store writes compressed and reads it back"
    );
    assert(
      entityStorageInfo("uu").format === "gz" &&
        entityStorageInfo("nobody").format === "missing",
      "entityStorageInfo reports stored format"
    );
    legacyStore.set("sb_entities_raw", JSON.stringify({ c1: [] }));
    assert(
      entityStorageInfo("raw").format === "raw",
      "entityStorageInfo flags pre-compression values"
    );
    // Empty verdicts are processed verdicts: NER ran and found nothing.
    // Dropping them at load resurrects the chat on every refresh.
    assert(
      "c1" in loadChatEntities("raw") &&
        loadChatEntities("raw").c1.length === 0,
      "entity store keeps stored empty verdicts at load"
    );
    saveChatEntities("uu", { c3: [] });
    assert(
      "c3" in loadChatEntities("uu"),
      "entity store round-trips empty verdicts through compression"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  // thread-b is current, thread-a needs scoring, the keyless chat belongs
  // to no thread: newest thread first.
  const tbHash = entityTextHash(
    buildThreadScoringText(
      catThreadSums.find((t) => t.key === "thread-b")!.chats
    )
  );
  const threadQueueAll = buildThreadCategoryQueue(procItems, {});
  const threadQueue = buildThreadCategoryQueue(procItems, {
    "thread-b": threadRec({}, tbHash),
  });
  assert(
    threadQueueAll.map((q) => q.id).join(",") === "thread-b,thread-a" &&
      threadQueue.map((q) => q.id).join(",") === "thread-a",
    "buildThreadCategoryQueue scores threads newest-first, skipping current and keyless"
  );

  const realFetch = (globalThis as Record<string, unknown>).fetch;
  const classifyFlags: unknown[] = [];
  (globalThis as Record<string, unknown>).fetch = async (
    url: unknown,
    init?: { body?: unknown }
  ) => {
    const body = JSON.parse(String((init?.body as string) ?? "{}")) as {
      items?: Array<{ id: string }>;
      multiLabel?: unknown;
    };
    const bodyItems = body.items ?? [];
    if (String(url).includes("classify-batch")) {
      classifyFlags.push(body.multiLabel);
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
  const memStore2 = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (memStore2.has(k) ? memStore2.get(k)! : null),
    setItem: (k: string, v: string) => {
      memStore2.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStore2.delete(k);
    },
  };
  try {
    const batchSizes: number[] = [];
    let lastCats: ThreadCategoryMap = {};
    const runnerArgs = {
      uuid: "u-run",
      items: procItems,
      baseMap: {},
      baseHashes: {},
      baseThreadCategories: {},
      serverVersion: 8,
      microBatch: 2,
      onBatch: (merged: ChatEntityMap) => {
        batchSizes.push(Object.keys(merged).length);
      },
      onCategories: (merged: ThreadCategoryMap) => {
        lastCats = merged;
      },
    };
    const first = processRunner.start(runnerArgs);
    const second = processRunner.start({ ...runnerArgs, onBatch: () => {} });
    assert(
      first === true && second === false,
      "processRunner is single-flight: a second start is refused"
    );
    for (let i = 0; i < 200 && processRunner.isRunning(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const snap = processRunner.getSnapshot();
    assert(
      snap.status === "idle" &&
        snap.error === null &&
        snap.phase === "categories" &&
        snap.done === 6 &&
        snap.total === 6 &&
        batchSizes.length === 2 &&
        Object.keys(lastCats).join(",") === "thread-b,thread-a" &&
        topCategory(lastCats["thread-a"].scores) === "finance" &&
        classifyFlags.length === 1 &&
        classifyFlags.every((f) => f === false),
      "processRunner drains NER then thread verdicts in micro-batches and reports completion"
    );
    // The runner persists BOTH entity stores itself (never via UI echo):
    // hashes landing while the map doesn't is exactly the refresh-reset.
    const storedMap = decodeStoredJson(
      memStore2.get("sb_entities_u-run") ?? null
    ) as Record<string, unknown> | null;
    const storedHashes = decodeStoredJson(
      memStore2.get("sb_entityhash_u-run") ?? null
    ) as Record<string, unknown> | null;
    assert(
      !!storedMap &&
        !!storedHashes &&
        Object.keys(storedMap).length === procItems.length &&
        Object.keys(storedHashes).length === procItems.length,
      "processRunner persists the entity map and hashes itself every NER run"
    );
    // Second run: every chat is NER-current, so NER is skipped and only
    // the 2 thread verdicts run.
    const fullMap: ChatEntityMap = {};
    const fullHashes: Record<string, { hash: string; version: number }> = {};
    for (const it of procItems) {
      fullMap[it.id] = [{ name: "x", type: "PER", score: 1 }];
      fullHashes[it.id] = {
        hash: entityTextHash(buildEntryClassificationText(it, [])),
        version: 8,
      };
    }
    let rescoreCats: ThreadCategoryMap = {};
    processRunner.start({
      ...runnerArgs,
      baseMap: fullMap,
      baseHashes: fullHashes,
      onCategories: (merged: ThreadCategoryMap) => {
        rescoreCats = merged;
      },
    });
    for (let i = 0; i < 200 && processRunner.isRunning(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const snap2 = processRunner.getSnapshot();
    assert(
      snap2.status === "idle" &&
        snap2.error === null &&
        snap2.phase === "categories" &&
        snap2.done === 2 &&
        snap2.total === 2 &&
        Object.keys(rescoreCats).join(",") === "thread-b,thread-a",
      "processRunner skips NER for current chats and scores only thread verdicts"
    );
    // Full-loop regression for the stuck-NER-count bug: the server finds
    // nothing for every chat (entities: []), the run stores those empty
    // verdicts, and a simulated refresh (load both stores, rebuild the
    // queue) must come back empty — not resurrect every chat.
    const nerMock = (globalThis as Record<string, unknown>).fetch;
    (globalThis as Record<string, unknown>).fetch = async (
      url: unknown,
      init?: { body?: unknown }
    ) => {
      const body = JSON.parse(String((init?.body as string) ?? "{}")) as {
        items?: Array<{ id: string }>;
      };
      const bodyItems = body.items ?? [];
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
          results: bodyItems.map((it) => ({ id: it.id, entities: [] })),
        }),
      };
    };
    try {
      processRunner.start({ ...runnerArgs, uuid: "u-empty" });
      for (let i = 0; i < 200 && processRunner.isRunning(); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const reloadedMap = loadChatEntities("u-empty");
      const reloadedHashes = loadChatEntityHashes("u-empty");
      const refreshQueue = buildProcessQueue(
        procItems,
        reloadedMap,
        reloadedHashes,
        8
      );
      assert(
        processRunner.getSnapshot().status === "idle" &&
          procItems.every(
            (it) => it.id in reloadedMap && reloadedMap[it.id].length === 0
          ) &&
          refreshQueue.length === 0,
        "empty NER verdicts persist and never requeue after a refresh"
      );
    } finally {
      (globalThis as Record<string, unknown>).fetch = nerMock;
    }
  } finally {
    processRunner.stop();
    (globalThis as Record<string, unknown>).fetch = realFetch;
    delete (globalThis as Record<string, unknown>).localStorage;
  }

  // Word-like padding (same length as a solid run) so truncation cut points
  // land near whitespace — a solid run backtracks far and would hide a
  // marker-overrun bug.
  const fatItem = (id: string, padChars: number): ParsedActivityItem => ({
    ...procItem(id, "2025-01-01T00:00:00Z"),
    turns: [
      {
        prompt: "w ".repeat(Math.ceil(padChars / 2)).slice(0, padChars),
        responseMarkdown: "ack",
        responseSummary: "ack",
        extractedEntities: [],
      },
    ],
  });
  const byteSize = (s: string) => new TextEncoder().encode(s).length;
  // ~320 packed bytes each at ~80 est. tokens: the byte budget (500) must
  // split even though the token budget (1e9) never binds.
  const bytePacked = packItemsIntoBatches(
    [fatItem("b1", 200), fatItem("b2", 200), fatItem("b3", 200)],
    1e9,
    500
  );
  assert(
    bytePacked.batches.length === 3 &&
      bytePacked.batches.every((b) => byteSize(b) <= 500) &&
      bytePacked.batches.join("\n").includes("[b3]"),
    "packItemsIntoBatches splits on the byte budget even when tokens fit"
  );
  const huge = packItemsIntoBatches([fatItem("huge", 2000)], 1e9, 500);
  assert(
    huge.batches.length === 1 &&
      huge.batches[0].includes(
        "[truncated: single chat exceeds the per-request size limit]"
      ) &&
      byteSize(huge.batches[0]) <= 500,
    "packItemsIntoBatches truncates a single oversize chat instead of failing the run"
  );
  // Separator accounting: with per-item size s and cap 3s+2, three items fit
  // by content (3s) but their two "\n\n" joins (3s+4) do not — the packer
  // must split instead of emitting an over-cap batch.
  const probe = packItemsIntoBatches([fatItem("pz", 20)], 1e9, 1e9);
  const s = byteSize(probe.batches[0]);
  const cap = 3 * s + 2;
  const sepPacked = packItemsIntoBatches(
    [fatItem("s1", 20), fatItem("s2", 20), fatItem("s3", 20), fatItem("s4", 20)],
    1e9,
    cap
  );
  assert(
    sepPacked.batches.length === 2 &&
      sepPacked.batches.every((b) => byteSize(b) <= cap),
    "packItemsIntoBatches counts join separators against the byte budget"
  );

  const chunkItem = (id: string, title: string): ParsedActivityItem => ({
    id,
    sourceFile: "f.json",
    header: "h",
    title,
    cleanTitle: title,
    timestamp: "2026-01-01T00:00:00.000Z",
    dateStr: "2026-01-01 00:00",
    products: [],
    turns: [],
    allPromptsText: "",
    condensedResponseText: "",
    fullMarkdown: "",
    extractedEntities: [],
    estimatedFullTokens: 0,
    estimatedPackedTokens: 0,
  });
  const tricky = [
    chunkItem("a", 'quote " and ],[ bracket'),
    chunkItem("b", "unicode \uE200 entity \u{1F600}"),
    chunkItem("c", "line\nbreak\tand\\backslash"),
  ];
  const bodies = [
    encodeHistoriesChunk(tricky.slice(0, 2)),
    encodeHistoriesChunk(tricky.slice(2)),
  ];
  const rejoined = JSON.parse(joinHistoriesChunks(bodies));
  assert(
    HISTORIES_CHUNK_SIZE >= 100 &&
      encodeHistoriesChunk([]) === "" &&
      joinHistoriesChunks([]) === "[]" &&
      Array.isArray(rejoined) &&
      rejoined.length === 3 &&
      rejoined[0].id === "a" &&
      rejoined[1].cleanTitle === "unicode \uE200 entity \u{1F600}" &&
      rejoined[2].title === "line\nbreak\tand\\backslash",
    "histories chunk helpers round-trip tricky content"
  );
  assert(
    (JSON.parse(joinHistoriesChunks([bodies[0], ""]))).length === 2 &&
      joinHistoriesChunks(["", ""]) === "[]",
    "histories chunk join drops missing-chunk placeholders"
  );

  const retroTpl = BUILTIN_TEMPLATES.find((t) => t.id === "retrospective");
  assert(
    !!retroTpl &&
      retroTpl.systemInstruction.includes("## Executive Summary") &&
      retroTpl.systemInstruction.includes("## What Moved Forward") &&
      retroTpl.systemInstruction.includes("## Key Learnings") &&
      retroTpl.systemInstruction.includes("## Action Items") &&
      retroTpl.systemInstruction.includes("- [ ]") &&
      retroTpl.systemInstruction.includes("Deadline:") &&
      retroTpl.systemInstruction.includes("Action Items template"),
    "retrospective template mandates the review format"
  );

  const actionTpl = BUILTIN_TEMPLATES.find((t) => t.id === "action_items");
  assert(
    !!actionTpl &&
      actionTpl.systemInstruction.includes("- [ ]") &&
      actionTpl.systemInstruction.includes("Deadline:"),
    "action_items template mandates the parseable checklist format"
  );
  for (const id of ["action_items", "retrospective", "milestone_timeline"]) {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === id);
    assert(
      !!tpl &&
        tpl.systemInstruction.includes("- [ ]") &&
        tpl.systemInstruction.includes("Deadline:") &&
        tpl.systemInstruction.includes("calendar.google.com/calendar/render") &&
        tpl.systemInstruction.includes("separate calendar section"),
      `${id} template mandates one-line actions with deadline and calendar link`
    );
  }

  const plainMd = [
    "## Summary",
    "- Just a note, not a task",
    "",
    "## Next Actions",
    "- Ship the report",
    "- [ ] Already a box",
    "- Review it. Deadline: 2026-11-05.",
    "- Deadline: 2026-08-16",
    "```",
    "- not a task, inside code",
    "```",
  ].join("\n");
  const injected = ensureActionItemCheckboxes(plainMd, refDate);
  assert(
    injected.split("\n").length === plainMd.split("\n").length &&
      injected.includes("- [ ] Ship the report") &&
      injected.includes("- [ ] Already a box") &&
      injected.includes("- [ ] Review it. Deadline: 2026-11-05.") &&
      injected.includes("- Just a note, not a task") &&
      injected.includes("- not a task, inside code"),
    "ensureActionItemCheckboxes boxes open items only, preserving lines"
  );
  assert(
    injected.includes("- Deadline: 2026-08-16") &&
      !injected.includes("[ ] Deadline: 2026-08-16"),
    "ensureActionItemCheckboxes leaves attached Deadline lines boxless"
  );
  // The display copy wires back to the stored markdown: every rendered box
  // matches a record that toggles the original text.
  const wired = listChecklistItems(injected, refDate);
  assert(
    wired.length === 3 &&
      wired.every(
        (r) =>
          toggleActionItemInMarkdown(
            plainMd,
            { text: r.text, deadline: r.deadline, deadlineText: r.deadlineText },
            true,
            refDate
          ) !== plainMd
      ),
    "injected boxes toggle the original markdown"
  );
  assert(
    stripActionItemPrefix("Action: do the thing") === "do the thing" &&
      stripActionItemPrefix("TASK: do it") === "do it" &&
      stripActionItemPrefix("todo: list it") === "list it" &&
      stripActionItemPrefix("No prefix here") === "No prefix here",
    "stripActionItemPrefix strips action labels case-insensitively"
  );

  const dottedMd = [
    "## Next Actions",
    "• Ship the dotted report",
    "• [ ] Dotted box item",
    "**Notable Milestones**",
    "• Plain milestone, not a task",
    "",
    "**Key Takeaways**",
    "• Takeaway one",
  ].join("\n");
  assert(
    JSON.stringify(extractActionItems(dottedMd)) ===
      JSON.stringify(["Ship the dotted report", "Dotted box item"]),
    "extractor reads • bullets and bold headings close action sections"
  );
  const dottedInjected = ensureActionItemCheckboxes(dottedMd, refDate);
  assert(
    dottedInjected.includes("• [ ] Ship the dotted report") &&
      dottedInjected.includes("• Plain milestone, not a task") &&
      dottedInjected.includes("• Takeaway one"),
    "injection boxes • action items and leaves takeaways plain"
  );
  const dottedWired = listChecklistItems(dottedInjected, refDate);
  assert(
    dottedWired.length === 2 &&
      dottedWired.every(
        (r) =>
          toggleActionItemInMarkdown(
            dottedMd,
            { text: r.text, deadline: r.deadline, deadlineText: r.deadlineText },
            true,
            refDate
          ) !== dottedMd
      ),
    "injected • boxes toggle the original markdown"
  );
  const dotItem = collectActionItems(
    [
      {
        id: "s9",
        createdAt: "2026-10-24T00:00:00.000Z",
        title: "Dotted",
        markdown: dottedMd,
        threads: [],
      } as unknown as SavedSummary,
    ],
    refDate
  ).find((a) => a.text === "Ship the dotted report");
  assert(
    !!dotItem &&
      toggleActionItemInMarkdown(dottedMd, dotItem, true, refDate).includes(
        "• [x] Ship the dotted report"
      ),
    "toggling keeps the author's • marker"
  );

  const starMd = ["## Next Actions", "** File the report", "** [ ] Starred box"].join(
    "\n"
  );
  assert(
    JSON.stringify(extractActionItems(starMd)) ===
      JSON.stringify(["File the report", "Starred box"]) &&
      ensureActionItemCheckboxes(starMd, refDate).includes(
        "** [ ] File the report"
      ),
    "extractor reads ** bullets as the nested dashes they render as"
  );

  const boldOpenMd = [
    "**Next Steps**",
    "- Do the thing",
    "",
    "## Wrap-up",
    "- Not a task",
  ].join("\n");
  assert(
    JSON.stringify(extractActionItems(boldOpenMd)) ===
      JSON.stringify(["Do the thing"]) &&
      ensureActionItemCheckboxes(boldOpenMd, refDate).includes(
        "- [ ] Do the thing"
      ),
    "bold action headings open collection until the next heading"
  );

  // === Real-world TL;DR fixtures: checkbox wiring end to end ===

  const oct14 = [
    "### TL;DR: Project & Task Summary",
    "",
    "#### Key Takeaways",
    "* **MYHOROS Launch:** Finalized a direct, high-engagement LinkedIn post copy featuring a soft-promotion hook (*\"Here’s a book written specifically for you\"*), complete with 10 free credits, multi-format delivery (phone, PDF, sharing), and the *\"when all stars align\"* payoff.",
    "* **Sourcing & Finance Operations:** Evaluated eBay international shipping options for Singapore; resolved a $10.50 Delta Dental billing overpayment credit; processed Toji/Funko high-margin daily sourcing filters.",
    "* **Tech & Tooling:** Addressed a software backend support bug regarding buy-box settings; clarified the structural differences between Meta Muse (consumer), Muse for Small Business (Shopify/QuickBooks/Stripe integrations), and Gemini Enterprise (MCP, connectors, skills).",
    "",
    "#### Action Items & Next Steps",
    "* [ ] **Publish LinkedIn Announcement** — Deploy the MYHOROS custom celestial blueprint post with the finalized copy and screenshot assets (Cover + Table of Contents). *(Deadline: 2026-10-15)* | [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Publish+MYHOROS+LinkedIn+Announcement&dates=20261015T120000Z/20261015T123000Z&details=Deploy+the+MYHOROS+custom+celestial+blueprint+post+with+finalized+copy+and+asset+screenshots.)",
    "* [ ] **Follow Up on Delta Dental Refund** — Contact the dental office front desk to process the $10.50 account overpayment refund back to the original payment method. *(Deadline: 2026-10-17)* | [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Follow+Up+on+Delta+Dental+Refund&dates=20261017T170000Z/20261017T173000Z&details=Call+dental+office+front+desk+to+process+%2410.50+overpayment+refund.)",
    "* [ ] **Monitor Software Support Ticket** — Check for technical engineering escalation updates regarding the backend UI bug that fails to save \"Below Buy Box\" settings. *(Deadline: 2026-10-18)* | [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Monitor+Software+Support+Ticket&dates=20261018T150000Z/20261018T153000Z&details=Check+ticket+status+on+backend+UI+bug+failing+to+save+edit+screen+inputs.)",
  ].join("\n");
  const oct14Sum = {
    id: "s10",
    createdAt: "2026-10-14T00:00:00.000Z",
    title: "TL;DR: Oct 14, 2026",
    markdown: oct14,
    threads: [],
  } as unknown as SavedSummary;
  const oct14Items = collectActionItems([oct14Sum], refDate);
  assert(
    oct14Items.length === 3 &&
      oct14Items[0].text.startsWith("Publish LinkedIn Announcement") &&
      oct14Items[0].text.includes("(Deadline: 2026-10-15)") &&
      oct14Items[0].deadline === "2026-10-15" &&
      oct14Items[1].deadline === "2026-10-17" &&
      oct14Items[2].deadline === "2026-10-18",
    "mid-line (Deadline: …) plus calendar link keeps full item text"
  );
  assert(
    ensureActionItemCheckboxes(oct14, refDate).split("[ ]").length - 1 === 3 &&
      renderedBoxesWired(oct14, refDate),
    "Oct 14 TL;DR: takeaways stay plain and every checkbox wires up"
  );

  const oct12 = [
    "# TL;DR: Project Summary & Action Items",
    "",
    "## 🚀 Key Takeaways & Milestones",
    "- **MYHOROS.COM Legal & Pay-as-You-Go Architecture:** Finalized the Terms & Conditions and Privacy Policy updates to include Stripe credit/pass purchases, feedback collection via Senja.io, and user account resets via the dashboard.",
    "- **UX & Clickwrap Compliance:** Implemented a non-pre-checked \"sign-in wrap\" notice directly above the `[LET_US_SEE]` button (capturing 18+ confirmation and agreement to T&C/Privacy Policy) without requiring disruptive checkboxes.",
    "- **Existing User Versioning:** Decided on a non-dismissible blocking prompt for older users based on a `consent_date` timestamp to ensure compliance with updated terms.",
    "- **Stock Predictive Analysis:** Completed a deep-dive technical, fundamental, and Monte Carlo risk assessment on UnitedHealth Group (UNH) ahead of its earnings release.",
    "- **E-Commerce & Logistics Bounds:** Clarified that using standard merchant tools like Shippo/Veeqo for walk-in retail shipping services breaches carrier terms of service.",
    "",
    "---",
    "",
    "## 📌 Action Items & Next Steps",
    "",
    "*   **Implement UI Clickwrap Notice:** Add the verified sign-in wrap text and hyperlinks directly above the entry button on MYHOROS.com.",
    "    *   *Deadline:* Before next traffic push / platform release",
    "    *   [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Implement+UI+Clickwrap+Notice+for+MYHOROS&dates=20261013T120000Z%2F20261013T130000Z&details=Add+the+verified+sign-in+wrap+text+and+hyperlinks+above+the+entry+button+on+MYHOROS.com)",
    "",
    "*   **Deploy Consent-Date Versioning Check:** Program the local storage logic to check for the updated `consent_date` and trigger the non-dismissible agreement prompt for legacy users.",
    "    *   *Deadline:* October 14, 2026",
    "    *   [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Deploy+Consent-Date+Versioning+Check&dates=20261014T100000Z%2F20261014T110000Z&details=Program+local+storage+logic+to+trigger+non-dismissible+agreement+prompt+for+legacy+users.)",
    "",
    "*   **Publish Updated Legal Pages:** Push the final revisions of the Terms & Conditions and Privacy Policy (incorporating Stripe, Senja, and MY ORBIT terms) live to the website.",
    "    *   *Deadline:* October 14, 2026",
    "    *   [Add Reminder to Google Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Publish+Updated+Legal+Pages+Live&dates=20261014T120000Z%2F20261014T130000Z&details=Push+final+revisions+of+T%26C+and+Privacy+Policy+live+to+MYHOROS.com.)",
  ].join("\n");
  const oct12Sum = {
    id: "s11",
    createdAt: "2026-10-12T00:00:00.000Z",
    title: "TL;DR: Oct 12, 2026",
    markdown: oct12,
    threads: [],
  } as unknown as SavedSummary;
  const oct12Items = collectActionItems([oct12Sum], refDate);
  assert(
    oct12Items.length === 3 &&
      oct12Items.some(
        (a) =>
          a.text.startsWith("Implement UI Clickwrap Notice") &&
          a.deadline === null &&
          a.deadlineText === "Before next traffic push / platform release"
      ) &&
      oct12Items.some(
        (a) =>
          a.text.startsWith("Deploy Consent-Date Versioning Check") &&
          a.deadline === "2026-10-14"
      ) &&
      oct12Items.some(
        (a) =>
          a.text.startsWith("Publish Updated Legal Pages") &&
          a.deadline === "2026-10-14"
      ),
    "takeaways under an action-titled H1 are not collected as actions"
  );
  assert(
    ensureActionItemCheckboxes(oct12, refDate).split("[ ]").length - 1 === 3 &&
      renderedBoxesWired(oct12, refDate),
    "Oct 12 TL;DR: takeaways and Deadline lines stay plain, parents wire up"
  );

  const parenMd = [
    "## Next Actions",
    "- Ship it (Deadline: 2026-11-05).",
    "- Review it (Deadline: Friday).",
  ].join("\n");
  const parenItems = collectActionItems(
    [
      {
        id: "s12",
        createdAt: "2026-10-24T00:00:00.000Z",
        title: "Parens",
        markdown: parenMd,
        threads: [],
      } as unknown as SavedSummary,
    ],
    refDate
  );
  assert(
    parenItems.length === 2 &&
      parenItems[0].text === "Ship it" &&
      parenItems[0].deadline === "2026-11-05" &&
      parenItems[1].text === "Review it" &&
      parenItems[1].deadlineText === "Friday",
    "parenthesized trailing deadlines split cleanly without paren residue"
  );

  console.log("=== All tests passed! ===");
}

runTests();
