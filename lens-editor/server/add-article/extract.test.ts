import { describe, it, expect } from "vitest";
import { extractArticle } from "./extract";

const FORUM_SHELL = (body: string, authorHref: string, authorText: string) => `
<!doctype html><html><head>
  <title>Test Post — AI Alignment Forum</title>
  <meta property="og:description" content="A test description." />
  <meta property="og:site_name" content="AI Alignment Forum" />
</head><body>
  <h1 class="PostsPageTitle-link">Test Post</h1>
  <span class="PostsAuthors-root">by <a class="UsersNameDisplay-noColor" href="${authorHref}">${authorText}</a></span>
  <div class="PostsPageDate"><time datetime="2021-04-28T00:00:00Z">28th Apr 2021</time></div>
  <div class="PostsPage-postContent instapaper_body ContentStyles-base content ContentStyles-postBody">
    ${body}
  </div>
  <div class="CommentBody-root ContentStyles-commentBody">
    A comment by <a class="UsersNameDisplay-noColor" href="/users/someone_else">someone_else</a>.
  </div>
</body></html>`;

describe("extractArticle — ForumMagnum adapter", () => {
  it("normalizes underscore handles in the author byline", async () => {
    const html = FORUM_SHELL(
      "<p>" + "Real article body. ".repeat(40) + "</p>",
      "/users/joe_carlsmith?from=post_header",
      "Joe_Carlsmith",
    );
    const ex = await extractArticle(html, "https://forum.effectivealtruism.org/posts/x/y");
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.author).toEqual(["Joe Carlsmith"]); // underscore -> space
  });

  it("scopes author to the post header and excludes commenters", async () => {
    const html = FORUM_SHELL(
      "<p>" + "Body text here. ".repeat(40) + "</p>",
      "/users/eliezer_yudkowsky?from=post_header",
      "Eliezer Yudkowsky",
    );
    const ex = await extractArticle(html, "https://www.lesswrong.com/posts/x/y");
    expect(ex.meta.author).toEqual(["Eliezer Yudkowsky"]);
    expect(ex.body).not.toContain("someone_else");
    expect(ex.meta.published).toBe("2021-04-28");
  });

  it("converts MathJax aria-label to LaTeX and markdown-it footnotes to [^n]", async () => {
    const body = `
      <p>Inline math <span class="mjpage"><span class="mjx-chtml"><span class="mjx-math" aria-label="x^2 + 1"><span class="mjx-mrow" aria-hidden="true">x2+1</span></span></span></span> here.<sup class="footnote-ref"><a href="#fn-abc-1" id="fnref-abc-1">[1]</a></sup></p>
      <p>${"More body text to clear the length floor. ".repeat(20)}</p>
      <section class="footnotes"><ol class="footnotes-list">
        <li class="footnote-item" id="fn-abc-1"><p>The footnote text. <a class="footnote-backref" href="#fnref-abc-1">↩</a></p></li>
      </ol></section>`;
    const html = FORUM_SHELL(body, "/users/a?from=post_header", "Author A");
    const ex = await extractArticle(html, "https://www.alignmentforum.org/posts/x/y");
    expect(ex.body).toContain("$x^2 + 1$");
    expect(ex.body).toMatch(/\[\^1\]/); // inline ref
    expect(ex.body).toMatch(/^\[\^1\]:/m); // definition
    expect(ex.body).not.toContain("↩");
  });
});

describe("extractArticle — link-out detection", () => {
  it("flags a short announcement that links out to a Google Doc", async () => {
    const body =
      "<p>I've written a draft report, viewable as a public google doc " +
      '<a href="https://docs.google.com/document/d/abc/edit">here</a>. Feedback welcome.</p>';
    const html = FORUM_SHELL(body, "/users/a?from=post_header", "Author A");
    const ex = await extractArticle(html, "https://forum.effectivealtruism.org/posts/x/y");
    expect(ex.linkedOut).toBe(true);
  });

  it("does not flag a normal full-length article", async () => {
    const body = "<p>" + "This is a genuine, full-length article body. ".repeat(60) + "</p>";
    const html = FORUM_SHELL(body, "/users/a?from=post_header", "Author A");
    const ex = await extractArticle(html, "https://www.lesswrong.com/posts/x/y");
    expect(ex.linkedOut).toBe(false);
  });

  it("does not flag an arXiv page as a link-out when it links to its own PDF", async () => {
    const body =
      "<article><p>" +
      "This paper studies debate and amplification as scalable oversight methods. ".repeat(11) +
      'The full version is available as a PDF at <a href="https://arxiv.org/pdf/2210.01241">the PDF</a>.</p></article>';
    const html = `<!doctype html><html><head><title>A Paper - arXiv</title></head><body>${body}</body></html>`;
    const ex = await extractArticle(html, "https://arxiv.org/abs/2210.01241");
    expect(ex.linkedOut).toBe(false); // arxiv→pdf is the same doc, not a link-out
  });
});

