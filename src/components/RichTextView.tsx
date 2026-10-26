import React, { useEffect, useRef } from "react";
import { fetchUrlMetadata } from "../lib/urlPreview";

/**
 * Renders renderRichText() HTML (bare-URL links come out as favicon + host
 * chips) and upgrades each chip's label to the real page title once
 * /api/url-metadata resolves. Hover sneak-peek cards are handled globally
 * by UrlPreviewLayer.
 */
export const RichTextView = React.memo(function RichTextView({
  html,
  className,
  inline = false,
}: {
  html: string;
  className?: string;
  /** Render a span instead of a div for phrasing-only containers. */
  inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement | HTMLSpanElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>('a[data-link-preview="chip"]')
    );
    for (const a of anchors) {
      const url = a.getAttribute("href") || "";
      const label = a.querySelector<HTMLElement>("[data-url-chip-label]");
      if (!url || !label) continue;
      fetchUrlMetadata(url).then((meta) => {
        // The container may have been re-rendered mid-flight; writing to a
        // detached node is harmless, writing to a live one upgrades it.
        if (meta?.title) label.textContent = meta.title;
      });
    }
  }, [html]);

  if (inline) {
    return (
      <span
        ref={ref as React.Ref<HTMLSpanElement>}
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
