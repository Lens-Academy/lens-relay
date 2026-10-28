# History viewer for the Lens editor: properties and open questions

Written by Claude (a new session on flowerbox, not yet named), 2026-10-23, for Lauren.
Lauren asked for "something vaguely in the genre of gdocs history or other history in a
multiplayer editor", to ship by Monday 2026-10-26.

## What Luc said

At the standup on 2026-10-20, Lauren asked how people felt about an edit history view.
Luc Brinkman answered (transcript lines 506 to 546, quoted exactly):

> [14:12] Don't yet.
> [14:13] Because we, like, sometimes when transcripts are uploaded, we put something
> confidential in there and only then an AI scrubs it out, which isn't good because the
> history is technically already in GitHub.
> [14:23] But history is not always safe.
> [14:28] But we should move towards a place where it is safe to do that.

Elias Schlie suggested letting an AI scrub a file's history. Luc replied "Or you'd have to
change the git tree."

## Facts the design rests on

Each fact below was checked on 2026-10-23.

1. The editor has two shared folders. "Lens Edu" holds course content. "Lens" holds the
   team's own documents, including meeting transcripts.
2. A sync service called relay-git-sync copies each folder into a git repository about
   every 30 seconds. Lens Edu goes to the repository lens-edu-staging, which is public on
   GitHub. Lens goes to lens-folder-relay, which is private.
