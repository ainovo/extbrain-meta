import { ConversationTurn, ParsedActivityItem, RawTakeoutEntry } from "./types";

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Removes ChatGPT internal entity/citation artifacts from exported message
 * text. These are private-use-area wrappers like
 * `\uE200entity\uE202["software", "Luma", 0]\uE201` that would otherwise
 * leak into the rendered output. The whole wrapper (including the JSON array)
 * is stripped, since the display text is not reliably recoverable.
 */
export function stripChatGptEntityArtifacts(text: string): string {
  if (!text) return text;
  return text
    .replace(/\uE200(?:entity|cite)\uE202[\s\S]*?\uE201/g, "")
    .replace(/\uE200[\s\S]*?\uE201/g, "")
    .replace(/[\uE200-\uE202]/g, "");
}

export function cleanAiModeArtifacts(rawHtml: string): string {
  let text = rawHtml;
  // Remove <ctrl97>tool_code...<ctrl98> blocks
  text = text.replace(
    /<span>\s*&lt;ctrl97&gt;\s*<\/span>[\s\S]*?<span>\s*&lt;ctrl98&gt;\s*<\/span>/gi,
    ""
  );
  // Remove <<!contextual(...)>> and <<!floatImage(...)>> tags
  text = text.replace(/&lt;&lt;!(?:contextual|floatImage)\([\s\S]*?\)\/&gt;&gt;/gi, "");
  // Remove <inline entity(...)> wrapper tags while keeping inner text
  text = text.replace(/&lt;inline\s+entity\([\s\S]*?\)&gt;/gi, "");
  text = text.replace(/<span>\s*&lt;\/inline&gt;\s*<\/span>|&lt;\/inline&gt;/gi, "");
  // Convert escaped <br> inside spans
  text = text.replace(/<span>\s*&lt;br\s*\/?&gt;\s*<\/span>/gi, "<br>");
  // Unwrap escaped emoji brackets like &lt;🗓&gt;
  text = text.replace(/&lt;([^a-zA-Z0-9_<>\/\s]{1,4})&gt;/g, "$1");
  // Convert {Link: Text URL} pattern to standard anchor tags
  text = text.replace(
    /\{Link:\s*([^}\n]+?)\s+(https?:\/\/[^\s}]+)\}/g,
    '<a href="$2">$1</a>'
  );
  return text;
}

function convertHtmlTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cellRegex = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const cellMd = htmlFragmentToMarkdown(cellMatch[1])
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
      cells.push(cellMd);
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => [...r, ...Array(colCount - r.length).fill("")]);
  const header = normalized[0];
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + Array(colCount).fill("---").join(" | ") + " |",
    ...normalized.slice(1).map((r) => "| " + r.join(" | ") + " |"),
  ];
  return "\n\n" + lines.join("\n") + "\n\n";
}

export function htmlFragmentToMarkdown(rawHtml: string): string {
  let html = cleanAiModeArtifacts(rawHtml);

  // Handle tables first
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (tableMatch) =>
    convertHtmlTableToMarkdown(tableMatch)
  );

  // Handle <pre><code>...</code></pre>
  html = html.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code\s*>\s*<\/pre\s*>/gi, (_, code) => {
    const decoded = decodeHtmlEntities(code).replace(/^\n+|\n+$/g, "");
    return `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n`;
  });

  // Handle inline <code>...</code>
  html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, code) => {
    const decoded = decodeHtmlEntities(code).trim();
    return decoded.includes("`") ? `\`\` ${decoded} \`\`` : `\`${decoded}\``;
  });

  // Handle links <a href="...">text</a>
  html = html.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const cleanHref = decodeHtmlEntities(href).trim();
    const cleanInner = htmlFragmentToMarkdown(inner).trim();
    if (!cleanHref || cleanHref === "url") return cleanInner;
    return `[${cleanInner || cleanHref}](${cleanHref})`;
  });

  // Headings
  html = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const hashes = "#".repeat(Number(level));
    return `\n\n${hashes} ${htmlFragmentToMarkdown(inner).trim()}\n\n`;
  });

  // Blockquotes
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner) => {
    const lines = htmlFragmentToMarkdown(inner)
      .trim()
      .split("\n")
      .map((l) => `> ${l}`);
    return `\n\n${lines.join("\n")}\n\n`;
  });

  // Bold & Italic
  // NOTE: \b after tag names is critical — without it, bare `b` matches `<br>`
  // and bare `i` matches `<img>`/`<input>`, swallowing content up to the next closing tag.
  html = html.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, "**$1**");
  html = html.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, "*$1*");

  // Lists
  html = html.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => {
    const cleanInner = htmlFragmentToMarkdown(inner).replace(/\n+/g, " ").trim();
    return `\n- ${cleanInner}`;
  });
  html = html.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n");

  // Horizontal rule, br, paragraphs
  html = html.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");
  html = html.replace(/<br\b[^>]*>/gi, "\n");
  html = html.replace(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi, "\n\n$1\n\n");

  // Block-level containers imply line breaks. Stripping them with "" glues
  // the last word of one block to the first word of the next ("...to
  // Braden</div><div>Hi Braden," -> "BradenHi Braden"), fabricating tokens
  // downstream NER then faithfully extracts. Inline tags (span/b/i/a/...)
  // are handled above or stripped safely below.
  html = html.replace(
    /<\/?(?:div|section|article|header|footer|main|aside|figure|figcaption|details|summary)\b[^>]*>/gi,
    "\n"
  );
  html = html.replace(/<\/?(?:tr)\b[^>]*>/gi, "\n");
  html = html.replace(/<\/?(?:td|th)\b[^>]*>/gi, " ");

  // Strip any remaining tags
  html = html.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Decode entities
  html = decodeHtmlEntities(html);

  // Normalize blank lines
  html = html.replace(/[ \t]+\n/g, "\n");
  html = html.replace(/\n{3,}/g, "\n\n");
  return html.trim();
}

