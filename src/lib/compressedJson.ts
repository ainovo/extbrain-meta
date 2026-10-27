import pako from "pako";

/**
 * Compressed JSON for the unbounded per-dataset localStorage maps
 * (entities, hashes, categories, tags, summaries). A 16K-chat history
 * pushes raw JSON past the ~5MB localStorage cap, which fails writes
 * silently and looks exactly like stuck progress; gzip shrinks
 * repetitive JSON ~3-4x. Reads accept both formats, so existing raw
 * stores migrate lazily on the next save — nothing is ever discarded.
 */

const PREFIX = "gz1:";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  // Chrome/Safari/modern Firefox: "QuotaExceededError" (code 22). Legacy
  // Firefox used NS_ERROR_DOM_QUOTA_REACHED (code 1014) for the same cap.
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

export interface PersistError {
  key: string;
  name: string;
  message: string;
}

/**
 * Last failed persist this page load (cleared by the next success). The
 * processing section surfaces it so a failing save can't hide behind a
 * progress bar ever again — refresh resets it, so it never goes stale.
 */
let lastError: PersistError | null = null;

export function lastPersistError(): PersistError | null {
  return lastError;
}

/**
 * Reactive persist outcomes: bumped on every setStoredItem completion so
 * UI can re-read lastPersistError() even when the save ran in a
 * post-render effect with no state change after it.
 */
let outcomeVersion = 0;
const outcomeListeners = new Set<() => void>();

export function getPersistOutcomeVersion(): number {
  return outcomeVersion;
}

export function subscribePersistOutcome(listener: () => void): () => void {
  outcomeListeners.add(listener);
  return () => {
    outcomeListeners.delete(listener);
  };
}

function noteOutcome(): void {
  outcomeVersion++;
  for (const fn of outcomeListeners) {
    try {
      fn();
    } catch {
      // a failing listener must never break persistence
    }
  }
}

function describeError(err: unknown): { name: string; message: string } {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    return {
      name:
        typeof e.name === "string"
          ? e.name
          : typeof e.code !== "undefined"
            ? `code ${String(e.code)}`
            : "Error",
      message: typeof e.message === "string" ? e.message : String(err),
    };
  }
  return { name: "Error", message: String(err) };
}

/**
 * Quota-aware setItem. If a write fails at quota AND a larger old value
 * exists, drop it first and retry once: replacing 3MB of raw JSON with
 * 900KB of gzip must not fail just because both briefly coexist. The
 * remove+write runs synchronously in one task, so no other tab can
 * interleave between them. Returns false when nothing could be saved —
 * and never deletes unless the retry has a smaller value to write.
 */
export function setStoredItem(key: string, value: string): boolean {
  let ok = false;
  try {
    localStorage.setItem(key, value);
    lastError = null;
    ok = true;
  } catch (firstErr) {
    if (isQuotaError(firstErr)) {
      let oldRaw: string | null = null;
      try {
        oldRaw = localStorage.getItem(key);
      } catch {
        oldRaw = null;
      }
      if (oldRaw && oldRaw.length > value.length) {
        try {
          localStorage.removeItem(key);
          localStorage.setItem(key, value);
          lastError = null;
          ok = true;
        } catch {
          // fall through to record the failure
        }
      }
    }
    if (!ok) {
      const { name, message } = describeError(firstErr);
      lastError = { key, name, message };
    }
  }
  noteOutcome();
  return ok;
}

/**
 * Approximate total localStorage usage in KB (JSON view, close enough to
 * diagnose quota pressure; the cap is ~5MB per origin).
 */
export function localStorageTotalKB(): number | null {
  try {
    return Math.round(JSON.stringify(localStorage).length / 1024);
  } catch {
    return null;
  }
}

/** JSON value → storable string (always compressed). */
export function encodeCompressedJson(value: unknown): string {
  return PREFIX + bytesToBase64(pako.gzip(JSON.stringify(value)));
}

/**
 * Storable string → parsed JSON. Accepts gz1: payloads and legacy raw
 * JSON; null when missing or unparseable (callers apply their own shape
 * validation and fallbacks on top).
 */
export function decodeStoredJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    if (raw.startsWith(PREFIX)) {
      return JSON.parse(
        new TextDecoder().decode(pako.ungzip(base64ToBytes(raw.slice(PREFIX.length))))
      );
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
