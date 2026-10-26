import { SavedSummary } from "./savedSummaries";
import { TOP_LIST_LIMIT } from "./topOfMind";
import { normalizeBulletLine } from "./richText";

export interface ActionItem {
  id: string;
  text: string;
  /** Resolved deadline (yyyy-mm-dd) or null when the text names none. */
  deadline: string | null;
  /** Verbatim deadline phrase when no explicit date parses ("Next session"). */
  deadlineText: string | null;
  summaryId: string;
  summaryTitle: string;
  /** First linked thread of the source summary, for navigation. */
  threadKey: string | null;
  createdAt: string;
}

const ACTION_HEADING_RE =
  /action|next steps?|todo|to-?do|follow[\s-]?ups?|deliverables?|task list/i;
const PAST_HEADING_RE =
  /troubleshoot|timeline|attempt|history|evolution|retrospect|completed|\bdone\b|result|root cause/i;

/** An action-item section header, excluding retrospective timelines. */
function isActionHeading(text: string): boolean {
  const clean = text.replace(/[*_`~]+/g, "");
  if (PAST_HEADING_RE.test(clean)) return false;
  return ACTION_HEADING_RE.test(clean);
}

/** Record-of-what-happened topics that end an action section outright. */
const SECTION_BREAK_RE =
  /takeaways?|milestones?|summar(?:y|ies)|overview|notes?|context|background|learnings?|recap|highlights?|results?|metrics?/i;

/**
 * True for record-style topics (takeaways, milestones, …): a non-action
 * heading naming one always closes the section, even as a deeper
 * sub-heading that would otherwise inherit action-ness from the title.
 */
function isSectionBreak(text: string): boolean {
  return SECTION_BREAK_RE.test(text.replace(/[*_`~]+/g, ""));
}

const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX_RE = /^\[([ xX])\]\s*(.*)$/;

interface ParsedBullet {
  /** Marker content exactly as written (trailing spacing kept). */
  content: string;
  /** Indent width in normalized space (matches rendered nesting). */
  indent: number;
  /** The stored line's own marker prefix, for rewriting the line. */
  prefix: string;
}

/**
 * Bullet parsing over tab-expanded, marker-normalized text (`•` and `**`
 * bullets read as the dashes they render as), with the prefix mapped back
 * onto the stored line so toggles keep the author's marker.
 */
function parseBulletLine(raw: string): ParsedBullet | null {
  const expanded = raw.replace(/\t/g, "  ");
  const bullet = BULLET_RE.exec(normalizeBulletLine(expanded));
  if (!bullet) return null;
  return {
    content: bullet[2],
    indent: bullet[1].length,
    prefix: expanded.slice(0, expanded.length - bullet[2].length),
  };
}
const BOLD_ONLY_RE = /^\*\*(.+?)\*\*\s*:?\s*$/;
/** Tool-meta boilerplate ("Add Reminder to Google Calendar") is not a task. */
const REMINDER_BOILERPLATE_RE =
  /^adds?\s+(a\s+)?reminders?\s+to\s+google\s+calendar\.?$/i;
const BARE_LINK_RE = /^\[(.+?)\]\((https?:\/\/[^)\s]+)\)\.?$/;
const CALENDAR_RENDER_RE =
  /^https?:\/\/(www\.)?calendar\.google\.com\/calendar\/render/i;

/**
 * True when a bullet is just a reminder affordance, not a task: the bare
 * reminder phrasing (optionally wrapped as a markdown link, as LLMs emit),
 * or a bare link to Google Calendar's event template under any label.
 * Bullets with real task text around a link are kept.
 */
function isReminderBoilerplate(text: string): boolean {
  if (REMINDER_BOILERPLATE_RE.test(text)) return true;
  const link = BARE_LINK_RE.exec(text.trim());
  if (!link) return false;
  return (
    REMINDER_BOILERPLATE_RE.test(link[1].trim()) ||
    CALENDAR_RENDER_RE.test(link[2])
  );
}

/**
 * Item text as it renders: emphasis markers are removed while literal
 * characters survive, so records match rendered checkbox labels. Runs of
 * `~` and backticks go unconditionally; `**`/`__` go unless word-glued on
 * both sides (`2**3`); single `*`/`_` go only in boundary-delimited pairs
 * (`*em*`, `_em_`), keeping intra-word uses (`consent_date`, `2*3`) that
 * rendering preserves.
 */
