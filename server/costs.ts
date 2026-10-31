/**
 * Model cost table (USD). Meta rates are per 1M tokens from the official
 * pricing page (https://dev.meta.ai/docs/pricing-rate-limits, checked
 * 2026-10-30):
 *
 * - muse-spark-1.3 / 1.2 / 1.1 (standard): $1.25 input, $0.15 cached input,
 *   $4.25 output. Spark 1.1 has no contributor tier.
 * - muse-spark-1.3 / 1.2 contributor: $0.10 input, $0.002 cached input,
 *   $0.20 output (discounted; content may train Meta models).
 * - muse-wonder-1.0: $4.00 input, $0.20 cached input, $20.00 output.
 *
 * Modal NER/NLI is billed per second of /analyze compute ($0.00023/sec).
 *
 * Rule: a model with no entry here costs $0 (free). Update this table when
 * Meta publishes new rates — past metering rows keep the cost computed at
 * the time, so history never rewrites.
 */

export interface TokenCost {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}

const STANDARD_SPARK: TokenCost = {
  inputPer1M: 1.25,
  cachedInputPer1M: 0.15,
  outputPer1M: 4.25,
};

const CONTRIBUTOR_SPARK: TokenCost = {
  inputPer1M: 0.1,
  cachedInputPer1M: 0.002,
  outputPer1M: 0.2,
};

export const META_MODEL_COSTS: Record<string, TokenCost> = {
  "muse-spark-1.3": STANDARD_SPARK,
  "muse-spark-1.2": STANDARD_SPARK,
  "muse-spark-1.1": STANDARD_SPARK,
  "muse-spark-1.3-contributor": CONTRIBUTOR_SPARK,
  "muse-spark-1.2-contributor": CONTRIBUTOR_SPARK,
  "muse-wonder-1.0": {
    inputPer1M: 4.0,
    cachedInputPer1M: 0.2,
    outputPer1M: 20.0,
  },
};

/** Modal /analyze compute rate: $0.00023 per second. */
export const MODAL_COST_PER_SEC = 0.00023;

/**
 * Free-tier pool (USD) backing the onboarding "remaining free usage"
 * meter: percent remaining = 1 - sum(costUsd) / budget.
 */
export const FREE_BUDGET_USD = 200;

/** Whole-percent free usage remaining, clamped to 0–100. */
export function remainingFreePct(
  totalCostUsd: number,
  budgetUsd: number = FREE_BUDGET_USD
): number {
  if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) totalCostUsd = 0;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 0;
  return Math.max(0, Math.round((1 - totalCostUsd / budgetUsd) * 100));
}

/**
 * Effective (runtime) rates. Start as the built-in table; the Settings page
 * can override them (persisted to Mongo, applied here) — see
 * setEffectiveCosts/resetEffectiveCosts. History is never rewritten: past
 * metering rows keep the cost computed at log time.
 */
let effectiveMetaCosts: Record<string, TokenCost> = { ...META_MODEL_COSTS };
let effectiveModalPerSec: number = MODAL_COST_PER_SEC;

export function getEffectiveMetaCosts(): Record<string, TokenCost> {
  return { ...effectiveMetaCosts };
}

export function getEffectiveModalPerSec(): number {
  return effectiveModalPerSec;
}

export function setEffectiveCosts(
  rates: Record<string, TokenCost>,
  modalPerSec: number
): void {
  effectiveMetaCosts = { ...rates };
  effectiveModalPerSec = modalPerSec;
}

export function resetEffectiveCosts(): void {
  effectiveMetaCosts = { ...META_MODEL_COSTS };
  effectiveModalPerSec = MODAL_COST_PER_SEC;
}

/** Validated custom-rate payload from the Settings page. */
export interface CustomCosts {
  rates: Record<string, TokenCost>;
  modalPerSec: number;
}

function isNonNegNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Validate a Settings-page cost payload. Unknown model ids are rejected;
 * every rate must be a finite number >= 0. Returns the sanitized payload
 * or an error message (never throws).
 */
export function sanitizeCustomCosts(input: unknown):
  | { ok: true; costs: CustomCosts }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Cost payload must be an object." };
  }
  const { rates, modalPerSec } = input as Record<string, unknown>;
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) {
    return { ok: false, error: "Missing rates object." };
  }
  const clean: Record<string, TokenCost> = {};
  for (const [id, r] of Object.entries(rates as Record<string, unknown>)) {
    if (!(id in META_MODEL_COSTS)) {
      return { ok: false, error: `Unknown model: ${id}.` };
    }
    const row = r as Record<string, unknown>;
    if (
      !row ||
      typeof row !== "object" ||
      !isNonNegNumber(row["inputPer1M"]) ||
      !isNonNegNumber(row["cachedInputPer1M"]) ||
      !isNonNegNumber(row["outputPer1M"])
    ) {
      return { ok: false, error: `Invalid rates for ${id}: all three must be numbers >= 0.` };
    }
    clean[id] = {
      inputPer1M: row["inputPer1M"],
      cachedInputPer1M: row["cachedInputPer1M"],
      outputPer1M: row["outputPer1M"],
    };
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: "No model rates provided." };
  }
  if (!isNonNegNumber(modalPerSec)) {
    return { ok: false, error: "modalPerSec must be a number >= 0." };
  }
  return { ok: true, costs: { rates: clean, modalPerSec } };
}

/**
 * USD cost of one Meta chat-completions call. Unknown models cost $0.
 * Cached input tokens (when reported) are billed at the discounted rate;
 * the rest of the input at the standard rate.
 */
export function metaCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number {
  const rate = effectiveMetaCosts[model.trim()];
  if (!rate) return 0;
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const uncached = Math.max(0, inputTokens - cached);
  return (
    (uncached * rate.inputPer1M + cached * rate.cachedInputPer1M) / 1_000_000 +
    (Math.max(0, outputTokens) * rate.outputPer1M) / 1_000_000
  );
}

/** USD cost of Modal compute for a measured duration. */
export function modalCostUsd(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return (durationMs / 1000) * effectiveModalPerSec;
}

/** Shape of the `usage` block in Meta chat-completions responses. */
export interface MetaUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Pull token counts out of a Meta response body (missing → zeros). */
export function parseMetaUsage(data: unknown): MetaUsage {
  const usage = (data as { usage?: Record<string, unknown> } | null)
    ?.usage as Record<string, unknown> | undefined;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const details = usage?.["prompt_tokens_details"] as
    | Record<string, unknown>
    | undefined;
  return {
    inputTokens: num(usage?.["prompt_tokens"]),
    cachedInputTokens: num(details?.["cached_tokens"]),
    outputTokens: num(usage?.["completion_tokens"]),
  };
}
