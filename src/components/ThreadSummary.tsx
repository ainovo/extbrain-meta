import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  ChevronDown,
  X,
  Copy,
  Check,
  Square,
  Download,
  Trash2,
} from "lucide-react";
import {
  ModelEndpointConfig,
  ParsedActivityItem,
  PromptTemplate,
} from "../lib/types";
import {
  BUILTIN_TEMPLATES,
  loadCustomThreadTemplates,
} from "../lib/promptTemplates";
import {
  InteractiveSummaryMarkdown,
  ToggledActionItem,
} from "./InteractiveSummaryMarkdown";
import { toggleActionItemInMarkdown } from "../lib/actionItems";
import {
  SavedSummary,
  appendSavedSummary,
  deleteSavedSummary,
  extractAbstract,
  loadSavedSummaries,
  updateSavedSummaryMarkdown,
} from "../lib/savedSummaries";
import {
  SynthesisPlan,
  formatSynthesisWarning,
  planSynthesis,
  streamSynthesis,
  synthesisNeedsConfirm,
} from "../lib/synthesize";

export interface ThreadSummaryOptions {
  threadKey: string;
  threadTitle?: string | null;
  uuid: string;
  items: ParsedActivityItem[];
  synthesisModel: ModelEndpointConfig;
  maxTokensPerBatch: number;
  onOpenModelSettings: () => void;
}

function deriveThreadTitle(
  items: ParsedActivityItem[],
  fallback?: string | null
): string {
  if (fallback && fallback.trim()) return fallback.trim().slice(0, 120);
  const sorted = [...items].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = sorted[0];
  const prompt = first?.turns[0]?.prompt?.trim() || first?.title?.trim() || "";
  if (!prompt) return "Thread summary";
  return prompt.length > 120 ? prompt.slice(0, 120).trimEnd() + "…" : prompt;
}

