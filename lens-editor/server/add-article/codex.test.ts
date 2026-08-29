import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexVerifyPrompt,
  parseCodexReviewStatus,
  runCodexArticleVerify,
} from "./codex";

const temporaryPaths: string[] = [];
const originalBinary = process.env.ARTICLE_REVIEW_CODEX_BIN;

afterEach(async () => {
  if (originalBinary === undefined) delete process.env.ARTICLE_REVIEW_CODEX_BIN;
  else process.env.ARTICLE_REVIEW_CODEX_BIN = originalBinary;
  await Promise.all(temporaryPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-review-test-"));
  temporaryPaths.push(root);
  await fs.mkdir(path.join(root, "evidence"));
  await fs.writeFile(path.join(root, "article.md"), "before\n");
  await fs.writeFile(path.join(root, "validation.json"), "[]\n");
  await fs.writeFile(path.join(root, "evidence", "source-rendered.html"), "<p>after</p>");
  return root;
}

describe("Codex article reviewer", () => {
  it("uses an ephemeral, config-free, network-disabled workspace-write invocation", () => {
    const args = buildCodexArgs("/tmp/review", "/tmp/review/status", "gpt-5.6-terra", 1);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("workspace-write");
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
    expect(args.at(-1)).toContain("review pass 2 of 3");
    expect(buildCodexVerifyPrompt("/tmp/review")).toContain("edit article.md in place with apply_patch");
    expect(buildCodexVerifyPrompt("/tmp/review")).not.toContain("Do not use the network");
  });

  it("registers the same base-selection MCP tool for dual-candidate reviews", () => {
    const args = buildCodexArgs(
      "/tmp/review",
      "/tmp/review/status",
      "gpt-5.6-terra",
      0,
      true,
    );
    expect(args).toContainEqual(expect.stringContaining("mcp_servers.article_review.command="));
    expect(args).toContainEqual(expect.stringMatching(
      /mcp_servers\.article_review\.args=.*select-review-base\.mjs/,
    ));
    expect(args.at(-1)).toContain("call the select_review_base tool exactly once");
  });

  it("accepts only exact terminal statuses", () => {
    expect(parseCodexReviewStatus("PASS\n")).toBe("PASS");
    expect(parseCodexReviewStatus("done\nREJECT: truncated source\n")).toBe("REJECT: truncated source");
    expect(() => parseCodexReviewStatus("PASS with notes")).toThrow();
  });

  it("copies back only the edited article from an isolated bundle", async () => {
    const source = await fixture();
    const fake = path.join(source, "fake-codex.mjs");
    await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
const status = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(cwd + "/article.md", "after\\n");
fs.writeFileSync(status, "PASS\\n");
`);
    await fs.chmod(fake, 0o755);
    process.env.ARTICLE_REVIEW_CODEX_BIN = fake;
    const result = await runCodexArticleVerify(source, 0, 5_000, "gpt-5.6-terra");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PASS\n");
    expect(await fs.readFile(path.join(source, "article.md"), "utf-8")).toBe("after\n");
  });

  it("surfaces CLI failures without copying back edits", async () => {
    const source = await fixture();
    const fake = path.join(source, "fake-codex.mjs");
    await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
fs.writeFileSync(cwd + "/article.md", "unsafe\\n");
process.stderr.write("subscription unavailable");
process.exit(7);
`);
    await fs.chmod(fake, 0o755);
    process.env.ARTICLE_REVIEW_CODEX_BIN = fake;
    const result = await runCodexArticleVerify(source, 0, 5_000, "gpt-5.6-terra");
    expect(result).toMatchObject({ exitCode: 7, stderr: "subscription unavailable" });
    expect(await fs.readFile(path.join(source, "article.md"), "utf-8")).toBe("before\n");
  });

  it("cancels the Codex process without copying back edits", async () => {
    const source = await fixture();
    const fake = path.join(source, "fake-codex.mjs");
    await fs.writeFile(fake, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
    await fs.chmod(fake, 0o755);
    process.env.ARTICLE_REVIEW_CODEX_BIN = fake;
    const controller = new AbortController();
    const review = runCodexArticleVerify(source, 0, 5_000, "gpt-5.6-terra", controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled by test")), 50);
    await expect(review).rejects.toThrow("cancelled by test");
    expect(await fs.readFile(path.join(source, "article.md"), "utf-8")).toBe("before\n");
  });
});
