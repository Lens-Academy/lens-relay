import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleImportMode, ArticleJob } from "./types";
import { extractVideoInput } from "../add-video/video-url";
import { VIDEO_JOB_TIMEOUT_MS } from "../add-video/pipeline";
import { evictFinishedJobs, FINISHED_JOB_TTL_MS } from "../queue-utils";
import { DuplicateDocumentError } from "./duplicate";
import { editorOpenUrl } from "../add-video/relay-docs";
import {
  createArticleReviewReporter,
  createMemoryArticleReviewReporter,
  type ArticleReviewReporter,
} from "./review-report";

// Hard ceiling on a single import job. Individual stages carry their own
// timeouts (fetch 30s, render 60s, Claude QC 7min, relay calls 30–60s), but a
// stage that misbehaves — or a gap between stages — must never strand a job in
// "processing" forever (three did, for 2h+, in production). The race below
// settles the job even if the underlying promise never does.
const DEFAULT_JOB_TIMEOUT_MS = 25 * 60_000;

function jobTimeoutMs(job: ArticleJob): number {
  // YouTube-video jobs run Claude over a whole transcript and legitimately
  // outlive the article deadline. Uses the classification stored at enqueue.
  if (job.video) return VIDEO_JOB_TIMEOUT_MS;
  const v = Number(process.env.ARTICLE_JOB_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_JOB_TIMEOUT_MS;
}

/** How many imports run at once: ARTICLE_IMPORT_WORKERS, default 3 (the
 *  Claude session pool's size; more workers than pool slots only makes jobs
 *  wait for a slot inside their deadline, so raise both together). */
export function articleImportWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.ARTICLE_IMPORT_WORKERS);
  return Number.isInteger(v) && v > 0 ? v : 3;
}

/** ETA basis until a job has finished on this server. */
const DEFAULT_JOB_MINUTES = 8;
/** Recent job durations kept for the ETA. */
const DURATION_SAMPLE = 20;
const CANCELLED = "Cancelled by user";
/** A job running during this many restarts in a row is failed, not requeued:
 *  it may be what crashes the editor, and it would block the queue. */
const MAX_RESTART_REQUEUES = 2;

interface QueueOptions {
  processJob: (job: ArticleJob, signal: AbortSignal, reporter: ArticleReviewReporter) => Promise<void>;
  reporterFactory?: (job: ArticleJob) => Promise<ArticleReviewReporter>;
  /** Imports run at once. Default: articleImportWorkers(). */
  workers?: number;
  /** JSON file the queue is saved to and restored from, so a restart or a
   *  deploy loses nothing. Default: ARTICLE_IMPORT_QUEUE_FILE; null = memory only. */
  stateFile?: string | null;
}

/** A job as the status API shows it: where it stands in the queue. */
export type ArticleJobView = ArticleJob & {
  /** 1 = next to start. Queued jobs only. */
  queue_position?: number;
  /** Rough minutes until it finishes (queued and processing jobs). */
  eta_minutes?: number;
};

export interface ArticleQueueSummary {
  workers: number;
  processing: number;
  queued: number;
  /** Mean of recent job durations (or the default before any finished). */
  avg_job_minutes: number;
  /** Rough minutes until every queued job is through. */
  estimated_minutes_to_empty: number;
  /** Written for agents: what the numbers mean and how to wait. */
  message: string;
  /** Articles written without a completed review, still in the job list. */
  unreviewed: Array<{ id: string; url: string; relay_path?: string; reason?: string }>;
  /** Set when the queue could not be saved; it then lives in memory only. */
  persistence_error?: string;
}

interface QueueSnapshot {
  version: 1;
  saved_at: string;
  pending: string[];
  jobs: ArticleJob[];
  durations_ms: number[];
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Job queue for article imports. Every submission waits its turn here and at
 * most `workers` run at once, so a batch of 70 is worked through steadily
 * instead of starting 70 jobs that race for three Claude slots and time out.
 * A job's deadline runs from when a worker picks it up, never while queued.
 *
 * Unlike the add-video queue, the relay path (and thus relay_url) is unknown
 * at enqueue time: it derives from the article title, which we only learn
 * after extraction. The pipeline fills job.relay_url and job.title.
 */
export class ArticleJobQueue {
  private jobs: Map<string, ArticleJob> = new Map();
  private pending: string[] = [];
  private controllers: Map<string, AbortController> = new Map();
  private running = 0;
  /** Jobs whose import succeeded and that are only closing their report. */
  private finishing = new Set<string>();
  private durationsMs: number[] = [];
  private persistenceError: string | undefined;
  private processJob: QueueOptions["processJob"];
  private reporterFactory: NonNullable<QueueOptions["reporterFactory"]>;
  readonly workers: number;
  private stateFile: string | null;

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
    this.reporterFactory = options.reporterFactory ?? (process.env.NODE_ENV === "test"
      ? async (job) => createMemoryArticleReviewReporter(job)
      : createArticleReviewReporter);
    this.workers = options.workers ?? articleImportWorkers();
    // Tests never touch a real queue file, even with the variable exported.
    this.stateFile = options.stateFile !== undefined
      ? options.stateFile
      : process.env.NODE_ENV === "test" ? null : process.env.ARTICLE_IMPORT_QUEUE_FILE || null;
    if (this.stateFile) {
      this.restore();
      if (this.pending.length > 0) void Promise.resolve().then(() => this.drain());
    }
  }

