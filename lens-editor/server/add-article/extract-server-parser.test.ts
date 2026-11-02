// @vitest-environment node
//
// The other extraction tests run under a browser-like environment, where
// turndown parses with that environment's DOM. On the server there is no such
// global, so turndown uses its own, smaller parser, and code that only works on
// the richer one crashes there alone. These run on the server's parser.
import { describe, expect, it } from "vitest";
import { extractArticle } from "./extract";

const prose = `<p>${"Real sentence of article body text here. ".repeat(40)}</p>`;
const extract = async (inner: string) =>
  (await extractArticle(`<html><head><title>T</title></head><body><article><h1>T</h1>${prose}${inner}${prose}</article></body></html>`, "https://example.com/post", {})).body;

describe("extractArticle on the server's parser", () => {
  it("runs under no browser-like globals", () => {
    expect(typeof document).toBe("undefined");
  });

  it("converts a table with a heading row: breaks, pipes, links", async () => {
    const md = await extract(`<table><thead><tr><th><p>Term</p></th><th>a|b</th></tr></thead>
      <tbody><tr><td><p>one</p><p>two</p></td><td><a href="https://e.org/a">link</a></td></tr></tbody></table>`);
    expect(md).toContain("| Term | a\\|b |");
    expect(md).toContain("| one<br>two | [link](https://e.org/a) |");
  });

  it("converts a table without a heading row: breaks, pipes, links", async () => {
    const md = await extract(`<table><tr><td><p>one</p><p><strong>two</strong></p></td><td>a|b</td></tr>
      <tr><td><a href="https://e.org/a"><strong>link</strong></a></td><td>z</td></tr></table>`);
    expect(md).toContain("| one<br>**two** | a\\|b |");
    expect(md).toContain("| [**link**](https://e.org/a) | z |");
  });

  it("finds a footnote's definition from a table without a heading row", async () => {
    const md = await extract(`<table><tr><td>X<sup class="footnote-ref"><a href="#fn1" id="r1">1</a></sup></td><td>Y<sup class="footnote-ref"><a href="#fn9" id="r9">9</a></sup></td></tr>
      <tr><td>y</td><td>z</td></tr></table><ol class="footnotes"><li id="fn1">The note.</li></ol>`);
    expect(md).toMatch(/\| X ?\[\^1\] \|/);
    expect(md).not.toContain("[^9]");
    expect(md).toContain("[^1]: The note.");
  });

  it("keeps a table neither table rule takes, without its cell markers", async () => {
    const md = await extract(`<table><caption>Table 1</caption><tbody><tr><th>one<br>two</th><th>a|b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>`);
    expect(md).not.toContain("data-lens");
  });

  it("keeps a space held in its own element, in a table", async () => {
    const md = await extract(`<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>55<span typeof="mw:Entity">&nbsp;</span>mph</td><td><code>[<span> </span>]</code></td></tr></tbody></table>`);
    expect(md).toMatch(/55[ \u00a0]mph/);
    expect(md).toContain("`[ ]`");
  });

  it("takes the original of a blurred Wix image", async () => {
    const media = "https://static.wixstatic.com/media/4bc7041ef2e94013a1802911c4c70070.jpg";
    const md = await extract(`<img alt="Skyline" src="${media}/v1/fill/w_81,h_54,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/4bc7041ef2e94013a1802911c4c70070.jpg">`);
    expect(md).toContain(`![Skyline](${media})`);
  });
});
