# Plan: Global footnote normalization + absolute links in article scraper

## Problem (empirically grounded)

The deterministic scraper (`server/add-article/extract.ts`, used by `extractArticle`)
mishandles two things on real course-corpus articles. Confirmed against the
hermetic eval fixtures:

1. **Footnotes are dropped / garbled instead of collected at the bottom.**
   On `gillen-barnett` (a LessWrong post) the gold has 40 `[^N]: …` definitions
   and `[^1]`..`[^40]` markers; the current scraper emits only **3** definitions,
   and those are mangled (`[^07]: [^07] E.g. …` — duplicated marker, junk number).

   Root cause: ForumMagnum (LessWrong / AI Alignment Forum / EA Forum) renders
   footnotes as:
   - inline ref: `<span class="footnote-reference" id="fnref<HASH>"><sup><a href="#fn<HASH>">[1]</a></sup></span>`
   - definition: `<ol class="footnotes"><li class="footnote-item" id="fn<HASH>"><span class="footnote-back-link">…</span><div class="footnote-content">…</div></li>`

   The footnote **number only exists in the reference's anchor text** (`[1]`); the
   definition's id is a content hash (`fn7menapb2jft`), not a number. The current
   per-node turndown rules derive each footnote's number from its own
   `id`/`href`/`textContent` (`trailingNum`), so the definition `<li>` cannot find
   its number and falls through to raw content; the back-link `<sup>` is
   mis-detected as a marker. Numbering footnotes requires **cross-node
   coordination** (map every definition to the number carried by the reference
   that points at it) which a stateless turndown rule cannot do.

2. **Links are left relative instead of absolute.** On `gillen-barnett` the gold
   has 60 absolute links and **0** relative; the scraper emits 34 relative
   (`](/posts/…)`) and 22 absolute. Root cause: `<a href>` resolution against the
   base URL is never done. (Images already are, via the `lazyImg` rule; links are
   not.) Turndown parses the body HTML string with no base URL, so relative hrefs
   survive verbatim.

Both must be fixed **globally**, not just for LessWrong. The corpus also contains
GFM-numeric footnotes (e.g. `amodei-machines-of-loving-grace`,
`a[data-footnote-ref]`, numeric `id="user-content-fn-N"`) and markdown-it
footnotes (`.footnote-ref`/`.footnote-item`, numeric ids) that already work and
must keep working.

## Approach

Introduce a deterministic **DOM normalization pass that runs before turndown**,
with the base URL available, that canonicalizes every footnote convention into a
single numeric form and absolutizes links. After the pass, turndown's existing
numeric footnote rules do the final text conversion unchanged. This keeps the
fix in one place that BOTH the adapter path and the generic (Defuddle/Readability)
path flow through.

### New module: `server/add-article/normalize-dom.ts`

`export function normalizeArticleDom(root: HTMLElement, baseUrl: string): void`
— mutates `root` in place. Two responsibilities:

**A. Footnote canonicalization**

1. Collect inline **references** in document order. **Back-links are excluded
   FIRST, before any inclusion test** (critical: `"#fnref".startsWith("#fn")` is
   true, so a back-link `<a href="#fnref…">` would otherwise be mis-detected as a
   marker — this is the exact collision the existing `footnoteBackref` rule guards
   against). A node is skipped if it is, or is inside, `.footnote-back-link`, or is
   `a[data-footnote-backref]`, or an anchor whose href starts with `#fnref`. A
   *reference* is then any remaining:
   - `.footnote-ref` or `.footnote-reference` (span/sup wrapper), or
   - `a[data-footnote-ref]`, or
   - `sup` containing `a[href^="#fn"]`.
2. For each reference, compute its **target id** (the definition it points at):
   the `#…` fragment of its inner anchor href, else `data-footnote-ref`, else the
   reference's own id with `ref` stripped (`fnref<HASH>` → `fn<HASH>`).
3. Compute each reference's **number N**, preferring a real display number over
   positional counting (per review B1 — positional renumbering diverges from gold
   when an author references footnotes out of order):
   - if the reference's inner anchor text is purely numeric (e.g. `[1]` → `1`), use it;
   - else if it carries `data-footnote-index` or `data-footnote-ref` that is numeric, use that;
   - else fall back to a 1-based first-occurrence counter.
   Build `targetId → N`. Repeated references to the same target reuse the same N.
   This makes the pass idempotent on already-canonical input (`<a data-footnote-ref="1" href="#fn-1">1</a>` → N=1 → def `#fn-1`).
4. Rewrite each reference node, in place, to a canonical marker the existing
   `footnoteRef` turndown rule already matches:
   `<sup class="footnote-ref"><a data-footnote-ref="N" href="#fn-N">N</a></sup>`.
5. Find footnote **definition** items (`li.footnote-item`, `li[id^="fn"]`,
   `li[id^="user-content-fn"]`). For each: look up N from its id via the
   `targetId → N` map. Remove its back-link descendants. Set its `id="fn-N"` so
   the existing `footnoteItem` rule derives N. Reorder the definition `<li>`s by N
   within their container so output order matches markers (stable; only touch
   `<li>`s that resolved to a number, leave any non-footnote `<li>` in place).
   **Orphan definitions** (id never targeted by a reference) are kept and given
   numbers continuing after the max, in DOM order — preserving footnote *content*
   is the primary goal of this fix, and losing real text is worse than an extra
   `[^N]:` line. (Review S1 noted the opposite precision tradeoff; we choose
   content-preservation and let the eval show if orphans actually occur — for the
   adapter path refs/defs are paired in-region, so orphans should be rare.)