  add(
    url: string,
    importMode: ArticleImportMode,
    retryOf?: string,
    options: { replaceExisting?: boolean } = {},
  ): ArticleJob {
    evictFinishedJobs(this.jobs, FINISHED_JOB_TTL_MS);
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: ArticleJob = {
      id,
      url,
      status: "queued",
      importMode,
      // Classify once here — every later consumer (deadline choice, pipeline
      // dispatch) reads job.video instead of re-parsing the URL.
      video: extractVideoInput(url) ?? undefined,
      report_persistence: "pending",
      retry_of: retryOf,
      ...(options.replaceExisting ? { replaceExisting: true } : {}),
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    this.persist();
    // Defer drain to the next microtask so callers always receive the job
    // with 'queued' status before any processing begins.
    void Promise.resolve().then(() => this.drain());
    return job;
  }

  get(id: string): ArticleJob | undefined {
    return this.jobs.get(id);
  }

  /** An unfinished job for this URL, if any — used to reject double submits.
   *  Matching is by normalized URL when a normalizer is provided by the caller. */
  findActive(
    url: string,
    normalize: (u: string) => string = (u) => u,
  ): ArticleJob | undefined {
    const key = normalize(url);
    for (const job of this.jobs.values()) {
      if (
        normalize(job.url) === key &&
        (job.status === "queued" || job.status === "processing")
      ) {
        return job;
      }
    }
    return undefined;
  }

  status(): ArticleJob[] {
    // The list now outlives deploys, so it is pruned on reads too.
    evictFinishedJobs(this.jobs, FINISHED_JOB_TTL_MS);
    return Array.from(this.jobs.values());
  }

  private avgJobMinutes(): number {
    if (this.durationsMs.length === 0) return DEFAULT_JOB_MINUTES;
    const mean = this.durationsMs.reduce((a, b) => a + b, 0) / this.durationsMs.length;
    return Math.max(1, Math.round(mean / 60_000));
  }

  /** Workers the (deferred) drain will fill without waiting for a job. */
  private freeWorkers(): number {
    return Math.max(0, this.workers - this.running);
  }

  /** The job with its queue position and a rough ETA. Position 0 = starting
   *  now (a worker is free; drain runs on the next tick), 1 = next to start. */
  view(job: ArticleJob): ArticleJobView {
    const avg = this.avgJobMinutes();
    if (job.status === "queued") {
      const index = this.pending.indexOf(job.id);
      if (index !== -1) {
        const position = Math.max(0, index + 1 - this.freeWorkers());
        return {
          ...job,
          queue_position: position,
          eta_minutes: (Math.ceil(position / this.workers) + 1) * avg,
        };
      }
    }
    if (job.status === "processing") {
      const elapsed = job.started_at ? (Date.now() - Date.parse(job.started_at)) / 60_000 : 0;
      return { ...job, eta_minutes: Math.max(1, Math.round(avg - elapsed)) };
    }
    return { ...job };
  }

  summary(): ArticleQueueSummary {
    const avg = this.avgJobMinutes();
    // Jobs a free worker is about to start count as importing, not waiting.
    const starting = Math.min(this.pending.length, this.freeWorkers());
    const queued = this.pending.length - starting;
    const processing = this.running + starting;
    const toEmpty = queued + processing === 0
      ? 0
      : (Math.ceil(queued / this.workers) + (processing > 0 ? 1 : 0)) * avg;
    const message = queued + processing === 0
      ? "The import queue is empty."
      : `${processing} importing now, ${queued} waiting in the queue. ` +
        `Imports run ${this.workers} at a time and take about ${avg} min each, ` +
        `so the queue should be through in about ${formatMinutes(toEmpty)}. ` +
        "Queued jobs do not time out or fail for waiting; they start in order. " +
        "Poll import_status every few minutes; import_cancel removes a job.";
    const unreviewed = this.status()
      .filter((job) => job.status === "done" && job.review_status === "unreviewed")
      .map((job) => ({ id: job.id, url: job.url, relay_path: job.relay_path, reason: job.review_note }));
    return {
      workers: this.workers,
      processing,
      queued,
      avg_job_minutes: avg,
      estimated_minutes_to_empty: toEmpty,
      message,
      unreviewed,
      ...(this.persistenceError ? { persistence_error: this.persistenceError } : {}),
    };
  }

  /**
   * Cancel a queued or processing job: a queued job leaves the queue at once,
   * a running one is aborted (in-flight fetches reject; the deadline race
   * settles it). Either ends "cancelled". False when the job doesn't exist
   * or is already finished.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "queued" && job.status !== "processing")) {
      return false;
    }
    if (this.finishing.has(id)) return false;
    const pendingIdx = this.pending.indexOf(id);
    if (pendingIdx !== -1) this.pending.splice(pendingIdx, 1);
    // Saved before the abort settles, so a restart in between does not
    // requeue a job that was cancelled while running.
    job.cancel_requested = true;
    this.controllers.get(id)?.abort(new Error(CANCELLED));
    // A queued job has no controller yet — settle it directly.
    if (job.status === "queued") {
      job.status = "cancelled";
      job.error = CANCELLED;
      job.stage = undefined;
      job.updated_at = new Date().toISOString();
      void this.reporterFactory(job).then(async (reporter) => {
        job.report_id = reporter.id;
        await reporter.finish("failed", { error: job.error });
        job.report_summary = reporter.summary();
        job.report_persistence = reporter.persistent ? "persisted" : "pending";
      }).catch((error) => {
        job.report_persistence = "failed";
        job.error = `${job.error}; report persistence failed: ${error}`;
      });
    }
    this.persist();
    return true;
  }

  private drain(): void {
    while (this.running < this.workers && this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      const now = new Date().toISOString();
      job.status = "processing";
      job.started_at = now;
      job.updated_at = now;
      this.running++;
      void this.runJob(job).finally(() => {
        this.running--;
        // Only completed imports: a fetch that fails in 2 s says nothing
        // about how long the next real import takes.
        if (job.started_at && job.status === "done") {
          this.durationsMs.push(Date.now() - Date.parse(job.started_at));
          if (this.durationsMs.length > DURATION_SAMPLE) this.durationsMs.shift();
        }
        this.persist();
        this.drain();
      });
    }
    this.persist();
  }

  /** Save the queue atomically (temp file + rename). A failure is logged and
   *  shown in summary(); imports carry on in memory. */
  private persist(): void {
    if (!this.stateFile) return;
    const snapshot: QueueSnapshot = {
      version: 1,
      saved_at: new Date().toISOString(),
      pending: [...this.pending],
      jobs: this.status(),
      durations_ms: [...this.durationsMs],
    };
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, this.stateFile);
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceError = `Could not save the import queue to ${this.stateFile}: ${error}`;
      console.error(`[add-article] ${this.persistenceError}`);
    }
  }

  /** Load a saved queue. Jobs that were running when the editor stopped go
   *  back to the front of the queue (a finished write is caught by the
   *  duplicate check); queued ones keep their order. */
  private restore(): void {
    const file = this.stateFile!;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.persistenceError = `Could not read the saved import queue ${file}: ${error}`;
        console.error(`[add-article] ${this.persistenceError}`);
      }
      return;
    }
    let snapshot: QueueSnapshot;
    try {
      snapshot = JSON.parse(raw) as QueueSnapshot;
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.pending)) {
        throw new Error("not a version-1 queue snapshot");
      }
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* keep going */ }
      this.persistenceError = `The saved import queue was unreadable (${error}); moved it to ${aside} and started empty`;
      console.error(`[add-article] ${this.persistenceError}`);
      return;
    }
    const interrupted: ArticleJob[] = [];
    for (const job of snapshot.jobs) {
      if (
        !job || typeof job.id !== "string" || typeof job.url !== "string" ||
        typeof job.created_at !== "string" || typeof job.updated_at !== "string"
      ) continue;
      if (job.status === "processing" && job.cancel_requested) {
        // Cancelled while running; the restart came before it settled.
        job.status = "cancelled";
        job.error = CANCELLED;
        job.stage = undefined;
      } else if (job.status === "processing" && (job.restart_requeues ?? 0) >= MAX_RESTART_REQUEUES) {
        job.status = "failed";
        job.error = `The editor restarted while this import ran, ${MAX_RESTART_REQUEUES + 1} times in a row; ` +
          "not retried automatically (it may be what crashes the editor). Retry it once the queue is through.";
        job.stage = undefined;
        console.error(`[add-article] job=${job.id} ${job.error}`);
      } else if (job.status === "processing") {
        job.status = "queued";
        job.stage = undefined;
        job.started_at = undefined;
        job.requeued_after_restart = true;
        job.restart_requeues = (job.restart_requeues ?? 0) + 1;
        job.updated_at = new Date().toISOString();
        interrupted.push(job);
      }
      this.jobs.set(job.id, job);
    }
    interrupted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const queued = snapshot.pending.filter((id) => this.jobs.get(id)?.status === "queued");
    this.pending = [...interrupted.map((j) => j.id), ...queued.filter((id) => !interrupted.some((j) => j.id === id))];
    // Queued jobs missing from `pending` (should not happen) still get a turn.
    for (const job of this.jobs.values()) {
      if (job.status === "queued" && !this.pending.includes(job.id)) this.pending.push(job.id);
    }
    this.durationsMs = Array.isArray(snapshot.durations_ms)
      ? snapshot.durations_ms.filter((n) => typeof n === "number" && n > 0).slice(-DURATION_SAMPLE)
      : [];
    // Save the restart count at once: a crash right after boot must still count.
    this.persist();
    console.log(
      `[add-article] restored the import queue from ${file}: ${this.pending.length} to run ` +
      `(${interrupted.length} interrupted by the restart), ${this.jobs.size} jobs in total`,
    );
  }

  private async runJob(job: ArticleJob): Promise<void> {
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    const timeoutMs = jobTimeoutMs(job);
    const timer = setTimeout(
      () =>
        ctrl.abort(
          new Error(
            `Import timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
          ),
        ),
      timeoutMs,
    );
    // Settles when the job is aborted (deadline or cancel) — raced against the
    // pipeline so the job's status ALWAYS resolves, even if some pipeline stage
    // ignores the signal and never returns.
    const aborted = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener(
        "abort",
        () => reject(ctrl.signal.reason ?? new Error("Job aborted")),
        { once: true },
      );
    });
    // An abort during reporter creation (before the race below observes this
    // promise) must not become an unhandled rejection: that kills Node.
    aborted.catch(() => {});
    let reporter: ArticleReviewReporter | undefined;
    try {
      reporter = await this.reporterFactory(job);
      job.report_id = reporter.id;
      job.report_persistence = reporter.persistent ? "persisted" : "pending";
      await Promise.race([this.processJob(job, ctrl.signal, reporter), aborted]);
      // The import is written; a cancel from here on would be a lie.
      this.finishing.add(job.id);
      await reporter.finish("done", { finalPath: job.relay_path });
      job.status = "done";
      job.report_summary = reporter.summary();
      job.report_persistence = reporter.persistent ? "persisted" : "pending";
      console.log(`[add-article] job=${job.id} report=${reporter.id} outcome=done path=${job.relay_path ?? ""} counts=${JSON.stringify(job.report_summary)}`);
    } catch (err) {
      if (err instanceof DuplicateDocumentError) {
        // The content is already in the library: nothing failed and there is
        // nothing to retry, so this must not read as an error.
        job.status = "skipped";
        job.error = err.message;
        job.relay_url ??= editorOpenUrl(err.docPath);
        // No import ran, but a report was opened -- close it out pointing at
        // the document that already holds this content, rather than leaving a
        // report stuck in "processing" forever.
        if (reporter) {
          try {
            await reporter.finish("done", { finalPath: err.docPath });
            job.report_summary = reporter.summary();
            job.report_persistence = reporter.persistent ? "persisted" : "pending";
          } catch (reportError) {
            job.report_persistence = "failed";
            console.warn(`[add-article] Job ${job.id} skipped, report persistence failed: ${reportError}`);
          }
        }
        console.log(`[add-article] Job ${job.id} skipped: ${err.message}`);
      } else {
        job.status = ctrl.signal.aborted && ctrl.signal.reason instanceof Error &&
          ctrl.signal.reason.message === CANCELLED
          ? "cancelled"
          : "failed";
        job.error = err instanceof Error ? err.message : String(err);
        if (reporter) {
          try {
            await reporter.finish("failed", { error: job.error, finalPath: job.relay_path });
            job.report_summary = reporter.summary();
            job.report_persistence = reporter.persistent ? "persisted" : "pending";
          } catch (reportError) {
            job.report_persistence = "failed";
            job.error = `${job.error}; report persistence failed: ${reportError}`;
          }
        } else {
          job.report_persistence = "failed";
          job.error = `Report persistence failed before import started: ${job.error}`;
        }
        console.error(`[add-article] Job ${job.id} failed: ${job.url}`);
        console.error(`[add-article]   Error: ${job.error}`);
        console.error(`[add-article] job=${job.id} report=${job.report_id ?? "unavailable"} outcome=failed path=${job.relay_path ?? ""} counts=${JSON.stringify(job.report_summary ?? {})}`);
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
      this.finishing.delete(job.id);
    }
    job.stage = undefined;
    job.updated_at = new Date().toISOString();
  }
}
