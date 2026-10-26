import React, { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { ChatEntityMap, EntityAggregate, aggregateEntities, entityTypeLabel, filterMentionCandidates } from "../lib/entities";

function MentionSearchBar({
  entityMap,
  hasEntities,
  onViewChats,
  minScore = 0,
}: {
  entityMap: ChatEntityMap;
  hasEntities: boolean;
  onViewChats: (keys: string[]) => void;
  minScore?: number;
}) {
  const candidates = useMemo(
    () => aggregateEntities(entityMap, 0, minScore),
    [entityMap, minScore]
  );
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<EntityAggregate[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const pickedKeys = useMemo(() => picked.map((p) => p.key), [picked]);
  const suggestions = useMemo(
    () => (open ? filterMentionCandidates(candidates, query, pickedKeys) : []),
    [open, candidates, query, pickedKeys]
  );

  const addPick = (c: EntityAggregate) => {
    setPicked((prev) =>
      prev.some((p) => p.key === c.key) ? prev : [...prev, c]
    );
    setQuery("");
    setHi(0);
    setOpen(false);
  };

  return (
    <div>
      <div className="relative">
        <div className="flex items-center gap-2 rounded-xl border border-divider bg-canvas px-3 py-2">
          <Search className="w-4 h-4 text-mention/60 shrink-0" />
          <input
            value={query}
            disabled={!hasEntities}
            onChange={(e) => {
              setQuery(e.target.value);
              setHi(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length > 0) {
                e.preventDefault();
                setHi((h) => (h + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                e.preventDefault();
                setHi(
                  (h) => (h - 1 + suggestions.length) % suggestions.length
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (query.trim() && suggestions.length > 0) {
                  addPick(suggestions[Math.min(hi, suggestions.length - 1)]);
                } else if (picked.length > 0) {
                  onViewChats(pickedKeys);
                }
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={
              hasEntities
                ? "Search mentions…"
                : "Run NER processing to search mentions"
            }
            aria-label="Search mentions"
            className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-mention/60 focus:outline-none disabled:opacity-60"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setHi(0);
              }}
              className="p-1 rounded-lg hover:bg-tag text-mention/60 hover:text-mention shrink-0"
              aria-label="Clear mention search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => onViewChats(pickedKeys)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition shrink-0"
          >
            Search
          </button>
        </div>
        {open && query.trim() && (
          <div className="absolute inset-x-0 top-full mt-1 z-20 rounded-xl border border-divider bg-white shadow-lg overflow-hidden">
            {suggestions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-mention/60">
                No mentions match “{query.trim()}”.
              </div>
            ) : (
              suggestions.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addPick(c)}
                  onMouseEnter={() => setHi(i)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] ${
                    i === hi ? "bg-tag" : ""
                  }`}
                >
                  <span className="flex-1 truncate font-medium text-ink">
                    {c.display}
                  </span>
                  <span className="text-[11px] text-mention/60 shrink-0">
                    {entityTypeLabel(c.type)}
                  </span>
                  <span className="font-mono text-[11px] text-mention/60 shrink-0">
                    {c.chatCount}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {picked.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setPicked((prev) => {
                  const updated = prev.filter((k) => k.key !== p.key);
                  onViewChats(updated.map((k) => k.key));
                  return updated;
                });
              }}
              title={`Remove ${p.display}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-mention px-3 py-1 text-xs font-medium text-white hover:bg-ink transition"
            >
              <span className="max-w-48 truncate">{p.display}</span>
              <X className="w-3 h-3 opacity-70 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default MentionSearchBar;