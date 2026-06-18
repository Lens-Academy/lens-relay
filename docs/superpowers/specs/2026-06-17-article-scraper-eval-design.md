# Article-Scraper Eval — Design Spec

**Date:** 2026-06-17
**Status:** Approved design (revised after subagent review), pre-implementation
**Area:** `lens-editor/server/add-article` (the deterministic article-import pipeline merged in PR #19)

## Motivation

PR #19 replaced the "let Claude regenerate the article body" importer with a
**deterministic** extraction pipeline (site adapters + Defuddle/Readability +
a fixed HTML→Markdown converter). We have unit tests for individual converter
rules, but **no end-to-end measurement of scraping quality** against
known-good output.

The existing harness (`scripts/eval-add-article.ts` + `eval/testset.json`)
never diffs against a gold body — it only checks a few asserted fields (title
substring, author surname, exact date, `must_contain` snippets) plus
artifact-regex warnings and an informational structure-count line. So it tells
us "didn't obviously break," not "how faithful is the extraction."

This spec defines a **hermetic eval** that scores the scraper's Markdown output
against a corpus of ~50 verified-good local fixtures.

## Goals

- Build a corpus of ~50 hermetic fixtures: frozen extraction inputs + a
  known-good gold Markdown body + expected metadata.
- Score current scraper output against each fixture with a deterministic stage
  (free, CI-able) and an optional LLM stage that classifies diffs as benign
  vs. real regression.
- Cover every extraction path (ForumMagnum, Wikipedia, AI Safety Atlas,
  arXiv/generic) so each is exercised.

## Non-goals (YAGNI for now)

- **No optimizing the scraper against the eval.** First pass just measures
  current behavior against whatever gold we already have.
- **No differential / two-pipeline extraction.** Separate future feature; this
  eval is the thing that would later *measure* whether it helps.
- **No eval of the Claude QC step.** The eval targets the deterministic
  extraction path only (`extractArticle`).
- **No live-network scoring.** All network I/O happens once, at fixture-build
  time; the scorer is fully offline (see Hermeticity).

## Background: relevant existing code (verified file:line)

- `server/add-article/extract.ts` — `extractArticle(html, url, opts)` returns
  `{ body, meta, siteName, via, linkedOut, assessment }`. **It is NOT purely
  offline:** when an adapter returns `bodyMarkdownUrl`, `extract.ts:302-307`
  does `await fetchText(ex.bodyMarkdownUrl)` (default `fetchRawHtml`), a live
  GET, with a silent fallback to converting `bodyHtml` on failure. `opts`
  exposes `sourceUrl` and an injectable `fetchText`.
- `server/add-article/adapters/ai-safety-atlas.ts:~188` — the Atlas HTML path
  **always** sets `bodyMarkdownUrl` (`<url>.md`) + `transformMarkdown` (injects
  HTML-page figures into the native `.md`). So Atlas extraction needs BOTH the
  rendered HTML and the `.md` export.
- `server/add-article/adapters/arxiv.ts:66-76` + `pipeline.ts:97-99` —
  `resolveFetchUrls` redirects `arxiv.org/abs/<id>` → `arxiv.org/html/<id>` /
  `ar5iv`; `extractArticle` is then called with that **resolved** URL, not the
  `source_url`. Extraction from the abstract page yields only the abstract.
- `server/add-article/fetch.ts` — `fetchRenderedHtml(url)` (post-JS rendered,
  SPA-safe), `fetchRawHtml(url)`, `fetchFirstHtml(urls)`, `MAX_HTML_BYTES` 32MB.
- `server/add-article/confidence.ts:~42` — `jaccard(a, b)` (char-4gram). Today
  used only for cross-extractor consensus, **not** gold-grading.
- `server/add-article/export.ts` — `generateArticleMarkdown(meta, body, date)`
  (frontmatter format, for normalization).
- `server/add-article/adapters/index.ts` — `resolveFetchUrls`,
  `adapterContext`, `findAdapter` (the builder reuses these to mirror the
  pipeline exactly).

## Hermeticity (how the eval stays offline)

The scorer must reproduce extraction **exactly** as the pipeline would, but
with zero network. Two adapter behaviors break naive "just pass the HTML":

1. **`bodyMarkdownUrl` fetch (AI Safety Atlas).** The builder freezes the
   `.md` export as `bodyMarkdown.txt`. The scorer passes an
   `opts.fetchText` stub that returns the frozen `bodyMarkdown.txt` for the
   expected URL and **throws on any other URL** — so a missing freeze is a hard
   error, never a silent network fallthrough to the lower-quality `bodyHtml`
   path.
2. **`resolveFetchUrls` redirect (arXiv).** The builder runs
   `resolveFetchUrls(adapterContext(source_url, ""))` + `fetchFirstHtml`
   (mirroring `pipeline.ts:97-98`), freezes the HTML actually fetched, and
   records the resolved URL. The scorer calls
   `extractArticle(html, resolved_fetch_url, { sourceUrl: source_url })`.

## Part A — Dataset (build first)

### Source pool: the Navigating Superintelligence course

Fixtures are drawn **only** from articles used in the **Navigating
Superintelligence** course — already used with students, most likely correct.

The course references articles transitively. Real relay grammar (verified):

- `courses/Navigating Superintelligence.md` interleaves `# Module: [[..]]`
  lines (note: variable spacing after the colon) with `# Meeting:` lines (which
  have no link — ignored).
- `modules/<m>.md` contain `# Learning Outcome:` and/or `# Lens:` segments
  where the **link is on the following `source::` line** (`source:: [[..]]` or
  `source:: ![[..]]`), and may nest these under `# Submodule:` / `## Lens:`
  headings.
- `Learning Outcomes/<lo>.md` reference lenses via `## Lens:` + a `source::`
  line (often embed + alias: `source:: ![[../Lenses/X|X]]`).
- `Lenses/<lens>.md` contain **0..n** `#### Article` segments, each with
  `source:: [[../articles/<slug>]]`. Lenses also have `#### Text`, `#### Video`
  (→ `../video_transcripts/`, **out of scope**), and `#### Chat` segments that
  carry no article.
- `articles/<slug>.md` frontmatter has `source_url`, `title`, `author`,
  `published`.

**Resolver rules** (so the pool isn't silently under-collected):
- Match the `source::` field **generically** (don't key on heading level);
  follow both `[[..]]` and `![[..]]`; strip an alias (`|Label`) and the embed
  `!`.
- Follow both edge types: module→learning-outcome→lens and module→lens;
  recurse through submodules.
- Collect only `source::` targets under `../articles/`; skip
  `../video_transcripts/` and article-less lenses.
- Emit per-module/per-lens article counts so a 0-article path is visible, not
  dropped.

The resolver (impl. phase 1) emits the deduplicated set of reachable
`articles/*.md`, each annotated with `source_url` and URL host, into the
committed `eval/fixtures.manifest.json`.

### Corpus read access

The relay has **no** read-doc-content HTTP API (`relay-docs.ts` only
writes/checks; content is served over the y-sweet CRDT socket). Instead the
resolver and builder read the gold docs + course graph from the local
**`lens-edu-relay`** git checkout (env `LENS_EDU_REPO`), which relay-git-sync
keeps mirrored to the relay's "Lens Edu" folder — its root maps to that folder,
so corpus paths are repo-root-relative (`articles/foo.md`, `courses/…md`; no
`Lens Edu/` prefix). This is read-only (**never** push — relay-git-sync owns the
repo) and fully scriptable/CI-capable. Once fixtures are committed, the scorer
needs no corpus access at all. The checkout may lag the live relay; a read-only
`git fetch && git checkout origin/staging` refreshes gold when needed.

### Selection & stratification (~50)

From the resolved pool, select ~50 stratified by **extraction path** (from each
article's `source_url` host) so each code path is exercised roughly in
proportion to real import volume:

- ForumMagnum — `lesswrong.com`, `alignmentforum.org`, `forum.effectivealtruism.org`
- Wikipedia — `*.wikipedia.org`
- AI Safety Atlas — `ai-safety-atlas.com`
- Generic (Defuddle/Readability) — blogs (cold-takes, waitbutwhy, wolfram,
  intelligence.org, etc.)
- arXiv — only if the pool contains an arXiv-sourced article; if absent, record
  the coverage gap (do not add a non-course URL).

Exclude articles whose gold body is intentionally not the extracted body —
i.e. **link-out** posts (`extractArticle` sets `linkedOut`; the existing
testset already has an EA-Forum "link-out stub"). Note them as excluded.

The final selection is committed in `fixtures.manifest.json` and presented for
sign-off before fixtures are frozen.

### `fixtures.manifest.json` schema

Array of entries:
```jsonc
{
  "slug": "nanda-interpretability-...",   // fixture dir name
  "relay_path": "Lens Edu/articles/....md",
  "source_url": "https://...",            // canonical URL, cited in the doc
  "resolved_fetch_url": "https://...",    // URL actually fetched (arXiv redirect); == source_url otherwise
  "host": "alignmentforum.org",
  "expected_via": "forum-adapter",        // see note below
  "needs_body_markdown": false,           // true for bodyMarkdownUrl adapters (Atlas)
  "status": "ok"                          // "ok" | "skipped:404" | "skipped:blocked" | "excluded:link-out"
}
```

### Fixture format (hermetic, committed)

```
server/add-article/eval/fixtures/<slug>/
  renderedSource.html   # frozen extraction INPUT (resolved_fetch_url, via fetchRenderedHtml/fetchFirstHtml)
  bodyMarkdown.txt      # ONLY when needs_body_markdown: the frozen .md export the adapter fetches
  expected.md           # gold article BODY, frontmatter stripped (from the relay doc)
  meta.json             # manifest entry fields + { title, author[], published, reviewed }
```

`expected_via` is the adapter id we expect `extractArticle` to report. For the
**generic path** the choice between `defuddle`/`readability` is dynamic
(`extract.ts:381-386` picks by length ratio), so for generic fixtures the
builder records the *actually observed* `via` and the scorer accepts the set
`{defuddle, readability}`.

### Manual review status

Not every gold body is confirmed correct yet. Each fixture's `meta.json` carries
a `reviewed` boolean (default `false`; an optional `reviewed_note` records why).
Workflow: when the scorer and a fixture disagree, a human inspects the diff and
decides which side is right — if the **scraper** was right, the gold is
re-frozen to be website-identical; either way the fixture is then marked
`reviewed: true`. The builder sets `reviewed: false` on a newly created fixture,
**preserves** the prior value when refreshing a fixture whose `expected.md` is
byte-identical (a human confirmation is never silently discarded), and resets it
to `false` when the gold body changes. The scorer report groups fixtures by
review status, so a disagreement on an *unreviewed* fixture reads as "gold may
be wrong," not "scraper regressed."

(Chosen `meta.json` over `expected.md` frontmatter so the gold body stays pure —
the goal is for `expected.md` to be website-identical, and review bookkeeping is
not website content.)

### Repo-size budget

Rendered HTML can be up to `MAX_HTML_BYTES` (32MB); 50 fixtures could exceed
1GB worst-case. Budget: **gzip any snapshot >1MB** (`renderedSource.html.gz`,
transparently decompressed by builder/scorer), and cap total fixture dir size
in CI (fail the build if exceeded). Atlas `_astro` figure URLs are
content-hashed and drift on rebuild → flag Atlas fixtures as
expected-to-need-refresh; image-URL diffs on that path are not regressions.

### Builder: `scripts/build-eval-fixtures.ts`

Driven by `fixtures.manifest.json`. For each `status: ok` entry:
1. Read the relay doc → split YAML frontmatter from body → write `expected.md`
   (body, **verbatim** — no CriticMarkup or editorial stripping) + `meta.json`
   (`reviewed: false` for a new fixture; preserve a prior `true` only when the
   body is byte-identical). If the body contains any CriticMarkup
   (`{>>..<<}`/`{++..++}`/`{--..--}`/`{~~..~~}`), record `reviewed_note: "gold
   contains editorial markup — clean to website-identical"` so the dirty gold is
   surfaced for curation rather than silently trusted. Nothing is stripped —
   curation happens during the review pass.
2. Mirror the pipeline fetch: `resolveFetchUrls` + `fetchFirstHtml` (or
   `fetchRenderedHtml` when no redirect) → write `renderedSource.html`,
   recording `resolved_fetch_url`.
3. If `needs_body_markdown`, replay the adapter's `bodyMarkdownUrl` derivation
   and freeze the response as `bodyMarkdown.txt`.
4. On 404 / block / render failure, **skip and flag** the manifest entry (never
   freeze a broken input).

A README documents regenerating/refreshing fixtures (sites drift).

## Part B — Scorer

New harness `scripts/eval-fixtures.ts` (existing `eval-add-article.ts` stays
for ad-hoc live-URL probing). For each fixture, **offline**:

1. Load `renderedSource.html` + `meta.json`; build the offline `fetchText` stub
   from `bodyMarkdown.txt` when present; run
   `extractArticle(html, resolved_fetch_url, { sourceUrl, fetchText })`.
2. **Deterministic stage** (free, CI-able):
   - **No normalization that masks differences.** The eval compares gold to
     scraper output **as-is** — whitespace, image URLs, links, and prose are all
     compared, because getting them right is the scraper's job. The recall/
     precision metric tokenizes into trimmed line-shingles (so it localizes
     *which* lines dropped/added) and jaccard runs on raw text. Any real
     divergence — including leftover CriticMarkup or editorial rewording in the
     gold — surfaces in the diff; if it is the gold that is wrong, that fixture
     is cleaned / re-frozen during the review pass (see Manual review status),
     not papered over by the scorer.
   - **Body fidelity (headline):** directional coverage over raw line shingles
     (trimmed only for line tokenization) — **recall** (gold shingles present in
     output) and **precision** (output shingles present in gold). This localizes
     *dropped* vs *added* content, unlike a symmetric score.
   - **jaccard tripwire:** char-4gram `jaccard(output, expected)` kept as a
     coarse secondary number (it saturates high on long docs, so it is not the
     headline).
   - **Structure deltas:** counts of headings / footnote refs+defs / tables /
     code blocks / math (`$…$`, `$$…$$`) / images / links, all compared
     **exactly** and reported as signed deltas (output − gold). On unreviewed
     fixtures a nonzero delta may be dirty gold rather than a scraper bug — that
     is what the review pass resolves; no tolerance is baked in to hide it.
   - **Metadata:** title / author / published vs `meta.json` (exact + fuzzy);
     `via` vs `expected_via` (catches a silent routing regression).
   - Emit a unified diff to `/tmp/article-eval/<slug>/` for eyeballing.
3. **Report:** per-fixture (recall/precision %, jaccard, structure deltas, `via`
   match) + aggregate (mean recall/precision, worst offenders by recall, count
   of fixtures with a routing mismatch). Mode `--deterministic` (default).

### `--llm` stage (separate, later plan)

Opt-in classification of diff hunks as
`editorial-benign | formatting-regression | content-loss | metadata-error`.
**Not** via the `spawnClaude` agentic CLI (it WebFetches the live URL → breaks
hermeticity, non-deterministic, heavyweight). Instead a **direct Anthropic API
call**: `temperature: 0`, pinned model id, structured JSON output, **no
tools/WebFetch**, with model-id recorded in the report. Treated as **advisory**
(not a gate) given residual non-determinism. Specified in its own plan; not
part of the first scorer deliverable.

## Sequencing & deliverables (phased — see Scope)

1. **Resolver** → `eval/fixtures.manifest.json` (course→pool→stratified ~50).
   Sign-off on the list. Includes the relay read client.
2. **Builder** → `scripts/build-eval-fixtures.ts` → ~50 committed fixtures
   (renderedSource.html [+ bodyMarkdown.txt] + expected.md + meta.json) + README.
3. **Scorer (deterministic)** → `scripts/eval-fixtures.ts`.
4. **Scorer (`--llm`)** → separate plan (most open questions, least first-pass
   leverage).

## Risks / open questions

- **The gold is human-edited — that is the central caveat.** Measured: ~12% of
  article docs (36/291) carry visible CriticMarkup (reviewer notes, AI tracked
  changes — footnote/image fixes, "TODO: licensed content"); silent edits
  (rewording, restructuring) would not even show up in a grep. So the relay gold
  is *not* clean scraper-target truth — it is the **starting point for
  curation**. The eval handles this honestly: compare raw, surface every
  divergence in the diff, and use the review pass to decide scraper-bug vs
  gold-bug and curate the gold (clean markup, re-freeze website-identical) into
  trusted `reviewed: true` targets. Until a fixture is reviewed its score is
  advisory; the deterministic headline is never a pass/fail gate on its own.
- **Snapshot staleness / content-hashed assets** (Atlas `_astro`) — acceptable;
  re-running the builder refreshes snapshots; image-URL diffs aren't regressions.
- **Pool coverage** bounded by what the course uses; some paths (arXiv) may be
  thin/absent — documented, not papered over.
- **Resolver fidelity** — must handle `#`/`##` headings, `source::`-on-next-line,
  `[[..]]`/`![[..]]`, aliases, submodules, 0-article lenses, and
  `video_transcripts` edges, or it under-collects.
- **Corpus read mechanism** — pinned to the local `lens-edu-relay` checkout
  (read-only); no relay read API needed. Risk: checkout staleness vs. live
  relay — refresh with `git fetch && git checkout origin/staging`.