describe("extractArticle — Wikipedia adapter", () => {
  it("takes the whole .mw-parser-output and strips refs/nav/editsection", async () => {
    const html = `<!doctype html><html><head><title>Test Topic - Wikipedia</title></head><body>
      <h1 id="firstHeading">Test Topic</h1>
      <div class="mw-parser-output">
        <p>${"The first section of the article body has plenty of real prose. ".repeat(8)}</p>
        <h2>Second section<span class="mw-editsection">[edit]</span></h2>
        <p>Second section content here.<sup class="reference"><a href="#c1">[1]</a></sup></p>
        <div class="reflist">REFERENCES_LIST_SHOULD_BE_DROPPED</div>
        <div class="navbox">NAVBOX_JUNK_SHOULD_BE_DROPPED</div>
      </div>
    </body></html>`;
    const ex = await extractArticle(html, "https://en.wikipedia.org/wiki/Test_Topic");
    expect(ex.via).toBe("wikipedia");
    expect(ex.meta.title).toBe("Test Topic");
    expect(ex.body).toContain("first section of the article body");
    expect(ex.body).toContain("Second section content");
    expect(ex.body).not.toContain("REFERENCES_LIST_SHOULD_BE_DROPPED");
    expect(ex.body).not.toContain("NAVBOX_JUNK_SHOULD_BE_DROPPED");
    expect(ex.body).not.toContain("[edit]");
  });
});

describe("extractArticle — robustness", () => {
  it("falls back to generic extractors when the Wikipedia adapter mis-fires", async () => {
    // .mw-parser-output exists but contains only stripped chrome → adapter
    // yields ~nothing; the real body lives in <article> and must be recovered.
    const html = `<!doctype html><html><head><title>Topic - Wikipedia</title></head><body>
      <h1 id="firstHeading">Topic</h1>
      <div class="mw-parser-output"><div class="navbox">nav junk that gets stripped</div></div>
      <article><p>${"Real fallback body content that should be recovered. ".repeat(30)}</p></article>
    </body></html>`;
    const ex = await extractArticle(html, "https://en.wikipedia.org/wiki/Topic");
    expect(ex.via).not.toBe("wikipedia");
    expect(ex.body).toContain("Real fallback body content");
  });

  it("rejects a bot-verification / challenge page instead of writing a stub", async () => {
    const html = `<!doctype html><html><head><title>Just a moment...</title></head><body><article>
      <p>Performing security verification. This website uses a security service to protect against malicious bots. ${"Please wait. ".repeat(10)}</p>
    </article></body></html>`;
    await expect(
      extractArticle(html, "https://www.example.com/blocked"),
    ).rejects.toThrow(/bot-verification|access-denied|article/i);
  });
});

