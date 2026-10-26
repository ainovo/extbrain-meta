import React, { useEffect, useState } from "react";
import {
  UrlMetadata,
  faviconForUrl,
  fetchUrlMetadata,
  hostOfUrl,
} from "../lib/urlPreview";

const PILL_CLASSES =
  "inline-flex items-center gap-1 rounded-full bg-tag px-2 py-0.5 text-[11px] font-medium text-mention hover:bg-divider transition min-w-0";
const INLINE_CLASSES =
  "inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-mention shadow-sm hover:bg-canvas transition min-w-0";

function hideImg(ev: React.SyntheticEvent<HTMLImageElement>) {
  (ev.target as HTMLImageElement).style.display = "none";
}

interface UrlChipProps {
  url: string;
  /** "pill" = source-section chip; "inline" = white pill inside message text. */
  variant?: "pill" | "inline";
  /** Tailwind max-w class capping the label width (e.g. "max-w-40"). */
  maxLabelWidth?: string;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * Compact external-link chip: favicon + page title (falls back to the host
 * until metadata resolves) instead of the raw URL. Hover sneak-peek cards
 * are provided globally by UrlPreviewLayer.
 */
export const UrlChip = React.memo(function UrlChip({
  url,
  variant = "pill",
  maxLabelWidth = "max-w-40",
  onClick,
}: UrlChipProps) {
  const [meta, setMeta] = useState<UrlMetadata | null>(null);

  useEffect(() => {
    let alive = true;
    fetchUrlMetadata(url).then((m) => {
      if (alive) setMeta(m);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const host = meta?.host || hostOfUrl(url) || url;
  const label = meta?.title || host;
  const favicon = meta?.favicon || faviconForUrl(url);

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={variant === "inline" ? INLINE_CLASSES : PILL_CLASSES}
    >
      {favicon && (
        <img
          src={favicon}
          alt=""
          className="w-3 h-3 rounded-sm shrink-0"
          onError={hideImg}
        />
      )}
      <span className={`truncate min-w-0 ${maxLabelWidth}`}>{label}</span>
    </a>
  );
});
