# Text Provenance: Human vs AI Authorship Tracking

**Status:** Design approved, not yet implemented
**Date:** 2026-07-18

## Goal

Show, for every piece of text in a lens-editor document, whether it was written
by a human or by an AI — per character, visible at a glance, robust to
collaborative editing.

Motivation (beyond transparency): **attention economics**. Writing is cheap for
AI and reading is expensive for humans, so readers need a fast signal for how
much scrutiny a document deserves. Character-level provenance is the substrate;
document-level effort/process signals can be layered on later (out of scope for
v1, see Future Work).

Prior art: [proofeditor.ai](https://www.proofeditor.ai/) (Every's "Proof",
open-source at `EveryInc/proof-sdk`). Proof stores authorship as ProseMirror
marks on rich text (green gutter = human, purple = AI). We deliberately do NOT
copy their mechanism: inline marks would pollute our plain markdown (git-sync,
Obsidian clients), and their dual-write of doc + marks required a large repair
machinery. Our approach uses attribution the CRDT already provides.

## Core Mechanism

Every Y.Text item permanently carries the `clientID` of the Y.Doc instance that
created it — this is core yjs/yrs state, already persisted in our squashed
snapshots, already synced to every client. Attribution therefore reduces to
**mapping clientIDs to actors**, using the Yjs `PermanentUserData` ("PUD")
convention: a top-level `Y.Map` named `"users"` inside each content doc.

The relay already implements the server half:

- `crates/y-sweet-core/src/doc_connection.rs` — `register_new_client_ids()`
  registers new clientIDs under the connection token's `user` (currently
  dormant for lens-editor: our minted doc tokens carry no `user` field).
- `crates/y-sweet-core/src/permanent_user_data.rs` — `compact_user_data()`
  dedups `ids` arrays and clears `ds` arrays (fixes upstream yjs PUD bloat).

Key properties of this design:

- **Attribution by construction.** Any writer is attributed via its clientID;
  no write path can "forget to stamp".
- **Zero content pollution.** Markdown bytes are untouched; `ytext.toString()`,
  git-sync, and Obsidian are unaffected.
- **Late-bound meaning.** The clientID is baked into items at insert time, but
  what it *means* is a map entry written at any time — enabling the paste
  prompt, retroactive claims, and re-classification.
- **Single source of truth.** No overlay/range annotations. Resolution is:
  `item.id.client` → users map → actor. Corrections happen by remapping a
  clientID or by re-stamping text (delete + reinsert under a correctly-mapped
  clientID); never by side-band range records.

### Why not alternatives

- **In-place clientID rewrite:** impossible; `(clientID, clock)` is the item's
  CRDT address, referenced by neighbors and replicas.
- **Y.Text formatting attributes** (`{author: ...}`): works (validated that
  y-codemirror.next tolerates format deltas), but requires every write path to
  cooperate forever, and inserts inherit the left neighbor's attributes so a
  human typing inside an AI run silently inherits `author: ai` unless stamped.
- **Inline markup (Proof-style spans / CriticMarkup):** pollutes content;
  survives export; needs strip/repair machinery.

## Actor Model (v1)

Two classes only. Actor strings are the PUD user-map keys:

| Actor | Key format | Display |
|---|---|---|
| Human | `human:<display name>` | `Luc` |
| AI | `ai:<model>:<behalf>` | `Opus 4.8 (Luc)` |
| Unmapped | (no entry) | `Unknown` (gray) |

- `<behalf>` = the human on whose behalf the AI acted (from the MCP session's
  `author_name`, e.g. "Luc's AI" → behalf `luc`).
- `<model>` = self-reported by the MCP client via a new optional `model`
  parameter on `create_session`; fallback `ai:unknown:<behalf>` → "AI (Luc)".
- Explicitly **out of scope for v1**: scribe/verbatim-human attribution via
  MCP, mixed classes, effort metrics. Everything added through the MCP is
  marked AI, no exceptions and no override parameter.

### Timestamps

Map entries carry `registeredAt` (epoch ms) per clientID. Since one clientID ≈
one editing session, every text run resolves to who + session date. For
day-level dating, the editor rotates its clientID at local calendar-day
boundaries (new random ID + new map entry). CRDT items themselves have no
wall-clock time; this is the whole dating mechanism.

