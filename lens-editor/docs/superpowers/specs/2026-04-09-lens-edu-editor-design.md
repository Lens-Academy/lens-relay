# Lens Edu Editor — Power-User View

## Goal

A two-panel editor for Lens Edu course content. The left panel shows module structure (pages, submodules, learning outcomes, lens references) as a navigable tree. The right panel shows the selected lens rendered in the platform's visual style (Newsreader/DM Sans, warm off-white background, article embed cards) with inline editing via CRDT-synced CodeMirror. Article-excerpt sections expand inline to show the referenced source article text, also editable.

## Architecture

### Panel layout

- **Left panel (340px fixed):** Module structure tree — parsed from the module's Y.Doc. Shows frontmatter, Page headers, Submodule groups, Learning Outcome blocks (with their Test and Lens references nested inside), all collapsible. Clicking a Lens reference loads that lens in the right panel.
- **Right panel (flex):** Selected lens content — rendered in platform visual style. Text sections as rendered markdown, article-excerpt sections as embed cards with excerpt text (ellipsis before/after, no surrounding article context), chat sections showing tutor instructions in a green card. All sections editable on click via inline CM editors.

### Hierarchy

From the Lens Edu content, the nesting is:

```
Module (Y.Doc)
├── # Submodule:        (collapsible group, optional)
│   └── ## Page:        (contains Text/Chat sections)
├── # Learning Outcome: (references an LO Y.Doc)
│   ├── ## Test:        (from the LO doc)
│   ├── # Submodule:    (groups lenses within an LO, optional)
│   │   └── ## Lens:    (references a Lens Y.Doc → shown in right panel)
│   └── ## Lens:        (ungrouped lens, when no submodule)
└── # Page:             (top-level page with Text/Chat)
```

Markdown heading levels and labels map to section types:

| Pattern | Type | Notes |
|---|---|---|
| `# Submodule: X` | `submodule` | Collapsible group |
| `# Page: X` / `## Page: X` | `page` | Contains text/chat children |
| `# Learning Outcome:` | `lo-ref` | References LO doc via `source::` |
| `## Test:` | `test-ref` | Test section within LO |
| `## Lens:` | `lens-ref` | References Lens doc via `source::` |
| `# Meeting: X` | `meeting-ref` | Meeting marker |
| `### Text` / `#### Text` | `text` | Authored content with `content::` |
| `### Chat` / `#### Chat` | `chat` | Tutor instructions with `instructions::` |
| `#### Article-excerpt` | `article-excerpt` | References article via `source::` with `from::`/`to::` |
| `#### Video` | `video` | Video embed |
| `#### Question` | `question` | Assessment question |

### Multi-document connections

The editor connects to multiple Y.Docs simultaneously:

1. **Module doc** — always connected. Drives the left panel.
2. **Learning Outcome docs** — connected on demand when an LO reference is expanded. The `source::` wikilink in the module resolves to the LO's relay doc UUID. The LO's content (Test section, Submodule/Lens references) is parsed and shown nested under the LO in the left panel.
3. **Lens doc** — connected when a lens is selected. Drives the right panel.
4. **Article docs** — connected on demand when an article-excerpt is expanded in the right panel. The lens's `source::` wikilink resolves to the article's relay doc UUID.

All connections use the existing `useDocConnection` hook which caches and reuses Y.Doc connections.

### Document resolution

Wikilinks like `[[../Lenses/Cascades and Cycles]]` and transclusions like `![[../Learning Outcomes/Feedback cycles create discontinuity]]` need to resolve to relay doc UUIDs. Resolution strategy:

1. Parse the wikilink to extract the relative path (e.g., `Lenses/Cascades and Cycles`)
2. Use the relay's link index API (`get_links` endpoint) to resolve path → doc UUID
3. Fall back to matching against doc metadata if the link index doesn't cover it

### Excerpt range resolution

Article-excerpt sections use `from::` and `to::` fields containing partial text strings:

```
from:: "Cascades are when"
to:: "neutron multiplication factor?_"
```

To find the highlighted range in the article text:
- Search for the first occurrence of the `from::` value → `fromIndex`
- Search for the first occurrence of the `to::` value after `fromIndex` → `toIndex`
- Excerpt range is `[fromIndex, toIndex + toValue.length]`
- If `from::` is empty (`""`), start at 0
- If `to::` is empty or missing, go to end of document

## Right panel rendering

The right panel renders the selected lens in a style matching the production platform:

### Visual style

- **Background:** `#faf8f3` (warm off-white)
- **Max content width:** `720px`, centered
- **Fonts:** `Newsreader` (serif) for article titles and discussion questions; `DM Sans` (sans-serif) for body text
- **Brand color:** `#b87018` (lens orange) for accents

### Section rendering

**Power toolbar** at the top: Edit / Preview / Feedback / Raw mode pills. Shows lens filename.

**TL;DR** (from frontmatter `tldr` field): Compact card with orange accent, white background.

**Text sections** (`#### Text`): Rendered markdown (via ReactMarkdown or similar). `content::` field is the body. Editable on hover — blue outline appears, "click to edit" indicator, opens inline CM editor.

**Article-excerpt sections** (`#### Article-excerpt`): Rendered as an article embed card:
- Header: article title (Newsreader serif, 20px), author, source
- Body: ellipsis → excerpt text → ellipsis. No surrounding article context.
- Card styling: `border: 1px solid rgba(184, 112, 24, 0.15)`, `background: rgba(184, 112, 24, 0.04)`, `border-radius: 12px`, `box-shadow: 0 1px 4px 0 rgba(0,0,0,0.06)`
- Excerpt text is plain (no blockquote/left-border styling)
- Editable: clicking opens CM editor for the article doc, scoped to the excerpt range