export function useThreadSummary({
  threadKey,
  threadTitle,
  uuid,
  items,
  synthesisModel,
  maxTokensPerBatch,
  onOpenModelSettings,
}: ThreadSummaryOptions) {
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(() =>
    loadCustomThreadTemplates()
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    BUILTIN_TEMPLATES[0].id
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">(
    "idle"
  );
  const [markdown, setMarkdown] = useState("");
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Pending template + plan while a large run waits for confirmation. */
  const [confirm, setConfirm] = useState<{
    plan: SynthesisPlan;
    tpl: PromptTemplate;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<SavedSummary[]>(() =>
    loadSavedSummaries(uuid).filter((s) =>
      s.threads.some((t) => t.key === threadKey)
    )
  );
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const markdownRef = useRef("");
  markdownRef.current = markdown;

  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...customTemplates],
    [customTemplates]
  );
  const selectedTemplate = useMemo(
    () =>
      allTemplates.find((t) => t.id === selectedTemplateId) ?? allTemplates[0],
    [allTemplates, selectedTemplateId]
  );

  // New thread → reset summary state and abort any in-flight stream.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setMarkdown("");
    setActiveSavedId(null);
    setProgressNote(null);
    setError(null);
    setConfirm(null);
    setDropdownOpen(false);
    setSaved(
      loadSavedSummaries(uuid).filter((s) =>
        s.threads.some((t) => t.key === threadKey)
      )
    );
  }, [threadKey, uuid]);

  // Leaving the view aborts the stream.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dropdownOpen]);

  const stop = () => abortRef.current?.abort();

  const generateWith = async (tpl: PromptTemplate, confirmed = false) => {
    if (items.length === 0) return;
    if (!confirmed) {
      const plan = planSynthesis(items, maxTokensPerBatch);
      if (synthesisNeedsConfirm(plan)) {
        setSelectedTemplateId(tpl.id);
        setDropdownOpen(false);
        setConfirm({ plan, tpl });
        return;
      }
    }
    setConfirm(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSelectedTemplateId(tpl.id);
    setDropdownOpen(false);
    setStatus("generating");
    setMarkdown("");
    setActiveSavedId(null);
    markdownRef.current = "";
    setProgressNote(null);
    setError(null);

    try {
      const acc = await streamSynthesis({
        items,
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
      setProgressNote(null);
      setStatus("done");
      if (acc.trim()) {
        const title = deriveThreadTitle(items, threadTitle);
        try {
          const rec = appendSavedSummary(uuid, {
            templateId: tpl.id,
            templateName: tpl.name,
            title,
            abstract: extractAbstract(acc),
            markdown: acc,
            threads: [{ key: threadKey, title, count: items.length }],
            tags: [],
            chatCount: items.length,
          });
          setSaved((prev) => [rec, ...prev]);
          setActiveSavedId(rec.id);
        } catch {
          // persistence is best-effort
        }
      }
    } catch (err: unknown) {
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
      abortRef.current = null;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdownRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setMarkdown("");
    setActiveSavedId(null);
    markdownRef.current = "";
    setProgressNote(null);
    setError(null);
    setConfirm(null);
  };

  const confirmGenerate = () => {
    if (confirm) void generateWith(confirm.tpl, true);
  };

  const cancelConfirm = () => setConfirm(null);

  const removeSaved = (id: string) => {
    try {
      deleteSavedSummary(uuid, id);
    } catch {
      // best-effort
    }
    setSaved((prev) => prev.filter((s) => s.id !== id));
  };

  const patchSavedMarkdown = (id: string, md: string) => {
    try {
      const all = updateSavedSummaryMarkdown(uuid, id, md);
      setSaved(all.filter((s) => s.threads.some((t) => t.key === threadKey)));
    } catch {
      // best-effort
    }
  };

  const toggleActiveItem = (item: ToggledActionItem, done: boolean) => {
    if (!activeSavedId) return;
    const next = toggleActionItemInMarkdown(markdownRef.current, item, done);
    if (next === markdownRef.current) return;
    setMarkdown(next);
    markdownRef.current = next;
    patchSavedMarkdown(activeSavedId, next);
  };

  return {
    allTemplates,
    selectedTemplate,
    selectedTemplateId,
    dropdownOpen,
    setDropdownOpen,
    status,
    markdown,
    activeSavedId,
    progressNote,
    error,
    copied,
    saved,
    wrapRef,
    items,
    onOpenModelSettings,
    generateWith,
    confirm,
    confirmGenerate,
    cancelConfirm,
    handleCopy,
    close,
    stop,
    removeSaved,
    patchSavedMarkdown,
    toggleActiveItem,
  };
}

export type ThreadSummaryApi = ReturnType<typeof useThreadSummary>;

export const ThreadSummaryButton: React.FC<{ api: ThreadSummaryApi }> = ({
  api,
}) => {
  const {
    wrapRef,
    status,
    dropdownOpen,
    setDropdownOpen,
    allTemplates,
    selectedTemplateId,
    generateWith,
    items,
  } = api;
  return (
    <div ref={wrapRef} className="relative inline-block shrink-0">
      <button
        type="button"
        disabled={items.length === 0 || status === "generating"}
        onClick={() => {
          setDropdownOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
      >
        <Sparkles className="w-3.5 h-3.5" />
        {status === "generating" ? "Summarizing…" : "Summarize"}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
        />
      </button>

      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-2 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-divider bg-canvas shadow-lg overflow-hidden">
              <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
                {allTemplates.map((tpl) => {
                  const active = tpl.id === selectedTemplateId;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => void generateWith(tpl)}
                      className={`w-full text-left rounded-lg px-3 py-2 transition ${
                        active ? "bg-tag" : "hover:bg-canvas"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink truncate">
                          {tpl.name}
                        </span>
                        <span className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention shrink-0">
                          {tpl.badge}
                        </span>
                        {active && status !== "idle" && (
                          <Check className="w-3.5 h-3.5 text-mention ml-auto shrink-0" />
                        )}
                      </div>
                      <p className="text-[11px] text-mention mt-0.5 line-clamp-2">
                        {tpl.description}
                      </p>
                    </button>
                  );
                })}
              </div>
        </div>
      )}
    </div>
  );
};

function formatSavedDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const SavedThreadRow: React.FC<{
  summary: SavedSummary;
  onDelete: (id: string) => void;
  onMarkdownChange: (id: string, markdown: string) => void;
}> = ({ summary, onDelete, onMarkdownChange }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [md, setMd] = useState(summary.markdown);
  useEffect(() => {
    setMd(summary.markdown);
  }, [summary.markdown]);

  const handleToggleItem = (item: ToggledActionItem, done: boolean) => {
    const next = toggleActionItemInMarkdown(md, item, done);
    if (next === md) return;
    setMd(next);
    onMarkdownChange(summary.id, next);
  };
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(summary.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };
  const handleDownload = () => {
    const blob = new Blob([summary.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug = summary.title
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    a.href = url;
    a.download = `${summary.createdAt.slice(0, 10)}-${slug || "summary"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <li>
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention shrink-0">
                {summary.templateName}
              </span>
              <span className="text-[11px] text-mention shrink-0">
                {formatSavedDate(summary.createdAt)}
              </span>
            </div>
            <p className="text-[13px] text-mention leading-relaxed mt-1.5">
              {summary.abstract || "No preview available."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0 mt-0.5"
          >
            {expanded ? "Hide" : "View"}
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
        {expanded && (
          <div className="mt-2">
            <InteractiveSummaryMarkdown
              markdown={md}
              onToggleItem={handleToggleItem}
              className="markdown-preview summary-markdown max-h-[480px] overflow-y-auto"
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition"
              >
                <Download className="w-3.5 h-3.5" /> .md
              </button>
              <button
                type="button"
                onClick={() => onDelete(summary.id)}
                className="inline-flex items-center gap-1 rounded-lg border border-divider bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-tag transition"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
};

export const ThreadSummaryPanel: React.FC<{ api: ThreadSummaryApi }> = ({
  api,
}) => {
  const {
    status,
    markdown,
    activeSavedId,
    progressNote,
    error,
    copied,
    saved,
    selectedTemplate,
    generateWith,
    confirm,
    confirmGenerate,
    cancelConfirm,
    handleCopy,
    close,
    stop,
    removeSaved,
    patchSavedMarkdown,
    toggleActiveItem,
    onOpenModelSettings,
  } = api;

  const showActive = status !== "idle" || markdown || error || confirm;
  const visibleSaved = markdown
    ? saved.filter((s) => s.markdown !== markdown)
    : saved;
  if (!showActive && visibleSaved.length === 0) return null;

  return (
    <div className="space-y-3">
    {showActive && (
    <div className="rounded-xl border border-divider bg-canvas overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-canvas">
        <Sparkles className="w-3.5 h-3.5 text-mention shrink-0" />
        <span className="text-xs font-semibold text-ink truncate">
          Summary · {selectedTemplate?.name ?? "Thread"}
        </span>
        {status === "generating" && (
          <span className="text-[11px] text-mention">
            {progressNote ?? "Generating…"}
          </span>
        )}
        <span className="flex-1" />
        {status === "generating" ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-1 rounded-lg border border-divider bg-white px-2.5 py-1 text-[11px] font-medium text-mention hover:bg-canvas transition"
          >
            <Square className="w-3 h-3" /> Stop
          </button>
        ) : (
          <>
            {markdown && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-lg border border-divider bg-white px-2.5 py-1 text-[11px] font-medium text-mention hover:bg-canvas transition"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-ink" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" /> Copy
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={close}
              className="p-1 rounded-lg hover:bg-tag text-mention/60 hover:text-mention transition"
              aria-label="Close summary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {confirm ? (
        <div className="px-4 py-3 space-y-2">
          <p className="text-[13px] text-ink leading-relaxed">
            {formatSynthesisWarning(confirm.plan, { noun: "thread" })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmGenerate}
              className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition"
            >
              Generate anyway
            </button>
            <button
              type="button"
              onClick={cancelConfirm}
              className="inline-flex items-center gap-1 rounded-lg border border-divider bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-tag transition"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="px-4 py-3 text-[13px] text-ink flex flex-wrap items-center gap-3">
          <span>Error: {error}</span>
          <button
            type="button"
            onClick={onOpenModelSettings}
            className="rounded-lg bg-white border border-divider px-3 py-1.5 text-xs font-medium text-ink hover:bg-tag shrink-0"
          >
            Model settings
          </button>
          {selectedTemplate && (
            <button
              type="button"
              onClick={() => void generateWith(selectedTemplate)}
              className="text-xs underline hover:text-ink"
            >
              Retry
            </button>
          )}
        </div>
      ) : markdown ? (
        <InteractiveSummaryMarkdown
          markdown={markdown}
          streaming={status === "generating"}
          disabled={status === "generating" || !activeSavedId}
          onToggleItem={toggleActiveItem}
          className="markdown-preview summary-markdown px-4 py-3 max-h-[480px] overflow-y-auto"
        />
      ) : (
        status === "generating" && (
          <div className="px-4 py-6 text-center">
            <div className="h-1.5 rounded-full bg-tag overflow-hidden max-w-xs mx-auto">
              <div className="h-full w-1/3 bg-divider rounded-full animate-pulse" />
            </div>
            <div className="mt-2 text-[12px] text-mention">
              {progressNote ?? "Contacting LLM…"}
            </div>
          </div>
        )
      )}
    </div>
    )}

    {visibleSaved.length > 0 && (
      <div className="rounded-xl border border-divider bg-canvas overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-canvas">
          <Sparkles className="w-3.5 h-3.5 text-mention shrink-0" />
          <span className="text-xs font-semibold text-ink">
            Saved {visibleSaved.length === 1 ? "summary" : "summaries"} · this thread
          </span>
        </div>
        <ul className="divide-y divide-divider/70">
          {visibleSaved.map((s) => (
            <SavedThreadRow
              key={s.id}
              summary={s}
              onDelete={removeSaved}
              onMarkdownChange={patchSavedMarkdown}
            />
          ))}
        </ul>
      </div>
    )}
    </div>
  );
};
