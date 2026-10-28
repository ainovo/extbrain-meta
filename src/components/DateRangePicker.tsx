import React, { useState } from "react";

export type ArchiveRangePreset = "14d" | "30d" | "90d" | "all" | "custom";

export interface DayBounds {
  minKey: string;
  maxKey: string;
}

export interface DateRangeValue {
  start: string;
  end: string;
}

function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-full bg-tag p-0.5 shrink-0"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition ${
            value === o.value
              ? "bg-action text-white"
              : "text-mention hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Resolve a preset to a day range, or null for All (no date filter). */
function rangeForPreset(
  bounds: DayBounds,
  preset: ArchiveRangePreset,
  customStart: string,
  customEnd: string
): DateRangeValue | null {
  if (preset === "all") return null;
  if (preset === "custom") {
    const s = customStart || addDaysToKey(bounds.maxKey, -13);
    const e = customEnd || bounds.maxKey;
    const lo = s <= e ? s : e;
    const hi = s <= e ? e : s;
    const clamp = (k: string) =>
      k < bounds.minKey ? bounds.minKey : k > bounds.maxKey ? bounds.maxKey : k;
    return { start: clamp(lo), end: clamp(hi) };
  }
  const n = preset === "14d" ? 14 : preset === "30d" ? 30 : 90;
  return {
    start: addDaysToKey(bounds.maxKey, -(n - 1)),
    end: bounds.maxKey,
  };
}

/**
 * Date range selector copied from Top of Mind: preset segmented control
 * plus custom date inputs. Starts at All (no filtering); every change
 * reports the resolved range (or null) to the parent.
 */
export function DateRangePicker({
  bounds,
  onSelectRange,
}: {
  bounds: DayBounds | null;
  onSelectRange: (range: DateRangeValue | null) => void;
}) {
  const [preset, setPreset] = useState<ArchiveRangePreset>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  if (!bounds) return null;

  const pick = (p: ArchiveRangePreset) => {
    setPreset(p);
    onSelectRange(rangeForPreset(bounds, p, customStart, customEnd));
  };
  const customInput = (which: "start" | "end", v: string) => {
    if (which === "start") setCustomStart(v);
    else setCustomEnd(v);
    onSelectRange(
      rangeForPreset(
        bounds,
        "custom",
        which === "start" ? v : customStart,
        which === "end" ? v : customEnd
      )
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0">
      <Segmented
        label="Date range"
        value={preset}
        onChange={pick}
        options={[
          { value: "14d", label: "14D" },
          { value: "30d", label: "30D" },
          { value: "90d", label: "90D" },
          { value: "all", label: "All" },
          { value: "custom", label: "Custom" },
        ]}
      />
      {preset === "custom" && (
        <span className="inline-flex items-center gap-1.5 text-xs text-mention">
          <input
            type="date"
            aria-label="Range start"
            value={customStart || addDaysToKey(bounds.maxKey, -13)}
            min={bounds.minKey}
            max={bounds.maxKey}
            onChange={(e) => customInput("start", e.target.value)}
            className="rounded-lg border border-divider bg-white px-2 py-1 text-xs text-ink"
          />
          <span aria-hidden>→</span>
          <input
            type="date"
            aria-label="Range end"
            value={customEnd || bounds.maxKey}
            min={bounds.minKey}
            max={bounds.maxKey}
            onChange={(e) => customInput("end", e.target.value)}
            className="rounded-lg border border-divider bg-white px-2 py-1 text-xs text-ink"
          />
        </span>
      )}
    </div>
  );
}
