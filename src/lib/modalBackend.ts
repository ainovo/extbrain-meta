/**
 * Shared Modal /analyze contract (modal/modal_deploy.py): request builders
 * and result mappers used by the server when a Modal NER/NLI backend is
 * selected. Pure functions (no fetch, no DOM) so the test suite covers the
 * mapping without a deployment.
 */
import {
  MAX_ENTITY_NAME_CHARS,
  cleanEntityText,
  hasNameLetters,
  isCommonConnective,
  isPlausibleEntityName,
} from "./entities";

/**
 * Labels for Modal NER: the deploy uppercases these and keeps only spans
 * whose XLM-R tag matches, so this must be the model's tag set, not
 * natural words (a mismatch silently returns zero entities). Superset on
 * purpose: extra labels match nothing, missing ones drop entities.
 */
export const MODAL_NER_LABELS = ["PER", "ORG", "LOC", "MISC", "DATE"];

/**
 * The Modal endpoint always runs its NLI pass, even for NER-only calls, so
 * those send one benign placeholder label. NER results are unaffected.
 */
export const MODAL_NER_PLACEHOLDER_CATEGORIES = ["general"];

/**
 * No server-side NER prefilter: records keep every span with its score and
 * the Settings floor does the filtering — same contract as the local path.
 */
export const MODAL_NER_THRESHOLD = 0;

/**
 * Classify calls discard entities, so they ask for (almost) none back to
 * keep the response lean. The NLI pass still runs; only the NER list
 * shrinks.
 */
export const MODAL_NLI_NER_THRESHOLD = 0.99;

export interface ModalEntityOut {
  text: string;
  label: string;
  score: number;
}

export interface ModalAnalyzeResult {
  scores: Record<string, number>;
  entities: ModalEntityOut[];
}

export interface ModalAnalyzeBody {
  texts: string[];
  categories: string[];
  exclude_categories: string[];
  ner_labels: string[];
  multi_label: boolean;
  category_threshold: number;
  exclude_threshold: number;
  ner_threshold: number;
}

export function buildModalNerBody(texts: string[]): ModalAnalyzeBody {
  return {
    texts,
    categories: [...MODAL_NER_PLACEHOLDER_CATEGORIES],
    exclude_categories: [],
    ner_labels: [...MODAL_NER_LABELS],
    multi_label: false,
    category_threshold: 0.5,
    exclude_threshold: 0.65,
    ner_threshold: MODAL_NER_THRESHOLD,
  };
}

export function buildModalNliBody(
  texts: string[],
  labels: string[],
  multiLabel: boolean
): ModalAnalyzeBody {
  return {
    texts,
    categories: [...labels],
    exclude_categories: [],
    ner_labels: [...MODAL_NER_LABELS],
    multi_label: multiLabel,
    category_threshold: 0.5,
    exclude_threshold: 0.65,
    ner_threshold: MODAL_NLI_NER_THRESHOLD,
  };
}

/**
 * Validate the Modal results array: one entry per input text, in order,
 * each with a scores map and an entities list. Null on any mismatch so
 * callers fail loudly instead of misaligning scores to the wrong chat.
 */
export function normalizeModalResults(
  raw: unknown,
  count: number
): ModalAnalyzeResult[] | null {
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const out: ModalAnalyzeResult[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const rec = r as { scores?: unknown; entities?: unknown };
    if (
      !rec.scores ||
      typeof rec.scores !== "object" ||
      Array.isArray(rec.scores) ||
      !Array.isArray(rec.entities)
    ) {
      return null;
    }
    out.push({
      scores: rec.scores as Record<string, number>,
      entities: rec.entities as ModalEntityOut[],
    });
  }
  return out;
}

export interface ModalMappedEntity {
  text: string;
  label: string;
  score: number;
}

/**
 * Modal entities to the local extract-entities shape. Modal already
 * trims spans and maps labels to PER/ORG/LOC; the local name filters run
 * again so mention aggregation sees the same quality bar as local NER.
 */
export function mapModalEntities(
  entities: ModalEntityOut[] | undefined | null
): ModalMappedEntity[] {
  const out: ModalMappedEntity[] = [];
  for (const e of entities || []) {
    if (!e || typeof e.text !== "string") continue;
    const name = cleanEntityText(e.text);
    if (
      !name ||
      name.length > MAX_ENTITY_NAME_CHARS ||
      !hasNameLetters(name) ||
      !isPlausibleEntityName(name) ||
      isCommonConnective(name)
    ) {
      continue;
    }
    out.push({
      text: name,
      label: typeof e.label === "string" && e.label ? e.label : "MISC",
      score: typeof e.score === "number" && Number.isFinite(e.score) ? e.score : 0,
    });
  }
  return out;
}

/**
 * Modal score map to per-label scores for exactly the requested labels.
 * Missing or non-finite entries read 0, matching scoresToCategories.
 */
export function mapModalScores(
  scores: Record<string, number> | undefined | null,
  labels: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const label of labels) {
    const v = scores?.[label];
    out[label] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return out;
}