export function extractEntitiesFromText(text: string): string[] {
  const entities = new Set<string>();

  // 1. Domains / URLs (e.g. example.com, docs provider sites)
  const domainRegex = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|io|ai|co|gov|edu|mil|us|app|dev|so))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = domainRegex.exec(text)) !== null) {
    const dom = match[1].toLowerCase();
    if (!["www.google.com", "google.com", "en.wikipedia.org"].includes(dom)) {
      entities.add(dom);
    }
  }

  // 2. Bolded phrases (**...**) that look like product/feature/concept names
  const boldRegex = /\*\*([^*:\n]{2,42})\*\*/g;
  while ((match = boldRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (
      candidate.length >= 3 &&
      !/^(yes|no|note|tip|step \d+|the |why |how |what |when |where |your prompt|search's response)/i.test(
        candidate
      )
    ) {
      entities.add(candidate);
    }
  }

  // 3. Inline code terms (`...`) that look like identifiers/tools/flags
  const codeRegex = /`([^`\n]{2,40})`/g;
  while ((match = codeRegex.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length >= 2 && !code.includes(" ")) {
      entities.add(code);
    }
  }

  // 4. Capitalized Proper Noun / Product Phrases (e.g. "ChatGPT Ads", "Ads Manager", "OpenAI Ads", "Delta Dental")
  const properPhraseRegex = /\b([A-Z][A-Za-z0-9.+-]{1,20}(?:\s+[A-Z][A-Za-z0-9.+-]{1,20}){1,2})\b/g;
  const ignoreProper = new Set([
    "Your Prompt",
    "Key Features",
    "Key Details",
    "The Hook",
    "Visual Synergy",
    "The Catch",
    "The Solution",
    "The Result",
    "Next Steps",
    "Quick Comparison",
    "How It Works",
    "United States",
  ]);
  while ((match = properPhraseRegex.exec(text)) !== null) {
    const phrase = match[1].trim();
    if (phrase.length >= 5 && !ignoreProper.has(phrase)) {
      entities.add(phrase);
    }
  }

  // 5. CamelCase / MixedCase brand & tool identifiers (e.g. ChatGPT, OpenAI, OpenClaw, GitHub, LinkedIn, FastMCP)
  const camelCaseRegex = /\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;
  while ((match = camelCaseRegex.exec(text)) !== null) {
    entities.add(match[1]);
  }

  // 6. Hashtags (e.g. #ChatGPTAds -> ChatGPT Ads)
  const hashtagRegex = /#([A-Za-z][A-Za-z0-9_]{3,30})\b/g;
  while ((match = hashtagRegex.exec(text)) !== null) {
    const tag = match[1].replace(/([a-z])([A-Z])/g, "$1 $2");
    entities.add(tag);
  }

  return Array.from(entities).slice(0, 25);
}

export function summarizeAiResponse(responseMd: string): string {
  if (!responseMd) return "";
  const lines = responseMd
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  // First paragraph (opening conclusion)
  const firstPara = lines.find((l) => !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("---")) || lines[0];

  // Collect section headings, bullets, AND prose paragraphs with bold highlights or metrics
  const highlights: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("### ") || line.startsWith("## ")) {
      highlights.push(line.replace(/^#+\s*/, ""));
    } else if (/^-\s+\*\*[^*]+\*\*/.test(line)) {
      const shortBullet = line.length > 180 ? line.slice(0, 180) + "..." : line;
      highlights.push(shortBullet);
    } else if (/\*\*[^*]+\*\*|\b\d+%|\$\d+/i.test(line)) {
      const shortPara = line.length > 260 ? line.slice(0, 260) + "..." : line;
      highlights.push(shortPara);
    }
    if (highlights.length >= 8) break;
  }

  const combined = [firstPara, ...highlights].join("\n");
  return combined.length > 1200 ? combined.slice(0, 1200) + "..." : combined;
}

export function parseTurnsFromMarkdownAndTitle(
  cleanTitle: string,
  rawHtmlItems: Array<{ html?: string }>
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const fullMdParts: string[] = [];

  for (const item of rawHtmlItems) {
    if (item.html) {
      const md = htmlFragmentToMarkdown(item.html);
      if (md) fullMdParts.push(md);
    }
  }

  const combinedMd = fullMdParts.join("\n\n");

  // AI Mode format ("Searched for ..." titles):
  // - Prompt comes from the title (already stripped of the "Searched for" prefix → cleanTitle)
  // - AI response is the content after each "Search's response:" marker.
  // Follow-up turns (if any) keep their own "**Your prompt:**" section text.
  if (/\*\*Your prompt:\*\*/i.test(combinedMd)) {
    const segments = combinedMd.split(/\*\*Your prompt:\*\*\s*/i).filter((s) => s.trim().length > 0);
    segments.forEach((seg, segIdx) => {
      const parts = seg.split(/\*\*Search's response:\*\*\s*/i);
      const sectionPrompt = (parts[0] || "").trim();
      // First turn's prompt is authoritative from the title; follow-ups use their own section text
      const promptText = segIdx === 0 && cleanTitle ? cleanTitle : sectionPrompt;
      const responseText = parts.slice(1).join("\n\n").trim();
      if (!promptText && !responseText) return;
      turns.push({
        prompt: promptText,
        responseMarkdown: responseText,
        responseSummary: summarizeAiResponse(responseText),
        extractedEntities: extractEntitiesFromText(promptText + "\n" + responseText),
      });
    });
  } else if (/\*\*Search's response:\*\*/i.test(combinedMd)) {
    // Single query with no "**Your prompt:**" echo: prompt is the title,
    // response is everything after the "Search's response:" marker
    const responseText = combinedMd
      .split(/\*\*Search's response:\*\*\s*/i)
      .slice(1)
      .join("\n\n")
      .trim();
    turns.push({
      prompt: cleanTitle,
      responseMarkdown: responseText,
      responseSummary: summarizeAiResponse(responseText),
      extractedEntities: extractEntitiesFromText(cleanTitle + "\n" + responseText),
    });
  } else if (combinedMd) {
    // Gemini Apps format: title holds "Prompted <user prompt>" and safeHtmlItem holds the AI response
    turns.push({
      prompt: cleanTitle,
      responseMarkdown: combinedMd,
      responseSummary: summarizeAiResponse(combinedMd),
      extractedEntities: extractEntitiesFromText(cleanTitle + "\n" + combinedMd),
    });
  } else if (cleanTitle) {
    // Search / Prompt with no response body
    turns.push({
      prompt: cleanTitle,
      responseMarkdown: "",
      responseSummary: "",
      extractedEntities: extractEntitiesFromText(cleanTitle),
    });
  }

  return turns;
}

/**
 * Rough token estimate: ASCII-ish text runs ~4 chars per token, but CJK
 * characters (Han, Hiragana, Katakana, Hangul) cost ~1 token each, so the
 * old chars/4 rule undercounted CJK-heavy histories by 2x or more. ASCII
 * text is unaffected (no CJK match, identical arithmetic).
 */
const CJK_FOR_TOKENS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

export function estimateTokens(text: string): number {
  const s = text || "";
  const cjk = s.match(CJK_FOR_TOKENS)?.length ?? 0;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/**
 * Recompute both token estimates from stored text, using the same inputs
 * as parse time (full text for full, prompts plus condensed responses for
 * packed). Falls back to rebuilding from turns when fullMarkdown is absent.
 */
export function refreshTokenEstimates(
  item: ParsedActivityItem
): ParsedActivityItem {
  const full =
    item.fullMarkdown ||
    item.turns
      .map(
        (t) =>
          `### Prompt\n${t.prompt}\n\n### Response\n${t.responseMarkdown || ""}`
      )
      .join("\n\n");
  const packed = `${item.allPromptsText || ""}\n${item.condensedResponseText || ""}`;
  return {
    ...item,
    estimatedFullTokens: estimateTokens(full),
    estimatedPackedTokens: estimateTokens(packed),
  };
}

