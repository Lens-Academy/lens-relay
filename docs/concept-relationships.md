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

## Who reads the rows

Three implementations parse the rows. They must agree.

| Implementation | File | What it does |
|---|---|---|
| Lens Editor | `lens-editor/src/lib/concept-rows.ts` | Shows the "Concept relationships" panel on articles, video transcripts and lenses. You can edit a row in the panel. The edit goes to the concept file. |
| Relay MCP | `crates/relay/src/mcp/tools/concept_rows.rs` | Adds a "Concept relationships" block before the file text when an agent reads an article, video transcript or lens. |
| Platform validator | `content_processor/src/concepts.ts` in lens-platform | Reports two rows for the same file in one concept file as an error. |

The MCP block is bounded: at most 40 concept files per file and 80 per read, at most 8 lens
sources, 1,500 characters per row and 20,000 per block. It says what it left out.

Each implementation has one test for each rule below. The tests are tagged
"canonical concept-row rules v1 #N". When you change a rule, change all three
implementations and their tagged tests in the same piece of work.

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

## Concept graph

Concepts form a hierarchy. A concept file can name its broader concepts. Every node is a
concept file in `Lens Edu/Concepts/`, which is a flat folder. Domains, topics and concepts
are all concept files. They differ only in how broad they are.

### Format

A concept file lists its broader concepts ("part of") in its frontmatter:

```yaml
---
parent:
  - "[[Control protocols]]"
  - "[[Monitoring and interpretability]]"
skill-tree: topic        # optional: domain | topic
---
```

- `parent:` is a list of wikilinks. A single value, `parent: "[[X]]"`, also works. Links
  are bare names or relative paths, and they resolve as the link indexer resolves them
  (case-insensitive, with a fallback from the folder root). Each must resolve to a file in
  `Concepts/`.
- A concept can have several parents. The **first** parent is the primary one. It gives
  the "main path" in displays, and later it will place the concept in the skill tree.
- `skill-tree:` marks the nodes the skill tree will show: `domain` is a row and `topic` is
  a group. Leave it out for a plain concept. v1 code only checks the value. The skill tree
  still reads `Domains and Topics/` until a later migration.

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

### Who reads it

| Implementation | File | What it does |
|---|---|---|
| Lens Editor | `lens-editor/src/lib/concept-graph.ts`, `src/components/ConceptGraphPanel/` | Shows a "Concept graph" header on every concept file: the main path upward ("Part of"), other paths, direct parents, and direct children ("Contains"). On request it also shows a tree of everything below. All names are links. The header is read-only, so you change parents in the frontmatter. |
| Relay MCP | `crates/relay/src/mcp/tools/concept_graph.rs` | A `read` of a concept file starts (first chunk only) with a "Concept graph" context block: the main path, other paths, direct parents, unresolved `parent:` entries, and direct children. |
| Platform validator | `content_processor` in lens-platform | Reports the errors below. |

The editor and the MCP server compute the graph in the same way:

- **Ancestors.** They follow `parent:` upward, breadth first, at most 20 levels and 200
  files. If a cap cuts the walk, they say so. The main path follows first parents. The
  other paths are all other simple paths from a top-level concept down to the file
  (at most 50).
- **Children.** These are the file's backlinks inside `Concepts/`, kept only when that
  file's own `parent:` resolves to this file. A plain link from another concept's text or
  rows does not make it a child. Descendants (editor only, loaded when you expand them)
  are found breadth first over children, with the same caps. A concept that has two
  parents is expanded once and marked at its other place.
- **Invalid content.** A cycle is shown with a note and is never followed. A `parent:`
  entry that is not a wikilink, or that does not resolve to a concept file, is shown as
  unresolved.
- **Parsing.** `parent:` is read line by line from the frontmatter. Both read block lists
  (`- "[[A]]"`, quoted or unquoted), single values and flow lists (`["[[A]]", "[[B]]"]`).
  Only the first `parent:` key counts. The MCP server reads the file with pending
  suggestions accepted, and the editor reads the raw text.

### Validator errors

For `Concepts/*.md` the platform validator reports these errors. It adds no new warnings.

1. `concept.parent-unresolved`: a `parent:` entry is not a wikilink, or it does not
   resolve to a file in `Concepts/`.
2. `concept.parent-self`: a concept lists itself as a parent.
3. `concept.parent-cycle`: there is a cycle through `parent:` links. It is reported once
   per cycle, on the file that sorts first, and names the files in order (A → B → C → A).
4. `skill-tree:` has a value other than `domain` or `topic`.
