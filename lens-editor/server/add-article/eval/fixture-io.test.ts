import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFixture, readFixture, makeOfflineFetchText } from "./fixture-io";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "fx-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("fixture round-trip", () => {
  it("writes and reads back html, body, meta, and optional bodyMarkdown", async () => {
    await writeFixture("foo", {
      renderedSourceHtml: "<html>hi</html>",
      expectedMd: "Gold body.",
      meta: { slug: "foo", title: "T", author: ["A"], published: "2021-01-01" },
      bodyMarkdown: "# native md",
    }, root);
    const fx = await readFixture("foo", root);
    expect(fx.html).toBe("<html>hi</html>");
    expect(fx.expectedMd).toBe("Gold body.");
    expect(fx.meta.title).toBe("T");
    expect(fx.bodyMarkdown).toBe("# native md");
  });

  it("round-trips reviewed meta field", async () => {
    await writeFixture("reviewed-test", {
      renderedSourceHtml: "<html>test</html>",
      expectedMd: "Test body.",
      meta: {
        slug: "reviewed-test",
        title: "Reviewed Article",
        author: ["Author"],
        published: "2021-06-15",
        reviewed: false,
        reviewed_note: "Needs second pass",
      },
    }, root);
    const fx = await readFixture("reviewed-test", root);
    expect(fx.meta.reviewed).toBe(false);
    expect(fx.meta.reviewed_note).toBe("Needs second pass");
  });

  it("gzips renderedSourceHtml when > 1MB, transparently decompresses on read", async () => {
    const largeHtml = "<html>" + "x".repeat(1024 * 1024 + 10) + "</html>";
    await writeFixture("gzip-test", {
      renderedSourceHtml: largeHtml,
      expectedMd: "Large file test.",
      meta: { slug: "gzip-test", title: "Large", author: ["A"], published: "2021-01-01" },
    }, root);

    const fx = await readFixture("gzip-test", root);
    expect(fx.html).toBe(largeHtml);

    const fixtureRoot = path.join(root, "gzip-test");
    const gzPath = path.join(fixtureRoot, "renderedSource.html.gz");
    const plainPath = path.join(fixtureRoot, "renderedSource.html");

    const gzExists = await fs.stat(gzPath).then(() => true).catch(() => false);
    const plainExists = await fs.stat(plainPath).then(() => true).catch(() => false);

    expect(gzExists).toBe(true);
    expect(plainExists).toBe(false);
  });
});

describe("makeOfflineFetchText", () => {
  it("returns the frozen md for the expected url and throws otherwise", async () => {
    const f = makeOfflineFetchText("https://x.com/a.md", "native");
    expect(await f("https://x.com/a.md")).toBe("native");
    await expect(f("https://other.com/y")).rejects.toThrow(/unexpected url/i);
  });
});
