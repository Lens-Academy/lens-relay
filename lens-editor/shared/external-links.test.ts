import { describe, expect, it } from "vitest";
import cases from "./external-link-cases.json";
import { externalLinkUrls, pageOffersSourceLinks, scanExternalLinks, swapLinkEdits } from "./external-links";

interface ScanCase {
  name: string;
  text: string;
  links: Array<{ url: string; form: string; label?: string; in_table?: boolean; swappable?: boolean }>;
}

describe("external link rules v1", () => {
  for (const { name, text, links } of cases.scan as ScanCase[]) {
    it(name, () => {
      const found = scanExternalLinks(text).map((link) => ({
        url: link.url,
        form: link.form,
        label: link.label,
        in_table: link.inTable,
        swappable: link.swappable,
      }));
      expect(found).toEqual(
        links.map((link) => ({
          url: link.url,
          form: link.form,
          label: link.label ?? null,
          in_table: link.in_table ?? false,
          swappable: link.swappable ?? true,
        })),
      );
    });
  }

  it("gives offsets of the whole link", () => {
    const text = "é [a](https://example.com/a) https://example.com/b.";
    const [inline, bare] = scanExternalLinks(text);
    expect(text.slice(inline.start, inline.end)).toBe("[a](https://example.com/a)");
    expect(text.slice(bare.start, bare.end)).toBe("https://example.com/b");
  });

  it("lists each URL once", () => {
    expect(externalLinkUrls("https://example.com/a [x](https://example.com/a) https://example.com/b")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("lists only links that can become wikilinks", () => {
    expect(externalLinkUrls("[a|b](https://example.com/a) [c](https://example.com/c)")).toEqual(["https://example.com/c"]);
  });
});

describe("swapLinkEdits", () => {
  for (const { name, text, url, rel, title, expected } of cases.swap) {
    it(name, () => {
      const edits = swapLinkEdits(text, [url], rel, title);
      const swapped = [...edits].reverse().reduce((out, e) => out.slice(0, e.from) + e.insert + out.slice(e.to), text);
      expect(swapped).toBe(expected);
    });
  }

  it("edits only the markup around a label", () => {
    expect(swapLinkEdits("[a](https://example.com/a)", ["https://example.com/a"], "x")).toEqual([
      { from: 0, to: 1, insert: "[[x|" },
      { from: 2, to: 26, insert: "]]" },
    ]);
  });

  it("falls back to the file stem when there is no title", () => {
    const [edit] = swapLinkEdits("https://example.com/a", ["https://example.com/a"], "../articles/x");
    expect(edit.insert).toBe("[[../articles/x|x]]");
  });
});

describe("pageOffersSourceLinks", () => {
  it("offers on a Markdown page outside Lens Edu", () => {
    expect(pageOffersSourceLinks("Lens/Notes/a.md", "text")).toBe(true);
  });

  it("leaves course pages, other file types and the trash alone", () => {
    expect(pageOffersSourceLinks("Lens Edu/Lenses/a.md", "text")).toBe(false);
    expect(pageOffersSourceLinks("Lens/page.html", "text")).toBe(false);
    expect(pageOffersSourceLinks("Lens/_trash/a.md", "text")).toBe(false);
  });

  it("leaves imported and synced files alone", () => {
    expect(pageOffersSourceLinks("Lens/a.md", "---\nsource_url: https://example.com/a\n---\nBody")).toBe(false);
    expect(pageOffersSourceLinks("Lens/a.md", "---\nsynced_from:\n  source: google-doc\n---\nBody")).toBe(false);
  });

  it("only reads the frontmatter", () => {
    expect(pageOffersSourceLinks("Lens/a.md", "---\ntitle: a\n---\nsource_url: nothing")).toBe(true);
  });
});
