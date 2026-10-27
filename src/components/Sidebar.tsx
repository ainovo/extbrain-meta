import React, { useEffect, useState } from "react";
import { ExtBrainLogo } from "./ExtBrainLogo";
import { ProcessJobSnapshot, processRunner } from "../lib/processRunner";
import {
  Upload,
  Tags,
  MessagesSquare,
  FileText,
  Settings,
  Menu,
  X,
  ChevronLeft,
  ChevronDown,
  Brain,
  ListChecks,
  History,
  Square,
} from "lucide-react";

export type SidebarView = "load" | "topics" | "summary" | "settings" | "chat" | "threads" | "top" | "actions";

export interface DayEntry {
  key: string;
  label: string;
  count: number;
}

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  view: SidebarView;
  onNavigate: (v: SidebarView) => void;
  historyCount: number;
  selectedCount: number;
  days: DayEntry[];
  selectedDay: string | null;
  onSelectDay: (dayKey: string) => void;
  uuid: string;
  timeZone: string;
}

function abbreviateUuid(uuid: string): string {
  const clean = uuid.replace(/-/g, "");
  return clean.length > 8 ? clean.slice(0, 8) : clean || "local";
}

const ITEMS: Array<{ id: Exclude<SidebarView, "settings">; label: string; icon: any; hint: string }> = [
  { id: "top", label: "Top of Mind", icon: Brain, hint: "Two-week overview" },
  { id: "load", label: "Load", icon: Upload, hint: "Import Takeout JSON" },
  { id: "threads", label: "Threads", icon: MessagesSquare, hint: "Resume source threads" },
  { id: "chat", label: "Chats", icon: History, hint: "Browse chat histories" },
  { id: "topics", label: "Tags", icon: Tags, hint: "Auto-tag chats" },
  { id: "summary", label: "Summaries", icon: FileText, hint: "Obsidian note" },
  { id: "actions", label: "Action Items", icon: ListChecks, hint: "Tasks from saved summaries" },
];

