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

/** Default for tag/summary generation: discounted, content may train Meta models. */
export const DEFAULT_CONTRIBUTOR_MODEL = "muse-spark-1.3-contributor";

/**
 * NER backend: on-device XLM-R, or the Modal deployment via /analyze. The
 * Modal id is model-agnostic on purpose: labels name the current model, so
 * a model swap never churns stored configs or records.
 */
export type NerBackendId = "local" | "modal";

export const NER_BACKEND_OPTIONS: Array<{ id: NerBackendId; label: string }> = [
  {
    id: "local",
    label: "local - xlm-roberta-base-ner-hrl - based on FacebookAI/xlm-roberta-base",
  },
  {
    id: "modal",
    label: "modal - xlm-roberta-base-ner-hrl - based on FacebookAI/xlm-roberta-base",
  },
];

/** NLI backend: on-device mDeBERTa XNLI, or the Modal deployment. */
export type NliBackendId = "local" | "modal";

export const NLI_BACKEND_OPTIONS: Array<{ id: NliBackendId; label: string }> = [
  {
    id: "local",
    label: "local - mdeberta-v3-base-xnli-multilingual-nli - based on microsoft/mdeberta-v3-base",
  },
  {
    id: "modal",
    label:
      "modal - xlm-roberta-base-snli-mnli-anli-xnli - based on FacebookAI/xlm-roberta-base",
  },
];

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
  /** Legacy toggle (Models section removed): always treated as independent. */
  useSameModel: boolean;
  /** Tag generation model (NLI label authoring for auto-tagging). */
  discovery: ModelEndpointConfig;
  /** Summary generation model (final project summary). */
  synthesis: ModelEndpointConfig;
  /** Voice agent model (answers spoken questions about chats). */
  voice: ModelEndpointConfig;
  maxTokensPerSynthesisBatch: number;
  /** Auto-tag rule: keep chat when max_target_score >= threshold AND > max_contrast_score. */
  zeroShotThreshold?: number;
  /** NER mention floor: ignore extracted spans scoring below this (0 = off). */
  nerScoreFloor?: number;
  /** NER backend selection (local default; modal runs via /analyze). */
  nerBackend?: NerBackendId;
  /** NLI backend selection (local default; modal runs via /analyze). */
  nliBackend?: NliBackendId;
  /** Mention surfacing rule: count entities mentioned in N+ chats (default 4). */
  mentionMinChats?: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  badge: string;
  description: string;
  systemInstruction: string;
}
