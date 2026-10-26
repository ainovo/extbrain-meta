import React, { useMemo } from "react";
import {
  markdownToPlainText,
  renderInlineMarkdown,
  renderRichText,
} from "../lib/richText";
import { RichTextView } from "./RichTextView";

const STREAM_CURSOR = '<span className="animate-pulse">▍</span>';

/**
 * Unified AI-markdown display, summaries-grade everywhere: full GFM block
 * rendering (lists, tables, headings, code) with favicon link chips, hover
 * preview cards, and page-title upgrades — the same pipeline summaries use.
 */
export const MarkdownView = React.memo(function MarkdownView({
  markdown,
  className,
  streaming = false,
}: {
  markdown: string;
  className?: string;
  /** Append a pulsing cursor while the model is still streaming. */
  streaming?: boolean;
}) {
  const html = useMemo(
    () =>
      markdown
        ? renderRichText(markdown) + (streaming ? STREAM_CURSOR : "")
        : "",
    [markdown, streaming]
  );
  return <RichTextView html={html} className={className} />;
});

/**
 * Inline twin for one-line surfaces (thread titles, headers): same escape
 * and link-chip pipeline, no block elements, valid inside h1-h6/buttons.
 */
export const MarkdownInline = React.memo(function MarkdownInline({
  markdown,
  className,
  title,
}: {
  markdown: string;
  className?: string;
  /** Plain-text tooltip; derived from the markdown when omitted. */
  title?: string;
}) {
  const html = useMemo(() => renderInlineMarkdown(markdown), [markdown]);
  const tip = useMemo(
    () => title ?? markdownToPlainText(markdown),
    [title, markdown]
  );
  return (
    <span title={tip} className="contents">
      <RichTextView inline html={html} className={className} />
    </span>
  );
});

export { markdownToPlainText };
