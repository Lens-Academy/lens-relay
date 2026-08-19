import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { normalizeArticleDom, largestSrcsetCandidate } from "./normalize-dom";

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

describe("review-hardening: footnote id false positives", () => {
  // Prevents: <li id="fnord"> being hijacked into a phantom footnote.
  it("leaves list items whose ids merely start with fn alone", () => {
    const dom = new JSDOM(
      `<body><ul><li id="fnord">Discordians venerate the fnord</li></ul></body>`,
    );
    const body = dom.window.document.body;
    normalizeArticleDom(body as unknown as Element, "https://example.com/");
    expect(body.querySelector("#fnord")).not.toBeNull();
    expect(body.innerHTML).not.toContain('id="fn-1"');
  });
});

describe("normalizeArticleDom — footnote rescue (80000hours pattern)", () => {
  /** Body fragment + separate FULL page doc, as extract.ts wires them. */
  function normalizeWithFull(bodyHtml: string, fullHtml: string | null, base = "https://80000hours.org/problem-profiles/ai/") {
    const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: base });
    const body = dom.window.document.body;
    const fullDoc = fullHtml ? new JSDOM(fullHtml, { url: base }).window.document : null;
    normalizeArticleDom(body as unknown as Element, base, () => fullDoc as unknown as Document | null);
    return body;
  }

  const REF = (n: number, title = "") =>
    `<a id="fn-ref-${n}" href="#fn-${n}"${title ? ` title="${title}"` : ""} rel="footnote" class="footnote-link no-visited-styling" aria-label="Footnote"><sup>${n}</sup></a>`;

  it("recognizes anchor-wrapping-sup references and rescues definitions from the full page", () => {
    const body = `<p>First claim.${REF(1)} Second claim.${REF(2)}</p>`;
    const full = `<html><body><main><p>First claim. Second claim.</p></main>
      <div class="wrap-footnotes"><div class="footnotes"><div><ol>
        <li id="fn-1"> The first note with <a href="https://example.com/a">a link</a>.<a href="#fn-ref-1" class="no-visited-styling fn-return" aria-label="Back to content">↩</a></li>
        <li id="fn-2"> The second note.<a href="#fn-ref-2" class="fn-return">↩</a></li>
      </ol></div></div></div></body></html>`;
    const out = normalizeWithFull(body, full);

    // Markers canonicalized to numeric refs.
    const markers = [...out.querySelectorAll("a[data-footnote-ref]")].map((a) =>
      a.getAttribute("data-footnote-ref"),
    );
    expect(markers).toEqual(["1", "2"]);
    // Definitions rescued from the sibling container the extractor dropped.
    const defs = [...out.querySelectorAll("li")].map((li) => li.id);
    expect(defs).toEqual(["fn-1", "fn-2"]);
    expect(out.textContent).toContain("The first note with");
    // Back-to-content arrows (#fn-ref-N / .fn-return) stripped from the defs.
    expect(out.querySelector("a.fn-return")).toBeNull();
    expect(out.textContent).not.toContain("↩");
    // The hover-preview title never survives (marker node is replaced).
    expect(out.innerHTML).not.toContain("title=");
  });

  it("synthesizes the definition from the reference's title attribute when the full page lacks it", () => {
    const title = "&lt;p&gt;The AI Impacts website has &lt;a href=&quot;https://example.com/args&quot;&gt;a summary of arguments&lt;/a&gt;, plus articles.&lt;/p&gt;";
    const body = `<p>A cited claim.${REF(1, title)}</p>`;
    const out = normalizeWithFull(body, null);

    expect(out.querySelector("a[data-footnote-ref='1']")).not.toBeNull();
    const def = out.querySelector("li#fn-1");
    expect(def).not.toBeNull();
    expect(def!.textContent).toContain("The AI Impacts website has");
    // The escaped HTML parsed into real elements, not literal markup text.
    expect(def!.querySelector("a")?.getAttribute("href")).toBe("https://example.com/args");
    expect(out.textContent).not.toContain("<p>");
  });

  it("does not fabricate a definition from a short UI-label title", () => {
    const body = `<p>Claim.${REF(1, "Footnote 1")}</p>`;
    const out = normalizeWithFull(body, null);
    expect(out.querySelector("a[data-footnote-ref='1']")).not.toBeNull();
    expect(out.querySelector("li#fn-1")).toBeNull();
  });

  it("leaves natively-present definitions alone (rescue is a no-op)", () => {
    const body = `<p>Claim.${REF(1)}</p>
      <ol class="footnotes"><li id="fn-1">Native def.</li></ol>`;
    const out = normalizeWithFull(body, `<html><body><li id="fn-1">WRONG copy</li></body></html>`);
    expect(out.textContent).toContain("Native def.");
    expect(out.textContent).not.toContain("WRONG copy");
    expect(out.querySelectorAll("li").length).toBe(1);
  });

  it("does not treat a #fn-ref back-link as a footnote marker", () => {
    const body = `<p>Claim.${REF(1)}</p>
      <ol class="footnotes"><li id="fn-1">Def text.<a href="#fn-ref-1" class="fn-return">↩</a></li></ol>`;
    const out = normalizeWithFull(body, null);
    expect(out.querySelectorAll("a[data-footnote-ref]").length).toBe(1);
    expect(out.textContent).not.toContain("↩");
  });
});

