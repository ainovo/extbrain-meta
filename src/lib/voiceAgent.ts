import { normalizeEntityKey, type ChatEntityMap } from "./entities";
import { apiPost } from "./api";
import { dayKeyOf, filterItemsByRange } from "./topOfMind";
import type { ParsedActivityItem } from "./types";

// ============================================================================
// Recording + WAV encoding (Meta ASR wants mono 16-bit PCM WAV at 16/24kHz)
// ============================================================================

export interface VoiceRecorder {
  /** Resolves with the recorded audio once the recorder stops. */
  stop: () => Promise<Blob>;
  /** Release mic tracks immediately (after stop, or to cancel). */
  dispose: () => void;
  /** Current mic input level, 0..1, for button visualization. */
  level: () => number;
}

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/** Start a mic recording; throws when the mic is unavailable or denied. */
export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Voice input needs a microphone, which this browser exposes no access to.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  const rec = new MediaRecorder(
    stream,
    mimeType ? { mimeType } : undefined
  );
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<Blob>((resolve, reject) => {
    rec.onerror = () => reject(new Error("Recording failed."));
    rec.onstop = () =>
      resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
  });
  // Input-level tap for the talking vibration (best-effort: recording
  // works without it when Web Audio is unavailable).
  let analyser: AnalyserNode | null = null;
  let levelCtx: AudioContext | null = null;
  let levelBuf: Uint8Array<ArrayBuffer> | null = null;
  try {
    const AC = audioContextClass();
    if (AC) {
      levelCtx = new AC();
      void levelCtx.resume().catch(() => {});
      const src = levelCtx.createMediaStreamSource(stream);
      analyser = levelCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      levelBuf = new Uint8Array(analyser.fftSize);
    }
  } catch {
    analyser = null;
    levelCtx = null;
    levelBuf = null;
  }
  rec.start();
  return {
    stop: () => {
      if (rec.state !== "inactive") rec.stop();
      return stopped;
    },
    dispose: () => {
      for (const track of stream.getTracks()) track.stop();
      analyser = null;
      levelBuf = null;
      if (levelCtx) {
        void levelCtx.close().catch(() => {});
        levelCtx = null;
      }
    },
    level: () => {
      if (!analyser || !levelBuf) return 0;
      try {
        analyser.getByteTimeDomainData(levelBuf);
      } catch {
        return 0;
      }
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) {
        const v = (levelBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / levelBuf.length);
      return Math.max(0, Math.min(1, rms * 6));
    },
  };
}

// ============================================================================
// Endpointing: auto-stop when the user finishes speaking
// ============================================================================

/** Trailing silence that ends a turn (mid-sentence pauses are shorter). */
export const VOICE_ENDPOINT_SILENCE_MS = 1800;
/** No auto-stop before this long, so slow starts never cut off instantly. */
export const VOICE_ENDPOINT_MIN_RECORD_MS = 1500;
/** Mic level (0..1, same scale as VoiceRecorder.level) counting as speech. */
export const VOICE_ENDPOINT_LEVEL_THRESHOLD = 0.08;

export interface VoiceEndpointOptions {
  silenceMs?: number;
  minRecordMs?: number;
  threshold?: number;
}

/**
 * Trailing-silence endpoint detector. Feed live mic levels via update();
 * it returns true once the user has spoken and then gone quiet for
 * silenceMs. Sticky after detection. Pure logic (no DOM), so the
 * component polls it alongside the elapsed timer.
 */
export class VoiceEndpointDetector {
  private startMs: number;
  private readonly silenceMs: number;
  private readonly minRecordMs: number;
  private readonly threshold: number;
  private lastSpeechMs: number | null = null;
  private detected = false;

  constructor(startMs: number, options?: VoiceEndpointOptions) {
    this.startMs = startMs;
    this.silenceMs = options?.silenceMs ?? VOICE_ENDPOINT_SILENCE_MS;
    this.minRecordMs = options?.minRecordMs ?? VOICE_ENDPOINT_MIN_RECORD_MS;
    this.threshold = options?.threshold ?? VOICE_ENDPOINT_LEVEL_THRESHOLD;
  }

  /** Feed the current level at nowMs; true once the endpoint is reached. */
  update(level: number, nowMs: number): boolean {
    if (this.detected) return true;
    if (level >= this.threshold) {
      this.lastSpeechMs = nowMs;
      return false;
    }
    // No speech yet: never stop (also covers a missing level tap, where
    // level() always reads 0 — the turn falls back to manual/max stop).
    if (this.lastSpeechMs === null) return false;
    if (nowMs - this.startMs < this.minRecordMs) return false;
    if (nowMs - this.lastSpeechMs >= this.silenceMs) {
      this.detected = true;
      return true;
    }
    return false;
  }

  /** Restart for a new turn. */
  reset(startMs: number): void {
    this.startMs = startMs;
    this.lastSpeechMs = null;
    this.detected = false;
  }
}

