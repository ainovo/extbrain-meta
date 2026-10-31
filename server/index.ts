import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  CompactIndexCard,
  MatchedItemResult,
  ModelEndpointConfig,
} from "../src/lib/types";
import {
  MAX_ENTITY_NAME_CHARS,
  NerRawToken,
  cleanEntityText,
  groupNerWords,
  hasNameLetters,
  isCommonConnective,
  isPlausibleEntityName,
  nerWordRuns,
  projectTextAlnum,
  recoverSpanText,
  truncateAtWordBoundary,
} from "../src/lib/entities";
import {
  MAX_API_BODY_BYTES,
  normalizeZeroShotBatch,
} from "../src/lib/retrievalEngine";
import {
  buildModalNerBody,
  buildModalNliBody,
  mapModalEntities,
  mapModalScores,
  normalizeModalResults,
  type ModalAnalyzeBody,
} from "../src/lib/modalBackend";
import {
  extractionConcurrencyFor,
  mapWithConcurrency,
  retryDelayMs,
} from "../src/lib/synthesize";
import {
  createRateLimiter,
  isAdminAuthorized,
  isMeteringEnforced,
  isModelAllowed,
  parseAllowedModels,
  parseAllowedOrigins,
} from "./security";
import {
  FREE_BUDGET_USD,
  META_MODEL_COSTS,
  getEffectiveMetaCosts,
  getEffectiveModalPerSec,
  metaCostUsd,
  modalCostUsd,
  parseMetaUsage,
  remainingFreePct,
  resetEffectiveCosts,
  sanitizeCustomCosts,
  setEffectiveCosts,
} from "./costs";
import { ModalJobAggregator } from "./modalJobs";
import {
  clearCustomCosts,
  getTotalMeteredCost,
  isMongoConfigured,
  loadCustomCosts,
  logConsent,
  logMetering,
  logVisit,
  sanitizeUserId,
  saveCustomCosts,
} from "./db";

// Absolute path: .env must load even when the server starts outside the
// repo root (e.g. from modal/); a missing file is silently ignored.
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.env"
  ),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Behind Cloud Run (or any reverse proxy) the client IP arrives in
// X-Forwarded-For; without this, every request shares one IP and the rate
// limiters below would throttle all users together.
app.set("trust proxy", 1);

// CORS allowlist: set CORS_ORIGINS to a comma-separated list of origins
// (e.g. "https://app.extbrain.ai") on any public deployment. Unset keeps
// the historical allow-all behavior for local development.
const allowedOrigins = parseAllowedOrigins();
if (!allowedOrigins && process.env.NODE_ENV === "production") {
  console.warn(
    "[cors] CORS_ORIGINS is unset: allowing all origins. " +
      "Set CORS_ORIGINS to your frontend domain(s) on public deployments."
  );
}
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
app.use(express.json({ limit: "50mb" }));

// Abuse guard for the paid Meta-backed endpoints. Limits are per instance
// per client IP over a 15-minute window; tune with RATE_LIMIT_API_MAX and
// RATE_LIMIT_GEN_MAX (0 disables that limiter, e.g. behind your own gateway).
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
function envPositiveInt(name: string, fallback: number): number {
  const v = Number((process.env[name] || "").trim());
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}
const apiMax = envPositiveInt("RATE_LIMIT_API_MAX", 600);
const genMax = envPositiveInt("RATE_LIMIT_GEN_MAX", 60);
if (apiMax > 0) {
  app.use("/api", createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: apiMax }));
}
if (genMax > 0) {
  // Stricter cap on the endpoints that spend Meta API quota.
  app.use(
    [
      "/api/discover",
      "/api/synthesize",
      "/api/synthesize-thread-stream",
      "/api/voice-transcribe",
      "/api/voice-agent",
    ],
    createRateLimiter({
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: genMax,
      message: "Generation budget exceeded for this address.",
    })
  );
}

// Client identity for consent + metering. The browser sends its local uuid
// as X-User-Id (see src/lib/api.ts); the body field is a fallback for
// hand-rolled clients. Missing → "anonymous" so spend is still logged.
app.use((req, _res, next) => {
  const fromHeader = req.get("X-User-Id");
  const fromBody =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>).userId
      : undefined;
  (req as unknown as { userId: string }).userId = sanitizeUserId(
    typeof fromHeader === "string" && fromHeader.trim() !== ""
      ? fromHeader
      : fromBody
  );
  // Settings → Logging & metering toggle. When the user disables logging,
  // the client sends X-Metering-Opt-Out and the server skips every write
  // (consent, visits, metering). No rows are created for opted-out users.
  (req as unknown as { meteringOptOut: boolean }).meteringOptOut =
    req.get("X-Metering-Opt-Out") === "1" && !isMeteringEnforced();
  next();
});

/**
 * Server-side model gate. The Settings UI lock is cosmetic (anyone can
 * POST a different model id with curl), so locked deployments enforce the
 * allowlist here, on every Meta call. Unset ALLOWED_META_MODELS = allow
 * everything (local development).
 */
function rejectDisallowedModel(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  model: unknown
): boolean {
  if (isModelAllowed(model, parseAllowedModels())) return false;
  res.status(403).json({
    error:
      "This deployment only allows specific models. Change the model in Settings (if available) or contact your administrator.",
  });
  return true;
}

/**
 * Kill switch for the entire cost-table surface. With DISABLE_COSTS_API=1
 * (Cloud Run), /api/costs behaves as if never deployed — every method 404s
 * before reaching any handler, so there is nothing to authenticate against
 * or bypass. The code still ships in the image but is unreachable.
 */
