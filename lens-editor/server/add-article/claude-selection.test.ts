import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewArticle, resolveArticleReviewerConfig } from "./claude";

const temporaryPaths: string[] = [];
const originalBinary = process.env.ARTICLE_REVIEW_CODEX_BIN;

afterEach(async () => {
  if (originalBinary === undefined) delete process.env.ARTICLE_REVIEW_CODEX_BIN;
  else process.env.ARTICLE_REVIEW_CODEX_BIN = originalBinary;
  await Promise.all(temporaryPaths.splice(0).map((entry) =>
    fs.rm(entry, { recursive: true, force: true })));
});

function candidate(body: string): string {
  return `---
title: "Candidate"
author:
  - "Author"
source_url: "https://example.org/article"
published: 2026-01-02
created: 2026-08-29
accessed: 2026-08-29
description: ""
tags:
  - "article-importer"
---

%%
Add discussion note here:

...

%%

${body}
`;
}

async function fixture(fakeBody: string): Promise<{ workDir: string; fake: string }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dual-candidate-review-"));
  temporaryPaths.push(workDir);
  await fs.mkdir(path.join(workDir, "evidence"));
  await fs.writeFile(path.join(workDir, "evidence", "source-rendered.html"), "<article>source</article>");
  const fake = path.join(workDir, "fake-codex.mjs");
  await fs.writeFile(fake, `#!/usr/bin/env node
${fakeBody}
`);
  await fs.chmod(fake, 0o755);
  process.env.ARTICLE_REVIEW_CODEX_BIN = fake;
  return { workDir, fake };
}

describe("dual-candidate article review", () => {
  it("uses Claude's recorded base as the immutable review original", async () => {
    const { workDir, fake } = await fixture(`
import fs from "node:fs";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
const status = args[args.indexOf("--output-last-message") + 1];
fs.copyFileSync(cwd + "/candidate-unrendered.md", cwd + "/article.md");
fs.chmodSync(cwd + "/article.md", 0o600);
if (fs.existsSync(cwd + "/validation.json")) process.exit(12);
fs.copyFileSync(process.env.ARTICLE_REVIEW_RENDERED_VALIDATION_PATH, cwd + "/validation-rendered.json");
fs.copyFileSync(process.env.ARTICLE_REVIEW_UNRENDERED_VALIDATION_PATH, cwd + "/validation-unrendered.json");
fs.copyFileSync(cwd + "/validation-unrendered.json", cwd + "/validation.json");
fs.writeFileSync(cwd + "/.base-selection.json", JSON.stringify({ base: "unrendered" }));
fs.appendFileSync(cwd + "/article.md", "Recovered complementary passage.\\n");
fs.writeFileSync(status, "PASS\\n");
`);
    const rendered = candidate("Rendered body.");
    const unrendered = candidate("Unrendered body.");
    const outcome = await reviewArticle(
      workDir,
      rendered,
      { title: "Candidate", author: ["Author"], source_url: "https://example.org/article", published: "2026-01-02", description: "" },
      [],
      0,
      undefined,
      { ...resolveArticleReviewerConfig("codex"), timeoutMs: 5_000 },
      {
        rendered,
        unrendered,
        validation: {
          rendered: [{ severity: "error", code: "rendered-problem", message: "rendered" }],
          unrendered: [{ severity: "warning", code: "unrendered-problem", message: "unrendered" }],
        },
      },
    );

    expect(outcome.selectedBase).toBe("unrendered");
    expect(outcome.originalMarkdown).toBe(unrendered);
    expect(outcome.markdown).toContain("Unrendered body.");
    expect(outcome.markdown).toContain("Recovered complementary passage.");
    expect(outcome.markdown).not.toContain("Rendered body.");
    expect(JSON.parse(await fs.readFile(path.join(workDir, "validation.json"), "utf-8")))
      .toEqual([{ severity: "warning", code: "unrendered-problem", message: "unrendered" }]);
    expect(JSON.parse(await fs.readFile(path.join(workDir, "validation-rendered.json"), "utf-8")))
      .toEqual([{ severity: "error", code: "rendered-problem", message: "rendered" }]);
    expect(JSON.parse(await fs.readFile(path.join(workDir, "validation-unrendered.json"), "utf-8")))
      .toEqual([{ severity: "warning", code: "unrendered-problem", message: "unrendered" }]);

    // A later pass replaces the now-read-only selected validation report with
    // findings for the current article while retaining both original reports.
    await fs.chmod(path.join(workDir, "validation.json"), 0o400);
    await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
const status = args[args.indexOf("--output-last-message") + 1];
fs.appendFileSync(cwd + "/article.md", "Second-pass repair.\\n");
fs.writeFileSync(status, "PASS\\n");
`);
    await fs.chmod(fake, 0o755);
    const repaired = await reviewArticle(
      workDir,
      outcome.markdown,
      outcome.meta,
      [{ severity: "error", code: "current-problem", message: "current" }],
      1,
      undefined,
      { ...resolveArticleReviewerConfig("codex"), timeoutMs: 5_000 },
    );
    expect(repaired.markdown).toContain("Second-pass repair.");
    expect(JSON.parse(await fs.readFile(path.join(workDir, "validation.json"), "utf-8")))
      .toEqual([{ severity: "error", code: "current-problem", message: "current" }]);
    expect(JSON.parse(await fs.readFile(path.join(workDir, "validation-rendered.json"), "utf-8")))
      .toEqual([{ severity: "error", code: "rendered-problem", message: "rendered" }]);
  });

  it("fails closed when a passing reviewer skips base selection", async () => {
    const { workDir } = await fixture(`
import fs from "node:fs";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
const status = args[args.indexOf("--output-last-message") + 1];
fs.copyFileSync(cwd + "/candidate-rendered.md", cwd + "/article.md");
fs.writeFileSync(status, "PASS\\n");
`);
    const rendered = candidate("Rendered body.");
    const unrendered = candidate("Unrendered body.");
    await expect(reviewArticle(
      workDir,
      rendered,
      { title: "Candidate", author: ["Author"], source_url: "https://example.org/article", published: "2026-01-02", description: "" },
      [],
      0,
      undefined,
      { ...resolveArticleReviewerConfig("codex"), timeoutMs: 5_000 },
      { rendered, unrendered, validation: { rendered: [], unrendered: [] } },
    )).rejects.toThrow("without selecting a review base");
  });
});
