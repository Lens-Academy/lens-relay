#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildSourceEvidence, writeSourceEvidence } from "../server/add-article/source-evidence";
import { parseFrontmatterAuthor, splitFrontmatter } from "../server/add-article/eval/edu-repo";
import { articleReviewDigest } from "../server/add-article/review-digest";
import { createRelayReviewClient, readAcceptedRelayMarkdown } from "../server/add-article/relay-review-read";
import {
  ArticleReviewRejectedError,
  REVIEW_MODEL,
  REVIEW_VERSION,
  reviewArticle,
} from "../server/add-article/claude";
import { validateArticleDraft } from "../server/add-article/platform-validation";
import { buildRelayReviewEdits } from "../server/add-article/review-diff";
import { normalizeReviewScaffolding } from "../server/add-article/review-scaffolding";

interface ReviewItem {
  article_path: string;
  relay_path: string;
  source_url: string;
  bundle: string;
  base_digest: string;
  base_sha256?: string;
  state: "prepared" | "suggested" | "reviewed" | "failed";
  error?: string;
}

interface ReviewRun {
  version: 1;
  run_id: string;
  created_at: string;
  content_root: string;
  items: ReviewItem[];
  batches: string[][];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  return `${path.basename(relative, ".md").slice(0, 60).replace(/[^a-zA-Z0-9-]/g, "-")}-${createHash("sha1").update(relative).digest("hex").slice(0, 8)}`;
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
  await fs.mkdir(runDir, { recursive: true });
  const items: ReviewItem[] = [];

  for (const relative of await selectedPaths(contentRoot)) {
    const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const full = path.resolve(contentRoot, normalized);
    if (!full.startsWith(`${contentRoot}${path.sep}`)) throw new Error(`Unsafe article path: ${relative}`);
    await fs.stat(full);
    const relayPath = `${relayFolder.replace(/\/+$/, "")}/${normalized}`;
    const markdown = await readAcceptedRelayMarkdown(relayPath, { relayUrl, token: relayToken });
    const { frontmatter } = splitFrontmatter(markdown);
    if (!frontmatter.source_url || frontmatter.tags?.includes("article-stub")) continue;
    const bundle = path.join(runDir, safeId(normalized));
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, "article.md"), markdown);
    const item: ReviewItem = {
      article_path: normalized,
      relay_path: relayPath,
      source_url: frontmatter.source_url,
      bundle,
      base_digest: articleReviewDigest(markdown),
      base_sha256: createHash("sha256").update(markdown).digest("hex"),
      state: "prepared",
    };
    try {
      const evidence = await buildSourceEvidence(frontmatter.source_url);
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
  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(run, null, 2));
  console.log(`\nPrepared ${items.length} articles in ${runDir} (${batches.length} batches of at most five).`);
}

function instructions(item: ReviewItem): string {
  return `# Retroactive article review

This bundle is processed by the same direct-edit reviewer used for new imports. Run \`article-review execute\` for \`${item.article_path}\`; it will compare \`article.md\` with \`evidence/\`, verify that \`${item.relay_path}\` has not changed, and publish the reviewed diff as CriticMarkup suggestions through Relay. It does not modify the local content checkout or accept its own suggestions.
`;
}

async function digest(): Promise<void> {
  const file = arg("--file");
  if (!file) throw new Error("digest requires --file <accepted-draft.md>");
  const markdown = await fs.readFile(path.resolve(file), "utf-8");
  console.log(JSON.stringify({
    file: path.resolve(file),
    view: "accepted-draft",
    digest: articleReviewDigest(markdown),
  }, null, 2));
}

async function status(): Promise<void> {
  const runDir = path.resolve(arg("--run") ?? "");
  if (!arg("--run")) throw new Error("status requires --run <run-directory>");
  const run = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf-8")) as ReviewRun;
  const counts: Record<string, number> = {};
  for (const item of run.items) {
    const result = await fs.readFile(path.join(item.bundle, "result.json"), "utf-8").then(JSON.parse).catch(() => null);
    const state = result?.state ?? item.state;
    counts[state] = (counts[state] ?? 0) + 1;
    console.log(`${state.padEnd(10)} ${item.article_path}`);
  }
  console.log(`\n${JSON.stringify(counts)}`);
}

