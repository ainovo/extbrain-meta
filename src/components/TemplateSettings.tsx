import React, { useMemo, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { PromptTemplate } from "../lib/types";
import {
  BUILTIN_TEMPLATES,
  deleteCustomThreadTemplate,
  loadCustomThreadTemplates,
  saveCustomThreadTemplate,
} from "../lib/promptTemplates";

/**
 * Summary template management (list, create, edit, delete custom templates).
 * Hosted on the Settings page; the thread, range, and Summaries pickers read
 * the same stored list.
 */
export const TemplateSettings: React.FC = () => {
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(() =>
    loadCustomThreadTemplates()
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");

  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...customTemplates],
    [customTemplates]
  );
  const customIds = useMemo(
    () => new Set(customTemplates.map((t) => t.id)),
    [customTemplates]
  );

  const openNew = () => {
    setEditingId(null);
    setName("");
    setInstruction("");
    setFormOpen(true);
  };

  const openEdit = (tpl: PromptTemplate) => {
    setEditingId(tpl.id);
    setName(tpl.name);
    setInstruction(tpl.systemInstruction);
    setFormOpen(true);
  };

  const handleSaveTemplate = () => {
    const cleanName = name.trim();
    const cleanInstruction = instruction.trim();
    if (!cleanName || !cleanInstruction) return;
    const tpl: PromptTemplate = {
      id: editingId ?? `thread_custom_${Date.now()}`,
      name: cleanName,
      badge: "Custom",
      description: "User-created summary template.",
      systemInstruction: cleanInstruction,
    };
    setCustomTemplates(saveCustomThreadTemplate(tpl));
    setFormOpen(false);
    setEditingId(null);
    setName("");
    setInstruction("");
  };

  const handleDeleteTemplate = (id: string) => {
    setCustomTemplates(deleteCustomThreadTemplate(id));
  };

  return (
    <div className="space-y-3 py-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-mention">
          {allTemplates.length}{" "}
          {allTemplates.length === 1 ? "template" : "templates"} ·{" "}
          {customTemplates.length} custom. Built-in templates can't be edited;
          pickers across the app read this list.
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover transition shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> New template
        </button>
      </div>

      {formOpen && (
        <div className="rounded-xl border border-divider bg-white p-4 space-y-2">
          <div className="text-xs font-semibold text-ink">
            {editingId ? "Edit template" : "New template"}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name (e.g. Action items)"
            className="w-full rounded-lg border border-divider px-2.5 py-1.5 text-xs text-ink placeholder:text-mention/60 focus:outline-none focus:border-action"
          />
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="System instruction — how should the LLM summarize?"
            rows={5}
            className="w-full rounded-lg border border-divider px-2.5 py-1.5 text-xs text-ink font-mono placeholder:text-mention/60 focus:outline-none focus:border-action"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!name.trim() || !instruction.trim()}
              onClick={handleSaveTemplate}
              className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
            >
              Save template
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setEditingId(null);
              }}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-mention hover:text-ink transition"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {allTemplates.map((tpl) => {
          const isCustom = customIds.has(tpl.id);
          return (
            <div
              key={tpl.id}
              className="rounded-xl border border-divider bg-white p-4 flex flex-col min-w-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-ink truncate flex-1">
                  {tpl.name}
                </span>
                <span className="rounded-md bg-tag px-1.5 py-0.5 text-[10px] font-medium text-mention shrink-0">
                  {tpl.badge}
                </span>
                {isCustom && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(tpl)}
                      title="Edit template"
                      className="p-1.5 rounded-lg hover:bg-tag text-mention/60 hover:text-ink transition"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteTemplate(tpl.id)}
                      title="Delete template"
                      className="p-1.5 rounded-lg hover:bg-tag text-mention/60 hover:text-ink transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-[12px] text-mention mt-1.5 line-clamp-3 flex-1">
                {isCustom ? tpl.systemInstruction : tpl.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