const tokenEstimateFlagFor = (uuid: string): string =>
  `sb_token_est_v2_${uuid}`;

/**
 * One-time backfill: stored chats keep the estimates computed at import,
 * so a formula change never reaches history by itself. Runs once per
 * dataset (flagged in localStorage), then returns inputs untouched.
 */
export function migrateTokenEstimates(
  uuid: string,
  items: ParsedActivityItem[]
): ParsedActivityItem[] {
  try {
    if (localStorage.getItem(tokenEstimateFlagFor(uuid))) return items;
    const next = items.map(refreshTokenEstimates);
    localStorage.setItem(tokenEstimateFlagFor(uuid), "1");
    return next;
  } catch {
    return items;
  }
}

export function parseTakeoutJson(
  jsonContent: string,
  sourceFileName = "MyActivity.json"
): ParsedActivityItem[] {
  const parsed = JSON.parse(jsonContent);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array in ${sourceFileName}`);
  }

  const items: ParsedActivityItem[] = [];

  parsed.forEach((entry: RawTakeoutEntry, idx: number) => {
    if (!entry || typeof entry !== "object") return;
    const rawTitle = (entry.title || "").trim();
    const htmlItems = entry.safeHtmlItem || [];

    // Skip empty "Used AI Mode" or "Searched with Google Lens" with no text turns
    if (
      htmlItems.length === 0 &&
      (rawTitle === "Used AI Mode" || rawTitle === "Searched with Google Lens" || !rawTitle)
    ) {
      return;
    }

    const cleanTitle = rawTitle
      .replace(/^(?:Searched for|Prompted)\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();

    const isoTime = entry.time || "";
    let dateStr = isoTime;
    try {
      if (isoTime) {
        const d = new Date(isoTime);
        if (!isNaN(d.getTime())) {
          dateStr = d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
        }
      }
    } catch {
      // fallback to raw string
    }

    const turns = parseTurnsFromMarkdownAndTitle(cleanTitle, htmlItems);
    if (turns.length === 0) return;

    const allPromptsText = turns.map((t, i) => (turns.length > 1 ? `[Turn ${i + 1}] ${t.prompt}` : t.prompt)).join("\n");
    const condensedResponseText = turns
      .map((t, i) => (t.responseSummary ? (turns.length > 1 ? `[AI Turn ${i + 1}] ${t.responseSummary}` : t.responseSummary) : ""))
      .filter(Boolean)
      .join("\n");

    const fullMarkdown = turns
      .map(
        (t, i) =>
          `### Prompt ${turns.length > 1 ? i + 1 : ""}\n${t.prompt}\n\n### Response ${turns.length > 1 ? i + 1 : ""}\n${t.responseMarkdown}`
      )
      .join("\n\n");

    const entitySet = new Set<string>();
    turns.forEach((t) => t.extractedEntities.forEach((e) => entitySet.add(e)));

    const id = `item_${isoTime.slice(0, 19).replace(/[^0-9]/g, "")}_${idx}`;

    items.push({
      id,
      sourceFile: sourceFileName,
      header: entry.header || "AI Mode",
      title: rawTitle,
      cleanTitle: cleanTitle || "Untitled Activity",
      titleUrl: entry.titleUrl,
      threadUrl: entry.details?.[0]?.url || undefined,
      timestamp: isoTime,
      dateStr,
      products: entry.products || [entry.header || "AI Mode"],
      turns,
      allPromptsText,
      condensedResponseText,
      fullMarkdown,
      extractedEntities: Array.from(entitySet),
      estimatedFullTokens: estimateTokens(fullMarkdown),
      estimatedPackedTokens: estimateTokens(allPromptsText + "\n" + condensedResponseText),
    });
  });

  // Sort chronologically (oldest -> newest) so timeline progression is natural
  items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return items;
}

