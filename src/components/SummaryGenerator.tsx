import React, { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Trash2,
  Copy,
  Check,
  Download,
  ChevronDown,
  MessagesSquare,
  Tags,
} from "lucide-react";
import { PromptTemplate } from "../lib/types";
import { toggleActionItemInMarkdown } from "../lib/actionItems";
import {
  InteractiveSummaryMarkdown,
  ToggledActionItem,
} from "./InteractiveSummaryMarkdown";
import {
  BUILTIN_TEMPLATES,
  loadCustomThreadTemplates,
} from "../lib/promptTemplates";
import {
  SavedSummary,
  deleteSavedSummary,
  loadSavedSummaries,
  updateSavedSummaryMarkdown,
} from "../lib/savedSummaries";

interface SummaryGeneratorProps {
  uuid: string;
  onOpenThread: (key: string) => void;
  onOpenTag: (id: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortTitle(title: string, limit = 70): string {
  const t = title.trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit).trimEnd() + "…";
}

const SummaryCard: React.FC<{
  summary: SavedSummary;
  uuid: string;
  onOpenThread: (key: string) => void;
  onOpenTag: (id: string) => void;
  onDelete: (id: string) => void;
  onSummariesChange: (s: SavedSummary[]) => void;
}> = ({ summary, uuid, onOpenThread, onOpenTag, onDelete, onSummariesChange }) => {
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
    onSummariesChange(updateSavedSummaryMarkdown(uuid, summary.id, next));
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
    <div className="rounded-xl border border-divider bg-canvas overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="text-sm font-medium text-ink truncate"
              title={summary.title}
            >
              {summary.title}
            </div>
            <div className="text-[11px] text-mention mt-0.5">
              {formatDate(summary.createdAt)} · {summary.chatCount}{" "}
              {summary.chatCount === 1 ? "chat" : "chats"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
          >
            {expanded ? "Hide" : "View"}
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        <p className="text-[13px] text-mention leading-relaxed mt-2">
          {summary.abstract || "No preview available."}
        </p>

        {(summary.threads.length > 0 || summary.tags.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {summary.threads.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onOpenThread(t.key)}
                title={`View thread: ${t.title}`}
                className="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] font-medium text-mention hover:bg-divider transition min-w-0 max-w-full"
              >
                <MessagesSquare className="w-3 h-3 shrink-0" />
                <span className="truncate max-w-48">
                  {shortTitle(t.title, 50)}
                </span>
                <span className="font-mono text-mention/60 shrink-0">
                  {t.count}
                </span>
              </button>
            ))}
            {summary.tags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenTag(t.id)}
                title={`View tag: ${t.name}`}
                className="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] font-medium text-mention hover:bg-divider transition"
              >
                <Tags className="w-3 h-3 shrink-0" />
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-divider">
          <InteractiveSummaryMarkdown
            markdown={md}
            onToggleItem={handleToggleItem}
            className="markdown-preview summary-markdown px-4 py-3 max-h-[480px] overflow-y-auto"
          />
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-t border-divider bg-canvas">
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
            <span className="flex-1" />
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
  );
};

export const SummaryGenerator: React.FC<SummaryGeneratorProps> = ({
  uuid,
  onOpenThread,
  onOpenTag,
}) => {
  // Custom templates are managed on the Settings page; this list only
  // resolves display names. The component remounts per navigation, so edits
  // made in Settings are picked up on return.
  const [customTemplates] = useState<PromptTemplate[]>(() =>
    loadCustomThreadTemplates()
  );
  const [summaries, setSummaries] = useState<SavedSummary[]>(() =>
    loadSavedSummaries(uuid)
  );

  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...customTemplates],
    [customTemplates]
  );

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { templateId: string; templateName: string; items: SavedSummary[] }
    >();
    for (const s of summaries) {
      let g = map.get(s.templateId);
      if (!g) {
        const tpl = allTemplates.find((t) => t.id === s.templateId);
        g = {
          templateId: s.templateId,
          templateName: tpl?.name ?? s.templateName,
          items: [],
        };
        map.set(s.templateId, g);
      }
      g.items.push(s);
    }
    const out = Array.from(map.values());
    // Most recently used template first.
    out.sort((a, b) =>
      (b.items[0]?.createdAt ?? "").localeCompare(a.items[0]?.createdAt ?? "")
    );
    for (const g of out) {
      g.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return out;
  }, [summaries, allTemplates]);

  const handleDeleteSummary = (id: string) => {
    setSummaries(deleteSavedSummary(uuid, id));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 px-1">
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
            Summaries
          </h2>
          <p className="text-[13px] text-mention mt-1">
            {summaries.length}{" "}
            {summaries.length === 1 ? "summary" : "summaries"}
          </p>
        </div>
      </div>

      <section className="space-y-8">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-mention/60">
          Summaries
        </h3>
        {summaries.length === 0 ? (
          <div className="text-center text-sm text-mention/60 py-10">
            <FileText className="w-5 h-5 mx-auto mb-2 text-mention/60" />
            No summaries yet — open a thread and hit Summarize.
          </div>
        ) : (
          grouped.map((g) => (
            <section key={g.templateId} aria-label={g.templateName}>
              <div className="px-1 flex items-baseline gap-2 pb-1">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-mention/60">
                  {g.templateName}
                </h4>
                <span className="text-[11px] text-mention/60 font-mono">
                  {g.items.length}{" "}
                  {g.items.length === 1 ? "summary" : "summaries"}
                </span>
                <div className="flex-1 h-px bg-tag/70 translate-y-[-3px]" />
              </div>
              <div className="space-y-3">
                {g.items.map((s) => (
                  <SummaryCard
                    key={s.id}
                    summary={s}
                    uuid={uuid}
                    onOpenThread={onOpenThread}
                    onOpenTag={onOpenTag}
                    onDelete={handleDeleteSummary}
                    onSummariesChange={setSummaries}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  );
};