/** Mono 16-bit PCM WAV writer (44-byte header + samples, little-endian). */
export function encodeWavMono16(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Decode any browser-supported recording to 24kHz mono WAV for the ASR endpoint. */
export async function convertToWav24kMono(blob: Blob): Promise<Blob> {
  const AC = audioContextClass();
  if (!AC) throw new Error("This browser cannot process audio.");
  const raw = await blob.arrayBuffer();
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(raw);
    const rate = 24000;
    const len = Math.max(1, Math.floor(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, len, rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    return new Blob([encodeWavMono16(samples, rate)], { type: "audio/wav" });
  } finally {
    void ctx.close().catch(() => {});
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(blob);
  });
}

async function readApiError(resp: Response, fallback: string): Promise<string> {
  try {
    const data = (await resp.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) {
      return data.error;
    }
  } catch {
    // fall through to the status-based message
  }
  return `${fallback} (${resp.status})`;
}

/** POST base64 WAV to the server transcribe endpoint; resolves the transcript. */
export async function transcribeVoiceClip(
  audioBase64: string,
  signal?: AbortSignal
): Promise<string> {
  const resp = await apiPost("/api/voice-transcribe", { audioBase64 }, { signal });
  if (!resp.ok) throw new Error(await readApiError(resp, "Transcription failed"));
  const data = (await resp.json()) as { transcript?: unknown };
  return typeof data.transcript === "string" ? data.transcript.trim() : "";
}

// ============================================================================
// find_chats tool (runs locally against loaded chats + NER mentions)
// ============================================================================

export interface FindChatsArgs {
  start_date: string;
  end_date: string;
  entities: string[];
}

export interface FoundChat {
  id: string;
  date: string;
  title: string;
  prompts: string;
  excerpt: string;
  matchedEntities: string[];
}

export interface FindChatsResult {
  chats: FoundChat[];
  /** Total matches before the display cap. */
  totalMatches: number;
  startDate: string;
  endDate: string;
  entities: string[];
}

export const FIND_CHATS_MAX_CHATS = 12;
const FIND_CHATS_MAX_TOTAL_CHARS = 15000;

function parseDayKey(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (
    d.getFullYear() !== Number(m[1]) ||
    d.getMonth() !== Number(m[2]) - 1 ||
    d.getDate() !== Number(m[3])
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function chatText(it: ParsedActivityItem): {
  haystack: string;
  haystackFlat: string;
  prompts: string;
  excerpt: string;
} {
  const prompts = it.allPromptsText || "";
  const response = it.condensedResponseText || it.fullMarkdown || "";
  const haystack = `${prompts}\n${response}`.toLowerCase();
  return {
    haystack,
    haystackFlat: haystack.replace(/\s+/g, ""),
    prompts,
    excerpt: response,
  };
}

function chatTitle(it: ParsedActivityItem): string {
  return (
    (it.cleanTitle || "").trim() ||
    (it.title || "").trim() ||
    (it.turns?.[0]?.prompt || "").trim().slice(0, 80) ||
    "Untitled chat"
  );
}

/**
 * Chats inside [start_date, end_date] mentioning ANY of the entities
 * (user-facing OR: one match suffices). Entity matching is forgiving:
 * a normalized NER mention hit, a case-insensitive substring hit, or a
 * spaceless hit ("openai" matches "Open AI"). Newest first.
 */
export function findChats(
  items: ParsedActivityItem[],
  entityMap: ChatEntityMap,
  args: FindChatsArgs,
  minScore = 0
): FindChatsResult {
  const startDate = parseDayKey(args.start_date);
  const endDate = parseDayKey(args.end_date);
  if (!startDate || !endDate) {
    throw new Error(
      "find_chats needs start_date and end_date as YYYY-MM-DD dates."
    );
  }
  const entities = (Array.isArray(args.entities) ? args.entities : [])
    .map((e) => (typeof e === "string" ? e.trim() : ""))
    .filter(Boolean);
  if (entities.length === 0) {
    throw new Error("find_chats needs at least one entity to search for.");
  }
  const ranged = filterItemsByRange(items, startDate, endDate);
  const scored = ranged.map((it) => {
    const keys = new Set<string>();
    for (const e of entityMap[it.id] || []) {
      if (!e || typeof e.name !== "string") continue;
      if ((typeof e.score === "number" ? e.score : 0) < minScore) continue;
      keys.add(normalizeEntityKey(e.name));
    }
    const text = chatText(it);
    const matched = entities.filter((raw) => {
      const low = raw.toLowerCase();
      if (keys.has(normalizeEntityKey(raw))) return true;
      if (low.length >= 2 && text.haystack.includes(low)) return true;
      const flat = low.replace(/\s+/g, "");
      return flat.length >= 4 && text.haystackFlat.includes(flat);
    });
    return { it, matched };
  });
  const hits = scored
    .filter((s) => s.matched.length > 0)
    .sort((a, b) => b.it.timestamp.localeCompare(a.it.timestamp));
  const chats: FoundChat[] = [];
  let chars = 0;
  for (const h of hits.slice(0, FIND_CHATS_MAX_CHATS)) {
    const text = chatText(h.it);
    const prompts =
      text.prompts.length > 400 ? text.prompts.slice(0, 400) + "…" : text.prompts;
    let excerpt =
      text.excerpt.length > 600 ? text.excerpt.slice(0, 600) + "…" : text.excerpt;
    if (chars + prompts.length + excerpt.length > FIND_CHATS_MAX_TOTAL_CHARS) {
      excerpt = excerpt.slice(
        0,
        Math.max(0, FIND_CHATS_MAX_TOTAL_CHARS - chars - prompts.length)
      );
    }
    chars += prompts.length + excerpt.length;
    chats.push({
      id: h.it.id,
      date: h.it.dateStr || dayKeyOf(h.it.timestamp) || h.it.timestamp.slice(0, 10),
      title: chatTitle(h.it),
      prompts,
      excerpt,
      matchedEntities: h.matched,
    });
    if (chars >= FIND_CHATS_MAX_TOTAL_CHARS) break;
  }
  return { chats, totalMatches: hits.length, startDate, endDate, entities };
}

/** Tool-result text the voice agent reads after find_chats runs. */
export function formatFindChatsResult(result: FindChatsResult): string {
  const range = `${result.startDate}..${result.endDate}`;
  if (result.totalMatches === 0) {
    return `No chats in ${range} mention any of: ${result.entities.join(", ")}.`;
  }
  const lines = [
    `Found ${result.totalMatches} chat(s) in ${range} mentioning any of: ${result.entities.join(", ")}. Showing ${result.chats.length}, newest first.`,
  ];
  for (const c of result.chats) {
    lines.push(
      `---\n[${c.date}] ${c.title} (matched: ${c.matchedEntities.join(", ")})`
    );
    if (c.prompts.trim()) lines.push(`User: ${c.prompts.trim()}`);
    if (c.excerpt.trim()) lines.push(`Excerpt: ${c.excerpt.trim()}`);
  }
  return lines.join("\n");
}

// ============================================================================
// Voice agent turn loop (client owns tool execution; server owns the model)
// ============================================================================

export interface VoiceToolCall {
  id: string;
  name: string;
  argsText: string;
}

export interface VoiceMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface VoiceAgentResponse {
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  };
}

async function voiceAgentStep(
  model: string,
  messages: VoiceMessage[],
  signal?: AbortSignal
): Promise<{ content: string | null; toolCalls: VoiceToolCall[] }> {
  const resp = await apiPost("/api/voice-agent", { model, messages }, { signal });
  if (!resp.ok) throw new Error(await readApiError(resp, "Voice agent failed"));
  const data = (await resp.json()) as VoiceAgentResponse;
  const msg = data.message ?? { content: null };
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        argsText: c.function.arguments,
      }))
    : [];
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    toolCalls,
  };
}

