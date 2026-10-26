// Markdown rendering for AI responses, prompts, and summaries.
//
// Block structure (lists, tables, headings, code) is handled by marked with
// GFM; only link rendering is customized so URLs come out as favicon chips.
// Raw HTML is escaped (anchors are restored as chips); non-http(s) link
// targets render as plain text, so generated markdown can't inject scripts.
import { Marked, type Renderer, type Tokens } from "marked";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCodeBlock(code: string, lang: string): string {
  const trimmed = code.replace(/^\n+|\n+$/g, "");
  const label = lang
    ? `<div class="px-3 pt-2 text-[10px] font-mono uppercase tracking-widest text-mention/60 select-none">${escapeHtml(lang)}</div>`
    : "";
  // Code is already HTML-escaped; raw newlines are preserved natively by <pre>.
  return `<div class="rounded-lg bg-tag my-2 overflow-hidden">${label}<pre class="p-3 overflow-x-auto text-[12px] font-mono leading-relaxed text-ink">${trimmed}</pre></div>`;
}

export function trimUrlPunctuation(url: string): string {
  let result = url;
  let previous = "";
  while (result !== previous) {
    previous = result;
    // Sentence punctuation and markdown emphasis that commonly trails a URL.
    result = result.replace(/[.,;:!?*_~'"`]+$/, "");
    // Unicode/CJK punctuation that some models append after links.
    result = result.replace(/[。，、；：！？…»”’）】》〉]+$/, "");
    // Drop a closing delimiter only when the URL has no matching opener.
    const last = result[result.length - 1];
    const opener =
      last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : last === ">" ? "<" : "";
    if (opener) {
      const opens = result.split(opener).length - 1;
      const closes = result.split(last).length - 1;
      if (closes > opens) result = result.slice(0, -1);
    }
  }
  return result;
}

function decodeUrlEntities(url: string): string {
  return url
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

function renderLinkChip(url: string, label?: string): string {
  const cleanUrl = trimUrlPunctuation(decodeUrlEntities(url));
  let hostname = "";
  try {
    hostname = new URL(cleanUrl).hostname;
  } catch {
    hostname = cleanUrl.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  }
  const domain = escapeHtml(hostname);
  const favicon = escapeHtml(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`
  );
  // An explicit (author/markdown) label is kept as-is; otherwise the domain
  // is marked for upgrade to the real page title by RichTextView.
  const labelHtml =
    label !== undefined
      ? `<span class="truncate max-w-[200px]">${label}</span>`
      : `<span data-url-chip-label class="truncate max-w-[200px]">${domain}</span>`;
  return `<a href="${escapeHtml(cleanUrl)}" data-link-preview="chip" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] font-medium text-mention no-underline hover:bg-divider hover:text-ink cursor-pointer"><img data-url-chip-icon src="${favicon}" alt="" class="w-3 h-3 rounded" loading="lazy" />${labelHtml}</a>`;
}

/**
 * One line of the bullet normalization below, shared with the action-item
 * extractor so record parsing agrees with rendering on model bullet
 * styles: what renders as a checkbox must also parse as one.
 */
export function normalizeBulletLine(line: string): string {
  const dot = /^(\s*)•\s+(.*)$/.exec(line);
  if (dot) return `${dot[1]}- ${dot[2]}`;
  const m = /^(\s*)(\*{2,})\s+(.*)$/.exec(line);
  if (!m || m[3].includes("**")) return line;
  const depth = m[2].length - 1;
  return `${m[1]}${"  ".repeat(depth)}- ${m[3]}`;
}

/**
 * Models sometimes emit "**" as a nested-bullet marker (which CommonMark
 * reads as unclosed emphasis) or "•" bullets (which CommonMark ignores as
 * plain text). Rewrite both to dashes before parsing (fenced code
 * untouched), so they list properly. Star lines whose remainder still
 * contains "**" are left alone — that's emphasis, not a list.
 */
function normalizeBullets(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^ {0,3}```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return normalizeBulletLine(line);
    })
    .join("\n");
}

/** Link markup to its label: "[text](url)" → "text" (event titles). */
export function stripLinkMarkup(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/**
 * Raw anchors occasionally survive into markdown (model-emitted HTML).
 * Rewrite them to markdown links outside fenced code so they render as
 * chips; every other raw tag stays escaped by the html renderer.
 */
function normalizeAnchors(md: string): string {
  const parts: string[] = [];
  let inFence = false;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n");
    parts.push(
      inFence
        ? text
        : text.replace(
            /<a\b[^>]*href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
            (_m, u1, u2, u3, inner) =>
              `[${inner.replace(/\n/g, " ")}](${(u1 ?? u2 ?? u3 ?? "").trim()})`
          )
    );
    buf = [];
  };
  for (const line of md.split("\n")) {
    if (/^ {0,3}```/.test(line)) {
      flush();
      parts.push(line);
      inFence = !inFence;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return parts.join("\n");
}

const md = new Marked();
md.use({
  gfm: true,
  breaks: true,
  renderer: {
    link(this: Renderer, { href, tokens }: Tokens.Link) {
      const raw = (href || "").trim();
      const label = this.parser.parseInline(tokens);
      if (!isHttpUrl(raw)) return label || escapeHtml(raw);
      const clean = trimUrlPunctuation(decodeUrlEntities(raw));
      if (!isHttpUrl(clean)) return label;
      // Bare (autolinked) URLs show the domain, upgraded to the page title;
      // explicit [text](url) labels are kept. A www. autolink's text omits
      // the scheme marked prepends to the href.
      const noScheme = clean.replace(/^https?:\/\//i, "");
      const rawNoScheme = raw.replace(/^https?:\/\//i, "");
      const bare =
        label === escapeHtml(raw) ||
        label === escapeHtml(clean) ||
        label === escapeHtml(noScheme) ||
        label === escapeHtml(rawNoScheme);
      return renderLinkChip(clean, bare ? undefined : label);
    },
    image(this: Renderer, { href, text, tokens }: Tokens.Image) {
      const raw = (href || "").trim();
      const alt =
        tokens && tokens.length > 0
          ? this.parser.parseInline(tokens)
          : escapeHtml(text || "");
      if (!isHttpUrl(raw)) return alt;
      const clean = trimUrlPunctuation(decodeUrlEntities(raw));
      if (!isHttpUrl(clean)) return alt;
      return renderLinkChip(clean, alt.trim() ? alt : undefined);
    },
    code({ text, lang }: Tokens.Code) {
      return renderCodeBlock(escapeHtml(text), lang || "");
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code class="rounded bg-tag px-1 py-0.5 text-[12px] font-mono text-ink">${escapeHtml(text)}</code>`;
    },
    html({ text }: Tokens.HTML | Tokens.Tag) {
      // Escape raw HTML, restoring only anchors (as chips).
      const escaped = escapeHtml(text);
      return escaped.replace(
        /&lt;a\b[\s\S]*?href=&quot;([^&]*(?:&amp;[^&]*)*)&quot;[\s\S]*?&gt;([\s\S]*?)&lt;\/a&gt;/gi,
        (_match, url, inner) => {
          const clean = decodeUrlEntities(url).trim();
          if (!isHttpUrl(clean)) return inner;
          const label = inner.replace(/&lt;[^&]*?&gt;/g, "");
          return renderLinkChip(
            trimUrlPunctuation(clean),
            label || undefined
          );
        }
      );
    },
    blockquote(this: Renderer, { tokens }: Tokens.Blockquote) {
      return `<blockquote class="border-l-2 border-divider pl-3 my-2 text-mention">${this.parser.parse(tokens)}</blockquote>`;
    },
    hr() {
      return `<hr class="border-divider my-3" />`;
    },
    del(this: Renderer, { tokens }: Tokens.Del) {
      return `<del class="text-mention">${this.parser.parseInline(tokens)}</del>`;
    },
  },
});

export function renderRichText(src: string): string {
  if (!src) return "";
  return md.parse(normalizeAnchors(normalizeBullets(src))) as string;
}

/**
 * Inline-only rendering for one-line surfaces (thread titles, headers):
 * the same link-chip/escape pipeline, but no block elements so it stays
 * valid inside h1-h6, buttons, and truncation containers.
 */
export function renderInlineMarkdown(src: string): string {
  if (!src) return "";
  return md.parseInline(normalizeAnchors(normalizeBullets(src))) as string;
}

/** Best-effort plain text from AI markdown for tooltips and aria labels. */
export function markdownToPlainText(src: string): string {
  if (!src) return "";
  return stripLinkMarkup(src)
    .replace(/[*_`~#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
