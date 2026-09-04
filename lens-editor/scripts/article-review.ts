#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { buildSourceEvidence, writeSourceEvidence } from "../server/add-article/source-evidence";
import { parseFrontmatterAuthor, splitFrontmatter } from "../server/add-article/eval/edu-repo";
import { createRelayReviewClient, readAcceptedRelayMarkdown } from "../server/add-article/relay-review-read";
import {
  ArticleReviewRejectedError,
  type ArticleReviewProvider,
  MAX_REVIEW_ROUNDS,
  REVIEW_VERSION,
  resolveArticleReviewerConfig,
  buildRevertNotice,
  reviewArticle,
} from "../server/add-article/claude";
import {
  assertArticleValidationConfigured,
  isArticleValidationOutage,
  validateArticleDraft,
  type ArticleValidationResult,
} from "../server/add-article/platform-validation";
import type { ArticleMeta } from "../server/add-article/types";
import { buildRelayReviewEdits } from "../server/add-article/review-diff";
import { normalizeReviewScaffolding } from "../server/add-article/review-scaffolding";
import {
  claimReviewItem,
  finishReviewItem,
  readReviewRun,
  releaseReviewItem,
  reviewItemCanBeClaimed,
  writeReviewRun,
  type ReviewItem,
  type ReviewRun,
} from "./article-review-manifest";

interface ReviewPassMetric {
  pass: number;
  duration_ms: number;
  outcome: "pass" | "reject" | "failed";
  trigger_validator_codes: string[];
  validation_before: ArticleValidationResult["counts"];
  validation_after?: ArticleValidationResult["counts"];
}

function validationCodes(validation: ArticleValidationResult): string[] {
  return [...new Set(validation.issues.map((issue) => issue.code).filter((code): code is string => !!code))];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function reviewerConfig() {
  const rawProvider = arg("--provider") ?? "claude";
  if (rawProvider !== "claude" && rawProvider !== "codex") {
    throw new Error("--provider must be claude or codex");
  }
  const config = resolveArticleReviewerConfig(rawProvider as ArticleReviewProvider, arg("--model"));
  const rawBudget = arg("--max-budget-usd");
  if (rawBudget !== undefined) {
    const maxBudgetUsd = Number(rawBudget);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw new Error("--max-budget-usd must be a positive number");
    }
    config.maxBudgetUsd = maxBudgetUsd;
  }
  const rawTimeoutMinutes = arg("--timeout-minutes");
  if (rawTimeoutMinutes !== undefined) {
    const timeoutMinutes = Number(rawTimeoutMinutes);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error("--timeout-minutes must be a positive number");
    }
    config.timeoutMs = timeoutMinutes * 60_000;
  }
  return config;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function safeId(relative: string): string {
  return Buffer.from(relative, "utf8").toString("base64url").slice(-180);
}

async function selectedPaths(contentRoot: string): Promise<string[]> {
  const articlePath = arg("--article");
  if (articlePath) return [articlePath];
  const manifestPath = arg("--manifest");
  if (manifestPath) {
    const parsed = JSON.parse(await fs.readFile(path.resolve(manifestPath), "utf-8"));
    const values = Array.isArray(parsed) ? parsed : parsed.articles ?? parsed.paths;
    if (!Array.isArray(values)) throw new Error("--manifest must contain an array or {articles:[...]}");
    return values.map(String);
  }
  if (!process.argv.includes("--all")) {
    throw new Error("prepare requires --article <path>, --all, or --manifest <file>");
  }
  const articles = path.join(contentRoot, "articles");
  return (await walk(articles)).map((full) => path.relative(contentRoot, full));
}

