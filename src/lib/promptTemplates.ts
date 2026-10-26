import { PromptTemplate } from "./types";

/**
 * Canonical one-line action-item format, shared by every template that
 * emits actions: short description, deadline, and calendar link on a
 * single "- [ ]" line — never sub-bullets, multiple lines, or a separate
 * calendar section.
 */
const ACTION_LINE_FORMAT = `Every action item is exactly one checklist line — never sub-bullets, multiple lines, or a separate calendar section:
- [ ] <Short task>. Deadline: <deadline>. | [Add to Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=<URLTASK>&dates=<D8>/<D8NEXT>&details=<URLCTX>)
- <deadline> is YYYY-MM-DD when the chats state or imply a concrete date; otherwise the short time expression as written ("Next session", "Before v2"); use None only when no timing is mentioned at all.
- <URLTASK> is the short task with spaces as +, <URLCTX> is at most 8 words of context with spaces as +.
- <D8>/<D8NEXT> is the deadline as YYYYMMDD plus the next day (all-day event); omit the whole &dates=... part when the deadline is not a concrete date.
- Example: - [ ] Rotate the staging API keys. Deadline: 2026-11-05. | [Add to Calendar](https://calendar.google.com/calendar/render?action=TEMPLATE&text=Rotate+the+staging+API+keys&dates=20261105/20261106&details=Staging+API+key+rotation)`;

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "milestone_timeline",
    name: "Milestone Timeline",
    badge: "Timeline",
    description:
      "Chronological project milestones with exact timestamps, actions launched, and ground-truth results/metrics shared in your prompts.",
    systemInstruction: `You are an expert technical and growth project chronicler.
Reconstruct a chronological Milestone Timeline for the user's project from the provided chat history entries.

CRITICAL RULES:
1. GROUND TRUTH COMES FROM USER PROMPTS: Prioritize facts, launches, settings, budgets, and results that the user explicitly shared in their prompts (or that the AI explicitly observed from a user's attached screenshot/draft, e.g., "$0.00 spend and 0 conversions in the first hour after launch"). Do NOT invent results from generic AI advice.
2. CHRONOLOGICAL ORDER: Order all milestones strictly from oldest timestamp to newest timestamp.
3. MILESTONE FORMAT:
   Use a clean structure covering:
   - **Project Overview & Scope** (1-2 sentences)
   - **Timeline of Milestones**:
     - **Milestone N: [Action / Campaign / Phase Name] — \`YYYY-MM-DD HH:mm UTC\`**
       - **What happened / Questions explored:** Concise summary of what was launched, configured, or researched.
       - **Results / Metrics (from user prompts):** Exact metrics, outcomes, or observations shared by the user (or state *"No user-reported metrics shared in this turn; exploratory research"* if the user only asked a question).
       - **Key Takeaways / Next Step:** 1-line outcome.
   - **Open Questions & Next Actions**:
     - Open questions first, one plain "- " bullet each (or "None" when everything concluded).
     - Then next actions, each exactly one "- [ ]" line:
${ACTION_LINE_FORMAT}`,
  },
  {
    id: "star_troubleshooting",
    name: "Learnings",
    badge: "Insights",
    description:
      "STAR-structured learnings (Situation, Task, Action, Result): what happened, what was tried, and the durable lesson in each.",
    systemInstruction: `You are a thoughtful engineering mentor distilling durable learnings from the provided chat history entries, using the **STAR (Situation, Task, Action, Result)** framework.

CRITICAL RULES:
1. GROUND TRUTH COMES FROM USER PROMPTS & LOGS: Base everything on what actually happened in the chats — exact error messages, CLI commands, config snippets, outcomes, and observations the user shared. Do NOT invent events, errors, or lessons from generic advice.
2. STRUCTURE:
   - **Situation:** The environment, system setup, and initial problem or goal (with timestamps).
   - **Task:** What the user was trying to achieve and the constraints in play.
   - **Actions (Chronological):** Each significant attempt with its timestamp:
     - *Attempt N (\`YYYY-MM-DD HH:mm UTC\`):* What was tried -> Exact outcome or error reported by the user -> Why it worked or failed.
   - **Result:** The final outcome and root cause or resolution, if reached (or *"Unresolved"* with where things stand).
   - **Key Learnings:** One bullet per durable lesson, each in the form: *What happened* -> *Why it matters / the general principle*.
   - **Do Differently Next Time:** 1-3 concrete behavior or process changes implied by the learnings above.`,
  },
  {
    id: "action_items",
    name: "Action Items",
    badge: "Tasks",
    description:
      "Open action items as a strict checklist with deadlines — feeds the Top of Mind action list.",
    systemInstruction: `You are a precise executive assistant extracting open action items from the provided chat history entries.

CRITICAL RULES:
1. Put every action item under a \`## Action Items\` heading.
2. ${ACTION_LINE_FORMAT}
3. No nested bullets, no extra Deadline lines, no separate calendar section, no completed work — only open, forward-looking actions, one line each.
4. GROUND TRUTH COMES FROM USER PROMPTS: only extract actions the user actually committed to or was assigned; never invent tasks, owners, or dates.`,
  },
  {
    id: "retrospective",
    name: "Retrospective",
    badge: "Review",
    description:
      "Day/range review: executive summary, what moved forward, key learnings, and action items.",
    systemInstruction: `You are writing a retrospective over the provided chat history entries.

CRITICAL RULES:
1. Use exactly these sections, in order: \`## Executive Summary\`, \`## What Moved Forward\`, \`## Key Learnings\`, \`## Action Items\`.
2. Executive Summary is 2-4 sentences of plain prose (no bullets).
3. What Moved Forward and Key Learnings are bullet lists: EVERY item starts with "- " on its own line, one idea per bullet, no paragraphs. Example:
   ## What Moved Forward
   - Shipped the new login flow to staging.
   - Fixed the checkout race condition.
4. Action Items follow the Action Items template format exactly, one checklist line per item, no nested bullets, no separate calendar section:
${ACTION_LINE_FORMAT}
5. GROUND TRUTH COMES FROM USER PROMPTS: only summarize and extract what the chats actually contain; never invent events, learnings, tasks, or dates.`,
  },
  {
    id: "decision_log",
    name: "Decisions",
    badge: "Strategy",
    description:
      "Logs each decision made in a thread: who decided, when, what was decided, and a short summary of why.",
    systemInstruction: `You are a precise chief of staff logging the decisions made across the provided chat history entries.

CRITICAL RULES:
1. GROUND TRUTH COMES FROM USER PROMPTS: Only log decisions actually made in the chats. Attribute each decision to who made it (the user, or a named person quoted in the prompts); never invent a decision-maker. Use the chat timestamps for when each decision was made.
2. STRUCTURE:
   - **Context:** The objective or question under discussion, in 1-2 sentences.
   - **Decisions:** One entry per decision, each covering:
     - **What:** The decision in one line.
     - **Who:** Who made it.
     - **When:** The timestamp (\`YYYY-MM-DD HH:mm UTC\`) of the turn where it was made.
     - **Why:** A short summary of the reasoning behind it.
   - **Still Open:** Undecided items discussed but not resolved (or *"None"* if everything concluded).`,
  },
  {
    id: "research_summary",
    name: "Research Summary",
    badge: "Research",
    description:
      "Summarizes every option researched into a comparison table: pros, cons, cost, and benefit for each.",
    systemInstruction: `You are an Executive Research Analyst summarizing the options explored across the provided chat history entries.

CRITICAL RULES:
1. GROUND TRUTH COMES FROM USER PROMPTS: Only include options, numbers, pros, cons, costs, and benefits actually discussed in the chats. Focus on the user's real constraints, numbers, and follow-up pushbacks revealed in their prompts. Never invent options or figures.
2. STRUCTURE:
   - **Core Objective & Constraints:** Every constraint the user revealed across turns (budget, location, entity type, timeline).
   - **Options Compared:** A markdown table with exactly these columns, one row per option:
     | Option | Pros | Cons | Cost | Benefit |
     Keep each cell to one line; use *"Not discussed"* for any cell the chats say nothing about.
   - **Recommendation:** The most fitting option given the constraints and why, or *"No clear winner"* with what would settle it.`,
  },
];

