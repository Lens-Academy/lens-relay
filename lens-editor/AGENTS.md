# Local Development

You can run the frontend against either production Relay or a local relay-server.

## Port Allocation (Multi-Workspace)

Ports are **auto-detected** from the directory name suffix (`-ws1`, `-ws2`, etc.) or the parent workspace directory (`ws1/lens-editor`, `ws2/lens-editor`, etc.):

| Service | Workspace 1 (ws1) | Workspace 2 (ws2) | Workspace 3 (ws3) |
|---------|-------------------|-------------------|-------------------|
| Vite dev server | 5173 | 5273 | 5373 |
| Relay server | 8090 | 8190 | 8290 |

Override with environment variables if needed:
```bash
VITE_PORT=5999 npm run dev
RELAY_PORT=8999 npm run relay:setup
```

## Three Server Modes

### 1. Production Relay (default)

```bash
npm run dev
```

Frontend connects directly to `relay.lensacademy.org`. No local server needed.

### 2. Local filesystem storage

```bash
# Terminal 1: Start relay + auto-populate test data
npm run relay:start

# Terminal 2: Start frontend
npm run dev:local
```

Filesystem-backed local storage at `/tmp/lens-relay-local-store`. Setup runs automatically after the server is ready and refreshes the test IDs (`local-test-folder`, `local-welcome`, etc.) with no interference with production. This is useful for quick isolated testing, but it has known gaps compared with production-shaped data; for workflows involving real folder metadata, blobs, backlinks, or other production-like behavior, use the Lens Relay dev R2 bucket instead. Developers can request dev R2 access from Luc Brinkman.

### 3. Local with R2 (copy of production data)

```bash
# Terminal 1: Start relay backed by R2
npm run relay:start:r2

# Terminal 2: Start frontend with production folder IDs
npm run dev:local:r2
```

Runs a local relay server against the **dev R2 bucket** (`lens-relay-dev`), a copy of production data safe to write to. No setup needed. Requires `crates/auth.local.env` (symlinked from parent dir, gitignored).

**R2 buckets:**
- `lens-relay-dev` — dev bucket, used by `relay:start:r2`
- `lens-relay-storage` — production bucket, used only by the prod server

## Integration Tests

```bash
# Requires local relay-server running (8090 for ws1, 8190 for ws2, 8290 for ws3)
npm run test:integration
```

Tests default to `http://localhost:8090`. Override with `RELAY_URL` env var. For production Relay, also set `RELAY_TOKEN`.

## Y.Doc Structure (Relay/Obsidian Format)

**Folder Document** has two Y.Maps for document metadata:

```javascript
doc.getMap('filemeta_v0')  // Modern format: Y.Map<path, { id, type, version, ... }>
doc.getMap('docs')         // Legacy format: Y.Map<path, guid>
```

Entries under `/_trash/` carry `trashed_at` (unix ms), written by the relay when a
file is deleted (`POST /doc/trash`) and cleared by a move out of the trash. The
relay purges them after `trash_retention_days`; the editor never removes filemeta
entries itself.

**Important:** For markdown documents, entries must exist in BOTH maps. Obsidian's `SyncStore.getMeta()` treats documents that exist only in `filemeta_v0` as orphaned and deletes them. Always write to both:

```javascript
folderDoc.transact(() => {
  filemeta.set(path, { id, type: 'markdown', version: 0 });
  legacyDocs.set(path, id);  // Required for Obsidian compatibility!
}, origin);
```

**Content Document** root types (all written by the relay or the editor, none of them content):

```javascript
doc.getText('contents')      // the markdown itself (CriticMarkup inline for pending suggestions)
doc.getMap('users')          // PermanentUserData: actor key → { ids, ds, meta } (provenance, src/lib/provenance.ts)
                             // moved, duplicated and re-pasted text keeps its authors: written under extra
                             // clientIDs registered to the original actor and date (keepAuthorship.ts)
doc.getMap('activity_v0')    // direct AI edits: event id → { ts, actor, kind, old, new, client, clock_from, clock_to, anchor, … }
                             // written by the relay's MCP edit path, pruned after 7 days; read by src/lib/activity.ts
                             // for the editor's "Recent" authorship mode and served on /recent via GET /recent-changes
doc.getMap('folds_v0')       // folded headings and indented blocks, shared by everyone on the page:
                             // fold id → { anchor (Y.RelativePosition JSON of the folded line's start), at }
                             // (src/components/Editor/extensions/sharedFolds.ts); the text itself is unchanged
doc.getMap('comments_v0')    // HTML pages only: comment threads, thread id → Y.Map { anchor, status, createdAt,
                             // createdBy, resolvedAt?, resolvedBy?, seen?, originalQuote?, messages: Y.Map<id, {…}> }
                             // (src/components/HtmlEditor/comments/thread-store.ts; the relay's comments MCP tool)
```