**Discussion questions** (Text sections containing a question): Newsreader serif, 17px, italic, white card with `#e8e5df` border.

**Chat sections** (`#### Chat`): Green card (`background: #f0fdf4`, `border: 1px solid #bbf7d0`). Shows the `instructions::` content rendered as formatted text with headers, bullet lists, etc. No chat UI rendering. Editable on click.

**Video sections** (`#### Video`): Same treatment as article-excerpt but resolves to video transcript doc instead.

**Question sections** (`#### Question`): Show the question content and any assessment instructions. Rendered as a card, editable.

### Editing interaction

All sections are editable via the existing section editor infrastructure:
1. Hover → blue outline + "click to edit" indicator
2. Click → inline CM editor opens (via `createSectionEditorView`)
3. CM editor is CRDT-synced to the section's Y.Text range
4. Click "Done" or click outside → editor closes

For article-excerpt expansion:
1. The article-excerpt card shows the excerpt text by default
2. The excerpt text is editable — clicking it opens a CM editor connected to the article's Y.Doc, scoped to the excerpt range `[fromIndex, toIndex + toValue.length]`

## Left panel rendering

### Module tree

The left panel parses the module doc and renders a tree:

- **Frontmatter:** Collapsed card showing slug/id
- **Submodule headers:** Collapsible group with purple badge. Click to expand/collapse children.
- **Page headers:** Card with purple badge and page name.
- **Text sections** (under pages): Nested card with content preview, indented with left border.
- **Learning Outcome references:** Yellow-bordered block. When expanded, connects to the LO doc and shows:
  - The `learning-outcome` text from LO frontmatter (italic)
  - Test section (if present)
  - Submodule groups (if present, collapsible)
  - Lens references (blue cards with arrow → clicking loads lens in right panel)
- **Lens references:** Blue card showing lens name. The active lens (shown in right panel) has a highlighted border.

### LO expansion

When an LO reference in the left panel is clicked/expanded:
1. Parse the `source::` wikilink/transclusion to get the LO doc path
2. Resolve to relay doc UUID
3. Connect to LO Y.Doc via `useDocConnection`
4. Parse the LO doc's sections
5. Render the LO's Test, Submodule, and Lens sections nested under the LO block

## Component structure

```
LensEduEditor (top-level route component)
├── ModulePanel (left panel)
│   ├── ModuleTree (parsed module sections as collapsible tree)
│   │   ├── SubmoduleGroup (collapsible, contains children)
│   │   ├── PageCard (reuses SectionCard)
│   │   ├── LOBlock (expandable, connects to LO doc)
│   │   │   ├── TestSection
│   │   │   ├── SubmoduleGroup (within LO)
│   │   │   └── LensRefCard (clickable → loads lens in right panel)
│   │   └── TextPreviewCard
│   └── (inline CM editors when sections are clicked)
├── LensPanel (right panel)
│   ├── PowerToolbar (Edit/Preview/Feedback/Raw)
│   ├── LensTldr
│   ├── LensSection (rendered per section type)
│   │   ├── AuthoredText (Text sections, rendered markdown)
│   │   ├── ArticleEmbed (Article-excerpt, with excerpt + expand)
│   │   ├── TutorInstructions (Chat sections)
│   │   ├── QuestionCard (Question sections)
│   │   └── VideoEmbed (Video sections)
│   └── (inline CM editors when sections are clicked)
└── useDocConnection (manages all Y.Doc connections)
```

## URL routing

```
/edu/:moduleDocId
```

The module doc UUID is the entry point. LO and Lens doc UUIDs are resolved from wikilinks within the module content. No need to encode them in the URL — the left panel state (which LO is expanded, which lens is selected) is component state.

## What's NOT in scope

- **Reviewer view** — future skin over the same technical foundation
- **Comment/annotation UX** — future (layout accommodates it)
- **Course-level navigation** — future (shows one module at a time)
- **Drag-to-reorder sections**
- **Creating new lenses/LOs/modules** — this edits existing documents
- **Chat rendering** — shows tutor instructions only, no chat UI
- **Video/audio playback** — shows transcript text only
- **Preview mode** — the toolbar shows it but it's not in v1 scope
- **Feedback mode** — the toolbar shows it but it's not in v1 scope
- **Raw mode** — the toolbar shows it but it's not in v1 scope (existing section editor covers this)

## Key risks and decisions

1. **Document resolution performance:** Expanding an LO connects to a new Y.Doc. If a module has many LOs (like Existing Approaches with 1 LO containing 5 submodules × 3-4 lenses each), we should connect lazily — only when the user expands an LO or clicks a lens. `useDocConnection` already caches connections.

2. **parseSections evolution:** The current `parseSections` handles `#`–`####` headers and classifies types. It needs to additionally classify `# Submodule:`, `#### Question`, and `#### Article-excerpt` types, and handle both `#` and `##` level variants of Page/Lens/Test headers. This is additive — new pattern matches in the existing classifier.

3. **Wikilink resolution:** The `source::` fields use both `[[...]]` and `![[...]]` syntax. The `!` prefix means transclusion (embed content) vs. link. For our purposes both resolve the same way — we connect to the referenced doc and parse its content.

4. **Large modules:** The "Existing Approaches" module has 1 LO with 5 submodules containing ~18 lenses total. The left panel needs to be collapsible so it doesn't become overwhelming. Default state: submodules collapsed, expand on click.
