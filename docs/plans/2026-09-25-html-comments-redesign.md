# HTML comments redesign (design notes, 2026-09-25)

Status: agreed direction, not started. Written as a handoff so a fresh session can build it.
Luc's brief: "create a new system, with a lot of freedom to do it really well."

## Why: the current system is brittle

Today a comment lives **in the HTML source**: `[[@comment:ID]]<!--lens-comment {"id","author","ts","body"}-->`,
replies as `<!--lens-reply {…,"parent"}-->` (`lens-editor/src/components/HtmlEditor/comment-store.ts`).
Placing one means mapping "the spot clicked in the rendered iframe" back to a source offset: a DOM
fingerprint (30 chars of `textContent` around the point + tag path, `bridge/bridge-script.ts:357-369`),
candidate scoring over the source (`position-finder.ts:56-137`), then verification by rendering each
candidate with a `<!--lens-probe-->` in hidden iframes (`HtmlPreview.tsx:401-487`, `position-finder.ts:198-214`).
That mapping is ill-posed, and most failures come from it:

1. The probe frame is never scrolled, so once the page is scrolled, placement fails whenever there is more
   than one candidate (`HtmlPreview.tsx:431-436`, `bridge-script.ts:418-419`).
2. A single candidate is accepted unverified (`HtmlPreview.tsx:785`): markers can land inside JS strings,
   `htm` templates or attributes and break the page. Bodies only escape `-->` (not `--!>`, not `</script>`).
3. Script-rendered content (React/htm/d3) has no source position, so comments on it orphan or misplace.
4. `renderInlineMarkers` replaces text nodes owned by the page's framework (`bridge-script.ts:253`), so
   React/htm pages can throw or update detached nodes.
5. Any remote keystroke clears the open composer and the user's typed text (`HtmlPreview.tsx:683-691`,
   `HtmlEditor.tsx:209-217`); in a busy doc you effectively can't comment.
6. The fallbacks are dead: manual placement in Source view and click-to-place need comment mode, which
   nothing turns on anymore; 12 tests are `it.skip` (`HtmlEditor.test.tsx:218-771`).
7. Pins attach to the *next* sibling element (`bridge-script.ts:258-267`); replies separated from their
   parent by anything but whitespace are silently dropped (`comment-store.ts:142-143`); edit/delete
   permission is by display name (`htmlCommentsAdapter.ts:48`); the relay needs a byte-exact guard so
   agents can't break markers (`crates/relay/src/mcp/tools/html_check.rs` `preserve_comment_blocks`).
8. Performance: a regex over the source per candidate (quadratic on big pages), up to 5 × 3 s probes,
   `parseComments` about 4× per change.

The one real strength of the current design: a marker in the source is attached mechanically to one exact
place (even among identical duplicates) and travels with the file (source view, GitHub mirror). Its
matching weakness: when surrounding content is rewritten the marker stays but drifts onto unrelated
content, and nothing records what it originally pointed at, so drift is undetectable.

## Prior art (all agree: store comments out of band, anchor with redundant selectors, resolve against what the reader sees)

- W3C Web Annotation selectors (TextQuote, TextPosition, CSS, XPath, Range, `refinedBy`):
  https://www.w3.org/TR/annotation-model/#selectors ; DOM implementation: Apache Annotator
  https://annotator.apache.org/ (`describeTextQuote` grows context until unique; collect all matches
  before highlighting, see its issue #112).
