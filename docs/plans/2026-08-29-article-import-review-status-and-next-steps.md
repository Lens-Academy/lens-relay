# Article import and review: current state and next steps

**Date:** 2026-08-29
**Status:** Current-state summary and handoff for the next implementation phase

## Executive summary

Our goal is to make adding an article through Lens a dependable, source-faithful
operation rather than the beginning of a cleanup project for Elias, Luc, or
other Lens staff. A full import should preserve the source, produce useful Lens
Markdown, catch deterministic syntax problems, use an LLM for the judgments
that genuinely require source comparison, and fail before writing anything to
Relay when it cannot establish a trustworthy result.

The pipeline is much stronger than when this work began. It now retains real
source evidence, produces independent Markdown candidates from the direct and
Jina-rendered HTML, lets Sonnet choose its starting candidate before seeing
validator scores, edits the chosen candidate directly, protects pipeline-owned
metadata, validates after every review pass, records an auditable report, and
fails closed. Existing articles can be reviewed through the same machinery and
published as pending Relay changes. Generic MCP creation and moves into the
articles folder are blocked so new articles go through the importer.

The most recent local change removes Claude's Bash access. Claude now has only
`Read`, `Edit`, and a one-shot `select_review_base` MCP tool. The tool copies
the chosen candidate to `article.md` and only then reveals the two candidates'
validator findings. A real Sonnet smoke review used this tool successfully and
finished in about 15 seconds. This latest MCP-selector change is implemented
and tested in workspace 2 but is not yet pushed or deployed.

The next phase should reduce the amount of mechanical repair left to Sonnet.
We should use the review funnel to identify the most frequent remaining error
families, implement narrow source-aware transformations for the cases we can
repair with high confidence, and leave completeness, ambiguous semantics, and
presentation judgment to the reviewer. Footnote structure is the clearest
first target; source-link recovery and high-confidence page-chrome removal are
likely next.

## Overall goal

The intended full-import contract is:

1. The user adds an article through the Lens Editor's Add Article feature or
   Relay MCP's `import_article`, not by manually creating an article file.
2. Lens fetches and retains trustworthy source evidence.
3. Deterministic extraction and normalization do all work that is safe and
   repeatable without semantic guessing.
4. The Lens Platform validator identifies syntax and renderer-contract
   problems.
5. Sonnet compares the candidate against the actual source evidence, repairs
   omissions and conversion errors, and makes the limited presentation
   judgments that cannot be encoded reliably.
6. Lens checks protected metadata and authoring scaffolding programmatically,
   revalidates the exact result, records provenance, and only then writes it.
7. Any inaccessible evidence, reviewer failure, unresolved validator error,
   unsafe edit, or reporting failure prevents the Relay write.

The standard is not merely "valid Markdown." It is a complete, source-faithful
article with correct links, headings, lists, tables, equations, footnotes,
captions, metadata, and Lens-specific syntax, without website chrome or reader
comments.

## Why this work started

Staging had accumulated roughly 2,000 validator errors and 600 warnings. A
significant share appeared to come from recent articles added outside the core
workflow or before the stricter rules existed. That exposed two related needs:

- clean up the existing library through retroactive review; and
- prevent new imports from producing the same downstream work.

The second need became the priority. Batch cleanup has value, but it does not
scale if every new import can reintroduce missing links, malformed footnotes,
page chrome, flattened math, or incomplete content.

## What has been built

### 1. Evidence preservation and source acquisition

- PDF bytes are copied into independent storage before pdf.js receives its
  own copy. The retained `source.pdf` is non-empty and byte-identical to the
  fetched input.
- HTML imports retain both the direct response and a Jina-rendered response.
  Jina is currently used for every HTML import, not only as an exceptional
  fallback.
- The reviewer receives line-bounded, lossless HTML derivatives named
  `source-unrendered.html` and `source-rendered.html`. This fixed the earlier
  problem where a minified page could be one enormous line that Claude's Read
  tool could not inspect effectively.
- The derived `source.txt` review artifact was removed. The reviewer compares
  Markdown directly against HTML, PDF, or authoritative native Markdown.
- For HTML, the deterministic extractor runs independently over direct and
  rendered evidence. Neither path is assumed to be globally superior.

### 2. Dual-candidate selection

- The pipeline prepares `candidate-unrendered.md` and
  `candidate-rendered.md` when both extractions succeed.
- Sonnet reads both candidates and, when useful, the corresponding HTML before
  choosing a base.
- Validator findings are deliberately hidden during this completeness-first
  comparison. This avoids incentivizing Sonnet to choose the candidate with
  fewer syntax errors even when it is less complete or less faithful.
