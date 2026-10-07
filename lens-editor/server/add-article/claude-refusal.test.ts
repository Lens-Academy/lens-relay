import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMocks = vi.hoisted(() => ({ spawnClaude: vi.fn() }));
vi.mock("../add-video/claude", () => spawnMocks);

import {
  ArticleReviewRejectedError,
  ArticleReviewUnavailableError,
  claudeReplyTail,
  isClaudeRefusal,
  isUnparseableClaudeReview,
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

  it("recognises the API output content filter", () => {
    expect(isClaudeRefusal(JSON.stringify({
      is_error: true,
      result: "API Error: Output blocked by content filtering policy",
    }))).toBe(true);
    // Only as an error result, not when a successful review quotes it.
    expect(isClaudeRefusal(JSON.stringify({
      is_error: false,
      result: "The source mentions an output blocked by content filtering policy. PASS",
    }))).toBe(false);
  });

  it("does not treat other failures as refusals", () => {
    expect(isClaudeRefusal(JSON.stringify({ is_error: true, result: "Error: max budget exceeded" }))).toBe(false);
    expect(isClaudeRefusal("spawn claude ENOENT")).toBe(false);
    expect(isClaudeRefusal("")).toBe(false);
    expect(isClaudeRefusal(JSON.stringify({
      is_error: false,
      result: "Fixed the link to https://www.anthropic.com/legal/aup; the model can't help with this example.\nPASS",
    }))).toBe(false);
  });
});

describe("claudeReplyTail and isUnparseableClaudeReview", () => {
  it("takes the result from CLI JSON, else the raw text, and keeps only the end", () => {
    expect(claudeReplyTail(JSON.stringify({ result: "  I can't help.  " }))).toBe("I can't help.");
    expect(claudeReplyTail("API Error: boom")).toBe("API Error: boom");
    const long = "a".repeat(500) + "END";
    expect(claudeReplyTail(long)).toBe(`...${long.slice(-400)}`);
  });

  it("only counts a successful run without PASS/REJECT", () => {
    const decline = JSON.stringify({ is_error: false, result: "I can't help with this request." });
    expect(isUnparseableClaudeReview({ exitCode: 0, stdout: decline })).toBe(true);
    expect(isUnparseableClaudeReview({ exitCode: 1, stdout: decline })).toBe(false);
    expect(isUnparseableClaudeReview({ exitCode: 0, stdout: passStdout })).toBe(false);
    expect(isUnparseableClaudeReview({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: false, result: "REJECT: source is not an article" }),
    })).toBe(false);
    // CLI errors and non-JSON output would fail the same way on a retry.
    expect(isUnparseableClaudeReview({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: true, result: "Error: max budget exceeded" }),
    })).toBe(false);
    expect(isUnparseableClaudeReview({ exitCode: 0, stdout: "{\"type\":\"res" })).toBe(false);
  });
});

