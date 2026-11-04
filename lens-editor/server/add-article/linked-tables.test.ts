import { describe, expect, it, vi } from "vitest";
import { extractArticle } from "./extract";
import { inlineLinkedTables, parseCsv, type LinkedTableFetchers } from "./linked-tables";

const PAGE = "https://link.springer.com/article/10.1186/x";
const prose = `<p>${"Real sentence of article body text about the study. ".repeat(40)}</p>`;
const page = (inner: string) =>
  `<html><head><title>Study</title></head><body><article><h1>Study</h1>${prose}${inner}${prose}</article></body></html>`;
const springerFigure = `<div class="c-article-table" id="table-1"><figure>
  <figcaption class="c-article-table__figcaption"><b id="Tab1">Table 1 Terms</b></figcaption>
  <div class="u-text-right u-hide-print"><a data-test="table-link" rel="nofollow" href="/article/10.1186/x/tables/1">Full size table</a></div>
</figure></div>`;
const springerTablePage = `<html><body><p>${"Filler text for a real page. ".repeat(20)}</p><div class="c-article-table-container"><table class="data">
  <thead><tr><th><p>Term</p></th><th><p>Meaning</p></th></tr></thead>
  <tbody><tr><td><p><b>Impact</b> (goal)</p></td><td><p>The change.</p><p>Often long-term.</p></td></tr></tbody>
</table></div></body></html>`;
const WALL = "<html><body>Just a moment...</body></html>";

function fetchers(direct: Record<string, string> = {}, rendered: Record<string, string> = {}): LinkedTableFetchers {
  return {
    fetchDirect: vi.fn(async (url: string) => {
      if (url in direct) return direct[url];
      throw new Error(`refused ${url}`);
    }),
    fetchRendered: vi.fn(async (url: string) => {
      if (url in rendered) return rendered[url];
      throw new Error(`refused ${url}`);
    }),
  };
}

const CHART = "https://datawrapper.dwcdn.net/YwgX4/2/";
const chartPage = (type: string) =>
  `<html><head><meta property="og:title" content="Table 1: Taxonomy &amp; terms"></head><body><div class="dw-chart ${type}"></div></body></html>`;
const chartIframe = `<figure class="block data-wrapper"><iframe class="lazy" src="${CHART}"></iframe></figure>`;

