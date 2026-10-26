import React, { useEffect, useMemo, useRef } from "react";
import {
  ChecklistItem,
  ensureActionItemCheckboxes,
  listChecklistItems,
  stripActionItemPrefix,
} from "../lib/actionItems";
import { stripLinkMarkup } from "../lib/richText";
import { MarkdownView } from "./MarkdownView";

export interface ToggledActionItem {
  text: string;
  deadline: string | null;
  deadlineText: string | null;
}

interface Props {
  /** Stored summary markdown; plain-bullet items gain display checkboxes. */
  markdown: string;
  className?: string;
  /** Append a pulsing cursor while the model is still streaming. */
  streaming?: boolean;
  /** Force every box disabled (e.g. while generating). */
  disabled?: boolean;
  /** Fired with the record and its new done-state when a box toggles. */
  onToggleItem?: (item: ToggledActionItem, done: boolean) => void;
}

/**
 * Summary markdown with live task checkboxes. Rendered boxes are matched
 * back to their source records by text (longest first, consumed once) so
 * nested or odd bullets can't misalign the mapping; unmatched boxes stay
 * disabled. Plain-bullet action items are shown with injected checkboxes
 * that toggle the stored lines through the same record pipeline.
 */
export const InteractiveSummaryMarkdown: React.FC<Props> = ({
  markdown,
  className,
  streaming = false,
  disabled = false,
  onToggleItem,
}) => {
  const display = useMemo(
    () => ensureActionItemCheckboxes(markdown),
    [markdown]
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef(onToggleItem);
  toggleRef.current = onToggleItem;

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !display) return;
    const norm = (s: string) =>
      stripActionItemPrefix(stripLinkMarkup(s).replace(/\s+/g, " ").trim()).trim();
    const records = listChecklistItems(display);
    const used = new Set<number>();
    const boxes = Array.from(
      root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    for (const box of boxes) {
      // Match against the item's own text: nested sub-lists are removed so
      // a parent matches its record regardless of nested content, and
      // block boundaries become spaces (textContent adds none between
      // blocks, gluing nested text onto the item otherwise).
      const li = box.closest("li");
      const clone = li ? (li.cloneNode(true) as HTMLElement) : null;
      clone?.querySelectorAll("ul,ol").forEach((n) => n.remove());
      clone
        ?.querySelectorAll("p,div,pre,blockquote,h1,h2,h3,h4,h5,h6,table,hr")
        .forEach((n) => n.after(document.createTextNode(" ")));
      const t = norm(clone?.textContent ?? "");
      let best = -1;
      records.forEach((r, i) => {
        if (used.has(i)) return;
        const rt = norm(r.text);
        if (!rt || !t) return;
        const follows =
          t.length === rt.length ? "" : t[rt.length] ?? "";
        if (
          (t === rt || (t.startsWith(rt) && /[\s.]/.test(follows))) &&
          (best === -1 || rt.length > norm(records[best].text).length)
        ) {
          best = i;
        }
      });
      if (best === -1 || disabled) {
        box.disabled = true;
        box.onchange = null;
        continue;
      }
      used.add(best);
      const rec: ChecklistItem = records[best];
      box.disabled = false;
      box.title = rec.checked ? "Mark open" : "Mark done";
      box.onchange = () => {
        // Hold the rendered state until the parent's markdown update flows
        // back; a no-op toggle (stale record) visibly reverts instead of
        // sticking on the wrong value.
        box.checked = rec.checked;
        toggleRef.current?.(
          {
            text: rec.text,
            deadline: rec.deadline,
            deadlineText: rec.deadlineText,
          },
          !rec.checked
        );
      };
    }
  });

  return (
    <div ref={bodyRef}>
      <MarkdownView markdown={display} streaming={streaming} className={className} />
    </div>
  );
};