export function parseObsidianMarkdownFile(
  mdContent: string,
  fileName: string,
  indexSuffix = 0
): ParsedActivityItem | null {
  let title = fileName.replace(/\.md$/i, "");
  let isoTime = "";
  let header = "Obsidian Note";
  let body = mdContent;

  const fmMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    body = fmMatch[2];
    const titleMatch = fm.match(/^title:\s*"?([^"\n]+)"?/m);
    const dateMatch = fm.match(/^date:\s*"?([^"\n]+)"?/m);
    const headerMatch = fm.match(/^header:\s*"?([^"\n]+)"?/m);
    if (titleMatch) title = titleMatch[1].trim();
    if (dateMatch) isoTime = dateMatch[1].trim();
    if (headerMatch) header = headerMatch[1].trim();
  }

  const cleanTitle = title.replace(/^(?:Searched for|Prompted)\s+/i, "").trim();
  const bodyWithoutH1 = body.replace(/^#\s+[^\n]+\n+/, "").trim();

  const turns: ConversationTurn[] = [];
  if (/###\s*Prompt/i.test(bodyWithoutH1)) {
    const blocks = bodyWithoutH1.split(/###\s*Prompt\s*\d*\s*\n/i).filter((b) => b.trim());
    for (const b of blocks) {
      const [promptPart, ...respParts] = b.split(/###\s*Response\s*\d*\s*\n/i);
      const pText = (promptPart || "").trim();
      const rText = respParts.join("\n").trim();
      turns.push({
        prompt: pText,
        responseMarkdown: rText,
        responseSummary: summarizeAiResponse(rText),
        extractedEntities: extractEntitiesFromText(pText + "\n" + rText),
      });
    }
  } else {
    turns.push({
      prompt: cleanTitle,
      responseMarkdown: bodyWithoutH1,
      responseSummary: summarizeAiResponse(bodyWithoutH1),
      extractedEntities: extractEntitiesFromText(cleanTitle + "\n" + bodyWithoutH1),
    });
  }

  let dateStr = isoTime || "Unknown Date";
  try {
    if (isoTime) {
      const d = new Date(isoTime);
      if (!isNaN(d.getTime())) {
        dateStr = d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      }
    }
  } catch {
    // ignore
  }

  const allPromptsText = turns.map((t) => t.prompt).join("\n");
  const condensedResponseText = turns.map((t) => t.responseSummary).join("\n");
  const entitySet = new Set<string>();
  turns.forEach((t) => t.extractedEntities.forEach((e) => entitySet.add(e)));

  return {
    id: `md_${isoTime.slice(0, 19).replace(/[^0-9]/g, "") || indexSuffix}_${indexSuffix}`,
    sourceFile: fileName,
    header,
    title,
    cleanTitle,
    timestamp: isoTime,
    dateStr,
    products: [header],
    turns,
    allPromptsText,
    condensedResponseText,
    fullMarkdown: bodyWithoutH1,
    extractedEntities: Array.from(entitySet),
    estimatedFullTokens: estimateTokens(bodyWithoutH1),
    estimatedPackedTokens: estimateTokens(allPromptsText + "\n" + condensedResponseText),
  };
}

export type TakeoutJsonSource = "chatgpt" | "gemini" | "aimode" | "claude" | "unknown";

/**
 * True when an entry looks like a ChatGPT conversation: it has a `title`
 * string and a `mapping` object of message nodes.
 */
function isChatGptConversationEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.title !== "string") return false;
  const mapping = e.mapping;
  return (
    !!mapping && typeof mapping === "object" && !Array.isArray(mapping)
  );
}

