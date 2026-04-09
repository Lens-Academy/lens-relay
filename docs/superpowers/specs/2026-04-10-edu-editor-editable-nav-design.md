# Edu Editor: Two-Pane Module/LO Editing

## Problem

Only lens docs are editable in the Edu Editor today. Modules, Learning Outcomes (LOs), inline lenses that live directly inside modules, and the `#### Question`/`#### Text` sections embedded in LO `## Test:` blocks are all unreachable as editable content. The left nav (`ModulePanel` → `LOBlock`) also conflates "expand" and "select": clicking an LO toggles its children instead of selecting it for editing.

## Goals

- Single-click navigation to any lens, test, or inline lens anywhere in the module tree.
- In-place editing of each LO's `learning-outcome:` definition text (the only long-form text that stays in the left pane).
- Right pane renders anything lens-shaped: standalone lenses, inline lenses defined inside module files, and LO tests with their embedded `#### Text`/`#### Question` children.
- Editing reuses the existing Y.Text-based CM section editor without regressions on lens docs.

## Non-goals

- Add / delete / reorder structural elements. No creating new LOs, lens refs, submodules, tests, or modules.
- Multi-doc split view on the right (one lens at a time).
- Awareness / cursor presence (out of scope).
- Collapsing the left pane.

## Two panes

### Left pane — ModuleTreeEditor (~420px wide)

Structural tree of the module, with one long-form editable field (the LO definition) and no other in-place content editing. Scrolls vertically.

**Contents, top to bottom:**

