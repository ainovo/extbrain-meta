import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import {
  ModelEndpointConfig,
  ParsedActivityItem,
  PromptTemplate,
} from "../lib/types";
import { SavedSummary } from "../lib/savedSummaries";
import { toggleActionItemInMarkdown } from "../lib/actionItems";
import {
  SavedSummaryThreadSource,
  appendSavedSummary,
  extractAbstract,
  updateSavedSummaryMarkdown,
} from "../lib/savedSummaries";
import { streamSynthesis } from "../lib/synthesize";
import { filterItemsByRange } from "../lib/topOfMind";
import {
  InteractiveSummaryMarkdown,
  ToggledActionItem,
} from "./InteractiveSummaryMarkdown";

interface Props {
  uuid: string;
  /** Summary template to generate with. */
  template: PromptTemplate;
  /** Saved-summary title, e.g. "Retrospective: Oct 12 – Oct 20, 2026". */
  title: string;
  items: ParsedActivityItem[];
  threads: SavedSummaryThreadSource[];
  synthesisModel: ModelEndpointConfig;
  maxTokensPerBatch: number;
  onOpenModelSettings: () => void;
  onDone?: (summaryId: string) => void;
  /** "panel" drops the card chrome and height cap for side-panel hosting. */
  variant?: "inline" | "panel";
  /** Shows a close button in the header when provided. */
  onClose?: () => void;
  /** Shows a "See all summaries" link once the summary is saved. */
  onViewAll?: () => void;
  /** Day-key range this summary covers; stamped onto the saved record. */
  range?: { startKey: string; endKey: string } | null;
  /** Previously saved summary to read instead of generating. */
  existing?: SavedSummary | null;
  /** "read" opens the existing summary without generating. */
  initialMode?: "read" | "generate";
  /** Hides the internal header row and footer (host renders its own bar). */
  chrome?: boolean;
  /** Host control bar: stop an in-flight run or start a fresh one. */
  controlsRef?: React.MutableRefObject<{
    stop: () => void;
    regenerate: () => void;
  } | null>;
  /** Reports generation status (including the initial state on mount). */
  onStatusChange?: (s: "idle" | "generating" | "done" | "error") => void;
  /** Reports the live progress note (model status) while generating. */
  onProgressChange?: (note: string | null) => void;
}

/**
 * Day/range summary generator: starts automatically on mount with the given
 * template (keyed remount per bucket + template), streams progress, and hands
 * the saved summary to the caller when done.
 */