- Hypothesis fuzzy anchoring (XPath range → text position → fuzzy prefix/suffix near expected spot →
  fuzzy quote; diff-match-patch/Bitap; orphans stay visible with their quote):
  https://web.hypothes.is/blog/fuzzy-anchoring/ ; ~27% of highlights orphaned on the open web
  (https://arxiv.org/abs/1512.06195). Users prefer visible orphans to wrong matches and want a "guessed"
  state (Brush et al., CHI'01, https://dl.acm.org/doi/10.1145/365024.365117).
- Text Fragments (`#:~:text=prefix-,start,end,-suffix`), a compact quote syntax:
  https://wicg.github.io/scroll-to-text-fragment/
- Page-feedback tools (Vercel comments, BugHerd, Pastel, SitePing
  https://dev.to/neosianexus/i-built-a-self-hosted-alternative-to-markerio-heres-how-it-works-under-the-hood-2i7k):
  element selector (shortest unique CSS via `@medv/finder`) + point as % of the element box + viewport width.
  Figma: node id + offset. Jupyter: cell ids. Stable ids are what makes those robust.
- Code review: GitHub "outdated" comments keep old context and never move silently; Reviewable maps forward.
- LLM re-anchoring: Magic Markup (~90% on its benchmark, https://arxiv.org/abs/2403.03481);
  Codetations (LLM proposes, human confirms, https://arxiv.org/abs/2504.18702).
- CRDT anchors: Yjs RelativePosition (https://docs.yjs.dev/api/relative-positions), Peritext marks.
  Useful only as an extra clue for static source content; our MCP `edit` replaces whole spans, so item ids
  inside an edited span don't survive.
- Claude artifacts keep comment threads out of band with resolve and a "comment mode"; their anchor format
  isn't public.

## Design

### 1. Storage: out of band, in the same Y.Doc
`comments_v0` Y.Map in the content doc: thread id → `{ anchor, messages: [{id, author, authorId, ts, body}],
status: open|resolved, created, resolution?: {state, at} }`. Consequences: the HTML stays clean, edits can't
break comments, concurrent comment edits don't duplicate, threads can be resolved. Trade-off: comments no
longer travel with the file (GitHub mirror, copy/paste). Relay sync/persistence comes for free; git-sync
only mirrors `contents`.

### 2. Anchor: what was commented on, not where (re-resolved on every render)
Recorded by the bridge from the rendered DOM when the comment is made:
```
quote / prefix / suffix   exact selected text + context (grown until unique, Apache Annotator style)
scope                     nearest identifiable ancestor: #id / [data-lens-id] / an ancestor whose text is
                          unique on the page (identified by that text) / shortest unique CSS path
refinedBy                 the quote (or target element) *within* that scope, W3C `refinedBy` style
ordinal                   Nth match inside the scope, only when nothing else disambiguates
position hint             offset into the page's visible text (tiebreaker only)
point                     element pins (charts, images, canvases): x/y as % of the element's box
context                   viewport width, timestamp
```
Resolution (inside the iframe, after script rendering settles, and again on MutationObserver changes):
scope by id → scope by unique text/CSS → exact quote within scope → fuzzy quote (diff-match-patch/Bitap)
near the hint → whole-page fuzzy. Draw highlights with the CSS Custom Highlight API and pins in an overlay,
so the page's DOM is never modified. Layout changes (reflow, reorder, phone width) never matter: the
browser reports where the text is now.

Duplicate text: longer context → unique ancestor + `refinedBy` → author-provided ids → ordinal. If only
the ordinal disambiguates and the page has changed, show the thread as *guessed*, never confidently wrong.
At creation, warn when the anchor needed the ordinal fallback ("this item has nothing unique; the comment
may drift"). Optional extra tiebreaker: a Yjs RelativePosition into the source when the target is static.

### 3. States
anchored · guessed (fuzzy or ordinal after changes, "moved? confirm") · not visible (scope exists but is
hidden, e.g. another tab or collapsed) · orphaned (nothing matches; show the quote; drag to re-attach).
Never drop a thread. Viewers write the resolution state back (only when it changes) so agents can see it.

### 4. LLMs
- Re-anchoring: when an edit orphans or guesses comments, a cheap model (Haiku 4.5 via the editor server)
  gets the old quote/context/body plus the page's current visible text and proposes a new anchor, shown
  as *guessed* until someone confirms.
- MCP: `read` of an `.html` lists open threads (quote, scope, status, messages); a `comments` tool
  adds / replies / resolves (like Claude artifact comments); `edit` warns when the edit removed a quote an
  open thread depends on (static check: quote no longer in the source's visible text). Drop the
  byte-exact marker guard.
- Guide + page check: ask agents to give sections and repeated items stable `id`s / `data-lens-id`.

### 5. UI
Explicit Comment mode (button + `C`) replaces the right-click/selection hijack. In comment mode: select
text for a range comment, tap an element for a pin (works on phones). The composer holds its anchor in
memory, so collaborators typing never close it. Resolved threads behind a toggle.

### 6. Migration
One-time: for each inline comment, compute an anchor from the element it currently attaches to in the
rendered page, write the thread to `comments_v0`, strip the markers. Few documents have comments.

### Phasing
1. Out-of-band store, anchor recording/resolution, comment mode, migration, MCP read/comments tools;
   delete fingerprints, candidate scoring, probe iframes, inline markers (net code removal).
2. Guessed/not-visible/orphan states, edit-time warnings, LLM re-anchoring.
3. Optional: element pins with viewport context, per-width filtering, orphan snapshot thumbnails.

## Open questions (defaults in bold)
1. Move comments out of the source? **Yes** (trade-off: not in the GitHub mirror).
2. Auto-migrate existing inline comments and strip markers? **Yes.**
3. Explicit Comment mode instead of right-click/selection hijack? **Yes.**
4. Resolve instead of delete, resolved hidden by default? **Yes.**
5. LLM re-anchoring suggests + human confirms (vs auto-apply)? **Suggest + confirm.**
6. Add a per-browser author id (spoof-proof "edit my comment") while showing names? **Yes.**
7. Move markdown comments to the same model? **Not now.**

## Expectations (estimates, not measurements)
- Placement: near 100% for anything visible (no source mapping). High confidence.
- Survival: typos/styling/layout/new sections elsewhere ~98%+; reworded quotes mostly fuzzy-recovered or
  "guessed"; rewritten/removed content orphans visibly, LLM re-anchor recovers many. Riskiest case:
  repeated identical items without ids after reordering; handled by the guessed state.
- Collateral damage (broken pages, lost drafts, blocked agent edits): removed structurally.

## Measure first (recommended first step)
Benchmark both systems: ~15 real pages (the agent-test pages in the local fs relay under
`Relay Folder 1/Agent Tests/`, plus prod pages), a few hundred synthetic comments (text ranges, element
pins, script-rendered content, duplicates), replay realistic edit sequences (agents' edits plus LLM
section rewrites), and score placement success / correct / wrong (dangerous) / orphaned / LLM-recovered.
Build the new anchoring on Apache Annotator's matchers so the benchmark prototype becomes phase 1 code.

## Context
- HTML runtime (same week): `lens-editor/src/components/HtmlEditor/runtime/page-runtime.ts`,
  `bridge/page-services.ts`, relay `html_check.rs`; author guide `Lens/AI Guide/HTML Pages.md` (relay doc;
  its comment section must be rewritten when this ships).
- Shared comment UI: `lens-editor/src/components/Comments/*` (CommentsLayer, CommentCard, types),
  `Mobile/MobileCommentsSheet.tsx`; HTML adapter `HtmlEditor/htmlCommentsAdapter.ts`.
