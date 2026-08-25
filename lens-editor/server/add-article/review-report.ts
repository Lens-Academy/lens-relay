import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DirectArticleReview } from "./claude";
import type { ArticleValidationIssue, ArticleValidationResult } from "./platform-validation";
import type { ArticleJob, ArticleMeta } from "./types";

export type RepairClassification =
  | "programmatic-fix"
  | "validator-detected-llm-fixed"
  | "llm-detected-llm-fixed";

export interface ReportSummary {
  programmatic_fixes: number;
  validator_detected_llm_fixes: number;
  llm_detected_llm_fixes: number;
  validator_errors: number;
  validator_warnings: number;
  initial_validator_errors: number;
  initial_validator_warnings: number;
  final_validator_errors: number;
  final_validator_warnings: number;
  llm_findings: number;
  validator_fixed_by_llm: number;
  validator_remaining: number;
  validator_introduced: number;
  llm_findings_unrepaired: number;
}

interface IssueLifecycle {
  initial_round?: string;
  final_round?: string;
  validator_fixed: ArticleValidationIssue[];
  validator_fixed_by_llm: ArticleValidationIssue[];
  validator_remaining: ArticleValidationIssue[];
  validator_introduced: ArticleValidationIssue[];
  llm_fixed_independently: unknown[];
  llm_findings_unrepaired: unknown[];
  final_validation?: {
    valid: boolean;
    truncated: boolean;
    counts: { errors: number; warnings: number };
    issues: ArticleValidationIssue[];
  };
}

interface ReportEvent {
  at: string;
  kind: string;
  stage?: string;
  duration_ms?: number;
  classification?: RepairClassification;
  [key: string]: unknown;
}

interface ReviewReport {
  schema_version: 2;
  report_id: string;
  job: {
    id: string;
    url: string;
    import_mode: string;
    created_at: string;
    retry_of?: string;
  };
  started_at: string;
  updated_at: string;
  outcome: "processing" | "done" | "failed";
  final_path?: string;
  error?: string;
  original_document?: { file: "original.md"; bytes: number; sha256: string };
  final_document?: { file: "final.md"; bytes: number; sha256: string };
  lifecycle?: IssueLifecycle;
  evidence_expired_at?: string;
  summary: ReportSummary;
  events: ReportEvent[];
}