See `src/test/fixtures/folder-metadata/production-sample.json` for real production data.

## HTML documents

`.html` files open in `HtmlEditor` (Source / Preview / Split; Desktop, or Phone: a 390x844 screen at full resolution, shortened to fit the pane). The preview's runtime contract
lives in `src/components/HtmlEditor/runtime/page-runtime.ts` (CSP, import map, `buildSrcDoc`) and the in-frame
services in `bridge/page-services.ts`; both are bundled into the bridge by `vite-plugin-bridge-bundle.ts`. Pages that
hang the preview can be opened with `?view=source`. The author-facing rules are the relay doc
`Lens/AI Guide/HTML Pages.md`.

HTML pages are wiki-link targets like Markdown: `[[x]]` finds `x.md`, else `x.html` (widgets are
`widgets/<name>.html`, with their fields in a leading `<!--lens-widget ... -->` comment), here in
`src/lib/document-resolver.ts` and in the relay's `resolve_in_virtual_tree`. Links leave out the extension, and
renaming `x.md` to `x.html` rewrites no links. `HtmlDocumentLayout` gives a page the right sidebar with its
backlinks (outgoing links in an HTML page are not indexed), and promotion and `validate_content` carry
`widgets/*.html`.

Comments on HTML pages are stored out of band (`comments_v0`, above) and anchored to the rendered page:
- `anchoring/`: the page's visible-text index, describing a click/selection/element as an anchor, and resolving it
  again (exact quote + context → scope → fuzzy → between old context; `guessed` rather than confidently wrong).
- `bridge/comment-layer.ts`: runs in the preview frame; resolves on render and DOM changes, draws highlights and
  badges without touching the page's DOM, and implements Comment mode (button or `C`; Esc leaves).
- `comments/useHtmlComments.ts`: threads, document-order numbering, write-backs (refreshing drifted anchors,
  recording what editors saw for agents) and the one-time migration of old inline `<!--lens-comment-->` markers.
- The page can forge bridge messages: `HtmlPreview.tsx` accepts captures and descriptions only in reply to requests.
  Read-aloud requests from the page (`tts-units` with `play`, `tts-key`) are honoured only right after a real
  click or key press (user activation), and `tts-key` only while the player is open. Ctrl/Cmd+O pressed in the
  page reaches the parent as `shortcut` `o` and opens the quick switcher under the same activation check.
- `scripts/anchor-bench/run.ts <dir of .html>` benchmarks anchoring against edits on real pages.

## Concept relationships panel

Concept files (`Lens Edu/Concepts/<name>.md`) hold one row per related file under `## Relationships`: a level-3
heading that is a single wikilink, then free notes. Articles, video transcripts and lenses show the rows about them
in a "Concept relationships" panel at the top of the document (a block widget in the main editor), editable in place;
on a lens the rows about its `source::` articles and videos are shown too, read-only.

- `src/lib/concept-rows.ts`: the rule table (which folders get the panel), row parsing, matching by resolved target,
  new-row insertion, lens sources, grouping.
