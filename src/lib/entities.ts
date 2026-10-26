export interface ExtractedEntity {
  /** Display form as found in the chat text. */
  name: string;
  /** NER type: PER, ORG, LOC, MISC (uppercased). */
  type: string;
  /** Mean model confidence for the span, when recorded (absent on legacy). */
  score?: number;
}

/** Per-chat extracted entities, keyed by chat id. */
export type ChatEntityMap = Record<string, ExtractedEntity[]>;

export interface EntityAggregate {
  /** Lowercased dedupe key. */
  key: string;
  /** Most frequent raw form, for display. */
  display: string;
  /** Most frequent NER type. */
  type: string;
  /** Number of distinct chats mentioning this entity. */
  chatCount: number;
}

const keyFor = (uuid: string) => `sb_entities_${uuid}`;

export function loadChatEntities(uuid: string): ChatEntityMap {
  try {
    const raw = localStorage.getItem(keyFor(uuid));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Migrate entities stored before WordPiece "##" cleanup was added.
    const cleaned: ChatEntityMap = {};
    for (const [chatId, ents] of Object.entries(parsed as ChatEntityMap)) {
      const fixed = (ents || [])
        .map((e) => ({
          name: cleanEntityText(e?.name || ""),
          type: e?.type || "MISC",
          ...(typeof e?.score === "number" ? { score: e.score } : {}),
        }))
        .filter((e) => e.name.length >= 2);
      if (fixed.length > 0) cleaned[chatId] = fixed;
    }
    return cleaned;
  } catch {
    return {};
  }
}

export function saveChatEntities(uuid: string, map: ChatEntityMap): void {
  try {
    localStorage.setItem(keyFor(uuid), JSON.stringify(map));
  } catch {
    // Quota or privacy mode: entities stay in memory for the session.
  }
}

/**
 * Strip WordPiece "##" continuation markers left behind by the
 * transformers.js NER aggregation ("San Fran ##cisco" -> "San Francisco").
 */
export function cleanEntityText(name: string): string {
  return name.replace(/\s*##/g, "").replace(/\s+/g, " ").trim();
}

export function normalizeEntityKey(name: string): string {
  return cleanEntityText(name).toLowerCase();
}

/**
 * Truncate text to maxLen without cutting mid-word: if the cut lands inside
 * a word, back off to the previous whitespace. Prevents dangling fragments
 * ("...sp" cut from "spending") from becoming phantom entities downstream.
 */
export function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.search(/\s(?=\S*$)/);
  if (lastSpace <= 0) return cut;
  return cut.slice(0, lastSpace);
}

/**
 * 53-bit content hash (cyrb53) of the exact text that was fed to the NER
 * model. Stored per chat so re-imports only re-extract chats whose text
 * actually changed — same text keeps its entities, changed text is redone.
 */
export function entityTextHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

const hashKeyFor = (uuid: string) => `sb_entityhash_${uuid}`;

/** Per-chat processing record: content hash plus the processor version used. */
export interface ChatEntityHash {
  hash: string;
  /** Processor logic version (0 = unknown/legacy, always reprocessed). */
  version: number;
}

export type ChatEntityHashMap = Record<string, ChatEntityHash>;

function normalizeHashEntry(raw: unknown): ChatEntityHash | null {
  if (typeof raw === "string") return { hash: raw, version: 0 };
  if (raw && typeof raw === "object") {
    const e = raw as { hash?: unknown; version?: unknown };
    if (typeof e.hash === "string") {
      return {
        hash: e.hash,
        version: typeof e.version === "number" ? e.version : 0,
      };
    }
  }
  return null;
}

