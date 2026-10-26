import type { ParsedActivityItem } from "./types";

/** Items per IndexedDB record; one giant put() stalls mobile browsers. */
export const HISTORIES_CHUNK_SIZE = 500;

/**
 * Serialize one chunk: per-item JSON joined by "," (no brackets), so chunk
 * bodies concatenate back into a valid array without re-parsing. Boundaries
 * always fall between items, never inside a value.
 */
export function encodeHistoriesChunk(items: ParsedActivityItem[]): string {
  return items.map((it) => JSON.stringify(it)).join(",");
}

/**
 * Reassemble a JSON array string from chunk bodies. Empty bodies (a missing
 * chunk record) are dropped, so one lost chunk can't corrupt the rest.
 */
export function joinHistoriesChunks(chunks: string[]): string {
  return `[${chunks.filter((c) => c.length > 0).join(",")}]`;
}

export function getOrCreateUuid(): string {
  const KEY = "sb_uuid";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `user-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "local-user";
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("secondbrain", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("histories")) {
        db.createObjectStore("histories");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getRecord(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("histories", "readonly");
    const req = tx.objectStore("histories").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHistories(
  uuid: string,
  items: ParsedActivityItem[],
  fileNames: string[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const bodies: string[] = [];
  for (let i = 0; i < items.length; i += HISTORIES_CHUNK_SIZE) {
    bodies.push(
      encodeHistoriesChunk(items.slice(i, i + HISTORIES_CHUNK_SIZE))
    );
  }
  if (bodies.length === 0) bodies.push("");
  const total = bodies.length + 1; // chunks + meta record
  try {
    const db = await openDb();
    const old = await getRecord(db, `items_${uuid}`).catch(() => null);
    const staleFrom = bodies.length;
    const staleTo =
      old?.chunked === true && typeof old.chunks === "number"
        ? old.chunks
        : bodies.length;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("histories", "readwrite");
      const store = tx.objectStore("histories");
      for (let i = staleFrom; i < staleTo; i++) {
        store.delete(`items_${uuid}_c${i}`);
      }
      let done = 0;
      const putNext = (i: number): void => {
        if (i >= bodies.length) {
          const metaReq = store.put(
            {
              chunked: true,
              chunks: bodies.length,
              fileNames,
              savedAt: new Date().toISOString(),
            },
            `items_${uuid}`
          );
          metaReq.onsuccess = () => {
            done++;
            onProgress?.(done, total);
          };
          metaReq.onerror = () => reject(metaReq.error);
          return;
        }
        const req = store.put({ body: bodies[i] }, `items_${uuid}_c${i}`);
        req.onsuccess = () => {
          done++;
          onProgress?.(done, total);
          putNext(i + 1);
        };
        req.onerror = () => reject(req.error);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      putNext(0);
    });
    db.close();
  } catch (e) {
    console.warn("IndexedDB save failed, falling back to memory only", e);
  }
}

export async function loadHistories(
  uuid: string
): Promise<{ itemsJson: string; fileNames: string[] } | null> {
  try {
    const db = await openDb();
    const result = await getRecord(db, `items_${uuid}`);
    if (!result) {
      db.close();
      return null;
    }
    if (result.chunked === true && typeof result.chunks === "number") {
      const bodies: string[] = [];
      for (let i = 0; i < result.chunks; i++) {
        const rec = await getRecord(db, `items_${uuid}_c${i}`);
        bodies.push(typeof rec?.body === "string" ? rec.body : "");
      }
      db.close();
      return {
        itemsJson: joinHistoriesChunks(bodies),
        fileNames: result.fileNames || [],
      };
    }
    db.close();
    return {
      itemsJson: result.itemsJson,
      fileNames: result.fileNames || [],
    };
  } catch (e) {
    console.warn("IndexedDB load failed", e);
    return null;
  }
}

export async function clearHistories(uuid: string): Promise<void> {
  try {
    const db = await openDb();
    const meta = await getRecord(db, `items_${uuid}`);
    const chunks =
      meta?.chunked === true && typeof meta.chunks === "number"
        ? meta.chunks
        : 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("histories", "readwrite");
      const store = tx.objectStore("histories");
      store.delete(`items_${uuid}`);
      for (let i = 0; i < chunks; i++) {
        store.delete(`items_${uuid}_c${i}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}