/**
 * True when an entry looks like a Claude conversation: it carries a
 * `chat_messages` array of `{ text, sender }` objects (Claude data export —
 * `conversations.json` is a bare array of these).
 */
function isClaudeConversationEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const msgs = e.chat_messages;
  if (!Array.isArray(msgs)) return false;
  return msgs.some((m) => {
    if (!m || typeof m !== "object") return false;
    const r = m as Record<string, unknown>;
    if (typeof r.sender !== "string") return false;
    return typeof r.text === "string" || Array.isArray(r.content);
  });
}

/**
 * Detects which product a Takeout/ChatGPT/Claude JSON blob belongs to.
 * - chatgpt: object with a `conversations` array, or a top-level array of
 *   conversation objects (ChatGPT data export — `conversations.json` is a
 *   bare array, but some exports wrap it in an object)
 * - gemini: Takeout array containing Gemini entries
 * - aimode: Takeout array containing Google Search AI Mode entries
 * - claude: top-level array of conversations with `chat_messages`
 */
export function detectJsonSource(jsonContent: string): TakeoutJsonSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return "unknown";
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const convs = (parsed as Record<string, unknown>).conversations;
    if (Array.isArray(convs)) return "chatgpt";
    return "unknown";
  }
  if (!Array.isArray(parsed)) return "unknown";
  const entries = parsed as RawTakeoutEntry[];
  if (entries.length > 0 && entries.some(isChatGptConversationEntry)) {
    return "chatgpt";
  }
  if (entries.length > 0 && entries.some(isClaudeConversationEntry)) {
    return "claude";
  }
  const hasGemini = entries.some((e) => {
    if (!e || typeof e !== "object") return false;
    const products = (e.products || []).join(" ").toLowerCase();
    const header = (e.header || "").toLowerCase();
    return products.includes("gemini") || header.includes("gemini");
  });
  if (hasGemini) return "gemini";
  const hasAiMode = entries.some((e) => {
    if (!e || typeof e !== "object") return false;
    return (
      e.header === "AI Mode" || (e.title || "").startsWith("Searched for")
    );
  });
  if (hasAiMode) return "aimode";
  return "unknown";
}

interface ChatGptMessageNode {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
  } | null;
}

/**
 * Parses a ChatGPT data export (`conversations.json`) into
 * ParsedActivityItems. Accepts both shapes:
 * - a top-level array of conversation objects (the current export format)
 * - an object with a `conversations` array (older/wrapped exports)
 * Throws on invalid format.
 */
