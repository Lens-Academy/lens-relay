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
9. **Sort order.** Displays sort concepts by name, without regard to case.