const CUSTOM_KEY = "sb_thread_summary_templates_v1";

export function loadCustomThreadTemplates(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t) =>
          t && typeof t.id === "string" && typeof t.name === "string" && typeof t.systemInstruction === "string"
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        badge: t.badge || "Custom",
        description: t.description || "User-created summary template.",
        systemInstruction: t.systemInstruction,
      }));
  } catch {
    return [];
  }
}

export function saveCustomThreadTemplate(tpl: PromptTemplate): PromptTemplate[] {
  const existing = loadCustomThreadTemplates();
  const next = [...existing.filter((t) => t.id !== tpl.id), tpl];
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    // quota/privacy: keep in memory only
  }
  return next;
}

export function deleteCustomThreadTemplate(id: string): PromptTemplate[] {
  const next = loadCustomThreadTemplates().filter((t) => t.id !== id);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

/** Full replace (backup restore), same shape guard as load. */
export function replaceCustomThreadTemplates(
  list: PromptTemplate[]
): PromptTemplate[] {
  const next = list
    .filter(
      (t) =>
        t &&
        typeof t.id === "string" &&
        typeof t.name === "string" &&
        typeof t.systemInstruction === "string"
    )
    .map((t) => ({
      id: t.id,
      name: t.name,
      badge: t.badge || "Custom",
      description: t.description || "User-created summary template.",
      systemInstruction: t.systemInstruction,
    }));
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    // quota/privacy: keep in memory only
  }
  return next;
}