export function parseChatGptJson(
  jsonContent: string,
  sourceFileName = "conversations.json"
): ParsedActivityItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    throw new Error("Not valid JSON.");
  }

  let convs: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    convs = parsed;
  } else if (parsed && typeof parsed === "object") {
    const wrapped = (parsed as Record<string, unknown>).conversations;
    if (Array.isArray(wrapped)) convs = wrapped;
  }

  if (!convs) {
    throw new Error(
      "Not a ChatGPT export (expected a top-level array of conversations or an object with a `conversations` array)."
    );
  }

  const items: ParsedActivityItem[] = [];

  convs.forEach((conv: unknown, convIdx: number) => {
    const c = (conv || {}) as Record<string, unknown>;
    const title =
      typeof c.title === "string" && c.title.trim()
        ? c.title.trim()
        : "Untitled Chat";
    const mapping = (c.mapping || {}) as Record<string, ChatGptMessageNode>;

    // Conversation UUID: `id` on current exports, `conversation_id` on some.
    const conversationId =
      (typeof c.id === "string" && c.id.trim()) ||
      (typeof c.conversation_id === "string" && c.conversation_id.trim()) ||
      "";
    const threadUrl = conversationId
      ? `https://chat.openai.com/c/${encodeURIComponent(conversationId)}`
      : undefined;
    const titleUrl = threadUrl;

    const messages: Array<{
      role: string;
      text: string;
      time: number;
      hasTime: boolean;
    }> = [];
    Object.values(mapping).forEach((node, order) => {
      const msg = node?.message;
      const role = msg?.author?.role;
      if (role !== "user" && role !== "assistant") return;
      const parts = msg?.content?.parts;
      if (!Array.isArray(parts)) return;
      const text = parts
        .filter((p): p is string => typeof p === "string")
        .map((p) =>
          stripChatGptEntityArtifacts(p)
        )
        .join("\n\n")
        .trim();
      if (!text) return;
      const hasTime =
        typeof msg?.create_time === "number" && msg.create_time > 0;
      const t = hasTime ? (msg?.create_time as number) : order;
      messages.push({ role, text, time: t, hasTime });
    });
    messages.sort((a, b) => a.time - b.time);
    if (messages.length === 0) return;

    const turns: Array<ConversationTurn & { time: number; hasTime: boolean }> =
      [];
    for (const m of messages) {
      if (m.role === "user") {
        turns.push({
          prompt: m.text,
          responseMarkdown: "",
          responseSummary: "",
          extractedEntities: extractEntitiesFromText(m.text),
          time: m.time,
          hasTime: m.hasTime,
        });
      } else {
        const last = turns[turns.length - 1];
        if (last && !last.responseMarkdown) {
          last.responseMarkdown = m.text;
          last.responseSummary = summarizeAiResponse(m.text);
          last.extractedEntities = extractEntitiesFromText(
            last.prompt + "\n" + m.text
          );
        } else if (last) {
          last.responseMarkdown = (last.responseMarkdown + "\n\n" + m.text).trim();
          last.responseSummary = summarizeAiResponse(last.responseMarkdown);
          last.extractedEntities = extractEntitiesFromText(
            last.prompt + "\n" + last.responseMarkdown
          );
        }
      }
    }
    // Drop leading assistant-only turns with no prompt
    const usable = turns.filter((t) => t.prompt || t.responseMarkdown);
    if (usable.length === 0) return;

    const toIso = (v: unknown): string => {
      if (typeof v === "number" && v > 0) {
        const ms = v < 1e12 ? v * 1000 : v;
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      return "";
    };
    const formatDateStr = (iso: string): string => {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        if (!isNaN(d.getTime())) {
          return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
        }
      } catch {
        // ignore
      }
      return iso;
    };

    const conversationIsoTime = toIso(c.create_time) || toIso(c.update_time);

    usable.forEach((turn, turnIdx) => {
      const turnIsoTime =
        (turn.hasTime && toIso(turn.time)) || conversationIsoTime;
      const turnDateStr = formatDateStr(turnIsoTime);
      const turnArr: ConversationTurn[] = [
        {
          prompt: turn.prompt,
          responseMarkdown: turn.responseMarkdown,
          responseSummary: turn.responseSummary,
          extractedEntities: turn.extractedEntities,
        },
      ];
      const allPromptsText = turn.prompt;
      const condensedResponseText = turn.responseSummary || "";
      const fullMarkdown = `### Prompt\n${turn.prompt}\n\n### Response\n${turn.responseMarkdown}`;
      const extractedEntities = turn.extractedEntities || [];

      items.push({
        id: `chatgpt_${turnIsoTime.slice(0, 19).replace(/[^0-9]/g, "") || convIdx}_${convIdx}_${turnIdx}`,
        sourceFile: sourceFileName,
        header: "ChatGPT",
        title,
        cleanTitle: title,
        titleUrl,
        threadUrl,
        timestamp: turnIsoTime,
        dateStr: turnDateStr,
        products: ["ChatGPT"],
        turns: turnArr,
        allPromptsText,
        condensedResponseText,
        fullMarkdown,
        extractedEntities,
        estimatedFullTokens: estimateTokens(fullMarkdown),
        estimatedPackedTokens: estimateTokens(
          allPromptsText + (condensedResponseText ? "\n" + condensedResponseText : "")
        ),
      });
    });
  });

  if (items.length === 0) {
    throw new Error("No conversations with messages found in this file.");
  }
  items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return items;
}

