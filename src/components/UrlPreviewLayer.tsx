import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  UrlMetadata,
  faviconForUrl,
  fetchUrlMetadata,
  hostOfUrl,
  isHttpUrl,
} from "../lib/urlPreview";

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 120;
const CARD_WIDTH = 340;
const CARD_EST_HEIGHT = 220;

interface AnchorPreviewState {
  url: string;
  rect: DOMRect;
}

function hideImg(ev: React.SyntheticEvent<HTMLImageElement>) {
  (ev.target as HTMLImageElement).style.display = "none";
}

/** The sneak-peek card: favicon, title, description (+ host and URL). */
function UrlPreviewCard({ url, rect }: AnchorPreviewState) {
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
  const title = meta?.title || host;
  const favicon = meta?.favicon || faviconForUrl(url);

  const vw = typeof window !== "undefined" ? window.innerWidth : CARD_WIDTH + 16;
  const vh =
    typeof window !== "undefined" ? window.innerHeight : CARD_EST_HEIGHT + 16;
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, vw - CARD_WIDTH - 8)
  );
  let top = rect.bottom + 8;
  if (top + CARD_EST_HEIGHT > vh) {
    top = Math.max(8, rect.top - CARD_EST_HEIGHT - 8);
  }

  return createPortal(
    <div
      style={{ position: "fixed", top, left, width: CARD_WIDTH }}
      className="pointer-events-none z-50 rounded-xl border border-divider bg-canvas shadow-xl p-3"
    >
      <div className="flex items-start gap-2.5">
        {favicon && (
          <img
            src={favicon}
            alt=""
            onError={hideImg}
            className="w-7 h-7 rounded-md shrink-0 mt-px bg-tag"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink leading-snug line-clamp-2">
            {title}
          </div>
          <div className="text-[11px] text-mention/60 truncate mt-0.5">
            {host}
          </div>
        </div>
      </div>
      {meta?.description && (
        <p className="text-[12px] text-mention leading-relaxed line-clamp-3 mt-2">
          {meta.description}
        </p>
      )}
      <div className="text-[10px] font-mono text-mention/60 truncate mt-2 border-t border-divider pt-1.5">
        {url}
      </div>
    </div>,
    document.body
  );
}

/**
 * Global hover layer: hovering any external http(s) link anywhere in the app
 * (message chips, source-section chips, markdown links) shows a sneak-peek
 * card after a short delay. An anchor can opt out with data-no-preview.
 */
export const UrlPreviewLayer: React.FC = () => {
  const [preview, setPreview] = useState<AnchorPreviewState | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const openUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (openTimerRef.current !== null) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };

    const openFor = (anchor: HTMLAnchorElement) => {
      const url = anchor.getAttribute("href") || "";
      if (!isHttpUrl(url)) return;
      if (anchor.getAttribute("data-no-preview") !== null) return;
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      // Already showing this URL (or about to): don't restart the timer.
      if (openTimerRef.current !== null || openUrlRef.current === url) return;
      anchorRef.current = anchor;
      openTimerRef.current = window.setTimeout(() => {
        const a = anchorRef.current;
        openTimerRef.current = null;
        if (!a || !a.isConnected) return;
        openUrlRef.current = url;
        setPreview({ url, rect: a.getBoundingClientRect() });
      }, OPEN_DELAY_MS);
    };

    const closeFor = (
      anchor: HTMLAnchorElement,
      relatedTarget: Node | null
    ) => {
      // Moving between the anchor's own children must not close the card.
      if (relatedTarget && anchor.contains(relatedTarget)) return;
      if (openTimerRef.current !== null) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        openUrlRef.current = null;
        anchorRef.current = null;
        setPreview(null);
      }, CLOSE_DELAY_MS);
    };

    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (anchor) openFor(anchor);
    };
    const onOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (anchor) closeFor(anchor, e.relatedTarget as Node | null);
    };
    const onDismiss = () => {
      clearTimers();
      openUrlRef.current = null;
      anchorRef.current = null;
      setPreview(null);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
      clearTimers();
    };
  }, []);

  if (!preview) return null;
  return <UrlPreviewCard url={preview.url} rect={preview.rect} />;
};
