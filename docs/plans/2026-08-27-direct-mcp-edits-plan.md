# Direct MCP Edits + Recent-Changes Review — Implementation Plan

**Status:** Proposed plan (independent second pass over
`2026-08-27-direct-mcp-edits-recent-changes-notes.md`)
**Date:** 2026-08-27
**Related:** `2026-07-18-provenance-design.md`, `2026-07-02-suggestions-index.md`,
`2026-03-08-debounce-deadlock-fix.md`,
Asana [Add per-file changelog view](https://app.asana.com/0/1215416124171520/1217858508660082)

## 1. What we are actually trying to achieve

From the Discord thread (2026-08-25/26) and Luc's notes:

- **The suggestion round-trip is mostly theatre today.** Luc and Elias both
  bulk-accept. Elias samples a few changes first and iterates with the AI
  before accepting. Nobody rejects individual suggestions in practice.
- **So: write by default, suggest when it matters.** The goal is not to
  remove review; it is to move review *after* the write, and make it cheap:
  a "what changed recently" surface instead of an accept queue.
- **Human prose is the thing worth protecting.** Luc: "It's very rare that we
  want human text to be replaced by AI text." AI replacing/deleting *human*
  text should stay behind a suggestion. Adding new text, or rewriting text the
  AI itself wrote, can go straight in.
- **Review surface = recent changes, not indefinite history.** A `/review`-like
  page over the last ~7 days across files, plus in-file highlighting with a
  time window (5 min while actively iterating, up to days), ideally including
  what was *removed*, not just what was added.
- **Lauren's per-file changelog** is the same need seen from one file. The
  Asana task overstates what Yjs history gives us (see §2); an explicit event
  log gives us the changelog for AI edits almost for free.

Success looks like: a Claude session edits a course doc → most edits land
immediately → the human opens the doc, flips on "recent changes: last 1h", sees
AI insertions tinted and AI removals as struck-through ghosts, and skims. A
change that would have overwritten their own sentence is still sitting there
as a pending suggestion. On `/recent` they can see everything the AI did
across the folder this week.

## 2. Facts that shape the design (verified in code, 2026-08-27)

1. **Provenance today = who created each *surviving* character, at day
   granularity.** Editor: `lens-editor/src/lib/authorship-runs.ts` walks
   `ytext._start → item.right`, keeps `{from, to, client}` (drops `clock`,
   drops tombstones). Actor + date come from the `users` map
   (`lens-editor/src/lib/provenance.ts`; human client IDs rotate per local
   day; MCP client ID lives for the session, TTL 7 days —
   `crates/relay/src/mcp/session.rs:38,149`). No deleted-text content survives:
   the relay and browser docs run with GC on (`Doc::new()` everywhere), so
   tombstones lose their string immediately. **Nothing can reconstruct "what
   changed on Tuesday" from CRDT state. An explicit event log is the only
   honest source of a changelog.**

2. **The server *can* read `(client, clock)` runs through public `yrs` API.**
   The earlier note assumed `yrs` lacks a run iterator. It doesn't:
   `Text::diff_range(&mut txn, Some(&now), Some(&empty), YChange::identity)`
   (yrs 0.19.2 `types/text.rs:431`) emits one `Diff { insert, ychange: Some(YChange{Added, id}) }`
   per visible item when `empty = Snapshot::new(StateVector::default(), DeleteSet::default())`
   (`DiffAssembler::process`, `text.rs:617-631`). The `hi` snapshot is
   `txn.snapshot()`. It needs a `TransactionMut` because it may split items,
   which is harmless; we can run it on the scratch doc that
   `apply_attributed_edit` already builds (`crates/relay/src/mcp/provenance.rs:60`).
   Y.Text offsets on the server are **UTF-8 byte offsets** (`OffsetKind::Bytes`,
   see `crates/y-sweet-core/src/critic_surgical.rs:21-29`), same convention as
   `edit.rs`. So no yrs patch and no private-field walking is needed.

3. **The edit path already has the right shape for a mode decision.**
   `crates/relay/src/mcp/tools/edit.rs:execute` finds `old_string` in the
   *accepted* view, then under the awareness write lock re-verifies and calls
   `merge_edit` → `apply_attributed_edit` → `persist()`. A direct mode is a
   second branch at the same point, with the same lock, same attribution, same
   persist.

4. **Indexes are rebuilt at boot from the docs that are loaded anyway, and
   refreshed via the debounced search worker** (`server.rs:469-585`,
   `rebuild_suggestions_index` at `server.rs:3573`). `handle_suggestions`
   never loads content docs on demand (`server.rs:4850`). Any recent-changes
   index must follow this exactly.

5. **The `/review` frontend already has the UI we want**:
   `ReviewPage.tsx` groups by file, filters by author/location/**time** (dual
   slider, presets 1h/24h/7d, default = last hour), and navigates to
   `/<shortUuid>?pos=<byteOffset>` (`EditorArea.tsx:360-386` converts to
   UTF-16 and jumps). A recent-changes page is mostly a read-only reuse.

6. **`yrs::StickyIndex` (relative positions) is public and wire-compatible
   with `Y.RelativePosition`** (`moving.rs:403,553`), so the server can record
   an anchor the browser can resolve.

## 3. Design

### 3.1 Editing policy: server-decided `auto`, explicit `suggest`

`edit` gains an optional `mode: "auto" | "suggest"` (default `auto`). There is
no `direct` override; the server decides.

Decision procedure (Markdown docs only; JSON/raw-Y.Text paths are already
direct and stay as they are):

1. Match `old_string` in the accepted view as today.
2. Compute the **minimal diff** between `effective_old` and `new_string`
   (char-level LCS/Myers, e.g. the `similar` crate; ≤ a few KB so cost is
   irrelevant). Unchanged context the AI included for uniqueness never counts.
3. If there are **no deleted characters** → direct (pure insertion).
4. Otherwise map each deleted accepted-range back to raw positions
   (`compute_raw_positions`, as `merge_edit` does). If any deleted range
   overlaps a CriticMarkup span → **suggest** (keep the existing
   supersede-merge behaviour for edits inside pending changes; simple and safe).
5. Otherwise resolve provenance for the deleted raw ranges (fact 2) and map
   client IDs through the doc's `users` map:
   - every deleted char attributed to an `ai:` actor → **direct**
   - any char `human:`, unmapped, or unresolvable → **suggest**
6. `mode: "suggest"` skips 3–5.

The check runs **inside the write-lock section**, on the current doc state,
so it is TOCTOU-safe together with the existing re-verify.

Result strings: `Made the changes to X.` / `Made pending changes to X
(N characters of human-written text would have been replaced).` The AI does
not need to know the rule to use the tool; the description explains it in
two sentences.

Expectation to set with the team: today almost all existing prose is
**unmapped** (pre-provenance), so initially only insertions and rewrites of
AI-written text go direct; the direct share grows as content is (re)written
under provenance. That is the intended safe default, not a bug.

Things I'd explicitly *not* do in v1: whitespace-only or punctuation-only
carve-outs, "mostly AI" thresholds, or letting the AI claim text. All of these
erode the one rule people can hold in their head.

### 3.2 Activity events live in the content doc (`activity_v0`), index derived

Each direct edit writes one event into a top-level `Y.Map("activity_v0")` in
the **same scratch transaction** as the text mutation, so the delta applied to
the live doc carries edit + event atomically and they persist together. No new
storage surface, no separate crash-safety protocol, and boot-time rebuild is
free because all docs are loaded at startup anyway (mirrors `users` and the
suggestions index).

Event (key = `"{ts_ms}-{ai_client_id}-{clock_start}"`, value = `Any::Map`):

```
v: 1
ts: epoch ms
actor: "ai:<model>:<behalf>"          (users-map key)
author: "Luc's AI"                    (display label, same as CriticMarkup author)
mode: "direct"
kind: "insert" | "delete" | "replace"
old: deleted text            (capped, e.g. 4 KB, with `old_truncated: true`)
new: inserted text           (capped likewise)
ctx_before / ctx_after: ~40 chars each of accepted-view context
pos: accepted-view byte offset at event time (for ?pos= navigation)
client: ai_client_id
clock_from / clock_to: half-open clock range minted by this call
anchor: StickyIndex (Assoc::After) at the deletion point, encoded v1, base64
```

`clock_from/to` come from `scratch.transact().state_vector().get(&ai_client_id)`
before/after the mutation — cheap and exact, no per-call client ID rotation.

Retention: on every append, and in the existing GC/compaction sweep for
loaded docs, delete keys with `ts < now − 7d`. Tombstoned map entries are
GC'd (GC is on), so growth is bounded by one week of events. Docs that are
evicted and never touched again keep stale events until they are next loaded,
which is harmless (the index filters by time on read).

**Why in-doc rather than an `activity/` store object** (the alternative the
note leaned to): atomicity with the edit for free; zero new lock ordering;
rebuild-for-free at boot; and the in-file overlay needs exactly this doc's
events, which now arrive with normal sync. Cost: events sync to every client
that opens the doc (bounded: 7 days × capped text; a heavily AI-edited doc
might carry a few hundred KB for a week), and git-sync / Obsidian must ignore
the map (they already ignore `users`, `backlinks_v0` etc. — confirm for
git-sync in step 0). If the sync cost is judged unacceptable, the same event
struct can be moved to `activity/{folder_uuid}/{day}.cbor` store objects with
an in-memory index; the rest of the plan is unchanged.

Suggestion-mode edits are **not** recorded in v1: they are already visible on
`/review`, and once accepted their payload keeps the AI client ID, so the
authorship view still shows them. (Recording them as `mode: "suggestion"` is a
one-line addition if the global page should show both.)

### 3.3 `RecentChangesIndex` + endpoint

- `y_sweet_core::recent_changes_index::RecentChangesIndex`:
  `DashMap<doc_uuid, Vec<ActivityEvent>>`, `update(uuid, events)` (empty =
  remove), `get(uuid)`, plus `query(uuids, since_ms)`.
- Boot: populate from `activity_v0` in `rebuild_suggestions_index`'s loop
  (same doc pass; set `recent_changes_ready`).
- Incremental: the search worker's fast lane already rescans content docs on
  debounce; add the `activity_v0` read next to `suggestions_fast_scan`
  (read lock only, write to index while holding the read guard — same
  read-your-writes reasoning as suggestions). The MCP edit path also updates
  the index directly under the write lock so the page is current immediately.
- `GET /recent-changes?folder_id=&since_ms=` → resolves UUIDs through the
  folder's `filemeta_v0` (scoping, paths, deleted-doc filtering), returns
  `{files: [{doc_id, path, events: [...]}]}`. Gated by `require_index_ready`.
  Never loads content docs.
- `GET /recent-changes?doc_id=` is not needed: the editor reads the doc's own
  `activity_v0` map.

### 3.4 Global page `/recent`

Clone the `/review` skeleton (`ReviewPage.tsx`) into a read-only
`RecentChangesPage`: same folder fetch-in-parallel hook pattern
(`useSuggestions` → `useRecentChanges`), same file grouping, same
author/location/time filter bar (time presets 5m/1h/24h/7d; default 24h),
same `?pos=` navigation. Rows show old (struck) / new (tinted) with context.
No accept/reject. Link to `/review` for pending suggestions. Factor the filter
bar + slider out of `ReviewPage.tsx` rather than copy-pasting 1,000 lines.

### 3.5 In-file "recent changes" mode

Add a `recent` mode to the authorship toolbar toggle with a small time-window
control (presets 5m/1h/24h/7d; remember last choice).

- Extend `getAuthorshipRuns` to carry `clock` (one field; the walker already
  has `item.id`). Build the set of `(client, [clock_from, clock_to))` from
  `activity_v0` events within the window; tint surviving runs that fall in it
  (`Decoration.mark`, reuse the inline-tint machinery).
- For `delete`/`replace` events, render `old` as a struck-through inline
  `Decoration.widget` (precedent: `CommentBadgeWidget` in `criticmarkup.ts`)
  at `Y.createAbsolutePositionFromRelativePosition(anchor)`; if that returns
  null (item GC'd) fall back to searching `ctx_before + ctx_after` in the
  current text; if that also fails, list the event in a small per-file
  activity tray at the top of the editor instead of guessing.
- Multiple events on the same range: the tint is per surviving item so it is
  automatically "final state"; ghosts stack in the tray if they collide.
- Recompute on `activity_v0` `observeDeep` + doc change, viewport-scoped like
  the existing plugin.

### 3.6 MCP prompt/tool surface

- `edit` description: "Edits are applied directly when they add text or
  change text the AI wrote; edits that would replace human-written text
  become pending changes for review. Either way, just edit; the result tells
  you which happened." Drop the current "first-class pending changes" framing
  (the uncommitted working-copy change in `mod.rs`/`edit.rs` will be
  superseded — keep it until this ships, it is an improvement on its own).
- `mode: "suggest"` documented as "use when the user asked for a proposal
  they want to review before it lands".
- `session_intro` mentions `/recent` so the AI can point the user there.

## 4. Implementation steps

Each step is independently shippable and testable.

0. **Prerequisites (½ day).** Confirm relay-git-sync and the Obsidian plugin
   ignore unknown top-level maps (they must, given `users`); confirm
   `diff_range` with an empty `lo` snapshot yields `Added` for every item on a
   doc restored from a persisted snapshot (write the unit test first — this is
   the load-bearing assumption). Pick the diff crate.

1. **Provenance runs on the server (1 day).** `provenance::visible_runs(txn,
   text) -> Vec<Run{from,to,client,clock}>` (byte offsets) + `resolve_actor(doc,
   client) -> Option<String>` reading `users`. Tests: single client, mixed
   clients, after deletions, non-ASCII, after `apply_attributed_edit`.

2. **Auto routing in `edit.rs` (1–2 days).** Minimal diff → protected-range
   check → direct branch (`remove_range` + `insert` at raw offsets, mapped via
   `compute_raw_positions`) or existing `merge_edit` branch; `mode` param;
   new result strings. Tests: pure insert → direct; replace AI text → direct;
   replace human text → suggestion; mixed → suggestion; unmapped → suggestion;
   context-only human text does not force suggestion; deleted range touching
   a pending span → suggestion; `mode: suggest` forces suggestion; smart-quote
   path; concurrent-change re-verify still errors.

3. **Activity events (1 day).** Write `activity_v0` entry in the scratch
   transaction (extend `apply_attributed_edit` to return clock range; add a
   `record_activity` helper); prune >7d on append; StickyIndex anchor. Tests:
   event present after direct edit, absent after suggestion edit, clock range
   matches minted items, pruning, size cap.

4. **Index + endpoint (1 day).** `RecentChangesIndex`, boot rebuild, worker
   refresh, MCP write-through, `GET /recent-changes`. Tests mirror
   `tests/suggestions_endpoint_test.rs` (folder scoping, deleted doc filtered,
   503 before ready, since filter). Add the retention prune to the GC sweep.

5. **`/recent` page (1–2 days).** Factor filter bar out of `ReviewPage.tsx`,
   `useRecentChanges`, page + route + nav entry. Playwright smoke via the
   headless recipe in memory.

6. **In-file overlay (2–3 days).** `clock` in runs, `recent` mode + window
   control, insertion tint, ghost widgets with anchor → context → tray
   fallback. Tests for the run walker and for anchor resolution after later
   edits and after GC (this is where the empirical check the note asked for
   lands).

7. **Prompt + docs (½ day).** Tool descriptions, `AGENTS.md` note on the
   rule, `docs/relay-auth-customizations.md`/ops doc pointer to `activity_v0`
   and its retention.

Steps 1–4 are pure Rust and can go out before any UI (the global page is
already useful as raw JSON for debugging); 5 and 6 are independent of each
other.

## 5. Risks and how the plan handles them

- **Accidentally overwriting human text.** Protection is enforced server-side
  on the actual deleted characters, unmapped text counts as protected, and any
  ambiguity (markup overlap, unresolvable runs) degrades to a suggestion. The
  only way to lose human text directly is a wrong `users` mapping, which is
  the existing self-reported trust model.
- **Doc bloat / sync cost from `activity_v0`.** Bounded by 7 days and text
  caps; measured in step 3 on a busy dev-R2 doc before committing; fallback
  storage design is described in §3.2.
- **Prod hang class of bugs.** No new locks; the endpoint reads only the
  folder doc + in-memory index; worker refresh reuses the existing
  snapshot-keys-then-lock discipline; the MCP write-through happens under the
  lock the edit already holds.
- **Ghost placement drifting after later rewrites.** Three-tier fallback
  (anchor → context → tray); never place a ghost on a guess.
- **Team expectation mismatch.** Because most existing prose is unmapped, the
  first weeks will still produce many suggestions. Say so when announcing.

## 6. Decisions I made and what I'd like confirmed

Defaults I'd go with unless overruled:

- Default mode `auto`; `suggest` is the only override; no `direct` override.
- Unmapped text is protected.
- Events stored in-doc (`activity_v0`), 7-day fixed retention, 4 KB per text
  field cap.
- v1 logs **MCP direct edits only**; suggestion edits, moves, creates and
  human edits are not events (git-sync already gives a coarse per-file history
  for the synced folders; a human-edit changelog would need the server to
  diff every incoming update and is a separate project).
- `/recent` is read-only; pending suggestions stay on `/review`; revert is a
  later feature (and must itself respect the human-text rule).
- The in-file deletion ghosts are attempted in v1 (step 6) but are the first
  thing to cut if the anchor behaviour turns out poor in practice — insertion
  tinting plus the per-file tray already covers Lauren's changelog ask.

Open question only Luc can answer: is it acceptable that an AI insertion
*inside* a human sentence (no deletion) goes direct? By the stated rule it
does; if that feels too aggressive the rule could become "no deletion *and*
insertion point is not inside a human-authored word/sentence", which is a
small extension of step 2.

## 7. Amendments after review (2026-08-27)

A code-verifying review of this plan found the following; the implementation
follows the amended versions.

1. **`diff_range` panics on singleton clients.** `split_by_snapshot(hi)` looks
   up `ID(client, state)` for every client in `hi.state_map`;
   `BlockStore::find_pivot` (`yrs/block_store.rs:74`) divides by the last
   block's `end` clock, which is 0 for a client whose only block is a 1-length
   item — a realistic shape (a human typing one character under a day-rotated
   ID). Fix: build `hi` ourselves — the current state vector with any client at
   state 1 clamped to 0, and an **empty** delete set (also avoids walking the
   whole delete set per call). Items of clamped clients come back tagged
   `Removed` instead of `Added`; both are live runs. Any emitted run whose id
   is in the real delete set, or a byte total that doesn't match the text,
   means the walk is untrustworthy → treat as unresolvable → suggestion.
2. **Editor proxy allowlist.** `lens-editor/server/relay-proxy-auth.ts`
   default-denies unknown paths for folder-scoped tokens; add a
   `GET /recent-changes` rule mirroring `GET /suggestions`, with tests.
3. **Anchor.** `StickyIndex::at(_, _, len, Assoc::After)` is `None` at end of
   text. Take the anchor *after* mutation at the start of the changed region
   with `Assoc::After`, fall back to `Assoc::Before`; the encoded relative
   position carries the assoc, so the editor just decodes it.
4. **Direct application is per-hunk and must not straddle markup.**
   `spans_covering_accepted_range` ignores zero-contribution `{--x--}` spans,
   so a deleted accepted range could map to two raw ranges around pending
   markup. Rule: each deleted hunk must map to exactly one `Span::Plain`
   coverage; each insertion point must lie within (or at the edge of) a Plain
   span; hunks are applied back-to-front. `compute_raw_positions` becomes
   `pub(crate)`.
5. **Comments/highlights/`{~~ ~~}` are not spans.** They sit verbatim in the
   accepted view as Plain text. Any hunk that intersects a
   `{>>…<<}` / `{==…==}` / `{~~…~~}` byte range (or inserts strictly inside
   one) → suggestion.
6. **Smart quotes.** The policy diff runs over char sequences with
   curly/straight quotes normalised for *equality only*; offsets and inserted
   text use the original chars, so a quote-only mismatch never counts as a
   deleted human character.
7. **Clock range** is captured around the text ops only (before
   `register_actor` and the activity write). Clocks are UTF-16 units; they are
   only ever compared with item ids, never with byte offsets.
8. Plumbing: three `Server` constructors, the no-store early return in
   `startup_reindex`, and the single-`folder_id` query shape are mirrored from
   the suggestions index.