6. Leave the wrapping `<ol class="footnotes">` / `<section data-footnotes>` for
   the existing `footnotesWrapper` rule to neutralize. (The defs already sit at
   the end of the article body in the DOM, so `[^N]:` lands at the bottom.)

**B. Link absolutization**

For every `a[href]` under `root`: read the raw `href` attribute; skip empty,
`#…`, `mailto:`, `tel:`, `data:`, `javascript:`; otherwise set it to
`new URL(href, baseUrl).href` (keep original on throw). Footnote ref/back anchors
keep their `#…` hrefs and are unaffected.

### Integration into `extract.ts`

Add a single helper and route all body conversion through it:

```ts
function htmlToMarkdown(bodyHtml: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: baseUrl });
  normalizeArticleDom(dom.window.document.body, baseUrl);
  return makeTurndown(baseUrl).turndown(dom.window.document.body.innerHTML).trim();
}
```

Replace the three current `makeTurndown(url).turndown(x).trim()` call sites
(adapter `bodyHtml`, adapter `bodyMarkdownUrl` HTML fallback, generic candidates)
with `htmlToMarkdown(x, url)`. The Markdown-URL branch (`ex.bodyMarkdown` /
`bodyMarkdownUrl` raw markdown) is unchanged — those are already markdown, not HTML.

### Turndown rules

Keep all existing footnote rules (`footnoteBackref`, `footnoteRef`,
`footnoteItem`, `footnotesWrapper`) and `lazyImg`. They now receive canonical
numeric input from the DOM pass and continue to cover the generic path directly.
No rule deletions in this change (minimize regression surface); revisit only if
the reviewer or eval shows a concrete redundancy bug.

## Tasks

1. **Create `normalize-dom.ts` + unit tests.** Implement `normalizeArticleDom`.
   Tests (Vitest, JSDOM): (a) ForumMagnum hash-id footnotes → sequential
   `[^1]`/`[^1]:` after a full extract round-trip or DOM assertion;
   (b) GFM numeric `data-footnote-ref` preserved; (c) markdown-it `.footnote-ref`
   numeric preserved; (d) repeated reference to one footnote reuses N;
   (e) **a back-link (`<a href="#fnref…">^`) is NOT rewritten into a marker** and
   is removed from the definition (review B2); (f) relative `<a href="/x">` →
   absolute, `#frag`/`mailto:` left alone, image-wrapping anchors survive;
   (g) non-ascending reference order numbers by display value, not position
   (review B1); (h) idempotency: already-canonical `fn-1` input is unchanged.
2. **Wire `htmlToMarkdown` into `extract.ts`** at the three HTML→markdown call
   sites. Add/extend `extract.test.ts` with a ForumMagnum-shaped HTML snippet
   asserting bottom-collected numeric footnotes and absolute links end-to-end.
3. **Run the existing add-article test suite** (math/MathML + atlas regression
   guard, review S3/S4): the existing `extract.test.ts` math/`mjpage`/ar5iv and
   the adapter atlas tests now run through the new `htmlToMarkdown` path, so they
   are the regression backstop for MathML round-trip and atlas markdown. All must
   stay green. Then **run the full eval** (`npx tsx scripts/eval-fixtures.ts`).
   Confirm `gillen-barnett` footnote defs 3→~40 and relative links →~0; check the
   global mean recall/precision rises and no previously-high fixture (e.g.
   `buck-worst-case` 0.94, `ngo` 0.96, `hobbhahn` 0.88) regresses. Iterate on the
   DOM pass for any convention the eval surfaces.

## Global constraints

- Fix applies to ALL sites (adapter + generic paths), not just LessWrong.
- Existing numeric GFM and markdown-it footnotes must keep working (no regression).
- Footnote numbering is by first-reference document order, 1-based, sequential.
- Definitions end up at the bottom of the body as `[^N]: …`; markers are `[^N]`.
- Relative links resolved against the fetch base URL; in-document `#` anchors,
  `mailto:`/`tel:`/`data:`/`javascript:` left untouched.
- Deterministic and idempotent: re-running the pass on already-canonical DOM is a
  no-op-equivalent (same numbering).
- The eval gold fixtures are the source of truth for the target format; do NOT
  edit gold to match the scraper in this change.

## Risks

- **Renumbering vs gold.** Gold footnotes are sequential 1..N matching reference
  order, so first-reference renumbering reproduces them. If any fixture's gold is
  non-sequential, eval will flag it; revisit then.
- **Over-broad reference detection** catching non-footnote `<sup>`s. Mitigated by
  requiring an anchor href starting `#fn` (and excluding `#fnref`).
- **Generic-path idempotency.** Defuddle/Readability HTML runs through the pass
  too; numeric conventions should pass through unchanged. Eval is the backstop.
- **Re-parse cost.** `htmlToMarkdown` parses the body once more per extraction.
  Negligible vs. the existing Defuddle+Readability+JSDOM work.