- After selection, Lens creates `article.md` from the chosen candidate and
  reveals both validator reports. Sonnet may then repair the chosen base using
  complementary information from either candidate and both source files.
- If neither candidate is good, Sonnet still starts from the less-bad one and
  can make extensive source-supported edits. It is not required to reject
  merely because the repair is large.

### 3. Direct LLM editing instead of review JSON

- The reviewer reads evidence and edits `article.md` in place. It no longer
  has to describe every repair in a separate review JSON structure.
- Auditability comes from retaining the selected original, the final Markdown,
  validator events, per-pass timings, and the resulting diff.
- Source-derived `title`, `author`, `published`, and `description` may change.
  Pipeline-owned fields, `source_url`, authoring comments, and existing
  CriticMarkup comments are checked and protected programmatically.
- Creative Commons and other licensing notices are removed from imported
  articles.
- Sonnet decides whether clearly terminal acknowledgements, references, or
  standalone series navigation belong in `:::collapse`. Deterministic
  normalization never inserts collapse blocks.

### 4. Constrained reviewer tools

The initial implementation let Claude use a narrowly allow-listed Bash command
to select a candidate. Real failed reviews showed why this was undesirable:
the model could spend many minutes writing and running conversion scripts
instead of making a small number of direct edits.

The current local implementation replaces that command with a one-shot MCP
tool:

- Claude receives only `Read`, `Edit`, and
  `mcp__article_review__select_review_base` during the first pass.
- `Bash`, `Write`, and `Agent` are explicitly unavailable, and Claude runs in
  restricted mode.
- The selector accepts only `{ base: "rendered" | "unrendered" }`. It accepts
  no path, command, or arbitrary filesystem input and rejects a second call.
- Selection and editing occur in one Claude process. There is no restart or
  context/cache reset between choosing the base and repairing it.
- Later repair passes receive only `Read` and `Edit`.
- The optional local Codex reviewer is also configured to use the same MCP
  selector. Production full imports remain Claude-only.

### 5. Deterministic normalization and validation

- Normalization is syntax-aware rather than a set of global substitutions.
  It protects fenced and inline code, paired `%%` comments, CriticMarkup, and
  math.
- Current narrow repairs include empty escaped inline math, root-relative link
  resolution, and exact known residue such as an empty `Posted in:` line.
- Normalization retains bounded samples for each individual change rather than
  attaching one whole-document excerpt to every repair code.
- Blanket trailing-whitespace and blank-line rewrites were removed.
- Validator issues are tracked independently of provisional filenames.
- The exact post-review draft is validated again. Up to three total Sonnet
  passes are allowed when errors remain.
- Funnel instrumentation records pass counts, durations, the validator codes
  that triggered extra passes, initial/final errors and warnings, and
  compatible aggregate fields.

### 6. Reporting, provenance, and cancellation

- Reports retain the exact selected original and exact final Markdown, along
  with extraction identity, programmatic changes, validation rounds, LLM
  repairs, pass metrics, and outcome.
- Review provenance uses nested YAML and records date, model, review version,
  source fetch date, and source kind.
- Content and source SHA stamps were removed. They gave a false impression
  that an article's quality was continuously guaranteed after review. Lens
  Platform's compatibility check was updated accordingly.
- Review reports are sealed after finishing; finishing is idempotent.
- Cancellation removes queued Claude-pool waiters, prevents a post-cancel
  Claude spawn, suppresses cancellation-induced late report events, and
  prevents a post-failure Relay write.

### 7. Workflow guardrails

- Generic MCP `create` cannot create a new file under `Lens Edu/articles`.
- Generic MCP `move` cannot move a non-article into that folder.
- The error explains that the Add Article UI or `import_article` runs
  extraction, validation, mandatory source review, evidence retention, and
  provenance, and that bypassing it creates downstream work for Elias and Luc.
- Existing article files remain editable. An exceptional manual article
  requires an informed user to create the file first; the AI can edit it
  afterward.

## Retroactive review work and what it taught us

We created a local CLI that prepares evidence bundles from current Relay
articles, runs the same reviewer, validates the result, and publishes exact
changes back as pending CriticMarkup. Claude/Sonnet is the default; a local
Codex subscription can be selected for cheaper batch experiments.

Several batches were reviewed, including a documented 20-article Sonnet run
in which 14 produced pending suggestions and six failed closed. The successful
reviews found genuinely useful changes: wrong dates and authors, missing
sentences, missing captions and links, duplicated words, incomplete
descriptions, terminal licensing notices, and presentation fixes.

The experiments also exposed important limitations:

- A reviewer can repair omissions it notices in prose but may fail to rebuild
  an extensively missing link and footnote graph from a damaged starting
  article. One clean re-import recovered substantially more content and many
  links than retroactive editing of the old article.