describe("extractArticle — AI Safety Atlas adapter", () => {
  const ATLAS = (footnotes: boolean) => `<!doctype html><html><head>
    <title>Compute Governance - Chapter 4 - AI Safety Atlas</title>
    <meta property="og:title" content="Compute Governance - Chapter 4" />
  </head><body>
    <!-- AI Safety Atlas — the open textbook for AI Safety. This page: Chapter 4 — Compute Governance
         Authors: Markov Grey, Charbel-Raphaël Segerie  Version: v1 -->
    <main id="reader-content">
      <header><h1 class="mt-2 text-4xl font-display">Compute Governance</h1></header>
      <article class="prose prose-a:text-brand-600">
        <h1 id="notebox-title"></h1>
        <h2 id="supply-chain" class="group">Supply chain
          <a href="#supply-chain" class="opacity-0 group-hover:opacity-100" aria-label="Link to section">#</a></h2>
        <p>${"Compute governance is the practice of steering AI development through hardware. ".repeat(8)}${
          footnotes
            ? '<sup class="footnote-ref -ml-1"><a href="#fn-1" id="fnref-1" data-footnote-ref="1">[1]</a></sup>'
            : ""
        }</p>
        <p><a href="false"></a>${"It rests on the physical chokepoints of the compute supply chain. ".repeat(8)}</p>
        <figure><img src="/_astro/x.webp" alt="chip" />
          <figcaption><strong>Figure 4.6</strong> - An NVIDIA accelerator</figcaption></figure>
        <figure><iframe src="https://www.youtube-nocookie.com/embed/kK3NmQT241w" allowfullscreen></iframe>
          <figcaption><strong>Video 1.2</strong> - A short talk</figcaption></figure>
        <h3 id="acknowledgements">Acknowledgements</h3>
        <p>We thank Jane Doe and John Roe for their valuable feedback and contributions.</p>
        ${
          footnotes
            ? `<section id="footnotes" class="mt-12"><h2 class="sr-only">Footnotes</h2>
                 <ol class="list-decimal"><li id="fn-1"><p>Decentralized training is an exception.
                   <a href="#fnref-1" class="..." aria-label="Back to content">↩</a></p></li></ol></section>`
            : ""
        }
        <div id="feedback-form" data-storage-key="feedback-v1-4-1"><h3>Was this section useful?</h3>
          <button>Submit Feedback</button></div>
        <div id="feedback-success" class="hidden"><h3>Thank you for your feedback</h3>
          <p>Your input helps improve the Atlas.</p></div>
        <nav><a href="/chapters/v1/x/next">Next</a></nav>
      </article>
    </main>
  </body></html>`;

  // When the .md fetch fails the adapter falls back to converting the HTML page;
  // these two tests exercise that fallback path (rejecting fetchText).
  const offline = { fetchText: () => Promise.reject(new Error("offline")) };

  it("uses the prose article, clean h1 title, and the credited authors from the metadata comment", async () => {
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      offline,
    );
    expect(ex.via).toBe("ai-safety-atlas");
    expect(ex.meta.title).toBe("Compute Governance"); // h1, not the empty #notebox-title
    // Real authors parsed from the machine-readable comment, not the site name.
    expect(ex.meta.author).toEqual(["Markov Grey", "Charbel-Raphaël Segerie"]);
    expect(ex.siteName).toBe("AI Safety Atlas");
    expect(ex.body).toContain("Compute governance is the practice");
  });

  it("strips feedback widget, chapter nav, heading self-links and dead links, and converts GFM footnotes", async () => {
    const ex = await extractArticle(
      ATLAS(true),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      offline,
    );
    // GFM/remark footnote convention (data-footnote-ref + <li id="fn-1">).
    expect(ex.body).toMatch(/\[\^1\]/);
    expect(ex.body).toMatch(/^\[\^1\]: Decentralized training is an exception\./m);
    expect(ex.body).not.toContain("↩");
    // In-article chrome must be gone.
    expect(ex.body).not.toMatch(/Was this section useful/i);
    expect(ex.body).not.toMatch(/Thank you for your feedback/i);
    expect(ex.body).not.toMatch(/Submit Feedback/i);
    expect(ex.body).not.toMatch(/^Next$/m);
    // Heading self-link (`[#](#supply-chain)`) and dead link (`[](false)`) cruft removed.
    expect(ex.body).toContain("## Supply chain");
    expect(ex.body).not.toContain("[#]");
    expect(ex.body).not.toContain("(false)");
    expect(ex.body).not.toMatch(/\[\]\(/);
  });

  it("uses the native .md export verbatim when fetched (markdown-passthrough mode)", async () => {
    const md = `# Compute Governance

Only a handful of companies make the chips needed to build advanced AI.

[Read online](https://aisafetytextbook.com/chapters/v1/governance/compute-governance)

---

## Supply chain

${"Hardware is the chokepoint of the AI compute supply chain, and a small number of firms control the critical steps. ".repeat(6)}[^1]

> Compute is the new oil
> — Some Analyst

${"Export controls and on-chip mechanisms are two of the main levers available to governments today. ".repeat(4)}

[^1]: Decentralized training is an exception.`;
    const ex = await extractArticle(
      md,
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance.md",
      { sourceUrl: "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance" },
    );
    expect(ex.via).toBe("ai-safety-atlas");
    expect(ex.meta.title).toBe("Compute Governance");
    expect(ex.meta.author).toEqual(["Markov Grey", "Charbel-Raphaël Segerie"]);
    // source_url stays the canonical page, not the .md.
    expect(ex.meta.source_url).toBe(
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
    );
    // Native markdown preserved verbatim (blockquote attribution + footnotes),
    // with only the leading title and the self-referential link removed.
    expect(ex.body).not.toMatch(/^#\s+Compute Governance/);
    expect(ex.body).not.toContain("[Read online]");
    expect(ex.body).toContain("Only a handful of companies");
    expect(ex.body).toContain("## Supply chain");
    expect(ex.body).toContain("> — Some Analyst");
    expect(ex.body).toMatch(/^\[\^1\]: Decentralized training is an exception\./m);
  });

  it("drops the leading `---` divider on chapters that have no intro paragraph", async () => {
    const md = `# Long-Term Questions

[Read online](https://aisafetytextbook.com/chapters/v1/strategies/appendix-long-term-questions)

---

${"This appendix opens directly into its body with no standalone intro paragraph. ".repeat(8)}`;
    const ex = await extractArticle(
      md,
      "https://ai-safety-atlas.com/chapters/v1/strategies/appendix-long-term-questions.md",
    );
    expect(ex.via).toBe("ai-safety-atlas");
    expect(ex.body).not.toMatch(/^---/); // no stray divider at the top of the body
    expect(ex.body).toMatch(/^This appendix opens directly/);
  });

  it("primary path: native .md body with the page's figure images injected + per-chapter authors", async () => {
    const md = `# Compute Governance

${"Compute governance steers AI development through hardware controls and supply-chain chokepoints. ".repeat(8)}

[Read online](https://aisafetytextbook.com/chapters/v1/governance/compute-governance)

---

*Figure 4.6: An NVIDIA accelerator ([NVIDIA, 2025](https://resources.nvidia.com/x))*

${"Export controls and on-chip mechanisms are the main levers available to governments. ".repeat(4)}`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      {
        sourceUrl: "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
        fetchText: async () => md, // the native .md export
      },
    );
    expect(ex.via).toBe("ai-safety-atlas");
    // Per-chapter authors from the HTML comment (not the .md, which has none).
    expect(ex.meta.author).toEqual(["Markov Grey", "Charbel-Raphaël Segerie"]);
    // The .md body is used (not the HTML fixture body).
    expect(ex.body).toContain("Compute governance steers AI development");
    expect(ex.body).not.toContain("[Read online]");
    // The HTML page's figure image is injected above the matching .md caption.
    expect(ex.body).toMatch(
      /!\[Figure 4\.6\]\(https:\/\/ai-safety-atlas\.com\/_astro\/x\.webp\)\n\n\*Figure 4\.6:/,
    );
  });

  it("injects each figure once, and never above a prose mention of it", async () => {
    const md = `# Compute Governance

${"Compute governance steers AI development through hardware controls. ".repeat(8)}

Figure 4.6 illustrates a modern accelerator, which we discuss below.

[Read online](https://aisafetytextbook.com/x)

---

*Figure 4.6: An NVIDIA accelerator ([NVIDIA, 2025](https://x))*`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      { fetchText: async () => md },
    );
    // Exactly one image embed — on the caption, not the prose mention.
    expect((ex.body.match(/!\[Figure 4\.6\]/g) || []).length).toBe(1);
    expect(ex.body).toContain("Figure 4.6 illustrates a modern accelerator");
    expect(ex.body).not.toMatch(/!\[Figure 4\.6\][^\n]*\n\nFigure 4\.6 illustrates/);
  });

  it("injects the page's YouTube embed above the matching .md video caption", async () => {
    const md = `# Compute Governance

${"Compute governance steers AI development through hardware controls. ".repeat(8)}

*Video 1.2: A short talk*`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      { fetchText: async () => md },
    );
    expect(ex.body).toMatch(
      /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/kK3NmQT241w"[^>]*><\/iframe>\n\n\*Video 1\.2:/,
    );
  });

  it("appends the page's Acknowledgements to the .md body (the .md export drops it)", async () => {
    const md = `# Compute Governance

${"Compute governance steers AI development through hardware controls. ".repeat(8)}`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      { fetchText: async () => md }, // native .md export, which has no acknowledgements
    );
    // Pulled from the HTML page so contributors keep their attribution.
    expect(ex.body).toContain("## Acknowledgements");
    expect(ex.body).toContain("We thank Jane Doe and John Roe");
  });

  it("preserves the YouTube iframe when falling back to HTML conversion", async () => {
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      offline, // .md fetch fails → HTML conversion path
    );
    expect(ex.body).toContain(
      '<iframe src="https://www.youtube-nocookie.com/embed/kK3NmQT241w"',
    );
    expect(ex.body).toContain("allowfullscreen");
  });
});

