export interface SavedSummaryThreadSource {
  key: string;
  title: string;
  count: number;
}

export interface SavedSummaryTagSource {
  id: string;
  name: string;
}

export interface SavedSummary {
  id: string;
  createdAt: string; // ISO
  templateId: string;
  templateName: string;
  title: string;
  abstract: string;
  markdown: string;
  threads: SavedSummaryThreadSource[];
  tags: SavedSummaryTagSource[];
  chatCount: number;
  /** Day-key range the summary was generated for (range summaries only). */
  range?: { start: string; end: string };
}

function keyFor(uuid: string): string {
  return `sb_saved_summaries_v1_${uuid}`;
}

function isSavedSummary(s: unknown): s is SavedSummary {
  return (
    !!s &&
    typeof (s as SavedSummary).id === "string" &&
    typeof (s as SavedSummary).markdown === "string" &&
    typeof (s as SavedSummary).templateId === "string"
  );
}

export function loadSavedSummaries(uuid: string): SavedSummary[] {
  try {
    const raw = localStorage.getItem(keyFor(uuid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedSummary);
  } catch {
    return [];
  }
}

/** Full replace (backup restore), same shape guard as load. */
export function replaceSavedSummaries(
  uuid: string,
  list: SavedSummary[]
): SavedSummary[] {
  const next = list.filter(isSavedSummary).slice(0, 200);
  persist(uuid, next);
  return next;
}

function persist(uuid: string, list: SavedSummary[]): void {
  try {
    localStorage.setItem(keyFor(uuid), JSON.stringify(list));
  } catch {
    // quota/privacy: keep in memory only
  }
}

export function appendSavedSummary(
  uuid: string,
  draft: Omit<SavedSummary, "id" | "createdAt">
): SavedSummary {
  const saved: SavedSummary = {
    ...draft,
    id: `sum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  const next = [saved, ...loadSavedSummaries(uuid)].slice(0, 200);
  persist(uuid, next);
  return saved;
}

export function deleteSavedSummary(uuid: string, id: string): SavedSummary[] {
  const next = loadSavedSummaries(uuid).filter((s) => s.id !== id);
  persist(uuid, next);
  return next;
}

export function updateSavedSummaryMarkdown(
  uuid: string,
  id: string,
  markdown: string
): SavedSummary[] {
  const next = loadSavedSummaries(uuid).map((s) =>
    s.id === id ? { ...s, markdown, abstract: extractAbstract(markdown) } : s
  );
  persist(uuid, next);
  return next;
}

/** First sentence of the rendered summary, markdown stripped. */
export function extractAbstract(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-\*\+]+\s*/gm, "")
    .replace(/[*_~`#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const m = text.match(/^(.{20,}?[.!?])(\s|$)/);
  if (m) return m[1].trim();
  const nl = text.indexOf("  ");
  if (text.length > 180) return text.slice(0, 180).trimEnd() + "…";
  return text.slice(0, 220);
}


