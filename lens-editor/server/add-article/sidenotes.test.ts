import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractArticle, footnoteDefinitionBlocks } from "./extract";
import { convertSidenotes } from "./sidenotes";

const FIXTURE = path.join(import.meta.dirname, "eval/fixtures-html/ai-2040-verification-plan/source.html.gz");
const SOURCE_URL = "https://ai-2040.com/supplements/verification-plan";

const offline = async (u: string): Promise<string> => {
  throw new Error(`offline: unexpected fetch ${u}`);
};

/** `[^N]` references in order (definitions excluded). */
function references(md: string): string[] {
  return [...md.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((m) => m[1]);
}

describe("sidenotes → footnotes (ai-2040.com verification plan)", () => {
  it("pairs all 20 source sidenotes as [^N] / [^N]: footnotes", async () => {
    const html = zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString("utf-8");
    const { body } = await extractArticle(html, SOURCE_URL, { fetchText: offline });

    const numbers = Array.from({ length: 20 }, (_, i) => String(i + 1));
    expect(references(body)).toEqual(numbers);
    const defs = footnoteDefinitionBlocks(body);
    expect(defs.map((d) => d.match(/^\[\^(\d+)\]:/)?.[1])).toEqual(numbers);
    for (const def of defs) expect(def.replace(/^\[\^\d+\]:/, "").trim().length).toBeGreaterThan(20);

    // Each marker sits where the source put it…
    expect(body).toContain("verification measures can make this possible,[^1] by providing");
    // …and each note keeps its full text and links, e.g. note 8's compute caveat.
    const note8 = defs[7];
    expect(note8).toContain("somewhere between 2x to 6x slower");
    expect(note8).toContain(
      "(https://www.lesswrong.com/posts/7jcPg79p3kD5ir3CL/how-much-slower-does-takeoff-go-with-10-less-compute)",
    );
    expect(note8).toContain("(https://ai-2040.com/supplements/covert-ai-projects#");
    // The note's own leading "8." is replaced by the [^8]: label.
    expect(note8).toMatch(/^\[\^8\]: We are uncertain/);
    // The margin toggles leave nothing behind.
    expect(body).not.toMatch(/margin-toggle|sn-\d/);
  }, 30_000); // a 2 MB page through Defuddle and Readability
});

describe("convertSidenotes", () => {
  const page = (inner: string, margin: string) =>
    `<html><body><main><div class="prose">${inner}</div></main><aside>${margin}</aside></body></html>`;

  it("leaves pages without sidenotes byte-identical", () => {
    const html = "<html><body><p>No notes here.</p></body></html>";
    expect(convertSidenotes(html, SOURCE_URL)).toBe(html);
  });

  it("moves each note next to the text as a footnote and drops its toggle", () => {
    const out = convertSidenotes(
      page(
        `<p>Claim,<label for="sn-1" data-sidenote-number="1"></label><input type="checkbox" id="sn-1"> more.</p>`,
        `<div id="footnote-1"><span>1<!-- -->.</span><p>See <a href="/x">this</a>.</p></div>`,
      ),
      SOURCE_URL,
    );
    expect(out).toContain(
      '<p>Claim,<sup class="footnote-ref"><a href="#fn-1" data-footnote-ref="1">1</a></sup> more.</p>' +
        '<section data-footnotes="" class="footnotes"><ol><li id="fn-1"><p>See <a href="/x">this</a>.</p></li></ol></section>',
    );
    expect(out).not.toContain("sn-1");
    expect(out).not.toContain('id="footnote-1"');
  });

  it("keeps a marker whose note is missing untouched", () => {
    const html = page(`<p>Claim<label for="sn-2" data-sidenote-number="2"></label></p>`, "");
    expect(convertSidenotes(html, SOURCE_URL)).toBe(html);
  });
});