- **Module header** — module title (from frontmatter `title`), slug, tags, discussion link. Click to open a small inline CM editor on the module's frontmatter section. Compact display, not long-form.
- **Module sections in document order**, one entry per top-level (`#`) section:
  - **`# Lens:` entry** (inline or referenced)
    - Tree entry with a "Lens" badge and the lens label.
    - If the `# Lens:` section contains a `source:: [[...]]` wikilink → badge + label; clicking opens the referenced lens doc on the right.
    - Otherwise (inline lens with `#### Text` etc. as siblings until the next `#`) → badge + label + small "inline" tag; clicking opens the subtree of the module doc on the right.
  - **`# Learning Outcome:` block** — a bordered card containing:
    - LO title (derived from the referenced LO's filename; fetched lazily from the LO doc).
    - **LO definition** — the `learning-outcome:` frontmatter field of the LO doc, rendered as a multi-line editable block. This is the only long-form editor on the left side. Writes back to the LO doc's frontmatter via the existing CM section editor mounted on the LO's frontmatter section.
    - **Children**, rendered always-expanded from the LO doc's sections:
      - `# Submodule:` → sub-label only, not clickable (pure grouping).
      - `## Lens:` → tree entry with "Lens" badge + label + optional "(optional)" tag. Click opens the referenced lens on the right.
      - `## Test:` → tree entry with "Test" badge + label "Test ({N} questions)" or "Test (empty)". Click opens the Test subtree of the LO doc on the right.
  - **`# Submodule:`** at module top level (rare but allowed) → sub-label + indented children.
  - **Anything else** (heading, meeting-ref, unknown) → compact tree entry that opens the module doc on the right, scoped to that section's subtree.
- Active right-pane selection is highlighted in the tree via background + border.

**LO-definition edit UX:** click the definition block → it becomes a CM editor scoped to the LO doc's frontmatter section. Matches the existing `useSectionEditor` pattern.

**No expand/collapse anywhere** — tree is always fully expanded.

### Right pane — ContentPanel

Renders a scoped view of a doc: either a full doc or a subtree. Takes a `ContentScope`:

```ts
type ContentScope =
  | { kind: 'full-doc'; docId: string; docName: string; docPath: string }
  | { kind: 'subtree'; docId: string; docName: string; docPath: string;
      rootSectionIndex: number; breadcrumb: string };
```

Renders:

- A toolbar (`PowerToolbar`) with the doc/subtree label. For a subtree, includes a small breadcrumb like "Test in Arguments for and against agendas.md".
- The sections from the scoped range, using the existing section renderers (`TextRenderer`, `ChatRenderer`, `VideoRenderer`, `ArticleRenderer`, `QuestionRenderer`, `HeadingRenderer`). The root header of the subtree is *not* re-rendered — it's implied by the toolbar.
- Click any section → CM editor mounts on that section (same as today's lens behavior).
- When no selection → a soft placeholder ("Pick a lens on the left").

### Subtree range computation

Given `sections: Section[]` (from `parseSections`) and `rootSectionIndex: number`, the subtree is:

- All sections after the root whose level is strictly greater than the root's level, until the first section with level ≤ root's level (or end of doc).

The root itself is included only for metadata (label, `source::` fields); its children are what the right pane renders.

Section level: we add `level: number` to the `Section` interface (easy: the parser already knows it from the header pattern, just needs to be exposed).

## Data model

### Existing

- Module doc (Y.Doc, WebSocket-connected) — its `contents` Y.Text is parsed on every change into `Section[]`.
- LO docs — same, one per LO referenced by the module.
- Lens docs — same, one per lens currently shown in the right pane.
- `useDocConnection` — shared connection pool; reusable.
- `parseSections` — extend to emit `level: number` per section.

### New

- `useLODocs(moduleSections, modulePath)` hook — eagerly fetches every LO doc referenced by the module, observes each LO's `contents`, returns `Record<uuid, { loPath: string; sections: Section[]; frontmatter: Map<string, string>; title: string }>`.
- `getSubtreeRange(sections, rootIndex): [from, to]` pure helper — returns `[rootIndex, endIndex)` based on section levels.
- `ContentScope` — selection type (above).

## Files

**New:**

- `src/components/EduEditor/ModuleTreeEditor.tsx` — left pane.
- `src/components/EduEditor/ContentPanel.tsx` — right pane; generalized form of today's `LensPanel`.
- `src/components/EduEditor/useLODocs.ts`.
- `src/components/EduEditor/getSubtreeRange.ts` — pure helper + unit tests.
- `src/components/EduEditor/ModuleTreeEditor/ModuleHeader.tsx`
- `src/components/EduEditor/ModuleTreeEditor/LoCard.tsx`
- `src/components/EduEditor/ModuleTreeEditor/LoDefinition.tsx`
- `src/components/EduEditor/ModuleTreeEditor/TreeEntry.tsx`
- `src/components/EduEditor/ContentPanel/renderers/` — extracted per-section-type renderers (Text, Chat, Video, Article, Question, Heading). Each takes `section`, `fields`, `editing`, `onStartEdit`, `metadata`, `lensDocId`.

**Modified:**

- `src/components/EduEditor/EduEditor.tsx` — swap panels, own the `ContentScope | null` selection state, default selection = `null` (empty right pane; see Behavior details).
- `src/components/SectionEditor/parseSections.ts` — add `level: number` to `Section` interface; populate it.

**Deleted:**

- `src/components/EduEditor/LensPanel.tsx` — replaced by `ContentPanel`.
- `src/components/EduEditor/ModulePanel.tsx` — replaced by `ModuleTreeEditor`.

## Behavior details

### Default selection on mount

No lens selected. Right pane shows the empty-state placeholder. Rationale: the left pane gives the user everything they need to see at a glance; forcing a default lens open would be arbitrary.

### Switching selections

When the user clicks a new entry on the left:

1. `EduEditor` updates its `ContentScope` state.
2. `ContentPanel` reacts: if the `docId` changed, tear down the current CM editor, reconnect. If only the scope changed within the same doc, keep the connection, swap the rendered range.
3. The active entry on the left gets its highlight styling.

### LO definition editing

The `learning-outcome:` frontmatter field lives in the LO doc's first section (the frontmatter). The LO definition renderer mounts a CM editor scoped to that section when clicked. CM changes write to the LO doc's Y.Text directly — no intermediate state.

Only one CM editor is mounted at a time across the entire app (matches current `useSectionEditor`). Clicking an LO definition while editing a right-pane section will tear down the right-pane editor first.

### Inline lens vs. referenced lens

A `# Lens:` section with a `source:: [[...]]` field → treated as a reference. Clicking it selects the **referenced** lens doc with a `full-doc` scope.

A `# Lens:` section without `source::`, followed by inline children (`#### Text`, `#### Question`, etc.) until the next `#` header → treated as inline. Clicking it selects the **containing module** doc with a `subtree` scope rooted at the `# Lens:` section.

### `## Test:` rendering

A `## Test:` inside an LO is a subtree-rooted entry. Clicking it selects the LO doc with a `subtree` scope rooted at the `## Test:` section. The `#### Text` and `#### Question` children are rendered and edited on the right exactly like any other lens content.

The left-pane label for a test shows `"Test ({N} questions)"` where N counts `#### Question` children, or `"Test (empty)"` if there are none.

## Testing strategy (TDD)

Tests live under `src/components/EduEditor/__tests__/` (new directory).

Order:

1. **`getSubtreeRange`** — pure unit tests against synthetic `Section[]` arrays with known levels. Covers: root alone, root with children, root with mixed levels, root at end of doc, nested roots.
2. **`parseSections` regression** — adding `level` must not break existing callers; snapshot test on existing fixtures.
3. **`useLODocs`** — mocked `useDocConnection`, asserts: fetches every unique LO uuid from `moduleSections`, returns `{ sections, frontmatter, title, loPath }` per uuid, updates on Y.Text change, tears down on unmount.
4. **`ModuleTreeEditor` rendering** — given a synthetic module + `useLODocs` map, assert the full tree renders with correct badges, LO cards, definitions, and children.
5. **`ModuleTreeEditor` click dispatch** — every entry type fires `onSelect(scope)` with the correct `ContentScope` shape.
6. **`ModuleTreeEditor` LO definition editing** — clicking a definition mounts CM on the LO frontmatter section; typing writes back to the LO doc's Y.Text.
7. **`ContentPanel` with `full-doc` scope** — existing lens sections render, CM edits, tearoff on doc change. Regression harness for current `LensPanel` behavior.
8. **`ContentPanel` with `subtree` scope** — given a doc + `rootSectionIndex`, asserts only the subtree sections render, and CM edits write to the right section of the doc.
9. **`EduEditor` integration** — end-to-end click paths with real fixtures:
   - Mount → empty right pane.
   - Click inline lens → `ContentPanel` shows subtree of module doc.
   - Click referenced lens → `ContentPanel` swaps to the lens doc.
   - Click LO test → `ContentPanel` shows subtree of LO doc (the `## Test:` children).
   - Click LO definition → CM editor mounts in the left pane; other panes unaffected.

## Open questions / risks

- **Default right-pane selection.** Defaulting to empty-state placeholder. An alternative (open the first lens in document order on mount) is friendlier but arbitrary. Revisit after use.
- **LO eager fetch cost.** A module with ~5–10 LOs opens that many y-sweet connections on mount. `useDocConnection` already does this when expanding LOs individually; the difference is timing. Acceptable.
- **`## Lens: (label)` header labels.** Some `## Lens:` headers carry an inline label like `## Lens: (Automating alignment)`. The parser's `cleanLabel` needs to handle the parenthesized form. Verify during implementation; extend `cleanLabel` if needed.
- **Module-header frontmatter edit.** The compact module-header renders title/slug/tags inline. Click-to-edit opens a CM editor on the frontmatter section. Consider whether inline fields (like tag chips) are worth the complexity, or if a full CM on the whole frontmatter block is fine. Default: full CM; keeps everything consistent.
- **Stale `rootSectionIndex`.** If a concurrent editor adds/removes sections in a doc currently being rendered as a subtree, `rootSectionIndex` could point at the wrong section. Detection: when section count changes, re-find the root by matching label + level. Fallback: show "subtree no longer exists; pick something on the left."
- **Test-rendering flicker.** Clicking a test on the left while the same LO's definition is being edited requires the CM editor to migrate from the left pane to the right pane. The single-editor-at-a-time constraint should handle this automatically, but it's worth a test.