function cleanItemText(text: string): string {
  return text
    .replace(/~~+/g, "")
    .replace(/`+/g, "")
    .replace(/(?<!\w)\*\*|\*\*(?!\w)/g, "")
    .replace(/(?<!\w)__|__(?!\w)/g, "")
    .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=$|\s)/g, "$1$2")
    .replace(/(^|\s)_([^_\s][^_]*?)_(?=$|\s)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Action items from summary markdown: unchecked `- [ ]` boxes anywhere,
 * plus plain bullets inside action-titled sections (ATX headings, or bold
 * bullets with nested items). Retrospective timelines ("Actions &
 * Troubleshooting Timeline") are excluded; completed boxes are returned
 * only when `completed` is set, and plain bullets carry no done-state.
 */
interface ExtractedLine {
  text: string;
  /** Zero-based source line, for done-toggling the exact bullet. */
  line: number;
}

export function extractActionItems(
  markdown: string,
  completed = false
): string[] {
  return extractActionItemLines(markdown, completed).map((e) => e.text);
}

function extractActionItemLines(
  markdown: string,
  completed: boolean
): ExtractedLine[] {
  if (!markdown) return [];
  const out: ExtractedLine[] = [];
  let inSection = false;
  let sectionLevel = 0;
  let headerIndent: number | null = null;

  const raws = markdown.split("\n");
  for (let k = 0; k < raws.length; k++) {
    const line = raws[k].replace(/\t/g, "  ");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      if (isActionHeading(heading[2])) {
        inSection = true;
        sectionLevel = level;
      } else if (
        level <= sectionLevel ||
        !inSection ||
        isSectionBreak(heading[2])
      ) {
        inSection = false;
        sectionLevel = 0;
      }
      headerIndent = null;
      continue;
    }
    if (!line.trim()) continue;
    const bullet = parseBulletLine(raws[k]);
    if (!bullet) {
      // Bold pseudo-headings ("**Key Takeaways**") scope sections like a
      // level-6 heading: an action-titled one opens collection and any
      // other closes it, so takeaways after an action section stay plain
      // bullets instead of inheriting action-ness.
      const boldHead = BOLD_ONLY_RE.exec(line.trim());
      if (boldHead) {
        if (isActionHeading(boldHead[1])) {
          inSection = true;
          sectionLevel = 6;
        } else if (!inSection || isSectionBreak(boldHead[1])) {
          inSection = false;
          sectionLevel = 0;
        }
        headerIndent = null;
      }
      continue;
    }
    const indent = bullet.indent;
    const content = bullet.content.trim();
    const box = CHECKBOX_RE.exec(content);
    if (box) {
      // Open boxes count wherever they appear; completed boxes on request.
      if ((box[1].toLowerCase() === "x") === completed) {
        const text = cleanItemText(box[2]);
        if (text) out.push({ text, line: k });
      }
      continue;
    }
    if (completed) continue;
    if (headerIndent !== null) {
      if (indent > headerIndent) {
        const text = cleanItemText(content);
        if (text) out.push({ text, line: k });
        continue;
      }
      headerIndent = null;
    }
    const boldOnly = BOLD_ONLY_RE.exec(content);
    if (boldOnly && isActionHeading(boldOnly[1])) {
      headerIndent = indent;
      continue;
    }
    if (inSection) {
      const text = cleanItemText(content);
      if (text) out.push({ text, line: k });
    }
  }
  return out.filter((e) => !isReminderBoilerplate(e.text));
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_RE =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?[\s]+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/gi;
const DEADLINE_HINT_RE = /(\bdues?|\bby|\bdeadlines?|\bbefore|\buntil|\bto)$/i;

function toIsoDay(y: number, m: number, d: number): string | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(y, m, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) {
    return null;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * First explicit deadline in free text (ISO or month-name dates). When
 * several dates appear, the one near a due/by/deadline cue wins. Yearless
 * dates resolve to the next occurrence on/after the reference day.
 */
export function parseExplicitDeadline(
  text: string,
  ref: Date = new Date()
): string | null {
  if (!text) return null;
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const found: Array<{ iso: string; hinted: boolean }> = [];
  const nearHint = (index: number): boolean =>
    DEADLINE_HINT_RE.test(text.slice(Math.max(0, index - 14), index).trimEnd());

  ISO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ISO_RE.exec(text)) !== null) {
    const iso = toIsoDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (iso) found.push({ iso, hinted: nearHint(m.index) });
  }
  MONTH_RE.lastIndex = 0;
  while ((m = MONTH_RE.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    let year =
      m[3] !== undefined ? Number(m[3]) : refDay.getFullYear();
    if (month === undefined) continue;
    let iso = toIsoDay(year, month, day);
    if (!iso) continue;
    if (m[3] === undefined) {
      const cand = new Date(year, month, day);
      if (cand < refDay) {
        iso = toIsoDay(year + 1, month, day);
        if (!iso) continue;
      }
    }
    found.push({ iso, hinted: nearHint(m.index) });
  }
  if (found.length === 0) return null;
  return (found.find((f) => f.hinted) ?? found[0]).iso;
}

const ACTION_PREFIX_RE = /^(action|task|todos?)\s*:\s*/i;

/** Strips a leading "Action:"/"Task:"/"Todo:" label, if present. */
export function stripActionItemPrefix(text: string): string {
  return text.replace(ACTION_PREFIX_RE, "").trim() || text;
}

const DEADLINE_LABEL_RE = /^(deadline|due(?:\s+date)?)\s*:\s*(.+)$/i;
/**
 * A deadline clause genuinely at the end of the line, with optional
 * parentheses ("Ship it (Deadline: Friday)."). The value excludes pipes,
 * brackets, and parens so a mid-line "(Deadline: …)" followed by a
 * calendar link ("… | [Add Reminder…](…)") does not truncate the item.
 */
const TRAILING_DEADLINE_RE =
  /\s*\(?\s*(?:deadline|due(?:\s+date)?)\s*:\s*([^|[\]()]+?)\s*\)?\s*\.?\s*$/i;
const NO_DEADLINE_RE = /^(none|n\/a|t\.?b\.?d\.?|unknown|unspecified|—|-)$/i;

/** Splits a deadline value into an ISO date and/or a verbatim phrase. */
function splitDeadlineValue(
  value: string,
  ref: Date
): { deadline: string | null; deadlineText: string | null } {
  const v = value.trim().replace(/\s*\.+$/, "").trim();
  if (!v || NO_DEADLINE_RE.test(v)) {
    return { deadline: null, deadlineText: null };
  }
  const iso = parseExplicitDeadline(v, ref);
  if (iso) return { deadline: iso, deadlineText: null };
  return { deadline: null, deadlineText: v };
}

interface AssembledActionItem {
  text: string;
  deadline: string | null;
  deadlineText: string | null;
  /** Source lines backing the record: the item line first. */
  lines: number[];
}

/**
 * One summary's extracted lines assembled into records: a whole-line
 * "Deadline:" attaches to the preceding item, trailing "Deadline:" values
 * split out of item text, and "Action:"-style prefixes are stripped.
 * Shared by collection and done-toggling so both see identical records.
 */
function assembleActionItems(
  texts: ExtractedLine[],
  ref: Date
): AssembledActionItem[] {
  const out: AssembledActionItem[] = [];
  const push = (
    text: string,
    deadline: string | null,
    deadlineText: string | null,
    line: number
  ) => {
    // Re-check after prefix stripping: "Action: [Add Reminder ...](...)"
    // only reveals itself as boilerplate once the label is gone.
    if (isReminderBoilerplate(text)) return;
    out.push({ text, deadline, deadlineText, lines: [line] });
  };
  texts.forEach((t) => {
    const raw = t.text;
    const dl = DEADLINE_LABEL_RE.exec(raw);
    if (dl) {
      const v = splitDeadlineValue(dl[2], ref);
      const prev = out.length > 0 ? out[out.length - 1] : null;
      let attached = false;
      if (prev) {
        if (v.deadline && !prev.deadline) {
          prev.deadline = v.deadline;
          attached = true;
        }
        if (v.deadlineText && !prev.deadlineText) {
          prev.deadlineText = v.deadlineText;
          attached = true;
        }
        if (attached) prev.lines.push(t.line);
      }
      // "Deadline: None" carries nothing; anything unattached stays a row.
      if (attached || (!v.deadline && !v.deadlineText)) return;
      if (!prev) {
        push(raw, v.deadline, v.deadlineText, t.line);
        return;
      }
    }
    const stripped = stripActionItemPrefix(raw);
    const trail = TRAILING_DEADLINE_RE.exec(stripped);
    if (trail && stripped.slice(0, trail.index).trim()) {
      const v = splitDeadlineValue(trail[1], ref);
      push(
        stripped.slice(0, trail.index).trim(),
        v.deadline,
        v.deadlineText,
        t.line
      );
      return;
    }
    push(stripped, parseExplicitDeadline(stripped, ref), null, t.line);
  });
  return out;
}

/**
 * Action items across saved summaries: explicit dates first (earliest),
 * then verbatim deadline phrases, then undated (newest summary first).
 * Labeled follow-up lines assemble into records: a whole-line "Deadline:"
 * attaches to the preceding item, and trailing "Deadline:" values split
 * out of item text; "Action:"-style prefixes are stripped. With
 * `completed`, completed boxes are collected instead of open items.
 */
export function collectActionItems(
  summaries: SavedSummary[],
  ref: Date = new Date(),
  limit = TOP_LIST_LIMIT,
  completed = false
): ActionItem[] {
  const out: ActionItem[] = [];
  for (const s of summaries) {
    if (!s || typeof s.markdown !== "string") continue;
    const records = assembleActionItems(
      extractActionItemLines(s.markdown, completed),
      ref
    );
    records.forEach((r, i) => {
      out.push({
        id: `${s.id}:${i}`,
        text: r.text,
        deadline: r.deadline,
        deadlineText: r.deadlineText,
        summaryId: s.id,
        summaryTitle: s.title || "Untitled summary",
        threadKey: s.threads?.[0]?.key ?? null,
        createdAt: s.createdAt || "",
      });
    });
  }
  const rank = (a: ActionItem): number =>
    a.deadline ? 0 : a.deadlineText ? 1 : 2;
  out.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.deadline && b.deadline && a.deadline !== b.deadline) {
      return a.deadline < b.deadline ? -1 : 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  return out.slice(0, Math.max(0, limit));
}

/** Open items whose explicit deadline falls inside [startKey, endKey], earliest first. */
export function actionItemsDueBetween(
  items: ActionItem[],
  startKey: string,
  endKey: string
): ActionItem[] {
  const lo = startKey <= endKey ? startKey : endKey;
  const hi = startKey <= endKey ? endKey : startKey;
  return items
    .filter((a) => a.deadline !== null && a.deadline >= lo && a.deadline <= hi)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

/** Compact deadline chip: "Nov 5", with 2-digit year outside this year. */
export function formatDeadlineChip(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const sameYear = new Date().getFullYear() === y;
  return dt.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "2-digit" }
  );
}

/** Completed action items across saved summaries (uncapped). */
export function collectCompletedActionItems(
  summaries: SavedSummary[],
  ref: Date = new Date()
): ActionItem[] {
  return collectActionItems(summaries, ref, Infinity, true);
}

export interface ChecklistItem {
  text: string;
  deadline: string | null;
  deadlineText: string | null;
  checked: boolean;
}

/**
 * Checkbox bullets (`- [ ]` / `- [x]`) in document order with their
 * assembled deadline records, for wiring rendered checkboxes back to
 * `toggleActionItemInMarkdown`. Plain bullets in action sections carry no
 * checkbox and are excluded.
 */
export function listChecklistItems(
  markdown: string,
  ref: Date = new Date()
): ChecklistItem[] {
  if (!markdown) return [];
  const raws = markdown.split("\n").map((l) => l.replace(/\t/g, "  "));
  const isBox = (line: number): boolean => {
    const raw = raws[line];
    if (!raw) return false;
    const bullet = parseBulletLine(raw);
    if (!bullet) return false;
    return CHECKBOX_RE.test(bullet.content.trim());
  };
  const recs = [
    ...assembleActionItems(extractActionItemLines(markdown, false), ref).map(
      (r) => ({ ...r, checked: false })
    ),
    ...assembleActionItems(extractActionItemLines(markdown, true), ref).map(
      (r) => ({ ...r, checked: true })
    ),
  ];
  return recs
    .filter((r) => r.lines.length > 0 && isBox(r.lines[0]))
    .sort((a, b) => a.lines[0] - b.lines[0])
    .map((r) => ({
      text: r.text,
      deadline: r.deadline,
      deadlineText: r.deadlineText,
      checked: r.checked,
    }));
}

const FENCE_RE = /^ {0,3}```/;

/**
 * Display copy of summary markdown where every open action item renders a
 * checkbox: plain bullets in action sections gain `- [ ]`, so collected
 * items that the model emitted without boxes stay visible and toggleable.
 * Line numbers are preserved for checkbox wiring; existing boxes, attached
 * Deadline labels, and fenced code are left untouched.
 */
export function ensureActionItemCheckboxes(
  markdown: string,
  ref: Date = new Date()
): string {
  if (!markdown) return markdown;
  const itemLines = new Set<number>();
  const deadlineLines = new Set<number>();
  for (const e of extractActionItemLines(markdown, false)) {
    itemLines.add(e.line);
    // Deadline labels attach to the preceding item and wire to nothing on
    // their own; detected on the cleaned text so "*Deadline:* …" emphasis
    // does not slip through.
    if (DEADLINE_LABEL_RE.test(e.text)) deadlineLines.add(e.line);
  }
  if (itemLines.size === 0) return markdown;
  let inFence = false;
  let changed = false;
  const next = markdown.split("\n").map((raw, k) => {
    const line = raw.replace(/\t/g, "  ");
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !itemLines.has(k) || deadlineLines.has(k)) return line;
    const bullet = parseBulletLine(raw);
    if (!bullet) return line;
    const content = bullet.content.trim();
    if (CHECKBOX_RE.test(content)) return line;
    changed = true;
    return `${bullet.prefix}[ ] ${bullet.content}`;
  });
  return changed ? next.join("\n") : markdown;
}

type ActionItemTuple = Pick<
  ActionItem,
  "text" | "deadline" | "deadlineText"
>;

/**
 * Flips the checkboxes of the bullet lines backing an action item: done
 * sets `- [x]` (plain bullets gain a box), open restores `- [ ]`. The
 * record assembles through the same pipeline as the visible list, so an
 * attached Deadline line flips with its item instead of orphaning. The
 * first matching record wins; no match returns the markdown untouched.
 */
export function toggleActionItemInMarkdown(
  markdown: string,
  item: ActionItemTuple,
  done: boolean,
  ref: Date = new Date()
): string {
  const records = assembleActionItems(
    extractActionItemLines(markdown, !done),
    ref
  );
  const hit = records.find(
    (r) =>
      r.text === item.text &&
      r.deadline === item.deadline &&
      r.deadlineText === item.deadlineText
  );
  if (!hit) return markdown;
  const lines = markdown.split("\n");
  for (const k of hit.lines) {
    const bullet = parseBulletLine(lines[k]);
    if (!bullet) continue;
    const content = bullet.content.trim();
    const box = CHECKBOX_RE.exec(content);
    const body = box ? box[2] : content;
    lines[k] = `${bullet.prefix}[${done ? "x" : " "}] ${body}`;
  }
  return lines.join("\n");
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pins an explicit deadline onto the bullet lines backing an action item:
 * an attached Deadline line is rewritten in place, otherwise the item line
 * gains (or replaces) a trailing "Deadline: <iso>." value. Box state is
 * preserved; no match or a malformed date returns the markdown untouched.
 */
export function setActionItemDeadline(
  markdown: string,
  item: ActionItemTuple,
  isoDate: string,
  ref: Date = new Date()
): string {
  if (!ISO_DAY_RE.test(isoDate)) return markdown;
  for (const completed of [false, true]) {
    const records = assembleActionItems(
      extractActionItemLines(markdown, completed),
      ref
    );
    const hit = records.find(
      (r) =>
        r.text === item.text &&
        r.deadline === item.deadline &&
        r.deadlineText === item.deadlineText
    );
    if (!hit) continue;
    const k = hit.lines.length > 1 ? hit.lines[1] : hit.lines[0];
    const lines = markdown.split("\n");
    const bullet = parseBulletLine(lines[k]);
    if (!bullet) continue;
    const content = bullet.content.trim();
    const box = CHECKBOX_RE.exec(content);
    const prefix = bullet.prefix;
    const body = (box ? box[2] : content).trim();
    const trail = TRAILING_DEADLINE_RE.exec(body);
    const head = trail ? body.slice(0, trail.index).trim() : body;
    const newBody = head
      ? `${/[.!?]$/.test(head) ? head : `${head}.`} Deadline: ${isoDate}.`
      : `Deadline: ${isoDate}.`;
    const boxPart = box ? `[${box[1]}] ` : "";
    lines[k] = `${prefix}${boxPart}${newBody}`;
    return lines.join("\n");
  }
  return markdown;
}

/** Adds whole days to a yyyy-mm-dd day, formatted back the same way. */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * Google Calendar "create event" link for an action item: prefilled title,
 * an all-day span on the deadline when it resolved to a date, and the
 * source summary plus any text deadline in the event details.
 */
export function googleCalendarTemplateUrl(item: {
  text: string;
  deadline: string | null;
  deadlineText: string | null;
  summaryTitle: string;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: item.text,
  });
  if (item.deadline) {
    const start = item.deadline.replaceAll("-", "");
    const end = addDaysIso(item.deadline, 1).replaceAll("-", "");
    params.set("dates", `${start}/${end}`);
  }
  const details = [`From summary: ${item.summaryTitle}`];
  if (item.deadlineText) details.push(`Deadline: ${item.deadlineText}`);
  params.set("details", details.join("\n"));
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
