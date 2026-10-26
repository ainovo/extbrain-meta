// Fast fuzzy-ish search with soft OR-matching: every query token contributes
// its best match score, so multi-word queries rank instead of returning nothing.
import { ParsedActivityItem } from "./types";

function normalize(s: string): string {
  return s.toLowerCase();
}

export function tokenizeQuery(q: string): string[] {
  return normalize(q)
    .split(/[^a-z0-9._@/#+-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++;
  }
  return j === needle.length;
}

function splitWords(s: string): string[] {
  return s.split(/[^a-z0-9._/#+-]+/).filter(Boolean);
}

interface ItemIndex {
  title: string;
  titleWords: Set<string>;
  prompt: string;
  promptWords: Set<string>;
  response: string;
  entities: string;
  entityWords: Set<string>;
  allCompact: string;
}

function buildIndex(item: ParsedActivityItem): ItemIndex {
  const title = normalize(item.cleanTitle || "");
  const prompt = normalize(item.allPromptsText || "");
  const response = normalize(
    `${item.condensedResponseText || ""} ${item.fullMarkdown || ""}`
  );
  const entities = normalize((item.extractedEntities || []).join(" "));
  return {
    title,
    titleWords: new Set(splitWords(title)),
    prompt,
    promptWords: new Set(splitWords(prompt)),
    response,
    entities,
    entityWords: new Set(splitWords(entities)),
    allCompact: `${title} ${prompt} ${response} ${entities}`.replace(
      /[^a-z0-9]/g,
      ""
    ),
  };
}

function startsWithAny(words: Set<string>, tok: string): boolean {
  for (const w of words) {
    if (w.startsWith(tok) && w !== tok) return true;
  }
  return false;
}

function tokenScore(tok: string, idx: ItemIndex): number {
  if (idx.titleWords.has(tok)) return 10;
  if (idx.promptWords.has(tok)) return 7;
  if (idx.entityWords.has(tok)) return 6;
  if (startsWithAny(idx.titleWords, tok)) return 6;
  if (startsWithAny(idx.promptWords, tok)) return 5;
  if (startsWithAny(idx.entityWords, tok)) return 4;
  if (idx.title.includes(tok)) return 4;
  if (idx.prompt.includes(tok)) return 3;
  if (idx.entities.includes(tok)) return 2;
  if (idx.response.includes(tok)) return 1.5;
  if (tok.length >= 4 && isSubsequence(tok, idx.allCompact)) return 0.75;
  return 0;
}

export interface IndexedItem {
  item: ParsedActivityItem;
  index: ItemIndex;
}

export function buildSearchIndex(items: ParsedActivityItem[]): IndexedItem[] {
  return items.map((item) => ({ item, index: buildIndex(item) }));
}

export function scoreIndexed(
  idx: ItemIndex,
  queryTokens: string[],
  rawQuery: string
): number {
  if (queryTokens.length === 0) return 1;
  let score = 0;

  const raw = normalize(rawQuery.trim());
  if (raw.length >= 3) {
    if (idx.title.includes(raw)) score += 12;
    else if (idx.prompt.includes(raw) || idx.entities.includes(raw)) score += 8;
    else if (idx.response.includes(raw)) score += 5;
  }

  for (const tok of queryTokens) {
    score += tokenScore(tok, idx);
  }

  // Small completeness bonus when every token matched somewhere.
  return score;
}

export function scoreItem(
  item: ParsedActivityItem,
  queryTokens: string[],
  rawQuery: string
): number {
  return scoreIndexed(buildIndex(item), queryTokens, rawQuery);
}

export function fuzzyFilterIndexed(
  indexed: IndexedItem[],
  query: string
): ParsedActivityItem[] {
  const q = query.trim();
  if (!q) return indexed.map((r) => r.item);
  const tokens = tokenizeQuery(q);
  if (tokens.length === 0) return indexed.map((r) => r.item);
  const scored = indexed
    .map((r) => ({ it: r.item, s: scoreIndexed(r.index, tokens, q) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.map((r) => r.it);
}

export function fuzzyFilter(
  items: ParsedActivityItem[],
  query: string
): ParsedActivityItem[] {
  return fuzzyFilterIndexed(buildSearchIndex(items), query);
}