export interface ArticleReviewReporter {
  readonly id: string;
  readonly persistent: boolean;
  summary(): ReportSummary;
  stage(stage: string): Promise<void>;
  extraction(data: Record<string, unknown>): Promise<void>;
  programmatic(input: {
    code: string;
    count: number;
    before?: string;
    after?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  validation(round: string, result: ArticleValidationResult, durationMs: number): Promise<void>;
  llm(round: number, review: DirectArticleReview, validatorCodes: string[], before: ArticleMeta, after: ArticleMeta, beforeMarkdown: string, afterMarkdown: string, durationMs: number): Promise<void>;
  llmRejected(round: number, review: DirectArticleReview, validatorCodes: string[], before: ArticleMeta, durationMs: number): Promise<void>;
  llmFailure(round: number, error: unknown, durationMs: number): Promise<void>;
  originalDocument(markdown: string): Promise<void>;
  finalDocument(markdown: string): Promise<void>;
  finish(outcome: "done" | "failed", data?: { finalPath?: string; error?: string }): Promise<void>;
}

const EMPTY_SUMMARY = (): ReportSummary => ({
  programmatic_fixes: 0,
  validator_detected_llm_fixes: 0,
  llm_detected_llm_fixes: 0,
  validator_errors: 0,
  validator_warnings: 0,
  initial_validator_errors: 0,
  initial_validator_warnings: 0,
  final_validator_errors: 0,
  final_validator_warnings: 0,
  llm_findings: 0,
  validator_fixed_by_llm: 0,
  validator_remaining: 0,
  validator_introduced: 0,
  llm_findings_unrepaired: 0,
});

function reportRoot(): string {
  return process.env.ARTICLE_REVIEW_REPORT_DIR || "/data/lens-editor/article-review-reports";
}

function bounded(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const max = 4_096;
  return {
    text: value.slice(0, max),
    truncated: value.length > max,
    chars: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function changedExcerpts(before?: string, after?: string): {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
} {
  if (before === undefined && after === undefined) return {};
  const left = before ?? "";
  const right = after ?? "";
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset += 1;
  const start = Math.max(0, offset - 512);
  const describe = (value: string) => {
    const excerpt = value.slice(start, start + 4_096);
    return {
      ...bounded(excerpt),
      truncated: excerpt.length < value.length,
      excerpt_offset: start,
      full_chars: value.length,
      full_sha256: createHash("sha256").update(value).digest("hex"),
    };
  };
  return {
    before: before === undefined ? undefined : describe(before),
    after: after === undefined ? undefined : describe(after),
  };
}

function issueKey(issue: ArticleValidationIssue): string {
  return JSON.stringify([
    issue.severity,
    issue.code ?? "",
    issue.message.replace(/\s+/g, " ").trim(),
  ]);
}

function groupedIssues(issues: ArticleValidationIssue[]): Map<string, ArticleValidationIssue[]> {
  const grouped = new Map<string, ArticleValidationIssue[]>();
  for (const issue of issues) {
    const key = issueKey(issue);
    grouped.set(key, [...(grouped.get(key) ?? []), issue]);
  }
  return grouped;
}

function buildLifecycle(events: ReportEvent[]): IssueLifecycle {
  const validations = events
    .filter((event) => event.kind === "validation")
    .map((event) => ({
      round: String(event.round ?? "unknown"),
      result: {
        valid: Boolean(event.valid),
        truncated: Boolean(event.truncated),
        counts: event.counts as { errors: number; warnings: number },
        issues: (event.issues ?? []) as ArticleValidationIssue[],
      },
    }));
  const initial = validations.find((entry) => entry.round === "initial") ?? validations[0];
  const final = [...validations].reverse().find((entry) => entry.round === "final") ?? validations.at(-1);
  const initialGroups = groupedIssues(initial?.result.issues ?? []);
  const finalGroups = groupedIssues(final?.result.issues ?? []);
  const fixed: ArticleValidationIssue[] = [];
  const remaining: ArticleValidationIssue[] = [];
  const introduced: ArticleValidationIssue[] = [];
  for (const key of new Set([...initialGroups.keys(), ...finalGroups.keys()])) {
    const before = initialGroups.get(key) ?? [];
    const after = finalGroups.get(key) ?? [];
    const shared = Math.min(before.length, after.length);
    remaining.push(...after.slice(0, shared));
    fixed.push(...before.slice(shared));
    introduced.push(...after.slice(shared));
  }

  const appliedReviews = events.filter((event) => event.kind === "llm-review" && event.applied !== false);
  const appliedRepairs = appliedReviews.flatMap((event) => (event.repairs ?? []) as Array<Record<string, unknown>>);
  // The pipeline performs no programmatic body transformation between initial
  // and final validation. Every initial issue that disappears is therefore an
  // LLM fix, even when the model used a broader/different finding code.
  const fixedByLlm = fixed;
  const llmFixedIndependently = appliedRepairs.filter(
    (repair) => repair.classification === "llm-detected-llm-fixed",
  );
  const unresolvedByCode = new Map<string, unknown[]>();
  for (const event of events.filter((value) => value.kind === "llm-review")) {
    const appliedCounts = new Map<string, number>();
    if (event.applied !== false) {
      for (const repair of (event.repairs ?? []) as Array<Record<string, unknown>>) {
        const code = String(repair.finding_code ?? "");
        appliedCounts.set(code, (appliedCounts.get(code) ?? 0) + 1);
      }
    }
    const findingsByCode = new Map<string, Array<Record<string, unknown>>>();
    for (const finding of (event.findings ?? []) as Array<Record<string, unknown>>) {
      const code = String(finding.code ?? "");
      findingsByCode.set(code, [...(findingsByCode.get(code) ?? []), finding]);
    }
    for (const [code, findings] of findingsByCode) {
      const remainingFindings = findings
        .filter(() => {
          const count = appliedCounts.get(code) ?? 0;
          if (!count) return true;
          appliedCounts.set(code, count - 1);
          return false;
        })
        .map((finding) => ({ round: event.round, applied: event.applied !== false, ...finding }));
      if (remainingFindings.length) unresolvedByCode.set(code, remainingFindings);
      else unresolvedByCode.delete(code);
    }
  }
  const llmFindingsUnrepaired = [...unresolvedByCode.values()].flat();

  return {
    initial_round: initial?.round,
    final_round: final?.round,
    validator_fixed: fixed,
    validator_fixed_by_llm: fixedByLlm,
    validator_remaining: remaining,
    validator_introduced: introduced,
    llm_fixed_independently: llmFixedIndependently,
    llm_findings_unrepaired: llmFindingsUnrepaired,
    final_validation: final?.result,
  };
}

class Reporter implements ArticleReviewReporter {
  readonly id: string;
  readonly persistent: boolean;
  private sequence = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private stageStarted = Date.now();
  private currentStage?: string;
  private sealed = false;
  private finishPromise?: Promise<void>;

  constructor(
    private readonly report: ReviewReport,
    private readonly runDir: string | null,
  ) {
    this.id = report.report_id;
    this.persistent = runDir !== null;
  }

  private async append(event: ReportEvent, allowSealed = false): Promise<void> {
    if (this.sealed && !allowSealed) return;
    this.report.events.push(event);
    this.report.updated_at = new Date().toISOString();
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.runDir) return;
    const sequence = ++this.sequence;
    const runDir = this.runDir;
    const serialized = JSON.stringify(this.report, null, 2) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      const temporary = path.join(
        runDir,
        `.report.${sequence}-${randomUUID()}.tmp`,
      );
      await fs.writeFile(temporary, serialized, { flag: "wx" });
      await fs.rename(temporary, path.join(runDir, "report.json"));
    });
    await this.writeChain;
  }

  async initialize(): Promise<void> {
    await this.flush();
  }

  summary(): ReportSummary {
    return { ...this.report.summary };
  }

  async stage(stage: string): Promise<void> {
    if (this.sealed) return;
    const now = Date.now();
    const previous = this.currentStage;
    const duration = now - this.stageStarted;
    this.currentStage = stage;
    this.stageStarted = now;
    await this.append({
      at: new Date(now).toISOString(),
      kind: "stage",
      stage,
      previous_stage: previous,
      previous_duration_ms: previous ? duration : undefined,
    });
  }

  extraction(data: Record<string, unknown>): Promise<void> {
    return this.append({ at: new Date().toISOString(), kind: "extraction", ...data });
  }

  async programmatic(input: {
    code: string;
    count: number;
    before?: string;
    after?: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    if (this.sealed) return;
    this.report.summary.programmatic_fixes += input.count;
    const excerpts = changedExcerpts(input.before, input.after);
    await this.append({
      at: new Date().toISOString(),
      kind: "repair",
      classification: "programmatic-fix",
      code: input.code,
      count: input.count,
      before: excerpts.before,
      after: excerpts.after,
      ...input.detail,
    });
  }

  async validation(round: string, result: ArticleValidationResult, durationMs: number): Promise<void> {
    if (this.sealed) return;
    this.report.summary.validator_errors += result.counts.errors;
    this.report.summary.validator_warnings += result.counts.warnings;
    if (round === "initial") {
      this.report.summary.initial_validator_errors = result.counts.errors;
      this.report.summary.initial_validator_warnings = result.counts.warnings;
    }
    if (round === "final") {
      this.report.summary.final_validator_errors = result.counts.errors;
      this.report.summary.final_validator_warnings = result.counts.warnings;
    }
    await this.append({
      at: new Date().toISOString(),
      kind: "validation",
      round,
      duration_ms: durationMs,
      valid: result.valid,
      truncated: result.truncated,
      counts: result.counts,
      issues: result.issues,
    });
  }

  private async recordLlm(
    round: number,
    review: DirectArticleReview,
    validatorCodes: string[],
    before: ArticleMeta,
    after: ArticleMeta,
    beforeMarkdown: string | undefined,
    afterMarkdown: string | undefined,
    durationMs: number,
    applied: boolean,
  ): Promise<void> {
    if (this.sealed) return;
    const validatorSet = new Set(validatorCodes);
    const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    const bodyChanged = applied && beforeMarkdown !== undefined && afterMarkdown !== undefined && body(beforeMarkdown) !== body(afterMarkdown);
    const repairs: Array<Record<string, unknown>> = [];
    if (bodyChanged) {
      const excerpts = changedExcerpts(beforeMarkdown, afterMarkdown);
      repairs.push({
        classification: "llm-detected-llm-fixed",
        finding_code: "content.direct-edit",
        reason: "source-fidelity reviewer edited the candidate directly",
        old: excerpts.before,
        new: excerpts.after,
      });
      this.report.summary.llm_detected_llm_fixes += 1;
    }
    const metadataChanges = (["title", "author", "published", "description"] as const)
      .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map((field) => {
        const code = `metadata.${field}`;
        const classification: RepairClassification = validatorSet.has(code)
          ? "validator-detected-llm-fixed"
          : "llm-detected-llm-fixed";
        return { field, code, classification, before: before[field], after: after[field] };
      });
    repairs.push(...metadataChanges.map((change) => ({
      classification: change.classification,
      finding_code: change.code,
      reason: "metadata corrected from source evidence",
      old: bounded(JSON.stringify(change.before)),
      new: bounded(JSON.stringify(change.after)),
      metadata_field: change.field,
    })));
    if (applied && metadataChanges.length) {
      for (const change of metadataChanges) {
        if (change.classification === "validator-detected-llm-fixed") {
          this.report.summary.validator_detected_llm_fixes += 1;
        } else {
          this.report.summary.llm_detected_llm_fixes += 1;
        }
      }
    }
    await this.append({
      at: new Date().toISOString(),
      kind: "llm-review",
      round,
      applied,
      duration_ms: durationMs,
      decision: review.decision,
      findings: [],
      repairs,
      metadata_changes: metadataChanges,
      metadata_before: before,
      metadata_after: after,
      note: review.reason,
    });
  }

  llm(
    round: number,
    review: DirectArticleReview,
    validatorCodes: string[],
    before: ArticleMeta,
    after: ArticleMeta,
    beforeMarkdown: string,
    afterMarkdown: string,
    durationMs: number,
  ): Promise<void> {
    return this.recordLlm(round, review, validatorCodes, before, after, beforeMarkdown, afterMarkdown, durationMs, true);
  }

  llmRejected(
    round: number,
    review: DirectArticleReview,
    validatorCodes: string[],
    before: ArticleMeta,
    durationMs: number,
  ): Promise<void> {
    return this.recordLlm(round, review, validatorCodes, before, before, undefined, undefined, durationMs, false);
  }

  llmFailure(round: number, error: unknown, durationMs: number): Promise<void> {
    return this.append({
      at: new Date().toISOString(),
      kind: "llm-review-failed",
      round,
      duration_ms: durationMs,
      error: safeError(error),
    });
  }

  async originalDocument(markdown: string): Promise<void> {
    if (this.sealed || this.report.original_document) return;
    const descriptor = {
      file: "original.md" as const,
      bytes: Buffer.byteLength(markdown, "utf-8"),
      sha256: createHash("sha256").update(markdown).digest("hex"),
    };
    if (this.runDir) {
      const temporary = path.join(this.runDir, `.original.${randomUUID()}.tmp`);
      await fs.writeFile(temporary, markdown, { flag: "wx" });
      await fs.rename(temporary, path.join(this.runDir, descriptor.file));
    }
    this.report.original_document = descriptor;
    await this.append({ at: new Date().toISOString(), kind: "original-document", ...descriptor });
  }

  async finalDocument(markdown: string): Promise<void> {
    if (this.sealed) return;
    const descriptor = {
      file: "final.md" as const,
      bytes: Buffer.byteLength(markdown, "utf-8"),
      sha256: createHash("sha256").update(markdown).digest("hex"),
    };
    if (this.runDir) {
      const sequence = ++this.sequence;
      const temporary = path.join(this.runDir, `.final.${sequence}-${randomUUID()}.tmp`);
      const destination = path.join(this.runDir, descriptor.file);
      this.writeChain = this.writeChain.then(async () => {
        await fs.writeFile(temporary, markdown, { flag: "wx" });
        await fs.rename(temporary, destination);
      });
      await this.writeChain;
    }
    this.report.final_document = descriptor;
    await this.append({
      at: new Date().toISOString(),
      kind: "final-document",
      ...descriptor,
    });
  }

  finish(
    outcome: "done" | "failed",
    data: { finalPath?: string; error?: string } = {},
  ): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.sealed = true;
    this.finishPromise = this.finishOnce(outcome, data);
    return this.finishPromise;
  }

  private async finishOnce(
    outcome: "done" | "failed",
    data: { finalPath?: string; error?: string },
  ): Promise<void> {
    this.report.outcome = outcome;
    this.report.final_path = data.finalPath;
    this.report.error = data.error?.slice(0, 4_096);
    this.report.lifecycle = buildLifecycle(this.report.events);
    this.report.summary.validator_fixed_by_llm = this.report.lifecycle.validator_fixed_by_llm.length;
    this.report.summary.validator_remaining = this.report.lifecycle.validator_remaining.length;
    this.report.summary.validator_introduced = this.report.lifecycle.validator_introduced.length;
    this.report.summary.llm_findings_unrepaired = this.report.lifecycle.llm_findings_unrepaired.length;
    await this.append({
      at: new Date().toISOString(),
      kind: "finished",
      stage: this.currentStage,
      duration_ms: Date.now() - this.stageStarted,
      total_duration_ms: Date.now() - Date.parse(this.report.started_at),
      outcome,
      final_path: data.finalPath,
      error: data.error?.slice(0, 4_096),
      summary: this.report.summary,
    }, true);
  }
}

let prunePromise: Promise<void> | null = null;
let lastPruneAt = 0;
export async function pruneArticleReviewReports(
  root: string,
  retentionDays: number,
  now: number = Date.now(),
  evidenceRetentionDays: number = 30,
): Promise<void> {
  const cutoff = now - retentionDays * 86_400_000;
  const evidenceCutoff = now - evidenceRetentionDays * 86_400_000;
  for (const day of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!day.isDirectory()) continue;
    const dayPath = path.join(root, day.name);
    for (const run of await fs.readdir(dayPath, { withFileTypes: true }).catch(() => [])) {
      if (!run.isDirectory()) continue;
      const runPath = path.join(dayPath, run.name);
      const stat = await fs.stat(runPath);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(runPath, { recursive: true });
        continue;
      }
      if (stat.mtimeMs < evidenceCutoff) await expireReportEvidence(runPath, now);
    }
  }
}

