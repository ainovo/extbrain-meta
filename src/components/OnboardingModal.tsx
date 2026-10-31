import React, { useEffect, useState } from "react";
import { SourceLogo, type SourceId } from "./FileUploader";
import { ExtBrainLogo } from "./ExtBrainLogo";
import { apiGet } from "../lib/api";

interface OnboardingSource {
  id: SourceId;
  name: string;
  fileHint: string;
  instructions: string;
  downloadUrl: string | null;
  downloadLabel: string | null;
}

const ONBOARDING_SOURCES: OnboardingSource[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    fileHint: "conversations.json",
    instructions:
      "In ChatGPT go to Settings → Data controls → Export data, then unzip the export and keep conversations.json.",
    downloadUrl:
      "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
    downloadLabel: "How to export ChatGPT history",
  },
  {
    id: "claude",
    name: "Claude",
    fileHint: "conversations.json",
    instructions:
      "In Claude go to Settings → Privacy → Export data. Newer exports arrive as a manifest.json listing ZIP parts — download the conversations-*.zip parts, unzip, and import each conversations.json.",
    downloadUrl:
      "https://support.claude.com/en/articles/9450526-export-your-claude-data",
    downloadLabel: "How to export Claude data",
  },
  {
    id: "gemini",
    name: "Gemini",
    fileHint: "Takeout MyActivity.json",
    instructions:
      "Open Google Takeout, select Gemini activity only, export, then unzip and keep the My Activity JSON file.",
    downloadUrl: "https://takeout.google.com",
    downloadLabel: "takeout.google.com",
  },
  {
    id: "aimode",
    name: "Google Search AI Mode",
    fileHint: "Takeout MyActivity.json",
    instructions:
      "Open Google Takeout, select Search (My Activity), export, then unzip and keep the My Activity JSON file.",
    downloadUrl: "https://takeout.google.com",
    downloadLabel: "takeout.google.com",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    fileHint: ".md notes",
    instructions:
      "No export needed — pick any saved chat note (.md) straight from your vault.",
    downloadUrl: "https://obsidian.md",
    downloadLabel: "obsidian.md",
  },
];

interface Props {
  onContinue: () => void;
  onViewTerms: () => void;
}

export const OnboardingModal: React.FC<Props> = ({ onContinue, onViewTerms }) => {
  const [downloaded, setDownloaded] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [remainingPct, setRemainingPct] = useState<number | null>(null);
  const canContinue = downloaded && agreed;

  // Free-tier meter: percent of the $200 pool left (1 - sum(cost)/budget).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiGet("/api/usage");
        if (!resp.ok) return;
        const data = (await resp.json()) as { remainingPct?: unknown };
        if (!cancelled && typeof data.remainingPct === "number") {
          setRemainingPct(Math.max(0, Math.min(100, Math.round(data.remainingPct))));
        }
      } catch {
        /* offline or unreachable — banner simply shows no number */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to ExtBrain"
      className="fixed inset-0 z-50 overflow-y-auto bg-ink/45 backdrop-blur-[2px]"
    >
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="w-full max-w-xl rounded-2xl border border-divider bg-canvas shadow-xl">
          <div className="px-5 sm:px-7 pt-6 pb-5">
            <div className="rounded-xl bg-tag/60 px-4 py-3 mb-5">
              <p className="text-[13px] text-ink leading-snug">
                Free for a limited time
                {remainingPct !== null && (
                  <>
                    {" "}·{" "}
                    <strong className="font-semibold">{remainingPct}%</strong>{" "}
                    free usage left
                  </>
                )}
                .
              </p>
              {remainingPct !== null && (
                <div
                  className="mt-2 h-1.5 rounded-full bg-divider/50 overflow-hidden"
                  role="progressbar"
                  aria-valuenow={remainingPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Remaining free usage"
                >
                  <div
                    className="h-full bg-action rounded-full transition-all"
                    style={{ width: `${remainingPct}%` }}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-tag shrink-0">
                <ExtBrainLogo className="w-6 h-6 text-action" />
              </span>
              <div>
                <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink leading-tight">
                  Welcome to ExtBrain
                </h2>
                <p className="text-[13px] text-mention mt-0.5">
                  Start by downloading your chat history, then load it here.
                </p>
              </div>
            </div>

            <ol className="mt-5 space-y-3">
              {ONBOARDING_SOURCES.map((source) => (
                <li
                  key={source.id}
                  className="flex gap-3 rounded-xl border border-divider bg-canvas px-4 py-3"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tag">
                    <SourceLogo id={source.id} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink leading-tight">
                      {source.name}
                      <span className="ml-2 font-normal text-[11px] text-mention/70 font-mono">
                        {source.fileHint}
                      </span>
                    </span>
                    <span className="block text-[12px] text-mention leading-snug mt-1">
                      {source.instructions}{" "}
                      {source.downloadUrl && (
                        <a
                          href={source.downloadUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-action hover:text-action-hover underline underline-offset-2"
                        >
                          {source.downloadLabel ?? source.downloadUrl}
                        </a>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-5 space-y-2.5 rounded-xl bg-tag/60 px-4 py-3.5">
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink leading-snug">
                <input
                  type="checkbox"
                  checked={downloaded}
                  onChange={(e) => setDownloaded(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0064E0]"
                />
                <span>
                  I have downloaded my chat history from one of the sources above.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink leading-snug">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0064E0]"
                />
                <span>
                  I have read the{" "}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onViewTerms();
                    }}
                    className="text-action hover:text-action-hover underline underline-offset-2"
                  >
                    terms
                  </button>{" "}
                  and agree that my chat histories and voice prompts may be
                  used by Meta to improve their products when I use the voice
                  agent and summary functions.
                </span>
              </label>
            </div>

            <button
              type="button"
              disabled={!canContinue}
              onClick={onContinue}
              className="mt-4 w-full rounded-xl bg-action px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue to import chats
            </button>
            {!canContinue && (
              <p className="mt-2 text-center text-[11px] text-mention/70">
                Check both boxes above to continue.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