async function prepare(): Promise<void> {
  const contentRoot = path.resolve(arg("--content-root") ?? "");
  if (!arg("--content-root")) throw new Error("prepare requires --content-root <directory>");
  const cacheRoot = path.resolve(arg("--cache-root") ?? path.join(process.cwd(), ".article-review-cache"));
  const runId = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(cacheRoot, runId);
  const relayUrl = arg("--relay-url") ?? process.env.RELAY_URL;
  const relayToken = process.env.ARTICLE_REVIEW_RELAY_TOKEN ?? process.env.MCP_API_KEY;
  const relayFolder = arg("--relay-folder") ?? "Lens Edu";
  if (!relayUrl) throw new Error("prepare requires --relay-url <url> or RELAY_URL");
  if (!relayToken) throw new Error("prepare requires ARTICLE_REVIEW_RELAY_TOKEN or MCP_API_KEY");
  // Optional gap between source fetches: mirrors such as greaterwrong.com
  // answer 429 to a burst of requests but are fine with a steady trickle.
  const paceMs = Number(arg("--pace-ms") ?? 0);
  if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error("--pace-ms must be a non-negative number");
  await fs.mkdir(runDir, { recursive: true });
  const items: ReviewItem[] = [];

  for (const relative of await selectedPaths(contentRoot)) {
    if (paceMs > 0 && items.length > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const full = path.resolve(contentRoot, normalized);
    if (!full.startsWith(`${contentRoot}${path.sep}`)) throw new Error(`Unsafe article path: ${relative}`);
    await fs.stat(full);
    const relayPath = `${relayFolder.replace(/\/+$/, "")}/${normalized}`;
    let markdown: string;
    try {
      markdown = await readAcceptedRelayMarkdown(relayPath, { relayUrl, token: relayToken });
    } catch (error) {
      // One unreadable article (most commonly: pending suggestions awaiting
      // human review) must not abort a whole batch — skip it and move on.
      console.log(`skipped  ${normalized}: ${String(error).slice(0, 120)}`);
      continue;
    }
    const { frontmatter } = splitFrontmatter(markdown);
    const preservedSourceUrl = markdown.match(
      /^Original source URL:\s*(https?:\/\/\S+)\s*$/m,
    )?.[1];
    const sourceUrl = frontmatter.source_url ?? preservedSourceUrl;
    if (!sourceUrl || frontmatter.tags?.includes("article-stub")) continue;
    const bundle = path.join(runDir, safeId(normalized));
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, "article.md"), markdown);
    const item: ReviewItem = {
      article_path: normalized,
      relay_path: relayPath,
      source_url: sourceUrl,
      bundle,
      state: "prepared",
    };
    try {
      const evidence = await buildSourceEvidence(sourceUrl);
      // A bot-check interstitial (Vercel "Security Checkpoint", Cloudflare
      // "Just a moment") extracts to a few dozen characters; recording it as
      // evidence would only make the reviewer reject the article later, at a
      // model call's cost. Fail the item now so it can be re-prepared.
      if (evidence.extraction.body.trim().length < 400) {
        throw new Error(
          `source evidence is only ${evidence.extraction.body.trim().length} characters ` +
          `(fetched ${evidence.manifest.fetched_url}); likely a bot-check page — re-prepare later`,
        );
      }
      await writeSourceEvidence(bundle, evidence);
      await fs.writeFile(path.join(bundle, "instructions.md"), instructions(item));
    } catch (error) {
      item.state = "failed";
      item.error = String(error);
    }
    items.push(item);
    console.log(`${item.state.padEnd(8)} ${normalized}`);
  }
  const batches = Array.from({ length: Math.ceil(items.length / 5) }, (_, i) =>
    items.slice(i * 5, i * 5 + 5).map((item) => item.article_path));
  const run: ReviewRun = { version: 1, run_id: runId, created_at: new Date().toISOString(), content_root: contentRoot, items, batches };
  await writeReviewRun(runDir, run);
  console.log(`\nPrepared ${items.length} articles in ${runDir} (${batches.length} batches of at most five).`);
}

function instructions(item: ReviewItem): string {
  return `# Retroactive article review

This bundle is processed by the same direct-edit reviewer used for new imports. Run \`article-review execute\` for \`${item.article_path}\`; it will compare \`article.md\` with \`evidence/\`, verify that \`${item.relay_path}\` has not changed, and publish the reviewed diff as CriticMarkup suggestions through Relay. It does not modify the local content checkout or accept its own suggestions.
`;
}

