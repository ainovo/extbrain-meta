import { ModelEndpointConfig, ParsedActivityItem } from "./types";
import { packItemsIntoBatches } from "./retrievalEngine";

export interface SynthesisStreamOptions {
  items: ParsedActivityItem[];
  templateName: string;
  systemInstruction: string;
  modelConfig: ModelEndpointConfig;
  maxTokensPerBatch: number;
  signal: AbortSignal;
  onDelta: (accumulated: string) => void;
  onProgress: (note: string) => void;
}

/**
 * Streams one summary over packed chat batches, resolving the accumulated
 * markdown. Shared by thread summaries and day retrospectives; throws on
 * HTTP/SSE errors and on abort (callers tell AbortError apart).
 */
export async function streamSynthesis({
  items,
  templateName,
  systemInstruction,
  modelConfig,
  maxTokensPerBatch,
  signal,
  onDelta,
  onProgress,
}: SynthesisStreamOptions): Promise<string> {
  const { batches } = packItemsIntoBatches(items, maxTokensPerBatch);
  const resp = await fetch("/api/synthesize-thread-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectQuery: templateName,
      batches,
      systemInstruction,
      modelConfig,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(
      (errData as { error?: string }).error || `HTTP ${resp.status}`
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (typeof evt.delta === "string" && evt.delta) {
          acc += evt.delta;
          onDelta(acc);
        } else if (typeof evt.progress === "string") {
          onProgress(evt.progress);
        } else if (typeof evt.error === "string" && evt.error) {
          throw new Error(evt.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) {
          throw e;
        }
        // ignore partial JSON frames
      }
    }
  }
  // Flush trailing buffered event.
  const tail = buf.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const evt = JSON.parse(payload);
        if (typeof evt.delta === "string" && evt.delta) {
          acc += evt.delta;
          onDelta(acc);
        } else if (typeof evt.error === "string" && evt.error) {
          throw new Error(evt.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }
  return acc;
}
