import { describe, expect, it } from "vitest";
import { intervalMs, parseBindings } from "./bindings";

const doc = "https://docs.google.com/document/d/1hWdq25Nw17538nk5aNG1_a8PxfNUhFKfaa9r0H6fRP4/edit?tab=t.0";
const good = { source: doc, target: "Lens Edu/articles/Atlas/Chapter 1.md", author: ["Markov Grey"] };
const parse = (entries: unknown) => parseBindings(JSON.stringify(entries));

describe("parseBindings", () => {
  it("is empty when unset", () => {
    expect(parseBindings(undefined)).toEqual({ bindings: [], problems: [] });
    expect(parseBindings("  ")).toEqual({ bindings: [], problems: [] });
  });

  it("reads a binding with its article fields", () => {
    expect(parse([{ ...good, target: "/Lens Edu/articles/Atlas/Chapter 1.md", published: "2025-01-01" }])).toEqual({
      bindings: [
        {
          source: doc,
          target: "Lens Edu/articles/Atlas/Chapter 1.md",
          author: ["Markov Grey"],
          title: undefined,
          published: "2025-01-01",
          sourceUrl: undefined,
        },
      ],
      problems: [],
    });
  });

  it("accepts a target in any folder's articles/ directory", () => {
    expect(parse([{ ...good, target: "Lens Edu/Atlas Sync/articles/Ch1.md" }]).problems).toEqual([]);
  });

  it("throws only when the whole value is unusable", () => {
    expect(() => parseBindings("{")).toThrow(/not valid JSON/);
    expect(() => parseBindings("{}")).toThrow(/must be a JSON array/);
  });

  it.each([
    [{ target: good.target, author: good.author }, /\[0\]\.source must be/],
    [{ ...good, target: "b.md" }, /target "b\.md" must be/],
    [{ ...good, target: "Lens Edu/articles/b.txt" }, /target .* must be/],
    [{ ...good, target: "Lens Edu/Atlas/Chapter 1.md" }, /must be inside an articles\/ folder/],
    [{ ...good, target: "Lens Edu/articles//x.md" }, /empty, padded, '\.' or '\.\.' segment/],
    [{ ...good, target: "Lens Edu/articles/../x.md" }, /empty, padded, '\.' or '\.\.' segment/],
    [{ ...good, target: "Lens Edu/articles/ x.md" }, /empty, padded/],
    [{ ...good, author: "Markov" }, /author must be a non-empty list/],
    [{ ...good, author: [] }, /author must be a non-empty list/],
    [{ source: doc, target: good.target }, /author must be a non-empty list/],
    [{ ...good, published: "Sept 2025" }, /published must be a real date/],
    [{ ...good, published: "2026-02-30" }, /published must be a real date/],
    [{ ...good, title: "" }, /\.title must be a non-empty string/],
    [{ ...good, autor: ["X"] }, /unknown key\(s\) "autor" \(did you mean "author"\?\)/],
    [{ ...good, sourceURL: "x" }, /unknown key\(s\) "sourceURL" \(did you mean "sourceUrl"\?\)/],
    ["just a string", /must be an object/],
  ])("reports %j and skips it", (entry, message) => {
    const { bindings, problems } = parse([entry]);
    expect(bindings).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
    expect(problems[0]).toMatch(/this binding is not synced$/);
  });

  it("keeps the good bindings when one is bad", () => {
    const second = { ...good, target: "Lens Edu/articles/Atlas/Chapter 2.md" };
    const { bindings, problems } = parse([good, { ...good, target: "Lens Edu/articles/Atlas/X.md", published: "30/09/2026" }, second, good]);
    expect(bindings.map((b) => b.target)).toEqual([good.target, second.target]);
    expect(problems).toEqual([
      expect.stringMatching(/\[1\]\.published/),
      expect.stringMatching(/\[3\]\.target ".*" is bound twice/),
    ]);
  });
});

describe("intervalMs", () => {
  it("defaults to ten minutes and reads minutes", () => {
    expect(intervalMs(undefined)).toBe(600_000);
    expect(intervalMs("2")).toBe(120_000);
    expect(intervalMs("1440")).toBe(86_400_000);
  });

  it("rejects less than a minute, more than a day, or junk", () => {
    expect(() => intervalMs("0.5")).toThrow(/from 1 to 1440/);
    expect(() => intervalMs("36000")).toThrow(/from 1 to 1440/);
    expect(() => intervalMs("5m")).toThrow();
  });
});
