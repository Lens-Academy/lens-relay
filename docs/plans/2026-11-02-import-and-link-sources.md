# Import and link sources

When a page links to external articles or videos, the person (or agent) who added it is offered one step:
import each source into the library and replace the link with a wikilink to the imported copy. Luc's reason:
"anything that's asking people to break their workflow (like going to the source importing page) is going to be
hard to use". He also wants imports for articles a page ends up not using, so the offer is not limited to sources
the page depends on.

## Decisions

- **The offer is about content, not creation.** There is no "doc created" event, and a sidebar-created page starts
  empty. The editor scans the open page's text instead, so a page written by an agent, pasted in, or synced from
  Obsidian gets the same offer the first time someone who can import opens it.
- **Ask once, and never block.** Dismissing a link records it in the page's `link_offers_v0` Y.Map, so nobody is asked
  about that link on that page again. Hide (×) is for this person only. A link someone ignored, hid, left unticked or
  stopped is remembered per browser: after 5 seconds on screen it isn't offered to that person again. Right-clicking a
  link can still import it.
- **The server finishes the job.** Accepting records a `link_back` on the import job, and the server swaps the link
  when the job ends. The person can keep working or close the tab, and an agent need not wait or poll. A browser that
  swapped links itself would strand them when the tab closed.
- **The link changes when the import finishes, not when the stub appears.** A wikilink to a page that then fails to
  fill is worse than an external link for a few more minutes. If an import fails, the link stays as it was.
- **Sources already in the library swap in the browser when the page is open.** The server's edit isn't on the person's
  undo stack, so Ctrl+Z after it would undo their typing and leave `[[path|]]`. A local swap is one undo step that
  brings the link back. An import that finishes later is still the server's swap, so that one can't be undone this way.
- **A URL matches the library more strictly than it dedups.** A dedup miss costs a duplicate import; a wrong match
  rewrites a page. `sameSource` keeps the port, route-style fragments (`#/…`) and differing `?ref=` apart.
- **Someone else's job is not this page's news.** `/links/check` takes the page's path (matched by doc id, so a rename
  doesn't lose it), so another page's running or failed import reads as an ordinary offer, and accepting joins it. Stop
  cancels only an import this page started that no other page has joined; otherwise it takes this page's link-back off.
- **One call, whatever the source's state.** `POST /api/add-article` with `linkBack` links what is already in the
  library at once and queues the rest. The MCP tool is the same call with `link_from`.
- **Humans decide directly; agents follow the edit policy.** A person clicking "Import and link" changes the page
  directly. An agent's swap goes through `edit_policy`: a link an AI wrote changes directly, a link a human wrote
  becomes a pending suggestion.
- **`Lens Edu` pages are left alone.** The platform rewrites wikilinks to lenses and modules only
  (`content_processor/src/flattener/resolve-text-links.ts`); a wikilink to an article stays literal text, so a swap in
  a lens would break a working link for learners. The offer and `link_from` both refuse pages under `Lens Edu/`.
  Importing without `link_from` still works there.
- **The relay scans; TypeScript decides.** URL spelling rules (`normalizeUrlForDedup`) stay in TypeScript. The relay
  returns frontmatter for the article and transcript folders, and the editor server keeps the index. A Rust index would
  have to port those rules, and scanning 1,280 articles per lookup is too slow for an editor panel.

## External link rules v1

Implemented in `lens-editor/shared/external-links.ts` and `crates/y-sweet-core/src/external_links.rs`, which must stay
in step. Both run `lens-editor/shared/external-link-cases.json`.

The scanner takes raw Markdown, CriticMarkup included, and returns links in document order.

1. Forms: `[label](url)` with an optional title, `<url>`, and a bare `http://` or `https://` URL. The scheme is
   case-insensitive and the URL keeps its spelling.
2. Images are not links: `![alt](url)`. A link whose label is an image is one link, and it is not swappable.
3. Skipped regions: leading YAML frontmatter, fenced code (``` and ~~~, CommonMark closing rule, an unclosed fence runs
   to the end; a fence may be indented any amount and sit in a quote or callout), indented code (four spaces or a tab
   after a blank line, unless it starts a list item, and the lines
   after it while they stay indented or blank), inline code, `%%…%%`, `{++ ++}` `{-- --}` `{~~ ~~}` `{== ==}`
   `{>> <<}`, `<!-- -->`, `[[wikilinks]]`, raw HTML tags, which may span lines, the contents of `<pre>`, `<code>`,
   `<script>` and `<style>`, and reference definitions (`[id]: url`).
4. An inline link's URL ends at its `)`, with balanced parentheses, or at whitespace before a title.
5. A bare URL stops at whitespace, any of `< > " ` | [ ] { }`, curly quotes, `« »`, `。 ， 、` or a long dash. Then
   trailing `. , ; : ! ? ' * _ ~` are trimmed, and a trailing `)` is trimmed while the URL has more `)` than `(`.
6. A label stays on one line. An autolink or bare URL straight after `](`, spaces allowed, is the end of a label that
   did not, so it is not swappable.
7. Not swappable, because a wikilink would lose something: a label containing `[ ] | * \` _ ~ $ < >` or `==` (an alias
   shows them as typed), a link with a title (`[a](url "title")`), and a URL with a `#fragment` (the copy has no
   such anchor). An empty label is swappable and takes the source's title.