async function status(): Promise<void> {
  const runDir = path.resolve(arg("--run") ?? "");
  if (!arg("--run")) throw new Error("status requires --run <run-directory>");
  const run = await readReviewRun(runDir);
  const counts: Record<string, number> = {};
  const reviewPassCounts: Record<string, number> = {};
  const extraPassTriggerCodes: Record<string, number> = {};
  const reviewers: Record<string, number> = {};
  const passDurations: Record<string, { attempts: number; total_duration_ms: number; average_duration_ms: number }> = {};
  const increment = (record: Record<string, number>, key: string) => {
    record[key] = (record[key] ?? 0) + 1;
  };
  for (const item of run.items) {
    const result = await fs.readFile(path.join(item.bundle, "result.json"), "utf-8").then(JSON.parse).catch(() => null);
    const state = result?.state ?? item.state;
    counts[state] = (counts[state] ?? 0) + 1;
    const provider = result?.review_provider ?? item.review_provider;
    const model = result?.review_model ?? item.review_model;
    if (provider || model) increment(reviewers, `${provider ?? "unknown"}:${model ?? "unknown"}`);
    const reviewPasses = Number(result?.review_passes);
    increment(reviewPassCounts, Number.isInteger(reviewPasses) ? String(reviewPasses) : "unknown");
    for (const metric of (result?.review_pass_details ?? []) as ReviewPassMetric[]) {
      for (const code of metric.trigger_validator_codes ?? []) increment(extraPassTriggerCodes, code);
      const key = String(metric.pass);
      const duration = passDurations[key] ?? { attempts: 0, total_duration_ms: 0, average_duration_ms: 0 };
      duration.attempts += 1;
      duration.total_duration_ms += Number(metric.duration_ms) || 0;
      duration.average_duration_ms = Math.round(duration.total_duration_ms / duration.attempts);
      passDurations[key] = duration;
    }
    console.log(`${state.padEnd(10)} ${item.article_path}`);
  }
  console.log(`\n${JSON.stringify({
    ...counts,
    _instrumentation: {
      review_pass_counts: reviewPassCounts,
      extra_pass_trigger_codes: extraPassTriggerCodes,
      llm_pass_durations_ms: passDurations,
      reviewers,
    },
  })}`);
}

function withReviewProvenance(markdown: string, manifest: Record<string, unknown>, model: string): string {
  const opening = markdown.match(/^---\r?\n/);
  if (!opening) throw new Error("Reviewed article has no frontmatter");
  const closing = /^---\s*$/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(markdown);
  if (!match) throw new Error("Reviewed article has unclosed frontmatter");
  let frontmatter = markdown.slice(opening[0].length, match.index);
  frontmatter = frontmatter.replace(/^llm-review:\r?\n(?:^[ \t].*(?:\r?\n|$))*/m, "");
  const reviewedDate = new Date().toISOString().slice(0, 10);
  const sourceFetched = String(manifest.fetched_at ?? reviewedDate).slice(0, 10);
  const sourceKind = String(manifest.source_kind ?? "live");
  const provenance = [
    "llm-review:",
    `  date: ${reviewedDate}`,
    `  model: "${model}"`,
    `  version: "${REVIEW_VERSION}"`,
    "  source:",
    `    fetched: ${sourceFetched}`,
    `    kind: "${sourceKind}"`,
  ].join("\n");
  const reviewed = `${opening[0]}${frontmatter.trimEnd()}\n${provenance}\n---${markdown.slice(match.index + match[0].length)}`;
  return reviewed.endsWith("\n") ? reviewed : `${reviewed}\n`;
}

/** Poll the validation service with a trivial draft until it answers again
 * (any real answer counts, including a verdict that the probe is invalid). */
