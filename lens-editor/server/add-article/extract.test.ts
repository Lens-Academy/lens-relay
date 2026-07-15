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

  it("escapes raw < in prose so placeholders survive the platform's rehype-raw", async () => {
    const body = `
      <p>Train a 'brain embeddings to &lt;behavior&gt;' model. ${"Padding text. ".repeat(40)}</p>
      <p>Comparison 1 &lt; 2 stays plain, code stays raw: <code>&lt;script&gt;x&lt;/script&gt;</code>.</p>`;
    const html = FORUM_SHELL(body, "/users/a?from=post_header", "Author A");
    const ex = await extractArticle(html, "https://www.alignmentforum.org/posts/x/y");
    expect(ex.body).toContain("brain embeddings to \\<behavior>'");
    expect(ex.body).toContain("1 < 2"); // not tag-like — left alone
    expect(ex.body).toContain("`<script>x</script>`"); // code spans untouched
  });

  it("escapes markdown syntax in image alt text (attribute, not a text node)", async () => {
    const body = `
      <p>${"Padding text to clear the length floor. ".repeat(40)}</p>
      <p><img src="https://example.com/fig.png" alt="the <behavior> [labeled] figure"></p>`;
    const html = FORUM_SHELL(body, "/users/a?from=post_header", "Author A");
    const ex = await extractArticle(html, "https://www.alignmentforum.org/posts/x/y");
    expect(ex.body).toContain(
      "![the \\<behavior> \\[labeled\\] figure](https://example.com/fig.png)",
    );
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
    // `###` to match the source h3 + the HTML-fallback path (level consistency).
    expect(ex.body).toContain("### Acknowledgements");
    expect(ex.body).toContain("We thank Jane Doe and John Roe");
  });

  it("relocates space-inside-bold lead-ins from the .md export so the bold binds", async () => {
    const md = `# Compute Governance

${"Compute governance steers AI development through hardware controls. ".repeat(8)}

**Are LLMs robust to distributional shifts? **While it is true that AI has not yet achieved maximal robustness, there has been progress.

- **Reflexion. **The Reflexion technique enhances the model.

These are **selection inference** and **chain of thought** methods.`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      { fetchText: async () => md },
    );
    // Inner edge-space relocated OUTSIDE the `**` so the emphasis binds.
    expect(ex.body).toContain(
      "**Are LLMs robust to distributional shifts?** While it is true",
    );
    expect(ex.body).toContain("- **Reflexion.** The Reflexion technique");
    // The specific space-inside-bold artifacts are gone (substring checks avoid
    // false-matching the legitimate `** and **` gap between adjacent spans).
    expect(ex.body).not.toContain("shifts? **");
    expect(ex.body).not.toContain("Reflexion. **");
    // Over-correction guard: legitimate adjacent bold is untouched.
    expect(ex.body).toContain("**selection inference** and **chain of thought**");
  });

  it("does not corrupt a ***bold-italic*** run when tidying bold edges", async () => {
    const md = `# T

${"Body text long enough to clear the adapter minimum length. ".repeat(8)}

This point is ***very important*** to note.`;
    const ex = await extractArticle(
      ATLAS(false),
      "https://ai-safety-atlas.com/chapters/v1/governance/compute-governance",
      { fetchText: async () => md },
    );
    expect(ex.body).toContain("***very important***");
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
    // Same Acknowledgements heading level as the .md-primary path (### , not ##).
    expect(ex.body).toContain("### Acknowledgements");
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

  // Prevents: all authors fused into one string ("Ryan Greenblatt∗ Buck
  // Shlegeris Kshitij Sachan Fabien Roger") when LaTeX \and renders several
  // authors inside a SINGLE .ltx_personname, separated only by wide spaces,
  // with footnote markers glued on (arxiv.org/html/2312.06942).
  it("splits multiple authors sharing one personname and drops footnote markers", async () => {
    const html = `<!doctype html><html><head><title>[2312.06942] AI Control</title></head>
    <body><div class="ltx_page_main"><div class="ltx_page_content"><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">AI Control: Improving Safety Despite Intentional Subversion</h1>
      <div class="ltx_authors">
        <span class="ltx_creator ltx_role_author"><span class="ltx_personname"><span class="ltx_text ltx_font_bold">Ryan Greenblatt<sup class="ltx_sup"><span class="ltx_text ltx_font_medium">∗</span></sup>      Buck Shlegeris      Kshitij Sachan      Fabien Roger</span></span></span>
      </div>
      <section class="ltx_section"><h2 class="ltx_title">1 Introduction</h2>
        <p class="ltx_p">${"Enough body text to clear the adapter minimum comfortably. ".repeat(15)}</p></section>
    </article></div></div></body></html>`;
    const ex = await extractArticle(html, "https://arxiv.org/html/2312.06942", {
      sourceUrl: "https://arxiv.org/abs/2312.06942",
    });
    expect(ex.via).toBe("arxiv");
    expect(ex.meta.author).toEqual([
      "Ryan Greenblatt",
      "Buck Shlegeris",
      "Kshitij Sachan",
      "Fabien Roger",
    ]);
  });

  // Prevents: the blind eval's #1 arXiv structure defect — display equations
  // wrapped in <table class="ltx_equation"> dumped as raw MathML/HTML blobs
  // (13/13 arXiv items flagged; one paper emitted 70 unreadable equations).
  it("converts ltx_equation display tables to $$LaTeX$$ blocks", async () => {
    const html = `<!doctype html><html><head><title>[9999.00001] Eq Test</title></head>
    <body><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">Eq Test</h1>
      <section class="ltx_section">
        <p class="ltx_p">${"Body text long enough for the adapter floor. ".repeat(15)}</p>
        <table class="ltx_equation ltx_eqn_table"><tbody><tr>
          <td class="ltx_eqn_cell"><math display="block" alttext="\\displaystyle E=mc^{2}"><semantics><mrow><mi>E</mi></mrow><annotation-xml>x</annotation-xml></semantics></math></td>
          <td class="ltx_eqn_eqno">(1)</td>
        </tr></tbody></table>
        <table class="ltx_equationgroup ltx_eqn_align"><tbody>
          <tr><td class="ltx_eqn_cell"><math display="block" alttext="a=b"><mrow><mi>a</mi></mrow></math></td></tr>
          <tr><td class="ltx_eqn_cell"><math display="block" alttext="c=d"><mrow><mi>c</mi></mrow></math></td></tr>
        </tbody></table>
      </section>
    </article></body></html>`;
    const ex = await extractArticle(html, "https://ar5iv.labs.arxiv.org/html/9999.00001", {
      sourceUrl: "https://arxiv.org/abs/9999.00001",
    });
    expect(ex.body).toContain("$$E=mc^{2}$$");
    expect(ex.body).toContain("$$a=b \\\\\nc=d$$");
    expect(ex.body).not.toMatch(/ltx_equation|annotation-xml|<math|semantics/);
  });

  // Prevents: incomplete/garbled author lists and day-01 dates — the abstract
  // page's citation_* metas are authoritative and override LaTeXML parsing.
  it("enriches authors/date/title from the abs page when fetchText is available", async () => {
    const absHtml = `<!doctype html><html><head>
      <title>[1706.03741] Deep reinforcement learning from human preferences</title>
      <meta property="og:title" content="Deep reinforcement learning from human preferences" />
      <meta name="citation_author" content="Christiano, Paul" />
      <meta name="citation_author" content="Leike, Jan" />
      <meta name="citation_author" content="Brown, Tom B." />
      <meta name="citation_author" content="Martic, Miljan" />
      <meta name="citation_author" content="Legg, Shane" />
      <meta name="citation_author" content="Amodei, Dario" />
      <meta name="citation_date" content="2017/06/12" />
    </head><body></body></html>`;
    const html = `<!doctype html><html><head><title>[1706.03741] Deep RL</title></head>
    <body><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">Deep Reinforcement Learning From Human Preferences</h1>
      <div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Paul F Christiano</span></span></div>
      <section class="ltx_section"><p class="ltx_p">${"Enough body for the floor. ".repeat(20)}</p></section>
    </article></body></html>`;
    const ex = await extractArticle(html, "https://ar5iv.labs.arxiv.org/html/1706.03741", {
      sourceUrl: "https://arxiv.org/abs/1706.03741",
      fetchText: async (u: string) => {
        expect(u).toBe("https://arxiv.org/abs/1706.03741");
        return absHtml;
      },
    });
    expect(ex.meta.author).toEqual([
      "Paul Christiano",
      "Jan Leike",
      "Tom B. Brown",
      "Miljan Martic",
      "Shane Legg",
      "Dario Amodei",
    ]);
    expect(ex.meta.published).toBe("2017-06-12"); // exact day, not YYYY-MM-01
    expect(ex.meta.title).toBe("Deep reinforcement learning from human preferences"); // exact casing
  });

  it("keeps the adapter's extraction when the abs page fetch fails", async () => {
    const html = `<!doctype html><html><head><title>[1805.00899] X</title></head>
    <body><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">AI safety via debate</h1>
      <div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Geoffrey Irving</span></span></div>
      <section class="ltx_section"><p class="ltx_p">${"Enough body for the floor. ".repeat(20)}</p></section>
    </article></body></html>`;
    const ex = await extractArticle(html, "https://ar5iv.labs.arxiv.org/html/1805.00899", {
      sourceUrl: "https://arxiv.org/abs/1805.00899",
      fetchText: async () => {
        throw new Error("abs down");
      },
    });
    expect(ex.meta.author).toEqual(["Geoffrey Irving"]);
    expect(ex.meta.published).toBe("2018-05-01"); // id-derived fallback survives
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

// GreaterWrong serves ForumMagnum posts from its own server-rendered DOM. Built
// against the live markup of greaterwrong.com (post body `.body-text.post-body`,
// byline/date in `.top-post-meta`, canonical LW URL in `a.lw2-link`).
const GW_SHELL = (opts: { lw2Link?: boolean } = { lw2Link: true }) => `
<!doctype html><html><head><title>Another (outer) alignment failure story</title></head><body>
  <main>
    <h1 class="post-title">Another (outer) alignment failure story</h1>
    <div class="post-meta top-post-meta">
      <a class="author" href="/users/paulfchristiano" data-userid="x">paulfchristiano</a>
      <span class="date hide-until-init" data-js-date=1617826352000>7 Apr 2021 20:12 UTC</span>
      ${opts.lw2Link ? '<a class="lw2-link" href="https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story">LW<span> link</span></a>' : ""}
    </div>
    <div class="body-text post-body">
      <p>${"The real post body, mirrored on GreaterWrong. ".repeat(30)}</p>
    </div>
    <div class="comments">
      <div class="comment">
        <a class="author" href="/users/some_commenter">some_commenter</a>
        <span class="date" data-js-date=1685500000000>31 May 2023</span>
        <div class="body-text comment-body">A comment that must not leak into the article.</div>
      </div>
    </div>
  </main>
</body></html>`;

describe("extractArticle — GreaterWrong mirror", () => {
  const GW_URL =
    "https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story";

  // Prevents: author "Greaterwrong", published from a comment timestamp, and
  // source_url pointing at the mirror — the exact failure of the July bulk import.
  it("extracts body/author/date from GreaterWrong DOM and cites the LW canonical", async () => {
    const ex = await extractArticle(GW_SHELL(), GW_URL);
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.author).toEqual(["paulfchristiano"]);
    expect(ex.meta.published).toBe("2021-04-07"); // from data-js-date, not the 2023 comment
    expect(ex.meta.source_url).toBe(
      "https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story",
    );
    expect(ex.body).not.toContain("must not leak");
  });

  it("maps the mirror host to the canonical host when the LW link is missing", async () => {
    const ex = await extractArticle(GW_SHELL({ lw2Link: false }), GW_URL);
    expect(ex.meta.source_url).toBe(
      "https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story",
    );
    const ea = await extractArticle(
      GW_SHELL({ lw2Link: false }),
      "https://ea.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story",
    );
    expect(ea.meta.source_url).toBe(
      "https://forum.effectivealtruism.org/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story",
    );
  });
});

describe("extractArticle — generic canonical URL", () => {
  // Prevents: utm-tagged / mirror URLs stored as source_url on the generic path.
  it("prefers the page's rel=canonical over the submitted URL", async () => {
    const html = `<!doctype html><html><head>
      <title>Some Article</title>
      <link rel="canonical" href="https://example.com/posts/some-article" />
      </head><body><article><h1>Some Article</h1>
      <p>${"Body text for the generic extractors to find. ".repeat(30)}</p>
      </article></body></html>`;
    const ex = await extractArticle(
      html,
      "https://example.com/posts/some-article?utm_source=newsletter",
    );
    expect(ex.meta.source_url).toBe("https://example.com/posts/some-article");
  });

  it("ignores a homepage canonical (misconfigured templates)", async () => {
    const html = `<!doctype html><html><head>
      <title>Some Article</title>
      <link rel="canonical" href="https://example.com/" />
      </head><body><article><h1>Some Article</h1>
      <p>${"Body text for the generic extractors to find. ".repeat(30)}</p>
      </article></body></html>`;
    const ex = await extractArticle(html, "https://example.com/posts/some-article");
    expect(ex.meta.source_url).toBe("https://example.com/posts/some-article");
  });
});

describe("extractArticle — fallback table conversion", () => {
  // Prevents: heading-less tables (ar5iv ltx_tabular, layout tables) dumped
  // as raw HTML with class soup — flagged on data-table papers in the eval.
  it("converts heading-less tables to plain pipe tables", async () => {
    const html = `<!doctype html><html><head><title>[9999.00002] T</title></head>
    <body><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">T</h1>
      <section class="ltx_section"><p class="ltx_p">${"Body text well past the adapter floor. ".repeat(15)}</p>
      <table class="ltx_tabular"><tbody>
        <tr><td class="ltx_td">Model</td><td class="ltx_td">Accuracy</td></tr>
        <tr><td class="ltx_td">MNIST | baseline</td><td class="ltx_td">99.1</td></tr>
      </tbody></table>
      </section></article></body></html>`;
    const ex = await extractArticle(html, "https://ar5iv.labs.arxiv.org/html/9999.00002", {
      sourceUrl: "https://arxiv.org/abs/9999.00002",
    });
    expect(ex.body).toContain("| Model | Accuracy |");
    expect(ex.body).toContain("| MNIST \\| baseline | 99.1 |");
    expect(ex.body).not.toMatch(/ltx_tabular|<td|class=/);
  });

  it("escapes tag-like < in cell text (raw textContent bypasses td.escape)", async () => {
    const html = `<!doctype html><html><head><title>[9999.00003] T</title></head>
    <body><article class="ltx_document">
      <h1 class="ltx_title ltx_title_document">T</h1>
      <section class="ltx_section"><p class="ltx_p">${"Body text well past the adapter floor. ".repeat(15)}</p>
      <table class="ltx_tabular"><tbody>
        <tr><td class="ltx_td">text to &lt;behavior&gt;</td><td class="ltx_td">P&lt;0.05</td></tr>
      </tbody></table>
      </section></article></body></html>`;
    const ex = await extractArticle(html, "https://ar5iv.labs.arxiv.org/html/9999.00003", {
      sourceUrl: "https://arxiv.org/abs/9999.00003",
    });
    expect(ex.body).toContain("| text to \\<behavior> | P<0.05 |");
  });

  it("leaves properly-headed tables to the GFM converter", async () => {
    const html = `<!doctype html><html><head><title>H</title></head>
    <body><article><h1>H</h1><p>${"Generic body text for extraction to hold onto. ".repeat(20)}</p>
      <table><thead><tr><th>A</th><th>B</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody></table>
    </article></body></html>`;
    const ex = await extractArticle(html, "https://example.com/post");
    expect(ex.body).toContain("| A | B |");
    expect(ex.body).toContain("| 1 | 2 |");
  });
});
