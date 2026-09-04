import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimReviewItem,
  finishReviewItem,
  readReviewRun,
  releaseReviewItem,
  writeReviewRun,
  type ReviewRun,
} from "../../scripts/article-review-manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeRun(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "article-manifest-test-"));
  roots.push(root);
  const run: ReviewRun = {
    version: 1,
    run_id: "test",
    created_at: new Date().toISOString(),
    content_root: "/content",
    items: ["one.md", "two.md"].map((article_path) => ({
      article_path,
      relay_path: `Lens Edu/${article_path}`,
      source_url: "https://example.com",
      bundle: path.join(root, article_path),
      state: "prepared" as const,
    })),
    batches: [["one.md", "two.md"]],
  };
  await writeReviewRun(root, run);
  return root;
}

describe("article review manifest", () => {
  it("allows only one concurrent claim of an article", async () => {
    const root = await makeRun();
    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      claimReviewItem(root, "one.md", "codex", "gpt-5.6-terra")));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await readReviewRun(root)).items[0]).toMatchObject({
      state: "running",
      review_provider: "codex",
      review_model: "gpt-5.6-terra",
    });
  });

  it("preserves independent concurrent item updates", async () => {
    const root = await makeRun();
    await Promise.all([
      claimReviewItem(root, "one.md", "claude", "sonnet"),
      claimReviewItem(root, "two.md", "codex", "gpt-5.6-terra"),
    ]);
    await Promise.all([
      finishReviewItem(root, "one.md", "suggested"),
      finishReviewItem(root, "two.md", "failed", "no evidence"),
    ]);
    const run = await readReviewRun(root);
    expect(run.items.map(({ state }) => state).sort()).toEqual(["failed", "suggested"]);
    expect(run.items.find(({ article_path }) => article_path === "two.md")?.error).toBe("no evidence");
  });

  it("recovers a stale lock", async () => {
    const root = await makeRun();
    const lock = path.join(root, ".manifest.lock");
    await fs.writeFile(lock, "orphaned");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    expect(await claimReviewItem(root, "one.md", "claude", "sonnet")).not.toBeNull();
  });

  it("reclaims an abandoned running item after its review timeout", async () => {
    const root = await makeRun();
    await claimReviewItem(root, "one.md", "claude", "sonnet");
    const run = await readReviewRun(root);
    run.items[0].started_at = new Date(Date.now() - 20 * 60_000).toISOString();
    await writeReviewRun(root, run);
    expect(await claimReviewItem(root, "one.md", "codex", "gpt-5.6-terra")).toMatchObject({
      state: "running",
      review_provider: "codex",
    });
  });

  it("releases a claimed item back to prepared so another executor can claim it", async () => {
    const root = await makeRun();
    const claimed = await claimReviewItem(root, "one.md", "claude", "sonnet");
    expect(claimed?.state).toBe("running");
    expect(await claimReviewItem(root, "one.md", "claude", "sonnet")).toBeNull();
    await releaseReviewItem(root, "one.md");
    const run = await readReviewRun(root);
    expect(run.items[0]).toMatchObject({ state: "prepared" });
    expect(run.items[0].started_at).toBeUndefined();
    expect(await claimReviewItem(root, "one.md", "claude", "sonnet")).toMatchObject({ state: "running" });
  });
});
