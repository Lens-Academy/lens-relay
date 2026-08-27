# Direct MCP Edits and Seven-Day Recent-Changes Review

**Status:** Deferred design note; not scheduled for immediate implementation

**Date:** 2026-08-27

**Related:** `docs/plans/2026-07-18-provenance-design.md`, `docs/plans/2026-07-02-suggestions-index.md`

**Existing Asana task:** [Add per-file changelog view to Relay editor](https://app.asana.com/0/1215416124171520/1217858508660082)

## Purpose

This document preserves the product discussion about allowing the Relay MCP to
make some changes directly, retaining suggestions as a first-class editing
service, and adding a short-lived review surface for recent direct changes. It
is deliberately a design record for later use, not an instruction to implement
the feature now.

The central direction is:

- Suggestions remain an intentional, first-class service.
- The server may apply safe AI changes directly.
- New text and edits to AI-authored text are candidates for direct application.
- Replacing or deleting human-authored or unattributed text remains protected
  behind suggestions.
- Direct changes are recorded in a durable but short-lived activity log,
  retained for approximately seven days.
- That log powers a global review-like page and recent-change overlays in the
  current file, including temporary representations of deleted text.

## Conversation record

The user messages below are preserved verbatim. Assistant contributions are
summarized between them rather than reproduced verbatim.

### Luc: suggestion access should be treated as ordinary editing

> Okay. Just let that task be. Please update the prompting of the MCP server to explain to the AI that its changes are presented to the user as pending changes, but this is to be treated as a first-class service. The user has a UI where they can accept all the changes.
>
> The AI should treat this sort of editing as if it's editing a raw document without any problems. It can also make multiple edits to the same range, and the software will handle everything automatically.
>
> I'd emphasize that suggestions are a first-class editing service that the AI needs neither to be worried about nor to tell the user about, because the user is already aware of this. Although it can be fine to tell the user. Instead of saying, "I made the changes," you can say, "I made the pending changes." But it doesn't need to explain this in detail. The user will not be surprised about this. At most, they might just like a very brief implicit reminder about it.

**Assistant summary:** The MCP `edit` tool guidance was updated accordingly.
It now frames pending changes as normal, first-class editing; says the user can
accept everything at once; tells the AI not to hesitate, apologize, or give a
long explanation; and confirms that repeated edits over the same range are
merged automatically. The success message now briefly says that pending
changes were made. This work is separate from the possible future direct-edit
mode described below.

### Luc: direct edits and provenance-backed recent changes

> https://discord.com/channels/1440725236843806762/1481581688705519689/1541805482984087612
>
> All right. We're also considering changing how the Relay MCP server works in the first place—namely, allowing the AI to make direct edits instead of suggestions. It seems what would be really nice for this is to be able to use our provenance system a bunch more. Like, we can already see in the UI who wrote what. Um, my guess is it would be fairly feasible thereby to highlight recent changes—at least recent text, not so much recent deletions, but recent text in the current editor if you're looking at it.
>
> How feasible would it be to have something akin to the slash review page, but in this case, have it be a page that shows all the recent changes across different files? My guess is this would be a lot harder than just showing an index of all the things with pending changes, because my guess is that it's harder to find the provenance data than it is to find the data that the provenance belongs to. But I'm not quite sure about how the data is being stored, so I might be wrong here. I'd love for you to look into this.

The linked Discord message was an automated transcription of Luc saying:

> Does anyone ever use the name three name CP server in a way that they actually review and rejects any suggestions? Because I usually just bulk accept all of them, which seems to kind of defeat the purpose. So it's probably better to make the AI choose between write and suggest, but when we do the suggest, it is actually intended and we actually review it. But that by and large, it's kind of write by default. What do you guys think?

The immediate Discord follow-up added useful context. Elias said he generally
bulk-accepts but first samples changes, sometimes iterating with the AI before
accepting. Luc then proposed highlighting recent changes via provenance.
Lauren later suggested a per-file changelog, noting that the data is not well
connected to the CRDT view.

**Assistant summary:** Investigation found that provenance is stored inside
each content Y.Doc. Every live Y.Text item carries the client ID that created
it, and the document's `users` PermanentUserData map resolves that ID to a
human or AI actor. The existing editor already walks the live Yjs item chain
to color text by authorship.

However, the current provenance layer is an authorship snapshot, not a true
changelog. Its `registeredAt` value dates a client/editing session rather than
each edit. CRDT items have no wall-clock timestamp. It also intentionally only
covers text that still exists; deleted-text history is not retained. There is
no global provenance index. This means current-file highlighting of surviving
text is relatively easy at coarse session/day granularity, but an accurate
global recent-changes page requires a separate derived index or event log.

The existing `/review` page is easier because CriticMarkup embeds explicit old
text, new text, author, timestamp, and location. Relay maintains a dedicated
in-memory suggestions index, rebuilt at startup and refreshed by its debounced
indexing worker. A provenance/activity page should follow that indexed pattern
and must not load every document on demand; the previous full-folder review
scan caused a production hang.

### Luc: seven-day log, deletion overlays, and protecting human text

> Well, yeah, I can see a recent changes log being useful. It would show basically the same as the current review page with all the recent changes. As long as we don't store this data indefinitely and just store it for the last 7 days or so, this seems pretty nice. Yeah, that seems pretty, pretty, pretty damn nice actually.
>
> And then the current file highlighting—if that can just highlight, like, here are the things that, I don't know, whatever. It depends on the timescale. Maybe you want to be able to set this with a slider at the top. But if you're actively making edits, maybe you only want to see what are the changes it made in the last 5 minutes or so. Would you say the current file highlighting could then even show text that was removed based on that, based on the recent changes index? Or still only highlight the currently existing things that were added or changed?
>
> I don't have strong takes on the provenance clients IT. Maybe 7 days is a bit much, but it depends. If you have the history living in an index file instead of through the provenance ID, then maybe it doesn't matter.
>
> There's another idea I have: maybe we should allow the AI to make direct edits to text that was previously written by AI or for adding new text, but we should not allow it to directly edit human text. It's very rare the time that we want human text to be replaced by AI text. So I think we should probably always defend that behind requiring suggestions. How easy or hard would that be?

**Assistant summary:** A seven-day activity log can support both a global
review-like page and deletion overlays. Deleted text cannot be highlighted as
ordinary document content because it no longer exists, but the UI can render
it temporarily as struck-through ghost text at a stable or reconstructed
location. Insertions can be highlighted normally; replacements can combine a
highlight on the new text with a struck-through representation of the old
text. When later edits make an old location ambiguous, the event should remain
visible in a file activity panel instead of being placed incorrectly.

Protecting human text is implementable and should be enforced by Relay rather
than delegated to the AI. Relay can compute the minimal diff between the old
and new strings, inspect provenance only for characters actually removed or
replaced, and choose direct application only when all affected existing text
is AI-authored. Pure additions are direct. Human, mixed, unknown, or ambiguous
replacement ranges fall back to the existing suggestion path.

## What the current provenance system actually stores

For each content document:

1. Visible Y.Text items contain an immutable `(clientID, clock)` CRDT identity.
2. A top-level `users` Y.Map maps client IDs to actor keys such as
   `human:Luc` or `ai:opus-5:luc`.
3. Per-client metadata contains `registeredAt`.
4. The browser walks the live Y.Text item chain and merges adjacent items into
   authorship runs.

Important consequences:

- Provenance reliably answers **who created this surviving text?**
- It does not reliably answer **what changed at a particular minute?**
- `registeredAt` is session-level. Human editor client IDs rotate at local-day
  boundaries; MCP client IDs currently last for the MCP session, whose idle
  TTL is seven days.
- It cannot reconstruct deleted text after the fact. Deleted-text attribution
  was explicitly excluded from provenance v1, and PUD deletion records are
  cleared during compaction.
- The existing Asana task's claim that current Yjs history can reconstruct a
  complete per-file edit history is too strong. It can reconstruct authorship
  of current text, not timestamped document history or reliable deletions.

## Proposed editing policy

The default MCP edit operation should be **server-decided automatic mode**.
The AI requests an edit; Relay determines whether it is safe to apply directly
or must become a pending suggestion.

| Actual change | Result |
|---|---|
| Insert new text without removing existing text | Direct |
| Delete or replace only AI-authored text | Direct |
| Delete or replace any human-authored text | Pending suggestion |
| Delete or replace mixed human/AI text | Pending suggestion |
| Delete or replace unknown/unattributed text | Pending suggestion |
| Provenance or location cannot be resolved safely | Pending suggestion |
| Caller explicitly requests suggestion mode | Pending suggestion |

The policy applies to the **minimal diff**, not the whole `old_string` used to
identify the edit. An AI often includes human-authored surrounding context to
make a match unique; unchanged context must not force the edit into suggestion
mode. Only existing characters actually deleted or replaced need provenance
classification.

The AI does not decide whether its target is human-authored. It can request an
ordinary edit, and the server reports a concise result:

- `Made the changes` when applied directly.
- `Made pending changes` when protected text caused a suggestion fallback.

An explicit force-direct override should not exist. An explicit force-suggest
option is safe and useful.

### Enforcement mechanics

For Markdown edits, Relay should:

1. Read and match against the clean/accepted document view as it does now.
2. Compute a minimal diff from `old_string` to `new_string`.
3. Map each deletion/replacement hunk back to the accepted Y.Text positions.
4. Resolve the Yjs client IDs responsible for those existing characters.
5. Resolve client IDs through the document's PUD actor map.
6. Apply the edit directly only if every changed old character is attributed
   to an `ai:` actor; otherwise run the existing smart CriticMarkup merge.
7. Persist the edit and its activity event together, or with a recovery-safe
   ordering that cannot silently lose the audit event.

The TypeScript editor already has a private-internals Yjs run walker. Rust's
`yrs` API does not currently expose an equally convenient public iterator over
visible `{from, to, client, clock}` runs. Options, in preference order:

1. Add or upstream a small safe `yrs` API exposing visible item provenance
   runs over a Y.Text or range.
2. Add a narrowly-scoped local patch to `yrs` with tests around Unicode,
   mixed-client runs, deleted items, and concurrent inserts.
3. For an initial conservative version, inspect target positions through
   public sticky-index APIs, cap the amount of work, and fall back to
   suggestions whenever classification is expensive or ambiguous.

## Seven-day activity log

The recent-changes feature should not attempt to infer historical edits from
the final CRDT state. Relay already knows the exact change at write time and
should record it explicitly.

### Event shape

Each event should contain at least:

```text
event_id
relay_id / folder_id
doc_id
path at event time
actor and model/behalf identity
timestamp
mode: direct | suggestion
kind: insertion | deletion | replacement
old_text
new_text
context_before / context_after
stable start/end anchors
inserted Yjs client-and-clock ranges
```

The client-and-clock ranges are important. The MCP can retain one provenance
client ID for a session while Yjs clocks distinguish items created by each
edit call. Recording those clock intervals lets the editor highlight the exact
surviving items from one event without minting a new client ID per call.

### Retention and indexing

- Retain events for approximately seven rolling days.
- Prune expired durable events and the in-memory index continuously.
- Rebuild the in-memory index from the retained durable log after restart.
- Filter endpoint results through current folder metadata so deleted or moved
  files do not leak across folder boundaries.
- Use the same lock-ordering and debounced-indexing discipline as the search
  and suggestions indexes.
- Never build the page by opening every content Y.Doc in the browser or loading
  every content document on demand.

The exact durable backing is still a design choice. It should avoid permanent
growth, survive deployments, and support crash-safe writes. Plausible options
include a server-owned activity Y.Doc per relay/folder, or time-partitioned
storage objects with an in-memory index. Storing activity records in every
ordinary content Y.Doc would make atomicity easy but would also sync review
history to every editor client and create avoidable CRDT/tombstone growth.

## Global recent-changes page

The page should reuse the information architecture of `/review`, but it is an
activity browser rather than an accept/reject queue.

Suggested capabilities:

- Group by file, with folder/path context.
- Filter by actor, location, change kind, direct/suggestion mode, and time.
- Quick time presets: `5m`, `1h`, `24h`, `7d`.
- Show old/new text and nearby context.
- Link directly to the document and change location.
- Clearly distinguish direct changes from still-pending suggestions.
- Do not offer accept/reject controls for direct events; navigation and
  inspection are the primary actions. Reversion could be a later feature and
  should itself respect the human-text protection rule.

## Current-file recent-change display

Add a recent-changes display mode alongside the existing authorship modes. A
time control at the top of the editor selects the visible window.

Rendering proposal:

- **Insertion:** tint the currently surviving inserted Yjs items.
- **Replacement:** tint surviving new text and render the old text as a
  struck-through ghost at the event anchor.
- **Deletion:** render struck-through ghost text at the former location, with
  a gutter marker.
- **Detached event:** if anchors and context cannot locate the change safely,
  show it in a file-level activity tray rather than guessing.
- **Repeated edits:** show the final surviving text for the selected window;
  the activity tray can expose intermediate events if needed.

Stable Yjs relative/sticky positions should be captured before deletion, with
surrounding textual context retained as a fallback. Anchor behavior across
subsequent deletion and GC needs a focused empirical test before committing to
the exact inline UX.

## Suggested implementation sequence

This sequence is intentionally deferred.

1. **Specify behavior and storage.** Finalize direct/suggest policy, event
   schema, retention semantics, and durable backing.
2. **Provenance range API.** Implement and test safe server-side extraction of
   visible Y.Text provenance runs.
3. **Automatic direct/suggest routing.** Add minimal-diff provenance checks and
   preserve the existing suggestion fallback.
4. **Activity recording.** Record direct MCP edits with timestamps, old/new
   text, anchors, and inserted clock ranges; implement seven-day pruning.
5. **RecentChangesIndex and endpoint.** Rebuild at startup and refresh without
   on-demand full-folder scans.
6. **Global page.** Adapt `/review` patterns for read-only activity browsing.
7. **Current-file overlays.** Add time filtering, insertion highlights,
   replacement/deletion ghosts, and detached-event fallback.
8. **Hardening.** Test concurrent edits, repeated edits over the same range,
   Unicode offsets, moves/renames, file deletion, GC, restarts, stale anchors,
   folder scoping, and large editing sessions.

## Open decisions

- Is seven days the right fixed retention period, or should it be configurable
  within a small bounded range?
- Does the activity log initially cover only MCP edits, or all human and AI
  editor transactions? MCP-only is much simpler and directly addresses the
  motivation for direct AI editing.
- Should the global page include pending suggestions alongside direct events,
  or link to `/review` for those?
- Should direct-edit eligibility require positively identified AI provenance,
  treating all unknown text as protected? The safe default is yes.
- Should moves, renames, file creation, and eventual suggested deletion appear
  as activity events?
- What durable store provides the best combination of crash safety, atomicity,
  pruning, and low synchronization overhead?
- How should a deletion be displayed when its stable anchor no longer resolves
  after subsequent edits or CRDT garbage collection?
- Should reverting a direct AI change be a first-class action on the activity
  page, and if so, should the revert be direct only when it does not overwrite
  later human work?

## Non-goals for the first version

- Indefinite audit history.
- Reconstructing complete historical document snapshots from Yjs state.
- Direct replacement of human-authored or unattributed text.
- Client-side full-folder Y.Doc loading.
- Cryptographic attribution guarantees.
- Perfect inline placement of old deletions after arbitrary later rewrites.
