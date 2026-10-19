# Concept relationships

A concept relationship records what the team knows about one pair: a concept and a source.
A source is an article, a video transcript, or a lens. An entry means "we have information
about this pair". It does not mean that the two match. An entry can say "good source", or
it can say "considered, but it only mentions the term".

## Where the data is

Each relationship is stored once, in the concept file, as a row:

```markdown
# Low-stakes control

Free-text description of the concept (optional).

## Relationships

### [[../articles/ai-control-redwood]]
Best intro we have. §2 is the explanation; §4 drifts into high-stakes.

### [[../video_transcripts/some-talk]]
Uses the term once. Not an explanation.
```

Concept files are in `Lens Edu/Concepts/`. The text under a row heading is free text.

A concept file can start with frontmatter holding an `id:`, a uuid that stays the same when
the file is renamed. The editor writes one into every concept file it creates (from the
"Create new concept" choice in the panel), and the MCP session intro asks agents to do the
same. It is optional: the validator does not warn when it is missing.

```markdown
---
id: 0b6f3c2e-5d4a-4f1e-9c8b-7a6d5e4f3a2b
---
# Low-stakes control
```

## Who reads the rows

Three implementations parse the rows. They must agree.

| Implementation | File | What it does |
|---|---|---|
| Lens Editor | `lens-editor/src/lib/concept-rows.ts` | Shows the "Concept relationships" panel on articles, video transcripts and lenses. You can edit a row in the panel, including a lens's row shown on an article (rule #10). The edit goes to the concept file. |
| Relay MCP | `crates/relay/src/mcp/tools/concept_rows.rs` | Adds a "Concept relationships" block before the file text when an agent reads an article, video transcript or lens. |
| Platform validator | `content_processor/src/concepts.ts` in lens-platform | Reports two rows for the same file in one concept file as an error. Rules #8 and #10 are display only, so it does not implement them. |

The MCP block is bounded: at most 40 concept files per file and 80 per read, at most 8 lens
sources (for a lens) or 8 lenses (for an article or video, from at most 40 lens files read),
1,500 characters per row and 20,000 per block. What the 80 leaves after the file's own rows
is split fairly over those related files, in order. It says what it left out.

Each implementation has one test for each rule below. The tests are tagged
"canonical concept-row rules v1 #N". Rules #8 to #10 only change what a display shows,
so the validator has no tests for them. When you change a rule, change every
implementation it applies to and their tagged tests in the same piece of work.

## Rules (v1)

1. **Section.** A rows section starts at an ATX level-2 heading whose text is exactly
   `Relationships`. Closing hashes are allowed. Setext headings and emphasis do not count.
   Every such section counts. The validator warns when a file has more than one.
2. **Section end.** A section ends at the next ATX heading of level 1 or 2.
3. **Row.** A row is an ATX level-3 heading with up to 3 leading spaces. Its text is exactly
   one wikilink, `[[target]]`, with an optional `|alias` or `#anchor` inside the brackets.
   Whitespace and closing hashes may follow. `![[...]]` is not a row. `[[#heading]]` and a
   target that contains `[` are not rows.