Note: this extends the canonical PUD entry layout (`ids`, `ds`) with a parallel
`meta` structure per user (clientID → `{registeredAt}`). The server-side
registration and compaction code must preserve it.

## Components

### 1. Editor: self-registration (`AwarenessInitializer.tsx`)

Next to the existing `setCurrentAuthor()` call:

```ts
const pud = new Y.PermanentUserData(ydoc, ydoc.getMap('users'))
if (!pud.getUserByClientId(ydoc.clientID)) {
  pud.setUserMapping(ydoc, ydoc.clientID, `human:${displayName}`)
  // + write registeredAt meta
}
```

Guard against duplicate registration (upstream PUD re-appends; our compactor
cleans up, but don't feed it). Re-register on display-name change and on
day-boundary clientID rotation. Note `Y.PermanentUserData.setUserMapping` may
not support our `meta` extension directly — small custom helper mirroring the
Rust layout is fine.

Human identity is client-claimed (display name), same trust level as the rest
of the system. Token-bound identity (auth-middleware passing `user` into the
relay token mint — structs already support it) is a later hardening option.

### 2. MCP: per-session scratch doc (`crates/relay/src/mcp/`)

Today `edit.rs` mutates the shared in-memory doc directly → all AI text lands
under the server doc's clientID, indistinguishable. Change: each MCP session
lazily creates a scratch `Doc::with_options(client_id = fresh random ID)`,
synced from the main doc's state; edits are applied in the scratch doc
and the encoded delta update is applied to the main doc — exactly how a remote
client works, just in-process. Register the scratch clientID as
`ai:<model>:<behalf>` (+ `registeredAt`) in the same flush as the first edit,
so there is no window of unattributed AI text.

`create_session` gains optional `model` (self-reported). CriticMarkup author
tags on suggestions/comments continue unchanged — they are the suggestion-layer
UX, not the provenance substrate.

### 3. Suggestion accept preserves authorship

Today accept/reject rewrites spans (`suggestion-actions.ts`,
`criticmarkup-actions.ts`), which would re-author accepted AI text under the
accepting human. Change accept to **surgically delete only the CriticMarkup
marker characters** (`{++`, `++}`, etc.), leaving payload items — and their AI
clientIDs — intact. This is what makes the word-level display honest: accepted
AI text stays purple; words the human then rewrites turn green.

### 4. Paste classification (editor)

On paste (CM `paste` handler / `input.paste` user events):

1. Mint a fresh clientID for the paste, apply the insert under it, restore the
   session's human ID. (Safe: one instance may hold many clientIDs; the store
   tracks a clock per ID. The hazard is only *cross-instance* ID reuse.)
2. Show a small non-blocking popover near the paste: **"Pasted text — who wrote
   it? [Me] [AI] [dismiss]"**, auto-dismissing after a few seconds.
3. The answer writes the map entry (`human:<name>` / `ai:unknown:<name>`);
   dismissed → unmapped → renders gray "unknown (pasted)". Classification can
   happen later (click the gray run) since mapping is late-bound.

Small pastes (below some threshold, e.g. < 20 chars) skip the popover and
inherit the human ID — nobody wants a prompt for pasting a word.

### 5. Renderer (editor)

New CM extension patterned on `criticmarkup.ts` (`ViewPlugin` +
`RangeSetBuilder`):

- Walk the Y.Text item chain (`ytext._start`, internal-but-stable): collect
  runs `{from, to, client}` from non-deleted countable items; merge adjacent
  same-client runs. Positions align 1:1 with the CM doc.
- Resolve via a reverse `Map<clientID, actor>` built from the users map
  (rebuild on `observeDeep`; O(ids) build, O(1) lookup).
- Recompute on ytext change + users-map change.

Display modes (toggle in editor toolbar, persisted preference):