describe("normalizeArticleDom — reviewer-hardened footnote guards", () => {
  function normalizeWithFull2(bodyHtml: string, fullHtml: string | null, base = "https://example.org/a") {
    const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: base });
    const body = dom.window.document.body;
    const fullDoc = fullHtml ? new JSDOM(fullHtml, { url: base }).window.document : null;
    normalizeArticleDom(body as unknown as Element, base, () => fullDoc as unknown as Document | null);
    return body;
  }

  it("leaves a rel=footnote link with an EXTERNAL href untouched (text + URL survive)", () => {
    const body = normalizeWithFull2(
      `<p>See <a rel="footnote" href="https://other.org/notes.html#3">my longer note on decision theory</a> inline.</p>`,
      null,
    );
    const a = body.querySelector("a")!;
    expect(a.textContent).toBe("my longer note on decision theory");
    expect(a.getAttribute("href")).toBe("https://other.org/notes.html#3");
    expect(body.querySelector("a[data-footnote-ref]")).toBeNull();
  });

  it("leaves a prose-length .footnote-link untouched (not marker-shaped)", () => {
    const body = normalizeWithFull2(
      `<p><a class="footnote-link" href="#fn-3">as discussed in footnote 3</a></p>
       <ol class="footnotes"><li id="fn-3">The note.</li></ol>`,
      null,
    );
    expect(body.querySelector("a.footnote-link")?.textContent).toBe(
      "as discussed in footnote 3",
    );
  });

  it("treats named ids like fn-reform as targets, not back-links", () => {
    const body = normalizeWithFull2(
      `<p>Claim<sup class="footnote-ref"><a href="#fn-reform">2</a></sup>.</p>
       <div class="footnotes"><ol>
         <li id="fn-reform">Reform note; see <a href="#fn-other">the other note</a>.<a href="#fn-ref-2" class="fn-return">↩</a></li>
         <li id="fn-other">Other note.</li>
       </ol></div>`,
      null,
    );
    // The marker was collected and numbered from its display number.
    expect(body.querySelector("a[data-footnote-ref='2']")).not.toBeNull();
    // The cross-reference link inside the definition survived, text and all…
    expect(body.textContent).toContain("see the other note");
    // …while the true back-link (#fn-ref-2 / .fn-return) was removed.
    expect(body.textContent).not.toContain("↩");
  });

  it("refuses to clone a section-sized container as a footnote definition", () => {
    const paras = Array.from({ length: 10 }, (_, i) => `<p>Excluded methods paragraph ${i} with plenty of words in it.</p>`).join("");
    const body = normalizeWithFull2(
      `<p>Claim<sup><a href="#fn-methods">1</a></sup>.</p>`,
      `<html><body><div id="fn-methods"><h2>Methods</h2>${paras}</div></body></html>`,
    );
    expect(body.querySelector("li")).toBeNull();
    expect(body.textContent).not.toContain("Excluded methods paragraph");
  });

  it("skips rescue when the definition text already survived in the body (unwrapped wrapper)", () => {
    const note = "The fnord div content that the extractor kept as a plain paragraph.";
    const body = normalizeWithFull2(
      `<p>Claim<sup><a href="#fnord9">3</a></sup>.</p><p>${note}</p>`,
      `<html><body><div id="fnord9"><p>${note}</p></div></body></html>`,
    );
    expect(body.querySelector("li")).toBeNull();
    expect((body.textContent!.match(/fnord div content/g) || []).length).toBe(1);
  });

  it("chain-rescues definitions referenced from inside rescued definitions", () => {
    const body = normalizeWithFull2(
      `<p>Claim<sup><a href="#fnA1">1</a></sup>.</p>`,
      `<html><body>
        <li id="fnA1">First note, see also<sup><a href="#fnA2">2</a></sup> for details.</li>
        <li id="fnA2">Second note reached only through the first.</li>
      </body></html>`,
    );
    const ids = [...body.querySelectorAll("li")].map((li) => li.id).sort();
    expect(ids).toEqual(["fn-1", "fn-2"]);
    expect(body.textContent).toContain("Second note reached only through the first");
  });

  it("does not fabricate a definition from a long PLAIN-TEXT tooltip title", () => {
    const body = normalizeWithFull2(
      `<p>Claim<a rel="footnote" href="#fn-1" title="Jump to the footnote content at the bottom of this page"><sup>1</sup></a>.</p>`,
      null,
    );
    expect(body.querySelector("li")).toBeNull();
    expect(body.textContent).not.toContain("Jump to the footnote");
  });

  it("sanitizes active content out of title-synthesized definitions", () => {
    const title =
      "&lt;p&gt;Note text with an embed &lt;iframe src='https://www.youtube.com/embed/EVIL'&gt;&lt;/iframe&gt; inside.&lt;/p&gt;";
    const body = normalizeWithFull2(
      `<p>Claim<a rel="footnote" href="#fn-1" title="${title}"><sup>1</sup></a>.</p>`,
      null,
    );
    const def = body.querySelector("li#fn-1")!;
    expect(def).not.toBeNull();
    expect(def.textContent).toContain("Note text with an embed");
    expect(def.querySelector("iframe")).toBeNull();
  });

  it("renumbers duplicate definition ids instead of emitting two identical [^N] defs", () => {
    const body = normalizeWithFull2(
      `<p>Claim<sup class="footnote-ref"><a href="#fn-1">1</a></sup>.</p>
       <ol class="footnotes">
         <li id="fn-1">First copy.</li>
         <li id="fn-1">Second copy with different content.</li>
       </ol>`,
      null,
    );
    const ids = [...body.querySelectorAll("li")].map((li) => li.id);
    expect(new Set(ids).size).toBe(2); // distinct numbers
    expect(body.textContent).toContain("First copy.");
    expect(body.textContent).toContain("Second copy with different content");
  });
});

