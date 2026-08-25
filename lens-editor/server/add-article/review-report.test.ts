import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArticleReviewReporter, pruneArticleReviewReports } from "./review-report";
import type { ArticleJob } from "./types";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function job(id: string): ArticleJob {
  const now = new Date().toISOString();
  return {
    id,
    url: `https://example.com/${id}`,
    status: "processing",
    importMode: "article",
    created_at: now,
    updated_at: now,
  };
}

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "article-reports-"));
  roots.push(value);
  vi.stubEnv("ARTICLE_REVIEW_REPORT_DIR", value);
  return value;
}

describe("article review reports", () => {
  it("isolates three concurrent jobs and leaves no shared temp files", async () => {
    const reportRoot = await root();
    const reporters = await Promise.all(["a", "b", "c"].map((id) => createArticleReviewReporter(job(id))));
    await Promise.all(reporters.map(async (reporter, i) => {
      await Promise.all([
        reporter.stage(`stage-${i}-a`),
        reporter.stage(`stage-${i}-b`),
        reporter.programmatic({ code: "normalize.test", count: 1, before: "old", after: "new" }),
      ]);
      await reporter.finish("done", { finalPath: `Lens Edu/articles/${i}.md` });
    }));
    const day = (await fs.readdir(reportRoot))[0];
    const runDirs = await fs.readdir(path.join(reportRoot, day));
    expect(runDirs).toHaveLength(3);
    expect(new Set(runDirs).size).toBe(3);
    for (const run of runDirs) {
      const files = await fs.readdir(path.join(reportRoot, day, run));
      expect(files).toEqual(["report.json"]);
      expect(JSON.parse(await fs.readFile(path.join(reportRoot, day, run, "report.json"), "utf-8")).outcome).toBe("done");
    }
  });

  it("bounds excerpts and records stable hashes", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("bounded"));
    await reporter.programmatic({ code: "normalize.large", count: 1, before: "x".repeat(5_000), after: "y" });
    await reporter.finish("done");
    const day = (await fs.readdir(reportRoot))[0];
    const run = (await fs.readdir(path.join(reportRoot, day)))[0];
    const report = JSON.parse(await fs.readFile(path.join(reportRoot, day, run, "report.json"), "utf-8"));
    const repair = report.events.find((event: { kind: string }) => event.kind === "repair");
    expect(repair.before.text).toHaveLength(4_096);
    expect(repair.before.truncated).toBe(true);
    expect(repair.before.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the exact final document and an explicit issue lifecycle", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("lifecycle"));
    const issue = (code: string, line: number) => ({
      code,
      severity: "warning" as const,
      path: "articles/example.md",
      line,
      message: `Problem ${code}`,
    });
    await reporter.validation("initial", {
      valid: true,
      truncated: false,
      counts: { errors: 0, warnings: 2 },
      issues: [issue("article.fixed", 2), issue("article.remaining", 3)],
    }, 10);
    const meta = { title: "Title", author: ["Author"], source_url: "https://example.com", published: "", description: "" };
    await reporter.llm(0, {
      decision: "repair",
      source_status: "complete",
      findings: [
        { code: "article.fixed", severity: "warning", evidence: "bad", confidence: 1 },
        { code: "semantic.fixed", severity: "warning", evidence: "also bad", confidence: 0.9 },
        { code: "semantic.unrepaired", severity: "warning", evidence: "still bad", confidence: 0.8 },
      ],
      patches: [
        { finding_code: "article.fixed", old: "bad", new: "good", reason: "fix validator issue" },
        { finding_code: "semantic.fixed", old: "also bad", new: "better", reason: "source fidelity" },
      ],
      note: "reviewed",
    }, ["article.fixed", "article.remaining"], meta, meta, 20);
    await reporter.validation("final", {
      valid: true,
      truncated: false,
      counts: { errors: 0, warnings: 2 },
      issues: [issue("article.remaining", 5), issue("article.introduced", 6)],
    }, 10);
    const markdown = "---\ntitle: Title\n---\n\nExact final body.\n";
    await reporter.finalDocument(markdown);
    await reporter.finish("done", { finalPath: "Lens Edu/articles/example.md" });

    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    expect(await fs.readFile(path.join(runPath, "final.md"), "utf-8")).toBe(markdown);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    expect(report.schema_version).toBe(2);
    expect(report.final_document).toMatchObject({ file: "final.md", bytes: Buffer.byteLength(markdown) });
    expect(report.lifecycle.validator_fixed.map((value: { code: string }) => value.code)).toEqual(["article.fixed"]);
    expect(report.lifecycle.validator_fixed_by_llm.map((value: { code: string }) => value.code)).toEqual(["article.fixed"]);
    expect(report.lifecycle.validator_remaining.map((value: { code: string }) => value.code)).toEqual(["article.remaining"]);
    expect(report.lifecycle.validator_introduced.map((value: { code: string }) => value.code)).toEqual(["article.introduced"]);
    expect(report.lifecycle.llm_fixed_independently[0].finding_code).toBe("semantic.fixed");
    expect(report.lifecycle.llm_findings_unrepaired[0].code).toBe("semantic.unrepaired");
  });

  it("retains structured findings when the LLM rejects the article", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("rejected"));
    const meta = { title: "Title", author: ["Author"], source_url: "https://example.com", published: "", description: "" };
    await reporter.llmRejected(0, {
      decision: "reject",
      source_status: "truncated",
      findings: [{ code: "source.missing-ending", severity: "error", evidence: "abrupt end", confidence: 0.95 }],
      patches: [],
      note: "The source evidence is incomplete.",
    }, [], meta, 25);
    await reporter.finish("failed", { error: "source review rejected the article" });
    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    expect(report.events.find((event: { kind: string }) => event.kind === "llm-review")).toMatchObject({
      applied: false,
      decision: "reject",
      source_status: "truncated",
    });
    expect(report.lifecycle.llm_findings_unrepaired[0].code).toBe("source.missing-ending");
  });

  it("matches duplicate validator issues independently of provisional filenames", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("renamed"));
    const issue = (pathValue: string, line: number) => ({
      code: "article.same",
      severity: "warning" as const,
      path: pathValue,
      line,
      message: "Same warning",
    });
    await reporter.validation("initial", {
      valid: true,
      truncated: false,
      counts: { errors: 1, warnings: 2 },
      issues: [issue("articles/provisional.md", 2), issue("articles/provisional.md", 8)],
    }, 1);
    await reporter.validation("final", {
      valid: true,
      truncated: false,
      counts: { errors: 0, warnings: 1 },
      issues: [issue("articles/final-name.md", 20)],
    }, 1);
    await reporter.finish("done");
    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    expect(report.lifecycle.validator_remaining).toHaveLength(1);
    expect(report.lifecycle.validator_fixed).toHaveLength(1);
    expect(report.lifecycle.validator_fixed_by_llm).toHaveLength(1);
    expect(report.summary).toMatchObject({
      initial_validator_errors: 1,
      initial_validator_warnings: 2,
      final_validator_errors: 0,
      final_validator_warnings: 1,
      validator_errors: 1,
      validator_warnings: 3,
    });
  });

  it("records metadata changes as attributed repairs and keeps per-code samples", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("metadata"));
    await reporter.programmatic({
      code: "normalize.root-relative-destination",
      count: 2,
      before: "[one](/one)",
      after: "[one](https://example.com/one)",
      detail: { samples: [
        { before: "[one](/one)", after: "[one](https://example.com/one)" },
        { before: "[two](/two)", after: "[two](https://example.com/two)" },
      ] },
    });
    const before = { title: "Wrong", author: ["Author"], source_url: "https://example.com", published: "", description: "" };
    const after = { ...before, title: "Correct" };
    await reporter.llm(0, {
      decision: "repair",
      source_status: "complete",
      findings: [{ code: "metadata.title", severity: "warning", evidence: "source title", confidence: 1 }],
      patches: [],
      title: "Correct",
      note: "metadata fixed",
    }, ["metadata.title"], before, after, 2);
    await reporter.finish("done");
    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    const normalization = report.events.find((event: { code?: string }) => event.code === "normalize.root-relative-destination");
    expect(normalization.samples).toHaveLength(2);
    const llm = report.events.find((event: { kind: string }) => event.kind === "llm-review");
    expect(llm.repairs).toContainEqual(expect.objectContaining({
      classification: "validator-detected-llm-fixed",
      finding_code: "metadata.title",
      metadata_field: "title",
    }));
  });

  it("seals after an idempotent finish and ignores late events", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("sealed"));
    await Promise.all([reporter.finish("failed", { error: "cancelled" }), reporter.finish("done")]);
    await reporter.llmFailure(9, new Error("late Claude event"), 100);
    await reporter.programmatic({ code: "normalize.late", count: 10 });
    await reporter.finalDocument("late document");
    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    expect(report.outcome).toBe("failed");
    expect(report.events.filter((event: { kind: string }) => event.kind === "finished")).toHaveLength(1);
    expect(report.events.some((event: { kind: string }) => event.kind === "llm-review-failed")).toBe(false);
    expect(report.events.some((event: { code?: string }) => event.code === "normalize.late")).toBe(false);
    await expect(fs.stat(path.join(runPath, "final.md"))).rejects.toThrow();
  });

  it("reports final unresolved LLM findings rather than stale earlier rounds", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("final-findings"));
    const meta = { title: "Title", author: ["Author"], source_url: "https://example.com", published: "", description: "" };
    const finding = { code: "body.issue", severity: "warning" as const, evidence: "bad", confidence: 1 };
    await reporter.llm(0, {
      decision: "pass",
      source_status: "complete",
      findings: [finding],
      patches: [],
      note: "deferred",
    }, [], meta, meta, 1);
    await reporter.llm(1, {
      decision: "repair",
      source_status: "complete",
      findings: [finding],
      patches: [{ finding_code: "body.issue", old: "bad", new: "good", reason: "fixed" }],
      note: "fixed",
    }, [], meta, meta, 1);
    await reporter.finish("done");
    const day = (await fs.readdir(reportRoot))[0];
    const runPath = path.join(reportRoot, day, (await fs.readdir(path.join(reportRoot, day)))[0]);
    const report = JSON.parse(await fs.readFile(path.join(runPath, "report.json"), "utf-8"));
    expect(report.lifecycle.llm_findings_unrepaired).toEqual([]);
  });

  it("fails the calling stage when persistence becomes unavailable", async () => {
    const reportRoot = await root();
    const reporter = await createArticleReviewReporter(job("disk-failure"));
    const day = (await fs.readdir(reportRoot))[0];
    const run = (await fs.readdir(path.join(reportRoot, day)))[0];
    await fs.rm(path.join(reportRoot, day, run), { recursive: true });
    await expect(reporter.stage("before-relay-write")).rejects.toThrow();
  });

  it("prunes only expired run directories", async () => {
    const reportRoot = await root();
    const dayDir = path.join(reportRoot, "2026-01-01");
    const oldRun = path.join(dayDir, "old-run");
    const evidenceExpiredRun = path.join(dayDir, "evidence-expired-run");
    const freshRun = path.join(dayDir, "fresh-run");
    await fs.mkdir(oldRun, { recursive: true });
    await fs.mkdir(evidenceExpiredRun, { recursive: true });
    await fs.mkdir(freshRun, { recursive: true });
    await fs.writeFile(path.join(evidenceExpiredRun, "report.json"), JSON.stringify({
      schema_version: 1,
      events: [{ kind: "repair", before: { text: "source excerpt", chars: 14, sha256: "abc" } }],
    }));
    await fs.writeFile(path.join(evidenceExpiredRun, "final.md"), "retained final document");
    const now = new Date("2026-08-19T00:00:00Z").getTime();
    const old = new Date(now - 91 * 86_400_000);
    const evidenceExpired = new Date(now - 31 * 86_400_000);
    await fs.utimes(oldRun, old, old);
    await fs.utimes(evidenceExpiredRun, evidenceExpired, evidenceExpired);
    await pruneArticleReviewReports(reportRoot, 90, now);
    await expect(fs.stat(oldRun)).rejects.toThrow();
    await expect(fs.stat(freshRun)).resolves.toBeDefined();
    const retained = JSON.parse(await fs.readFile(path.join(evidenceExpiredRun, "report.json"), "utf-8"));
    expect(retained.events[0].before).toEqual({ chars: 14, sha256: "abc", expired: true });
    expect(retained.evidence_expired_at).toBe("2026-08-19T00:00:00.000Z");
    expect((await fs.readdir(evidenceExpiredRun)).sort()).toEqual(["final.md", "report.json"]);
    expect(await fs.readFile(path.join(evidenceExpiredRun, "final.md"), "utf-8")).toBe("retained final document");
  });
});