describe("extractArticle — video embeds (generic path)", () => {
  it("keeps a YouTube iframe and drops a non-video iframe", async () => {
    const html = `<!doctype html><html><head><title>Post</title></head><body><article>
      <h1>Post</h1>
      <p>${"Genuine article prose so the generic extractor keeps the content cleanly. ".repeat(25)}</p>
      <p><iframe src="https://www.youtube.com/embed/abc123XYZ" allowfullscreen></iframe></p>
      <p><iframe src="https://ads.example.net/banner"></iframe></p>
      <p>${"More prose after the embedded talk to keep the body substantial. ".repeat(15)}</p>
    </article></body></html>`;
    const ex = await extractArticle(html, "https://example.com/post");
    expect(ex.body).toContain('<iframe src="https://www.youtube.com/embed/abc123XYZ"');
    expect(ex.body).not.toContain("ads.example.net");
  });
});

describe("extractArticle — arXiv (ar5iv / LaTeXML) adapter", () => {
  const AR5IV = `<!doctype html><html><head><title>[1805.00899] AI safety via debate</title></head>
  <body><div class="ltx_page_main"><div class="ltx_page_content"><article class="ltx_document">
    <h1 class="ltx_title ltx_title_document">AI safety via debate</h1>
    <div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Geoffrey Irving
        </span><span class="ltx_author_notes">Corresponding author: irving@openai.com</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Paul Christiano
        <br class="ltx_break"><br class="ltx_break">OpenAI</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Dario Amodei</span></span>
    </div>
    <div class="ltx_abstract"><h6 class="ltx_title">Abstract</h6>
      <p class="ltx_p">${"We propose training agents via self play on a debate game. ".repeat(12)}</p></div>
    <section class="ltx_section"><h2 class="ltx_title">1 Introduction</h2>
      <p class="ltx_p">Debate is in the complexity class <math display="inline" alttext="\\PSPACE"><mi>P</mi></math>
        and equals <math display="inline" alttext="\\NP"><mi>N</mi></math> under assumptions.
        ${"This sentence pads the body comfortably past the adapter length floor. ".repeat(10)}</p></section>
  </article></div></div></body></html>`;

  it("redirected ar5iv fetch: full body, clean authors (name before <br>), MathML, citing arXiv", async () => {
    const ex = await extractArticle(
      AR5IV,
      "https://ar5iv.labs.arxiv.org/html/1805.00899",
      { sourceUrl: "https://arxiv.org/abs/1805.00899" },
    );
    expect(ex.via).toBe("arxiv");
    expect(ex.meta.title).toBe("AI safety via debate");
    // Affiliation after the <br> ("OpenAI") and the email note must not pollute names.
    expect(ex.meta.author).toEqual(["Geoffrey Irving", "Paul Christiano", "Dario Amodei"]);
    // source_url stays the canonical arxiv.org page even though we fetched ar5iv.
    expect(ex.meta.source_url).toBe("https://arxiv.org/abs/1805.00899");
    // MathML alttext → LaTeX; no raw presentation-MathML leakage.
    expect(ex.body).toContain("$\\PSPACE$");
    expect(ex.body).toContain("$\\NP$");
    // Abstract body present; author block not duplicated as prose.
    expect(ex.body).toContain("debate game");
    expect(ex.body).not.toContain("Corresponding author");
  });
});

describe("extractArticle — metadata hardening (generic path)", () => {
  const GENERIC = (head: string) =>
    `<!doctype html><html><head><title>Paper Title</title>${head}</head><body><article>
      <h1>Paper Title</h1>
      <p>${"This is the article body with enough text for extraction to succeed cleanly. ".repeat(20)}</p>
    </article></body></html>`;

  it("reads citation_author ('Last, First') and flips to natural order", async () => {
    const head =
      '<meta name="citation_author" content="Van Gulick, Robert">' +
      '<meta name="citation_author" content="Smith, Jane">' +
      '<meta name="citation_publication_date" content="2004/06/18">';
    const ex = await extractArticle(GENERIC(head), "https://example.org/entries/consciousness");
    expect(ex.meta.author).toEqual(["Robert Van Gulick", "Jane Smith"]);
    expect(ex.meta.published).toBe("2004-06-18");
  });

  it("falls back to a date embedded in the URL path", async () => {
    const ex = await extractArticle(GENERIC(""), "https://example.com/2017/02/14/some-post");
    expect(ex.meta.published).toBe("2017-02-14");
  });
});