async function waitForArticleValidation(maxWaitMs = 3 * 60 * 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await validateArticleDraft("articles/validator-probe.md", "---\ntitle: probe\n---\n\nprobe\n");
      return;
    } catch (error) {
      if (!isArticleValidationOutage(error)) return;
      if (Date.now() - started > maxWaitMs) {
        throw new Error("Article validation service stayed unavailable for hours; giving up");
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

/** A reviewer failure caused by the provider refusing work (rate limit or the
 * subscription's session window), rather than by this article. */
function isReviewerUnavailable(error: unknown): boolean {
  const text = String(error);
  return /Mandatory article LLM review failed/.test(text) &&
    /"api_error_status":\s*(?:429|5\d\d)\b|session limit|rate.?limit|overloaded/i.test(text);
}

async function execute(): Promise<void> {
  const runDir = path.resolve(arg("--run") ?? "");
  if (!arg("--run")) throw new Error("execute requires --run <run-directory>");
  const onlyArticle = arg("--article")?.replace(/\\/g, "/");
  if (!onlyArticle && !process.argv.includes("--all")) {
    throw new Error("execute requires --article <path> or --all");
  }
  const relayUrl = arg("--relay-url") ?? process.env.RELAY_URL;
  const relayToken = process.env.ARTICLE_REVIEW_RELAY_TOKEN ?? process.env.MCP_API_KEY;
  if (!relayUrl || !relayToken) throw new Error("execute requires Relay URL and token");
  assertArticleValidationConfigured();
  // The post-publish folder validation report is informational, and the relay
  // produces it by calling the platform validator while holding the request —
  // when that validator is flaky, every executor's MCP calls stall behind it.
  const skipValidationReport = process.argv.includes("--skip-validation-report");
  const selectedReviewer = reviewerConfig();
  // Re-read the manifest before every claim: other executors share the run,
  // and an item released after a service outage must be picked up again.
  const nextClaimable = async () => {
    const run = await readReviewRun(runDir);
    return run.items.find((item) =>
      reviewItemCanBeClaimed(item) && (!onlyArticle || item.article_path === onlyArticle));
  };
  if (!(await nextClaimable())) throw new Error("No matching prepared articles");

  for (let candidate = await nextClaimable(); candidate; candidate = await nextClaimable()) {
    const item = await claimReviewItem(
      runDir,
      candidate.article_path,
      selectedReviewer.provider,
      selectedReviewer.model,
    );
    if (!item) continue;
    const resultPath = path.join(item.bundle, "result.json");
    const reviewPassDetails: ReviewPassMetric[] = [];
    let prepared: string | undefined;
    try {
      const client = await createRelayReviewClient({ relayUrl, token: relayToken }, "Luc");
      const accepted = await client.read(item.relay_path);
      prepared = await fs.readFile(path.join(item.bundle, "article.md"), "utf-8");
      if (accepted !== prepared) {
        throw new Error("Relay accepted view changed since preparation; prepare a fresh run");
      }
      const reviewBase = normalizeReviewScaffolding(accepted);
      const { frontmatter: reviewFrontmatter } = splitFrontmatter(reviewBase.replace(/\r\n?/g, "\n"));
      const meta = {
        title: reviewFrontmatter.title ?? "",
        author: parseFrontmatterAuthor(reviewFrontmatter.author),
        source_url: reviewFrontmatter.source_url ?? item.source_url,
        published: reviewFrontmatter.published ?? "",
        description: reviewFrontmatter.description ?? "",
      };
      let validation = await validateArticleDraft(item.article_path, reviewBase);
      const runReviewPass = async (
        round: number,
        markdown: string,
        passMeta: ArticleMeta,
        beforeValidation: ArticleValidationResult,
        revertNotice = "",
      ) => {
        const started = Date.now();
        const metric: ReviewPassMetric = {
          pass: round + 1,
          duration_ms: 0,
          outcome: "failed",
          trigger_validator_codes: round > 0 ? validationCodes(beforeValidation) : [],
          validation_before: beforeValidation.counts,
        };
        try {
          const reviewed = await reviewArticle(
            item.bundle,
            markdown,
            passMeta,
            beforeValidation.issues,
            round,
            undefined,
            selectedReviewer,
            undefined,
            revertNotice,
          );
          metric.outcome = reviewed.review.decision;
          return reviewed;
        } catch (error) {
          metric.outcome = error instanceof ArticleReviewRejectedError ? "reject" : "failed";
          throw error;
        } finally {
          metric.duration_ms = Date.now() - started;
          reviewPassDetails.push(metric);
        }
      };
      let outcome = await runReviewPass(0, reviewBase, meta, validation);
      if (outcome.markdown === reviewBase) {
        outcome = { ...outcome, markdown: reviewBase };
      }
      validation = await validateArticleDraft(item.article_path, outcome.markdown);
      reviewPassDetails.at(-1)!.validation_after = validation.counts;
      let pendingRevertNotice = outcome.reverted.length > 0 ? buildRevertNotice(outcome.reverted) : "";
      if (pendingRevertNotice) console.log(`  reverted ${outcome.reverted.length} protected edit(s); scheduling confirmation pass`);
      for (
        let repairRound = 1;
        (!validation.valid || pendingRevertNotice) && repairRound < MAX_REVIEW_ROUNDS;
        repairRound++
      ) {
        const repairBase = outcome.markdown;
        outcome = await runReviewPass(repairRound, outcome.markdown, outcome.meta, validation, pendingRevertNotice);
        if (outcome.markdown === repairBase) {
          outcome = { ...outcome, markdown: repairBase };
        }
        validation = await validateArticleDraft(item.article_path, outcome.markdown);
        reviewPassDetails.at(-1)!.validation_after = validation.counts;
        pendingRevertNotice = outcome.reverted.length > 0 ? buildRevertNotice(outcome.reverted) : "";
        if (pendingRevertNotice) console.log(`  reverted ${outcome.reverted.length} protected edit(s); scheduling confirmation pass`);
      }
      if (pendingRevertNotice) {
        throw new Error("protected-content edits were reverted in the final review round and no round remained to confirm the result");
      }
      if (!validation.valid) throw new Error(`Reviewed article remains invalid (${validation.counts.errors} errors)`);
      const evidenceManifest = JSON.parse(await fs.readFile(path.join(item.bundle, "evidence/manifest.json"), "utf-8"));
      const reviewed = withReviewProvenance(outcome.markdown, evidenceManifest, selectedReviewer.model);
      const reviewedValidation = await validateArticleDraft(item.article_path, reviewed);
      if (!reviewedValidation.valid) {
        throw new Error(`Reviewed article provenance is invalid (${reviewedValidation.counts.errors} errors)`);
      }
      await fs.writeFile(path.join(item.bundle, "reviewed.md"), reviewed);

      const fresh = await client.read(item.relay_path);
      if (fresh !== prepared) {
        throw new Error("Relay accepted view changed before suggestions were published");
      }
      const edits = buildRelayReviewEdits(fresh, reviewed, { allowWholeDocumentFallback: false });
      for (const edit of edits) {
        try {
          await client.edit(item.relay_path, edit.old, edit.replacement);
        } catch (error) {
          // Relay's read tool cannot convey whether the document ends with a
          // newline (the decoded view always does), so an edit that reaches the
          // end of the document may carry a trailing "\n" the document lacks.
          // Retry that one case without it; anything else is a real failure.
          const eofNewlineMismatch =
            /old_string not found/.test(String(error)) &&
            edit.old.endsWith("\n") &&
            fresh.endsWith(edit.old);
          if (!eofNewlineMismatch) throw error;
          await client.edit(item.relay_path, edit.old.slice(0, -1), edit.replacement.replace(/\n$/, ""));
        }
      }
      const proposed = await client.read(item.relay_path, true);
      if (proposed !== reviewed) throw new Error("Relay accepted-draft view does not match the reviewed article");
      // The suggestions are published at this point; the folder validation
      // report is informational, so a validator outage must not turn a
      // published review into a "failed" item.
      let validationOutput: string;
      try {
        validationOutput = skipValidationReport ? "skipped (--skip-validation-report)" : await client.validateContent(true);
      } catch (error) {
        validationOutput = `unavailable: ${String(error).slice(0, 500)}`;
        console.error(`  validation report unavailable for ${item.article_path}: ${String(error).slice(0, 160)}`);
      }
      const reviewUrl = await client.getUrl(item.relay_path);
      await fs.writeFile(resultPath, JSON.stringify({
        state: "suggested",
        edits: edits.length,
        review_url: reviewUrl.trim(),
        review_passes: reviewPassDetails.length,
        review_pass_details: reviewPassDetails,
        review_provider: selectedReviewer.provider,
        review_model: selectedReviewer.model,
        validation: validationOutput.slice(0, 20_000),
      }, null, 2));
      await finishReviewItem(runDir, item.article_path, "suggested");
      console.log(`suggested ${item.article_path}\n${reviewUrl.trim()}`);
    } catch (error) {
      const message = error instanceof ArticleReviewRejectedError ? error.reason : String(error);
      if (isArticleValidationOutage(error)) {
        // The validation service is down, not this article. Failing every
        // remaining claim would just burn through the run, so wait for the
        // service instead; an item whose bundle the reviewer never touched
        // goes back to "prepared" and is claimed again once it recovers.
        if (reviewPassDetails.length === 0) {
          await releaseReviewItem(runDir, item.article_path);
          console.error(`released  ${item.article_path}: ${message.slice(0, 200)}`);
        } else {
          await fs.writeFile(resultPath, JSON.stringify({ state: "failed", error: message, review_passes: reviewPassDetails.length, review_pass_details: reviewPassDetails, review_provider: selectedReviewer.provider, review_model: selectedReviewer.model }, null, 2));
          await finishReviewItem(runDir, item.article_path, "failed", message);
          console.error(`failed    ${item.article_path}: ${message.slice(0, 200)}`);
        }
        console.error("Article validation service is unavailable; waiting for it to recover");
        await waitForArticleValidation();
        continue;
      }
      if (isReviewerUnavailable(error) && prepared !== undefined) {
        // The reviewer itself is rate-limited (per-minute 429, or the
        // subscription's session window). The reviewer replaces the bundle's
        // article.md with its own working copy, so put the prepared copy back
        // and release the item; then stop rather than burn the rest of the run.
        await fs.writeFile(path.join(item.bundle, "article.md"), prepared);
        await releaseReviewItem(runDir, item.article_path);
        console.error(`released  ${item.article_path}: ${message.slice(0, 200)}`);
        throw new Error("Reviewer is rate-limited; stopping this executor");
      }
      await fs.writeFile(resultPath, JSON.stringify({
        state: "failed",
        error: message,
        review_passes: reviewPassDetails.length,
        review_pass_details: reviewPassDetails,
        review_provider: selectedReviewer.provider,
        review_model: selectedReviewer.model,
      }, null, 2));
      await finishReviewItem(runDir, item.article_path, "failed", message);
      console.error(`failed    ${item.article_path}: ${message}`);
    }
  }
}

async function prune(): Promise<void> {
  const cacheRoot = path.resolve(arg("--cache-root") ?? path.join(process.cwd(), ".article-review-cache"));
  const days = Number(arg("--days") ?? 30);
  const cutoff = Date.now() - days * 86_400_000;
  for (const name of await fs.readdir(cacheRoot).catch(() => [])) {
    const full = path.join(cacheRoot, name);
    const stat = await fs.stat(full);
    if (stat.isDirectory() && stat.mtimeMs < cutoff) {
      await fs.rm(full, { recursive: true });
      console.log(`pruned ${full}`);
    }
  }
}

async function summarizeReports(): Promise<void> {
  const root = path.resolve(arg("--report-root") ?? process.env.ARTICLE_REVIEW_REPORT_DIR ?? "/data/lens-editor/article-review-reports");
  const since = arg("--since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const summary = {
    since,
    reports: 0,
    outcomes: {} as Record<string, number>,
    repair_classifications: {} as Record<string, number>,
    repair_codes: {} as Record<string, number>,
    validator_codes: {} as Record<string, number>,
    validator_fixed_codes: {} as Record<string, number>,
    validator_remaining_codes: {} as Record<string, number>,
    validator_introduced_codes: {} as Record<string, number>,
    llm_finding_codes: {} as Record<string, number>,
    llm_unrepaired_codes: {} as Record<string, number>,
    extraction_methods: {} as Record<string, number>,
    review_pass_counts: {} as Record<string, number>,
    extra_pass_trigger_codes: {} as Record<string, number>,
    llm_pass_durations_ms: {} as Record<
      string,
      { attempts: number; total_duration_ms: number; average_duration_ms: number }
    >,
  };
  const increment = (record: Record<string, number>, key: string) => {
    record[key] = (record[key] ?? 0) + 1;
  };
  for (const day of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!day.isDirectory() || day.name < since) continue;
    const dayPath = path.join(root, day.name);
    for (const run of await fs.readdir(dayPath, { withFileTypes: true }).catch(() => [])) {
      if (!run.isDirectory()) continue;
      const report = await fs.readFile(path.join(dayPath, run.name, "report.json"), "utf-8")
        .then(JSON.parse)
        .catch(() => null);
      if (!report) continue;
      summary.reports += 1;
      increment(summary.outcomes, String(report.outcome ?? "unknown"));
      const llmEvents = (report.events ?? []).filter(
        (event: Record<string, unknown>) =>
          event.kind === "llm-review" || event.kind === "llm-review-failed",
      );
      const reportedPasses = Number(report.summary?.llm_review_passes);
      const reviewPasses = Number.isInteger(reportedPasses) ? reportedPasses : llmEvents.length;
      increment(summary.review_pass_counts, String(reviewPasses));
      let lastValidationCodes: string[] = [];
      for (const event of report.events ?? []) {
        if (event.kind === "extraction" && event.via) increment(summary.extraction_methods, String(event.via));
        if (event.kind === "repair" && event.classification) {
          increment(summary.repair_classifications, String(event.classification));
          if (event.code) increment(summary.repair_codes, String(event.code));
        }
        if (event.kind === "llm-review") {
          for (const finding of event.findings ?? []) {
            increment(summary.llm_finding_codes, String(finding.code ?? "unknown"));
          }
          for (const repair of event.applied === false ? [] : event.repairs ?? []) {
            increment(summary.repair_classifications, String(repair.classification ?? "unknown"));
            increment(summary.repair_codes, String(repair.finding_code ?? "unknown"));
          }
          for (const change of event.metadata_changes ?? []) {
            increment(summary.repair_classifications, String(change.classification ?? "unknown"));
            increment(summary.repair_codes, String(change.code ?? "metadata.unknown"));
          }
        }
        if (event.kind === "llm-review" || event.kind === "llm-review-failed") {
          const pass = Number(event.round) + 1;
          const key = Number.isInteger(pass) ? String(pass) : "unknown";
          const duration = summary.llm_pass_durations_ms[key] ?? {
            attempts: 0,
            total_duration_ms: 0,
            average_duration_ms: 0,
          };
          duration.attempts += 1;
          duration.total_duration_ms += Number(event.duration_ms) || 0;
          duration.average_duration_ms = Math.round(duration.total_duration_ms / duration.attempts);
          summary.llm_pass_durations_ms[key] = duration;
          const explicitTriggers = Array.isArray(event.trigger_validator_codes)
            ? event.trigger_validator_codes.map(String)
            : null;
          const triggerCodes = explicitTriggers ?? (Number(event.round) > 0 ? lastValidationCodes : []);
          for (const code of new Set(triggerCodes)) increment(summary.extra_pass_trigger_codes, code);
        }
        if (event.kind === "validation") {
          for (const issue of event.issues ?? []) increment(summary.validator_codes, String(issue.code ?? "uncoded"));
          lastValidationCodes = [...new Set(
            (event.issues ?? []).map((issue: { code?: unknown }) => String(issue.code ?? "uncoded")),
          )];
        }
      }
      for (const issue of report.lifecycle?.validator_fixed ?? []) {
        increment(summary.validator_fixed_codes, String(issue.code ?? "uncoded"));
      }
      for (const issue of report.lifecycle?.validator_remaining ?? []) {
        increment(summary.validator_remaining_codes, String(issue.code ?? "uncoded"));
      }
      for (const issue of report.lifecycle?.validator_introduced ?? []) {
        increment(summary.validator_introduced_codes, String(issue.code ?? "uncoded"));
      }
      for (const finding of report.lifecycle?.llm_findings_unrepaired ?? []) {
        increment(summary.llm_unrepaired_codes, String(finding.code ?? "unknown"));
      }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

const command = process.argv[2];
try {
  if (command === "prepare") await prepare();
  else if (command === "execute") await execute();
  else if (command === "status") await status();
  else if (command === "prune") await prune();
  else if (command === "summarize-reports") await summarizeReports();
  else throw new Error(
    "Usage: article-review <prepare|execute|status|prune|summarize-reports> ... " +
    "[--provider claude|codex] [--model <model>] [--max-budget-usd <amount>] " +
    "[--timeout-minutes <minutes>] [--pace-ms <ms>] [--skip-validation-report]",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
