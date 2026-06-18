import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { normalizeArticleDom } from "./normalize-dom";

const BASE = "https://www.lesswrong.com/posts/abc/the-post";

/** Parse a body fragment, normalize it, return the resulting <body>. */
function normalize(bodyHtml: string, base = BASE) {
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: base });
  const body = dom.window.document.body;
  normalizeArticleDom(body as unknown as Element, base);
  return body;
}

describe("normalizeArticleDom — footnotes", () => {
  it("numbers ForumMagnum hash-id footnotes from the reference display number", () => {
    const body = normalize(`
      <p>First<span class="footnote-reference" id="fnrefAAA"><sup><a href="#fnAAA">[1]</a></sup></span>
      and second<span class="footnote-reference" id="fnrefBBB"><sup><a href="#fnBBB">[2]</a></sup></span>.</p>
      <ol class="footnotes">
        <li class="footnote-item" id="fnAAA"><span class="footnote-back-link"><sup><strong><a href="#fnrefAAA">^</a></strong></sup></span><div class="footnote-content"><p>First note.</p></div></li>
        <li class="footnote-item" id="fnBBB"><span class="footnote-back-link"><sup><strong><a href="#fnrefBBB">^</a></strong></sup></span><div class="footnote-content"><p>Second note.</p></div></li>
      </ol>`);

    // Markers became canonical numeric refs.
    const markers = [...body.querySelectorAll("a[data-footnote-ref]")].map((a) =>
      a.getAttribute("data-footnote-ref"),
    );
    expect(markers).toEqual(["1", "2"]);
    // Definitions got numeric ids matching their markers.
    expect([...body.querySelectorAll("li")].map((li) => li.id)).toEqual([
      "fn-1",
      "fn-2",
    ]);
    // Back-links were stripped from the definitions.
    expect(body.querySelector(".footnote-back-link")).toBeNull();
    expect(body.innerHTML).not.toContain("#fnref");
  });

  it("does NOT turn a back-link into a marker (#fnref startsWith #fn collision)", () => {
    const body = normalize(`
      <p>x<span class="footnote-reference" id="fnrefAAA"><sup><a href="#fnAAA">[1]</a></sup></span></p>
      <ol class="footnotes">
        <li class="footnote-item" id="fnAAA"><span class="footnote-back-link"><sup><a href="#fnrefAAA">^</a></sup></span><div class="footnote-content"><p>Note.</p></div></li>
      </ol>`);
    // Exactly one canonical marker (the inline ref), none synthesized from the back-link.
    expect(body.querySelectorAll("a[data-footnote-ref]").length).toBe(1);
    expect(body.querySelector("a[href^='#fnref']")).toBeNull();
  });

  it("preserves GFM numeric footnotes", () => {
    const body = normalize(`
      <p>x<sup class="footnote-ref"><a id="user-content-fnref-1" href="#user-content-fn-1" data-footnote-ref="1">1</a></sup></p>
      <section data-footnotes class="footnotes"><ol>
        <li id="user-content-fn-1"><p>GFM note. <a href="#user-content-fnref-1" data-footnote-backref>↩</a></p></li>
      </ol></section>`);
    expect(
      body.querySelector("a[data-footnote-ref]")?.getAttribute("data-footnote-ref"),
    ).toBe("1");
    expect(body.querySelector("li")?.id).toBe("fn-1");
    expect(body.innerHTML).not.toContain("↩");
  });

  it("preserves markdown-it footnotes", () => {
    const body = normalize(`
      <p>x<sup class="footnote-ref"><a href="#fn-k-1" id="fnref-k-1">[1]</a></sup></p>
      <section class="footnotes"><ol class="footnotes-list">
        <li class="footnote-item" id="fn-k-1"><p>mdit note. <a class="footnote-backref" href="#fnref-k-1">↩</a></p></li>
      </ol></section>`);
    expect(body.querySelector("li")?.id).toBe("fn-1");
    expect(body.innerHTML).not.toContain("↩");
  });

  it("reuses one number for repeated references to the same footnote", () => {
    const body = normalize(`
      <p>a<span class="footnote-reference"><sup><a href="#fnAAA">[1]</a></sup></span>
      b<span class="footnote-reference"><sup><a href="#fnAAA">[1]</a></sup></span></p>
      <ol class="footnotes"><li class="footnote-item" id="fnAAA"><div class="footnote-content"><p>One.</p></div></li></ol>`);
    const markers = [...body.querySelectorAll("a[data-footnote-ref]")].map((a) =>
      a.getAttribute("data-footnote-ref"),
    );
    expect(markers).toEqual(["1", "1"]);
    expect([...body.querySelectorAll("li")].map((li) => li.id)).toEqual(["fn-1"]);
  });

  it("numbers by display value, not document position, when refs are out of order", () => {
    const body = normalize(`
      <p>cite two first<span class="footnote-reference"><sup><a href="#fnBBB">[2]</a></sup></span>
      then one<span class="footnote-reference"><sup><a href="#fnAAA">[1]</a></sup></span>.</p>
      <ol class="footnotes">
        <li class="footnote-item" id="fnAAA"><div class="footnote-content"><p>One.</p></div></li>
        <li class="footnote-item" id="fnBBB"><div class="footnote-content"><p>Two.</p></div></li>
      </ol>`);
    // fnBBB referenced first but shows "[2]" → must be numbered 2, not 1.
    expect([...body.querySelectorAll("li")].map((li) => li.id)).toEqual([
      "fn-1",
      "fn-2",
    ]);
    // Definitions reordered ascending by number.
    expect(body.querySelector("ol")?.textContent).toMatch(/One[\s\S]*Two/);
  });

  it("relocates arXiv/LaTeXML inline footnotes to a bottom list", () => {
    const body = normalize(`
      <p>Some claim<span class="ltx_note ltx_role_footnote" id="footnote1"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup><span class="ltx_tag ltx_tag_note">1</span>The first note text.</span></span></span> and more<span class="ltx_note ltx_role_footnote" id="footnote2"><sup class="ltx_note_mark">2</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">2</sup><span class="ltx_tag ltx_tag_note">2</span>The second note text.</span></span></span>.</p>`);
    // Inline note containers are gone; numeric markers remain in the prose.
    expect(body.querySelector(".ltx_role_footnote")).toBeNull();
    expect([...body.querySelectorAll("a[data-footnote-ref]")].map((a) =>
      a.getAttribute("data-footnote-ref"),
    )).toEqual(["1", "2"]);
    // Definitions were collected into a bottom list with numeric ids + text,
    // and the duplicated LaTeXML mark/tag glyphs were stripped.
    const defs = [...body.querySelectorAll("li")];
    expect(defs.map((li) => li.id)).toEqual(["fn-1", "fn-2"]);
    expect(defs[0].textContent).toContain("The first note text.");
    expect(defs[0].textContent).not.toMatch(/^\s*1\s*1/);
    // The footnotes list is at the end of the body.
    expect(body.lastElementChild?.tagName).toBe("OL");
  });

  it("never assigns the same number twice when display + positional refs mix", () => {
    // First ref has no number (positional), second prints [1]: must not collide.
    const body = normalize(`
      <p>a<sup><a href="#fnAAA">note</a></sup>
      b<span class="footnote-reference"><sup><a href="#fnBBB">[1]</a></sup></span></p>
      <ol class="footnotes">
        <li class="footnote-item" id="fnAAA"><div class="footnote-content"><p>A note</p></div></li>
        <li class="footnote-item" id="fnBBB"><div class="footnote-content"><p>B note</p></div></li>
      </ol>`);
    const markers = [...body.querySelectorAll("a[data-footnote-ref]")].map((a) =>
      a.getAttribute("data-footnote-ref"),
    );
    expect(new Set(markers).size).toBe(markers.length); // all unique
    expect([...body.querySelectorAll("li")].map((li) => li.id)).toEqual([
      "fn-1",
      "fn-2",
    ]);
  });

  it("gives unique numbers across two separate footnote sections", () => {
    const body = normalize(`
      <p>a<span class="footnote-reference"><sup><a href="#fnA">[1]</a></sup></span></p>
      <ol class="footnotes"><li class="footnote-item" id="fnA"><div class="footnote-content"><p>First section note</p></div></li></ol>
      <p>b<span class="footnote-reference"><sup><a href="#fnB">[1]</a></sup></span></p>
      <ol class="footnotes"><li class="footnote-item" id="fnB"><div class="footnote-content"><p>Second section note</p></div></li></ol>`);
    const ids = [...body.querySelectorAll("li")].map((li) => li.id);
    expect(ids).toEqual(["fn-1", "fn-2"]); // second [1] bumped to 2, no duplicate
  });

  it("does not turn an ordinary superscript in-page link into a footnote marker", () => {
    const body = normalize(
      `<p>See<sup><a href="#fn-section">notes section</a></sup> below.</p>`,
    );
    // No definition exists and the text isn't numeric → not a footnote, and the
    // in-page fragment link is left untouched.
    expect(body.querySelector("a[data-footnote-ref]")).toBeNull();
    expect(body.querySelector("a")?.getAttribute("href")).toBe("#fn-section");
  });

  it("is idempotent on already-canonical input", () => {
    const canonical = `<p>x<sup class="footnote-ref"><a data-footnote-ref="1" href="#fn-1">1</a></sup></p>
      <ol class="footnotes"><li id="fn-1"><div class="footnote-content"><p>Note.</p></div></li></ol>`;
    const once = normalize(canonical).innerHTML;
    const twice = normalize(once).innerHTML;
    expect(twice).toBe(once);
    expect(once).toContain('data-footnote-ref="1"');
    expect(once).toContain('id="fn-1"');
  });
});

describe("normalizeArticleDom — links", () => {
  it("absolutizes relative hrefs against the base URL", () => {
    const body = normalize(`<p><a href="/posts/xyz/other">other</a></p>`);
    expect(body.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.lesswrong.com/posts/xyz/other",
    );
  });

  it("leaves in-document, mailto and absolute hrefs untouched", () => {
    const body = normalize(
      `<p><a href="#section">x</a> <a href="mailto:a@b.c">y</a> <a href="https://example.com/z">z</a></p>`,
    );
    const hrefs = [...body.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#section", "mailto:a@b.c", "https://example.com/z"]);
  });

  it("keeps an anchor that wraps an image (resolving its href)", () => {
    const body = normalize(
      `<p><a href="/go"><img src="/img.png" alt="pic"></a></p>`,
    );
    const a = body.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://www.lesswrong.com/go");
    expect(a?.querySelector("img")).not.toBeNull();
  });
});