function withReviewProvenance(markdown: string, manifest: Record<string, unknown>): string {
  const opening = markdown.match(/^---\r?\n/);
  if (!opening) throw new Error("Reviewed article has no frontmatter");
  const closing = /^---\s*$/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(markdown);
  if (!match) throw new Error("Reviewed article has unclosed frontmatter");
  let frontmatter = markdown.slice(opening[0].length, match.index);
  frontmatter = frontmatter.replace(/^llm-review:\r?\n(?:^[ \t].*(?:\r?\n|$))*/m, "");
  const digest = articleReviewDigest(markdown);
  const reviewed = new Date().toISOString().slice(0, 10);
  const sourceDigest = String(manifest.source_digest ?? "");
  const sourceFetched = String(manifest.fetched_at ?? reviewed).slice(0, 10);
  const sourceKind = String(manifest.source_kind ?? "live");
  const provenance = [
    "llm-review:",
    `  content-sha: "${digest}"`,
    `  date: ${reviewed}`,
    `  model: "${REVIEW_MODEL}"`,
    `  version: "${REVIEW_VERSION}"`,
    "  source:",
    `    content-sha: "${sourceDigest}"`,
    `    fetched: ${sourceFetched}`,
    `    kind: "${sourceKind}"`,
  ].join("\n");
  const reviewed = `${opening[0]}${frontmatter.trimEnd()}\n${provenance}\n---${markdown.slice(match.index + match[0].length)}`;
  return reviewed.endsWith("\n") ? reviewed : `${reviewed}\n`;
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
  const run = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf-8")) as ReviewRun;
  const items = run.items.filter((item) => item.state === "prepared" && (!onlyArticle || item.article_path === onlyArticle));
  if (!items.length) throw new Error("No matching prepared articles");

  for (const item of items) {
    const resultPath = path.join(item.bundle, "result.json");
    try {
      const client = await createRelayReviewClient({ relayUrl, token: relayToken }, "Luc");
      const accepted = await client.read(item.relay_path);
      const prepared = await fs.readFile(path.join(item.bundle, "article.md"), "utf-8");
      const baseSha256 = item.base_sha256 ?? createHash("sha256").update(prepared).digest("hex");
      if (createHash("sha256").update(accepted).digest("hex") !== baseSha256) {
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
      let outcome = await reviewArticle(item.bundle, reviewBase, meta, validation.issues, 0);
      if (articleReviewDigest(outcome.markdown) === articleReviewDigest(reviewBase)) {
        outcome = { ...outcome, markdown: reviewBase };
      }
      validation = await validateArticleDraft(item.article_path, outcome.markdown);
      if (!validation.valid) {
        const repairBase = outcome.markdown;
        outcome = await reviewArticle(item.bundle, outcome.markdown, outcome.meta, validation.issues, 1);
        if (articleReviewDigest(outcome.markdown) === articleReviewDigest(repairBase)) {
          outcome = { ...outcome, markdown: repairBase };
        }
        validation = await validateArticleDraft(item.article_path, outcome.markdown);
      }
      if (!validation.valid) throw new Error(`Reviewed article remains invalid (${validation.counts.errors} errors)`);
      const evidenceManifest = JSON.parse(await fs.readFile(path.join(item.bundle, "evidence/manifest.json"), "utf-8"));
      const reviewed = withReviewProvenance(outcome.markdown, evidenceManifest);
      const reviewedValidation = await validateArticleDraft(item.article_path, reviewed);
      if (!reviewedValidation.valid) {
        throw new Error(`Reviewed article provenance is invalid (${reviewedValidation.counts.errors} errors)`);
      }
      await fs.writeFile(path.join(item.bundle, "reviewed.md"), reviewed);

      const fresh = await client.read(item.relay_path);
      if (createHash("sha256").update(fresh).digest("hex") !== baseSha256) {
        throw new Error("Relay accepted view changed before suggestions were published");
      }
      const edits = buildRelayReviewEdits(fresh, reviewed, { allowWholeDocumentFallback: false });
      for (const edit of edits) await client.edit(item.relay_path, edit.old, edit.replacement);
      const proposed = await client.read(item.relay_path, true);
      if (proposed !== reviewed) throw new Error("Relay accepted-draft view does not match the reviewed article");
      const validationOutput = await client.validateContent(true);
      const reviewUrl = await client.getUrl(item.relay_path);
      await fs.writeFile(resultPath, JSON.stringify({
        state: "suggested",
        edits: edits.length,
        review_url: reviewUrl.trim(),
        validation: validationOutput.slice(0, 20_000),
      }, null, 2));
      console.log(`suggested ${item.article_path}\n${reviewUrl.trim()}`);
    } catch (error) {
      const message = error instanceof ArticleReviewRejectedError ? error.reason : String(error);
      await fs.writeFile(resultPath, JSON.stringify({ state: "failed", error: message }, null, 2));
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
        if (event.kind === "validation") {
          for (const issue of event.issues ?? []) increment(summary.validator_codes, String(issue.code ?? "uncoded"));
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
  else if (command === "digest") await digest();
  else if (command === "status") await status();
  else if (command === "prune") await prune();
  else if (command === "summarize-reports") await summarizeReports();
  else throw new Error("Usage: article-review <prepare|execute|digest|status|prune|summarize-reports> ...");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
