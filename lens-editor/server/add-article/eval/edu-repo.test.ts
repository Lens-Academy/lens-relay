import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readEduDoc, splitFrontmatter, parseFrontmatterAuthor } from "./edu-repo";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "edu-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("readEduDoc", () => {
  it("reads a doc by repo-relative path from the repo root", async () => {
    await fs.mkdir(path.join(dir, "articles"), { recursive: true });
    await fs.writeFile(path.join(dir, "articles/foo.md"), "hello");
    expect(await readEduDoc("articles/foo.md", dir)).toBe("hello");
  });
  it("throws naming the missing path", async () => {
    await expect(readEduDoc("articles/missing.md", dir)).rejects.toThrow(/missing\.md/);
  });
});

describe("splitFrontmatter", () => {
  it("splits YAML frontmatter and parses author list + scalars", () => {
    const md = `---\ntitle: "A Title"\nsource_url: https://x.com\nauthor:\n  - "Jane Doe"\n  - "John Roe"\npublished: 2021-04-28\n---\n\nBody text here.`;
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter.title).toBe("A Title");
    expect(frontmatter.source_url).toBe("https://x.com");
    expect(JSON.parse(frontmatter.author)).toEqual(["Jane Doe", "John Roe"]);
    expect(frontmatter.published).toBe("2021-04-28");
    expect(body).toBe("Body text here.");
  });
});

describe("parseFrontmatterAuthor", () => {
  it("handles list-form (JSON array string), scalar, comma scalar, and empty", () => {
    expect(parseFrontmatterAuthor(JSON.stringify(["Jane Doe"]))).toEqual(["Jane Doe"]);
    expect(parseFrontmatterAuthor("Scott Alexander")).toEqual(["Scott Alexander"]);
    expect(parseFrontmatterAuthor("Luke Muehlhauser, Anna Salamon")).toEqual([
      "Luke Muehlhauser",
      "Anna Salamon",
    ]);
    expect(parseFrontmatterAuthor(undefined)).toEqual([]);
  });
});
