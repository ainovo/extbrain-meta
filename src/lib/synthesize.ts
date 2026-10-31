import { ModelEndpointConfig, ParsedActivityItem } from "./types";
import {
  MAX_API_BODY_BYTES,
  packItemsIntoBatches,
} from "./retrievalEngine";
import { apiPost } from "./api";

export interface SynthesisPlan {
  batches: string[];
  batchCount: number;
  totalBytes: number;
  totalTokens: number;
}

/** Pack once up front so callers can warn before an expensive run. */
export function planSynthesis(
  items: ParsedActivityItem[],
  maxTokensPerBatch: number,
  maxBytesPerBatch = MAX_API_BODY_BYTES
): SynthesisPlan {
  const { batches, totalPackedTokens } = packItemsIntoBatches(
    items,
    maxTokensPerBatch,
    maxBytesPerBatch
  );
  const enc = new TextEncoder();
  const totalBytes = batches.reduce((n, b) => n + enc.encode(b).length, 0);
  return {
    batches,
    batchCount: batches.length,
    totalBytes,
    totalTokens: totalPackedTokens,
  };
}

/**
 * Warn when a run exceeds either budget. Multi-request runs need an
 * extraction pass per batch plus a final synthesis, and a ~1MB single
 * request is itself ~250K tokens of prefill — both take minutes.
 */
export const SYNTHESIS_WARN_BYTES = 512 * 1024;

export function synthesisNeedsConfirm(plan: SynthesisPlan): boolean {
  return plan.batchCount > 1 || plan.totalBytes > SYNTHESIS_WARN_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

/**
 * Per-model extraction fan-out cap. Contributor models allow 150 requests /
 * 3M tokens per minute per team, standard models 3,000 / 4M
 * (https://dev.meta.ai/docs/pricing-rate-limits). A full 1MB batch is
 * ~250K tokens, so each cap bursts at most ~25% of its tier's TPM — a 4x
 * margin — while beating sequential extraction several-fold.
 */
export function extractionConcurrencyFor(model: string): number {
  return model.includes("contributor") ? 3 : 4;
}

/** Promise.all with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      // Single-threaded pick-up: no two workers take the same index.
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * 429 backoff per the rate-limit docs: 500ms doubling plus jitter,
 * honoring Retry-After (seconds) when the API sends one.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterSec: number | null
): number {
  const backoff = 500 * 2 ** Math.max(0, attempt) + Math.random() * 500;
  if (retryAfterSec !== null && retryAfterSec > 0) {
    return Math.max(backoff, retryAfterSec * 1000);
  }
  return backoff;
}

/** Pre-flight warning with real numbers, e.g. before a 3MB/3-batch run. */
export function formatSynthesisWarning(
  plan: SynthesisPlan,
  opts?: { noun?: string; tip?: string }
): string {
  const noun = opts?.noun ?? "selection";
  const reqs = plan.batchCount === 1 ? "1 request" : `${plan.batchCount} requests`;
  const tip = opts?.tip ? ` ${opts.tip}` : "";
  return (
    `Large ${noun}: ~${formatBytes(plan.totalBytes)} in ${reqs} ` +
    `(~${formatCompactTokens(plan.totalTokens)} tokens). ` +
    `This may take several minutes.${tip}`
  );
}

export interface SynthesisStreamOptions {
  items: ParsedActivityItem[];
  templateName: string;
  systemInstruction: string;
  modelConfig: ModelEndpointConfig;
  maxTokensPerBatch: number;
  signal: AbortSignal;
  onDelta: (accumulated: string) => void;
  onProgress: (note: string) => void;
}

/**
 * Streams one summary over packed chat batches, resolving the accumulated
 * markdown. Shared by thread summaries and day retrospectives; throws on
 * HTTP/SSE errors and on abort (callers tell AbortError apart).
 */
export async function streamSynthesis({
  items,
  templateName,
  systemInstruction,
  modelConfig,
  maxTokensPerBatch,
  signal,
  onDelta,
  onProgress,
}: SynthesisStreamOptions): Promise<string> {
  const { batches } = planSynthesis(items, maxTokensPerBatch);
  const resp = await apiPost(
    "/api/synthesize-thread-stream",
    {
      projectQuery: templateName,
      batches,
      systemInstruction,
      modelConfig,
    },
    { signal }
  );
  if (!resp.ok || !resp.body) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(
      (errData as { error?: string }).error || `HTTP ${resp.status}`
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (typeof evt.delta === "string" && evt.delta) {
          acc += evt.delta;
          onDelta(acc);
        } else if (typeof evt.progress === "string") {
          onProgress(evt.progress);
        } else if (typeof evt.error === "string" && evt.error) {
          throw new Error(evt.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) {
          throw e;
        }
        // ignore partial JSON frames
      }
    }
  }
  // Flush trailing buffered event.
  const tail = buf.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const evt = JSON.parse(payload);
        if (typeof evt.delta === "string" && evt.delta) {
          acc += evt.delta;
          onDelta(acc);
        } else if (typeof evt.error === "string" && evt.error) {
          throw new Error(evt.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }
  return acc;
}