function expireBoundedEvidence(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) expireBoundedEvidence(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && typeof record.sha256 === "string") {
    delete record.text;
    record.expired = true;
  }
  for (const child of Object.values(record)) expireBoundedEvidence(child);
}

async function expireReportEvidence(runPath: string, now: number): Promise<void> {
  const reportPath = path.join(runPath, "report.json");
  const report = await fs.readFile(reportPath, "utf-8").then(JSON.parse).catch(() => null) as ReviewReport | null;
  if (!report || report.evidence_expired_at) return;
  expireBoundedEvidence(report.events);
  report.evidence_expired_at = new Date(now).toISOString();
  report.updated_at = report.evidence_expired_at;
  const temporary = path.join(runPath, `.report.retention-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await fs.rename(temporary, reportPath);
}

async function pruneExpiredReports(root: string): Promise<void> {
  if (Date.now() - lastPruneAt < 24 * 60 * 60 * 1000) return;
  if (prunePromise) return prunePromise;
  prunePromise = (async () => {
    const days = Number(process.env.ARTICLE_REVIEW_REPORT_RETENTION_DAYS || 90);
    const evidenceDays = Number(process.env.ARTICLE_REVIEW_EVIDENCE_RETENTION_DAYS || 30);
    await pruneArticleReviewReports(root, days, Date.now(), evidenceDays);
    lastPruneAt = Date.now();
  })().finally(() => { prunePromise = null; });
  return prunePromise;
}

export async function createArticleReviewReporter(job: ArticleJob): Promise<ArticleReviewReporter> {
  const reportId = randomUUID();
  const root = reportRoot();
  const day = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(root, day);
  await fs.mkdir(dayDir, { recursive: true });
  const runDir = path.join(dayDir, `${job.id}-${reportId}`);
  await fs.mkdir(runDir, { recursive: false });
  const now = new Date().toISOString();
  const reporter = new Reporter({
    schema_version: 2,
    report_id: reportId,
    job: { id: job.id, url: job.url, import_mode: job.importMode, created_at: job.created_at, retry_of: job.retry_of },
    started_at: now,
    updated_at: now,
    outcome: "processing",
    summary: EMPTY_SUMMARY(),
    events: [],
  }, runDir);
  await reporter.initialize();
  void pruneExpiredReports(root).catch((error) => {
    console.error(`[add-article] report pruning failed: ${error}`);
  });
  return reporter;
}

export function createMemoryArticleReviewReporter(job: ArticleJob): ArticleReviewReporter {
  const now = new Date().toISOString();
  return new Reporter({
    schema_version: 2,
    report_id: randomUUID(),
    job: { id: job.id, url: job.url, import_mode: job.importMode, created_at: job.created_at, retry_of: job.retry_of },
    started_at: now,
    updated_at: now,
    outcome: "processing",
    summary: EMPTY_SUMMARY(),
    events: [],
  }, null);
}