export function loadChatEntityHashes(uuid: string): ChatEntityHashMap {
  try {
    const raw = localStorage.getItem(hashKeyFor(uuid));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ChatEntityHashMap = {};
    for (const [id, e] of Object.entries(parsed)) {
      const norm = normalizeHashEntry(e);
      if (norm) out[id] = norm;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveChatEntityHashes(uuid: string, map: ChatEntityHashMap): void {
  try {
    localStorage.setItem(hashKeyFor(uuid), JSON.stringify(map));
  } catch {
    // ignore
  }
}

/**
 * True when a chat needs (re-)processing: no entities stored, changed text,
 * no record at all, or a record from an older processor version. A null
 * server version (unreachable backend) skips the version check.
 */
export function chatNeedsProcessing(args: {
  hasEntities: boolean;
  entry: unknown;
  hash: string;
  serverVersion: number | null;
}): boolean {
  if (!args.hasEntities) return true;
  const norm = normalizeHashEntry(args.entry);
  if (!norm) return true;
  if (norm.hash !== args.hash) return true;
  if (args.serverVersion !== null && norm.version < args.serverVersion) {
    return true;
  }
  return false;
}

/** Junk filter: too short, purely numeric/punctuation. */
function isJunk(key: string): boolean {
  if (key.length < 2) return true;
  return /^[\d\W_]+$/.test(key);
}

/**
 * Aggregate per-chat entities into distinct entities with chat counts.
 * Only entities appearing in MORE than minChats different chats are kept
 * (default minChats = 3, i.e. 4+ chats). Spans below minScore are dropped
 * (unscored legacy spans count as 0, so any floor above 0 hides them
 * until a re-extract records scores).
 */
export function aggregateEntities(
  map: ChatEntityMap,
  minChats = 3,
  minScore = 0
): EntityAggregate[] {
  const acc = new Map<
    string,
    { forms: Map<string, number>; types: Map<string, number>; chats: Set<string> }
  >();
  for (const [chatId, ents] of Object.entries(map)) {
    const seen = new Set<string>();
    for (const e of ents || []) {
      if (!e || typeof e.name !== "string") continue;
      if ((typeof e.score === "number" ? e.score : 0) < minScore) continue;
      const key = normalizeEntityKey(e.name);
      if (isJunk(key) || seen.has(key)) continue;
      seen.add(key);
      let a = acc.get(key);
      if (!a) {
        a = { forms: new Map(), types: new Map(), chats: new Set() };
        acc.set(key, a);
      }
      const form = e.name.trim();
      a.forms.set(form, (a.forms.get(form) || 0) + 1);
      const t = (e.type || "MISC").toUpperCase();
      a.types.set(t, (a.types.get(t) || 0) + 1);
      a.chats.add(chatId);
    }
  }
  const out: EntityAggregate[] = [];
  for (const [key, a] of acc) {
    if (a.chats.size <= minChats) continue;
    const display =
      [...a.forms.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? key;
    const type =
      [...a.types.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "MISC";
    out.push({ key, display, type, chatCount: a.chats.size });
  }
  return out.sort(
    (a, b) => b.chatCount - a.chatCount || a.display.localeCompare(b.display)
  );
}

export function entityTypeLabel(t: string): string {
  switch ((t || "").toUpperCase()) {
    case "PER":
      return "People";
    case "ORG":
      return "Organizations";
    case "LOC":
      return "Places";
    case "MISC":
      return "Misc";
    default:
      return t || "Misc";
  }
}

/**
 * Autocomplete candidates for a mention query: substring match on display
 * (or key) in the candidates' existing rank order, minus already-picked
 * keys, capped. Blank queries match nothing.
 */
export function filterMentionCandidates(
  candidates: EntityAggregate[],
  query: string,
  exclude: readonly string[] = [],
  limit = 8
): EntityAggregate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set(exclude);
  const out: EntityAggregate[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (skip.has(c.key)) continue;
    if (c.display.toLowerCase().includes(q) || c.key.includes(q)) {
      out.push(c);
    }
  }
  return out;
}

/** Raw per-token NER output (no aggregation): entity like "B-ORG", token index, score. */
export interface NerRawToken {
  entity: string;
  score: number;
  index: number;
}

export interface NerEntityGroup {
  /** "ORG", "PER", ... (uppercased, B-/I- prefix stripped). */
  type: string;
  /** Token span covering whole words (inclusive). */
  lo: number;
  hi: number;
  /** Average word score across the group. */
  score: number;
  /** Internal grouping bookkeeping. */
  wordCount: number;
  pendingGap: number;
  /** True when the pending gap contains a list separator (",", ";", ":"). */
  pendingComma: boolean;
}

export interface NerWord {
  lo: number;
  hi: number;
  /** Lowercased joined surfaces, for separator/conjunction checks. */
  text: string;
  /** Null when no fragment of the word was tagged. */
  type: string | null;
  /**
   * Mean fragment support for the word type: each fragment contributes its
   * score when tagged with the winning type, else 0. A lone 0.98 fragment
   * beside an untagged sibling (Funk B-PER + O "##o") scores ~0.49, not
   * 0.98, so the confidence floor can suppress it. 0 when untagged.
   */
  score: number;
  /** True when the word holds no letters/digits (punctuation like "."). */
  glue: boolean;
}

/**
 * Split the surface list into maximal WordPiece word runs ("Xiao ##yi ##n"
 * is one word, "." is its own word). Each word takes a single type from its
 * highest-confidence tagged fragment — fragments can never stand alone, so a
 * mid-word type flip from model noise (I-ORG 0.43 inside a PER word) does not
 * split the word. The word score averages support across every fragment, so
 * untagged or disagreeing siblings dampen lone-fragment overconfidence.
 */
export function nerWordRuns(
  surfaces: string[],
  tokens: NerRawToken[]
): NerWord[] {
  const byIdx = new Map<number, NerRawToken>();
  for (const t of tokens) {
    if (!t || typeof t.index !== "number" || typeof t.entity !== "string") {
      continue;
    }
    if (!/^([BI])-(.+)$/.exec(t.entity)) continue;
    const prev = byIdx.get(t.index);
    const sc = typeof t.score === "number" ? t.score : 0;
    if (!prev || sc > (typeof prev.score === "number" ? prev.score : 0)) {
      byIdx.set(t.index, t);
    }
  }
  const words: NerWord[] = [];
  const n = surfaces.length;
  let i = 0;
  while (i < n) {
    const s = surfaces[i];
    if (!s || SPECIAL_TOKENS.has(s)) {
      i++;
      continue;
    }
    let j = i;
    if (!s.startsWith("##")) {
      while (j + 1 < n && surfaces[j + 1]?.startsWith("##")) j++;
    }
    let type: string | null = null;
    let best = 0;
    let glue = true;
    const frags: Array<{ type: string | null; score: number }> = [];
    for (let k = i; k <= j; k++) {
      const surf = surfaces[k] ?? "";
      if (!surf.startsWith("##") && !SPECIAL_TOKENS.has(surf)) {
        for (const ch of surf) {
          if (/[\p{L}\p{N}]/u.test(ch)) {
            glue = false;
            break;
          }
        }
      }
      const t = byIdx.get(k);
      if (!t) {
        frags.push({ type: null, score: 0 });
        continue;
      }
      const sc = typeof t.score === "number" ? t.score : 0;
      const ft = /^([BI])-(.+)$/.exec(t.entity)![2].toUpperCase();
      frags.push({ type: ft, score: sc });
      if (!type || sc > best) {
        type = ft;
        best = sc;
      }
    }
    const score =
      type === null || frags.length === 0
        ? 0
        : frags.reduce((s, f) => s + (f.type === type ? f.score : 0), 0) /
          frags.length;
    const text = surfaces
      .slice(i, j + 1)
      .join("")
      .toLowerCase();
    words.push({ lo: i, hi: j, text, type, score, glue });
    i = j + 1;
  }
  return words;
}

const LIST_SEPS = new Set([",", ";", ":"]);

/**
 * Group same-type tagged words across small punctuation gaps (the "." in
 * "MYHOROS.COM"). An untagged real word always splits the group ("Hi" in
 * "Braden Hi Braden", "and" in "Apple and Microsoft") — coordinations
 * enumerate distinct entities ("Max" / "Alex" / "Teo", "USPS" / "FedEx"),
 * so they must never fuse. The one exception is places, where "City, ST"
 * ("Sunnyvale, CA") is conventionally a single reference. Word spans are
 * exact, so recovery never fabricates fragments like "MHOROS" or "funk".
 */
export function groupNerWords(
  words: NerWord[],
  maxWordGap = 1,
  maxWords = 8
): NerEntityGroup[] {
  const groups: NerEntityGroup[] = [];
  let open: NerEntityGroup | null = null;
  for (const w of words) {
    if (!w.type) {
      // Punctuation gaps are tolerated, except commas which only places
      // span. A real word closes the group; its pending gap is discarded
      // (never absorbed into a span).
      const comma = LIST_SEPS.has(w.text);
      if (
        open &&
        w.glue &&
        open.pendingGap < maxWordGap &&
        (!comma || open.type === "LOC")
      ) {
        open.pendingGap += 1;
        if (comma) open.pendingComma = true;
      } else {
        open = null;
      }
      continue;
    }
    if (
      open &&
      open.type === w.type &&
      open.pendingGap <= maxWordGap &&
      open.wordCount + 1 + open.pendingGap <= maxWords &&
      // A comma-separated tail only belongs to a place when it reads as a
      // qualifier ("CA"), not another enumeration ("London", "Texas").
      !(open.pendingComma && (open.type !== "LOC" || w.text.length > 3))
    ) {
      open.hi = w.hi;
      open.score =
        (open.score * open.wordCount + w.score) / (open.wordCount + 1);
      open.wordCount += 1;
      open.pendingGap = 0;
      open.pendingComma = false;
    } else {
      open = {
        type: w.type,
        lo: w.lo,
        hi: w.hi,
        score: w.score,
        wordCount: 1,
        pendingGap: 0,
        pendingComma: false,
      };
      groups.push(open);
    }
  }
  return groups;
}

const BRACKET_PAIRS: Array<[string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Absorb immediately-adjacent hyphen-joined runs ("SP" + "-API", "art" in
 * "state-of-the-art") so hyphenated names never end up truncated. Only
 * extends over tight joins — a spaced hyphen ("Apple - Microsoft") stops
 * the extension.
 */
function extendHyphenated(
  source: string,
  s: number,
  e: number
): [number, number] {
  let a = s;
  let b = e;
  const isWordChar = (ch: string | undefined) =>
    !!ch && /[\p{L}\p{N}]/u.test(ch);
  while (source[b + 1] === "-" && isWordChar(source[b + 2])) {
    let j = b + 2;
    while (j + 1 < source.length && isWordChar(source[j + 1])) j++;
    b = j;
  }
  while (source[a - 1] === "-" && isWordChar(source[a - 2])) {
    let j = a - 2;
    while (j - 1 >= 0 && isWordChar(source[j - 1])) j--;
    a = j;
  }
  return [a, b];
}

/**
 * Absorb immediately-adjacent brackets so a recovered name never ends up
 * unbalanced ("San Francisco (CA" -> "San Francisco (CA)", "CA)" -> "(CA)").
 * Only repairs imbalance — names without brackets are left untouched.
 */
function balanceBrackets(
  source: string,
  s: number,
  e: number
): [number, number] {
  let name = source.slice(s, e + 1);
  for (const [o, c] of BRACKET_PAIRS) {
    const opens = countChar(name, o);
    let closes = countChar(name, c);
    let j = e + 1;
    while (closes < opens) {
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== c) break;
      e = j;
      j++;
      closes++;
      name = source.slice(s, e + 1);
    }
  }
  for (const [o, c] of BRACKET_PAIRS) {
    let opens = countChar(name, o);
    const closes = countChar(name, c);
    let j = s - 1;
    while (opens < closes) {
      while (j >= 0 && /\s/.test(source[j])) j--;
      if (source[j] !== o) break;
      s = j;
      j--;
      opens++;
      name = source.slice(s, e + 1);
    }
  }
  return [s, e];
}

/** Lowercased alphanumeric projection of a source text with a char index map. */
export interface TextProjection {
  folded: string;
  /** folded[i] came from source[map[i]]. */
  map: number[];
}

export function projectTextAlnum(source: string): TextProjection {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      folded += ch.toLowerCase();
      map.push(i);
    }
  }
  return { folded, map };
}

const SPECIAL_TOKENS = new Set(["[CLS]", "[SEP]", "[PAD]", "[MASK]", "[UNK]"]);

/**
 * Recover the exact source substring for a token span. The alphanumeric
 * content of the span's surfaces (including skipped O-tagged fragments) is
 * located in the source's alphanumeric projection, and the original slice is
 * returned — so "M ##Y ##H ##OR ##OS . CO ##M" resolves to "MYHOROS.COM",
 * never to the fabricated "MHOROS COM". Returns null when the span cannot be
 * located (tokenizer misalignment), in which case the entity is dropped.
 */
export function recoverSpanText(
  source: string,
  proj: TextProjection,
  surfaces: string[],
  lo: number,
  hi: number
): string | null {
  let needle = "";
  for (let i = lo; i <= hi; i++) {
    let s = surfaces[i];
    if (!s || SPECIAL_TOKENS.has(s)) continue;
    if (s.startsWith("##")) s = s.slice(2);
    for (const ch of s) {
      if (/[\p{L}\p{N}]/u.test(ch)) needle += ch.toLowerCase();
    }
  }
  if (!needle) return null;
  const pos = proj.folded.indexOf(needle);
  if (pos < 0) return null;
  const [bs, be] = balanceBrackets(
    source,
    proj.map[pos],
    proj.map[pos + needle.length - 1]
  );
  const [s, e] = extendHyphenated(source, bs, be);
  const name = source
    .slice(s, e + 1)
    .replace(/\s+/g, " ")
    .trim();
  return name.length >= 2 ? name : null;
}

/**
 * Top mentions for an arbitrary subset of chats (e.g. all chats in one
 * thread). Counts distinct chats mentioning each entity within the subset,
 * so a thread's top mentions reflect what that thread is about — no global
 * min-chats cutoff applied (min 1 chat).
 */
export function topEntitiesForChatIds(
  chatIds: string[] | Set<string>,
  map: ChatEntityMap,
  limit = 3,
  minScore = 0
): EntityAggregate[] {
  const ids = chatIds instanceof Set ? chatIds : new Set(chatIds);
  const sub: ChatEntityMap = {};
  for (const id of ids) {
    const ents = map[id];
    if (ents && ents.length > 0) sub[id] = ents;
  }
  if (Object.keys(sub).length === 0) return [];
  return aggregateEntities(sub, 0, minScore).slice(0, Math.max(0, limit));
}

/** Fixed group order for the entity map. Unknown types sink to the end. */
export function entityTypeRank(t: string): number {
  switch ((t || "").toUpperCase()) {
    case "PER":
      return 0;
    case "ORG":
      return 1;
    case "LOC":
      return 2;
    case "MISC":
      return 3;
    default:
      return 4;
  }
}
