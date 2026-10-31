import type { NextFunction, Request, Response } from "express";

/**
 * Parse the CORS allowlist from the CORS_ORIGINS env var (comma-separated
 * origins, e.g. "https://app.extbrain.ai"). Returns null when unset, which
 * preserves the historical allow-all behavior for local development.
 */
export function parseAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env
): string[] | null {
  const raw = (env.CORS_ORIGINS || "").trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * Server-side model allowlist (ALLOWED_META_MODELS, comma-separated, e.g.
 * "muse-spark-1.3-contributor"). Null/empty means no restriction (local
 * development). Unlike the Settings UI lock — which is cosmetic and
 * bypassable with curl — this is enforced on every Meta call, so locked
 * deployments cannot be talked into expensive models.
 */
export function parseAllowedModels(
  env: NodeJS.ProcessEnv = process.env
): string[] | null {
  const raw = (env.ALLOWED_META_MODELS || "").trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

export function isModelAllowed(
  model: unknown,
  allowed: string[] | null
): boolean {
  if (!allowed) return true;
  return (
    typeof model === "string" &&
    allowed.includes(model.trim().toLowerCase())
  );
}

/**
 * Admin gate for sensitive mutations (cost table). Open when no
 * ADMIN_API_KEY is configured (local single-user dev); otherwise the
 * request must carry the key in X-Admin-Key.
 */
export function isAdminAuthorized(
  provided: unknown,
  configured: string
): boolean {
  if (!configured) return true;
  return typeof provided === "string" && provided === configured;
}

/** True when metering opt-out must be ignored (locked deployments). */
export function isMeteringEnforced(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = (env.METERING_ENFORCED || "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export interface RateLimitOptions {
  /** Rolling window in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** Key selector (defaults to client IP). */
  keyOf?: (req: Request) => string;
  /** JSON error message for rejected requests. */
  message?: string;
  /** Clock override for tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  reset: number;
}

/**
 * Minimal fixed-window in-memory rate limiter. No external dependency, and
 * safe for single- or few-instance deployments: each instance enforces its
 * own counters, so treat `max` as per-instance. Behind Cloud Run (or any
 * proxy) the app must set `trust proxy` for req.ip to be the client IP.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const keyOf = opts.keyOf ?? ((req: Request) => req.ip ?? "unknown");
  const message = opts.message ?? "Too many requests, please slow down.";
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  // Opportunistic cleanup so idle IPs don't grow the map forever. unref'd
  // so the timer never holds the process open on its own.
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) {
      if (b.reset <= t) buckets.delete(k);
    }
    if (buckets.size > 10000) buckets.clear();
  }, opts.windowMs);
  if (typeof sweep === "object" && "unref" in sweep) {
    (sweep as { unref: () => void }).unref();
  }

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const t = now();
    const key = keyOf(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= t) {
      bucket = { count: 0, reset: t + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      res
        .status(429)
        .json({ error: `${message} Try again in a few minutes.` });
      return;
    }
    next();
  };
}