- A clean re-import is not automatically better. In at least one LessWrong
  case the old article was good while the new extraction was bad.
- Direct and Jina-rendered HTML each win on different sites. Choosing one
  globally would simplify the code but lose content on real sources.
- Hundreds of validator findings often represent repeated structural
  conversion defects, especially footnote identifiers. Asking Sonnet to fix
  each instance manually is slow, expensive, and encourages scripting.
- Some apparent failures were orchestration problems rather than content
  failures: timeouts, exact-anchor application failures, final-newline
  comparisons, or earlier budget ceilings.
- Large repairs should not by themselves cause rejection. The prompt now
  reserves rejection for inaccessible/non-article sources, unavailable
  substantive content, or article boundaries that cannot reasonably be
  determined.

The article-review version was bumped as the contract changed. The current
code identifies itself as `article-qc-v1.2`; earlier passes no longer establish
that an article has received the current review behavior. The corpus-wide
backfill is not complete, and the current production validator total has not
been re-audited in this local change.

## Current pipeline, end to end

For a normal HTML import, the current intended flow is:

```text
Add Article UI / import_article
    ↓
Direct fetch + Jina render, with retained evidence
    ↓
Deterministic extraction of both HTML variants
    ↓
Syntax-aware normalization of each Markdown candidate
    ↓
Initial Platform validation of both candidates
    ↓
Sonnet compares candidates and source evidence
    ↓
One-shot MCP base selection reveals validator findings
    ↓
Sonnet directly edits article.md and returns PASS or REJECT
    ↓
Protected-field checks + Platform validation
    ↓
Up to two additional Read/Edit repair passes if errors remain
    ↓
Final exact-file validation + report/provenance
    ↓
Relay write, or fail closed
```

PDF imports use retained `source.pdf` evidence rather than the dual-HTML path.
Stub-only imports still bypass structural and LLM review by design.

## Deployment state as of 2026-08-29

- Production contains the previously deployed dual-candidate/review pipeline
  and the raised approximately $10 Claude review budget.
- Lens Platform has the compatibility update that no longer requires SHA
  fields.
- The one-shot MCP selector and removal of Claude Bash/Write access are local
  in workspace 2 as jj change `pzuxkmwp`.
- The MCP selector passed protocol, invalid-input, repeat-call, lint,
  TypeScript, build, and article-import tests.
- A real authenticated Sonnet smoke test compared two controlled candidates,
  invoked the MCP selector, chose the complete unrendered candidate without
  being told which one was correct, retained the missing paragraph, and
  returned `PASS` in roughly 15 seconds.
- That smoke began at the review stage. It was not a complete network fetch,
  extraction, validation, and Relay-write import.
- The local MCP-selector change has not yet been pushed or deployed.

## Next phase: move repeated mechanical work out of Sonnet

The next goal is not to make the deterministic layer "smart" in the same way
as the LLM. It is to remove repeated, locally provable conversion defects so
Sonnet can spend its time on completeness and source correspondence.

### Step 1: rank actual repair families from the funnel

Before adding transformations, summarize recent production and retroactive
reports by:

- validator code on the selected base;
- code that triggered pass two or three;
- number of occurrences per article, not only number of affected articles;
- average time and cost for articles containing each code;
- whether the code remained after each pass; and
- source host and extractor path.

This distinguishes a code seen once in 100 articles from a structural problem
that creates 300 findings in one paper. The latter is where deterministic work
has the highest leverage.

### Step 2: canonicalize footnote structure before Markdown review

This is the leading candidate because duplicate, malformed, and untyped
footnote identifiers can generate hundreds of individually measurable errors.

The repair should operate on the selected article DOM or a structured Markdown
parse, not with a global regex:

1. Collect every footnote reference and definition together with its HTML
   target, source order, and surrounding text.
2. Match references to definitions using explicit `href`/`id` relationships
   first. Never infer a pairing merely because two labels look similar.
3. Assign one unique stable identifier per matched definition and rewrite all
   of its references as a unit.
4. Preserve repeated references to the same definition rather than creating
   duplicate definitions.
5. Remove only known back-reference UI and footnote-container chrome.
6. Classify a footnote as `cite-*` only when it has strong bibliographic
   evidence, such as a DOI, a clearly structured citation, or an unambiguous
   source link/title/author pattern. Classify clear explanatory prose as
   `note-*`.
7. Leave genuinely ambiguous cite-versus-note cases visible to Sonnet rather
   than pretending a syntactically valid ID proves the semantics are right.
8. Test multiple footnote sections, references cited out of order, repeated
   references, alphanumeric source IDs, missing definitions, inline arXiv
   notes, and unrelated elements whose IDs happen to begin with `fn`.

