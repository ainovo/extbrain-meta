import React, { useEffect, useMemo, useState } from "react";
import { CalendarPlus, ChevronDown, ChevronRight, Square, SquareCheck } from "lucide-react";
import {
  ActionItem,
  collectActionItems,
  collectCompletedActionItems,
  formatDeadlineChip,
  googleCalendarTemplateUrl,
  toggleActionItemInMarkdown,
} from "../lib/actionItems";
import { loadSavedSummaries, updateSavedSummaryMarkdown } from "../lib/savedSummaries";
import { MarkdownView } from "./MarkdownView";
import { SidebarView } from "./Sidebar";

function localTodayKey(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate()
  ).padStart(2, "0")}`;
}

/** Full-page list of every action item across saved summaries. */
export const ActionItemsView: React.FC<{
  uuid: string;
  onOpenThread: (key: string) => void;
  onNavigate: (v: SidebarView) => void;
}> = ({ uuid, onOpenThread, onNavigate }) => {
  const [summaries, setSummaries] = useState(() => loadSavedSummaries(uuid));
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    setSummaries(loadSavedSummaries(uuid));
  }, [uuid]);
  const today = localTodayKey();

  const openItems = useMemo(() => collectActionItems(summaries, new Date(), Infinity), [summaries]);
  const doneItems = useMemo(() => collectCompletedActionItems(summaries), [summaries]);

  const toggle = (item: ActionItem, done: boolean) => {
    const target = summaries.find((s) => s.id === item.summaryId);
    if (!target) return;
    const markdown = toggleActionItemInMarkdown(target.markdown, item, done);
    if (markdown === target.markdown) return;
    setSummaries(updateSavedSummaryMarkdown(uuid, target.id, markdown));
  };

  const renderRow = (a: ActionItem, done: boolean) => {
    const overdue = !done && a.deadline !== null && a.deadline < today;
    const chip = a.deadline ? formatDeadlineChip(a.deadline) : a.deadlineText;
    const BoxIcon = done ? SquareCheck : Square;
    return (
      <div
        key={a.id}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,button")) return;
          if (a.threadKey) onOpenThread(a.threadKey);
          else onNavigate("summary");
        }}
        title={`${a.summaryTitle}${chip ? ` (${chip})` : ""}`}
        className="w-full flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-tag text-left transition cursor-pointer"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle(a, !done);
          }}
          title={done ? "Mark open" : "Mark done"}
          className="shrink-0 mt-0.5 text-mention/60 hover:text-ink transition"
        >
          <BoxIcon className="w-3.5 h-3.5" />
        </button>
        <div className="flex-1 min-w-0">
          <MarkdownView
            markdown={a.text}
            className={`text-[13px] font-medium text-ink leading-snug ${done ? "line-through opacity-60" : ""}`}
          />
          <div className="truncate text-[11px] text-mention/60 mt-0.5">{a.summaryTitle}</div>
        </div>
        {chip && (
          <span
            title={chip}
            className={`shrink-0 text-[11px] font-mono mt-0.5 max-w-36 truncate ${
              overdue ? "font-semibold text-ink" : "text-mention"
            }`}
          >
            {overdue ? "Overdue " : ""}
            {chip}
          </span>
        )}
        {!done && (
          <a
            href={googleCalendarTemplateUrl({
              text: a.text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
              deadline: a.deadline,
              deadlineText: a.deadlineText,
              summaryTitle: a.summaryTitle,
            })}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Add to Google Calendar"
            className="shrink-0 mt-1 text-mention/40 hover:text-ink transition"
          >
            <CalendarPlus className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="min-w-0 px-1">
        <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
          Action Items
        </h2>
        <p className="text-[13px] text-mention mt-1">
          {openItems.length} open
          {doneItems.length > 0 ? ` · ${doneItems.length} completed` : ""} · from saved
          summaries
        </p>
      </div>
      {openItems.length === 0 && doneItems.length === 0 ? (
        <div className="text-center text-sm text-mention/60 py-16">
          No action items yet — checklists and Next Actions sections in saved summaries feed
          this list.
        </div>
      ) : (
        <div className="-mx-2">
          {openItems.length === 0 ? (
            <p className="text-[13px] text-mention/60 px-2 py-2">All caught up.</p>
          ) : (
            openItems.map((a) => renderRow(a, false))
          )}
          {doneItems.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="flex items-center gap-1 px-2 py-2 text-xs text-mention/60 hover:text-ink transition"
            >
              {showDone ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              Completed ({doneItems.length})
            </button>
          )}
          {showDone && doneItems.map((a) => renderRow(a, true))}
        </div>
      )}
    </div>
  );
};