/**
 * True when the blob looks like a Claude export manifest index: a JSON
 * object (never the conversations array) that points at per-category ZIP
 * parts via download URLs. Newer Claude exports arrive as a
 * `manifest-*.json` listing parts like `conversations-000.zip` instead of a
 * single `conversations.json`, so the manifest itself holds no chats.
 * A `conversations` array value is never descended into, so a wrapped
 * ChatGPT export (message text may contain URLs) cannot match.
 */
/**
 * Anthropic's own stand-in for tool/artifact blocks in the flattened `text`
 * rendering. The structured `content` blocks carry the real data, so the
 * placeholder is dropped wherever `text` is used as a fallback.
 */
const CLAUDE_BLOCK_PLACEHOLDER =
  "This block is not supported on your current device yet.";

function scrubClaudePlaceholders(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== CLAUDE_BLOCK_PLACEHOLDER)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Authoritative message text for a Claude export message. The structured
 * `content` blocks win (prose lives in `type: "text"` blocks; `thinking`,
 * `tool_use`, `tool_result` and friends are execution detail, not chat
 * content). Older exports without `content` fall back to the flattened
 * `text` field with tool placeholders scrubbed.
 */
function claudeMessageText(msg: ClaudeMessage): string {
  const content = msg.content;
  if (Array.isArray(content) && content.length > 0) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        const t = b.text.trim();
        if (t) parts.push(t);
      }
    }
    return parts.join("\n\n").trim();
  }
  if (typeof content === "string" && content.trim()) return content.trim();
  return typeof msg.text === "string" ? scrubClaudePlaceholders(msg.text) : "";
}

interface OrderedClaudeMessage {
  msg: ClaudeMessage;
  index: number;
}

/**
 * Order a conversation's messages parent-before-child via
 * `parent_message_uuid` (stable by `created_at`, then export order), so
 * children render under the message they reply to even when the export
 * array is not chronological. Roots are messages whose parent is absent
 * from the conversation. Cycle-safe: leftovers append at the end.
 */
function orderClaudeMessages(rawMessages: unknown[]): OrderedClaudeMessage[] {
  const entries: Array<{
    msg: ClaudeMessage;
    index: number;
    uuid: string;
    parent: string;
    time: string;
  }> = rawMessages.map((raw, index) => {
    const msg = (raw || {}) as ClaudeMessage;
    return {
      msg,
      index,
      uuid: typeof msg.uuid === "string" ? msg.uuid : "",
      parent: typeof msg.parent_message_uuid === "string" ? msg.parent_message_uuid : "",
      time: typeof msg.created_at === "string" ? msg.created_at : "",
    };
  });
  const byUuid = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, i);
  });
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  entries.forEach((e, i) => {
    const parentIdx = e.parent ? byUuid.get(e.parent) : undefined;
    if (parentIdx === undefined || parentIdx === i) {
      roots.push(i);
    } else {
      const arr = children.get(parentIdx) ?? [];
      arr.push(i);
      children.set(parentIdx, arr);
    }
  });
  const byTimeThenIndex = (a: number, b: number): number => {
    const ta = entries[a].time;
    const tb = entries[b].time;
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    return entries[a].index - entries[b].index;
  };
  roots.sort(byTimeThenIndex);
  for (const arr of children.values()) arr.sort(byTimeThenIndex);
  const visited = new Set<number>();
  const ordered: OrderedClaudeMessage[] = [];
  const visit = (i: number): void => {
    if (visited.has(i)) return;
    visited.add(i);
    ordered.push({ msg: entries[i].msg, index: entries[i].index });
    for (const child of children.get(i) ?? []) visit(child);
  };
  for (const r of roots) visit(r);
  // Orphans from cycles or anything missed: keep them, don't drop them.
  const leftover = entries.map((_, i) => i).filter((i) => !visited.has(i)).sort(byTimeThenIndex);
  for (const i of leftover) visit(i);
  return ordered;
}

export function looksLikeClaudeManifest(jsonContent: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const strings: string[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (depth > 3 || strings.length > 200) return;
    if (typeof v === "string") {
      strings.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) collect(item, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        strings.push(k);
        // Never descend into a `conversations` array: that is the ChatGPT
        // wrapped-export shape (message text may contain URLs), not a
        // manifest part list.
        if (k === "conversations" && Array.isArray((v as Record<string, unknown>)[k])) {
          continue;
        }
        collect((v as Record<string, unknown>)[k], depth + 1);
      }
    }
  };
  collect(parsed, 0);
  const lower = strings.map((s) => s.toLowerCase());
  return (
    lower.some((s) => s.includes("conversations")) &&
    lower.some((s) => s.startsWith("http") || s.endsWith(".zip"))
  );
}

interface ClaudeMessage {
  uuid?: unknown;
  text?: unknown;
  content?: unknown;
  sender?: unknown;
  created_at?: unknown;
  parent_message_uuid?: unknown;
}