Some footnote normalization already exists in `normalize-dom.ts`. The first
task is therefore to compare observed failures against that implementation and
extend the missing cases, not build a second footnote system.

### Step 3: remove high-confidence page chrome at the DOM boundary

Page chrome should be removed before Turndown whenever the article boundary is
known. Candidate rules should target structural evidence such as:

- reader-comment and reaction containers;
- previous/next navigation widgets outside the selected article;
- share, feedback, newsletter, and related-content controls;
- back-reference arrows and duplicated accessibility-only labels; and
- exact, recurrent converter residue observed in reports.

Do not broadly delete `script` content before article extraction: JSON-LD or
hydration data can be the best available evidence for a JavaScript site. First
extract the article payload, then exclude scripts and UI containers from the
candidate Markdown. Every removal rule needs a nearby valid control showing
that ordinary article prose with similar words is retained.

### Step 4: recover source links where correspondence is provable

Missing links were one of the clearest quality gaps in the old library. A
validator cannot discover them from Markdown alone, and Sonnet may miss many
when an article contains a large link graph.

A deterministic source-aware link pass can do more:

1. Extract anchors from the chosen source article DOM after resolving relative
   destinations against the final source URL.
2. Align the anchor's normalized visible text with the generated Markdown's
   parsed text nodes.
3. Insert the link only when the matching span is unique, contiguous, and not
   already linked, code, math, a comment, or CriticMarkup.
4. Preserve the source destination exactly after safe URL resolution; do not
   replace it with a newer or guessed URL.
5. If anchor text is duplicated or extraction changed the wording, record the
   unmatched source link for Sonnet rather than choosing a location
   heuristically.
6. Report counts for source anchors, preserved links, uniquely recovered
   links, and unresolved links so completeness is measurable.

This is closer to deterministic extraction repair than LLM review. It should
substantially reduce the chance that an article passes while silently losing
most of its links.

### Step 5: add narrow structural cleanup for recurring residue

After ranking reports, add exact transformations for repeated families such
as:

- duplicated list markers or bullet glyphs;
- known standalone converter/submission-system diagnostics;
- empty widget labels and empty residue lines;
- duplicated heading self-links or footnote backlinks; and
- unambiguous HTML entity or line-boundary artifacts.

Each repair must be syntax-aware, idempotent, independently counted, and
covered by positive and negative fixtures. Avoid general prose rewriting,
blank-line normalization, or broad keyword deletion.

### Step 6: keep semantic math repair with Sonnet

Programmatic code can safely remove empty math nodes, preserve TeX, recognize
known DOM math representations, and flag suspicious flattened tokens. It
should not guess that every `pi`, `times`, underscore-parenthesis sequence, or
piece of adjacent prose has a particular TeX reconstruction. The validator
should identify suspicious expressions; Sonnet should compare them with HTML
or PDF evidence and repair their meaning.

## What should remain LLM work

Even after stronger preprocessing, Sonnet should remain responsible for:

- deciding which candidate is the better base;
- detecting missing or duplicated substantive passages;
- resolving conflicting direct/rendered evidence;
- determining article boundaries when page structure is imperfect;
- ambiguous cite-versus-note classification;
- semantic equation reconstruction;
- source-backed metadata corrections when structured metadata conflicts;
- captions or detached fragments that require context; and
- whether terminal auxiliary material should be collapsed.

The deterministic layer should never synthesize prose, paraphrase the source,
or choose a plausible value merely to satisfy the validator.

## Success criteria for the preprocessing phase

We should consider the next phase successful when, on a representative fixed
corpus:

- selected candidates enter Sonnet with materially fewer repeated validator
  findings;
- footnote and link counts agree more closely with the selected source DOM;
- the fraction of reviews requiring pass two or three falls;
- median review duration and tool calls fall;
- Sonnet no longer attempts bulk mechanical work;
- source-fidelity scores do not regress;
- deterministic transformations are idempotent and have near-zero false
  positives in valid controls; and
- final validation remains fail-closed.

## Recommended immediate next step

Use the existing report summarizer to produce a frequency table for the last
several production and retroactive runs, then inspect representative bundles
for the top three pass-triggering codes. Start implementation with the
highest-volume footnote family that can be reproduced from retained HTML.
Build the repair in the existing DOM normalization/extraction path, add source
and valid-control fixtures, and rerun the fixed corpus to measure how many
Sonnet edits and extra passes disappear.

After that focused improvement is proven, deploy the local MCP selector and
the preprocessing change together, run one complete dev import and one
authenticated production smoke import, and only then resume larger
retroactive batches.