describe("scaledReviewBudgetUsd", () => {
  it("is $20 per started 50k chars, between $20 and $60", () => {
    expect(scaledReviewBudgetUsd(0)).toBe(20);
    expect(scaledReviewBudgetUsd(50_000)).toBe(20);
    expect(scaledReviewBudgetUsd(50_001)).toBe(40);
    expect(scaledReviewBudgetUsd(120_000)).toBe(60);
    expect(scaledReviewBudgetUsd(1_000_000)).toBe(60);
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

  // Prevents: a refusal on both models failing the import; it must surface
  // as "review unavailable" so the pipeline imports the article flagged.
  it("reports the review unavailable when the fallback model also refuses", async () => {
    spawnMocks.spawnClaude.mockResolvedValue({ exitCode: 1, stdout: refusalStdout, stderr: "" });
    const error = await reviewArticle(workDir, article, {} as never, [], 1).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleReviewUnavailableError);
    expect(error.kind).toBe("refused");
    expect(error.message).toMatch(/can't help with this/);
    // A refusal gets no decision-only retry.
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
    expect(budgets).toEqual(["40", "5"]);
  });

  it("also retries a refusal reported with exit code 0", async () => {
    spawnMocks.spawnClaude
      .mockResolvedValueOnce({ exitCode: 0, stdout: refusalStdout, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: passStdout, stderr: "" });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.model).toBe("opus");
  });

  it("retries a refused base-selection pass with fresh read-only candidates", async () => {
    const candidates = {
      rendered: article.replace("Body text.", "Rendered body."),
      unrendered: article.replace("Body text.", "Unrendered body."),
      validation: { rendered: [], unrendered: [] },
    };
    spawnMocks.spawnClaude
      .mockImplementationOnce(async (dir: string) => {
        // The refused attempt had already picked a base before the block.
        await fs.writeFile(path.join(dir, "article.md"), "partial edit");
        return { exitCode: 1, stdout: refusalStdout, stderr: "" };
      })
      .mockImplementationOnce(async (dir: string, _t: number, args: string[], _s: unknown, env: NodeJS.ProcessEnv) => {
        expect(argValue(args, "--model")).toBe("opus");
        await expect(fs.access(path.join(dir, "article.md"))).rejects.toThrow();
        // Do what select_review_base does for base = unrendered.
        const rendered = await fs.readFile(env.ARTICLE_REVIEW_RENDERED_VALIDATION_PATH!, "utf-8");
        const unrendered = await fs.readFile(env.ARTICLE_REVIEW_UNRENDERED_VALIDATION_PATH!, "utf-8");
        await fs.writeFile(path.join(dir, "article.md"), await fs.readFile(path.join(dir, "candidate-unrendered.md"), "utf-8"));
        await fs.writeFile(path.join(dir, "validation.json"), unrendered);
        await fs.writeFile(path.join(dir, "validation-rendered.json"), rendered);
        await fs.writeFile(path.join(dir, "validation-unrendered.json"), unrendered);
        await fs.writeFile(path.join(dir, ".base-selection.json"), JSON.stringify({ base: "unrendered" }));
        return { exitCode: 0, stdout: passStdout, stderr: "" };
      });
    const outcome = await reviewArticle(workDir, "", {} as never, [], 0, undefined, undefined, candidates);
    expect(outcome.model).toBe("opus");
    expect(outcome.selectedBase).toBe("unrendered");
    expect(outcome.markdown).toContain("Unrendered body.");
  });

  it("retries a reply without PASS/REJECT on opus, from the same article, and logs its tail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    spawnMocks.spawnClaude
      .mockImplementationOnce(async (dir: string) => {
        seen.push(await fs.readFile(path.join(dir, "article.md"), "utf-8"));
        await fs.writeFile(path.join(dir, "article.md"), "half-edited");
        return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "I can't help with this request." }), stderr: "" };
      })
      .mockImplementationOnce(async (dir: string, _t: number, args: string[]) => {
        expect(argValue(args, "--model")).toBe("opus");
        seen.push(await fs.readFile(path.join(dir, "article.md"), "utf-8"));
        return { exitCode: 0, stdout: passStdout, stderr: "" };
      });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.model).toBe("opus");
    expect(seen).toEqual([article, article]);
    expect(warn.mock.calls[0][0]).toMatch(/ended without PASS\/REJECT.*I can't help with this request/);
    warn.mockRestore();
  });

  // Prevents: a reviewer that did its work but closed with a summary
  // failing the import (8 of ready-30's sources, 4-6 Oct).
  it("asks the same session for the decision line alone after the opus retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summary = (id: string) => JSON.stringify({ is_error: false, session_id: id, result: "Done with the edits." });
    spawnMocks.spawnClaude
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary("s-sonnet"), stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary("s-opus"), stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: passStdout, stderr: "" });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1, new AbortController().signal);
    expect(outcome.review).toEqual({ decision: "pass", reason: "" });
    expect(outcome.model).toBe("opus");
    const calls = spawnMocks.spawnClaude.mock.calls;
    expect(calls).toHaveLength(3);
    const decisionArgs = calls[2][2] as string[];
    expect(argValue(decisionArgs, "--resume")).toBe("s-opus");
    expect(argValue(decisionArgs, "--model")).toBe("opus");
    expect(argValue(decisionArgs, "--tools")).toBe("");
    expect(argValue(decisionArgs, "--max-turns")).toBe("1");
    // Inside a job (a signal), every pass waits for a pool slot without the
    // 30-min backstop; the job deadline bounds it.
    for (const call of calls) expect(call[5]).toEqual({ acquireTimeoutMs: Infinity });
    warn.mockRestore();
  });

  // Prevents: a batch script without a signal hanging forever on a leaked slot.
  it("keeps the pool backstop when there is no job signal", async () => {
    spawnMocks.spawnClaude.mockResolvedValue({ exitCode: 0, stdout: passStdout, stderr: "" });
    await reviewArticle(workDir, article, {} as never, [], 1);
    expect(spawnMocks.spawnClaude.mock.calls[0][5]).toEqual({});
  });

  it("honours a REJECT given in the decision-only retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summary = JSON.stringify({ is_error: false, session_id: "s1", result: "Done." });
    spawnMocks.spawnClaude
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ is_error: false, result: "REJECT: only an abstract" }),
        stderr: "",
      });
    const error = await reviewArticle(workDir, article, {} as never, [], 1).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleReviewRejectedError);
    expect(error.reason).toBe("only an abstract");
    warn.mockRestore();
  });

  // Prevents: an import failing because no reply ever said PASS/REJECT; the
  // pass's edits are kept and the article is flagged instead.
  it("returns an unconfirmed pass when no retry yields a decision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMocks.spawnClaude.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: false, session_id: "s1", result: "Done with the edits." }),
      stderr: "",
    });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.review).toEqual({ decision: "pass", reason: "", unconfirmed: true });
    expect(spawnMocks.spawnClaude).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("leaves the pass unconfirmed when the decision-only retry errors out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summary = JSON.stringify({ is_error: false, session_id: "s1", result: "Done." });
    spawnMocks.spawnClaude
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ is_error: true, result: "Error: budget exceeded" }),
        stderr: "",
      });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.review.unconfirmed).toBe(true);
    warn.mockRestore();
  });

  it("skips the decision-only retry when the reply carries no session id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMocks.spawnClaude.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: false, result: "Done with the edits." }),
      stderr: "",
    });
    const outcome = await reviewArticle(workDir, article, {} as never, [], 1);
    expect(outcome.review.unconfirmed).toBe(true);
    expect(spawnMocks.spawnClaude).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  // Prevents: an unconfirmed base-selection pass writing an article whose
  // base was never chosen; it must fall back to the unreviewed import.
  it("reports no-decision when an unconfirmed base-selection pass chose no base", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMocks.spawnClaude.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: false, result: "Done with the edits." }),
      stderr: "",
    });
    const error = await reviewArticle(
      workDir,
      article,
      {} as never,
      [],
      0,
      undefined,
      undefined,
      { rendered: article, unrendered: article, validation: { rendered: [], unrendered: [] } },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleReviewUnavailableError);
    expect(error.kind).toBe("no-decision");
    warn.mockRestore();
  });

  // Prevents: the API's output filter (exit 1, "Output blocked by content
  // filtering policy") being treated as an ordinary crash with no fallback.
  it("treats the API content filter as a refusal: opus retry, then unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: null,
      result: "API Error: Output blocked by content filtering policy",
    });
    spawnMocks.spawnClaude.mockResolvedValue({ exitCode: 1, stdout: blocked, stderr: "" });
    const error = await reviewArticle(workDir, article, {} as never, [], 1).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleReviewUnavailableError);
    expect(error.flagReason).toBe("Claude's content filter blocked the review");
    const models = spawnMocks.spawnClaude.mock.calls.map((call) => argValue(call[2], "--model"));
    expect(models).toEqual(["sonnet", "opus"]);
    warn.mockRestore();
  });
});
