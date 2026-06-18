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
});

describe("makeOfflineFetchText", () => {
  it("returns the frozen md for the expected url and throws otherwise", async () => {
    const f = makeOfflineFetchText("https://x.com/a.md", "native");
    expect(await f("https://x.com/a.md")).toBe("native");
    await expect(f("https://other.com/y")).rejects.toThrow(/unexpected url/i);
  });
});
