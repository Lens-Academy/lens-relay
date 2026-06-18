import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFixture } from "./fixture-io";
import { scoreFixture } from "../../../scripts/eval-fixtures";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "score-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("scoreFixture (hermetic, real extractArticle)", () => {
  it("scores a generic-path fixture against gold with high recall", async () => {
    const html = `<!doctype html><html><head><title>Post</title></head><body><article>
      <h1>Post</h1><p>${"This is the real article body sentence that should survive extraction cleanly. ".repeat(20)}</p>
      </article></body></html>`;
    const gold = `${"This is the real article body sentence that should survive extraction cleanly. ".repeat(20)}`;
    await writeFixture("generic-fix", {
      renderedSourceHtml: html, expectedMd: gold,
      meta: { slug: "generic-fix", source_url: "https://example.com/post",
              resolved_fetch_url: "https://example.com/post", expected_via: "generic",
              needs_body_markdown: false, title: "Post", author: [], published: "" },
    }, root);

    const s = await scoreFixture("generic-fix", root);
    expect(s.body.recall).toBeGreaterThan(0.8);
    expect(["defuddle", "readability"]).toContain(s.via); // generic set
  });
});