if (
  ["1", "true"].includes(
    (process.env.DISABLE_COSTS_API || "").trim().toLowerCase()
  )
) {
  console.log("[costs] cost-table API disabled (DISABLE_COSTS_API=1).");
  app.use("/api/costs", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
}

/** Admin gate for cost-table writes. Open when ADMIN_API_KEY is unset. */
function rejectUnauthorizedAdmin(req: {
  get: (name: string) => string | undefined;
}): { status: number; error: string } | null {
  const configured = (process.env.ADMIN_API_KEY || "").trim();
  if (isAdminAuthorized(req.get("X-Admin-Key"), configured)) return null;
  return {
    status: 403,
    error: "Cost table changes require a valid admin key.",
  };
}

function isOptedOut(req: express.Request): boolean {
  return (req as unknown as { meteringOptOut?: boolean }).meteringOptOut === true;
}

function reqUid(req: express.Request): string {
  return sanitizeUserId((req as unknown as { userId?: unknown }).userId);
}

// Onboarding consent + app-load visit. Fire-and-forget from the client;
// failures never surface (metering must not break the app).
app.post("/api/consent", async (req, res) => {
  try {
    const { consentAt } = req.body as { consentAt?: unknown };
    const at =
      typeof consentAt === "string" && consentAt.trim() !== ""
        ? consentAt.trim().slice(0, 64)
        : new Date().toISOString();
    if (!isOptedOut(req)) await logConsent(reqUid(req), at);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.post("/api/visit", async (req, res) => {
  try {
    if (!isOptedOut(req)) await logVisit(reqUid(req));
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

/**
 * Cost table for Settings → Logging & metering. GET returns the effective
 * rates (built-ins merged with saved customs); POST validates and saves a
 * custom table; DELETE reverts to built-ins. Rates apply to future logs
 * only. Writing requires MongoDB; without MONGODB_URI the table is
 * read-only built-ins.
 */
app.get("/api/costs", async (_req, res) => {
  try {
    res.json({
      dbAvailable: isMongoConfigured(),
      rates: getEffectiveMetaCosts(),
      modalPerSec: getEffectiveModalPerSec(),
      custom: (await loadCustomCosts()) !== null,
    });
  } catch {
    res.status(500).json({ error: "Failed to load cost table." });
  }
});

app.post("/api/costs", async (req, res) => {
  try {
    const admin = rejectUnauthorizedAdmin(req);
    if (admin) {
      res.status(admin.status).json({ error: admin.error });
      return;
    }
    if (!isMongoConfigured()) {
      res.status(400).json({
        error:
          "MongoDB is not configured (MONGODB_URI). Custom rates need a database to persist.",
      });
      return;
    }
    const parsed = sanitizeCustomCosts(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await saveCustomCosts(parsed.costs);
    setEffectiveCosts(
      { ...META_MODEL_COSTS, ...parsed.costs.rates },
      parsed.costs.modalPerSec
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save cost table." });
  }
});

/**
 * Free-usage meter for the onboarding page: percent remaining of the $200
 * pool, i.e. 1 - sum(costUsd) / budget. Without Mongo there is no tracked
 * spend, so the pool reads as untouched.
 */
app.get("/api/usage", async (_req, res) => {
  try {
    const totalCost = await getTotalMeteredCost();
    res.json({
      totalCostUsd: totalCost,
      budgetUsd: FREE_BUDGET_USD,
      remainingPct: remainingFreePct(totalCost),
    });
  } catch {
    res.status(500).json({ error: "Failed to load usage." });
  }
});

app.delete("/api/costs", async (req, res) => {
  try {
    const admin = rejectUnauthorizedAdmin(req);
    if (admin) {
      res.status(admin.status).json({ error: admin.error });
      return;
    }
    if (!isMongoConfigured()) {
      res.status(400).json({ error: "MongoDB is not configured (MONGODB_URI)." });
      return;
    }
    await clearCustomCosts();
    resetEffectiveCosts();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to reset cost table." });
  }
});

// Apply saved custom rates on startup (validated; corrupt docs fall back
// to built-ins rather than breaking metering).
void loadCustomCosts().then((custom) => {
  if (!custom) return;
  const parsed = sanitizeCustomCosts({
    rates: custom.rates,
    modalPerSec: custom.modalPerSec,
  });
  if (parsed.ok) {
    setEffectiveCosts(
      { ...META_MODEL_COSTS, ...parsed.costs.rates },
      parsed.costs.modalPerSec
    );
    console.log("[costs] applied saved custom rates.");
  } else {
    console.warn(`[costs] ignoring invalid saved rates: ${parsed.error}`);
  }
});

// One aggregator for Modal chunk jobs: each chunk adds its measured
// duration; the `isLast` chunk (or TTL expiry) logs exactly one row.
const modalJobs = new ModalJobAggregator();

/**
 * Meter one Modal chunk. Chunked jobs (jobId set) accumulate durations and
 * log exactly one row on `isLast` (or on TTL expiry for aborted runs).
 * Single-shot calls without a jobId log immediately. Local backends are
 * never metered (free, no usage to report).
 */
function recordModalChunk(opts: {
  jobId?: unknown;
  isLast?: unknown;
  userId: string;
  kind: string;
  model: string;
  durationMs: number;
  allowed?: boolean;
}): void {
  if (opts.allowed === false) return;
  const jobId =
    typeof opts.jobId === "string" ? opts.jobId.trim().slice(0, 128) : "";
  const row = {
    userId: opts.userId,
    kind: opts.kind,
    model: opts.model,
    backend: "modal" as const,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: Math.max(0, Math.round(opts.durationMs)),
    costUsd: 0,
  };
  if (!jobId) {
    row.costUsd = modalCostUsd(row.durationMs);
    void logMetering(row);
    return;
  }
  modalJobs.addChunk(jobId, {
    userId: row.userId,
    kind: row.kind,
    model: row.model,
    durationMs: row.durationMs,
  });
  if (opts.isLast === true) {
    const total = modalJobs.completeJob(jobId);
    if (total) {
      void logMetering({
        userId: total.userId,
        kind: total.kind,
        model: total.model,
        backend: "modal",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: total.totalMs,
        costUsd: modalCostUsd(total.totalMs),
      });
    }
  }
}
setInterval(() => {
  const expired = modalJobs.sweepExpired();
  for (const job of expired) {
    void logMetering({
      userId: job.userId,
      kind: job.kind,
      model: job.model,
      backend: "modal",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: job.totalMs,
      costUsd: modalCostUsd(job.totalMs),
    });
  }
}, 5 * 60 * 1000).unref?.();

/** Meta Model API base URL. The key lives only in the server .env. */
const META_API_BASE_URL = "https://api.meta.ai/v1";

/**
 * Muse models emit private reasoning tokens before visible output, so the
 * default effort delays the first streamed token by seconds. Summaries,
 * extraction, and stitching don't need deep reasoning — "low" keeps
 * time-to-first-token (and cost) down. See
 * https://dev.meta.ai/docs/reasoning
 */
const REASONING_EFFORT = "low";

function metaApiKey(): string {
  return (process.env.MODEL_API_KEY || "").trim();
}

export interface MeterContext {
  userId: string;
  kind: string;
  /** False when the user disabled logging (skip all writes). */
  allowed: boolean;
  /**
   * Aborted when the browser goes away (stop button, navigation, or a
   * superseded StrictMode remount). Threaded into Meta fetches so an
   * abandoned run stops spending quota instead of running to completion.
   */
  signal?: AbortSignal;
}

async function callLLM(
  config: ModelEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: { name: string; schema: Record<string, unknown> },
  meter?: MeterContext
): Promise<string> {
  const started = Date.now();
  const apiKey = metaApiKey();
  const model = config.model.trim();
  if (!model) {
    throw new Error("No Meta model selected. Pick one in Settings → Models.");
  }
  if (!apiKey) {
    throw new Error(
      "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai)."
    );
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    reasoning_effort: REASONING_EFFORT,
    ...(jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: jsonSchema.name, schema: jsonSchema.schema },
          },
        }
      : {}),
  };

  // The rate-limit docs ask clients to retry 429s with exponential
  // backoff + jitter and to honor Retry-After.
  const MAX_429_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${META_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: meter?.signal,
    });

    if (resp.ok) {
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Record<string, unknown>;
      };
      if (meter && meter.allowed) {
        // Token counts come straight from the Meta response; unknown
        // models have no cost-table entry and log $0.
        const usage = parseMetaUsage(data);
        const durationMs = Date.now() - started;
        void logMetering({
          userId: meter.userId,
          kind: meter.kind,
          model,
          backend: "meta",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs,
          costUsd: metaCostUsd(
            model,
            usage.inputTokens,
            usage.cachedInputTokens,
            usage.outputTokens
          ),
        });
      }
      return (data.choices?.[0]?.message?.content || "").trim();
    }

    const errText = await resp.text();
    if (resp.status !== 429 || attempt >= MAX_429_RETRIES) {
      throw new Error(
        `Meta Model API Error (${resp.status}): ${errText.slice(0, 400)}`
      );
    }
    const retryAfterSec = Number(resp.headers.get("retry-after"));
    const waitMs = retryDelayMs(
      attempt,
      Number.isFinite(retryAfterSec) ? retryAfterSec : null
    );
    console.log(
      `[meta] rate limited (429) on ${model}, retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 2}/${MAX_429_RETRIES + 1})`
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

let serverZeroShotClassifier: any = null;
let serverZeroShotLoadingPromise: Promise<any> | null = null;

async function getServerZeroShotClassifier() {
  if (serverZeroShotClassifier) return serverZeroShotClassifier;
  if (!serverZeroShotLoadingPromise) {
    serverZeroShotLoadingPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      serverZeroShotClassifier = await pipeline(
        "zero-shot-classification",
        "onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX",
        { dtype: "q8" }
      );
      return serverZeroShotClassifier;
    })();
  }
  return serverZeroShotLoadingPromise;
}

let serverNerExtractor: any = null;
let serverNerTokenizer: any = null;
let serverNerLoadingPromise: Promise<any> | null = null;

/**
 * Bump whenever the entity reconstruction logic changes (1 = naive
 * aggregation join, 2 = span-fill recovery, 3 = word-atomic spans,
 * 4 = list coordination merge + hyphen-joined recovery,
 * 5 = coordinations enumerate distinct entities; only City, ST places merge,
 * 6 = span confidence scores recorded for the Settings score floor,
 * 7 = word scores average fragment support (untagged siblings dampen lone votes),
 * 8 = XLM-RoBERTa NER (quantized ONNX) with markerless word runs + DATE labels,
 * 9 = RoBERTa-large NER with byte-level BPE Ġ word runs,
 * 10 = punctuation gaps bridge only off lettered anchors; standalone
 * sentence connectives ("However") are dropped,
 * 11 = newlines split word runs (section labels no longer fuse into names),
 * 12 = markdown stripped before NER; spaced joins after .?! split as
 * sentence boundaries (abbreviations excepted),
 * 13 = JSON blobs and UUIDs stripped before NER; names capped at 120 chars,
 * 14 = list separators split word runs (coordinations enumerate again);
 * tagged punctuation never votes on a word's type,
 * 15 = query strings/templates stripped before NER; punctuation-only BPE
 * fragments (list closers, "=", "{{") never glue words or bridge groups;
 * spans containing assignments or fused list boundaries are rejected,
 * 16 = Davlan XLM-RoBERTa-base NER (quantized ONNX, markerless word runs,
 * BIO + DATE labels) replaces RoBERTa-large,
 * 17 = comma places merge only on known region codes ("Berkeley, CA"
 * stays whole; "Canada, UK" splits into two places),
 * 18 = CJK/ASCII spacing isolated before NER ("周末要去 whistler 滑雪")
 * so mixed-script blobs no longer fuse into one entity; every truncation
 * backs off to a full word (spaceless text backs off ASCII runs, never
 * splits surrogate pairs).
 * The Load page stores this per chat alongside its content hash and only
 * reprocesses chats whose record is missing, stale, or from an older version.
 */
const NER_EXTRACTOR_VERSION = 18;

/**
 * Token-classification model for NER (extractor and tokenizer agree):
 * Davlan/xlm-roberta-base-ner-hrl via the pre-exported ONNX port
 * (tjruesch/xlm-roberta-base-ner-hrl-onnx), assembled once into a local
 * dir (scripts/prepare_xlm_ner.py, one-time ~1.4GB); resolved from this
 * file so the server's working directory doesn't matter.
 */
const NER_MODEL_ID = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "models",
  "xlm-roberta-base-ner-hrl"
);

async function getServerNerExtractor() {
  if (serverNerExtractor) return serverNerExtractor;
  if (!serverNerLoadingPromise) {
    serverNerLoadingPromise = (async () => {
      if (
        !fs.existsSync(path.join(NER_MODEL_ID, "onnx", "model_quantized.onnx")) &&
        !fs.existsSync(path.join(NER_MODEL_ID, "onnx", "model.onnx"))
      ) {
        throw new Error(
          `XLM-R NER weights missing at ${NER_MODEL_ID} — run: npm run prepare:ner`
        );
      }
      const { pipeline, env, AutoTokenizer } = await import(
        "@huggingface/transformers"
      );
      env.allowLocalModels = true;
      try {
        serverNerExtractor = await pipeline(
          "token-classification",
          NER_MODEL_ID,
          { dtype: "q8" }
        );
      } catch (err) {
        // Quantized load failed (e.g. only FP32 was fetched): fall back
        // to full precision rather than failing all NER.
        console.warn(
          `[ner] quantized load failed for ${NER_MODEL_ID}, retrying full precision:`,
          err instanceof Error ? err.message : err
        );
        serverNerExtractor = await pipeline(
          "token-classification",
          NER_MODEL_ID
        );
      }
      serverNerTokenizer = await AutoTokenizer.from_pretrained(NER_MODEL_ID);
      return serverNerExtractor;
    })();
  }
  return serverNerLoadingPromise;
}

/**
 * Modal-hosted NER+NLI (modal/modal_deploy.py /analyze). Config lives only
 * in the server .env: MODAL_ANALYZE_URL is the full deployed endpoint URL
 * (including /analyze) and EXTBRAIN_API_SECRET must match the value in the
 * Modal extbrain-auth secret (same name both sides; legacy MODAL_API_SECRET
 * still works as a fallback). Neither value ever reaches the client.
 */
function modalConfig(): { url: string; secret: string } {
  return {
    url: (process.env.MODAL_ANALYZE_URL || "").trim().replace(/\/+$/, ""),
    secret: (
      process.env.EXTBRAIN_API_SECRET ||
      process.env.MODAL_API_SECRET ||
      ""
    ).trim(),
  };
}

function modalReady(): boolean {
  const { url, secret } = modalConfig();
  return url.length > 0 && secret.length > 0;
}

/**
 * Processor version for Modal NER. Separate space from the local
 * NER_EXTRACTOR_VERSION (records also stamp which backend produced them,
 * so switching backends reprocesses regardless of numbers). Bump when the
 * NER logic in modal/modal_deploy.py changes.
 */
const MODAL_NER_EXTRACTOR_VERSION = 1;

async function callModalAnalyze(body: ModalAnalyzeBody): Promise<unknown[]> {
  const { url, secret } = modalConfig();
  if (!url || !secret) {
    throw new Error(
      "Modal backend selected but the server has no MODAL_ANALYZE_URL / EXTBRAIN_API_SECRET configured (server .env)."
    );
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ExtBrain-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(
      `Modal /analyze failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`
    );
  }
  const data = (await resp.json()) as { results?: unknown };
  if (!Array.isArray(data.results)) {
    throw new Error(
      "Modal /analyze returned an unexpected shape (missing results array)."
    );
  }
  return data.results;
}

app.post("/api/extract-entities-batch", async (req, res) => {
  try {
    const { items, backend, jobId, isLast } = req.body as {
      items: Array<{ id: string; text: string }>;
      backend?: string;
      jobId?: string;
      isLast?: boolean;
    };
    if (!items || items.length === 0) {
      res.json({ results: [] });
      return;
    }

    // Legacy "modal-gliner" tolerated for in-flight clients mid-upgrade.
    if (backend === "modal" || backend === "modal-gliner") {
      const started = Date.now();
      const normalized = normalizeModalResults(
        await callModalAnalyze(
          buildModalNerBody(items.map((e) => e.text || ""))
        ),
        items.length
      );
      if (!normalized) {
        throw new Error(
          `Modal /analyze returned a misaligned batch for ${items.length} texts.`
        );
      }
      recordModalChunk({
        jobId,
        isLast,
        userId: reqUid(req),
        allowed: !isOptedOut(req),
        kind: "modal-ner",
        model: "modal",
        durationMs: Date.now() - started,
      });
      res.json({
        results: items.map((entry, i) => ({
          id: entry.id,
          entities: mapModalEntities(normalized[i].entities),
        })),
      });
      return;
    }

    await getServerNerExtractor();
    const extractor = serverNerExtractor;
    const tokenizer = serverNerTokenizer;
    const results: Array<{
      id: string;
      entities: Array<{ text: string; label: string; score: number }>;
    }> = [];

    for (const entry of items) {
      const text = truncateAtWordBoundary(entry.text || "", 2000);
      if (!text.trim()) {
        results.push({ id: entry.id, entities: [] });
        continue;
      }
      // Raw per-token output (no aggregation): transformers.js "simple"
      // aggregation joins only the tagged token surfaces and silently drops
      // O-tagged fragments in the middle, fabricating strings that never
      // appeared ("myhoros" -> "MHOROS"). Rebuild each entity from its full
      // token span instead, filling skipped fragments from our own
      // tokenization of the same text.
      const out: any = await extractor(text);
      const tokens: NerRawToken[] = Array.isArray(out) ? out : [];
      let surfaces: string[] | null = null;
      try {
        const tokOut: any = await tokenizer(text);
        // Token ids can come back as BigInts (the tokenizer uses int64);
        // decode needs plain numbers.
        const ids: number[] = Array.from(
          tokOut.input_ids?.data ?? tokOut.input_ids ?? []
        ).map((v) => Number(v));
        surfaces = ids.map((id) => {
          try {
            return tokenizer.decode([id]);
          } catch {
            return "";
          }
        });
      } catch {
        surfaces = null;
      }
      const proj = projectTextAlnum(text);
      const entities: Array<{ text: string; label: string; score: number }> =
        [];
      if (surfaces) {
        // Word-atomic spans: fragments can never stand alone, so trailing or
        // mid-word O-tagged pieces are recovered as part of their word
        // instead of being dropped into fabrications. RoBERTa per-id decodes
        // carry Ġ word-start markers, which nerWordRuns groups on (it takes
        // the same text for the markerless fallback).
        for (const g of groupNerWords(nerWordRuns(surfaces, tokens, text))) {
          const span = recoverSpanText(text, proj, surfaces, g.lo, g.hi);
          if (!span) continue;
          // Bare names only: strip link syntax, then drop letter-less
          // mistags ("298-7775"), URL-only spans (cleaned to ""),
          // standalone connectives ("However"), and fused-blob monsters.
          const name = cleanEntityText(span);
          if (
            !name ||
            name.length > MAX_ENTITY_NAME_CHARS ||
            !hasNameLetters(name) ||
            !isPlausibleEntityName(name) ||
            isCommonConnective(name)
          ) {
            continue;
          }
          entities.push({ text: name, label: g.type, score: g.score });
        }
      }
      results.push({ id: entry.id, entities });
    }

    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/generate-nli-labels", async (req, res) => {
  try {
    const { projectQuery, modelConfig } = req.body as {
      projectQuery: string;
      modelConfig: ModelEndpointConfig;
    };

    if (!projectQuery || !projectQuery.trim()) {
      res.status(400).json({ error: "Missing project description." });
      return;
    }

    if (rejectDisallowedModel(res, modelConfig?.model)) return;

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You generate NLI zero-shot evaluation labels for multilingual-MiniLMv2-L6-mnli-xnli (multilingual NLI).
CRITICAL NLI RULE: If the user names a specific project, brand, or domain, the FIRST target_label MUST include that exact name (e.g. "user acquisition optimization for myhoros.com"), because chats explicitly about the project should match strongly. ALSO include 1-2 broader functional/topic phrases WITHOUT the brand/domain name, so follow-up turns that omit the name still match (scoring takes the best match across all labels).
Return strict JSON only with "tag_name", "target_labels", "contrast_labels", "date_start", and "date_end".`;

    const userPrompt = `The user wants to find chat logs about: "${projectQuery.trim()}".
Today is ${today}.

Generate a JSON object with:
- "tag_name": a short 2 to 4 word tag name for this topic (no hashtags; keep the project/domain name if the user named one, e.g. "myhoros acquisition").
- "target_labels": 3 descriptive phrases capturing the target intent (use rich semantic context, not single words). The FIRST label must include the exact project/brand/domain name when the user named one; the remaining labels must be broader functional phrases WITHOUT the name, so follow-up turns that omit it still match.
- "contrast_labels": 2 to 3 plausible distractor topics that might share keywords but represent different intents to exclude.
- "date_start" / "date_end": the evaluation window as YYYY-MM-DD dates inferred from the description relative to today (e.g. "in the last month" means the past 30 days). Use null when the description implies no time bound.

Output strict JSON only:
{
  "tag_name": "myhoros acquisition",
  "target_labels": [
    "user acquisition optimization for myhoros.com",
    "paid user acquisition, marketing spend, and ad campaigns",
    "conversion tracking, CAC, and ad performance optimization"
  ],
  "contrast_labels": [
    "website monetization, displaying ads for revenue, and ad network scripts",
    "general software bugs and server infrastructure setup",
    "casual everyday chat"
  ],
  "date_start": null,
  "date_end": null
}`;

    const raw = await callLLM(modelConfig, systemPrompt, userPrompt, {
      name: "nli_labels",
      schema: {
        type: "object",
        properties: {
          tag_name: { type: "string" },
          target_labels: { type: "array", items: { type: "string" } },
          contrast_labels: { type: "array", items: { type: "string" } },
          date_start: { type: ["string", "null"] },
          date_end: { type: ["string", "null"] },
        },
        required: [
          "tag_name",
          "target_labels",
          "contrast_labels",
          "date_start",
          "date_end",
        ],
        additionalProperties: false,
      },
    },
      { userId: reqUid(req), kind: "tag-labels", allowed: !isOptedOut(req) });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM did not return valid JSON for NLI labels.");
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      tag_name?: string;
      target_labels?: string[];
      contrast_labels?: string[];
      date_start?: string | null;
      date_end?: string | null;
    };

    const cleanDate = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const s = v.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const d = new Date(s + "T00:00:00Z");
      return isNaN(d.getTime()) ? null : s;
    };
    let dateStart = cleanDate(parsed.date_start);
    let dateEnd = cleanDate(parsed.date_end);
    if (dateStart && dateEnd && dateEnd < dateStart) {
      [dateStart, dateEnd] = [dateEnd, dateStart];
    }

    res.json({
      tag_name: (parsed.tag_name || "").trim() || "untagged topic",
      target_labels: (parsed.target_labels || [])
        .map((s) => s.trim())
        .filter(Boolean),
      contrast_labels: (parsed.contrast_labels || [])
        .map((s) => s.trim())
        .filter(Boolean),
      date_start: dateStart,
      date_end: dateEnd,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/classify-entry", async (req, res) => {
  try {
    const { text, labels } = req.body as { text: string; labels: string[] };
    const cleanLabels = (labels || []).map((l) => l.trim()).filter(Boolean);
    if (!text || cleanLabels.length === 0) {
      res.json({ scores: {} });
      return;
    }
    const clf = await getServerZeroShotClassifier();
    const out: any = await clf(text, cleanLabels, {
      multi_label: true,
      hypothesis_template:
        "The user's task or goal in this conversation is related to {}",
    });
    const single = Array.isArray(out) ? out[0] : out;
    const scoreMap: Record<string, number> = {};
    if (single && Array.isArray(single.labels) && Array.isArray(single.scores)) {
      for (let i = 0; i < single.labels.length; i++) {
        scoreMap[single.labels[i]] = single.scores[i];
      }
    }
    res.json({ scores: scoreMap });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/classify-batch", async (req, res) => {
  try {
    const { items, labels, multiLabel, backend, jobId, isLast } = req.body as {
      items: Array<{ id: string; text: string }>;
      labels: string[];
      multiLabel?: boolean;
      backend?: string;
      jobId?: string;
      isLast?: boolean;
    };
    const cleanLabels = (labels || []).map((l) => l.trim()).filter(Boolean);
    if (!items || items.length === 0 || cleanLabels.length === 0) {
      res.json({ results: [] });
      return;
    }
    // Tags score target/contrast labels independently (multi-label); the
    // category taxonomy picks exactly one label (softmaxed single-label).
    const multi = multiLabel !== false;

    // Legacy "modal-bge-m3" tolerated for in-flight clients mid-upgrade.
    if (backend === "modal" || backend === "modal-bge-m3") {
      const started = Date.now();
      const normalized = normalizeModalResults(
        await callModalAnalyze(
          buildModalNliBody(
            items.map((e) => e.text || ""),
            cleanLabels,
            multi
          )
        ),
        items.length
      );
      if (!normalized) {
        throw new Error(
          `Modal /analyze returned a misaligned batch for ${items.length} texts.`
        );
      }
      recordModalChunk({
        jobId,
        isLast,
        userId: reqUid(req),
        allowed: !isOptedOut(req),
        kind: "modal-nli",
        model: "modal",
        durationMs: Date.now() - started,
      });
      res.json({
        results: items.map((entry, i) => ({
          id: entry.id,
          scores: mapModalScores(normalized[i].scores, cleanLabels),
        })),
      });
      return;
    }

    const clf = await getServerZeroShotClassifier();
    const opts = {
      multi_label: multi,
      hypothesis_template:
        "The user's task or goal in this conversation is related to {}",
    };
    const scoreOne = async (text: string): Promise<Record<string, number>> => {
      const out: any = await clf(text, cleanLabels, opts);
      const single = Array.isArray(out) ? out[0] : out;
      const scoreMap: Record<string, number> = {};
      if (
        single &&
        Array.isArray(single.labels) &&
        Array.isArray(single.scores)
      ) {
        for (let i = 0; i < single.labels.length; i++) {
          scoreMap[single.labels[i]] = single.scores[i];
        }
      }
      return scoreMap;
    };

    const results: Array<{ id: string; scores: Record<string, number> }> = [];
    // One pipeline call for the whole micro-batch lets the model batch
    // internally instead of paying per-chat overhead N times. If the
    // output shape ever mismatches, fall back to one call per chat —
    // slower, but scores can never misalign to the wrong chat.
    const batched = normalizeZeroShotBatch(
      await clf(
        items.map((e) => e.text),
        cleanLabels,
        opts
      ),
      items.length
    );
    if (batched) {
      for (let i = 0; i < items.length; i++) {
        results.push({ id: items[i].id, scores: batched[i] });
      }
    } else {
      console.log(
        `[meta] zero-shot batch shape mismatch, falling back to sequential (${items.length} chats)`
      );
      for (const entry of items) {
        results.push({ id: entry.id, scores: await scoreOne(entry.text) });
      }
    }

    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    nerExtractorVersion: NER_EXTRACTOR_VERSION,
    modalNerVersion: MODAL_NER_EXTRACTOR_VERSION,
    modalReady: modalReady(),
    hasServerMetaKey: Boolean(process.env.MODEL_API_KEY),
  });
});

/**
 * Link metadata (favicon / title / description) for URL preview chips and
 * hover cards. The browser can't read cross-origin pages, so the server
 * fetches the page, extracts <head> metadata, and caches the result.
 */
interface UrlMetadataPayload {
  url: string;
  host: string;
  title: string;
  description: string;
  favicon: string;
  error?: string;
}

const URL_META_CACHE = new Map<
  string,
  { value: UrlMetadataPayload; expires: number }
>();
const URL_META_TTL_MS = 30 * 60 * 1000;
const URL_META_CACHE_MAX = 500;
const URL_FETCH_TIMEOUT_MS = 8000;
const URL_FETCH_CAP_BYTES = 400 * 1024;

/** Only public http(s) targets; blocks loopback/private/link-local hosts. */
function safeFetchTarget(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h.includes(":")) return null; // any IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null; // any IPv4 literal
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return null;
  }
  return u;
}

function safeHostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Follows redirects manually so every hop is re-validated by safeFetchTarget. */
async function fetchWithRedirectGuard(
  target: URL,
  signal: AbortSignal
): Promise<Response> {
  let current = target;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(current.href, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ExtBrainPreview/1.0; +link metadata)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      let next: URL;
      try {
        next = new URL(loc, current.href);
      } catch {
        return resp;
      }
      const safe = safeFetchTarget(next.href);
      if (!safe) throw new Error("Blocked redirect target.");
      current = safe;
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects.");
}

/** Reads at most `capBytes` of the body (metadata lives in <head>, early on). */
async function readCappedText(
  resp: Response,
  capBytes: number
): Promise<string> {
  const body = resp.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let received = 0;
  try {
    while (received < capBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(
      /&([a-z][a-z0-9]*);/gi,
      (m: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m
    );
}

function cleanMetaText(s: string, cap: number): string {
  const t = decodeHtmlEntities(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > cap ? t.slice(0, cap - 1).trimEnd() + "…" : t;
}

function firstMatch(s: string, re: RegExp): string {
  const m = s.match(re);
  return m?.[1] ?? "";
}

/** content= of the first <meta> whose name/property matches `keys`. */
function metaTagContent(html: string, keys: string[]): string {
  const keyRe = new RegExp(
    `(?:name|property)\\s*=\\s*["']\\s*(?:${keys.join("|")})\\s*["']`,
    "i"
  );
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!keyRe.test(tag)) continue;
    const content = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (content) return content[1] ?? content[2] ?? "";
  }
  return "";
}

/** First <link rel~icon> href, resolved absolute against the final URL. */
function pageFavicon(html: string, base: string): string {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tag.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const relVal = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase();
    if (!relVal.includes("icon")) continue;
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const hrefVal = href?.[1] ?? href?.[2];
    if (!hrefVal) continue;
    try {
      return new URL(hrefVal, base).href;
    } catch {
      // skip invalid href
    }
  }
  return "";
}

app.get("/api/url-metadata", async (req, res) => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  const target = safeFetchTarget(raw);
  if (!target) {
    res.status(400).json({ error: "Invalid or disallowed URL." });
    return;
  }
  const key = target.href;
  const hit = URL_META_CACHE.get(key);
  if (hit && hit.expires > Date.now()) {
    res.json(hit.value);
    return;
  }

  let payload: UrlMetadataPayload;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchWithRedirectGuard(target, ctrl.signal);
      const finalUrl = resp.url || target.href;
      const host = safeHostOf(finalUrl) || safeHostOf(target.href);
      const ctype = (resp.headers.get("content-type") || "").toLowerCase();
      if (!resp.ok) {
        payload = {
          url: finalUrl,
          host,
          title: host,
          description: "",
          favicon: "",
          error: `HTTP ${resp.status}`,
        };
      } else if (
        ctype !== "" &&
        !ctype.includes("html") &&
        !ctype.includes("xml") &&
        !ctype.startsWith("text/")
      ) {
        // Not a page (PDF, image, JSON, …): nothing to preview beyond the host.
        payload = { url: finalUrl, host, title: host, description: "", favicon: "" };
      } else {
        const body = await readCappedText(resp, URL_FETCH_CAP_BYTES);
        const title = cleanMetaText(
          firstMatch(body, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
            metaTagContent(body, ["og:title", "twitter:title"]),
          160
        );
        const description = cleanMetaText(
          metaTagContent(body, [
            "description",
            "og:description",
            "twitter:description",
          ]),
          400
        );
        payload = {
          url: finalUrl,
          host,
          title: title || host,
          description,
          favicon: pageFavicon(body, finalUrl),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const host = safeHostOf(target.href);
    payload = {
      url: target.href,
      host,
      title: host,
      description: "",
      favicon: "",
      error: message,
    };
  }

  URL_META_CACHE.set(key, {
    value: payload,
    expires: Date.now() + URL_META_TTL_MS,
  });
  if (URL_META_CACHE.size > URL_META_CACHE_MAX) {
    const oldest = URL_META_CACHE.keys().next().value;
    if (oldest !== undefined) URL_META_CACHE.delete(oldest);
  }
  res.json(payload);
});

/**
 * STAGE 1: Project Discovery & Multi-Week Entity Stitching
 */
app.post("/api/discover", async (req, res) => {
  try {
    const {
      projectQuery,
      compactCards,
      localSeedMatches,
      localDiscoveredEntities,
      modelConfig,
    } = req.body as {
      projectQuery: string;
      compactCards: CompactIndexCard[];
      localSeedMatches: MatchedItemResult[];
      localDiscoveredEntities: string[];
      modelConfig: ModelEndpointConfig;
    };

    const apiKey = metaApiKey();

    // If no API key is configured, return the local two-hop entity snowball result immediately
    if (!apiKey) {
      res.json({
        mode: "local_snowball",
        matches: localSeedMatches,
        discoveredEntities: localDiscoveredEntities,
        notice:
          "Used local 2-Hop Entity Snowballing (set MODEL_API_KEY in the server .env to enable LLM semantic stitching).",
      });
      return;
    }

    // Only enforced when a Meta call will actually happen (see above).
    if (rejectDisallowedModel(res, modelConfig?.model)) return;

    const systemPrompt = `You are an expert Project Thread Stitcher for Google Takeout AI chat histories.
Your job is to identify ALL activity entries belonging to the user's target project across weeks or months, even when follow-up chats omit the project name.

HOW TO STITCH RELEVANT CHATS ACROSS WEEKS:
1. ANCHOR DISCOVERY (Hop 1): Find entries that directly mention the project name, domain, or core topic in either the user's prompt OR the AI's key points.
2. ENTITY SNOWBALLING (Hop 2): From the anchor entries, identify the specific platforms, ad networks, tools, or sub-problems being used for that project (e.g., "ChatGPT Ads", "OpenAI Ads", "Maximize Results", "oCPC", "ChatGPT Go tier"). Include all entries across ANY date that research or troubleshoot those connected entities for the project.
3. SESSION CONTINUITY (Hop 3): Include immediate follow-up prompts from the same session if they continue the same thread, but EXCLUDE unrelated topic switches (e.g., shipping carriers, movies, recipes) even if they happened on the same day.

Return ONLY valid JSON with this exact structure:
{
  "discoveredEntities": ["entity1", "entity2"],
  "matches": [
    {
      "id": "entry_id",
      "matchType": "anchor" | "entity_snowball" | "session_stitch",
      "reason": "Short 1-line explanation of why this entry belongs to the project"
    }
  ]
}`;

    const userPrompt = `TARGET PROJECT DESCRIPTION:
"${projectQuery}"

LOCAL 2-HOP SEED ENTITIES DETECTED:
${JSON.stringify(localDiscoveredEntities)}

COMPACT ACTIVITY INDEX (${compactCards.length} entries, ordered oldest to newest):
${JSON.stringify(compactCards, null, 2)}`;

    const rawResponse = await callLLM(modelConfig, systemPrompt, userPrompt, {
      name: "discovery_matches",
      schema: {
        type: "object",
        properties: {
          discoveredEntities: { type: "array", items: { type: "string" } },
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                matchType: {
                  type: "string",
                  enum: ["anchor", "entity_snowball", "session_stitch"],
                },
                reason: { type: "string" },
              },
              required: ["id", "matchType", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["discoveredEntities", "matches"],
        additionalProperties: false,
      },
    },
      { userId: reqUid(req), kind: "discover", allowed: !isOptedOut(req) });

    // Extract JSON block safely
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Model did not return valid JSON during discovery.");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      discoveredEntities?: string[];
      matches?: MatchedItemResult[];
    };

    // Merge LLM matches with any strong local anchor matches so nothing is dropped
    const mergedMap = new Map<string, MatchedItemResult>();
    for (const m of localSeedMatches) {
      if (m.matchType === "anchor") {
        mergedMap.set(m.id, m);
      }
    }
    for (const m of parsed.matches || []) {
      if (m && m.id) {
        mergedMap.set(m.id, {
          id: m.id,
          matchType: m.matchType || "entity_snowball",
          reason: m.reason || "Matched by LLM discovery",
        });
      }
    }

    const entitySet = new Set<string>([
      ...(parsed.discoveredEntities || []),
      ...(localDiscoveredEntities || []),
    ]);

    res.json({
      mode: "llm",
      matches: Array.from(mergedMap.values()),
      discoveredEntities: Array.from(entitySet).slice(0, 20),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * STAGE 2: Asymmetric Context Synthesis (Single-Call or Adaptive Multi-Batch Merge)
 */
app.post("/api/synthesize", async (req, res) => {
  // Same client-gone protection as the streaming endpoint: an abandoned
  // (navigated-away, superseded) request stops its Meta calls instead of
  // burning quota to completion.
  const clientGone = new AbortController();
  // NOTE: this must watch the *response*, not the request: req 'close'
  // fires as soon as Express finishes reading the POST body, which would
  // wrongly cancel every run. res 'close' before writableEnded means the
  // browser actually went away.
  const onClientClose = () => {
    if (!res.writableEnded) clientGone.abort();
  };
  res.on("close", onClientClose);
  try {
    const {
      projectQuery,
      batches,
      systemInstruction,
      modelConfig,
    } = req.body as {
      projectQuery: string;
      batches: string[];
      systemInstruction: string;
      modelConfig: ModelEndpointConfig;
    };

    if (!batches || batches.length === 0) {
      res.status(400).json({ error: "No packed chat batches provided." });
      return;
    }

    if (rejectDisallowedModel(res, modelConfig?.model)) return;

    // Case 1: Single batch (typical for 1 - 150 chats with Asymmetric Packing) -> 1 LLM Call
    if (batches.length === 1) {
      const userPrompt = `PROJECT TOPIC: "${projectQuery}"

CHRONOLOGICAL ASYMMETRICALLY-PACKED PROJECT CHATS (100% verbatim user prompts + condensed AI context):
${batches[0]}

Generate the requested project summary in clean Obsidian Markdown.`;

      const markdown = await callLLM(
        modelConfig,
        systemInstruction,
        userPrompt,
        undefined,
        {
          userId: reqUid(req),
          kind: "synthesize",
          allowed: !isOptedOut(req),
          signal: clientGone.signal,
        }
      );

      res.json({
        markdown,
        llmCallsMade: 1,
        batchCount: 1,
      });
      return;
    }

    // Case 2: Huge project (>150 chats) -> Extract chronological milestones per batch, then 1 final synthesis merge
    const intermediateExtractions: string[] = [];
    for (let i = 0; i < batches.length; i++) {
      const batchExtractSystem = `You are extracting factual chronological project notes from Batch ${
        i + 1
      } of ${batches.length} for the project "${projectQuery}".
Preserve all exact timestamps, user-shared metrics, campaign names, errors, config snippets, and decisions verbatim.`;

      const batchExtractUser = `Extract all chronological events, user prompts, metrics, and outcomes from Batch ${
        i + 1
      }:\n\n${batches[i]}`;

      const partial = await callLLM(
        modelConfig,
        batchExtractSystem,
        batchExtractUser,
        undefined,
        {
          userId: reqUid(req),
          kind: "synthesize-extract",
          allowed: !isOptedOut(req),
          signal: clientGone.signal,
        }
      );
      intermediateExtractions.push(
        `### Extracted Chronological Notes (Batch ${i + 1}/${batches.length})\n${partial}`
      );
    }

    const finalMergeUser = `PROJECT TOPIC: "${projectQuery}"

Below are the chronological milestone extractions across ${batches.length} batches of chat history.
Synthesize them into a single unified project summary following the system instructions:\n\n${intermediateExtractions.join(
      "\n\n---\n\n"
    )}`;

    const finalMarkdown = await callLLM(
      modelConfig,
      systemInstruction,
      finalMergeUser,
      undefined,
      {
        userId: reqUid(req),
        kind: "synthesize",
        allowed: !isOptedOut(req),
        signal: clientGone.signal,
      }
    );

    res.json({
      markdown: finalMarkdown,
      llmCallsMade: batches.length + 1,
      batchCount: batches.length,
    });
  } catch (err: unknown) {
    if (!clientGone.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    } else {
      console.log("[meta] synthesize aborted by client; Meta calls cancelled.");
    }
  } finally {
    res.off("close", onClientClose);
  }
});

/**
 * Streams one completion over the Responses API. Visible text goes to
 * onDelta; the model's reasoning summary (requested, so it arrives before
 * output) accumulates into onStatus for live progress display.
 */
async function streamLLMToSSE(
  config: ModelEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  onDelta: (text: string) => void,
  onStatus: (text: string) => void,
  meter?: MeterContext
): Promise<void> {
  const started = Date.now();
  const apiKey = metaApiKey();
  const model = config.model.trim();
  if (!model) {
    throw new Error("No Meta model selected. Pick one in Settings → Models.");
  }
  if (!apiKey) {
    throw new Error(
      "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai)."
    );
  }
  const resp = await fetch(`${META_API_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: meter?.signal,
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: userPrompt,
      temperature: 0.2,
      reasoning: { effort: REASONING_EFFORT, summary: "auto" },
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Meta Model API Error (${resp.status}): ${errText.slice(0, 400)}`
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let statusAcc = "";
  let textDeltas = 0;
  let statusDeltas = 0;
  let streamUsage: { input: number; cached: number; output: number } | null =
    null;
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
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore partial frames
      }
      if (
        json?.type === "response.output_text.delta" &&
        typeof json.delta === "string" &&
        json.delta
      ) {
        textDeltas++;
        onDelta(json.delta);
      } else if (
        json?.type === "response.reasoning_summary_text.delta" &&
        typeof json.delta === "string" &&
        json.delta
      ) {
        statusDeltas++;
        statusAcc += json.delta;
        onStatus(statusAcc);
      } else if (json?.type === "response.failed") {
        const msg =
          json.response?.error?.message ||
          json.error?.message ||
          "Meta response failed during streaming.";
        throw new Error(`Meta Model API Error: ${String(msg).slice(0, 400)}`);
      } else if (json?.type === "response.completed") {
        // The Responses API reports totals on completion (not per delta).
        const u = (json.response as { usage?: unknown } | undefined)?.usage as
          | Record<string, unknown>
          | undefined;
        if (u && typeof u === "object") {
          const n = (v: unknown): number =>
            typeof v === "number" && Number.isFinite(v) && v >= 0
              ? Math.floor(v)
              : 0;
          const det = u["input_tokens_details"] as
            | Record<string, unknown>
            | undefined;
          streamUsage = {
            input: n(u["input_tokens"]),
            cached: n(det?.["cached_tokens"]),
            output: n(u["output_tokens"]),
          };
        }
      }
    }
  }
  if (meter && meter.allowed && streamUsage) {
    void logMetering({
      userId: meter.userId,
      kind: meter.kind,
      model,
      backend: "meta",
      inputTokens: streamUsage.input,
      outputTokens: streamUsage.output,
      durationMs: Date.now() - started,
      costUsd: metaCostUsd(
        model,
        streamUsage.input,
        streamUsage.cached,
        streamUsage.output
      ),
    });
  }
  console.log(
    `[meta] stream done model=${model} textDeltas=${textDeltas} statusDeltas=${statusDeltas}` +
      (statusAcc ? ` status=${JSON.stringify(statusAcc.slice(0, 120))}` : "")
  );
}

/**
 * Streaming thread summary: single-batch threads stream directly; large
 * multi-batch threads extract notes per batch (non-streaming) then stream
 * the final merge so long threads still show progressive output.
 */
app.post("/api/synthesize-thread-stream", async (req, res) => {
  // If the browser goes away mid-stream (stop button, navigation, or a
  // superseded StrictMode remount in dev), cancel the Meta request too.
  // Otherwise the abandoned run keeps burning quota to completion and
  // logs a phantom second "stream done" for a single user action.
  const clientGone = new AbortController();
  // NOTE: this must watch the *response*, not the request: req 'close'
  // fires as soon as Express finishes reading the POST body, which would
  // wrongly cancel every run. res 'close' before writableEnded means the
  // browser actually went away.
  const onClientClose = () => {
    if (!res.writableEnded) clientGone.abort();
  };
  res.on("close", onClientClose);
  try {
    const { projectQuery, batches, systemInstruction, modelConfig } = req.body as {
      projectQuery: string;
      batches: string[];
      systemInstruction: string;
      modelConfig: ModelEndpointConfig;
    };
    if (!batches || batches.length === 0) {
      res.status(400).json({ error: "No packed chat batches provided." });
      return;
    }

    if (rejectDisallowedModel(res, modelConfig?.model)) return;

    // Defense in depth: the packer caps bodies client-side, but a stale
    // client could still send a batch the API would truncate mid-JSON
    // (cryptic 400 hex-escape error). Fail fast with a clear message.
    const biggest = Math.max(
      ...batches.map((b) => Buffer.byteLength(b || "", "utf8"))
    );
    if (biggest > MAX_API_BODY_BYTES) {
      res.status(400).json({
        error: `Packed batch too large (${(biggest / 1024).toFixed(0)}KB > ${MAX_API_BODY_BYTES / 1024}KB per request). Narrow the range or lower Max Packed Tokens in Settings → Models.`,
      });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const send = (obj: unknown) => {
      if (clientGone.signal.aborted) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    // Flush headers and announce immediately so the UI shows life within
    // milliseconds (and no proxy buffers the stream) while the model works
    // toward its first token.
    res.flushHeaders();
    const inputBytes = batches.reduce(
      (n, b) => n + Buffer.byteLength(b || "", "utf8"),
      0
    );
    console.log(
      `[meta] synthesize start batches=${batches.length} model=${modelConfig?.model} input≈${(inputBytes / 1024).toFixed(0)}kb topic=${JSON.stringify((projectQuery || "").slice(0, 80))}`
    );
    send({ progress: "Contacting Meta model…" });

    let finalSystem = systemInstruction;
    let finalUser: string;
    let batchCount = batches.length;
    if (batches.length === 1) {
      finalUser = `PROJECT TOPIC: "${projectQuery}"\n\nCHRONOLOGICAL ASYMMETRICALLY-PACKED PROJECT CHATS (100% verbatim user prompts + condensed AI context):\n${batches[0]}\n\nGenerate the requested project summary in clean Obsidian Markdown.`;
    } else {
      // Batches are independent: extract them concurrently instead of
      // sequentially, so a 3-batch run takes ~1 extraction instead of ~3.
      // Fan-out follows the model's rate-limit tier so a huge selection
      // can't burst past the per-team TPM budget; results keep order and
      // join chronologically.
      const fanOut = extractionConcurrencyFor(modelConfig?.model ?? "");
      const capped =
        batches.length > fanOut ? ` (up to ${fanOut} at a time)` : "";
      send({ progress: `Extracting ${batches.length} batches in parallel${capped}…` });
      const partials = await mapWithConcurrency(
        batches,
        fanOut,
        (batch, i) =>
          callLLM(
            modelConfig,
            `You are extracting factual chronological project notes from Batch ${i + 1} of ${batches.length} for the project "${projectQuery}". Preserve all exact timestamps, user-shared metrics, campaign names, errors, config snippets, and decisions verbatim.`,
            `Extract all chronological events, user prompts, metrics, and outcomes from Batch ${i + 1}:\n\n${batch}`,
            undefined,
            {
              userId: reqUid(req),
              kind: "synthesize-extract",
              allowed: !isOptedOut(req),
              signal: clientGone.signal,
            }
          )
      );
      const intermediateExtractions = partials.map(
        (partial, i) =>
          `### Extracted Chronological Notes (Batch ${i + 1}/${batches.length})\n${partial}`
      );
      finalUser = `PROJECT TOPIC: "${projectQuery}"\n\nBelow are the chronological milestone extractions across ${batches.length} batches of chat history.\nSynthesize them into a single unified project summary following the system instructions:\n\n${intermediateExtractions.join("\n\n---\n\n")}`;
    }

    send({ batchCount });
    await streamLLMToSSE(
      modelConfig,
      finalSystem,
      finalUser,
      (delta) => send({ delta }),
      (status) => send({ progress: status }),
      {
        userId: reqUid(req),
        kind: "summary-stream",
        allowed: !isOptedOut(req),
        signal: clientGone.signal,
      }
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: unknown) {
    if (clientGone.signal.aborted) {
      // The browser is gone: the Meta fetch was cancelled with it, so
      // there is nothing to report and no completed usage to meter. This
      // is the normal end of a stopped or superseded run, not an error.
      console.log("[meta] synthesize aborted by client; Meta stream cancelled.");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  } finally {
    res.off("close", onClientClose);
  }
});

/** Muse Voice Transcribe model for /api/voice-transcribe. See https://dev.meta.ai/docs/speech-to-text */
const VOICE_TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";

/**
 * Transcribe a short voice command. The browser records the mic, converts
 * to mono 16-bit PCM WAV at 24kHz, and posts it as base64; the key stays
 * server-side and the audio is only ever forwarded to Meta's ASR endpoint.
 */
app.post("/api/voice-transcribe", async (req, res) => {
  try {
    const started = Date.now();
    const apiKey = metaApiKey();
    if (!apiKey) {
      res.status(400).json({
        error:
          "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai).",
      });
      return;
    }
    const { audioBase64 } = req.body as { audioBase64?: unknown };
    if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
      res.status(400).json({ error: "No audio provided." });
      return;
    }
    // ~18MB of audio; Meta caps request bodies at 32MB / 10 minutes.
    if (audioBase64.length > 24_000_000) {
      res.status(413).json({
        error: "Voice clip too long. Keep questions under a minute.",
      });
      return;
    }
    let pcm: Buffer;
    try {
      pcm = Buffer.from(audioBase64, "base64");
    } catch {
      res.status(400).json({ error: "Audio is not valid base64." });
      return;
    }
    if (pcm.length === 0) {
      res.status(400).json({ error: "No audio provided." });
      return;
    }
    const form = new FormData();
    form.append(
      "request",
      new Blob(
        [
          JSON.stringify({
            mode: "PUSH_TO_TALK",
            model: VOICE_TRANSCRIBE_MODEL,
            audioEncoding: "WAV",
          }),
        ],
        { type: "application/json" }
      )
    );
    const bytes = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength
    ) as ArrayBuffer;
    form.append("audio", new Blob([bytes], { type: "audio/wav" }), "clip.wav");
    const sessionId = `voice-${crypto.randomUUID()}`;
    const resp = await fetch(
      `${META_API_BASE_URL}/asr/transcribe?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      const status =
        resp.status === 400 || resp.status === 413 || resp.status === 429
          ? resp.status
          : 500;
      res.status(status).json({
        error: `Transcription failed (${resp.status}): ${errText.slice(0, 400)}`,
      });
      return;
    }
    const data = (await resp.json()) as {
      transcript?: unknown;
      audioDurationMs?: unknown;
    };
    res.json({
      transcript:
        typeof data.transcript === "string" ? data.transcript.trim() : "",
      audioDurationMs:
        typeof data.audioDurationMs === "number" ? data.audioDurationMs : null,
    });
    // Speech-to-text reports no token usage; log duration with zero tokens.
    // The model has no cost-table entry, so cost is $0.
    if (!isOptedOut(req)) {
      void logMetering({
        userId: reqUid(req),
        kind: "voice-transcribe",
        model: VOICE_TRANSCRIBE_MODEL,
        backend: "meta",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - started,
        costUsd: 0,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

const FIND_CHATS_TOOL = {
  type: "function",
  function: {
    name: "find_chats",
    description:
      "Find chat history within an inclusive date range mentioning any of the given entities. Returns matching chats with dates, titles, user prompts, and excerpts.",
    parameters: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Range start, YYYY-MM-DD.",
        },
        end_date: {
          type: "string",
          description: "Range end, YYYY-MM-DD (inclusive).",
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description:
            "People, organizations, places, or topics. A chat matches when it mentions any of them.",
        },
      },
      required: ["start_date", "end_date", "entities"],
    },
  },
};

function voiceSystemPrompt(today: Date): string {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const weekday = today.toLocaleDateString("en-US", { weekday: "long" });
  return [
    `You are a voice assistant answering questions about the user's chat history. Today is ${y}-${m}-${d} (${weekday}).`,
    "",
    "To answer, first translate the request into a find_chats call: a start_date and end_date (YYYY-MM-DD) plus 1-6 entities (people, organizations, places, topics; split phrases like 'OpenAI ads campaign' into separate entities such as openai, ads). Resolve relative dates against today: a bare month ('in Sep') means the most recent such month on or before today; 'last week' means the previous Monday-to-Sunday week; 'yesterday'/'today' map to those dates.",
    "If the start date, end date, or entities cannot be determined, do NOT call the tool: ask one short clarifying question instead.",
    "After find_chats returns, answer from those chats only — never invent details. Reply with the TL;DR only: no preamble about searching, no thinking process, no narration of tool calls. Start with one short paragraph (1-3 sentences), then at most 3 short bullets with dates. Keep the whole reply under ~120 words. Use simple GitHub-flavored markdown only: **bold**, bullets (-), and plain URLs. No tables, headings, nested lists, or HTML.",
    "If the chats lack the requested detail, say so in one sentence and ask the user whether to revise the requirement (different dates or entities).",
  ].join("\n");
}

interface VoiceAgentMessage {
  role: "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function sanitizeVoiceMessages(raw: unknown): VoiceAgentMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) return null;
  const out: VoiceAgentMessage[] = [];
  let chars = 0;
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const r = m as Record<string, unknown>;
    if (r.role !== "user" && r.role !== "assistant" && r.role !== "tool") {
      return null;
    }
    const content =
      typeof r.content === "string" ? r.content : r.content === null ? null : undefined;
    if (typeof content === "string") {
      chars += content.length;
      if (chars > 200_000) return null;
    }
    const msg: VoiceAgentMessage = { role: r.role, content: content ?? null };
    if (r.role === "tool") {
      if (typeof r.tool_call_id !== "string" || !r.tool_call_id) return null;
      msg.tool_call_id = r.tool_call_id;
    }
    if (r.role === "assistant" && Array.isArray(r.tool_calls)) {
      const calls: VoiceAgentMessage["tool_calls"] = [];
      for (const c of r.tool_calls) {
        const cc = c as Record<string, unknown>;
        const fn = cc.function as Record<string, unknown> | undefined;
        if (
          typeof cc.id !== "string" ||
          typeof fn?.name !== "string" ||
          typeof fn?.arguments !== "string"
        ) {
          return null;
        }
        calls.push({
          id: cc.id,
          type: "function",
          function: { name: fn.name, arguments: fn.arguments },
        });
      }
      if (calls.length > 0) msg.tool_calls = calls;
    }
    out.push(msg);
  }
  return out;
}

/**
 * One voice-agent turn. The client owns the tool loop: it sends the
 * conversation, executes any returned find_chats calls against local
 * chats, and posts results back as tool messages.
 */
app.post("/api/voice-agent", async (req, res) => {
  try {
    const started = Date.now();
    const apiKey = metaApiKey();
    if (!apiKey) {
      res.status(400).json({
        error:
          "Missing Meta API key. Set MODEL_API_KEY in the server .env (create one at https://dev.meta.ai).",
      });
      return;
    }
    const { model, messages } = req.body as {
      model?: unknown;
      messages?: unknown;
    };
    if (typeof model !== "string" || !model.trim()) {
      res.status(400).json({
        error: "No voice agent model selected. Pick one in Settings → Voice agent.",
      });
      return;
    }
    if (rejectDisallowedModel(res, model)) return;
    const clean = sanitizeVoiceMessages(messages);
    if (!clean) {
      res.status(400).json({ error: "Invalid conversation messages." });
      return;
    }
    const body: Record<string, unknown> = {
      model: model.trim(),
      messages: [
        { role: "system", content: voiceSystemPrompt(new Date()) },
        ...clean,
      ],
      tools: [FIND_CHATS_TOOL],
      temperature: 0.3,
      reasoning_effort: REASONING_EFFORT,
    };
    const MAX_429_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`${META_API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: Record<string, unknown>;
        };
        const msg = data.choices?.[0]?.message ?? {};
        const toolCalls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls
              .filter(
                (c) =>
                  c &&
                  typeof c.id === "string" &&
                  typeof c.function?.name === "string" &&
                  typeof c.function?.arguments === "string"
              )
              .map((c) => ({
                id: c.id as string,
                type: "function" as const,
                function: {
                  name: c.function?.name as string,
                  arguments: c.function?.arguments as string,
                },
              }))
          : [];
        res.json({
          message: {
            role: "assistant" as const,
            content:
              typeof msg.content === "string" ? msg.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        });
        if (!isOptedOut(req)) {
          const usage = parseMetaUsage(data);
          void logMetering({
            userId: reqUid(req),
            kind: "voice-agent",
            model: (typeof model === "string" ? model.trim() : ""),
            backend: "meta",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            durationMs: Date.now() - started,
            costUsd: metaCostUsd(
              typeof model === "string" ? model.trim() : "",
              usage.inputTokens,
              usage.cachedInputTokens,
              usage.outputTokens
            ),
          });
        }
        return;
      }
      const errText = await resp.text();
      if (resp.status !== 429 || attempt >= MAX_429_RETRIES) {
        throw new Error(
          `Meta Model API Error (${resp.status}): ${errText.slice(0, 400)}`
        );
      }
      const retryAfterSec = Number(resp.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(
          r,
          retryDelayMs(
            attempt,
            Number.isFinite(retryAfterSec) ? retryAfterSec : null
          )
        )
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// Serve static frontend in production (Google Cloud Run)
const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) next();
  });
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