function executeVoiceTool(
  call: VoiceToolCall,
  items: ParsedActivityItem[],
  entityMap: ChatEntityMap,
  minScore: number
): string {
  if (call.name !== "find_chats") {
    return `Error: unknown tool "${call.name}". Only find_chats exists.`;
  }
  let args: unknown;
  try {
    args = JSON.parse(call.argsText);
  } catch {
    return "Error: find_chats arguments were not valid JSON.";
  }
  const a = (args || {}) as Record<string, unknown>;
  try {
    return formatFindChatsResult(
      findChats(
        items,
        entityMap,
        {
          start_date: typeof a.start_date === "string" ? a.start_date : "",
          end_date: typeof a.end_date === "string" ? a.end_date : "",
          entities: Array.isArray(a.entities)
            ? (a.entities as unknown[]).filter(
                (e): e is string => typeof e === "string"
              )
            : [],
        },
        minScore
      )
    );
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run one voice turn to completion: model steps alternate with local
 * find_chats execution until the model answers in text (no tool calls)
 * or the round cap hits. Returns the full appended conversation plus
 * the final answer text.
 */
export async function runVoiceAgentTurn(args: {
  model: string;
  messages: VoiceMessage[];
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  minScore?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}): Promise<{ messages: VoiceMessage[]; text: string }> {
  const {
    model,
    items,
    entityMap,
    minScore = 0,
    maxRounds = 4,
    signal,
    onStatus,
  } = args;
  const messages = [...args.messages];
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    const step = await voiceAgentStep(model, messages, signal);
    messages.push({
      role: "assistant",
      content: step.content,
      ...(step.toolCalls.length > 0
        ? {
            tool_calls: step.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.argsText },
            })),
          }
        : {}),
    });
    if (step.toolCalls.length === 0) {
      return { messages, text: (step.content || "").trim() };
    }
    for (const call of step.toolCalls) {
      signal?.throwIfAborted();
      onStatus?.(
        call.name === "find_chats"
          ? "Searching chats…"
          : `Running ${call.name}…`
      );
      const result = executeVoiceTool(call, items, entityMap, minScore);
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
    onStatus?.("Reading results…");
  }
  return {
    messages,
    text: "I found some chats but couldn't finish the answer in time. Could you narrow the dates or entities?",
  };
}
