import { getOrCreateUuid } from "./storage";
import { MODELS_LOCKED } from "./edition";

const METERING_KEY = "extbrain_metering_enabled"; // "0" = disabled

/**
 * Settings → Logging & metering toggle. Defaults to enabled. Locked
 * deployments (Cloud Run) force it on: logging is mandatory there and the
 * toggle is immutable.
 */
export function isMeteringEnabled(): boolean {
  if (MODELS_LOCKED) return true;
  try {
    return localStorage.getItem(METERING_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setMeteringEnabled(on: boolean): void {
  if (MODELS_LOCKED) return;
  try {
    localStorage.setItem(METERING_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const userId = getOrCreateUuid();
    if (userId) headers["X-User-Id"] = userId;
  } catch {
    /* server falls back to "anonymous" */
  }
  if (!isMeteringEnabled()) headers["X-Metering-Opt-Out"] = "1";
  return headers;
}

function mergeHeaders(
  extra: RequestInit["headers"] | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...identityHeaders(),
  };
  if (!extra) return headers;
  const obj =
    extra instanceof Headers
      ? Object.fromEntries(extra.entries())
      : Array.isArray(extra)
        ? Object.fromEntries(extra)
        : (extra as Record<string, string>);
  return { ...headers, ...obj };
}

/**
 * POST JSON to the API with the client's identity attached. The server reads
 * X-User-Id for consent + metering (see server/index.ts); when no uuid
 * exists yet the header is omitted and the server logs "anonymous".
 * Failures reject like a normal fetch — callers that must not break the UI
 * (consent, visit) catch them.
 */
export async function apiPost(
  path: string,
  body: unknown,
  init?: Omit<RequestInit, "method" | "body">
): Promise<Response> {
  return fetch(path, {
    ...init,
    method: "POST",
    headers: mergeHeaders(init?.headers),
    body: JSON.stringify(body),
  });
}

export async function apiGet(
  path: string,
  init?: Omit<RequestInit, "method">
): Promise<Response> {
  return fetch(path, {
    ...init,
    method: "GET",
    headers: mergeHeaders(init?.headers),
  });
}

export async function apiDelete(
  path: string,
  init?: Omit<RequestInit, "method">
): Promise<Response> {
  return fetch(path, {
    ...init,
    method: "DELETE",
    headers: mergeHeaders(init?.headers),
  });
}

/**
 * Consent + visit pings. Never throws; never blocks the UI. Skipped
 * entirely when the user disabled logging & metering in Settings.
 */
export function logConsent(consentAt: string): void {
  if (!isMeteringEnabled()) return;
  try {
    void apiPost("/api/consent", { userId: getOrCreateUuid(), consentAt }).catch(
      () => {}
    );
  } catch {
    /* ignore */
  }
}

export function logVisit(): void {
  if (!isMeteringEnabled()) return;
  try {
    void apiPost("/api/visit", {}).catch(() => {});
  } catch {
    /* ignore */
  }
}