describe("normalizeArticleDom — heading level restore (Defuddle flattening)", () => {
  function withFull(bodyHtml: string, fullHtml: string, base = "https://example.org/a") {
    const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: base });
    const body = dom.window.document.body;
    const fullDoc = new JSDOM(fullHtml, { url: base }).window.document;
    normalizeArticleDom(body as unknown as Element, base, () => fullDoc as unknown as Document);
    return body;
  }

  it("demotes body h2s that were h2 in the source when siblings were h1", () => {
    const body = withFull(
      `<h2>Overview</h2><p>a</p><h2>ToVs in AI Safety</h2><p>b</p><h2>Camp 1</h2><p>c</p>`,
      `<html><body><h1>The Post Title</h1>
        <h1>Overview</h1><h1>ToVs in AI Safety</h1><h2>Camp 1</h2></body></html>`,
    );
    expect([...body.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Overview",
      "ToVs in AI Safety",
    ]);
    expect([...body.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Camp 1",
    ]);
  });

  it("is a no-op when the source hierarchy really was flat h2s", () => {
    const body = withFull(
      `<h2>One</h2><p>a</p><h2>Two</h2><p>b</p>`,
      `<html><body><h1>Title</h1><h2>One</h2><h2>Two</h2></body></html>`,
    );
    expect(body.querySelectorAll("h3").length).toBe(0);
    expect(body.querySelectorAll("h2").length).toBe(2);
  });
});

describe("parseSrcset / image rendition restore", () => {
  it("parses srcsets whose URLs contain commas (fetch-CDN parameter lists)", () => {
    const srcset =
      "https://cdn.example.com/image/fetch/$s_!X!,w_424,c_limit,f_webp/https%3A%2F%2Fx.com%2Fpic.png 424w, https://cdn.example.com/image/fetch/$s_!X!,w_1456,c_limit,f_webp/https%3A%2F%2Fx.com%2Fpic.png 1456w";
    const best = largestSrcsetCandidate(srcset)!;
    expect(best.width).toBe(1456);
    expect(best.url).toContain("w_1456,c_limit");
    expect(best.url.startsWith("https://cdn.example.com/")).toBe(true);
  });

  it("restores the largest rendition of a fetch-CDN image from the full page", () => {
    const small =
      "https://cdn.example.com/image/fetch/$s_!X!,w_424,c_limit/https%3A%2F%2Fx.com%2Fpic_958x540.png";
    const large =
      "https://cdn.example.com/image/fetch/$s_!X!,w_1456,c_limit/https%3A%2F%2Fx.com%2Fpic_958x540.png";
    const dom = new JSDOM(`<body><p>t</p><img src="${small}" srcset="${small}"></body>`, {
      url: "https://example.org/a",
    });
    const body = dom.window.document.body;
    const fullDoc = new JSDOM(
      `<html><body><picture>
        <source srcset="${small} 424w, ${large} 1456w">
        <img src="${large}">
      </picture></body></html>`,
      { url: "https://example.org/a" },
    ).window.document;
    normalizeArticleDom(body as unknown as Element, "https://example.org/a", () => fullDoc as unknown as Document);
    const img = body.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(large);
    expect(img.getAttribute("srcset")).toBeNull();
  });
});
