import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Sparkles, Square, X } from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import type { ChatEntityMap } from "../lib/entities";
import type { ModelEndpointConfig, ParsedActivityItem } from "../lib/types";
import {
  blobToBase64,
  convertToWav24kMono,
  runVoiceAgentTurn,
  startVoiceRecording,
  transcribeVoiceClip,
  VoiceEndpointDetector,
  type VoiceMessage,
  type VoiceRecorder,
} from "../lib/voiceAgent";

/** Auto-stop recordings here: 90s of 24kHz mono 16-bit PCM is ~4MB. */
const MAX_RECORD_MS = 90_000;

interface Turn {
  id: number;
  kind: "user" | "agent" | "error";
  text: string;
}

let turnId = 0;
const nextTurn = (kind: Turn["kind"], text: string): Turn => ({
  id: ++turnId,
  kind,
  text,
});

function formatSecs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const VoiceAssistant: React.FC<{
  items: ParsedActivityItem[];
  entityMap: ChatEntityMap;
  voiceModel: ModelEndpointConfig;
  minScore?: number;
}> = ({ items, entityMap, voiceModel, minScore = 0 }) => {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const messagesRef = useRef<VoiceMessage[]>([]);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pulseRef = useRef<HTMLSpanElement | null>(null);
  const stoppingRef = useRef(false);
  const endpointRef = useRef<VoiceEndpointDetector | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const entityMapRef = useRef(entityMap);
  entityMapRef.current = entityMap;

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const disposeRecorder = () => {
    try {
      recorderRef.current?.dispose();
    } catch {
      // ignore cleanup errors
    }
    recorderRef.current = null;
    endpointRef.current = null;
    stopTimer();
    setRecording(false);
    setElapsed(0);
  };

  // Leaving the page (or unmount) releases the mic and aborts pipelines.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      disposeRecorder();
    },
    []
  );

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy, open]);

  // Talking vibration: while recording, pulse an inner disc with the
  // live input level (styles mutate directly — no 60fps re-renders). The
  // button box itself never moves, so taps always land while it throbs.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const target = recorderRef.current?.level() ?? 0;
      smooth = Math.max(target, smooth * 0.86);
      const disc = pulseRef.current;
      if (disc) {
        disc.style.scale = `${1 + smooth * 0.25}`;
        disc.style.opacity = smooth > 0.02 ? "1" : "0";
        disc.style.boxShadow =
          smooth > 0.02
            ? `0 0 0 ${Math.round(smooth * 14)}px rgba(239, 68, 68, ${0.35 * smooth})`
            : "";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  const runPipeline = async (audio: Blob) => {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setBusy("Transcribing…");
      const wav = await convertToWav24kMono(audio);
      const transcript = await transcribeVoiceClip(
        await blobToBase64(wav),
        controller.signal
      );
      if (!transcript) {
        setTurns((prev) => [
          ...prev,
          nextTurn("error", "I couldn't hear anything. Try again?"),
        ]);
        return;
      }
      const convo: VoiceMessage[] = [
        ...messagesRef.current,
        { role: "user", content: transcript },
      ];
      setTurns((prev) => [...prev, nextTurn("user", transcript)]);
      setBusy("Thinking…");
      const { messages, text } = await runVoiceAgentTurn({
        model: voiceModel.model,
        messages: convo,
        items: itemsRef.current,
        entityMap: entityMapRef.current,
        minScore,
        signal: controller.signal,
        onStatus: (status) => setBusy(status),
      });
      messagesRef.current = messages;
      setTurns((prev) => [
        ...prev,
        nextTurn(
          "agent",
          text || "I couldn't put together an answer. Try rephrasing?"
        ),
      ]);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setTurns((prev) => [
        ...prev,
        nextTurn(
          "error",
          err instanceof Error ? err.message : String(err)
        ),
      ]);
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  };

  const stopRecording = async (recorder: VoiceRecorder) => {
    // MediaRecorder stops async; a second tap before it settles must not
    // run the pipeline twice.
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      const audio = await recorder.stop();
      if (audio.size > 0) await runPipeline(audio);
    } catch (err: unknown) {
      setTurns((prev) => [
        ...prev,
        nextTurn("error", err instanceof Error ? err.message : String(err)),
      ]);
    } finally {
      stoppingRef.current = false;
      disposeRecorder();
    }
  };

  const toggleMic = async () => {
    if (busy) return;
    if (recording && recorderRef.current) {
      await stopRecording(recorderRef.current);
      return;
    }
    if (itemsRef.current.length === 0) {
      setOpen(true);
      setTurns((prev) => [
        ...prev,
        nextTurn("error", "Load chats first, then ask about them by voice."),
      ]);
      return;
    }
    setOpen(true);
    try {
      const recorder = await startVoiceRecording();
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      endpointRef.current = new VoiceEndpointDetector(Date.now());
      setElapsed(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsed(ms);
        if (recorderRef.current !== recorder) return;
        if (ms >= MAX_RECORD_MS) {
          void stopRecording(recorder);
          return;
        }
        // Auto-send when the user finishes: trailing silence after speech
        // ends the turn, so no second tap is needed. Manual tap still works.
        const detector = endpointRef.current;
        if (detector?.update(recorder.level(), Date.now())) {
          void stopRecording(recorder);
        }
      }, 250);
    } catch (err: unknown) {
      setTurns((prev) => [
        ...prev,
        nextTurn("error", err instanceof Error ? err.message : String(err)),
      ]);
    }
  };

  const cancelWork = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
  };

  const close = () => {
    if (recording) disposeRecorder();
    cancelWork();
    setOpen(false);
  };

  const resetConversation = () => {
    if (recording || busy) return;
    messagesRef.current = [];
    setTurns([]);
  };

  const idle = !recording && busy === null;

  return (
    <>
      {open && (
        <div
          aria-hidden
          onClick={() => {
            // Dismiss on backdrop tap, but never mid-recording or mid-run.
            if (idle) close();
          }}
          className="fixed inset-0 z-30 backdrop-blur-sm bg-black/10"
        />
      )}
      {open && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-divider bg-white shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-canvas">
            <Sparkles className="w-3.5 h-3.5 text-mention shrink-0" />
            <span className="text-xs font-semibold text-ink">
              Voice agent
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={resetConversation}
              disabled={recording || busy !== null}
              title="Start a new conversation"
              className="text-[11px] font-medium text-mention hover:text-ink disabled:opacity-40 transition"
            >
              New
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close voice agent"
              className="p-1 rounded-lg hover:bg-tag text-mention/60 hover:text-mention transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div
            ref={bodyRef}
            className="px-4 py-3 space-y-3 max-h-[50vh] overflow-y-auto"
          >
            {turns.length === 0 && !busy && !recording && (
              <p className="text-[13px] text-mention/70 text-center py-4">
                Tap the mic and ask about your chats — e.g. “What did we
                decide about the Shopify ads last month?”
              </p>
            )}
            {turns.map((t) =>
              t.kind === "user" ? (
                <div key={t.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-tag px-4 py-2.5 text-[13px] leading-relaxed text-ink whitespace-pre-wrap break-words">
                    {t.text}
                  </div>
                </div>
              ) : t.kind === "agent" ? (
                <MarkdownView
                  key={t.id}
                  markdown={t.text}
                  className="text-[13px] leading-relaxed text-ink break-words"
                />
              ) : (
                <div
                  key={t.id}
                  className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-mention"
                >
                  {t.text}
                </div>
              )
            )}
            {(recording || busy) && (
              <div className="flex items-center gap-2 text-xs text-mention">
                {recording ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-red-500 motion-safe:animate-pulse shrink-0" />
                    Listening… {formatSecs(elapsed)}
                    <span className="flex-1" />
                    <span className="text-[11px] text-mention/70">
                      Auto-sends on pause · tap mic to end now
                    </span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-action motion-safe:animate-pulse shrink-0" />
                    {busy}
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={cancelWork}
                      className="inline-flex items-center gap-1 rounded-lg border border-divider bg-white px-2.5 py-1 text-[11px] font-medium text-mention hover:bg-canvas transition"
                    >
                      <Square className="w-3 h-3" /> Stop
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={toggleMic}
        disabled={busy !== null}
        title={recording ? "Stop recording" : "Ask by voice"}
        aria-label={recording ? "Stop recording" : "Ask by voice"}
        className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-14 h-14 rounded-full shadow-lg transition-colors flex items-center justify-center disabled:opacity-60 ${
          recording
            ? "bg-red-500 text-white"
            : "bg-action text-white hover:bg-action-hover"
        }`}
      >
        {recording && (
          <span
            ref={pulseRef}
            aria-hidden
            className="absolute inset-0 rounded-full bg-red-500 opacity-0 pointer-events-none"
          />
        )}
        {recording ? (
          <MicOff className="w-6 h-6 relative" />
        ) : (
          <Mic className="w-6 h-6" />
        )}
      </button>
    </>
  );
};