3. The live documents do not keep deleted text. The relay server runs Yjs (the library
   that merges everyone's edits) with garbage collection on, so old text is discarded.
   The git copy is therefore the only source of old versions.
4. The Lens Edu git copy has snapshots back to 2026-01-18. In the two weeks to
   2026-10-23, about half of its commits name an author, such as "Elias" or
   "ai:opus-5.5:Andreas". The rest say "Relay Git Sync", which means the author is unknown.
5. The git copy lives on the production server, the same machine that runs the editor
   server. That disk is 88 percent full, with 4.5 gigabytes free. The git copy is 526 megabytes.
6. The editor already has a smaller feature: a 7-day log of edits made by AI tools,
   shown on the editor's "Recent" page. It covers AI edits only, so it cannot serve as
   the history of a file.

## Properties a good history viewer must have

Each property has a reason it is required. Lauren's method is to check each one, then
derive the design from the list.

1. **It shows nothing that its reader could not already read.** This answers Luc's
   objection. Lens Edu history is already public on GitHub, so showing it adds no
   exposure. Lens folder history would let anyone with an editor link to that folder read
   text that an AI later scrubbed. So the first version covers Lens Edu only. The server
   refuses any path outside Lens Edu, and a test proves that a Lens folder path gets
   refused. Sorrel noted that a reviewer found exactly this hole in an earlier route.
2. **It shows a file as it was at a chosen time.** This is the core of the feature.
3. **It shows what changed in each version, inside the text.** Added text is coloured
   green and removed text is red and struck through, as in Google Docs. A list of
   versions without the changes would force the reader to compare by eye.
4. **It says who made each version when the record knows, and says "unknown" when it
   does not.** It never guesses an author. A guessed name on a change is worse than none.
5. **It groups the 30-second snapshots into editing sessions.** One file can have
   hundreds of snapshots in a week. Google Docs groups edits by author and by gaps in
   time, and this viewer would do the same. Without grouping, the list is too long to use.
6. **It opens from the file being read, in one click.** A History button in the file's
   header opens a panel beside the text.
7. **It answers fast.** The version list and each version should each load in under one
   second, so that clicking through versions feels like browsing.

Two properties seem useful but not required for the first version:

8. Following a file across renames. Git can do this, but it adds cases to test.
9. Restoring an old version over the current text. This changes a shared document that
   other people may be editing at that moment, so it needs more care.

## How the design follows

- The editor server already keeps a full copy of the lens-edu-staging history for its
  promote feature, at `/data/lens-editor/promotion-repos/lens-edu-production` inside
  the editor container. The history viewer reads that copy, so it needs no extra disk.
  The server runs `git log` for the file's history and `git show` for a version.
- Git can build an index of which files each commit changed (a "commit-graph with
  changed-path filters"). On a copy of the same history, that index cut one file's
  `git log` from 0.47 seconds to 0.05 seconds. The index is 1.8 megabytes and took 1.3
  seconds to build. The server rebuilds it after it fetches new commits.
- The server route uses the editor's existing check for Lens Edu links
  (`requireEduShareToken`) and also checks that the requested path is inside Lens Edu.
- The panel lists sessions newest first. Each row shows the time and the authors.
  Clicking a row shows that version with its changes marked and opens it at the first
  change. The header above the text counts the words added and removed. The list does
  not show those counts, because each count needs two versions fetched.

## Questions for Lauren

Each question has a proposed answer. Silence on a question means the proposed answer stands.

1. **May the first version cover Lens Edu only, with no history for the Lens folder?**
   The proposed answer is yes. This avoids the leak Luc named. Luc should also agree, because his
   "don't yet" may have meant course content as well. A draft message for Lauren to
   relay: "Hi Luc — Claude here, building the history viewer for Lauren. v1 covers Lens
   Edu only (its git history is already public on lens-edu-staging), with no history for
   the Lens team folder. OK?"
2. **Where should the server read git from?** The proposed answer is the copy that the
   promote feature already keeps inside the editor container. A new copy would take about
   500 megabytes on a production disk with 4.5 gigabytes free. That copy is only as fresh
   as its last fetch, so the viewer fetches at most once a minute when someone opens it.
   The copy that relay-git-sync writes every 30 seconds is fresher, but it lives in
   another container and would need a new mount.
3. **Should the first version restore old versions?** The proposed answer is no. The viewer offers "copy this
   version's text" instead. Restore can follow once the viewer is in use.
4. **How should old versions show pending suggestions?** The git copy stores pending
   suggestions inline as CriticMarkup (marks such as two braces and a plus sign around
   added text). The proposed answer is to show them as the editor shows suggestions, because that is what
   people saw at that time.
5. **Who may open history?** The proposed answer is anyone with a Lens Edu link, including view-only
   links. The same history is already public on GitHub.

## Lauren's feedback on the first version (2026-10-26, held until after standup)

Lauren said "I like it as an initial version" and gave these four points, quoted exactly:

- "like gdocs, related groups of changes"
- "show formatted markdown, if possible closer to how editor sees it"
- "in the history list, show how many things changed in a given row, and a preview of what the first one was"
- "lots of "unknown" in the history, seems slightly distracting"

Status: not started. The first version is merged (5f720000) and was deployed to the production editor on 2026-10-28.

### How Strata reads each point (2026-10-28, before building)

Lauren may overrule any of these readings. Each one names what gets built.

1. "Like gdocs, related groups of changes." Google Docs lists editing sessions, and each
   session opens with a small arrow into the separate saves inside it. The panel will do
   the same. A session row gets an arrow, and each save inside it can be opened on its own,
   showing only what that save changed.
2. "Show formatted markdown, closer to how the editor sees it." The version is shown in a
   read-only copy of the editor itself, with the same headings, links, tables and suggestion
   marks. Added text is marked green, and removed text appears struck through in red where it
   used to be.
3. "How many things changed in a row, and a preview of the first one." Each row will say
   how many separate places changed, for example "3 changes". It also previews the first
   one, for example "causes → leads". A change is a run of edits with fewer than four
   unchanged words between them.
4. "Lots of unknown." Rows with no recorded author show no author line at all, instead of
   the word "unknown". AI authors are written plainly, so "ai:opus-5.5:Andreas" becomes
   "Andreas (AI)".

Assay's review asked for one more change. The server will fetch new versions in the
background, so no reader waits for GitHub.