- `src/components/ConceptRowsPanel/`: the panel, row cards (edits go through `lib/embed-docs.ts`'s single live
  connection and `SectionEditor/y-section-sync.ts` bound to the row's text), the concept picker, the data hook.

The parsing rules are shared with the relay's MCP tools (`crates/relay/src/mcp/tools/concept_rows.rs`) and the
platform's content validator, and must stay in step: each implementation has one test per numbered rule ("canonical
concept-row rules v1 #N"). Format and rules: `docs/concept-relationships.md`.

Concept files themselves get a "Concept graph" header instead (same panel host, above the relationships panel if both
ever apply): a drawn layered graph (`@dagrejs/dagre`) of every ancestor from their `parent-concepts:` frontmatter, the
concept and its direct children (backlinkers in `Concepts/` whose parents include it, "+N" below each), then plain
"Parent concepts" / "Child concepts" lists (the accessible version; the drawing is aria-hidden). Read-only.

- `src/lib/concept-graph.ts`: `parent-concepts:` parsing ("concept graph rules v1 #N", shared with the relay's
  `concept_graph.rs`) and resolution, the capped walks (ancestors; two levels below for children and "+N"), cycle detection, the drawn graph's data. Pure.
- `src/components/ConceptGraphPanel/`: the header, the drawing (`ConceptGraphDrawing.tsx`, loaded lazily so only concept
  files download dagre) and its data hook (reads files through the relationships panel's
  `useSnapshots`, growing the set of files to read as the walks reach them).

## Concept map page (Context Accelerator)

`/concept-map` (••• menu, "Concept Map") draws the idea files of `Lens Edu/Context Accelerator LOs/` as a graph: one
file per idea (frontmatter `id`, `priority`, `topic`, `courses`; the outcome paragraph; then `## Requires`,
`## Helpful first`, `## Why it matters`, `## Lenses`, `## Tests`; only these heading names are read). `## Requires` and `## Helpful first` hold wikilinks to other ideas, a link to a file that does not
exist is an idea "not written yet". Four views (Map, Order, Table, Walk through) and a side panel; links that can edit also add an
idea, create a not-written-yet one, change an idea's two requirement lists (only those lines are rewritten) and add a
question (one typed `#### Question: Open|Choice` segment appended to `## Tests`). They also edit every part of an
idea ("Edit": name, outcome, priority, topic, courses, why, the lenses, both lists), rename it, delete it, and edit or delete a
question. Rules of every edit: only the part that changed is rewritten and the rest of the file stays byte for byte;
the save carries what the form was opened with and writes nothing when the file no longer says that; a part that
holds a pending suggestion or a comment is refused. An emptied section keeps its heading. A rename is the relay's
move (`movePath`, which rewrites links in other files; links it left under Requires / Helpful first are rewritten by
`renameLinkChanges`). A delete takes the idea's links out of the other ideas' two lists, then trashes the file
(`trashPath`: `Lens Edu/_trash/`, restorable); it stops when a file outside the map links to the idea. Questions of
types other than Open and Choice are edited in the file. In `options::` a right answer is `- [x] text` and a wrong
one plain `- text` (the platform's parser reports `- [ ]` as an error), and `multi:: true` is written whenever
several options are right (the platform refuses them without it).

- `src/lib/idea-map.ts`: file parsing, the graph (steps, circles, problems), sorting, the map's column layout, the
  text of a new file, the changes for a requirements edit, the text of a new question and the change that appends
  it, and the changes for editing an idea (`ideaEditChanges`), renaming or removing its links in other files
  (`renameLinkChanges`, `removeLinkChanges`) and editing or deleting a question (`questionEditChanges`,
  `questionDeleteChanges`). Pure. The platform reads the same files for the learner's
  tree, so the format is a contract: change it on both sides or not at all.
- `src/components/ConceptMapPage/`: the page, the four views, the panel, the two forms, and `useIdeaMap.ts` (reads
  the folder through `useSnapshots`, writes through `createDocument` and `withLiveDoc`). Everything but the hook
  imports only `contexts/AuthContext`, `lib/relay-api` (`PathExistsError`), `components/DocLink` and `lib/idea-map`,
  so the page can be built outside the editor with another `useIdeaMap`: keep it that way.
- More that the page does (each in the files named):
  - Requirement boxes (`PickList.tsx`) are keyboard comboboxes; a typed name no concept has can be added as a link
    to a concept "not written yet" (`pickChoices` in the lib). The concept forms also have "Needed for" and "Helpful
    for": saving writes the link into the other concept's file (`dependentEdits`), every check before the first write.
  - A box of the map is as tall as its name needs (measured, then laid out again); every textarea of the forms is a
    `GrowingTextarea`. The name of a concept stays a one-line field.
  - Several concepts can be selected (Ctrl/Cmd/Shift-click, or a box per row in the Table) to delete at once
    (`deleteIdeas`, `deletePlan`). `IdeaMap.profiles` is optional (a switcher of separate sets, "Copy to…"): the
    editor's hook provides none, a standalone build can.
  - The drawing: `src/lib/idea-map-layouts.ts` has the "Layout" / "Group by" / "Links" choice and `layoutFor`, which
    draws the map the chosen way; chosen in `MapLayoutSwitch.tsx`, kept per browser by `useMapLayoutChoice.ts` (only
    what was chosen by hand: the rest follows the map, `resolveChoice`: a map of more than 60 concepts opens in
    Groups, and groups are the author's topics as soon as one concept has a topic). The layouts, each with a line in
    `MAP_LAYOUTS` on what it is good for (shown as the tooltip): Groups (a small layered map per group in a frame),
    Topic grid (boxes only, links for the concept pointed at), Tree (`idea-map-tree.ts`: every concept under the one
    it builds on most directly), Organic (`idea-map-organic.ts`: groups as islands, one arrow per strongly linked
    pair), Left to right / Top to bottom (`idea-map-layered.ts`: columns by dagre, square lines on tracks of their
    own) and Around one concept. A new layout has to pass the checks every layout passes in
    `idea-map-layouts.test.ts` (no box on another, the same drawing every time, no line through a box where it
    promises that).
  - Topics: the frontmatter `topic:` of a concept file is the author's own group ("Topic (yours)" in Group by, a
    field in the forms, a column in the Table). "Clusters (computed from the links)" is Louvain on the links; no one
    chose those. A topic has one colour everywhere (`topicColours` in `ideaLook.ts`): its frame and the left edge of
    its boxes.
  - Links (`src/lib/idea-map-links.ts`): "Requires only" leaves Helpful first out; "Hide implied links" leaves out
    what a chain of Requires says already (the transitive reduction). Pointing at a concept or selecting it lights
    its whole chain (`chainOf`) and dims the rest. A `quiet` line (between groups, outside the tree, all of the grid)
    is drawn only while it is part of that chain.
  - `mapView.ts` has the view that shows the map whole (below the row of controls, `CONTROL_ROOM`); a map shown
    whole is fitted again when its frame changes size, one moved or zoomed by hand is left alone.
  - Walk through (`IdeaWalkView.tsx`, `WalkOverview.tsx`, `WalkStep.tsx`, orders in `src/lib/idea-map-walk.ts`): the
    map one concept at a time, against the overwhelm of the whole graph. It opens on the topics in reading order;
    a step shows one concept with what it builds on (left) and what it leads to (right). Four orders: Foundations
    first (every concept after what it requires, topic by topic), Topic by topic, Backwards from a goal, Follow my
    curiosity. Right / Left walk, a click on a neighbour is a detour, what was seen is kept per set of concepts in
    the browser (`useWalkStore.ts`).
  - Keyboard (keep it working when you add a control; `describe('by keyboard')` in `ConceptMapPage.test.tsx`):
    `FindBox.tsx` lists the matches under "Find a concept" (arrows, Enter opens or picks, Escape empties, "/" goes
    to it). `ideaKeys.ts`: arrow keys move the focus between the `[data-key]` elements of a view (`nextBox`); the
    map follows the focus. Enter on a concept opens it, Ctrl/Cmd+Enter and Shift+Enter do what those clicks do
    (`pickByEnter`). `formKeys.ts` (`useFormKeys`, both forms): Escape closes (asks once when something changed),
    Ctrl/Cmd+Enter saves from any field, Enter in a one-line field moves to the next field and never saves. The
    panel has E, R, Q, C and Delete while it holds the focus. The page moves the focus itself (`focusOn`: into the
    panel when a concept is opened by key and after a save or cancel, back to the concept when the panel closes,
    to the search box after a delete) and says what it did in a notice (`say`, `data-testid="idea-notice"`).
- Local data: the default seed (`scripts/setup-local-relay.mjs`) has the three real files. For a big set run
  `npx tsx scripts/seed-fake-ideas.ts --relay-url http://127.0.0.1:<relay port>` (150 made-up ideas in
  `Context Accelerator LOs (fake 150)`; `--count 12 --cycle` makes a small set with a circle), then pick the folder in
  the page's header or with `?folder=`. The script refuses any relay that is not on localhost.
