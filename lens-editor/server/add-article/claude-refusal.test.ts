import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMocks = vi.hoisted(() => ({ spawnClaude: vi.fn() }));
vi.mock("../add-video/claude", () => spawnMocks);

import {
  isClaudeRefusal,
  reviewArticle,
  scaledReviewBudgetUsd,
} from "./claude";

const refusalStdout = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result:
    "API Error: Sonnet 5 can't help with this. Start a new session to continue.\n\n" +
    "Learn more: https://www.anthropic.com/legal/aup\n\nDetails: `[bio]`",
});
const passStdout = JSON.stringify({ type: "result", is_error: false, result: "PASS" });

const article = `---
title: "Title"
author:
  - "An Author"
source_url: "https://example.com/source"
published: 2026-06-16
created: 2026-08-25
accessed: 2026-08-25
description: "Description"
tags:
  - "article-importer"
---

%%
Add discussion note here:

...

%%

Body text.
`;

function argValue(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

describe("isClaudeRefusal", () => {
  it("recognises a usage-policy refusal in CLI JSON", () => {
    expect(isClaudeRefusal(refusalStdout)).toBe(true);
    expect(isClaudeRefusal(JSON.stringify({ stop_reason: "refusal", result: "" }))).toBe(true);
  });

  it("does not treat other failures as refusals", () => {
    expect(isClaudeRefusal(JSON.stringify({ is_error: true, result: "Error: max budget exceeded" }))).toBe(false);
    expect(isClaudeRefusal("spawn claude ENOENT")).toBe(false);
    expect(isClaudeRefusal("")).toBe(false);
  });
});

describe("scaledReviewBudgetUsd", () => {
  it("is $10 per started 50k chars, between $10 and $30", () => {
    expect(scaledReviewBudgetUsd(0)).toBe(10);
    expect(scaledReviewBudgetUsd(50_000)).toBe(10);
    expect(scaledReviewBudgetUsd(50_001)).toBe(20);
    expect(scaledReviewBudgetUsd(120_000)).toBe(30);
    expect(scaledReviewBudgetUsd(1_000_000)).toBe(30);
  });
});

describe("reviewArticle refusal fallback", () => {
  let workDir: string;
  beforeEach(async () => {
    spawnMocks.spawnClaude.mockReset();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-refusal-"));
  });

  it("retries a refused pass once on opus and reports the model used", async () => {
    spawnMocks.spawnClaude
      .mockResolvedValueOnce({ exitCode: 1, stdout: refusalStdout, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: passStdout, stderr: "" });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.review.decision).toBe("pass");
    expect(outcome.model).toBe("opus");
    const models = spawnMocks.spawnClaude.mock.calls.map((call) => argValue(call[2], "--model"));
    expect(models).toEqual(["sonnet", "opus"]);
  });

  it("does not retry a failure that is not a refusal", async () => {
    spawnMocks.spawnClaude.mockResolvedValueOnce({
      exitCode: 1,
      stdout: JSON.stringify({ is_error: true, result: "Error: something else" }),
      stderr: "",
    });
    await expect(reviewArticle(workDir, article, {} as never, [], 1))
      .rejects.toThrow(/Mandatory article LLM review failed/);
    expect(spawnMocks.spawnClaude).toHaveBeenCalledOnce();
  });

  it("fails when the fallback model also refuses", async () => {
    spawnMocks.spawnClaude.mockResolvedValue({ exitCode: 1, stdout: refusalStdout, stderr: "" });
    await expect(reviewArticle(workDir, article, {} as never, [], 1))
      .rejects.toThrow(/can't help with this/);
    expect(spawnMocks.spawnClaude).toHaveBeenCalledTimes(2);
  });

  it("scales the per-pass budget with article length unless one is configured", async () => {
    spawnMocks.spawnClaude.mockResolvedValue({ exitCode: 0, stdout: passStdout, stderr: "" });
    const long = article + "x".repeat(80_000);
    await reviewArticle(workDir, long, {} as never, [], 1);
    await reviewArticle(workDir, long, {} as never, [], 1, undefined, {
      provider: "claude",
      model: "sonnet",
      maxBudgetUsd: 5,
    });
    const budgets = spawnMocks.spawnClaude.mock.calls.map((call) => argValue(call[2], "--max-budget-usd"));
    expect(budgets).toEqual(["20", "5"]);
  });
});