/** Live NER progress + stop, visible on every page while a run continues. */
function ProcessingIndicator({
  collapsed,
  uuid,
}: {
  collapsed: boolean;
  uuid: string;
}) {
  const [job, setJob] = useState<ProcessJobSnapshot>(() =>
    processRunner.getSnapshot()
  );
  useEffect(() => processRunner.subscribe(setJob), []);
  if (job.status !== "running" || job.uuid !== uuid) return null;
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  if (collapsed) {
    return (
      <div
        className="px-3 pb-2"
        title={`Processing chats ${job.done}/${job.total} steps`}
      >
        <div className="h-1.5 rounded-full bg-tag overflow-hidden">
          <div
            className="h-full bg-action transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="mx-2 mb-2 rounded-xl border border-divider bg-tag px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink flex-1 truncate">
          {job.phase === "categories" ? "Scoring" : "Processing"}{" "}
          {job.done}/{job.total}
        </span>
        <button
          type="button"
          onClick={() => processRunner.stop()}
          title="Stop processing"
          aria-label="Stop processing"
          className="p-1 rounded-md text-mention hover:text-ink hover:bg-divider/60 transition shrink-0"
        >
          <Square className="w-3 h-3" />
        </button>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-divider/50 overflow-hidden">
        <div
          className="h-full bg-action transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SidebarBody({
  collapsed,
  onToggleCollapse,
  view,
  onNavigate,
  historyCount,
  selectedCount,
  days,
  selectedDay,
  onSelectDay,
  uuid,
  timeZone,
  onCloseDrawer,
}: Omit<Props, "mobileOpen" | "onCloseMobile"> & { onCloseDrawer?: () => void }) {
  const [historiesOpen, setHistoriesOpen] = useState(true);
  const shortUuid = abbreviateUuid(uuid);
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Logo / product + expander/collapser at the top next to the title */}
      <div className="flex items-center gap-2 px-3 py-4 border-b border-divider/70 shrink-0">
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="group relative mx-auto"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white border border-divider">
              <ExtBrainLogo className="w-6 h-6" />
            </span>
            <span
              style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-divider bg-tag text-mention shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
            >
              <ChevronLeft className="w-4 h-4 rotate-180" />
            </span>
          </button>
        ) : (
          <>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white border border-divider">
              <ExtBrainLogo className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-2xl font-bold tracking-tight text-ink leading-tight">ExtBrain</div>
            </div>
        {onCloseDrawer ? (
          <button
            type="button"
            onClick={onCloseDrawer}
            className="rounded-full border border-divider bg-tag p-1.5 text-mention shadow-sm hover:bg-divider flex items-center justify-center shrink-0"
            title="Close menu"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-full border border-divider bg-tag p-1.5 text-mention shadow-sm hover:bg-divider flex items-center justify-center shrink-0"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronLeft className={`w-4 h-4 transition-transform ${collapsed ? "rotate-180" : ""}`} />
          </button>
        )}
          </>
        )}
      </div>

      {/* Nav */}
      <nav className="p-2 space-y-1 shrink-0">
        {ITEMS.map((it) => {
          const Icon = it.icon;
          const active = view === it.id;
          return (
            <button
              key={it.id}
              type="button"
              title={it.hint}
              onClick={() => onNavigate(it.id)}
              className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${
                active
                  ? "bg-action text-white"
                  : "text-mention hover:bg-tag"
              } ${collapsed ? "justify-center px-0" : ""}`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!collapsed && (
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium leading-tight truncate">{it.label}</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Expandable/collapsible Histories section: dates, one line each.
          Shown only on the Chats page, where day navigation applies. */}
      {!collapsed && view === "chat" && (
        <div className="flex-1 min-h-0 flex flex-col px-2 pb-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setHistoriesOpen((v) => !v)}
            className="w-full flex items-center gap-1 px-2 py-2 text-mention hover:text-ink transition shrink-0"
            aria-expanded={historiesOpen}
          >
            <span className="text-[13px] font-medium">Histories</span>
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${historiesOpen ? "" : "-rotate-90"}`}
            />
            <span className="ml-auto text-[11px] text-mention/60 font-mono">
              {days.length > 0 ? `${historyCount}` : ""}
            </span>
          </button>
          {historiesOpen && (
            <div className="flex-1 min-h-0 overflow-y-auto sb-scroll space-y-0.5 pb-1">
              {days.length === 0 && (
                <div className="px-2 py-2 text-[13px] text-mention/60">
                  No histories yet
                </div>
              )}
              {days.map((day) => {
                const isActive = day.key === selectedDay;
                return (
                  <button
                    key={day.key}
                    type="button"
                    title={day.label}
                    onClick={() => onSelectDay(day.key)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-[13px] leading-snug transition flex items-center gap-2 ${
                      isActive
                        ? "bg-tag text-ink font-medium"
                        : "text-ink hover:bg-tag"
                    }`}
                  >
                    <span className="flex-1 truncate min-w-0">{day.label}</span>
                    <span className="shrink-0 text-[11px] text-mention/60 font-mono">
                      {day.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Profile + settings pinned to the bottom */}
      <div className="mt-auto p-2 border-t border-divider/70 shrink-0">
        <ProcessingIndicator collapsed={collapsed} uuid={uuid} />
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              title="Settings"
              aria-label="Settings"
              onClick={() => onNavigate("settings")}
              className={`p-2 rounded-xl transition ${
                view === "settings"
                  ? "bg-action text-white"
                  : "text-mention hover:bg-tag hover:text-ink"
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          <button
            type="button"
            title={`${uuid} • ${timeZone}`}
            className="rounded-full hover:opacity-90 transition"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tag text-mention text-[15px] font-semibold uppercase">
              {shortUuid.slice(0, 1) || "E"}
            </span>
          </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-2 w-full">
          <button
            type="button"
            title={`${uuid} • ${timeZone}`}
            className="flex items-center gap-2.5 min-w-0 flex-1 text-left rounded-lg hover:bg-tag transition px-1 py-0.5 -ml-1"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tag text-mention text-[15px] font-semibold uppercase">
              {shortUuid.slice(0, 1) || "E"}
            </span>
            <span className="min-w-0 space-y-1">
              <span className="block text-[12px] font-medium text-ink font-mono leading-relaxed truncate">
                {uuid}
              </span>
              <span className="block text-[11px] text-mention/60 leading-relaxed truncate" title={timeZone}>
                {timeZone}
              </span>
            </span>
          </button>
            <button
              type="button"
              title="Settings"
              aria-label="Settings"
              onClick={() => onNavigate("settings")}
              className={`p-2 rounded-lg transition shrink-0 ${
                view === "settings"
                  ? "bg-action text-white"
                  : "text-mention hover:bg-tag hover:text-ink"
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        )}
        {!collapsed && (
          <div className="px-2 pt-1.5 text-center text-[10px] leading-relaxed text-mention/60">
            Proudly built 100% by Meta Muse Code
            <br />
            for{" "}
            <a
              href="https://cerebralvalley.ai/e/meta-ai-developer-hackathon"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-mention"
            >
              Meta Global AI Developer Hackathon
            </a>
            <br />© 2026 Ainovo Co.
          </div>
        )}
      </div>
    </div>
  );
}

export const Sidebar: React.FC<Props> = (props) => {
  const { collapsed, mobileOpen, onCloseMobile } = props;
  return (
    <>
      {/* Desktop */}
      <aside
        className={`hidden md:flex flex-col shrink-0 border-r border-divider bg-canvas transition-all duration-200 h-screen sticky top-0 ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <div className="flex-1 min-h-0">
          <SidebarBody {...props} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onCloseMobile} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-canvas shadow-2xl flex flex-col">
            <div className="flex-1 min-h-0">
              <SidebarBody {...props} collapsed={false} onCloseDrawer={onCloseMobile} />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export function SidebarHamburger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="md:hidden p-2 -ml-1 rounded-lg hover:bg-tag text-mention"
      aria-label="Open menu"
    >
      <Menu className="w-5 h-5" />
    </button>
  );
}
