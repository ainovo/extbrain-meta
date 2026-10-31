/**
 * Aggregation for Modal processing jobs that arrive in many chunks.
 *
 * A client run (one NER + NLI pass) sends each batch with the same `jobId`;
 * the server measures every chunk and this aggregator sums the durations so
 * the job logs exactly ONE metering row when it completes (`isLast` chunk)
 * — or a single partial row if the job goes quiet and the sweeper expires
 * it (aborted runs still spent Modal compute).
 */

export interface ModalJobChunk {
  userId: string;
  kind: string;
  model: string;
  durationMs: number;
}

export interface ModalJobTotal extends ModalJobChunk {
  jobId: string;
  chunks: number;
  totalMs: number;
}

interface JobState {
  userId: string;
  kind: string;
  model: string;
  totalMs: number;
  chunks: number;
  lastSeen: number;
}

export class ModalJobAggregator {
  private jobs = new Map<string, JobState>();

  constructor(
    private now: () => number = Date.now,
    private ttlMs: number = 30 * 60 * 1000,
    private maxJobs: number = 1000
  ) {}

  /** Add one measured chunk. Later chunks for the same jobId accumulate. */
  addChunk(jobId: string, chunk: ModalJobChunk): void {
    if (!jobId) return;
    const t = this.now();
    const prev = this.jobs.get(jobId);
    if (prev) {
      prev.totalMs += Math.max(0, chunk.durationMs);
      prev.chunks += 1;
      prev.lastSeen = t;
      return;
    }
    if (this.jobs.size >= this.maxJobs) this.sweepExpired();
    this.jobs.set(jobId, {
      userId: chunk.userId,
      kind: chunk.kind,
      model: chunk.model,
      totalMs: Math.max(0, chunk.durationMs),
      chunks: 1,
      lastSeen: t,
    });
  }

  /**
   * Finalize a job: returns the single aggregate row to log (or null when
   * the jobId is unknown, e.g. already finalized). Always deletes the job.
   */
  completeJob(jobId: string): ModalJobTotal | null {
    const state = this.jobs.get(jobId);
    this.jobs.delete(jobId);
    if (!state) return null;
    return {
      jobId,
      userId: state.userId,
      kind: state.kind,
      model: state.model,
      durationMs: state.totalMs,
      totalMs: state.totalMs,
      chunks: state.chunks,
    };
  }

  /**
   * Expire jobs idle past the TTL (aborted runs that never sent `isLast`).
   * Returns one aggregate row per expired job so partial spend is still
   * logged exactly once.
   */
  sweepExpired(): ModalJobTotal[] {
    const t = this.now();
    const expired: ModalJobTotal[] = [];
    for (const [jobId, state] of this.jobs) {
      if (t - state.lastSeen >= this.ttlMs) {
        expired.push({
          jobId,
          userId: state.userId,
          kind: state.kind,
          model: state.model,
          durationMs: state.totalMs,
          totalMs: state.totalMs,
          chunks: state.chunks,
        });
        this.jobs.delete(jobId);
      }
    }
    return expired;
  }

  /** For tests: how many open jobs are held. */
  get size(): number {
    return this.jobs.size;
  }
}
