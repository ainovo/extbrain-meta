import React, { useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { ExtBrainLogo } from "./ExtBrainLogo";
import { SectionHeader } from "./ui";
import { ParsedActivityItem } from "../lib/types";
import {
  detectJsonSource,
  parseChatGptJson,
  parseObsidianMarkdownFile,
  parseTakeoutJson,
} from "../lib/takeoutParser";
import {
  ParsedBackup,
  RestoreResult,
  parseExportZip,
  restoreBackup,
} from "../lib/exportData";

export type SourceId = "chatgpt" | "gemini" | "aimode" | "obsidian";

interface SourceDef {
  id: SourceId;
  name: string;
  fileHint: string;
  accept: string;
}

const SOURCES: SourceDef[] = [
  { id: "chatgpt", name: "ChatGPT", fileHint: "conversations.json", accept: ".json" },
  { id: "gemini", name: "Gemini", fileHint: "Takeout MyActivity.json", accept: ".json" },
  { id: "aimode", name: "Google Search AI Mode", fileHint: "Takeout MyActivity.json", accept: ".json" },
  { id: "obsidian", name: "Obsidian", fileHint: ".md notes", accept: ".md" },
];

export function SourceLogo({ id }: { id: SourceId }) {
  if (id === "chatgpt") {
    return (
      <svg viewBox="0 0 24 24" className="w-6 h-6 text-ink" fill="currentColor" aria-label="ChatGPT">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    );
  }
  if (id === "gemini") {
    // Official Google Gemini icon (2025), commons.wikimedia.org/wiki/File:Google_Gemini_icon_2025.svg:
    // sparkle silhouette as an alpha mask over blurred color blobs + blue→purple gradient.
    return (
      <svg viewBox="0 0 65 65" className="w-6 h-6" aria-label="Gemini" fill="none" xmlns="http://www.w3.org/2000/svg">
        <mask id="gem-mask" style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x="0" y="0" width="65" height="65">
          <path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" fill="#000" />
          <path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" fill="url(#gem-grad)" />
        </mask>
        <g mask="url(#gem-mask)">
          <g filter="url(#gem-f0)"><path d="M-5.859 50.734c7.498 2.663 16.116-2.33 19.249-11.152 3.133-8.821-.406-18.131-7.904-20.794-7.498-2.663-16.116 2.33-19.25 11.151-3.132 8.822.407 18.132 7.905 20.795z" fill="#FFE432" /></g>
          <g filter="url(#gem-f1)"><path d="M27.433 21.649c10.3 0 18.651-8.535 18.651-19.062 0-10.528-8.35-19.062-18.651-19.062S8.78-7.94 8.78 2.587c0 10.527 8.35 19.062 18.652 19.062z" fill="#FC413D" /></g>
          <g filter="url(#gem-f2)"><path d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z" fill="#00B95C" /></g>
          <g filter="url(#gem-f3)"><path d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z" fill="#00B95C" /></g>
          <g filter="url(#gem-f4)"><path d="M30.954 74.181c9.014-5.485 11.427-17.976 5.389-27.9-6.038-9.925-18.241-13.524-27.256-8.04-9.015 5.486-11.428 17.977-5.39 27.902 6.04 9.924 18.242 13.523 27.257 8.038z" fill="#00B95C" /></g>
          <g filter="url(#gem-f5)"><path d="M67.391 42.993c10.132 0 18.346-7.91 18.346-17.666 0-9.757-8.214-17.667-18.346-17.667s-18.346 7.91-18.346 17.667c0 9.757 8.214 17.666 18.346 17.666z" fill="#3186FF" /></g>
          <g filter="url(#gem-f6)"><path d="M-13.065 40.944c9.33 7.094 22.959 4.869 30.442-4.972 7.483-9.84 5.987-23.569-3.343-30.663C4.704-1.786-8.924.439-16.408 10.28c-7.483 9.84-5.986 23.57 3.343 30.664z" fill="#FBBC04" /></g>
          <g filter="url(#gem-f7)"><path d="M34.74 51.43c11.135 7.656 25.896 5.524 32.968-4.764 7.073-10.287 3.779-24.832-7.357-32.488C49.215 6.52 34.455 8.654 27.382 18.94c-7.072 10.288-3.779 24.833 7.357 32.49z" fill="#3186FF" /></g>
          <g filter="url(#gem-f8)"><path d="M54.984-2.336c2.833 3.852-.808 11.34-8.131 16.727-7.324 5.387-15.557 6.631-18.39 2.78-2.833-3.853.807-11.342 8.13-16.728 7.324-5.387 15.558-6.631 18.39-2.78z" fill="#749BFF" /></g>
          <g filter="url(#gem-f9)"><path d="M31.727 16.104C43.053 5.598 46.94-8.626 40.41-15.666c-6.53-7.04-21.006-4.232-32.332 6.274s-15.214 24.73-8.683 31.77c6.53 7.04 21.006 4.232 32.332-6.274z" fill="#FC413D" /></g>
          <g filter="url(#gem-f10)"><path d="M8.51 53.838c6.732 4.818 14.46 5.55 17.262 1.636 2.802-3.915-.384-10.994-7.116-15.812-6.731-4.818-14.46-5.55-17.261-1.636-2.802 3.915.383 10.994 7.115 15.812z" fill="#FFEE48" /></g>
        </g>
        <defs>
          <filter id="gem-f0" x="-19.824" y="13.152" width="39.274" height="43.217" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="2.46" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f1" x="-15.001" y="-40.257" width="84.868" height="85.688" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="11.891" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f2" x="-20.776" y="11.927" width="79.454" height="90.916" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f3" x="-20.776" y="11.927" width="79.454" height="90.916" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f4" x="-19.845" y="15.459" width="79.731" height="81.505" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f5" x="29.832" y="-11.552" width="75.117" height="73.758" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="9.606" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f6" x="-38.583" y="-16.253" width="78.135" height="78.758" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="8.706" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f7" x="8.107" y="-5.966" width="78.877" height="77.539" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="7.775" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f8" x="13.587" y="-18.488" width="56.272" height="51.81" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="6.957" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f9" x="-15.526" y="-31.297" width="70.856" height="69.306" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="5.876" result="effect1_foregroundBlur_2001_67" /></filter>
          <filter id="gem-f10" x="-14.168" y="20.964" width="55.501" height="51.571" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="7.273" result="effect1_foregroundBlur_2001_67" /></filter>
          <linearGradient id="gem-grad" x1="18.447" y1="43.42" x2="52.153" y2="15.004" gradientUnits="userSpaceOnUse"><stop stopColor="#4893FC" /><stop offset="0.27" stopColor="#4893FC" /><stop offset="0.777" stopColor="#969DFF" /><stop offset="1" stopColor="#BD99FE" /></linearGradient>
        </defs>
      </svg>
    );
  }
  if (id === "aimode") {
    return (
      <svg viewBox="0 0 24 24" className="w-6 h-6">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.1a7.16 7.16 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6" fill="#7C3AED" aria-label="Obsidian">
      <path d="M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z" />
    </svg>
  );
}

interface FileJob {
  key: string;
  fileName: string;
  source: SourceDef;
  status: "queued" | "parsing" | "done" | "error";
  count?: number;
  range?: string;
  error?: string;
}

interface Props {
  onItemsLoaded: (newItems: ParsedActivityItem[], replace?: boolean) => void;
  uuid: string;
  onBackupRestored: (result: RestoreResult) => void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function dateRangeOf(items: ParsedActivityItem[]): string {
  const days = items
    .map((it) => it.timestamp.slice(0, 10))
    .filter(Boolean)
    .sort();
  if (days.length === 0) return "—";
  return days[0] === days[days.length - 1]
    ? days[0]
    : `${days[0]} → ${days[days.length - 1]}`;
}

function formatBackupDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const FileUploader: React.FC<Props> = ({
  onItemsLoaded,
  uuid,
  onBackupRestored,
}) => {
  const fileInputRefs = useRef<Record<SourceId, HTMLInputElement | null>>({
    chatgpt: null,
    gemini: null,
    aimode: null,
    obsidian: null,
  });
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [backupPreview, setBackupPreview] = useState<{
    fileName: string;
    backup: ParsedBackup;
  } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreStage, setRestoreStage] = useState<string | null>(null);
  const [restoredInfo, setRestoredInfo] = useState<{
    fileName: string;
    chats: number;
    summaries: number;
  } | null>(null);

  const parseForSource = (
    source: SourceDef,
    fileName: string,
    text: string,
    index: number
  ): ParsedActivityItem[] => {
    const lower = fileName.toLowerCase();
    if (source.id === "obsidian") {
      if (!lower.endsWith(".md")) {
        throw new Error(`Expected a .md file for Obsidian, got "${fileName}".`);
      }
      const item = parseObsidianMarkdownFile(text, fileName, index);
      if (!item) throw new Error("No readable chat found in this file.");
      return [item];
    }
    if (!lower.endsWith(".json")) {
      throw new Error(`Expected a .json file for ${source.name}, got "${fileName}".`);
    }
    if (source.id === "chatgpt") {
      const detected = detectJsonSource(text);
      if (detected !== "chatgpt") {
        throw new Error(
          `This doesn't look like a ChatGPT export (expected a top-level array of conversations or an object with a "conversations" array)${
            detected === "gemini" || detected === "aimode"
              ? " — try the " + (detected === "gemini" ? "Gemini" : "Google Search AI Mode") + " button instead."
              : "."
          }`
        );
      }
      return parseChatGptJson(text, fileName);
    }
    // gemini / aimode: Google Takeout MyActivity.json
    const detected = detectJsonSource(text);
    if (source.id === "gemini" && detected !== "gemini") {
      throw new Error(
        "No Gemini entries found in this file (expected Takeout data with Gemini products)."
      );
    }
    if (source.id === "aimode" && detected !== "aimode") {
      throw new Error(
        'No AI Mode entries found in this file (expected Takeout data with "Searched for" titles).'
      );
    }
    return parseTakeoutJson(text, fileName);
  };

  const runBatch = async (entries: Array<{ file: File; source: SourceDef }>) => {
    if (entries.length === 0 || isLoading) return;
    setIsLoading(true);
    const initialJobs: FileJob[] = entries.map((e, i) => ({
      key: `${Date.now()}-${i}`,
      fileName: e.file.name,
      source: e.source,
      status: "queued",
    }));
    setJobs(initialJobs);

    const parsedAll: ParsedActivityItem[] = [];

    for (let i = 0; i < entries.length; i++) {
      const { file, source } = entries[i];
      setJobs((prev) =>
        prev.map((j, jIdx) => (jIdx === i ? { ...j, status: "parsing" } : j))
      );
      await tick();
      try {
        const text = await file.text();
        const parsed = parseForSource(source, file.name, text, i);
        parsedAll.push(...parsed);
        const range = dateRangeOf(parsed);
        setJobs((prev) =>
          prev.map((j, jIdx) =>
            jIdx === i
              ? { ...j, status: "done", count: parsed.length, range }
              : j
          )
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setJobs((prev) =>
          prev.map((j, jIdx) =>
            jIdx === i ? { ...j, status: "error", error: msg } : j
          )
        );
      }
      await tick();
    }

    if (parsedAll.length > 0) {
      onItemsLoaded(parsedAll, false);
    }
    setIsLoading(false);
  };

  const handleSourceFiles = (source: SourceDef, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    runBatch(Array.from(fileList).map((file) => ({ file, source })));
  };

  const handleBackupFile = async (file: File) => {
    if (isLoading) return;
    setIsLoading(true);
    setBackupPreview(null);
    setBackupError(null);
    setRestoreStage(null);
    setRestoredInfo(null);
    try {
      const backup = await parseExportZip(file);
      setBackupPreview({ fileName: file.name, backup });
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!backupPreview || isLoading) return;
    setIsLoading(true);
    setBackupError(null);
    setRestoreStage("Reading backup…");
    await tick();
    try {
      const result = await restoreBackup(
        uuid,
        backupPreview.backup,
        (stage) => setRestoreStage(stage)
      );
      setRestoreStage("Loading chats…");
      await tick();
      onBackupRestored(result);
      setRestoredInfo({
        fileName: backupPreview.fileName,
        chats: result.items.length,
        summaries: backupPreview.backup.summaries.length,
      });
      setBackupPreview(null);
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
      setRestoreStage(null);
    } finally {
      setIsLoading(false);
    }
  };

  const doneCount = jobs.filter((j) => j.status === "done" || j.status === "error").length;
  const progressPct = jobs.length === 0 ? 0 : Math.round((doneCount / jobs.length) * 100);

  return (
    <section aria-label="Import chats" className="space-y-4">
      <SectionHeader
        title="Import chats"
        sub="Pick a source below. Files are validated before loading and stay in your browser."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SOURCES.map((source) => (
          <div key={source.id}>
            <input
              ref={(el) => {
                fileInputRefs.current[source.id] = el;
              }}
              type="file"
              multiple
              accept={source.accept}
              onChange={(e) => {
                handleSourceFiles(source, e.target.files);
                e.target.value = "";
              }}
              className="hidden"
            />
            <button
              type="button"
              disabled={isLoading}
              onClick={() => fileInputRefs.current[source.id]?.click()}
              className="w-full flex items-center gap-3 rounded-xl border border-divider bg-canvas px-4 py-3.5 text-left hover:border-mention hover:bg-tag transition disabled:opacity-40"
            >
              <span className="shrink-0 flex h-10 w-10 items-center justify-center rounded-xl bg-tag">
                <SourceLogo id={source.id} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-ink leading-tight">
                  {source.name}
                </span>
                <span className="block text-[11px] text-mention/60 leading-tight truncate">
                  {source.fileHint}
                </span>
              </span>
            </button>
          </div>
        ))}
        <div>
          <input
            ref={backupInputRef}
            type="file"
            accept=".zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleBackupFile(file);
            }}
            className="hidden"
          />
          <button
            type="button"
            disabled={isLoading}
            onClick={() => backupInputRef.current?.click()}
            className="w-full flex items-center gap-3 rounded-xl border border-divider bg-canvas px-4 py-3.5 text-left hover:border-mention hover:bg-tag transition disabled:opacity-40"
          >
            <span className="shrink-0 flex h-10 w-10 items-center justify-center rounded-xl bg-tag">
              <ExtBrainLogo className="w-6 h-6 text-action" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink leading-tight">
                ExtBrain Backup
              </span>
              <span className="block text-[11px] text-mention/60 leading-tight truncate">
                extbrain_userid.zip
              </span>
            </span>
          </button>
        </div>
      </div>

      {backupError && (
        <div className="flex items-center gap-2 text-[13px]">
          <XCircle className="w-4 h-4 text-ink shrink-0" />
          <span className="text-ink truncate">{backupError}</span>
        </div>
      )}

      {backupPreview && (
        <div className="rounded-xl border border-divider bg-canvas px-4 py-3.5">
          <div className="text-[13px] font-semibold text-ink truncate">
            {backupPreview.fileName}
          </div>
          <div className="text-[11px] text-mention/60 mt-0.5">
            Exported {formatBackupDate(backupPreview.backup.manifest.exportedAt)}
            {backupPreview.backup.manifest.userid &&
              backupPreview.backup.manifest.userid !== uuid &&
              ` · from another user (${backupPreview.backup.manifest.userid})`}
          </div>
          <div className="text-[13px] text-mention mt-2 font-mono">
            {backupPreview.backup.histories.length} chats ·{" "}
            {backupPreview.backup.summaries.length} summaries ·{" "}
            {backupPreview.backup.tags.length} tags ·{" "}
            {Object.keys(backupPreview.backup.entities).length} entity chats ·{" "}
            {backupPreview.backup.templates.length} templates
          </div>
          <p className="text-[11px] text-mention/60 mt-1">
            Restoring replaces everything currently stored in this browser.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void handleRestore()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
            >
              {isLoading && restoreStage ? restoreStage : "Restore backup"}
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => setBackupPreview(null)}
              className="px-3 py-1.5 text-xs text-mention hover:text-ink underline disabled:opacity-40 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {restoredInfo && (
        <div className="flex items-center gap-2 text-[13px]">
          <CheckCircle2 className="w-4 h-4 text-ink shrink-0" />
          <span className="text-ink">
            Restored {restoredInfo.chats} chats and {restoredInfo.summaries}{" "}
            summaries from {restoredInfo.fileName}.
          </span>
        </div>
      )}

      {jobs.length > 0 && (
        <div>
          <div className="flex items-center justify-between text-[11px] text-mention mb-1.5">
            <span>
              Loading {doneCount}/{jobs.length} files{isLoading ? "…" : ""}
            </span>
            <span className="font-mono">{progressPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-tag/70 overflow-hidden">
            <div
              className="h-full bg-action rounded-full transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="mt-2 space-y-1.5">
            {jobs.map((job) => (
              <div key={job.key} className="flex items-center gap-2 text-[13px]">
                {job.status === "done" ? (
                  <CheckCircle2 className="w-4 h-4 text-ink shrink-0" />
                ) : job.status === "error" ? (
                  <XCircle className="w-4 h-4 text-ink shrink-0" />
                ) : (
                  <Loader2 className="w-4 h-4 text-mention/60 shrink-0 animate-spin" />
                )}
                <span className="text-ink truncate font-medium">{job.fileName}</span>
                <span className="text-mention/60 text-[11px] shrink-0">{job.source.name}</span>
                {job.status === "done" && (
                  <span className="text-mention text-[11px] ml-auto shrink-0 font-mono">
                    {job.count} chats • {job.range}
                  </span>
                )}
                {job.status === "error" && (
                  <span className="text-ink text-[11px] ml-auto shrink-0 truncate max-w-[60%]">
                    {job.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