4. **Row body.** The row body continues to the next ATX heading of level 3 or less.
5. **Ignored regions.** Headings in these regions are never rows: fenced code (``` or ~~~;
   the closing fence uses the same character, is at least as long as the opening fence, and
   has only whitespace after it; a fence indented 4 or more spaces is not a fence), `%% %%`
   comments, list items, block quotes, and frontmatter. The closing `---` of frontmatter can
   have trailing whitespace.
6. **Text view.** The MCP server parses the text with pending CriticMarkup suggestions
   accepted. The editor parses the raw text, because it edits at raw positions. The validator
   uses its normal validation view. A heading that exists only in a pending suggestion is a
   known difference. Do not add code for it.
7. **Matching.** A row belongs to the file that its link resolves to. The editor and the MCP
   server resolve links like the link indexer (case-insensitive, with a fallback from the
   folder root). The validator uses the platform resolver, which is stricter. It warns about
   a row that does not resolve.
8. **Lens sources.** For a lens, the editor and the MCP server also show the rows about the
   lens's sources. They follow every `source::` field, except in `#### Text` sections. They
   keep targets in `articles/` or `video_transcripts/`, with or without `.md`. They skip
   widgets. They use the first wikilink in the value. The MCP server follows at most 8
   sources.
9. **Sort order.** Displays sort concepts by name, case-insensitive; the order of non-ASCII
   names may differ slightly between the editor and the MCP block. This is cosmetic.
10. **Lenses that use a file.** For an article or a video transcript, the editor and the
    MCP server also show the rows about each lens that uses it. Those lenses are the
    file's backlinkers in `Lenses/` whose `source::` targets (read as in rule #8) include
    a link that resolves to the file (rule #7). The rows are labelled per lens and grouped
    per concept like rule #8, mirrored: a concept with a row about the file shows its lens
    rows with it, and concepts reached only through a lens come last. The editor shows
    every such lens, and its lens rows stay editable. The MCP server follows at most 8
    lenses.

## Concept graph

Concepts form a hierarchy. A concept file can name its broader concepts. Every node is a
concept file in `Lens Edu/Concepts/`, which is a flat folder. Domains, topics and concepts
are all concept files. They differ only in how broad they are.

### Format

A concept file lists its broader concepts ("part of") in its frontmatter:

```yaml
---
parent-concepts:
  - "[[Control protocols]]"
  - "[[Monitoring and interpretability]]"
skill-tree: topic        # optional: domain | topic
---
```

- `parent-concepts:` is a list of wikilinks. A single value also works. Each entry must
  resolve to a file in `Concepts/`. The parsing rules are below.
- A concept can have several parents. The **first** parent is the primary one. It gives
  the main path in displays, and later it will place the concept in the skill tree.
- `skill-tree:` marks the nodes the skill tree will show: `domain` is a row and `topic` is
  a group. Leave it out for a plain concept. v1 code only checks the value. The skill tree
  still reads `Domains and Topics/` until a later migration.
- The older key `parent:` is not read. Nothing has been migrated to the new key yet.

### Rules

- **No cycles.** The graph must be a DAG. A concept cannot be its own parent, directly or
  through other concepts.
- **Shortcut edges are fine.** If A is part of B, B is part of D, and A also lists D, that
  is allowed and gets no warning.
- **"Part of" goes upward only.** A row about a narrower concept is implicitly about every
  concept above it. It is never about the concepts below it.
- **Write each relationship row at the most specific level that is true.** The hierarchy
  supplies the broader implications, so do not copy a row up to the parents. Rollups of
  rows from narrower concepts are a later feature. v1 only shows the graph.

### Parsing rules (concept graph rules v1)

The editor and the relay read `parent-concepts:` line by line. Each has one test per rule,
tagged "concept graph rules v1 #N", and both use the same inputs. The platform validator
(lens-platform PR #1310) parses the frontmatter as YAML instead. The rules are chosen so
that it gets the same entries, including unquoted `- [[A]]`, which YAML reads as a nested
list.

1. **Block list.** `parent-concepts:` followed by `- entry` lines, indented or at column
   0. The list ends at the next key, which is a non-blank line at column 0 that does not
   start with `-`.
2. **Single value.** `parent-concepts: "[[A]]"`.
3. **Flow list.** `parent-concepts: ["[[A]]", '[[B]]']`. A comma inside quotes or inside
   `[[...]]` does not split entries.
4. **Quoted or not.** `"[[A]]"`, `'[[A]]'` and `[[A]]` are the same entry. An `|alias` or
   a `#heading` inside the brackets is dropped.
5. **Trailing comments.** Whitespace followed by `#` starts a YAML comment, as in
   `- "[[A]]" # main`. A `#` inside quotes is kept.
6. **Scope.** Only the frontmatter is read: a first line `---` up to the next `---` line.
   Only the first `parent-concepts:` key counts. An entry that is not a single wikilink is
   kept as written, and it is reported as unresolved. An empty entry is skipped.
7. **Resolution.** A link resolves like the link indexer: relative to the file first, then
   from the folder root, case-insensitive. It must resolve to a `.md` file in
   `Lens Edu/Concepts/`. A parent listed twice counts once.

### Who reads it

| Implementation | File | What it does |
|---|---|---|
| Lens Editor | `lens-editor/src/lib/concept-graph.ts`, `src/components/ConceptGraphPanel/` | Shows a "Concept graph" header on every concept file. It draws a layered graph (dagre), top to bottom: all ancestors with every parent edge, the concept itself highlighted, and its direct children with "+N" for the concepts below each. Below the graph are two lists, "Parent concepts" in frontmatter order and "Child concepts" in alphabetical order. These lists are the accessible version, and the drawing is `aria-hidden`. Every name is a link. The header is read-only, so you change parents in the frontmatter. |
| Relay MCP | `crates/relay/src/mcp/tools/concept_graph.rs` | A `read` of a concept file starts (first chunk only) with a "Concept graph" context block. The block lists "Parent concepts" as full paths, each with its main path up to the top, and "Child concepts" as full paths, each with "+N below". It adds notes for unresolved parents, cycles and caps. |
| Platform validator | `content_processor` in lens-platform | Reports the errors below. |

Both implementations compute the graph in the same way:

- **Ancestors.** They follow parents upward, breadth first, at most 20 levels and 30
  concepts, and say so when a cap cuts the walk. The main path follows first parents.
- **Children.** These are the file's backlinks inside `Concepts/`, kept only when that
  file's own parents include this file. A plain link from another concept's text or rows
  does not make it a child. At most 80 backlinkers are read, and the display says when
  more exist.
- **"+N below".** This is the number of a child's own children. It is found by reading at
  most 50 of the children's backlinkers in all. The 50 are split fairly: children take
  turns in path order, each gets an even share of what is left (at least 1), and an unused
  share carries forward. A `+` after the number means there may be more below. That is
  the case when a grandchild has backlinkers of its own (checked in the backlinks index,
  without reading anything) or when the child's share was smaller than its backlinkers. A
  child that got no share shows "+?". The editor shows "counting…" until the counts are
  ready, and it reads nothing below while the header is collapsed.
- **Bounded reads.** Each walk has its own cap, so one header or one `read` loads at most
  30 + 80 + 50 concept files: the ancestors, the children's candidates and the count
  files. Both sides take candidates in path order, so they pick the same files when a cap
  applies.
- **Invalid content.** A cycle is drawn as far as it goes, gets a note ("A cycle runs
  through this file", or one above it), and is never followed twice. An entry that does
  not resolve is reported as "Parent not found". A concept whose entries all fail to
  resolve shows "none resolved", not "top-level concept".
- **Text view.** The MCP server reads the file with pending suggestions accepted. The
  editor reads the raw text.

### Validator errors

For `Concepts/*.md` the platform validator reports these errors. It adds no new warnings.

1. `concept.parent-unresolved`: a `parent-concepts:` entry is not a wikilink, or it does
   not resolve to a file in `Concepts/`.
2. `concept.parent-self`: a concept lists itself as a parent.
3. `concept.parent-cycle`: there is a cycle through `parent-concepts:` links. It is
   reported once per cycle, on the file that sorts first, and names the files in order
   (A → B → C → A).
4. `skill-tree:` has a value other than `domain` or `topic`.