8. `in_table` is true when the link's line starts with `|` after spaces and any `>`, or is a row of a table found by
   its delimiter row (`--- | ---`), outer pipes or not.

A link that isn't swappable is not offered, to a person or an agent: it would be imported and stay as it is.

### Classification (`shared/external-link-rules.json`)

In order, first match wins:

1. Not `http`/`https`: not a source.
2. Host in `skip_hosts`, exactly or as a subdomain, ignoring a leading `www.`: not a source.
3. YouTube hosts: a single video (`/watch?v=`, `/shorts/`, `/live/`, `/embed/`, `youtu.be/<id>`) is a `video`, and
   anything else is not a source.
4. Path ending in one of `skip_extensions`: not a source.
5. No path and no query (a site's home page): not a source.
6. Otherwise an `article`.

### Which pages

A page gets the offer when it is a `.md` file outside `Lens Edu/` and `_trash/`, and its frontmatter has neither
`source_url` nor `synced_from`.

## Swapping a link

`POST /doc/link-source` on the relay, server token only.

| Link | Becomes |
|---|---|
| `[label](url)` | `[[rel|label]]` |
| `[](url)`, `<url>`, bare URL | `[[rel|title]]` |
| Any of those in a table | The same with `\|` for the alias separator |

- `rel` comes from `compute_relative_wikilink`, from the page's current path. The job holds the page's doc id, so a page
  moved during an import still gets the right link.
- `title` has `[`, `]`, `|`, braces and newlines removed, and a run of `%` becomes one, so a source's title can't open
  markup or a comment in the page. An empty result falls back to the target's file stem.
- Links are found again in the live text at swap time. Offsets from earlier are never used.
- Unswappable links are left and counted.
- A direct swap edits only the markup around a label, so the label keeps its author.

## Editor

A one-line bar that floats over the top of the page area, so it stays in view for someone who pasted a link 300 lines
down and never moves the text. If the caret would sit under it, it steps down below the caret's line, and CodeMirror
keeps a scroll margin of its height. It never takes the keyboard and is never a dialog. A link with anyone's caret in
it, local or remote, is still being typed, so it isn't offered until the caret leaves. Every state below is in
`src/components/SourceLinksBar/bar-model.ts`.

| State | Text | Actions |
|---|---|---|
| Offer, all new | 3 sources on this page aren't in the library yet. | **Import and link**, Choose, Dismiss |
| Offer, one | example.com/post isn't in the library yet. | **Import and link**, Dismiss |
| Offer, all in library | 2 sources on this page are already in the library. | **Use library copies**, Choose, Dismiss |
| Offer, mixed | 4 sources on this page: 1 is in the library, 3 can be imported. | **Import and link**, Choose, Dismiss |
| Offer, more than 10 new | 34 sources on this page aren't in the library yet. | **Choose**, Dismiss |
| Working | Importing 2 sources, about 8 min. You can keep working or close this page. | Details, Stop |
| Done | 3 sources imported and linked. Or "2 sources linked.", or "1 source suggested." Clears after 8 seconds. | |
| Failed | 1 source couldn't be imported. | **Retry**, Details, Dismiss |

Choose opens a list under the bar, one row per source with a tick box, its host and path (or title if in the library),
an "In library" or "Video" tag, and a link to open it (the library copy for an "In library" row). Above 10 sources the
list starts unticked. Its footer has "Import and link N" and the estimate. In the
Working and Failed states Details shows the same rows with each one's state and any error.

Right-click on an external link adds "Import and link this source", which also works on a dismissed link.

In Suggesting mode the swap is a pending suggestion: the editor sends `protectHuman: true` and leaves it to the server.

v1 covers the main editor only: not HTML pages, `/edu`, or the section editor.

## Agents

`create` and `edit` end with a note when they add links that are sources, and when the session can import and the page
is eligible. `edit` lists only links the edit added.

```
Created Lens/Reading list.md

External links: this page links to 3 sources that could live in the library:
- https://example.com/post-a (line 4)
- https://www.lesswrong.com/posts/abc/title (line 9)
- https://youtu.be/xyz (line 12)
Offer to import them, unless the user has already said what they want: import_source with these urls and link_from
"Lens/Reading list.md" imports each one and replaces its link with a wikilink when it is ready. Sources already in the
library are linked at once. You don't need to wait, poll or edit the page. Each new import takes a few minutes and a
Claude review, so leave out links the page only mentions in passing.
```

`import_source` gains an optional `link_from` path. The result's rows report `linked`, `suggested` or `queued`.

## API

Types are in `lens-editor/shared/source-links-contract.ts`.

- `POST /api/add-article/links/check`: `{urls}` to `{ready, links, queue}`. Only sources come back. While the library
  index is loading, `ready` is false and states say only what the job list knows.
- `POST /api/add-article` with `linkBack`: as today, plus link-back. Rows gain `linked`, `suggested`, `link_failed`.
- `POST /doc/frontmatters` on the relay: `{folder, subfolder}` to `{docs: [{path, frontmatter}]}`.
- `POST /doc/link-source` on the relay: see above.

## Not in v1

Swapping links in `Lens Edu` pages (needs the platform to render article wikilinks), turning a pasted URL into a
wikilink as you type, HTML pages, and the other editors.