export const RangeSummaryBox: React.FC<Props> = ({
  uuid,
  template,
  title,
  items,
  threads,
  synthesisModel,
  maxTokensPerBatch,
  onOpenModelSettings,
  onDone,
  variant = "inline",
  onClose,
  onViewAll,
  range = null,
  existing = null,
  initialMode = "generate",
  chrome = true,
  controlsRef,
  onStatusChange,
  onProgressChange,
}) => {
  const effectiveItems = range
    ? filterItemsByRange(items, range.startKey, range.endKey)
    : items;
  const readExisting =
    initialMode === "read" && existing !== null ? existing : null;
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">(
    readExisting ? "done" : effectiveItems.length > 0 ? "generating" : "idle"
  );
  const [markdown, setMarkdown] = useState(readExisting?.markdown ?? "");
  const [savedId, setSavedId] = useState<string | null>(
    readExisting?.id ?? null
  );
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const markdownRef = useRef("");
  markdownRef.current = markdown;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const templateRef = useRef(template);
  templateRef.current = template;
  const statusCb = useRef(onStatusChange);
  statusCb.current = onStatusChange;
  const progressCb = useRef(onProgressChange);
  progressCb.current = onProgressChange;

  // Host control bar + status mirror (used when chrome is off).
  useEffect(() => {
    statusCb.current?.(status);
    progressCb.current?.(progressNote);
    if (controlsRef) {
      controlsRef.current = {
        stop: () => abortRef.current?.abort(),
        regenerate: () => void generate(),
      };
    }
  });

  const toggleBox = (rec: ToggledActionItem, done: boolean) => {
    const next = toggleActionItemInMarkdown(markdown, rec, done);
    if (next === markdown) return;
    setMarkdown(next);
    if (savedId) updateSavedSummaryMarkdown(uuid, savedId, next);
  };

  const generate = async () => {
    if (effectiveItems.length === 0 || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("generating");
    setSavedId(null);
    setMarkdown("");
    markdownRef.current = "";
    setProgressNote(null);
    setError(null);
    try {
      const tpl = templateRef.current;
      const acc = await streamSynthesis({
        items: effectiveItems,
        templateName: tpl.name,
        systemInstruction: tpl.systemInstruction,
        modelConfig: synthesisModel,
        maxTokensPerBatch,
        signal: controller.signal,
        onDelta: (next) => {
          setMarkdown(next);
          markdownRef.current = next;
        },
        onProgress: setProgressNote,
      });
      // A superseded run (StrictMode remount) must not clobber the live one.
      if (abortRef.current !== controller) return;
      setProgressNote(null);
      if (!acc.trim()) {
        setStatus("error");
        setError("The model returned no content.");
        return;
      }
      setStatus("done");
      try {
        const rec = appendSavedSummary(uuid, {
          templateId: tpl.id,
          templateName: tpl.name,
          title,
          abstract: extractAbstract(acc),
          markdown: acc,
          threads,
          tags: [],
          chatCount: effectiveItems.length,
          range: range
            ? { start: range.startKey, end: range.endKey }
            : undefined,
        });
        setSavedId(rec.id);
        doneRef.current?.(rec.id);
      } catch {
        // persistence is best-effort; the content is still shown below
      }
    } catch (err: unknown) {
      if (abortRef.current !== controller) return;
      if (
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        setStatus(markdownRef.current ? "done" : "idle");
        setProgressNote(null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setProgressNote(null);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  useEffect(() => {
    // Read mode never generates on mount; the parent's keyed remount
    // restarts generation per bucket + template + request.
    if (!readExisting && effectiveItems.length > 0) void generate();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={
        variant === "panel"
          ? "space-y-3"
          : "rounded-xl border border-divider bg-white p-4 space-y-3"
      }
    >
      {chrome && (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink">{template.name}</span>
        <span className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention">
          {template.badge}
        </span>
        <div className="flex-1" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
            className="p-1.5 rounded-lg hover:bg-tag text-mention hover:text-ink transition shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {status === "generating" && (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
          >
            <X className="w-3.5 h-3.5" /> Stop
          </button>
        )}
        {status !== "generating" && effectiveItems.length > 0 && (
          <button
            type="button"
            onClick={() => void generate()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
          >
            {savedId ? "Regenerate" : "Retry"}
          </button>
        )}
        {status === "generating" && progressNote && (
          <span className="text-xs text-mention w-full">{progressNote}</span>
        )}
      </div>
      )}
      {effectiveItems.length === 0 && (
        <p className="text-xs text-mention/60">No chats in this range.</p>
      )}
      {error && (
        <p className="text-xs text-mention">
          Generation failed: {error}{" "}
          <button
            type="button"
            onClick={onOpenModelSettings}
            className="underline hover:text-ink"
          >
            Model settings
          </button>
        </p>
      )}
      {markdown && (
        <InteractiveSummaryMarkdown
          markdown={markdown}
          onToggleItem={toggleBox}
          disabled={status === "generating"}
          className={
            variant === "panel"
              ? "markdown-preview summary-markdown text-[13px] text-ink leading-relaxed"
              : "markdown-preview summary-markdown text-[13px] text-ink leading-relaxed max-h-72 overflow-y-auto"
          }
        />
      )}
      {chrome && status === "done" && savedId && onViewAll && (
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-xs font-medium text-mention hover:text-ink transition"
        >
          See all summaries <ArrowRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
