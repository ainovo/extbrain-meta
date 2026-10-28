import React, { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { EntityAggregate, entityTypeLabel, filterMentionCandidates } from "../lib/entities";

function MentionSearchBar({
  candidates,
  hasEntities,
  onViewChats,
  initialKeys = [],
  noun = "threads",
  stagePicks = false,
  excludeKeys = [],
  requireSelection = false,
}: {
  /** Precomputed shared aggregation (App memoizes one per dataset+floor). */
  candidates: EntityAggregate[];
  hasEntities: boolean;
  onViewChats: (keys: string[]) => void;
  /** Entity keys to pre-populate as pills (e.g. arriving from a pill click). */
  initialKeys?: string[];
  /** What a search returns on this page (placeholder wording). */
  noun?: string;
  /**
   * Stage picks as tokens in the box instead of committing each one:
   * onViewChats fires solely via Search/Enter with the full staged set.
   * For launchpads (Top of Mind) where committing would navigate away
   * mid-selection. In-place filters keep instant mode (default).
   */
  stagePicks?: boolean;
  /** Extra keys to hide from suggestions (e.g. already-active filters). */
  excludeKeys?: string[];
  /**
   * Search stays disabled until an entity is picked: typed text alone
   * never searches, and unmatched text is dropped instead of becoming a
   * raw mention key. Committed filters live outside the box (header).
   */
  requireSelection?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<EntityAggregate[]>(() =>
    initialKeys.flatMap((k) => {
      const found = candidates.find((c) => c.key === k);
      return found ? [found] : [];
    })
  );
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  // A page scroll leaves the open dropdown behind: it sits above the
  // sticky header (z-20 over z-10) and ends up covering the title, so
  // any scroll dismisses it. The dropdown itself never scrolls, so a
  // plain bubble-phase listener is safe.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [open]);
  const pickedKeys = useMemo(() => picked.map((p) => p.key), [picked]);
  // Computed regardless of dropdown-open state: clicking Search blurs the
  // input first (open=false), and gating this on open wiped the matches
  // before commit ran — type-then-click silently searched nothing. Only
  // the dropdown rendering below stays gated on open.
  const suggestions = useMemo(
    () =>
      filterMentionCandidates(candidates, query, [
        ...pickedKeys,
        ...excludeKeys,
      ]),
    [candidates, query, pickedKeys, excludeKeys]
  );

  const addPick = (c: EntityAggregate) => {
    // Instant mode filters on every pick: staging the pill without
    // searching left the list unfiltered, which read as "search doesn't
    // filter". Staged mode only collects the token; Search commits.
    if (!picked.some((p) => p.key === c.key)) {
      const next = [...picked, c];
      setPicked(next);
      if (!stagePicks) {
        onViewChats(next.map((p) => p.key));
      }
    }
    setQuery("");
    setHi(0);
    setOpen(false);
  };

  const removePick = (key: string) => {
    const updated = picked.filter((k) => k.key !== key);
    setPicked(updated);
    if (!stagePicks) {
      onViewChats(updated.map((k) => k.key));
    }
  };

  // Every commit filters: a picked suggestion, the staged pills, or —
  // unless selection is required — the raw text itself as a mention key
  // when it matches no known entity (absent text then narrows to nothing
  // instead of leaving the list untouched). Enter and Search share it,
  // in both modes.
  const commit = () => {
    if (query.trim() && suggestions.length > 0) {
      const c = suggestions[Math.min(hi, suggestions.length - 1)];
      const next = picked.some((p) => p.key === c.key)
        ? picked
        : [...picked, c];
      setPicked(next);
      onViewChats(next.map((p) => p.key));
    } else if (requireSelection) {
      // Staged picks only: unmatched text is dropped, never searched.
      if (picked.length === 0) return;
      onViewChats(pickedKeys);
    } else {
      if (picked.length === 0 && !query.trim()) return;
      const keys = query.trim() ? [...pickedKeys, query.trim()] : pickedKeys;
      onViewChats(keys);
    }
    setQuery("");
    setHi(0);
    setOpen(false);
  };

  const searchDisabled = requireSelection
    ? picked.length === 0 && suggestions.length === 0
    : picked.length === 0 && !query.trim();

  return (
    <div>
      <div className="relative">
        <div className="flex items-center gap-2 rounded-xl border border-divider bg-canvas px-3 py-2">
          <Search className="w-4 h-4 text-mention/60 shrink-0" />
          <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
            {stagePicks &&
              picked.map((p) => (
                <span
                  key={p.key}
                  className="inline-flex items-center gap-1 rounded-full bg-mention py-0.5 pl-2.5 pr-1.5 text-[11px] font-medium text-white"
                >
                  <span className="max-w-32 truncate">{p.display}</span>
                  <button
                    type="button"
                    onClick={() => removePick(p.key)}
                    title={`Remove ${p.display}`}
                    aria-label={`Remove ${p.display}`}
                    className="rounded-full p-0.5 hover:bg-white/20 transition"
                  >
                    <X className="w-3 h-3 opacity-70" />
                  </button>
                </span>
              ))}
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
                  commit();
                } else if (e.key === "Escape") {
                  setOpen(false);
                } else if (
                  e.key === "Backspace" &&
                  stagePicks &&
                  !query &&
                  picked.length > 0
                ) {
                  e.preventDefault();
                  removePick(picked[picked.length - 1].key);
                }
              }}
              placeholder={
                hasEntities
                  ? `Search ${noun} mentioning…`
                  : `Run NER processing to search ${noun}`
              }
              aria-label={`Search ${noun} by mention`}
              className="flex-1 min-w-[100px] bg-transparent text-sm text-ink placeholder:text-mention/60 focus:outline-none disabled:opacity-60"
            />
          </div>
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
            disabled={searchDisabled}
            onClick={commit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition shrink-0"
          >
            Search
          </button>
        </div>
        {open && query.trim() && (
          <div className="absolute inset-x-0 top-full mt-1 z-20 rounded-xl border border-divider bg-white shadow-lg overflow-hidden">
            {suggestions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-mention/60">
                {candidates.length === 0 && hasEntities
                  ? "All mentions are hidden by the confidence floor — lower it in Settings → Mentions."
                  : `No mentions match “${query.trim()}”.`}
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
      {!stagePicks && picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {picked.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => removePick(p.key)}
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