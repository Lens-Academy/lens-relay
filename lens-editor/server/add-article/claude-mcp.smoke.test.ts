import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewArticle, resolveArticleReviewerConfig } from "./claude";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) =>
    fs.rm(entry, { recursive: true, force: true })));
});

function candidate(body: string): string {
  return `---
title: "Base Selection Smoke Test"
author:
  - "Lens Academy"
source_url: "https://example.org/base-selection-smoke"
published: 2026-08-29
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

describe.runIf(process.env.RUN_CLAUDE_ARTICLE_SMOKE === "1")(
  "real Claude MCP article review",
  () => {
    it("selects the complete candidate and edits without Bash", async () => {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-mcp-review-smoke-"));
      temporaryPaths.push(workDir);
      await fs.mkdir(path.join(workDir, "evidence"));
      const source = `<article><h1>Base Selection Smoke Test</h1><p>Opening paragraph.</p><p>This indispensable middle paragraph appears in the source.</p><p>Closing paragraph.</p></article>`;
      await Promise.all([
        fs.writeFile(path.join(workDir, "evidence", "source-rendered.html"), source),
        fs.writeFile(path.join(workDir, "evidence", "source-unrendered.html"), source),
        fs.writeFile(path.join(workDir, "evidence", "manifest.json"), JSON.stringify({
          source_url: "https://example.org/base-selection-smoke",
          fetched_at: "2026-08-29T00:00:00.000Z",
        })),
      ]);

      const rendered = candidate("Opening paragraph.\n\nClosing paragraph.");
      const unrendered = candidate(
        "Opening paragraph.\n\nThis indispensable middle paragraph appears in the source.\n\nClosing paragraph.",
      );
      const outcome = await reviewArticle(
        workDir,
        rendered,
        {
          title: "Base Selection Smoke Test",
          author: ["Lens Academy"],
          source_url: "https://example.org/base-selection-smoke",
          published: "2026-08-29",
          description: "",
        },
        [],
        0,
        undefined,
        {
          ...resolveArticleReviewerConfig("claude", "sonnet"),
          maxBudgetUsd: 1,
          timeoutMs: 3 * 60_000,
        },
        {
          rendered,
          unrendered,
          validation: { rendered: [], unrendered: [] },
        },
      );

      expect(outcome.review.decision).toBe("pass");
      expect(outcome.selectedBase).toBe("unrendered");
      expect(outcome.markdown).toContain("This indispensable middle paragraph appears in the source.");
    }, 4 * 60_000);
  },
);
