import {
  DEFAULT_MAX_TOKENS_PER_BATCH,
  MatchedItemResult,
  ParsedActivityItem,
} from "./types";
import { estimateTokens } from "./takeoutParser";
import { truncateAtWordBoundary } from "./entities";

export const MODERNBERT_MODEL_ID = "MoritzLaurer/ModernBERT-large-zeroshot-v2.0";

export function normalizeTagLabel(rawTag: string): string {
  return rawTag.replace(/^#+/, "").trim();
}

/**
 * Builds the text evaluated by ModernBERT for each chat entry:
 * Includes User Prompt(s) + all key paragraphs/sentences from the AI response
 * (opening paragraphs + any paragraph/sentence containing bold takeaways, metrics/%, $, domains, or label terms)
 * up to ~1,400 chars so multi-paragraph Gemini Apps responses never lose mid/late-paragraph conclusions.
 */
export function buildEntryClassificationText(
  item: ParsedActivityItem,
  userTags: string[] = []
): string {
  const promptPart = truncateAtWordBoundary(item.allPromptsText, 400);
  const fullResp = item.turns
    .map((t) => t.responseMarkdown || t.responseSummary)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (fullResp.length <= 1350) {
    return `User Prompt:\n${promptPart}\n\nAI Response:\n${fullResp}`.trim();
  }

  const paragraphs = fullResp
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const picked: string[] = paragraphs.slice(0, 3);
  const tagWords = userTags
    .flatMap((t) => normalizeTagLabel(t).toLowerCase().split(/[\s,]+/))
    .filter((w) => w.length >= 3);

  for (const p of paragraphs.slice(3)) {
    const pLow = p.toLowerCase();
    if (
      /\*\*[^*]+\*\*/.test(p) ||
      /\b\d+%|\$\d+/i.test(p) ||
      /\b[a-z0-9-]+\.(com|org|net|io|ai)\b/i.test(p) ||
      /ads?|campaign|spend|conversion|paywall|click|monetiz/i.test(p) ||
      tagWords.some((w) => pLow.includes(w))
    ) {
      picked.push(p);
      if (picked.join("\n").length >= 1350) break;
    }
  }

  return `User Prompt:\n${promptPart}\n\nAI Response:\n${picked
    .join("\n")
    .slice(0, 1400)}`.trim();
}

export interface ScoredEntryMatch {
  item: ParsedActivityItem;
  tagScores: Record<string, number>;
  totalScore: number;
  minScore: number;
  maxTargetScore: number;
  maxContrastScore: number;
  bestTargetLabel: string;
  bestContrastLabel: string;
}

/**
 * Target vs. Contrast NLI Evaluation & Filtering:
 * 1. Compute max_target_score = max(scores for target_labels)
 * 2. Compute max_contrast_score = max(scores for contrast_labels)
 * 3. Filter criteria to keep a chat:
 *    max_target_score >= threshold (default 0.40) AND max_target_score > max_contrast_score
 * 4. Rank kept chats by max_target_score descending.
 */
export function filterAndRankByTargetContrast(
  items: ParsedActivityItem[],
  scoresMap: Map<string, Record<string, number>>,
  targetLabels: string[],
  contrastLabels: string[],
  threshold = 0.4
): ScoredEntryMatch[] {
  const cleanTargets = targetLabels.map((t) => t.trim()).filter(Boolean);
  const cleanContrasts = contrastLabels.map((c) => c.trim()).filter(Boolean);
  if (cleanTargets.length === 0) return [];

  const matched: ScoredEntryMatch[] = [];

  for (const item of items) {
    const entryScores = scoresMap.get(item.id);
    if (!entryScores) continue;

    // Ensure at least one target label has been scored for this item
    const hasScoredTarget = cleanTargets.some(
      (t) => typeof entryScores[t] === "number"
    );
    if (!hasScoredTarget) continue;

    let maxTargetScore = 0;
    let bestTargetLabel = cleanTargets[0] || "";
    for (const t of cleanTargets) {
      const s = entryScores[t] ?? 0;
      if (s >= maxTargetScore) {
        maxTargetScore = s;
        bestTargetLabel = t;
      }
    }

    let maxContrastScore = 0;
    let bestContrastLabel = cleanContrasts[0] || "";
    for (const c of cleanContrasts) {
      const s = entryScores[c] ?? 0;
      if (s >= maxContrastScore) {
        maxContrastScore = s;
        bestContrastLabel = c;
      }
    }

    const passesFilter =
      maxTargetScore >= threshold && maxTargetScore > maxContrastScore;

    if (passesFilter) {
      matched.push({
        item,
        tagScores: entryScores,
        totalScore: maxTargetScore,
        minScore: maxTargetScore,
        maxTargetScore,
        maxContrastScore,
        bestTargetLabel,
        bestContrastLabel,
      });
    }
  }

  matched.sort((a, b) => b.maxTargetScore - a.maxTargetScore);
  return matched;
}

/**
 * Legacy helper kept for backward compatibility
 */
export function filterAndRankByTagScores(
  items: ParsedActivityItem[],
  scoresMap: Map<string, Record<string, number>>,
  userTags: string[],
  threshold = 0.85
): ScoredEntryMatch[] {
  const cleanTags = userTags.map(normalizeTagLabel).filter(Boolean);
  if (cleanTags.length === 0) return [];

  const matched: ScoredEntryMatch[] = [];

  for (const item of items) {
    const entryScores = scoresMap.get(item.id);
    if (!entryScores) continue;

    let allAboveThreshold = true;
    let totalScore = 0;
    let minScore = 1.0;
    let maxTargetScore = 0;
    let bestTargetLabel = cleanTags[0] || "";
    const relevantScores: Record<string, number> = {};

    for (const tag of cleanTags) {
      const score = entryScores[tag];
      if (typeof score !== "number") {
        allAboveThreshold = false;
        break;
      }
      relevantScores[tag] = score;
      totalScore += score;
      if (score < minScore) minScore = score;
      if (score > maxTargetScore) {
        maxTargetScore = score;
        bestTargetLabel = tag;
      }
      if (score < threshold) {
        allAboveThreshold = false;
      }
    }

    if (allAboveThreshold) {
      matched.push({
        item,
        tagScores: relevantScores,
        totalScore,
        minScore,
        maxTargetScore,
        maxContrastScore: 0,
        bestTargetLabel,
        bestContrastLabel: "",
      });
    }
  }

  matched.sort((a, b) => b.totalScore - a.totalScore);
  return matched;
}

/**
 * Direct in-process ModernBERT loader & classifier (also used for Node tests or non-worker fallback).
 */
let zeroShotPipeline: any = null;
let zeroShotModelLoaded = false;

export async function loadZeroShotModel(
  onProgress?: (pct: number, status: string) => void
): Promise<boolean> {
  if (zeroShotModelLoaded && zeroShotPipeline) return true;

  try {
    onProgress?.(5, "Initializing ModernBERT-large-zeroshot-v2.0 (checking Cache API)...");
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = typeof caches !== "undefined";

    const fileProgress = new Map<string, { loaded: number; total: number }>();

    zeroShotPipeline = await pipeline(
      "zero-shot-classification",
      MODERNBERT_MODEL_ID,
      {
        dtype: "q8",
        progress_callback: (data: any) => {
          if (data.status === "progress" && data.file) {
            fileProgress.set(data.file, {
              loaded: data.loaded || 0,
              total: data.total || 1,
            });
            let loaded = 0;
            let total = 0;
            fileProgress.forEach((v) => {
              loaded += v.loaded;
              total += v.total;
            });
            const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 10;
            onProgress?.(pct, `Downloading & caching ${data.file} (${pct}%)`);
          } else if (data.status === "done") {
            onProgress?.(100, "Model cached in browser Cache API.");
          }
        },
      }
    );

    zeroShotModelLoaded = true;
    onProgress?.(100, "ModernBERT-large-zeroshot-v2.0 ready.");
    return true;
  } catch (err) {
    console.error("Failed to load ModernBERT in main thread:", err);
    return false;
  }
}

export async function classifySingleTextWithModernBert(
  text: string,
  allLabels: string[]
): Promise<Record<string, number>> {
  const cleanLabels = allLabels.map((l) => l.trim()).filter(Boolean);
  if (cleanLabels.length === 0) return {};

  if (!zeroShotPipeline) {
    const ok = await loadZeroShotModel();
    if (!ok) {
      throw new Error("ModernBERT model failed to load");
    }
  }

  // Pass all target and contrast labels in a single batch array with multi_label=true
  const output: any = await zeroShotPipeline(text, cleanLabels, {
    multi_label: true,
    hypothesis_template: "This text is about {}.",
  });

  const single = Array.isArray(output) ? output[0] : output;
  const scoreMap: Record<string, number> = {};
  if (single && Array.isArray(single.labels) && Array.isArray(single.scores)) {
    for (let i = 0; i < single.labels.length; i++) {
      scoreMap[single.labels[i]] = single.scores[i];
    }
  }
  return scoreMap;
}

// ============================================================================
// Asymmetric Context Packing for Step 4 Synthesis
// ============================================================================
export function packSingleItemAsymmetrically(item: ParsedActivityItem): string {
  const turnBlocks = item.turns.map((turn, idx) => {
    const turnHeader = item.turns.length > 1 ? `Turn ${idx + 1}` : `Single Turn`;
    const isReferentialPrompt =
      turn.prompt.length < 110 ||
      /\b(option|recommend|sure|that|this|above|screenshot|post|draft|error|same)\b/i.test(
        turn.prompt
      );
    const aiContext = isReferentialPrompt
      ? turn.responseMarkdown.length > 1400
        ? turn.responseMarkdown.slice(0, 1400) + "\n...[truncated boilerplate]..."
        : turn.responseMarkdown
      : turn.responseSummary || turn.responseMarkdown.slice(0, 600);

    return [
      `  [${turnHeader} - USER PROMPT (VERBATIM)]:`,
      `  ${turn.prompt}`,
      `  [${turnHeader} - AI CONTEXT]:`,
      `  ${aiContext}`,
    ].join("\n");
  });

  return [
    `=== ENTRY [${item.id}] | TIMESTAMP: ${item.dateStr} (${item.timestamp}) | SOURCE: ${item.header} ===`,
    ...turnBlocks,
  ].join("\n");
}

export function packItemsIntoBatches(
  selectedItems: ParsedActivityItem[],
  maxTokensPerBatch = DEFAULT_MAX_TOKENS_PER_BATCH
): { batches: string[]; totalPackedTokens: number; totalRawTokens: number } {
  // Sort chronologically oldest -> newest for timeline synthesis
  const sorted = [...selectedItems].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  let totalRawTokens = 0;
  let totalPackedTokens = 0;
  const batches: string[] = [];
  let currentBatchParts: string[] = [];
  let currentBatchTokens = 0;

  for (const item of sorted) {
    totalRawTokens += item.estimatedFullTokens;
    const packed = packSingleItemAsymmetrically(item);
    const tokens = estimateTokens(packed);
    totalPackedTokens += tokens;

    if (
      currentBatchParts.length > 0 &&
      currentBatchTokens + tokens > maxTokensPerBatch
    ) {
      batches.push(currentBatchParts.join("\n\n"));
      currentBatchParts = [packed];
      currentBatchTokens = tokens;
    } else {
      currentBatchParts.push(packed);
      currentBatchTokens += tokens;
    }
  }

  if (currentBatchParts.length > 0) {
    batches.push(currentBatchParts.join("\n\n"));
  }

  return { batches, totalPackedTokens, totalRawTokens };
}

export function buildCompactIndex(
  items: ParsedActivityItem[]
): Array<{
  id: string;
  time: string;
  header: string;
  prompts: string[];
  aiKeyPoints: string;
  entities: string[];
}> {
  return items.map((item) => ({
    id: item.id,
    time: item.dateStr,
    header: item.header,
    prompts: item.turns.map((t) =>
      t.prompt.length > 260 ? t.prompt.slice(0, 260) + "..." : t.prompt
    ),
    aiKeyPoints:
      item.condensedResponseText.length > 360
        ? item.condensedResponseText.slice(0, 360) + "..."
        : item.condensedResponseText,
    entities: item.extractedEntities.slice(0, 12),
  }));
}

export function localTwoHopSnowballSearch(
  items: ParsedActivityItem[],
  projectQuery: string
): { matches: MatchedItemResult[]; discoveredEntities: string[] } {
  const STOPWORDS = new Set([
    "the", "and", "for", "that", "this", "with", "from", "what", "how", "why",
    "when", "where", "who", "which", "are", "was", "were", "will", "would",
    "could", "should", "can", "does", "did", "have", "has", "had", "not",
    "but", "you", "your", "about", "into", "more", "other", "than", "then",
    "them", "they", "their", "there", "been", "being", "some", "such", "only",
    "also", "very", "just", "like", "make", "made", "use", "used", "using",
    "project", "summary", "explore", "exploration", "channel", "option",
    "recommend", "need", "want", "think", "mean", "meant", "sure", "know",
    "paid", "free", "best", "good", "work", "time", "cost", "price", "plan",
    "plans", "user", "users", "account", "service", "system", "issue", "issues",
    "problem", "problems", "error", "errors", "setup", "test", "testing",
  ]);
  const GENERIC = new Set([
    "paid", "free", "best", "good", "work", "time", "cost", "price", "plan",
    "plans", "user", "users", "account", "service", "system", "issue", "issues",
    "problem", "problems", "error", "errors", "setup", "test", "testing",
  ]);
  const tokenize = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, " ")
      .split(/\s+/)
      .filter((w: string) => w.length >= 3 && !STOPWORDS.has(w));

  const queryTerms = tokenize(projectQuery);
  if (queryTerms.length === 0 || items.length === 0) {
    return { matches: [], discoveredEntities: [] };
  }

  const entityDocFreq = new Map<string, number>();
  for (const item of items) {
    const seen = new Set(item.extractedEntities.map((e) => e.toLowerCase()));
    for (const e of seen) {
      entityDocFreq.set(e, (entityDocFreq.get(e) || 0) + 1);
    }
  }

  const matchedMap = new Map<string, MatchedItemResult>();
  const hop1Items: ParsedActivityItem[] = [];

  for (const item of items) {
    const hayFull = (item.allPromptsText + " " + item.fullMarkdown).toLowerCase();
    const matchedFullTerms = queryTerms.filter((t) => hayFull.includes(t));
    if (matchedFullTerms.length > 0) {
      const specificMatchedTerms = matchedFullTerms.filter((t) => !GENERIC.has(t));
      const isStrongAnchor =
        specificMatchedTerms.length >= 1 || matchedFullTerms.length >= 2;
      if (isStrongAnchor) {
        hop1Items.push(item);
        matchedMap.set(item.id, {
          id: item.id,
          matchType: "anchor",
          matchedTerms:
            specificMatchedTerms.length > 0
              ? specificMatchedTerms
              : matchedFullTerms,
          reason: `Direct match on [${(specificMatchedTerms.length > 0
            ? specificMatchedTerms
            : matchedFullTerms
          ).join(", ")}]`,
        });
      }
    }
  }

  const maxAllowedDocFreq = Math.max(3, Math.ceil(items.length * 0.25));
  const candidateEntities = new Map<string, number>();
  for (const item of hop1Items) {
    for (const rawEnt of item.extractedEntities) {
      const entLower = rawEnt.toLowerCase();
      const df = entityDocFreq.get(entLower) || 1;
      if (df <= maxAllowedDocFreq && entLower.length >= 3 && !STOPWORDS.has(entLower)) {
        candidateEntities.set(rawEnt, (candidateEntities.get(rawEnt) || 0) + 1);
      }
    }
  }

  const discoveredEntities = Array.from(candidateEntities.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ent]) => ent)
    .slice(0, 18);

  const snowballPhrases = discoveredEntities
    .map((e) => e.toLowerCase())
    .filter((e) => e.length >= 4);

  if (snowballPhrases.length > 0) {
    for (const item of items) {
      if (matchedMap.has(item.id)) continue;
      const hay = (
        item.allPromptsText +
        " " +
        item.condensedResponseText +
        " " +
        item.extractedEntities.join(" ")
      ).toLowerCase();
      const hits = snowballPhrases.filter((phrase) => hay.includes(phrase));
      const hasMultiWordHit = hits.some((h) => h.includes(" ") || h.includes("."));
      if (hasMultiWordHit || hits.length >= 2) {
        matchedMap.set(item.id, {
          id: item.id,
          matchType: "entity_snowball",
          matchedTerms: hits.slice(0, 4),
          reason: `Linked via project entities: [${hits.slice(0, 3).join(", ")}]`,
        });
      }
    }
  }

  const currentMatchedIds = new Set(matchedMap.keys());
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (currentMatchedIds.has(item.id)) continue;
    const itemTime = new Date(item.timestamp).getTime();
    if (isNaN(itemTime)) continue;
    for (const neighborIdx of [i - 1, i + 1]) {
      if (neighborIdx < 0 || neighborIdx >= items.length) continue;
      const neighbor = items[neighborIdx];
      if (!currentMatchedIds.has(neighbor.id)) continue;
      const neighborTime = new Date(neighbor.timestamp).getTime();
      const diffMinutes = Math.abs(itemTime - neighborTime) / 60000;
      const sharedEntities = item.extractedEntities.filter((e) =>
        neighbor.extractedEntities
          .map((ne) => ne.toLowerCase())
          .includes(e.toLowerCase())
      );
      const isShortFollowUp = diffMinutes <= 12 && item.allPromptsText.length < 90;
      const isSameHourEntityContinuation =
        diffMinutes <= 60 && sharedEntities.length > 0;
      if (isShortFollowUp || isSameHourEntityContinuation) {
        matchedMap.set(item.id, {
          id: item.id,
          matchType: "session_stitch",
          matchedTerms: sharedEntities,
          reason: `Same-session continuation (${Math.round(diffMinutes)}m from "${neighbor.cleanTitle.slice(
            0,
            35
          )}...", shared: [${sharedEntities.join(", ") || "context"}])`,
        });
        break;
      }
    }
  }

  const orderedMatches = items
    .filter((item) => matchedMap.has(item.id))
    .map((item) => matchedMap.get(item.id)!);
  return { matches: orderedMatches, discoveredEntities };
}
