import React, { useMemo, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import {
  DEFAULT_CONTRIBUTOR_MODEL,
  DEFAULT_MAX_TOKENS_PER_BATCH,
  DEFAULT_META_MODEL,
  DualModelConfig,
  isMetaModelId,
  MAX_MODEL_CONTEXT_TOKENS,
  META_MODEL_OPTIONS,
  ModelEndpointConfig,
  NER_BACKEND_OPTIONS,
  NerBackendId,
  NLI_BACKEND_OPTIONS,
  NliBackendId,
} from "../lib/types";
import { exportFileName, exportUserDataZip } from "../lib/exportData";
import {
  ChatEntityMap,
  EntityAggregate,
  aggregateEntities,
  entityTypeLabel,
  entityTypeRank,
} from "../lib/entities";
import { TemplateSettings } from "./TemplateSettings";

function EndpointEditor({
  title,
  subtitle,
  endpoint,
  defaultModel = DEFAULT_META_MODEL,
  onUpdate,
}: {
  title: string;
  subtitle: string;
  endpoint: ModelEndpointConfig;
  defaultModel?: string;
  onUpdate: (updated: ModelEndpointConfig) => void;
}) {
  return (
    <div className="space-y-3 py-1">
      <div>
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <p className="text-xs text-mention">{subtitle}</p>
      </div>

      <div>
        <label className="block text-xs text-mention mb-1">Meta model</label>
        <select
          value={
            isMetaModelId(endpoint.model) ? endpoint.model : defaultModel
          }
          onChange={(e) =>
            onUpdate({ provider: "meta", model: e.target.value })
          }
          className="w-full rounded-lg bg-white border border-divider px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-action"
        >
          {META_MODEL_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.hint}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-mention">
        Runs on Meta Model API (api.meta.ai). The API key lives in the server
        .env as MODEL_API_KEY — it is never stored in the browser.
      </p>
    </div>
  );
}

function SettingsSection({
  id,
  title,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="px-1 flex items-center gap-1.5 pb-1">
        <button
          type="button"
          onClick={() => onToggle(id)}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${title} section`}
          className="p-0.5 rounded hover:bg-tag text-mention/60 hover:text-mention transition shrink-0"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-mention/60">
          {title}
        </h3>
        <div className="flex-1 h-px bg-tag/70" />
      </div>
      {!collapsed && <div className="px-1 py-2">{children}</div>}
    </section>
  );
}

interface Props {
  uuid: string;
  config: DualModelConfig;
  onChange: (newConfig: DualModelConfig) => void;
  entityMap: ChatEntityMap;
  /** Shared App-level aggregation (same score floor). */
  mentionCandidates: EntityAggregate[];
}

/** Live entity cloud grouped by NER category, filtered by the score floor. */
function EntityCloudPreview({
  entityMap,
  floor,
  candidates,
}: {
  entityMap: ChatEntityMap;
  floor: number;
  /**
   * Shared App-level aggregation (same floor). When provided, the cloud
   * reuses it instead of re-folding the whole map on every Settings visit;
   * otherwise it folds lazily, only once expanded.
   */
  candidates?: EntityAggregate[];
}) {
  const [expanded, setExpanded] = useState(false);
  const aggregates = useMemo(
    () =>
      candidates ?? (expanded ? aggregateEntities(entityMap, 0, floor) : []),
    [candidates, expanded, entityMap, floor]
  );
  const groups = useMemo(() => {
    const byType = new Map<string, typeof aggregates>();
    for (const a of aggregates) {
      const list = byType.get(a.type) ?? [];
      list.push(a);
      byType.set(a.type, list);
    }
    return [...byType.entries()].sort(
      ([a], [b]) => entityTypeRank(a) - entityTypeRank(b)
    );
  }, [aggregates]);
  const hasEntities = Object.keys(entityMap).length > 0;
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 text-xs font-medium text-mention hover:text-ink transition"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        {expanded ? "Hide" : "Show"} entities passing this floor ({aggregates.length})
      </button>
      {expanded && (
        <div className="mt-2 max-h-72 overflow-y-auto space-y-3 pr-1">
          {!hasEntities && (
            <div className="text-xs text-mention">
              No processed entities yet — process chats on the Load page.
            </div>
          )}
          {hasEntities && aggregates.length === 0 && (
            <div className="text-xs text-mention">
              No entities pass this floor — lower it to see more.
            </div>
          )}
          {groups.map(([type, list]) => (
            <div key={type}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-mention mb-1">
                {entityTypeLabel(type)} · {list.length}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {list.map((a) => (
                  <span
                    key={a.key}
                    title={`${a.chatCount} ${a.chatCount === 1 ? "chat" : "chats"}`}
                    className="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] text-ink whitespace-nowrap"
                  >
                    {a.display}
                    <span className="text-mention/70 font-mono">
                      {a.chatCount}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Local-vs-Modal backend picker. Modal options are selectable so the
 * preference persists, but no Modal endpoint is wired yet — picking one
 * keeps the local model doing the work and says so below the picker.
 */
function BackendChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const modal = value !== "local";
  return (
    <div className="py-1">
      <label className="block text-sm font-medium text-ink">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-lg bg-white border border-divider px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-action"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {modal && (
        <p className="text-xs text-mention mt-1">
          The Modal endpoint isn&apos;t wired up yet — the local model still
          does the work.
        </p>
      )}
    </div>
  );
}

/** Settings page: collapsible sections, details flat without boxes. */
export const SettingsView: React.FC<Props> = ({ uuid, config, onChange, entityMap, mentionCandidates }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportUserDataZip(uuid, config);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFileName(uuid);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="px-1">
        <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-ink leading-tight">
          Settings
        </h2>
        <p className="text-xs text-mention mt-1">
          User ID{" "}
          <code className="font-mono bg-tag px-1.5 py-0.5 rounded">{uuid}</code>{" "}
          — histories persist in this browser under this ID across updates.
        </p>
      </div>

      <div className="space-y-8">
        <SettingsSection
          id="mentions"
          title="Mentions"
          collapsed={collapsed.has("mentions")}
          onToggle={toggle}
        >
          <BackendChoice<NerBackendId>
            label="NER model"
            value={config.nerBackend ?? "local"}
            options={NER_BACKEND_OPTIONS}
            onChange={(v) => onChange({ ...config, nerBackend: v })}
          />
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">
                Minimum chats per mention
              </div>
              <div className="text-xs text-mention">
                Entities must appear in at least this many chats to count.
                Applies instantly.
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={config.mentionMinChats ?? 4}
                onChange={(e) =>
                  onChange({
                    ...config,
                    mentionMinChats: Number(e.target.value),
                  })
                }
                aria-label="Minimum chats per mention"
                className="w-24 sm:w-32 accent-action"
              />
              <span className="text-xs font-mono text-ink">
                {config.mentionMinChats ?? 4}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">
                NER confidence floor
              </div>
              <div className="text-xs text-mention">
                Mentions scoring below this are hidden everywhere. Applies
                instantly; chats processed before scores were recorded need a
                reprocess on the Load page first.
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <input
                type="range"
                min={0}
                max={0.99}
                step={0.01}
                value={config.nerScoreFloor ?? 0}
                onChange={(e) =>
                  onChange({
                    ...config,
                    nerScoreFloor: Number(e.target.value),
                  })
                }
                aria-label="NER confidence floor"
                className="w-24 sm:w-32 accent-action"
              />
              <span className="text-xs font-mono text-ink">
                {(config.nerScoreFloor ?? 0).toFixed(2)}
              </span>
            </div>
          </div>
          <EntityCloudPreview
            entityMap={entityMap}
            floor={config.nerScoreFloor ?? 0}
            candidates={mentionCandidates}
          />
        </SettingsSection>

        <SettingsSection
          id="tags"
          title="tags"
          collapsed={collapsed.has("tags")}
          onToggle={toggle}
        >
          <EndpointEditor
            title="Tag generation model"
            subtitle="Authors the match/contrast labels used for auto-tagging."
            endpoint={config.discovery}
            defaultModel={DEFAULT_CONTRIBUTOR_MODEL}
            onUpdate={(updated) =>
              onChange({ ...config, discovery: updated })
            }
          />
          <BackendChoice<NliBackendId>
            label="NLI model"
            value={config.nliBackend ?? "local"}
            options={NLI_BACKEND_OPTIONS}
            onChange={(v) => onChange({ ...config, nliBackend: v })}
          />
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">
                Zero-shot auto-tag threshold
              </div>
              <div className="text-xs text-mention">
                Chats auto-tag when max target score ≥ threshold and beats the
                contrast score. Retags instantly from stored scores.
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.zeroShotThreshold ?? 0.4}
                onChange={(e) =>
                  onChange({
                    ...config,
                    zeroShotThreshold: Number(e.target.value),
                  })
                }
                aria-label="Zero-shot auto-tag threshold"
                className="w-24 sm:w-32 accent-action"
              />
              <span className="text-xs font-mono text-ink">
                {(config.zeroShotThreshold ?? 0.4).toFixed(2)}
              </span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          id="summaries"
          title="summaries"
          collapsed={collapsed.has("summaries")}
          onToggle={toggle}
        >
          <TemplateSettings />
          <div className="py-3">
            <EndpointEditor
              title="Summary generation model"
              subtitle="Writes the final project summary from packed chats."
              endpoint={config.synthesis}
              defaultModel={DEFAULT_CONTRIBUTOR_MODEL}
              onUpdate={(updated) =>
                onChange({ ...config, synthesis: updated })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">
                Max Packed Tokens per Synthesis Batch
              </div>
              <div className="text-xs text-mention">
                Projects under this token limit run in a single LLM Call #2;
                larger threads auto-batch. Capped at the models&apos; 1,048,576-token
                context window.
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <input
                type="range"
                min={10000}
                max={MAX_MODEL_CONTEXT_TOKENS}
                step={5000}
                value={Math.min(
                  config.maxTokensPerSynthesisBatch,
                  MAX_MODEL_CONTEXT_TOKENS
                )}
                onChange={(e) =>
                  onChange({
                    ...config,
                    maxTokensPerSynthesisBatch: Math.min(
                      Math.max(
                        Number(e.target.value) || DEFAULT_MAX_TOKENS_PER_BATCH,
                        10000
                      ),
                      MAX_MODEL_CONTEXT_TOKENS
                    ),
                  })
                }
                aria-label="Max packed tokens per synthesis batch"
                className="w-24 sm:w-32 accent-action"
              />
              <span className="text-xs font-mono text-ink">
                {config.maxTokensPerSynthesisBatch.toLocaleString()}
              </span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          id="voice"
          title="Voice agent"
          collapsed={collapsed.has("voice")}
          onToggle={toggle}
        >
          <EndpointEditor
            title="Voice agent model"
            subtitle="Answers spoken questions about your chats, searching by date and entity."
            endpoint={config.voice}
            defaultModel={DEFAULT_CONTRIBUTOR_MODEL}
            onUpdate={(updated) =>
              onChange({ ...config, voice: updated })
            }
          />
        </SettingsSection>

        <SettingsSection
          id="data"
          title="Data"
          collapsed={collapsed.has("data")}
          onToggle={toggle}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">Export all data</div>
              <div className="text-xs text-mention">
                Downloads histories, summaries, tags, entities, templates, and
                settings as{" "}
                <code className="font-mono">{exportFileName(uuid)}</code>.
                The Meta API key stays in the server .env and is never
                included.
              </div>
              {exportError && (
                <div className="text-xs text-mention mt-1">
                  Export failed: {exportError}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? "Preparing…" : "Export .zip"}
            </button>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
};