1. **Hidden**
2. **Gutter** (default): thin edge strip, per-line majority-wins color —
   human blue, AI orange, unknown gray (green/red are reserved for the
   CriticMarkup suggestion layer; blue/orange is also the colorblind-safe
   pair). Genuinely mixed human/AI lines (both ≥25%) get a fixed-pitch
   blue/orange dashed stripe. (We currently hide `.cm-gutters`; the strip
   can be a CM gutter or a Proof-style fixed strip.)
3. **Inline**: gutter + per-character `Decoration.mark` background tint, so
   individual human-edited words inside AI paragraphs are visible.

Hover tooltip on gutter/inline runs: actor display name + session date
("Opus 4.8 (Luc) · Jul 18, 2026"; "Luc · Jul 12, 2026").

### 6. Corrections & retroactive attribution

- **Coarse (whole session misattributed):** remap the clientID in the users
  map. Re-attributes everything that ID wrote in the doc, on every replica,
  retroactively.
- **Claiming old text:** pre-feature text has clientIDs but no map entries.
  Click a gray run → "I wrote this" → registers that run's clientID under the
  claimant. One claim lights up that whole session's text. (Old MCP edits and
  previously-accepted AI suggestions carry misleading clientIDs — "unknown" or
  a wrong-looking claim is possible; accepted trust model.)
- **Fine (re-stamp a range):** delete + reinsert identical text in one
  transaction under a correctly-mapped clientID. Use a dedicated transaction
  origin so (a) local UndoManager ignores it, (b) future effort accumulators
  ignore it. Costs: tombstone churn; tiny concurrency window (concurrent
  inserts inside the range land at the collapse boundary); re-stamped text is
  indistinguishable from originally-typed text — by design, no audit trail.

v1 ships coarse remap + claiming; the fine re-stamp gesture can follow (v1.1)
— the mechanism is trivial, the UX (range selection → "mark as…") is the work.

## Edge Cases & Notes

- **Unknown ≠ AI.** Unlike Proof (unmarked defaults to AI), we have years of
  pre-existing human content; unmapped text renders gray, always.
- **Scale:** clientIDs persist only for *writing* sessions, scoped per doc;
  busy docs reach thousands of entries at a few bytes each. The state vector
  already grows identically; PUD adds a constant factor. Compaction exists.
- **GC/tombstones:** provenance of *current* text needs only live items.
  Deleted-text attribution is out of scope.
- **Section/HTML/Edu editors** share the same `contents` Y.Text via the same
  binding — human attribution works unchanged; renderer integration per editor
  surface can land incrementally (main Editor first).
- **Scripts** (`setup-local-relay.mjs` etc.) write under unmapped IDs → gray.
  Fine. Optionally register themselves as `ai:script:<name>` later.
- **Trust model:** self-reported end to end (same as Proof's `by` field). Not
  cryptographic. Server-side token-bound registration is the hardening path.

## Implementation Order

1. **Spike A — mappings accumulate:** editor self-registration (+
   `registeredAt`, day rotation). Ship early so real
   docs accumulate data before the renderer exists. Verify against a dev-R2
   doc that the users map populates and compaction preserves `meta`.
2. **Spike B — renderer:** run walk + reverse map + gutter mode; then inline
   mode + tooltips.
3. **MCP scratch-doc attribution** (+ `model` on `create_session`).
4. **Surgical suggestion accept.**
5. **Paste popover.**
6. **Claim-unknown flow; coarse remap UI.**
7. (v1.1) Re-stamp gesture; per-block intensity; effort/process signals
   (see Future Work).

During Spike A, verify empirically: (a) yrs GC settings on the relay and what
the delete set retains, (b) that `Y.PermanentUserData` client-side reads the
Rust-written layout without friction, (c) snapshot size impact on a busy doc.

## Future Work (explicitly deferred)

- **Scribe/verbatim-human attribution** via MCP (`attribution:
  "verbatim-human"`, `scribe:<human>:<model>` actors) — designed, cut from v1.
- **Effort / process signals:** per-actor chars-ever-typed (state vector +
  delete set), server-side active-editing-time accumulator, doc-header badge
  with process classes (human-written / human-drafted-AI-edited /
  AI-drafted-human-edited / AI-written).
- **Export surface:** provenance summary (% human) in git-sync frontmatter.
- **Token-bound human identity.**
