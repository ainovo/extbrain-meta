export interface RawTakeoutEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  time?: string;
  products?: string[];
  activityControls?: string[];
  imageFile?: string;
  details?: Array<{ name?: string; url?: string }>;
  subtitles?: Array<{ name?: string; url?: string }>;
  safeHtmlItem?: Array<{ html?: string }>;
}

export interface ConversationTurn {
  prompt: string;
  responseMarkdown: string;
  responseSummary: string;
  extractedEntities: string[];
}

export interface ParsedActivityItem {
  id: string;
  sourceFile: string;
  header: string;
  title: string;
  cleanTitle: string;
  titleUrl?: string;
  threadUrl?: string;
  timestamp: string; // ISO string
  dateStr: string;   // YYYY-MM-DD HH:mm
  products: string[];
  turns: ConversationTurn[];
  allPromptsText: string;
  condensedResponseText: string;
  fullMarkdown: string;
  extractedEntities: string[];
  estimatedFullTokens: number;
  estimatedPackedTokens: number;
}

export interface CompactIndexCard {
  id: string;
  time: string;
  header: string;
  prompts: string[];
  aiKeyPoints: string;
  entities: string[];
}

export interface NliLabelSet {
  target_labels: string[];
  contrast_labels: string[];
}

export interface MatchedItemResult {
  id: string;
  reason: string;
  matchType: "anchor" | "entity_snowball" | "session_stitch" | "zero_shot" | "manual";
  matchedTerms?: string[];
  tagScores?: Record<string, number>;
  totalScore?: number;
  maxTargetScore?: number;
  maxContrastScore?: number;
  bestTargetLabel?: string;
  bestContrastLabel?: string;
}

export type LLMProviderType = "meta";

export interface ModelEndpointConfig {
  provider: LLMProviderType;
  model: string;
}

/**
 * Meta Model API text models served over Chat Completions
 * (https://api.meta.ai/v1/chat/completions). The API key lives in the
 * server .env as MODEL_API_KEY and never appears in this config.
 */
export const META_MODEL_OPTIONS: Array<{
  id: string;
  label: string;
  hint: string;
}> = [
  {
    id: "muse-spark-1.3",
    label: "Muse Spark 1.3",
    hint: "Recommended — latest, agentic + coding",
  },
  {
    id: "muse-spark-1.3-contributor",
    label: "Muse Spark 1.3 Contributor",
    hint: "Discounted — content may train Meta models",
  },
  {
    id: "muse-wonder-1.0",
    label: "Muse Wonder 1.0",
    hint: "Most capable, long-horizon work",
  },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2", hint: "Previous version" },
  {
    id: "muse-spark-1.2-contributor",
    label: "Muse Spark 1.2 Contributor",
    hint: "Discounted — content may train Meta models",
  },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1", hint: "Original version" },
];

export const DEFAULT_META_MODEL = "muse-spark-1.3";

/**
 * Default packed-tokens-per-synthesis-batch. All picker models offer a
 * ~1M-token window, so histories pack into a single batch unless they are
 * enormous. Estimates use chars/4, which can undershoot dense text.
 */
export const DEFAULT_MAX_TOKENS_PER_BATCH = 1000000;

/** Hard ceiling: the Muse models' 1,048,576-token context window. */
export const MAX_MODEL_CONTEXT_TOKENS = 1048576;

/** True for model IDs our Meta picker supports (legacy IDs fail closed). */
export function isMetaModelId(v: unknown): v is string {
  return (
    typeof v === "string" && META_MODEL_OPTIONS.some((o) => o.id === v)
  );
}

export interface DualModelConfig {
  useSameModel: boolean;
  discovery: ModelEndpointConfig;
  synthesis: ModelEndpointConfig;
  maxTokensPerSynthesisBatch: number;
  /** Auto-tag rule: keep chat when max_target_score >= threshold AND > max_contrast_score. */
  zeroShotThreshold?: number;
  /** NER mention floor: ignore extracted spans scoring below this (0 = off). */
  nerScoreFloor?: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  badge: string;
  description: string;
  systemInstruction: string;
}
