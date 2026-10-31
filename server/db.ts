import { MongoClient, type Db } from "mongodb";
import type { CustomCosts } from "./costs";

/**
 * MongoDB consent + metering store.
 *
 * Configuration (server .env — tell the deployer these two keys):
 *   MONGODB_URI   Connection string, e.g. mongodb+srv://user:pass@host/db
 *   MONGODB_DB    Database name (optional, defaults to "extbrain")
 *
 * Collections:
 *   users    { _id: userId, consentAt: ISO string|null, lastVisited: ISO string }
 *   metering { userId, ts, kind, model, backend, inputTokens, outputTokens,
 *              durationMs, costUsd }
 *
 * Every helper is safe to call when no URI is configured (local development
 * without a database): it warns once and becomes a no-op, so requests never
 * fail because metering is unavailable.
 */

function mongoConfig(): { uri: string; dbName: string } {
  return {
    uri: (process.env.MONGODB_URI || "").trim(),
    dbName: (process.env.MONGODB_DB || "").trim() || "extbrain",
  };
}

/** True when a Mongo connection string is configured. */
export function isMongoConfigured(): boolean {
  return mongoConfig().uri.length > 0;
}

export function sanitizeUserId(raw: unknown): string {
  if (typeof raw !== "string") return "anonymous";
  const id = raw.trim().slice(0, 128);
  return id.length > 0 ? id : "anonymous";
}

interface UserDoc {
  _id: string;
  consentAt?: string | null;
  lastVisited: string;
}

interface MeteringDoc {
  userId: string;
  ts: string;
  kind: string;
  model: string;
  backend: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd: number;
}

let dbPromise: Promise<Db | null> | null = null;
let warnedNoUri = false;
let lastConnectFailure = 0;

async function getDb(): Promise<Db | null> {
  // Retry a failed connection at most once a minute (a deploy with a bad
  // URI shouldn't pay a connect timeout on every request forever).
  if (dbPromise && Date.now() - lastConnectFailure < 60_000) {
    return dbPromise;
  }
  if (!dbPromise) {
    dbPromise = (async (): Promise<Db | null> => {
      const { uri, dbName } = mongoConfig();
      if (!uri) {
        if (!warnedNoUri) {
          warnedNoUri = true;
          console.warn(
            "[mongo] MONGODB_URI is unset: consent/metering logging is disabled."
          );
        }
        return null;
      }
      try {
        const client = new MongoClient(uri);
        await client.connect();
        const db = client.db(dbName);
        // Firestore's MongoDB-compatible endpoint maps createIndex to a
        // Firestore admin action (datastore.indexes.create) that the app
        // runtime identity usually lacks. Manage indexes out-of-band (see
        // .env.example) and set MONGO_SKIP_INDEXES=1 to skip this call.
        const skipIndexes = ["1", "true"].includes(
          (process.env.MONGO_SKIP_INDEXES || "").trim().toLowerCase()
        );
        if (!skipIndexes) {
          await db
            .collection<MeteringDoc>("metering")
            .createIndex({ userId: 1, ts: -1 })
            .catch((e) =>
              console.warn("[mongo] metering index skipped:", String(e))
            );
        }
        console.log(`[mongo] connected (db=${dbName}).`);
        return db;
      } catch (e) {
        lastConnectFailure = Date.now();
        console.warn(
          "[mongo] connection failed, metering disabled:",
          e instanceof Error ? e.message : String(e)
        );
        return null;
      }
    })();
  }
  return dbPromise;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Record (or refresh) a user's onboarding consent. Never throws. */
export async function logConsent(
  userId: string,
  consentAt: string | null
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const id = sanitizeUserId(userId);
    await db.collection<UserDoc>("users").updateOne(
      { _id: id },
      {
        $set: { lastVisited: isoNow() },
        $setOnInsert: { _id: id },
        ...(consentAt ? { $set: { consentAt } } : {}),
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[mongo] logConsent failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Touch a user's last-visited time (called on app load). Never throws. */
export async function logVisit(userId: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const id = sanitizeUserId(userId);
    await db
      .collection<UserDoc>("users")
      .updateOne(
        { _id: id },
        { $set: { lastVisited: isoNow() }, $setOnInsert: { _id: id } },
        { upsert: true }
      );
  } catch (e) {
    console.warn("[mongo] logVisit failed:", e instanceof Error ? e.message : String(e));
  }
}

interface CostDoc {
  _id: string;
  rates: Record<
    string,
    { inputPer1M: number; cachedInputPer1M: number; outputPer1M: number }
  >;
  modalPerSec: number;
  updatedAt: string;
}

const COST_DOC_ID = "current";

/** Load saved custom rates (null when none/disabled). Never throws. */
export async function loadCustomCosts(): Promise<CustomCosts | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db.collection<CostDoc>("costs").findOne({ _id: COST_DOC_ID });
    if (!doc || !doc.rates || typeof doc.modalPerSec !== "number") return null;
    return { rates: doc.rates, modalPerSec: doc.modalPerSec };
  } catch (e) {
    console.warn("[mongo] loadCustomCosts failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Persist validated custom rates. Never throws. */
export async function saveCustomCosts(costs: CustomCosts): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection<CostDoc>("costs").updateOne(
      { _id: COST_DOC_ID },
      {
        $set: {
          _id: COST_DOC_ID,
          rates: costs.rates,
          modalPerSec: costs.modalPerSec,
          updatedAt: isoNow(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[mongo] saveCustomCosts failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Delete custom rates (revert to built-ins). Never throws. */
export async function clearCustomCosts(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection<CostDoc>("costs").deleteOne({ _id: COST_DOC_ID });
  } catch (e) {
    console.warn("[mongo] clearCustomCosts failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Sum of costUsd across the whole metering table (0 when unavailable). */
export async function getTotalMeteredCost(): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const rows = await db
      .collection<MeteringDoc>("metering")
      .aggregate<{ _id: null; total: number }>([
        { $group: { _id: null, total: { $sum: "$costUsd" } } },
      ])
      .toArray();
    const total = rows[0]?.total;
    return typeof total === "number" && Number.isFinite(total) && total > 0
      ? total
      : 0;
  } catch (e) {
    console.warn("[mongo] getTotalMeteredCost failed:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}

export interface MeteringEntry {
  userId: string;
  ts?: string;
  kind: string;
  model: string;
  backend: "meta" | "modal";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd: number;
}

/** Insert one metering row and refresh the user's last-visited. Never throws. */
export async function logMetering(entry: MeteringEntry): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const id = sanitizeUserId(entry.userId);
    const ts = entry.ts || isoNow();
    await db.collection<MeteringDoc>("metering").insertOne({
      userId: id,
      ts,
      kind: entry.kind,
      model: entry.model,
      backend: entry.backend,
      inputTokens: Math.max(0, Math.floor(entry.inputTokens)),
      outputTokens: Math.max(0, Math.floor(entry.outputTokens)),
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      costUsd: entry.costUsd,
    });
    await db
      .collection<UserDoc>("users")
      .updateOne(
        { _id: id },
        { $set: { lastVisited: ts }, $setOnInsert: { _id: id } },
        { upsert: true }
      );
  } catch (e) {
    console.warn("[mongo] logMetering failed:", e instanceof Error ? e.message : String(e));
  }
}