interface ClaudeConversation {
  uuid?: unknown;
  name?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  chat_messages?: unknown;
}

/**
 * Parses a Claude data export (`conversations.json`) into
 * ParsedActivityItems. The export is a top-level array of conversation
 * objects, each with a `name` and a `chat_messages` array whose entries
 * carry `text`, `sender` ("human" | "assistant") and `created_at`.
 * Like the ChatGPT parser, this emits one item per human turn paired with
 * the assistant reply that follows it.
 * Throws on invalid format.
 */
export function parseClaudeJson(
  jsonContent: string,
  sourceFileName = "conversations.json"
): ParsedActivityItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    throw new Error("Not valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a top-level array of conversations in ${sourceFileName}`
    );
  }

  const toIso = (v: unknown): string => {
    if (typeof v !== "string" || !v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  };
  const formatDateStr = (iso: string): string => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) {
        return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      }
    } catch {
      // ignore
    }
    return iso;
  };

  const items: ParsedActivityItem[] = [];

  parsed.forEach((conv: unknown, convIdx: number) => {
    const c = (conv || {}) as ClaudeConversation;
    const title =
      typeof c.name === "string" && c.name.trim()
        ? c.name.trim()
        : "Untitled chat";
    const conversationId = typeof c.uuid === "string" && c.uuid.trim() ? c.uuid.trim() : "";
    const threadUrl = conversationId
      ? `https://claude.ai/chat/${encodeURIComponent(conversationId)}`
      : undefined;
    const titleUrl = threadUrl;
    const rawMessages = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    const conversationIsoTime = toIso(c.created_at) || toIso(c.updated_at);

    // Per-message times: every turn keeps its own prompt time so turns of
    // one conversation stay distinct under import's timestamp+title dedupe.
    const turns: Array<ConversationTurn & { time: string }> = [];
    for (const { msg: m } of orderClaudeMessages(rawMessages)) {
      const role = typeof m.sender === "string" ? m.sender.toLowerCase() : "";
      if (role !== "human" && role !== "assistant") continue;
      const text = claudeMessageText(m);
      if (!text) continue;
      if (role === "human") {
        turns.push({
          prompt: text,
          responseMarkdown: "",
          responseSummary: "",
          extractedEntities: extractEntitiesFromText(text),
          time: toIso(m.created_at),
        });
      } else {
        const last = turns[turns.length - 1];
        // A turn without its own prompt time (unpaired assistant reply)
        // still borrows the reply time rather than the conversation time.
        if (last && !last.time) last.time = toIso(m.created_at);
        if (last && !last.responseMarkdown) {
          last.responseMarkdown = text;
          last.responseSummary = summarizeAiResponse(text);
          last.extractedEntities = extractEntitiesFromText(
            last.prompt + "\n" + text
          );
        } else if (last) {
          last.responseMarkdown = (last.responseMarkdown + "\n\n" + text).trim();
          last.responseSummary = summarizeAiResponse(last.responseMarkdown);
          last.extractedEntities = extractEntitiesFromText(
            last.prompt + "\n" + last.responseMarkdown
          );
        }
      }
    }
    // Drop leading assistant-only turns with no prompt
    const usable = turns.filter((t) => t.prompt || t.responseMarkdown);
    if (usable.length === 0) return;

    usable.forEach((turn, turnIdx) => {
      const turnIsoTime = turn.time || conversationIsoTime;
      const turnDateStr = formatDateStr(turnIsoTime);
      const allPromptsText = turn.prompt;
      const condensedResponseText = turn.responseSummary || "";
      const fullMarkdown = `### Prompt\n${turn.prompt}\n\n### Response\n${turn.responseMarkdown}`;
      const extractedEntities = turn.extractedEntities || [];

      items.push({
        id: `claude_${turnIsoTime.slice(0, 19).replace(/[^0-9]/g, "") || convIdx}_${convIdx}_${turnIdx}`,
        sourceFile: sourceFileName,
        header: "Claude",
        title,
        cleanTitle: title,
        titleUrl,
        threadUrl,
        timestamp: turnIsoTime,
        dateStr: turnDateStr,
        products: ["Claude"],
        turns: [
          {
            prompt: turn.prompt,
            responseMarkdown: turn.responseMarkdown,
            responseSummary: turn.responseSummary,
            extractedEntities: turn.extractedEntities,
          },
        ],
        allPromptsText,
        condensedResponseText,
        fullMarkdown,
        extractedEntities,
        estimatedFullTokens: estimateTokens(fullMarkdown),
        estimatedPackedTokens: estimateTokens(
          allPromptsText + (condensedResponseText ? "\n" + condensedResponseText : "")
        ),
      });
    });
  });

  if (items.length === 0) {
    throw new Error("No conversations with messages found in this file.");
  }
  items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return items;
}