describe("parseCsv", () => {
  it("reads quoted delimiters, newlines and doubled quotes", () => {
    expect(parseCsv('a,"b,c"\n"line 1\nline 2","say ""hi"""\n')).toEqual([
      ["a", "b,c"],
      ["line 1\nline 2", 'say "hi"'],
    ]);
  });

  it("keeps empty cells, drops empty rows, and takes CRLF and a byte order mark", () => {
    expect(parseCsv("\uFEFFCategory,,Terms\r\n,,\r\nx,,y\r\n")).toEqual([
      ["Category", "", "Terms"],
      ["x", "", "y"],
    ]);
  });

  it("finds a tab or semicolon delimiter from the header", () => {
    expect(parseCsv("a\tb\n1,5\t2\n")).toEqual([["a", "b"], ["1,5", "2"]]);
    expect(parseCsv("a;b\n1;2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("Name, full\tValue\nx, y\tz\n")).toEqual([["Name, full", "Value"], ["x, y", "z"]]);
  });
});

describe("inlineLinkedTables", () => {
  it("returns a page without linked tables untouched, and fetches nothing", async () => {
    const html = page("<p>Nothing linked.</p>");
    const f = fetchers();
    const result = await inlineLinkedTables(html, PAGE, f);
    expect(result).toEqual({ html, inlined: [], failed: [] });
    expect(f.fetchDirect).not.toHaveBeenCalled();
  });

  it("puts a Springer table where its link was, and keeps the caption", async () => {
    const url = `${PAGE}/tables/1`;
    const result = await inlineLinkedTables(page(springerFigure), PAGE, fetchers({ [url]: springerTablePage }));
    expect(result.inlined).toEqual([url]);
    expect(result.html).toContain("Table 1 Terms");
    expect(result.html).toContain('<table class="data">');
    expect(result.html).not.toContain("Full size table");
  });

  it("replaces only the link when it shares a wrapper with article text", async () => {
    const url = `${PAGE}/tables/1`;
    const html = page('<div><p>Words that must stay.</p><a data-test="table-link" href="/article/10.1186/x/tables/1">Full size table</a></div>');
    const result = await inlineLinkedTables(html, PAGE, fetchers({ [url]: springerTablePage }));
    expect(result.html).toContain("Words that must stay.");
    expect(result.html).toContain('<table class="data">');
  });

  it("keeps an image sharing the link's wrapper", async () => {
    const url = `${PAGE}/tables/1`;
    const html = page('<div><a data-test="table-link" href="/article/10.1186/x/tables/1">Full size table</a><img src="https://e.org/fig.png"></div>');
    const result = await inlineLinkedTables(html, PAGE, fetchers({ [url]: springerTablePage }));
    expect(result.html).toContain("fig.png");
    expect(result.html).toContain('<table class="data">');
  });

  it("does not report a table whose link went with an earlier one", async () => {
    const url = `${PAGE}/tables/1`;
    const html = page(`<div><a data-test="table-link" href="/article/10.1186/x/tables/1">Full size table</a><div><a data-test="table-link" href="/article/10.1186/x/tables/1"></a></div></div>`);
    const result = await inlineLinkedTables(html, PAGE, fetchers({ [url]: springerTablePage }));
    expect(result.inlined).toEqual([url]);
    expect(result.html.match(/<table class="data">/g)).toHaveLength(1);
  });

  it("goes through the renderer when the table page is bot-walled", async () => {
    const url = `${PAGE}/tables/1`;
    const f = fetchers({ [url]: WALL }, { [url]: springerTablePage });
    const result = await inlineLinkedTables(page(springerFigure), PAGE, f);
    expect(result.inlined).toEqual([url]);
    expect(f.fetchRendered).toHaveBeenCalledOnce();
  });

  it("goes through the renderer when the direct fetch fails", async () => {
    const url = `${PAGE}/tables/1`;
    const result = await inlineLinkedTables(page(springerFigure), PAGE, fetchers({}, { [url]: springerTablePage }));
    expect(result.inlined).toEqual([url]);
  });

  it("leaves the page as it was and reports a table that cannot be fetched", async () => {
    const html = page(springerFigure);
    const result = await inlineLinkedTables(html, PAGE, fetchers());
    expect(result).toEqual({ html, inlined: [], failed: [`${PAGE}/tables/1`] });
  });

  it("does not follow a table link to another site", async () => {
    const f = fetchers();
    const html = page('<div><a data-test="table-link" href="https://evil.example/tables/1">Full size table</a></div>');
    expect((await inlineLinkedTables(html, PAGE, f)).html).toBe(html);
    expect(f.fetchDirect).not.toHaveBeenCalled();
  });

  it("builds a Datawrapper table from its data, with its title as the caption", async () => {
    const f = fetchers({
      [CHART]: chartPage("vis-tables"),
      [`${CHART}dataset.csv`]: 'Category,,Terms\n"Form\n(essence)",Mind-like,<script>x</script>\n',
    });
    const result = await inlineLinkedTables(page(chartIframe), PAGE, f);
    expect(result.inlined).toEqual([CHART]);
    expect(result.html).toContain("<strong>Table 1: Taxonomy &amp; terms</strong>");
    expect(result.html).toContain("<td>Form<br>(essence)</td>");
    expect(result.html).toContain("<td>x</td>");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("<iframe");
  });

  it("keeps a figure's own text, wherever it sits", async () => {
    const f = () => fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: "a,b\n1,2\n" });
    const loose = await inlineLinkedTables(page(`<figure><iframe src="${CHART}"></iframe>Source: Pew Research 2023 survey</figure>`), PAGE, f());
    expect(loose.html).toContain("Source: Pew Research 2023 survey");
    const nested = await inlineLinkedTables(page(`<figure><div><iframe src="${CHART}"></iframe><p>Figure 3. Survey of experts</p></div></figure>`), PAGE, f());
    expect(nested.html).toContain("Figure 3. Survey of experts");
    expect(nested.inlined).toEqual([CHART]);
  });

  // Prevents: valid articles failing validation over a cell's text. A Datawrapper
  // cell can hold a little HTML, and its text is not Markdown.
  it("keeps a cell's own markup, cleaned, and the text of any other tag", async () => {
    const csv = [
      "Term,Note",
      '<b class="x">Bold</b> and <a href="https://e.org/a|b" target="_blank" onclick="x()">link</a>,a|b and <script>code</script> and <a href="javascript:x">bad</a> and <font color="red">red</font> a<b',
      "",
    ].join("\n");
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: csv });
    const { html } = await inlineLinkedTables(page(chartIframe), PAGE, f);
    expect(html).toContain("<b>Bold</b>");
    expect(html).toContain('<a href="https://e.org/a%7Cb">link</a>');
    expect(html).not.toMatch(/onclick|<script|<font|javascript/);
    const md = (await extractArticle(html, PAGE, {})).body;
    expect(md).toContain("**Bold** and [link](https://e.org/a%7Cb)");
    expect(md).toContain("a\\|b and code and bad and red a\\<b");
  });

  // Prevents: a table cut off at that cell, with the rest gone and nothing reported.
  it("does not lose the table to a stray quote or > in a tag", async () => {
    const csv = 'Term,Note\n<a href="https://x.org" title="a>b">link</a>,one\nrow2a,<a href="https://x.org" title="abc>two</a>\nrow3a,row3b\n';
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: csv });
    const md = (await extractArticle((await inlineLinkedTables(page(chartIframe), PAGE, f)).html, PAGE, {})).body;
    for (const text of ["link", "one", "row2a", "two", "row3a", "row3b"]) expect(md).toContain(text);
  });

  // Prevents: an import failing validation on "Reference target 'ref 120' is not
  // defined", which the validator reads out of literal text.
  it("keeps literal brackets from reading as a Markdown reference", async () => {
    const csv = "Term [# of definitions][ref 182],Focus[ref 119]\nx[ref 1],y\n";
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: csv });
    const md = (await extractArticle((await inlineLinkedTables(page(chartIframe), PAGE, f)).html, PAGE, {})).body;
    expect(md).toContain(String.raw`Term \[# of definitions\] \[ref 182\]`);
    expect(md).toContain(String.raw`Focus\[ref 119\]`);
  });

  it("leaves brackets in a link's address alone", async () => {
    const csv = 'a,b\n<a href="https://x.org/?a[0][1]=2">link</a>,2\n';
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: csv });
    expect((await inlineLinkedTables(page(chartIframe), PAGE, f)).html).toContain('href="https://x.org/?a[0][1]=2"');
  });

  it("follows an older version's page to the current one", async () => {
    const newest = "https://datawrapper.dwcdn.net/YwgX4/3/";
    const f = fetchers({
      [CHART]: `<html><head><meta http-equiv="REFRESH" content="0; url=${newest}"></head></html>`,
      [newest]: chartPage("vis-tables"),
      [`${newest}dataset.csv`]: "a,b\n1,2\n",
    });
    const result = await inlineLinkedTables(page(chartIframe), PAGE, f);
    expect(result.inlined).toEqual([CHART]);
    expect(result.html).toContain("<td>1</td>");
  });

  it("does not follow a redirect to another host", async () => {
    const f = fetchers({ [CHART]: `<meta http-equiv="REFRESH" content="0; url=https://evil.example/YwgX4/3/">` });
    await inlineLinkedTables(page(chartIframe), PAGE, f);
    expect(f.fetchDirect).toHaveBeenCalledOnce();
  });

  it("skips what sits in a noscript, which extraction drops", async () => {
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: "a,b\n1,2\n" });
    const result = await inlineLinkedTables(page(`<noscript><iframe src="${CHART}"></iframe></noscript>`), PAGE, f);
    expect(result.inlined).toEqual([]);
  });

  it("reads an iframe's lazy data-src", async () => {
    const f = fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: "a,b\n1,2\n" });
    const result = await inlineLinkedTables(page(`<iframe data-src="${CHART}"></iframe>`), PAGE, f);
    expect(result.inlined).toEqual([CHART]);
  });

  it("leaves a Datawrapper chart alone, and other iframes too", async () => {
    const f = fetchers({ [CHART]: chartPage("vis-d3-bars") });
    const html = page(`${chartIframe}<iframe src="https://evil.example/YwgX4/2/"></iframe>`);
    expect(await inlineLinkedTables(html, PAGE, f)).toEqual({ html, inlined: [], failed: [] });
    expect(f.fetchDirect).toHaveBeenCalledOnce();
  });

  it("fetches a table once across the raw and the rendered page", async () => {
    const url = `${PAGE}/tables/1`;
    const f = fetchers({ [url]: springerTablePage });
    const cache = new Map();
    await inlineLinkedTables(page(springerFigure), PAGE, f, { cache });
    await inlineLinkedTables(page(springerFigure), PAGE, f, { cache });
    expect(f.fetchDirect).toHaveBeenCalledOnce();
  });

  it("tries a failed table again on the other copy of the page", async () => {
    const url = `${PAGE}/tables/1`;
    const cache = new Map();
    const first = await inlineLinkedTables(page(springerFigure), PAGE, fetchers(), { cache });
    expect(first.failed).toEqual([url]);
    const second = await inlineLinkedTables(page(springerFigure), PAGE, fetchers({ [url]: springerTablePage }), { cache });
    expect(second.inlined).toEqual([url]);
  });

  it("stops on the job's abort", async () => {
    const controller = new AbortController();
    const f: LinkedTableFetchers = {
      fetchDirect: async () => {
        controller.abort(new Error("cancelled"));
        throw new Error("aborted");
      },
      fetchRendered: async () => {
        throw new Error("aborted");
      },
    };
    await expect(inlineLinkedTables(page(chartIframe), PAGE, f, { signal: controller.signal })).rejects.toThrow("cancelled");
  });

  it("reaches the Markdown through either extractor", async () => {
    const url = `${PAGE}/tables/1`;
    const { html } = await inlineLinkedTables(page(springerFigure), PAGE, fetchers({ [url]: springerTablePage }));
    const ex = await extractArticle(html, PAGE, {});
    expect(ex.body).toContain("| Term | Meaning |");
    expect(ex.body).toContain("| **Impact** (goal) | The change.<br>Often long-term. |");

    const chart = await inlineLinkedTables(
      page(chartIframe),
      PAGE,
      fetchers({ [CHART]: chartPage("vis-tables"), [`${CHART}dataset.csv`]: 'A,B\n"one\ntwo",3\n' }),
    );
    const md = (await extractArticle(chart.html, PAGE, {})).body;
    expect(md).toContain("**Table 1: Taxonomy & terms**");
    expect(md).toContain("| A | B |");
    expect(md).toContain("| one <br> two | 3 |");
  });
});
