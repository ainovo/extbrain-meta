import React, { useMemo, useState, useEffect } from "react";
import { MessageSquare, CalendarDays } from "lucide-react";
import { ParsedActivityItem } from "../lib/types";
import { MarkdownView } from "./MarkdownView";

interface Props {
  items: ParsedActivityItem[];
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Unknown date";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const ChatHistoryExplorer: React.FC<Props> = ({ items }) => {
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "local";
    }
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, ParsedActivityItem[]>();
    for (const it of items) {
      const k = localDayKey(it.timestamp);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    // sort items within each day by timestamp asc
    for (const [, arr] of map) {
      arr.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
    // days descending (most recent first)
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [items]);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    if (grouped.length > 0 && !selectedDay) {
      setSelectedDay(grouped[0][0]);
    }
    if (selectedDay && !grouped.some(([k]) => k === selectedDay)) {
      setSelectedDay(grouped.length > 0 ? grouped[0][0] : null);
    }
  }, [grouped]);

  const selectedItems = useMemo(() => {
    if (!selectedDay) return [];
    return grouped.find(([k]) => k === selectedDay)?.[1] ?? [];
  }, [grouped, selectedDay]);

  if (items.length === 0) return null;

  return (
    <div className="rounded-2xl border border-divider/80 bg-canvas shadow-[0_1px_3px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-divider/80 bg-canvas">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-mention" />
          <h3 className="text-sm font-semibold text-ink">
            Chat History Timeline
          </h3>
          <span className="text-[11px] text-mention/60">
            {grouped.length} days • times shown in {timeZone}
          </span>
        </div>
      </div>

      <div className="flex flex-col md:flex-row min-h-[480px] max-h-[640px]">
        {/* Sidebar: days */}
        <aside className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-divider/80 bg-canvas overflow-y-auto max-h-48 md:max-h-[640px]">
          {grouped.map(([dayKey, dayItems]) => {
            const isActive = dayKey === selectedDay;
            return (
              <button
                key={dayKey}
                type="button"
                onClick={() => setSelectedDay(dayKey)}
                className={`w-full text-left px-4 py-3 border-b border-divider/60 transition flex items-center justify-between gap-2 ${
                  isActive ? "bg-canvas border-l-2 border-l-action" : "hover:bg-canvas"
                }`}
              >
                <div className="min-w-0">
                  <div
                    className={`text-[13px] font-medium truncate ${
                      isActive ? "text-ink" : "text-mention"
                    }`}
                  >
                    {formatDayLabel(dayKey)}
                  </div>
                  <div className="text-[11px] text-mention/60 font-mono">
                    {dayKey}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0 ${
                    isActive
                      ? "bg-action text-white"
                      : "bg-tag/70 text-mention"
                  }`}
                >
                  {dayItems.length}
                </span>
              </button>
            );
          })}
        </aside>

        {/* Chat window: OpenAI style */}
        <div className="flex-1 flex flex-col min-w-0 bg-canvas">
          <div className="px-5 py-2.5 border-b border-divider flex items-center gap-2">
            <MessageSquare className="w-3.5 h-3.5 text-mention/60" />
            <span className="text-xs font-medium text-mention">
              {selectedDay ? formatDayLabel(selectedDay) : "Select a day"}
            </span>
            <span className="text-[11px] text-mention/60">
              {selectedItems.length} chats • {timeZone}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 bg-canvas">
            {selectedItems.map((item) => (
              <div key={item.id} className="space-y-3">
                <div className="text-center">
                  <span className="inline-block rounded-full bg-tag px-3 py-1 text-[11px] text-mention font-mono">
                    {formatLocalTime(item.timestamp)} • {item.header}
                  </span>
                </div>
                {item.turns.map((t, idx) => (
                  <div key={idx} className="space-y-3">
                    {/* User: right aligned */}
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-action text-white px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap shadow-xs">
                        {t.prompt}
                      </div>
                    </div>
                    {/* AI: left aligned */}
                    {t.responseMarkdown && (
                      <div className="flex justify-start">
                        <MarkdownView
                          markdown={t.responseMarkdown.slice(0, 4000)}
                          className="max-w-[90%] rounded-2xl rounded-bl-md border border-divider bg-canvas px-4 py-3 text-[13px] leading-relaxed text-ink ai-rich break-words"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {selectedItems.length === 0 && (
              <div className="text-center text-sm text-mention/60 py-16">
                Select a day on the left to view chats.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
