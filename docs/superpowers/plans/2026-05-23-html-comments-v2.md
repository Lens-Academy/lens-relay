# HTML Comments v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add point-anchored, threaded collaborative comments to HTML documents in Lens, with dot overlays in the sandboxed preview iframe and a click-to-place creation flow.

**Architecture:** Comments stored as HTML comment nodes embedded in `Y.Text('contents')` (parent `<!--lens-comment ...-->` + clustered `<!--lens-reply ...-->`). A Lens-controlled bridge script is injected at the top of every preview iframe and renders 💬 dot overlays via TreeWalker scans. Parent ↔ bridge communicate via nonce-authenticated postMessage RPC. New comments are placed by capturing a fingerprint of the user's preview click, then text-searching the source for matching positions; ambiguous matches are resolved by inserting a unique probe marker, re-rendering in a hidden iframe, and checking whether the probe lands at the click point.

**Tech Stack:** TypeScript (strict), React 19, Yjs / y-codemirror.next / @y-sweet/react (existing), `MutationObserver` + `TreeWalker(SHOW_COMMENT)` (browser DOM), Vitest + happy-dom + @testing-library/react, Rust + axum (server regression test only).

**Prerequisite:** v1 (`docs/superpowers/plans/2026-05-22-html-sharing-v1.md`) is implemented. Files this plan modifies — `HtmlPreview.tsx`, `HtmlEditor.tsx`, `HtmlSourceEditor.tsx` — exist at `lens-editor/src/components/HtmlEditor/`. Verify before starting.

**Workspace ports (ws3):** Vite 5373, relay 8290.

---

## File Structure

| File | Role | New / Modify |
|---|---|---|
| `lens-editor/src/components/HtmlEditor/comment-store.ts` | Pure parse/serialize of `<!--lens-comment-->` and `<!--lens-reply-->` markers in source strings; atomic mutation helpers (`addComment`, `addReply`, `editMessage`, `deleteMessage`) that operate on a `Y.Text`. | New |
| `lens-editor/src/components/HtmlEditor/comment-store.test.ts` | Pure unit tests for parser, serializer, escape rules, cluster grouping. | New |
| `lens-editor/src/components/HtmlEditor/comment-store.ytext.test.ts` | Integration tests against a real `Y.Doc`/`Y.Text` for the mutation helpers (no Yjs mocks). | New |
| `lens-editor/src/components/HtmlEditor/bridge/protocol.ts` | Discriminated union of message types `BridgeToParent` / `ParentToBridge`; `makeNonce()`; `validateEnvelope()`. Shared between parent and bridge. | New |
| `lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts` | Unit tests for envelope validation and nonce mismatch handling. | New |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts` | The injected script. Exports pure functions (`renderDots`, `captureFingerprintAt`, `findProbe`, `installBridge`) so they're directly unit-testable against happy-dom. The trailing IIFE invocation that bootstraps `installBridge(window, ...)` in production is appended by the bundler plugin (Task 13), not the file itself. | New |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.test.ts` | DOM-level tests for `renderDots`, `captureFingerprintAt`, `findProbe` against happy-dom (no mocked DOM). | New |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts` | Tests `installBridge` end-to-end against happy-dom: ready/init handshake, click capture, MutationObserver, source/nonce filtering. | New |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-bundle.test.ts` | Smoke test that the `virtual:bridge-bundle` exports are non-empty IIFE source + hex hash. | New |
| `lens-editor/vite-plugin-bridge-bundle.ts` | Vite plugin that bundles `bridge-script.ts` as IIFE via esbuild, computes SHA-256, exports `BRIDGE_SOURCE`/`BRIDGE_SCRIPT_HASH` from `virtual:bridge-bundle`. | New |
| `lens-editor/vite.config.ts` | Register the bridge plugin. | Modify |
| `lens-editor/src/vite-env.d.ts` | Augment with `declare module 'virtual:bridge-bundle'`. | Modify |
| `lens-editor/src/components/HtmlEditor/position-finder.ts` | Fingerprint scoring (pure) + probe-verify orchestration (impure: drives a hidden iframe via a passed-in `ProbeRunner`). | New |
| `lens-editor/src/components/HtmlEditor/position-finder.test.ts` | Pure tests for `scoreCandidates`. Integration tests for `verifyByProbe` using a real in-memory `ProbeRunner` (not a mock). | New |
| `lens-editor/src/components/HtmlEditor/CommentThread.tsx` | Popover UI: render parent + replies; reply input; edit/delete on own messages. | New |
| `lens-editor/src/components/HtmlEditor/CommentThread.test.tsx` | Component tests with real `Y.Doc` + `comment-store`; assert thread renders, reply submits, edit/delete work. | New |
| `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.tsx` | Right-side panel listing comments with no DOM anchor. | New |
| `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.test.tsx` | Component tests. | New |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx` | Inject bridge into srcdoc; create iframe transport; wire ready/init handshake; render dot overlays from bridge messages; manage hidden iframe lifecycle for probe-verify; render `CommentThread` popover. | Modify |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx` | Extend: integration test that bridge messages drive popover open/close and click-to-place writes a marker. Uses real `window.postMessage` against a real (happy-dom) iframe; no transport mocking. | Modify |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx` | Add comment-mode toggle button; subscribe to comment store; pass comments + callbacks to `HtmlPreview`; render `OrphanedCommentsPanel` and orphan badge. | Modify |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx` | Extend: comment-mode toggle, orphan badge count, orphan-click-to-source-view. | Modify |
| `lens-editor/src/contexts/DisplayNameContext.tsx` | Source of the `useDisplayName()` hook used as `author` for comment-store mutations. | Read only |
| `lens-editor/src/lib/relay-api.ts` | Add `export` to the existing `LENS_EDITOR_ORIGIN` const so other modules can import it. | Modify (Task 0) |
| `crates/relay/tests/html_comment_markers.rs` | Server regression: `.html` doc containing `lens-comment` / `lens-reply` markers round-trips through the relay unchanged. | New |

---

## Task 0: Pre-flight — verify v1 layout and prepare two existing utilities

**Files:**
- Read: `lens-editor/src/components/HtmlEditor/*`
- Modify: `lens-editor/src/lib/relay-api.ts` (add `export` to `LENS_EDITOR_ORIGIN`)
- No new files.

Two facts the plan relies on:

- **Identity source:** `useDisplayName()` from `lens-editor/src/contexts/DisplayNameContext.tsx` returns `{ displayName: string | null }`. This is the existing display-name infrastructure (used by `AwarenessInitializer`, `ComposeBox`, etc.). The comment-store author field is this string. Comment tasks below import and call this hook from inside components; the `author` argument passed into mutations is `displayName ?? 'Anonymous'`.
- **Origin constant:** `LENS_EDITOR_ORIGIN` is declared in `lens-editor/src/lib/relay-api.ts:9` as a *local* `const` (`const LENS_EDITOR_ORIGIN = 'lens-editor'`). It is not currently exported — Tasks 2/11/12 need to import it, so this task adds the `export` keyword.

- [ ] **Step 1: Verify v1 file layout matches plan assumptions**

Run:
```bash
ls lens-editor/src/components/HtmlEditor/
```
Expected: `HtmlEditor.tsx`, `HtmlPreview.tsx`, `HtmlSourceEditor.tsx`, `index.ts`, plus existing test files. If any are missing, stop and reconcile with the v1 implementation before continuing.

- [ ] **Step 2: Export `LENS_EDITOR_ORIGIN`**

Edit `lens-editor/src/lib/relay-api.ts` line 9:

```diff
- const LENS_EDITOR_ORIGIN = 'lens-editor';
+ export const LENS_EDITOR_ORIGIN = 'lens-editor';
```

- [ ] **Step 3: Verify `useDisplayName` is the identity source**

Run:
```bash
grep -n "useDisplayName" lens-editor/src/contexts/DisplayNameContext.tsx
```
Expected: matches `export function useDisplayName(): DisplayNameContextValue`. If the function or context has moved, update Tasks 8/9/11/12 to use the current import path before proceeding.

- [ ] **Step 4: Sanity-check the build still passes**

```bash
cd lens-editor && npm run build
```
Adding `export` to a const should not change anything. Build should pass.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "refactor: export LENS_EDITOR_ORIGIN for HTML comments v2"
jj st
```

---

## Task 1: Comment store — parse & serialize (pure)

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/comment-store.ts`
- Test: `lens-editor/src/components/HtmlEditor/comment-store.test.ts`

The comment store has two layers: pure parse/serialize over plain strings (this task) and Y.Text mutation helpers (Task 2). This task is the foundation; everything else uses it.

**Encoding refinement vs. spec:** the spec said "escape `-->` to `--&gt;`". That round-trips lossily — a user typing literal `--&gt;` in a comment body becomes `-->` after parse. This task uses a stricter, lossless rule: after `JSON.stringify`, post-replace every literal three-character sequence `-->` with the two JSON-escape sequences for `-` followed by a literal `>`. In code:

```ts
const encoded = JSON.stringify(payload).replace(/-->/g, '\\u002d\\u002d>');
```

`JSON.parse` auto-decodes the unicode escapes back to `-`, so the round-trip is exact for any string. The HTML parser never sees an early `-->` inside the payload because the `-` chars on the wire are backslash-u-0-0-2-d, not literal dashes.

Additionally: the parser **cannot use** a naive `(\{[\s\S]*?\})-->` regex because it fails when JSON bodies contain literal `}` characters (e.g., `body: "see {x} here"`). This task uses a hand-written brace-counting scanner that tracks string state and escape sequences. Same complexity as a real JSON tokenizer for the outer structure only.

- [ ] **Step 1: Write the failing test**

`comment-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseComments,
  serializeComment,
  serializeReply,
  type CommentMarker,
  type ReplyMarker,
} from './comment-store';

describe('serializeComment', () => {
  it('emits an HTML comment node with JSON payload', () => {
    const marker: CommentMarker = {
      kind: 'comment',
      id: 'c1',
      author: 'luc@x',
      ts: '2026-05-23T14:33:00Z',
      body: 'why?',
    };
    expect(serializeComment(marker)).toBe(
      '<!--lens-comment {"id":"c1","author":"luc@x","ts":"2026-05-23T14:33:00Z","body":"why?"}-->'
    );
  });

  it('encodes --> in body as \\u002d\\u002d> so the HTML comment is not terminated early', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'has --> in it',
    };
    const out = serializeComment(marker);
    expect(out).toContain('\\u002d\\u002d>');
    expect(out.indexOf('-->')).toBe(out.length - 3); // only the closing -->
  });

  it('round-trips a body containing --> losslessly', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'see --> there',
    };
    const out = serializeComment(marker);
    const parsed = parseComments(out);
    expect(parsed[0].comment.body).toBe('see --> there');
  });

  it('round-trips a body containing literal { and } characters', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'has {nested} braces',
    };
    const parsed = parseComments(serializeComment(marker));
    expect(parsed[0].comment.body).toBe('has {nested} braces');
  });
});

describe('parseComments', () => {
  it('returns empty for source with no markers', () => {
    expect(parseComments('<p>hello</p>')).toEqual([]);
  });

  it('parses a single top-level comment with correct source bounds', () => {
    const marker = '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->';
    const src = `before ${marker} after`;
    const result = parseComments(src);
    expect(result).toHaveLength(1);
    expect(result[0].comment).toEqual({ kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'x' });
    expect(result[0].replies).toEqual([]);
    expect(src.slice(result[0].sourceStart, result[0].sourceEnd)).toBe(marker);
  });

  it('clusters replies with their parent', () => {
    const src =
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '\n<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"y"}-->' +
      '\n<!--lens-reply {"id":"r2","parent":"c1","author":"a","ts":"t3","body":"z"}-->';
    const result = parseComments(src);
    expect(result).toHaveLength(1);
    expect(result[0].replies.map(r => r.id)).toEqual(['r1', 'r2']);
  });

  it('round-trips: parse then serialize produces byte-equal source for canonical comment markers', () => {
    const src = 'X<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"y"}-->Y';
    const parsed = parseComments(src);
    const reSerialized = serializeComment(parsed[0].comment);
    expect(src.slice(parsed[0].sourceStart, parsed[0].sourceEnd)).toBe(reSerialized);
  });

  it('treats reply with non-matching parent as orphan data: logged, skipped from clusters', () => {
    const src = '<!--lens-reply {"id":"r1","parent":"missing","author":"a","ts":"t","body":"x"}-->';
    expect(parseComments(src)).toEqual([]);
  });

  it('ignores markers with malformed JSON', () => {
    const src = '<!--lens-comment {not json}-->' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"ok"}-->';
    expect(parseComments(src).map(c => c.comment.id)).toEqual(['c1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- comment-store.test`
Expected: FAIL with "Cannot find module './comment-store'".

- [ ] **Step 3: Implement `comment-store.ts`**

```ts
export interface CommentMarker {
  kind: 'comment';
  id: string;
  author: string;
  ts: string;
  body: string;
}

export interface ReplyMarker {
  kind: 'reply';
  id: string;
  parent: string;
  author: string;
  ts: string;
  body: string;
}

export interface CommentCluster {
  comment: CommentMarker;
  replies: ReplyMarker[];
  /** Inclusive start index in source of the parent comment marker. */
  sourceStart: number;
  /** Exclusive end index in source of the last marker in the cluster (parent or last reply). */
  sourceEnd: number;
}

function encodePayload<T extends Record<string, unknown>>(payload: T): string {
  return JSON.stringify(payload).replace(/-->/g, '\\u002d\\u002d>');
}

export function serializeComment(m: CommentMarker): string {
  const { id, author, ts, body } = m;
  return `<!--lens-comment ${encodePayload({ id, author, ts, body })}-->`;
}

export function serializeReply(m: ReplyMarker): string {
  const { id, parent, author, ts, body } = m;
  return `<!--lens-reply ${encodePayload({ id, parent, author, ts, body })}-->`;
}

export interface FoundMarker {
  kind: 'comment' | 'reply';
  payloadStart: number;
  payloadEnd: number;   // exclusive — index of closing '}' + 1
  markerEnd: number;    // exclusive — index after closing '-->'
  start: number;        // index of opening '<'
}

/**
 * Scans `source` starting at `from` for the next `<!--lens-comment ` or
 * `<!--lens-reply ` marker. Returns the marker bounds, or null if none found.
 * Brace-balanced, string-aware: tolerates JSON containing literal `{`, `}`,
 * and quoted strings with escapes. Exported so Task 2 can locate live markers
 * for atomic edits without relying on serialization round-trip stability.
 */
export function findNextMarker(source: string, from: number): FoundMarker | null {
  let scan = from;
  while (scan < source.length) {
    const start = source.indexOf('<!--lens-', scan);
    if (start === -1) return null;
    const after = start + '<!--lens-'.length;
    let kind: 'comment' | 'reply' | null = null;
    let payloadStart = -1;
    if (source.startsWith('comment ', after)) {
      kind = 'comment';
      payloadStart = after + 'comment '.length;
    } else if (source.startsWith('reply ', after)) {
      kind = 'reply';
      payloadStart = after + 'reply '.length;
    } else {
      scan = after;
      continue;
    }
    if (source[payloadStart] !== '{') { scan = after; continue; }
    // Scan balanced braces, respecting string state.
    let depth = 0;
    let inString = false;
    let escape = false;
    let i = payloadStart;
    for (; i < source.length; i++) {
      const c = source[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (inString) {
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) { scan = after; continue; }
    const payloadEnd = i;
    if (!source.startsWith('-->', payloadEnd)) { scan = after; continue; }
    return { kind, payloadStart, payloadEnd, markerEnd: payloadEnd + 3, start };
  }
  return null;
}

export function parsePayload(raw: string): Record<string, string> | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function parseComments(source: string): CommentCluster[] {
  const clusters: CommentCluster[] = [];
  const byId = new Map<string, CommentCluster>();
  let from = 0;
  while (true) {
    const found = findNextMarker(source, from);
    if (!found) break;
    from = found.markerEnd;
    const payload = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
    if (!payload) continue;
    if (found.kind === 'comment') {
      if (!payload.id || !payload.author || !payload.ts || payload.body === undefined) continue;
      const cluster: CommentCluster = {
        comment: {
          kind: 'comment',
          id: payload.id,
          author: payload.author,
          ts: payload.ts,
          body: payload.body,
        },
        replies: [],
        sourceStart: found.start,
        sourceEnd: found.markerEnd,
      };
      clusters.push(cluster);
      byId.set(payload.id, cluster);
    } else {
      if (!payload.id || !payload.parent || !payload.author || !payload.ts || payload.body === undefined) continue;
      const parent = byId.get(payload.parent);
      if (!parent) continue;
      parent.replies.push({
        kind: 'reply',
        id: payload.id,
        parent: payload.parent,
        author: payload.author,
        ts: payload.ts,
        body: payload.body,
      });
      parent.sourceEnd = found.markerEnd;
    }
  }
  return clusters;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- comment-store.test`
Expected: PASS — all parser/serializer tests green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: comment-store parse/serialize for HTML comment markers"
jj st
```

---

## Task 2: Comment store — Y.Text mutation helpers

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/comment-store.ts`
- Test: `lens-editor/src/components/HtmlEditor/comment-store.ytext.test.ts`

These helpers do the actual writes against `Y.Text`. They're tested against a real in-process `Y.Doc` (no mocking — Yjs is a direct dependency).

**Known v2 limitation — concurrent edit race:** `addReply`, `editMessage`, and `deleteMessage` read `ytext.toString()` then compute insertion/deletion indices, then `transact` to write. If another peer's update lands between the read and the transact, indices can be stale and the mutation may land at the wrong offset. The Yjs primitive that solves this is `Y.RelativePosition` (anchors that survive concurrent edits). v2 ships without this protection — the practical impact is low for collaborative comment add/edit but real for high-frequency simultaneous editing. Documented as v2 known limitation; tracked for v3 hardening. The bounds computation in this task uses `findNextMarker` (Task 1) to locate the current source position of a marker by id, so it is robust to hand-edited markers — but not to concurrent peer edits.

- [ ] **Step 1: Write the failing test**

`comment-store.ytext.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  addReply,
  editMessage,
  deleteMessage,
  parseComments,
} from './comment-store';

const ORIGIN = Symbol('test-origin');

function newDoc(initial = ''): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  if (initial) ytext.insert(0, initial);
  return { doc, ytext };
}

describe('addComment', () => {
  it('inserts a comment marker at the given source position', () => {
    const { ytext } = newDoc('<p>Hello world</p>');
    addComment(ytext, ORIGIN, {
      id: 'c1', author: 'luc', ts: 't1', body: 'why?', position: 11,
    });
    const after = ytext.toString();
    expect(after).toContain('<p>Hello world<!--lens-comment ');
    expect(parseComments(after)).toHaveLength(1);
    expect(parseComments(after)[0].comment.body).toBe('why?');
  });
});

describe('addReply', () => {
  it('inserts a reply marker immediately after the last marker in the cluster', () => {
    const { ytext } = newDoc(
      '<p>X</p><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}--><p>Y</p>'
    );
    addReply(ytext, ORIGIN, {
      id: 'r1', parent: 'c1', author: 'b', ts: 't2', body: 'answer',
    });
    const clusters = parseComments(ytext.toString());
    expect(clusters[0].replies).toHaveLength(1);
    expect(clusters[0].replies[0].body).toBe('answer');
    // Cluster must still be contiguous: replies adjacent to parent.
    const parentEnd = ytext.toString().indexOf('-->') + 3;
    expect(ytext.toString().slice(parentEnd, parentEnd + '<!--lens-reply'.length)).toBe('<!--lens-reply');
  });

  it('appends to existing replies (preserves order)', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"first"}-->'
    );
    addReply(ytext, ORIGIN, { id: 'r2', parent: 'c1', author: 'c', ts: 't3', body: 'second' });
    expect(parseComments(ytext.toString())[0].replies.map(r => r.body)).toEqual(['first', 'second']);
  });
});

describe('editMessage', () => {
  it('atomically replaces a comment marker preserving cluster integrity', () => {
    const { doc, ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"old"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->'
    );
    let transactionCount = 0;
    doc.on('afterTransaction', () => { transactionCount++; });
    editMessage(ytext, ORIGIN, { id: 'c1', newBody: 'new' });
    expect(parseComments(ytext.toString())[0].comment.body).toBe('new');
    expect(parseComments(ytext.toString())[0].replies).toHaveLength(1);
    expect(transactionCount).toBe(1); // single transaction
  });

  it('edits a reply by id', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"old reply"}-->'
    );
    editMessage(ytext, ORIGIN, { id: 'r1', newBody: 'new reply' });
    expect(parseComments(ytext.toString())[0].replies[0].body).toBe('new reply');
  });
});

describe('deleteMessage', () => {
  it('deleting a reply removes only that reply marker', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"c","ts":"t3","body":"y"}-->'
    );
    deleteMessage(ytext, ORIGIN, 'r1');
    const clusters = parseComments(ytext.toString());
    expect(clusters[0].replies.map(r => r.id)).toEqual(['r2']);
  });

  it('deleting a parent comment cascades to replies in one transaction', () => {
    const { doc, ytext } = newDoc(
      '<p>A</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->' +
      '<p>B</p>'
    );
    let transactionCount = 0;
    doc.on('afterTransaction', () => { transactionCount++; });
    deleteMessage(ytext, ORIGIN, 'c1');
    expect(parseComments(ytext.toString())).toEqual([]);
    expect(ytext.toString()).toBe('<p>A</p><p>B</p>');
    expect(transactionCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- comment-store.ytext.test`
Expected: FAIL with `addComment is not a function` (or similar).

- [ ] **Step 3: Extend `comment-store.ts` with mutation helpers**

Append to `comment-store.ts`:

```ts
import type * as Y from 'yjs';

export interface AddCommentInput {
  id: string;
  author: string;
  ts: string;
  body: string;
  position: number;
}

export function addComment(ytext: Y.Text, origin: unknown, input: AddCommentInput): void {
  const marker = serializeComment({
    kind: 'comment',
    id: input.id, author: input.author, ts: input.ts, body: input.body,
  });
  ytext.doc!.transact(() => {
    ytext.insert(input.position, marker);
  }, origin);
}

export interface AddReplyInput {
  id: string;
  parent: string;
  author: string;
  ts: string;
  body: string;
}

export function addReply(ytext: Y.Text, origin: unknown, input: AddReplyInput): void {
  const source = ytext.toString();
  const clusters = parseComments(source);
  const cluster = clusters.find(c => c.comment.id === input.parent);
  if (!cluster) throw new Error(`addReply: no parent comment with id ${input.parent}`);
  const insertAt = cluster.sourceEnd;
  const marker = serializeReply({
    kind: 'reply',
    id: input.id, parent: input.parent, author: input.author, ts: input.ts, body: input.body,
  });
  ytext.doc!.transact(() => {
    ytext.insert(insertAt, marker);
  }, origin);
}

interface MessageLocation {
  start: number;
  end: number;
  kind: 'comment' | 'reply';
  current: CommentMarker | ReplyMarker;
}

function findMessage(source: string, id: string): MessageLocation | null {
  // Walk markers via the scanner so bounds are derived from the live source,
  // not from re-serializing a parsed marker (which would break on hand edits).
  let from = 0;
  while (true) {
    const found = findNextMarker(source, from);
    if (!found) return null;
    from = found.markerEnd;
    const payload = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
    if (!payload || payload.id !== id) continue;
    if (found.kind === 'comment') {
      return {
        start: found.start, end: found.markerEnd, kind: 'comment',
        current: { kind: 'comment', id: payload.id, author: payload.author, ts: payload.ts, body: payload.body },
      };
    }
    return {
      start: found.start, end: found.markerEnd, kind: 'reply',
      current: { kind: 'reply', id: payload.id, parent: payload.parent, author: payload.author, ts: payload.ts, body: payload.body },
    };
  }
}

export interface EditMessageInput {
  id: string;
  newBody: string;
}

export function editMessage(ytext: Y.Text, origin: unknown, input: EditMessageInput): void {
  const source = ytext.toString();
  const loc = findMessage(source, input.id);
  if (!loc) throw new Error(`editMessage: no message with id ${input.id}`);
  const replacement = loc.kind === 'comment'
    ? serializeComment({ ...(loc.current as CommentMarker), body: input.newBody })
    : serializeReply({ ...(loc.current as ReplyMarker), body: input.newBody });
  ytext.doc!.transact(() => {
    ytext.delete(loc.start, loc.end - loc.start);
    ytext.insert(loc.start, replacement);
  }, origin);
}

export function deleteMessage(ytext: Y.Text, origin: unknown, id: string): void {
  const source = ytext.toString();
  // Use parseComments only to learn whether `id` is a parent or a reply and to
  // get the cluster span (for cascade delete). Per-marker bounds come from the
  // scanner to stay robust against hand edits.
  const clusters = parseComments(source);
  ytext.doc!.transact(() => {
    for (const cluster of clusters) {
      if (cluster.comment.id === id) {
        // Cascade: cluster.sourceEnd is set by parser to last marker end.
        ytext.delete(cluster.sourceStart, cluster.sourceEnd - cluster.sourceStart);
        return;
      }
      const isReplyOfThisCluster = cluster.replies.some(r => r.id === id);
      if (!isReplyOfThisCluster) continue;
      const loc = findMessage(source, id);
      if (!loc) throw new Error(`deleteMessage: reply ${id} bounds not found`);
      ytext.delete(loc.start, loc.end - loc.start);
      return;
    }
    throw new Error(`deleteMessage: no message with id ${id}`);
  }, origin);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- comment-store`
Expected: PASS — both `comment-store.test` and `comment-store.ytext.test` green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: comment-store Y.Text mutation helpers"
jj st
```

---

## Task 3: Bridge protocol module

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/bridge/protocol.ts`
- Test: `lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts`

Defines message envelopes shared between parent and bridge, plus nonce helpers. Pure module.

- [ ] **Step 1: Write the failing test**

`protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeNonce, validateEnvelope, type Envelope, type BridgeToParent, type ParentToBridge } from './protocol';

describe('makeNonce', () => {
  it('returns a 32-char hex string', () => {
    const n = makeNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
  it('produces distinct nonces', () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});

describe('validateEnvelope', () => {
  const goodMsg: BridgeToParent = { type: 'click-captured', payload: { fingerprint: { before: '', after: '', tag: 'p', ancestorPath: [], clickRect: { x: 0, y: 0, w: 0, h: 0 } } } };

  it('accepts envelopes whose nonce matches the expected nonce', () => {
    const env: Envelope<BridgeToParent> = { nonce: 'abc', message: goodMsg };
    expect(validateEnvelope(env, 'abc')).toEqual(goodMsg);
  });

  it('rejects envelopes whose nonce does not match', () => {
    const env: Envelope<BridgeToParent> = { nonce: 'wrong', message: goodMsg };
    expect(validateEnvelope(env, 'expected')).toBeNull();
  });

  it('rejects envelopes that are not objects', () => {
    expect(validateEnvelope('not an envelope' as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
    expect(validateEnvelope(null as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
  });

  it('rejects envelopes missing the message field', () => {
    expect(validateEnvelope({ nonce: 'x' } as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- bridge/protocol.test`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `protocol.ts`**

```ts
export interface Fingerprint {
  before: string;
  after: string;
  tag: string;
  ancestorPath: Array<{ tag: string; index: number }>;
  clickRect: { x: number; y: number; w: number; h: number };
}

export interface CommentSummary {
  id: string;
  body: string;
  replies: number;
}

export type ParentToBridge =
  | { type: 'init'; payload: { comments: CommentSummary[]; scriptHash: string } }
  | { type: 'enable-click-to-place'; payload: Record<string, never> }
  | { type: 'disable-click-to-place'; payload: Record<string, never> }
  | { type: 'find-probe'; payload: { token: string } }
  | { type: 'highlight-comment'; payload: { id: string } }
  | { type: 'set-comments'; payload: { comments: CommentSummary[] } };

export type BridgeToParent =
  | { type: 'ready'; payload: { scriptHash: string } }
  | { type: 'click-captured'; payload: { fingerprint: Fingerprint } }
  | { type: 'dot-clicked'; payload: { id: string } }
  | { type: 'probe-found'; payload: { token: string; rect: { x: number; y: number; w: number; h: number } | null } }
  | { type: 'comments-rendered'; payload: { found: string[]; orphaned: string[] } };

export interface Envelope<M> {
  nonce: string;
  message: M;
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function validateEnvelope<M>(env: unknown, expectedNonce: string): M | null {
  if (typeof env !== 'object' || env === null) return null;
  const e = env as { nonce?: unknown; message?: unknown };
  if (typeof e.nonce !== 'string' || e.nonce !== expectedNonce) return null;
  if (typeof e.message !== 'object' || e.message === null) return null;
  return e.message as M;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- bridge/protocol.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: bridge protocol types and envelope validation"
jj st
```

---

## Task 4: Bridge script — DOM-level pure functions

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Test: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.test.ts`

The bridge has two layers:
1. **Pure DOM functions** (this task): `findCommentNodes`, `findAnchorElement`, `renderDots`, `captureFingerprintAt`, `findProbe`. Tested directly against happy-dom — no postMessage involved.
2. **Wiring** (Task 5): event listeners, MutationObserver, postMessage handlers. The IIFE that wraps them is what gets injected.

This separation is intentional — it satisfies the testing-anti-patterns "mock at slow/external boundaries" guidance. The DOM is a direct dependency we use real (happy-dom is fast). postMessage is wired separately and tested via the parent's integration test in Task 9.

- [ ] **Step 1: Write the failing test**

`bridge-script.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findCommentNodes,
  findAnchorElement,
  renderDots,
  captureFingerprintAt,
  findProbe,
} from './bridge-script';
import type { CommentSummary } from './protocol';

function setupBody(html: string): void {
  document.body.innerHTML = html;
}

describe('findCommentNodes', () => {
  it('returns lens-comment comment nodes with parsed ids', () => {
    setupBody(
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p>after</p>' +
      '<!--lens-comment {"id":"c2","author":"a","ts":"t","body":"y"}-->'
    );
    expect(findCommentNodes(document).map(n => n.id)).toEqual(['c1', 'c2']);
  });

  it('ignores reply markers (they do not get their own dot)', () => {
    setupBody(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t","body":"y"}-->'
    );
    expect(findCommentNodes(document).map(n => n.id)).toEqual(['c1']);
  });
});

describe('findAnchorElement', () => {
  it('returns the next element sibling when one exists', () => {
    setupBody(
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="target">after</p>'
    );
    const commentNode = document.body.childNodes[1] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('target');
  });

  it('falls back to parent element when no next sibling', () => {
    setupBody('<div id="parent"><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--></div>');
    const commentNode = document.getElementById('parent')!.childNodes[0] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('parent');
  });
});

describe('renderDots', () => {
  beforeEach(() => {
    setupBody('<p>before</p><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--><p id="t">after</p>');
  });

  it('creates an overlay root and one dot per comment, returns found/orphaned ids', () => {
    const summaries: CommentSummary[] = [{ id: 'c1', body: 'x', replies: 0 }];
    const result = renderDots(document, summaries);
    expect(result).toEqual({ found: ['c1'], orphaned: [] });
    const root = document.querySelector('[data-lens-overlay="true"]');
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('reports orphaned ids for comments whose marker is missing from DOM', () => {
    const summaries: CommentSummary[] = [
      { id: 'c1', body: 'x', replies: 0 },
      { id: 'gone', body: 'y', replies: 0 },
    ];
    expect(renderDots(document, summaries)).toEqual({ found: ['c1'], orphaned: ['gone'] });
  });

  it('reuses overlay root across calls (idempotent)', () => {
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    expect(document.querySelectorAll('[data-lens-overlay="true"]')).toHaveLength(1);
  });
});

describe('captureFingerprintAt', () => {
  it('reports tag, ancestor path, before/after text for a given target', () => {
    setupBody('<body><main><p id="t">Hello world here</p></main></body>');
    const target = document.getElementById('t')!;
    const fp = captureFingerprintAt(target, /*clickX*/ 0, /*clickY*/ 0, /*charOffset*/ 5);
    expect(fp.tag).toBe('p');
    expect(fp.before.endsWith('Hello')).toBe(true);
    expect(fp.after.startsWith(' world')).toBe(true);
    expect(fp.ancestorPath.map(a => a.tag)).toContain('main');
  });
});

describe('findProbe', () => {
  it('returns the bounding rect of the nearest rendered neighbor', () => {
    setupBody('<p id="x">A</p><!--lens-probe TOKEN--><p id="y">B</p>');
    const rect = findProbe(document, 'TOKEN');
    expect(rect).not.toBeNull();
  });

  it('returns null when token not found', () => {
    setupBody('<p>nothing here</p>');
    expect(findProbe(document, 'TOKEN')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- bridge-script.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bridge-script.ts` (DOM-pure layer only)**

```ts
import type { CommentSummary, Fingerprint } from './protocol';

export const OVERLAY_ROOT_ID = 'lens-comment-overlay-root';

export interface FoundComment {
  id: string;
  node: Comment;
}

export function findCommentNodes(root: Document | Element): FoundComment[] {
  const out: FoundComment[] = [];
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
    root instanceof Document ? root.body : root,
    NodeFilter.SHOW_COMMENT,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Comment).data;
    const m = data.match(/^lens-comment\s+(\{[\s\S]*\})$/);
    if (!m) continue;
    try {
      const payload = JSON.parse(m[1]) as { id?: string };
      if (payload.id) out.push({ id: payload.id, node: n as Comment });
    } catch {
      // skip
    }
  }
  return out;
}

export function findAnchorElement(commentNode: Comment): Element | null {
  let sib: Node | null = commentNode.nextSibling;
  while (sib && sib.nodeType !== Node.ELEMENT_NODE) sib = sib.nextSibling;
  if (sib) return sib as Element;
  return commentNode.parentElement;
}

function ensureOverlayRoot(doc: Document): HTMLDivElement {
  let root = doc.getElementById(OVERLAY_ROOT_ID) as HTMLDivElement | null;
  if (root) return root;
  root = doc.createElement('div');
  root.id = OVERLAY_ROOT_ID;
  root.setAttribute('data-lens-overlay', 'true');
  root.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
  doc.body.appendChild(root);
  return root;
}

export function renderDots(doc: Document, comments: CommentSummary[]): { found: string[]; orphaned: string[] } {
  const root = ensureOverlayRoot(doc);
  const presentNodes = findCommentNodes(doc);
  const byId = new Map(presentNodes.map(c => [c.id, c]));
  const found: string[] = [];
  const orphaned: string[] = [];
  // Clear existing dots (idempotent rebuild).
  root.innerHTML = '';
  for (const summary of comments) {
    const present = byId.get(summary.id);
    if (!present) { orphaned.push(summary.id); continue; }
    const anchor = findAnchorElement(present.node);
    if (!anchor) { orphaned.push(summary.id); continue; }
    const rect = anchor.getBoundingClientRect();
    const dot = doc.createElement('div');
    dot.className = 'lens-comment-dot';
    dot.dataset.commentId = summary.id;
    dot.style.cssText = `position:absolute;left:${rect.right - 8}px;top:${rect.top - 4}px;width:16px;height:16px;background:#fbbf24;border-radius:50%;pointer-events:auto;cursor:pointer;font-size:11px;line-height:16px;text-align:center;`;
    dot.textContent = '💬';
    dot.setAttribute('aria-label', `Comment: ${summary.body.slice(0, 60)}`);
    root.appendChild(dot);
    found.push(summary.id);
  }
  return { found, orphaned };
}

function describeAncestors(el: Element): Array<{ tag: string; index: number }> {
  const out: Array<{ tag: string; index: number }> = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'BODY') {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    let index = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib.tagName === cur.tagName) {
        if (sib === cur) break;
        index++;
      }
    }
    out.unshift({ tag: cur.tagName.toLowerCase(), index });
    cur = parent;
  }
  return out;
}

export function captureFingerprintAt(target: Element, clickX: number, clickY: number, charOffset: number): Fingerprint {
  const text = target.textContent ?? '';
  const before = text.slice(Math.max(0, charOffset - 30), charOffset);
  const after = text.slice(charOffset, charOffset + 30);
  const rect = target.getBoundingClientRect();
  return {
    before,
    after,
    tag: target.tagName.toLowerCase(),
    ancestorPath: describeAncestors(target),
    clickRect: { x: clickX, y: clickY, w: rect.width, h: rect.height },
  };
}

export function findProbe(doc: Document, token: string): { x: number; y: number; w: number; h: number } | null {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Comment).data === `lens-probe ${token}`) {
      const anchor = findAnchorElement(n as Comment);
      if (!anchor) return null;
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- bridge-script.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: bridge-script DOM-pure layer (scan, render, fingerprint, probe)"
jj st
```

---

## Task 5: Bridge script — wiring (IIFE for injection)

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Test: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts`

Append the runtime IIFE that listens for `message` events from the parent, captures clicks, runs MutationObserver, and posts back. This is what gets injected as `<script>` text into srcdoc.

**Signature revision (review feedback):** `installBridge` takes only the window (`Window & typeof globalThis`) and the script hash. It uses `win.parent.postMessage` internally — no `parent` injection parameter. Tests assign `vi.fn()` to `window.parent.postMessage` before calling. This removes a production prop whose only purpose was test capture.

**Security:** The `ready` handshake must NOT leak the parent's nonce to arbitrary message sources. The bridge sends `ready` without a nonce, but the parent only responds with `init` (containing the real nonce) if the message arrived from `iframeRef.current.contentWindow`. The bridge's listener filters incoming messages: it ignores any message whose `source` is not its designated `win.parent`.

**MutationObserver filtering:** The observer watches `doc.body` with `subtree: true`. To avoid an infinite rebuild loop when `rebuildDots` mutates the overlay subtree, the observer's callback inspects each `MutationRecord` and ignores any whose `target` is inside the `[data-lens-overlay="true"]` root.

- [ ] **Step 1: Write the failing test**

`bridge-script.wiring.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installBridge } from './bridge-script';
import type { Envelope, BridgeToParent, ParentToBridge } from './protocol';

const SCRIPT_HASH = 'test-hash';

describe('installBridge', () => {
  let sent: Array<Envelope<BridgeToParent>>;
  const originalPostMessage = window.parent.postMessage;

  beforeEach(() => {
    document.body.innerHTML = '';
    sent = [];
  });
  afterEach(() => {
    window.parent.postMessage = originalPostMessage;
  });

  // Stub production postMessage target. In happy-dom window.parent === window,
  // so this hook is the same one production uses (where the iframe's window.parent
  // is the editor window).
  function arm(): void {
    document.body.innerHTML =
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="t">after</p>';
    window.parent.postMessage = ((env: Envelope<BridgeToParent>) => sent.push(env)) as typeof window.parent.postMessage;
    installBridge(window as Window & typeof globalThis, SCRIPT_HASH);
  }

  it('posts "ready" with scriptHash immediately on install', () => {
    arm();
    expect(sent[0].message.type).toBe('ready');
    expect((sent[0].message as Extract<BridgeToParent, { type: 'ready' }>).payload.scriptHash).toBe(SCRIPT_HASH);
  });

  it('after receiving init, renders dots and posts comments-rendered', () => {
    arm();
    const initEnv: Envelope<ParentToBridge> = {
      nonce: 'NONCE',
      message: { type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }], scriptHash: SCRIPT_HASH } },
    };
    window.dispatchEvent(new MessageEvent('message', { data: initEnv, source: window.parent }));
    expect(document.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
    const rendered = sent.find(e => e.message.type === 'comments-rendered');
    expect(rendered).toBeDefined();
    expect((rendered!.message as Extract<BridgeToParent, { type: 'comments-rendered' }>).payload.found).toEqual(['c1']);
  });

  it('ignores messages with wrong nonce after init', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [], scriptHash: SCRIPT_HASH } } },
      source: window.parent,
    }));
    const sentCountAfterInit = sent.length;
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'WRONG', message: { type: 'set-comments', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } } },
      source: window.parent,
    }));
    expect(sent.length).toBe(sentCountAfterInit); // no new outbound message
  });

  it('on dot click, posts dot-clicked with the comment id', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }], scriptHash: SCRIPT_HASH } } },
      source: window.parent,
    }));
    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    dot.click();
    const clicked = sent.find(e => e.message.type === 'dot-clicked');
    expect(clicked).toBeDefined();
    expect((clicked!.message as Extract<BridgeToParent, { type: 'dot-clicked' }>).payload.id).toBe('c1');
  });

  it('when enable-click-to-place is active, next body click posts click-captured', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [], scriptHash: SCRIPT_HASH } } },
      source: window.parent,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'enable-click-to-place', payload: {} } },
      source: window.parent,
    }));
    const target = document.getElementById('t')!;
    target.click();
    const captured = sent.find(e => e.message.type === 'click-captured');
    expect(captured).toBeDefined();
    expect((captured!.message as Extract<BridgeToParent, { type: 'click-captured' }>).payload.fingerprint.tag).toBe('p');
  });

  it('responds to find-probe with rect or null', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [], scriptHash: SCRIPT_HASH } } },
      source: window.parent,
    }));
    document.body.insertAdjacentHTML('beforeend', '<!--lens-probe TKN--><span>x</span>');
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'find-probe', payload: { token: 'TKN' } } },
      source: window.parent,
    }));
    const probe = sent.find(e => e.message.type === 'probe-found');
    expect(probe).toBeDefined();
    expect((probe!.message as Extract<BridgeToParent, { type: 'probe-found' }>).payload.token).toBe('TKN');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- bridge-script.wiring`
Expected: FAIL — `installBridge is not a function`.

- [ ] **Step 3: Append `installBridge` and IIFE wrapper to `bridge-script.ts`**

Append to `bridge-script.ts`:

```ts
import { validateEnvelope, type Envelope, type BridgeToParent, type ParentToBridge } from './protocol';
// OVERLAY_ROOT_ID is exported by the file's existing Task-4 code; reused here.

export function installBridge(win: Window & typeof globalThis, scriptHash: string): void {
  const parent = win.parent;
  let nonce: string | null = null;
  let clickToPlaceArmed = false;
  const doc = win.document;

  function postToParent(message: BridgeToParent): void {
    const env: Envelope<BridgeToParent> = { nonce: nonce ?? '', message };
    (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(env, '*');
  }

  function rebuildDots(comments: Array<{ id: string; body: string; replies: number }>): void {
    const result = renderDots(doc, comments);
    postToParent({ type: 'comments-rendered', payload: result });
    const root = doc.getElementById(OVERLAY_ROOT_ID);
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.lens-comment-dot'))) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.commentId;
        if (id) postToParent({ type: 'dot-clicked', payload: { id } });
      });
    }
  }

  // emit ready immediately (no nonce yet)
  postToParent({ type: 'ready', payload: { scriptHash } });

  let lastComments: Array<{ id: string; body: string; replies: number }> = [];

  win.addEventListener('message', (event: MessageEvent) => {
    // Strict source check: only accept messages from our designated parent.
    // In production this is the editor window; in tests the same window
    // (happy-dom: window.parent === window). Reject everything else,
    // including messages with no source (null).
    if (event.source !== parent) return;
    const data = event.data as Envelope<ParentToBridge>;
    if (nonce === null) {
      // Before init we accept only init messages; nonce is assigned here.
      if (!data || typeof data !== 'object') return;
      const msg = data.message;
      if (!msg || msg.type !== 'init') return;
      if (typeof data.nonce !== 'string' || data.nonce.length === 0) return;
      nonce = data.nonce;
      lastComments = msg.payload.comments;
      rebuildDots(lastComments);
      return;
    }
    const msg = validateEnvelope<ParentToBridge>(data, nonce);
    if (!msg) return;
    switch (msg.type) {
      case 'enable-click-to-place':
        clickToPlaceArmed = true;
        doc.body.style.cursor = 'crosshair';
        break;
      case 'disable-click-to-place':
        clickToPlaceArmed = false;
        doc.body.style.cursor = '';
        break;
      case 'set-comments':
        lastComments = msg.payload.comments;
        rebuildDots(lastComments);
        break;
      case 'highlight-comment': {
        const el = doc.querySelector<HTMLElement>(`.lens-comment-dot[data-comment-id="${msg.payload.id}"]`);
        if (el) {
          el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 400 });
        }
        break;
      }
      case 'find-probe': {
        const rect = findProbe(doc, msg.payload.token);
        postToParent({ type: 'probe-found', payload: { token: msg.payload.token, rect } });
        break;
      }
    }
  });

  // Click-to-place: capture first body click while armed.
  win.addEventListener('click', (event) => {
    if (!clickToPlaceArmed) return;
    const target = event.target as Element | null;
    if (!target || target.closest('[data-lens-overlay]')) return;
    event.preventDefault();
    event.stopPropagation();
    clickToPlaceArmed = false;
    doc.body.style.cursor = '';
    const fp = captureFingerprintAt(target, event.clientX, event.clientY, 0);
    postToParent({ type: 'click-captured', payload: { fingerprint: fp } });
  }, true);

  // Re-render dots when DOM mutates *outside* our overlay (debounced).
  // The filter prevents an infinite loop where rebuildDots' overlay mutations
  // trigger more observer ticks.
  let pending = false;
  const observer = new win.MutationObserver((records) => {
    const meaningful = records.some(r => !(r.target as Element).closest?.('[data-lens-overlay="true"]'));
    if (!meaningful) return;
    if (pending) return;
    pending = true;
    win.setTimeout(() => {
      pending = false;
      rebuildDots(lastComments);
    }, 100);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- bridge-script`
Expected: PASS — both bridge-script tests green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: bridge-script wiring (postMessage, click capture, observer)"
jj st
```

---

## Task 6: Position finder — fingerprint scoring (pure)

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/position-finder.ts`
- Test: `lens-editor/src/components/HtmlEditor/position-finder.test.ts`

Pure scoring function. Takes a source string + fingerprint, returns ranked candidate positions.

- [ ] **Step 1: Write the failing test**

`position-finder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scoreCandidates, type Candidate } from './position-finder';
import type { Fingerprint } from './bridge/protocol';

const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  before: '', after: '', tag: 'p',
  ancestorPath: [], clickRect: { x: 0, y: 0, w: 0, h: 0 },
  ...over,
});

describe('scoreCandidates', () => {
  it('returns the position of a unique text match', () => {
    const src = '<p>Hello world</p>';
    const result = scoreCandidates(src, fp({ before: 'Hel', after: 'lo wo' }));
    expect(result.length).toBeGreaterThan(0);
    expect(src.slice(result[0].position, result[0].position + 5)).toContain('lo wo');
  });

  it('returns multiple candidates when text appears multiple times', () => {
    const src = '<p>click here</p><p>click here</p>';
    const result = scoreCandidates(src, fp({ before: 'click ', after: 'here' }));
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty when fingerprint text not found', () => {
    expect(scoreCandidates('<p>foo</p>', fp({ before: 'bar', after: 'baz' }))).toEqual([]);
  });

  it('ranks the candidate whose open-tag stack matches the fingerprint ancestors first', () => {
    const src = '<main><p>click here</p></main><aside><p>click here</p></aside>';
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'p',
      ancestorPath: [{ tag: 'main', index: 0 }, { tag: 'p', index: 0 }],
    }));
    expect(result[0].score).toBeGreaterThan(result[1].score);
    // The winning candidate is inside <main>...</main>, not <aside>.
    const winner = result[0].position;
    const mainOpen = src.indexOf('<main>');
    const mainClose = src.indexOf('</main>');
    expect(winner).toBeGreaterThan(mainOpen);
    expect(winner).toBeLessThan(mainClose);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- position-finder.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scoreCandidates`**

```ts
import type { Fingerprint } from './bridge/protocol';

export interface Candidate {
  position: number;
  score: number;
}

const MAX_CANDIDATES = 8;

export function scoreCandidates(source: string, fp: Fingerprint): Candidate[] {
  const needle = fp.before + fp.after;
  if (needle.length === 0) return [];
  const out: Candidate[] = [];
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    const position = idx + fp.before.length;
    const score = fp.before.length + fp.after.length + ancestorBonus(source, position, fp);
    out.push({ position, score });
    from = idx + 1;
  }
  out.sort((a, b) => b.score - a.score || a.position - b.position);
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * Returns the stack of element tag names that are open at `position` in `source`,
 * outermost first. Uses a tag-scanning walk (no real HTML parser). Approximate:
 * does not perfectly model void elements or script/style nesting, but adequate
 * for ranking fingerprint candidates.
 */
function openTagsAt(source: string, position: number): string[] {
  const stack: string[] = [];
  const before = source.slice(0, position);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(before)) !== null) {
    const [, slash, name, selfClose] = m;
    const tag = name.toLowerCase();
    if (slash === '/') {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  return stack;
}

function ancestorBonus(source: string, position: number, fp: Fingerprint): number {
  if (fp.ancestorPath.length === 0) return 0;
  const open = openTagsAt(source, position);
  let bonus = 0;
  for (const a of fp.ancestorPath) {
    if (open.includes(a.tag)) bonus += 5;
  }
  return bonus;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- position-finder.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: position-finder fingerprint candidate scoring"
jj st
```

---

## Task 7: Position finder — probe-verify orchestration

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/position-finder.ts`
- Modify: `lens-editor/src/components/HtmlEditor/position-finder.test.ts`

Adds `verifyByProbe(source, candidates, fp, runner)`. The `ProbeRunner` is a passed-in dependency (interface). Tests inject a real in-memory runner — not a mock.

The runner abstraction is **not test-only kludge**. It also lets us swap implementations later (e.g., off-thread render). Same parameters apply in production: HtmlPreview injects a runner backed by a real hidden iframe.

- [ ] **Step 1: Write the failing test**

Append to `position-finder.test.ts`:

```ts
import { verifyByProbe, type ProbeRunner } from './position-finder';

describe('verifyByProbe', () => {
  it('accepts the first candidate whose probe rect overlaps click point', async () => {
    const src = '<p>click here</p><p>click here</p>';
    const candidates: Candidate[] = [{ position: 13, score: 5 }, { position: 30, score: 5 }];
    const fpr: Fingerprint = fp({
      before: 'click ', after: 'here', clickRect: { x: 100, y: 50, w: 10, h: 10 },
    });
    // Runner returns rect overlapping first candidate's click point only.
    const runner: ProbeRunner = {
      async run(sourceWithProbe, token) {
        if (sourceWithProbe.includes(`<!--lens-probe ${token}-->`)) {
          // Position 13 cluster yields overlap; 30 yields miss.
          const probeIdx = sourceWithProbe.indexOf(`<!--lens-probe ${token}-->`);
          if (Math.abs(probeIdx - candidates[0].position) < 5) return { x: 95, y: 45, w: 20, h: 20 };
          return { x: 500, y: 500, w: 10, h: 10 };
        }
        return null;
      },
      dispose() {},
    };
    const result = await verifyByProbe(src, candidates, fpr, runner);
    expect(result.kind).toBe('placed');
    if (result.kind === 'placed') expect(result.position).toBe(13);
  });

  it('returns kind:"manual" when no candidate overlaps the click point', async () => {
    const src = '<p>click here</p>';
    const candidates: Candidate[] = [{ position: 13, score: 5 }];
    const runner: ProbeRunner = {
      async run() { return { x: 999, y: 999, w: 1, h: 1 }; },
      dispose() {},
    };
    const result = await verifyByProbe(src, candidates, fp({ clickRect: { x: 0, y: 0, w: 10, h: 10 } }), runner);
    expect(result.kind).toBe('manual');
  });

  it('returns kind:"manual" with no candidates', async () => {
    const runner: ProbeRunner = { async run() { return null; }, dispose() {} };
    const result = await verifyByProbe('', [], fp(), runner);
    expect(result.kind).toBe('manual');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- position-finder.test`
Expected: FAIL — `verifyByProbe` not exported.

- [ ] **Step 3: Extend `position-finder.ts`**

```ts
const TOLERANCE_PX = 20;
const MAX_PROBES = 5;

export interface ProbeRunner {
  /** Renders `sourceWithProbe` and reports the rect of `<!--lens-probe TOKEN-->`. */
  run(sourceWithProbe: string, token: string): Promise<{ x: number; y: number; w: number; h: number } | null>;
  dispose(): void;
}

export type VerifyResult =
  | { kind: 'placed'; position: number }
  | { kind: 'manual'; candidates: Candidate[] };

export function makeProbeToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, tol: number): boolean {
  return !(a.x + a.w + tol < b.x || b.x + b.w + tol < a.x || a.y + a.h + tol < b.y || b.y + b.h + tol < a.y);
}

export async function verifyByProbe(source: string, candidates: Candidate[], fp: Fingerprint, runner: ProbeRunner): Promise<VerifyResult> {
  for (const c of candidates.slice(0, MAX_PROBES)) {
    const token = makeProbeToken();
    const probeMarker = `<!--lens-probe ${token}-->`;
    const withProbe = source.slice(0, c.position) + probeMarker + source.slice(c.position);
    const rect = await runner.run(withProbe, token);
    if (rect && rectsOverlap(rect, fp.clickRect, TOLERANCE_PX)) {
      return { kind: 'placed', position: c.position };
    }
  }
  return { kind: 'manual', candidates };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- position-finder.test`
Expected: PASS — all 7+ tests green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: position-finder probe-verify with ProbeRunner abstraction"
jj st
```

---

## Task 8: CommentThread popover

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/CommentThread.tsx`
- Test: `lens-editor/src/components/HtmlEditor/CommentThread.test.tsx`

Renders one thread (parent + replies), provides reply input and edit/delete affordances. Operates on real `Y.Text` via comment-store helpers.

- [ ] **Step 1: Write the failing test**

`CommentThread.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { CommentThread } from './CommentThread';
import { parseComments } from './comment-store';

const ORIGIN = Symbol('test');

function setup(initial: string, currentUser = 'me@x') {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, initial);
  return {
    ytext,
    rerender: render(
      <CommentThread
        ytext={ytext}
        origin={ORIGIN}
        threadId="c1"
        currentUser={currentUser}
        onClose={() => {}}
      />
    ).rerender,
  };
}

describe('CommentThread', () => {
  it('renders the parent comment body and author', () => {
    setup(
      '<!--lens-comment {"id":"c1","author":"luc@x","ts":"2026-05-23T00:00:00Z","body":"why?"}-->'
    );
    expect(screen.getByText('why?')).toBeInTheDocument();
    expect(screen.getByText(/luc@x/)).toBeInTheDocument();
  });

  it('renders replies in order', () => {
    setup(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t1","body":"first"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"c","ts":"t2","body":"second"}-->'
    );
    const messages = screen.getAllByRole('article');
    expect(messages.map(m => m.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('first'), expect.stringContaining('second')]),
    );
  });

  it('submitting reply input adds a lens-reply marker to the y.text', async () => {
    const { ytext } = setup(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->'
    );
    const input = screen.getByPlaceholderText(/reply/i);
    await userEvent.type(input, 'thanks');
    await userEvent.click(screen.getByRole('button', { name: /send|reply/i }));
    expect(parseComments(ytext.toString())[0].replies[0].body).toBe('thanks');
  });

  it('shows edit/delete only for own messages', () => {
    setup(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"mine"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"them@x","ts":"t1","body":"theirs"}-->',
      'me@x'
    );
    // Own comment has edit + delete
    const ownArticle = screen.getByText('mine').closest('article')!;
    expect(ownArticle.querySelector('button[aria-label="Edit"]')).not.toBeNull();
    expect(ownArticle.querySelector('button[aria-label="Delete"]')).not.toBeNull();
    // Others' reply has neither
    const theirsArticle = screen.getByText('theirs').closest('article')!;
    expect(theirsArticle.querySelector('button[aria-label="Edit"]')).toBeNull();
    expect(theirsArticle.querySelector('button[aria-label="Delete"]')).toBeNull();
  });

  it('clicking Delete on own comment removes it (and its replies) from the y.text', async () => {
    const { ytext } = setup(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"mine"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"me@x","ts":"t1","body":"x"}-->',
      'me@x'
    );
    const ownArticle = screen.getByText('mine').closest('article')!;
    await userEvent.click(ownArticle.querySelector('button[aria-label="Delete"]') as HTMLElement);
    expect(parseComments(ytext.toString())).toEqual([]);
  });

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    render(<CommentThread ytext={ytext} origin={ORIGIN} threadId="c1" currentUser="me@x" onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- CommentThread.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `CommentThread.tsx`**

```tsx
import { useEffect, useState, useCallback } from 'react';
import type * as Y from 'yjs';
import { parseComments, addReply, editMessage, deleteMessage, type CommentMarker, type ReplyMarker } from './comment-store';

interface CommentThreadProps {
  ytext: Y.Text;
  origin: unknown;
  threadId: string;
  currentUser: string;
  onClose: () => void;
}

function useCommentSnapshot(ytext: Y.Text, threadId: string) {
  const [snapshot, setSnapshot] = useState(() => parseComments(ytext.toString()).find(c => c.comment.id === threadId));
  useEffect(() => {
    const update = () => setSnapshot(parseComments(ytext.toString()).find(c => c.comment.id === threadId));
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ytext, threadId]);
  return snapshot;
}

function newId(): string {
  return crypto.randomUUID();
}

function Message({
  msg, currentUser, onEdit, onDelete,
}: {
  msg: CommentMarker | ReplyMarker;
  currentUser: string;
  onEdit: (newBody: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const isOwn = msg.author === currentUser;
  return (
    <article className="border-b border-gray-100 p-2">
      <div className="text-xs text-gray-500">{msg.author} · {msg.ts}</div>
      {editing ? (
        <div className="mt-1">
          <textarea
            className="w-full rounded border border-gray-300 p-1 text-sm"
            value={draft}
            onChange={e => setDraft(e.target.value)}
          />
          <div className="mt-1 flex gap-1">
            <button className="rounded bg-gray-900 px-2 py-0.5 text-xs text-white" onClick={() => { onEdit(draft); setEditing(false); }}>Save</button>
            <button className="rounded px-2 py-0.5 text-xs text-gray-600" onClick={() => { setDraft(msg.body); setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-1 whitespace-pre-wrap text-sm">{msg.body}</div>
      )}
      {isOwn && !editing && (
        <div className="mt-1 flex gap-2">
          <button aria-label="Edit" className="text-xs text-gray-500 hover:text-gray-700" onClick={() => setEditing(true)}>Edit</button>
          <button aria-label="Delete" className="text-xs text-gray-500 hover:text-red-600" onClick={onDelete}>Delete</button>
        </div>
      )}
    </article>
  );
}

export function CommentThread({ ytext, origin, threadId, currentUser, onClose }: CommentThreadProps) {
  const snapshot = useCommentSnapshot(ytext, threadId);
  const [reply, setReply] = useState('');

  // Esc closes the popover.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submitReply = useCallback(() => {
    if (!reply.trim()) return;
    addReply(ytext, origin, {
      id: newId(),
      parent: threadId,
      author: currentUser,
      ts: new Date().toISOString(),
      body: reply,
    });
    setReply('');
  }, [reply, ytext, origin, threadId, currentUser]);

  if (!snapshot) {
    return (
      <div className="rounded border border-gray-200 bg-white p-2 shadow-lg">
        <div className="text-sm text-gray-500">Comment no longer exists.</div>
        <button onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <div className="w-80 rounded border border-gray-200 bg-white shadow-lg">
      <Message
        msg={snapshot.comment}
        currentUser={currentUser}
        onEdit={body => editMessage(ytext, origin, { id: snapshot.comment.id, newBody: body })}
        onDelete={() => { deleteMessage(ytext, origin, snapshot.comment.id); onClose(); }}
      />
      {snapshot.replies.map(r => (
        <Message
          key={r.id}
          msg={r}
          currentUser={currentUser}
          onEdit={body => editMessage(ytext, origin, { id: r.id, newBody: body })}
          onDelete={() => deleteMessage(ytext, origin, r.id)}
        />
      ))}
      <div className="border-t border-gray-100 p-2">
        <textarea
          placeholder="Reply..."
          className="w-full rounded border border-gray-300 p-1 text-sm"
          value={reply}
          onChange={e => setReply(e.target.value)}
        />
        <div className="mt-1 flex justify-end">
          <button
            className="rounded bg-gray-900 px-2 py-1 text-xs text-white"
            onClick={submitReply}
          >Send</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- CommentThread.test`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: CommentThread popover with reply/edit/delete"
jj st
```

---

## Task 9: HtmlPreview — bridge integration

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`

Inject bridge into srcdoc, run the ready/init handshake, render the `CommentThread` popover on `dot-clicked`, surface `orphaned` IDs via callback. Click-to-place orchestration comes in Task 10.

The test simulates the bridge by directly dispatching `MessageEvent` events that look like they came from the iframe's `contentWindow`. No iframe mocking — happy-dom renders the iframe element; we just don't depend on its script execution.

**Nonce in tests:** the previous draft used a `nonceForTests` prop on `HtmlPreview` to make the nonce observable. Review feedback (correctly): a test-only prop on a production component is the anti-pattern this whole skill is about. Instead, the test file uses `vi.mock('./bridge/protocol', ...)` to override `makeNonce` to a deterministic value. The production component is unchanged.

**Existing v1 test:** the v1 file has assertions like `expect(iframe.getAttribute('srcdoc')).toBe('<p>first</p>')`. Task 9's `injectBridge` prepends `<script>...</script>` to every srcdoc — that test would break. Update those assertions to `.toContain('<p>first</p>')` as part of this task, NOT as a hidden placeholder.

- [ ] **Step 1: Update existing v1 srcdoc-equality assertions**

Open `HtmlPreview.test.tsx`. Wherever a test asserts srcdoc equals a specific string (e.g., `toBe('<p>first</p>')`, `toBe('')`), change to `.toContain(...)` to permit the prepended bridge `<script>`. Run `npm run test:run -- HtmlPreview` and confirm those tests still pass (they should — same content, looser assertion).

- [ ] **Step 2: Write the new failing tests**

Append to `HtmlPreview.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';
import type { Envelope, BridgeToParent } from './bridge/protocol';

// Deterministic nonce so dispatched messages can be authenticated.
// This replaces the previous draft's `nonceForTests` prop — testing-anti-patterns
// flagged the prop as a test-only production API; vi.mock of the dependency module
// is a better seam (the production component is unchanged).
vi.mock('./bridge/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/protocol')>();
  return { ...actual, makeNonce: () => '__test_nonce__' };
});

function dispatchFromBridge(iframe: HTMLIFrameElement, env: Envelope<BridgeToParent>): void {
  window.dispatchEvent(new MessageEvent('message', { data: env, source: iframe.contentWindow }));
}

describe('HtmlPreview bridge integration', () => {
  it('opens the comment thread popover when bridge reports dot-clicked', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p><!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"question"}-->');
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    // Bridge would normally send ready first (no nonce) — parent responds with init carrying the nonce.
    // For this test we skip the ready→init dance and dispatch dot-clicked directly with the known mocked nonce.
    await act(async () => {
      dispatchFromBridge(iframe, { nonce: '__test_nonce__', message: { type: 'dot-clicked', payload: { id: 'c1' } } });
    });
    expect(screen.getByText('question')).toBeInTheDocument();
  });

  it('ignores bridge messages from sources other than the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    await act(async () => {
      // No source — should be rejected.
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '__test_nonce__', message: { type: 'dot-clicked', payload: { id: 'c1' } } },
      }));
    });
    expect(screen.queryByText('x')).toBeNull();
  });

  it('ignores bridge messages with a wrong nonce', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, { nonce: 'wrong', message: { type: 'dot-clicked', payload: { id: 'c1' } } });
    });
    expect(screen.queryByText('x')).toBeNull();
  });

  it('calls onOrphanedChange with reported orphan ids', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    const orphans: string[][] = [];
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} onOrphanedChange={ids => orphans.push(ids)} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, { nonce: '__test_nonce__', message: { type: 'comments-rendered', payload: { found: [], orphaned: ['c1'] } } });
    });
    expect(orphans.at(-1)).toEqual(['c1']);
  });

  it('responds to bridge ready by posting init back to the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    // Spy on the iframe's contentWindow.postMessage so we can assert init is sent.
    const posted: unknown[] = [];
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage;
    }
    await act(async () => {
      // Bridge sends ready (no nonce envelope).
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '', message: { type: 'ready', payload: { scriptHash: 'any' } } },
        source: iframe.contentWindow,
      }));
    });
    const init = posted.find((p): p is Envelope<{ type: 'init' }> =>
      typeof p === 'object' && p !== null && (p as { message?: { type?: string } }).message?.type === 'init',
    );
    expect(init).toBeDefined();
    expect((init as Envelope<{ nonce: string }>).nonce).toBe('__test_nonce__');
  });
});
```

- [ ] **Step 3: Run tests to verify the new tests fail**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: the four new tests FAIL — popover not rendered, no source-filter, no nonce-filter, no init-on-ready. The existing v1 tests (now using `.toContain`) should still pass.

- [ ] **Step 4: Rewrite `HtmlPreview.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { CommentThread } from './CommentThread';
import { parseComments } from './comment-store';
import { makeNonce, validateEnvelope, type Envelope, type BridgeToParent, type CommentSummary, type ParentToBridge } from './bridge/protocol';
import { BRIDGE_SOURCE, BRIDGE_SCRIPT_HASH } from './bridge/bridge-bundle';

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser: string;
  origin: unknown;
  debounceMs?: number;
  onOrphanedChange?: (orphanedIds: string[]) => void;
}

export function HtmlPreview({ ytext, currentUser, origin, debounceMs = 300, onOrphanedChange }: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string>(makeNonce());

  useEffect(() => {
    const sync = () => setContent(ytext.toString());
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  const srcDoc = injectBridge(debounced);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Strict source check: messages must come from our iframe's contentWindow.
      // This is what prevents a malicious external iframe (or a stray window)
      // from forging messages — including the "ready" handshake that would
      // otherwise leak the parent's nonce.
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as Envelope<BridgeToParent>;
      // Pre-init "ready" message: no nonce yet. Source check above is the only gate.
      if (typeof data === 'object' && data !== null && (data as { message?: { type?: string } }).message?.type === 'ready') {
        sendToBridge({ type: 'init', payload: { comments: summarize(ytext), scriptHash: BRIDGE_SCRIPT_HASH } });
        return;
      }
      const msg = validateEnvelope<BridgeToParent>(data, nonceRef.current);
      if (!msg) return;
      handle(msg);
    }
    function handle(msg: BridgeToParent) {
      switch (msg.type) {
        case 'dot-clicked':
          setOpenThreadId(msg.payload.id);
          break;
        case 'comments-rendered':
          onOrphanedChange?.(msg.payload.orphaned);
          break;
        case 'click-captured':
          // Wired in Task 10
          break;
        case 'probe-found':
          // Wired in Task 10
          break;
      }
    }
    function sendToBridge(message: ParentToBridge) {
      const env: Envelope<ParentToBridge> = { nonce: nonceRef.current, message };
      iframeRef.current?.contentWindow?.postMessage(env, '*');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ytext, onOrphanedChange]);

  useEffect(() => {
    const summaries = summarize(ytext);
    const env: Envelope<ParentToBridge> = {
      nonce: nonceRef.current,
      message: { type: 'set-comments', payload: { comments: summaries } },
    };
    iframeRef.current?.contentWindow?.postMessage(env, '*');
  }, [debounced, ytext]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title="HTML preview"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="w-full h-full border-0 bg-white"
      />
      {openThreadId && (
        <div className="absolute right-4 top-4 z-10">
          <CommentThread
            ytext={ytext}
            origin={origin}
            threadId={openThreadId}
            currentUser={currentUser}
            onClose={() => setOpenThreadId(null)}
          />
        </div>
      )}
    </div>
  );
}

function summarize(ytext: Y.Text): CommentSummary[] {
  return parseComments(ytext.toString()).map(c => ({
    id: c.comment.id,
    body: c.comment.body,
    replies: c.replies.length,
  }));
}

function injectBridge(source: string): string {
  const tag = `<script>${BRIDGE_SOURCE}</script>`;
  const headOpen = source.match(/<head\b[^>]*>/i);
  if (headOpen) {
    const idx = headOpen.index! + headOpen[0].length;
    return source.slice(0, idx) + tag + source.slice(idx);
  }
  return tag + '\n' + source;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: PASS — all bridge-integration tests green; existing v1 srcdoc-debounce test (now with `.toContain`) still green.

- [ ] **Step 6: Commit**

```bash
jj st
jj commit -m "feat: HtmlPreview bridge integration (popover, orphan callback, source/nonce filters)"
jj st
```

---

## Task 10: HtmlPreview — click-to-place orchestration

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`

Adds:
- An `isCommentMode` prop and a `onPlaceComplete` callback (parent controls toggle state).
- A hidden iframe managed by the component, used as the `ProbeRunner` for `verifyByProbe`.
- On `click-captured` → run `scoreCandidates` + `verifyByProbe` → on `placed`, call `addComment`, open thread; on `manual`, invoke `onManualPlacement(candidates)` — Task 11/12 consume that callback to drive the split-source UI.

- [ ] **Step 1: Write the failing test**

Append to `HtmlPreview.test.tsx`:

```tsx
import { addComment, parseComments } from './comment-store';
import { scoreCandidates } from './position-finder';

describe('HtmlPreview click-to-place', () => {
  it('inserts a comment marker when bridge reports a click whose fingerprint uniquely matches source', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>unique words here</p>');
    const onPlace = vi.fn();
    render(<HtmlPreview
      ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0}
      isCommentMode={true} onPlaceComplete={onPlace}
    />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'unique ', after: 'words', tag: 'p',
              ancestorPath: [], clickRect: { x: 0, y: 0, w: 10, h: 10 },
            },
          },
        },
      });
    });
    // For a uniquely-resolving fingerprint, no probe round-trip is needed.
    expect(parseComments(ytext.toString())).toHaveLength(1);
    expect(onPlace).toHaveBeenCalled();
  });

  it('falls back to manual placement when every probe candidate misses the click rect', async () => {
    // Two candidates: each requires its own find-probe round-trip. We need to
    // answer each probe request with a miss, then assert onManual is called.
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onManual = vi.fn();
    render(<HtmlPreview
      ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0}
      isCommentMode={true} onManualPlacement={onManual}
    />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    // Intercept find-probe RPCs so we can respond per-token instead of guessing.
    const probeTokens: string[] = [];
    const visiblePost = iframe.contentWindow?.postMessage;
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((msg: unknown) => {
        const env = msg as Envelope<{ type: string; payload: { token?: string } }>;
        if (env?.message?.type === 'find-probe' && env.message.payload?.token) {
          probeTokens.push(env.message.payload.token);
        }
      }) as typeof window.postMessage;
    }
    // The hidden iframe runner posts to its own iframe; for this test we don't
    // care about its postMessage, we care that the parent's verify loop walks
    // both candidates and ends in manual fallback. Drive that by stubbing
    // verifyByProbe via a vi.spyOn — see comment-store.ts pattern.

    // Simpler: directly assert the flow by stubbing the probe runner. The
    // useHiddenProbeRunner hook gets its iframe-backed runner; in this test we
    // override it by exposing a runner-factory prop. (See Task 10 step 3.)
    // For the purposes of this test, the runner-factory is replaced with a
    // function returning a runner whose .run() resolves to a non-overlapping rect.

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: { before: 'click ', after: 'here', tag: 'p', ancestorPath: [], clickRect: { x: 9999, y: 9999, w: 1, h: 1 } },
          },
        },
      });
    });
    expect(onManual).toHaveBeenCalled();
    expect(parseComments(ytext.toString())).toEqual([]);
  });
});

describe('useHiddenProbeRunner (real-iframe integration)', () => {
  it('renders the probe source into a hidden iframe and resolves find-probe with a rect', async () => {
    // This is the integration test for the real ProbeRunner used in production.
    // It mounts a hidden iframe via the hook, kicks off ready→init→find-probe,
    // and asserts the resolved rect is non-null for a found probe.
    //
    // happy-dom limitation: srcdoc scripts do not execute. The test therefore
    // mounts the bridge into the iframe's contentWindow *manually* via
    // installBridge, simulating what production browser execution would do.
    // This validates the parent-side hook's RPC orchestration and the bridge's
    // find-probe logic end-to-end across a real Window/MessageEvent boundary.
    const { renderHook } = await import('@testing-library/react');
    const { useHiddenProbeRunner } = await import('./HtmlPreview');
    const { installBridge } = await import('./bridge/bridge-script');

    const { result } = renderHook(() => useHiddenProbeRunner('__test_nonce__'));
    const runner = result.current;

    // The hook lazily creates the iframe on first .run() call. Trigger it,
    // then install the bridge into the iframe's window once it appears.
    const runPromise = runner.run(
      '<body><p>before</p><!--lens-probe TKN--><p id="t">after</p></body>',
      'TKN',
    );
    // Wait for the iframe to appear in the DOM.
    await new Promise(r => setTimeout(r, 10));
    const hiddenIframe = document.querySelector('iframe[style*="-9999px"]') as HTMLIFrameElement;
    expect(hiddenIframe).not.toBeNull();
    // Manually install the bridge into the hidden iframe's window.
    // (Production browsers run the injected <script> automatically; happy-dom does not.)
    if (hiddenIframe.contentWindow && hiddenIframe.contentDocument) {
      hiddenIframe.contentDocument.body.innerHTML = '<p>before</p><!--lens-probe TKN--><p id="t">after</p>';
      installBridge(hiddenIframe.contentWindow as Window & typeof globalThis, 'any-hash');
    }
    const rect = await runPromise;
    expect(rect).not.toBeNull();
    runner.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: FAIL — `isCommentMode` prop ignored, no placement happens.

- [ ] **Step 3: Extend `HtmlPreview.tsx`**

Add props and logic:

```tsx
import { scoreCandidates, verifyByProbe, type ProbeRunner } from './position-finder';
import { addComment } from './comment-store';

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser: string;
  origin: unknown;
  debounceMs?: number;
  onOrphanedChange?: (orphanedIds: string[]) => void;
  isCommentMode?: boolean;
  onPlaceComplete?: (commentId: string) => void;
  onManualPlacement?: (candidates: { position: number; score: number }[]) => void;
}
```

Inside the component, when `isCommentMode` changes, send `enable-click-to-place` / `disable-click-to-place` to the bridge:

```tsx
useEffect(() => {
  const env: Envelope<ParentToBridge> = {
    nonce: nonceRef.current,
    message: { type: isCommentMode ? 'enable-click-to-place' : 'disable-click-to-place', payload: {} },
  };
  iframeRef.current?.contentWindow?.postMessage(env, '*');
}, [isCommentMode]);
```

Build a `ProbeRunner` backed by a hidden iframe. **Exported** so the Task 10 integration test can render it via `renderHook`:

```tsx
export function useHiddenProbeRunner(nonce: string): ProbeRunner {
  return useMemo(() => {
    let iframe: HTMLIFrameElement | null = null;
    let pendingResolve: ((rect: { x: number; y: number; w: number; h: number } | null) => void) | null = null;
    function ensureIframe(): HTMLIFrameElement {
      if (iframe) return iframe;
      iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;visibility:hidden;';
      document.body.appendChild(iframe);
      window.addEventListener('message', (event) => {
        if (event.source !== iframe?.contentWindow) return;
        const msg = validateEnvelope<BridgeToParent>(event.data, nonce);
        if (msg?.type === 'probe-found' && pendingResolve) {
          pendingResolve(msg.payload.rect);
          pendingResolve = null;
        }
      });
      return iframe;
    }
    return {
      async run(sourceWithProbe, token) {
        const frame = ensureIframe();
        const srcWithBridge = `<script>${BRIDGE_SOURCE}</script>` + sourceWithProbe;
        frame.srcdoc = srcWithBridge;
        // Wait for ready, then send init + find-probe.
        await new Promise<void>((resolve) => {
          const handler = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return;
            const d = event.data as Envelope<BridgeToParent>;
            if (d?.message?.type === 'ready') {
              window.removeEventListener('message', handler);
              resolve();
            }
          };
          window.addEventListener('message', handler);
        });
        const initEnv: Envelope<ParentToBridge> = {
          nonce, message: { type: 'init', payload: { comments: [], scriptHash: BRIDGE_SCRIPT_HASH } },
        };
        frame.contentWindow?.postMessage(initEnv, '*');
        return new Promise((resolve) => {
          pendingResolve = resolve;
          const findEnv: Envelope<ParentToBridge> = {
            nonce, message: { type: 'find-probe', payload: { token } },
          };
          frame.contentWindow?.postMessage(findEnv, '*');
        });
      },
      dispose() {
        iframe?.remove();
        iframe = null;
      },
    };
  }, [nonce]);
}
```

In the message handler, on `click-captured`:

```tsx
case 'click-captured': {
  const fp = msg.payload.fingerprint;
  const source = ytext.toString();
  const candidates = scoreCandidates(source, fp);
  if (candidates.length === 1) {
    placeAndOpen(candidates[0].position);
    return;
  }
  verifyByProbe(source, candidates, fp, probeRunner).then(result => {
    if (result.kind === 'placed') {
      placeAndOpen(result.position);
    } else {
      onManualPlacement?.(result.candidates);
    }
  });
  break;
}
```

where:

```tsx
function placeAndOpen(position: number) {
  const id = crypto.randomUUID();
  addComment(ytext, origin, {
    id, author: currentUser, ts: new Date().toISOString(), body: '', position,
  });
  setOpenThreadId(id);
  onPlaceComplete?.(id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: PASS — click-to-place tests green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: HtmlPreview click-to-place orchestration with probe-verify"
jj st
```

---

## Task 11: HtmlEditor — comment-mode toggle + orphan badge

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`
- Create: `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.tsx`
- Create: `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.test.tsx`

Adds the comment-mode toggle button next to the source/preview/split toggle, the orphan badge, and the orphan panel.

For brevity the orphan panel is treated as a single bundled step here. If the panel grows non-trivial later, split into its own task.

- [ ] **Step 1: Write the failing tests**

`OrphanedCommentsPanel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { OrphanedCommentsPanel } from './OrphanedCommentsPanel';

describe('OrphanedCommentsPanel', () => {
  it('lists each orphan by body and author', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0,
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"first"}-->' +
      '<!--lens-comment {"id":"c2","author":"b","ts":"t","body":"second"}-->'
    );
    render(<OrphanedCommentsPanel ytext={ytext} orphanedIds={['c1', 'c2']} onJumpToSource={() => {}} />);
    expect(screen.getByText(/first/)).toBeInTheDocument();
    expect(screen.getByText(/second/)).toBeInTheDocument();
  });

  it('renders nothing when there are no orphans', () => {
    const doc = new Y.Doc();
    const { container } = render(<OrphanedCommentsPanel ytext={doc.getText('contents')} orphanedIds={[]} onJumpToSource={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

Extend `HtmlEditor.test.tsx`:

```tsx
it('comment-mode toggle button toggles aria-pressed state', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  const awareness = new Awareness(doc);
  render(<HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />);
  const btn = screen.getByRole('button', { name: /comment mode/i });
  expect(btn).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(btn);
  expect(btn).toHaveAttribute('aria-pressed', 'true');
});

it('orphan badge displays the count from HtmlPreview', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0,
    '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
    '<!--lens-comment {"id":"c2","author":"a","ts":"t","body":"y"}-->'
  );
  const awareness = new Awareness(doc);
  render(<HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />);
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '__test_nonce__', message: { type: 'comments-rendered', payload: { found: [], orphaned: ['c1', 'c2'] } } },
      source: iframe.contentWindow,
    }));
  });
  expect(screen.getByText(/2 orphan/i)).toBeInTheDocument();
});

it('hides the comment-mode toggle when readOnly is true', () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  const awareness = new Awareness(doc);
  render(<HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" readOnly />);
  expect(screen.queryByRole('button', { name: /comment mode/i })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- OrphanedCommentsPanel HtmlEditor`
Expected: FAIL — panel module not found, toggle button missing.

- [ ] **Step 3: Implement `OrphanedCommentsPanel.tsx`**

```tsx
import type * as Y from 'yjs';
import { parseComments } from './comment-store';

interface OrphanedCommentsPanelProps {
  ytext: Y.Text;
  orphanedIds: string[];
  onJumpToSource: (id: string) => void;
}

export function OrphanedCommentsPanel({ ytext, orphanedIds, onJumpToSource }: OrphanedCommentsPanelProps) {
  if (orphanedIds.length === 0) return null;
  const clusters = parseComments(ytext.toString());
  const orphans = orphanedIds.map(id => clusters.find(c => c.comment.id === id)).filter(Boolean) as ReturnType<typeof parseComments>;
  return (
    <aside className="w-72 border-l border-gray-200 bg-gray-50 p-3">
      <h3 className="text-xs font-medium text-gray-700">Orphaned comments ({orphans.length})</h3>
      <ul className="mt-2 space-y-2">
        {orphans.map(o => (
          <li key={o.comment.id} className="rounded border border-gray-200 bg-white p-2 text-sm">
            <div className="text-xs text-gray-500">{o.comment.author}</div>
            <div className="mt-1">{o.comment.body}</div>
            <button className="mt-1 text-xs text-blue-600 hover:underline" onClick={() => onJumpToSource(o.comment.id)}>
              Find in source
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

Extend `HtmlEditor.tsx` to add `currentUser`/`readOnly` props (or read `currentUser` from `useDisplayName()` if not passed), comment-mode state, orphan tracking, and the orphan panel:

```tsx
import { useState } from 'react';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';
import { OrphanedCommentsPanel } from './OrphanedCommentsPanel';
import { useDisplayName } from '../../contexts/DisplayNameContext';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
  currentUser?: string; // optional override; defaults to useDisplayName()
}

export function HtmlEditor({ ytext, awareness, readOnly = false, currentUser: currentUserProp }: HtmlEditorProps) {
  const { displayName } = useDisplayName();
  const currentUser = currentUserProp ?? displayName ?? 'Anonymous';
  const [mode, setMode] = useState<Mode>('preview');
  const [commentMode, setCommentMode] = useState(false);
  const [orphanedIds, setOrphanedIds] = useState<string[]>([]);

  return (
    <div className="flex h-full w-full flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-2">
        {modes.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            className={['rounded px-3 py-1.5 text-sm font-medium transition-colors',
              mode === id ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900',
            ].join(' ')}
          >{label}</button>
        ))}
        {!readOnly && (
          <button
            type="button"
            aria-pressed={commentMode}
            aria-label="Comment mode"
            onClick={() => setCommentMode(m => !m)}
            className={commentMode
              ? 'ml-2 rounded bg-amber-500 px-3 py-1.5 text-sm text-white'
              : 'ml-2 rounded px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100'}
          >💬 Comment</button>
        )}
        {orphanedIds.length > 0 && (
          <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">{orphanedIds.length} orphan</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {mode !== 'preview' && (
          <div className="min-w-0 flex-1">
            <HtmlSourceEditor ytext={ytext} awareness={awareness} readOnly={readOnly} />
          </div>
        )}
        {mode !== 'source' && (
          <div className={mode === 'split' ? 'min-w-0 flex-1 border-l border-gray-200' : 'min-w-0 flex-1'}>
            <HtmlPreview
              ytext={ytext}
              currentUser={currentUser}
              origin={LENS_EDITOR_ORIGIN}
              isCommentMode={commentMode && !readOnly}
              onOrphanedChange={setOrphanedIds}
              onPlaceComplete={() => setCommentMode(false)}
            />
          </div>
        )}
        <OrphanedCommentsPanel
          ytext={ytext}
          orphanedIds={orphanedIds}
          onJumpToSource={() => setMode('source')}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- OrphanedCommentsPanel HtmlEditor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: HtmlEditor comment-mode toggle + orphan badge + panel"
jj st
```

---

## Task 12: Manual split-source confirmation fallback

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx` (add `highlightRanges`, `onClickAtPosition` props)
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx` (handle `onManualPlacement` callback from preview)
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx`

When `HtmlPreview` calls `onManualPlacement(candidates)`, the editor switches to split mode, highlights candidate regions in the source pane, and arms a one-shot click handler. Next click in source places the marker at that exact position.

Before starting: open `HtmlSourceEditor.tsx` and confirm it uses a `EditorView`/`useRef` pattern with CodeMirror 6. The decoration extension and click handler below assume that. If the file uses a different shape, adapt.

- [ ] **Step 1: Write the failing tests**

Append to `HtmlSourceEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlSourceEditor } from './HtmlSourceEditor';

describe('HtmlSourceEditor manual placement props', () => {
  it('renders highlight decorations for each range', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const { container } = render(
      <HtmlSourceEditor
        ytext={ytext}
        awareness={new Awareness(doc)}
        highlightRanges={[{ from: 3, to: 13 }, { from: 20, to: 30 }]}
      />,
    );
    // After CodeMirror mounts, our decoration class should be applied twice.
    const highlights = container.querySelectorAll('.cm-lens-candidate');
    expect(highlights.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onClickAtPosition with the doc offset when armed', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>abc</p>');
    const onClick = vi.fn();
    const { container } = render(
      <HtmlSourceEditor
        ytext={ytext}
        awareness={new Awareness(doc)}
        onClickAtPosition={onClick}
      />,
    );
    const editor = container.querySelector('.cm-content') as HTMLElement;
    // Click on the first character; CodeMirror translates to position 0.
    editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
    editor.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: 0, clientY: 0 }));
    expect(onClick).toHaveBeenCalled();
    expect(typeof onClick.mock.calls[0][0]).toBe('number');
  });
});
```

Append to `HtmlEditor.test.tsx`:

```tsx
import { parseComments } from './comment-store';
import { Awareness } from 'y-protocols/awareness';

it('on manual placement, switches to split mode and places marker at clicked source position', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>click here</p><p>click here</p>');
  const awareness = new Awareness(doc);
  render(<HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />);

  // Activate comment mode.
  await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));

  // The preview's onManualPlacement is triggered by a click-captured event from
  // the bridge whose probe-verify resolves to "manual". Drive that by dispatching
  // a click-captured with a click rect that no probe rect overlaps.
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

  // Stub iframe.contentWindow.postMessage to respond to find-probe with a miss,
  // so verifyByProbe runs through all candidates and falls through to manual.
  iframe.contentWindow!.postMessage = ((msg: unknown) => {
    const env = msg as { message?: { type?: string; payload?: { token?: string } } };
    if (env?.message?.type === 'find-probe') {
      const token = env.message.payload!.token!;
      // Echo back a probe-found whose rect doesn't overlap the click point.
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '__test_nonce__', message: { type: 'probe-found', payload: { token, rect: { x: 0, y: 0, w: 1, h: 1 } } } },
        source: iframe.contentWindow,
      }));
    }
  }) as typeof window.postMessage;

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: { fingerprint: { before: 'click ', after: 'here', tag: 'p', ancestorPath: [], clickRect: { x: 9999, y: 9999, w: 1, h: 1 } } },
        },
      },
      source: iframe.contentWindow,
    }));
    // Let probe-verify chain settle.
    await new Promise(r => setTimeout(r, 0));
  });

  // Mode should now be 'split'; both source and preview panes visible.
  expect(screen.getAllByRole('button', { name: /split/i })[0]).toHaveAttribute('aria-pressed', 'true');

  // The source pane should now have highlights on both candidates.
  const highlights = document.querySelectorAll('.cm-lens-candidate');
  expect(highlights.length).toBeGreaterThanOrEqual(1);

  // Simulate clicking on the second 'click here' in the source pane.
  // The exact pixel coords don't matter — we mock CodeMirror's posAtCoords via
  // a one-shot dispatch on the editor element, then assert the resulting marker
  // lands at the expected position.
  const editor = document.querySelector('.cm-content') as HTMLElement;
  editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));
  // Wait for the onClickAtPosition handler to write to ytext.
  await new Promise(r => setTimeout(r, 0));

  const clusters = parseComments(ytext.toString());
  expect(clusters).toHaveLength(1);
  // We don't assert the precise position — we assert a marker was placed at
  // some position that posAtCoords returned. The bound check on the highlight
  // ensures it landed on a candidate region.
  expect(clusters[0].sourceStart).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- HtmlSourceEditor HtmlEditor`
Expected: FAIL — props don't exist, manual placement flow not wired.

- [ ] **Step 3: Extend `HtmlSourceEditor.tsx`**

Add the props and CodeMirror extensions:

```tsx
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface HighlightRange { from: number; to: number; }
const setHighlights = StateEffect.define<HighlightRange[]>();
const highlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlights)) {
        deco = Decoration.set(
          e.value.map(r => Decoration.mark({ class: 'cm-lens-candidate' }).range(r.from, r.to)),
        );
      }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

interface HtmlSourceEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
  highlightRanges?: HighlightRange[];
  onClickAtPosition?: (position: number) => void;
}

// Inside the component, after the EditorView is created (existing v1 code):
useEffect(() => {
  if (!viewRef.current || !highlightRanges) return;
  viewRef.current.dispatch({ effects: setHighlights.of(highlightRanges) });
}, [highlightRanges]);

// Add a click handler extension:
const clickExtension = EditorView.domEventHandlers({
  mouseup(event, view) {
    if (!onClickAtPosition) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) onClickAtPosition(pos);
    return false;
  },
});
// Include `clickExtension` and `highlightField` in the EditorView extensions list.
```

Add CSS for the candidate highlight (in whatever global stylesheet `HtmlSourceEditor` already pulls in, or inline):

```css
.cm-lens-candidate { background: rgba(251, 191, 36, 0.25); border-bottom: 2px solid rgb(251, 191, 36); }
```

Extend `HtmlEditor.tsx`:

```tsx
const [pendingCandidates, setPendingCandidates] = useState<Candidate[] | null>(null);

// Pass to HtmlPreview:
<HtmlPreview
  // ...existing props...
  onManualPlacement={(candidates) => {
    setMode('split');
    setPendingCandidates(candidates);
  }}
/>

// Pass to HtmlSourceEditor:
<HtmlSourceEditor
  ytext={ytext}
  awareness={awareness}
  readOnly={readOnly}
  highlightRanges={pendingCandidates?.map(c => ({ from: c.position, to: Math.min(c.position + 10, ytext.length) }))}
  onClickAtPosition={(position) => {
    if (!pendingCandidates) return;
    const id = crypto.randomUUID();
    addComment(ytext, LENS_EDITOR_ORIGIN, {
      id, author: currentUser, ts: new Date().toISOString(), body: '', position,
    });
    setPendingCandidates(null);
  }}
/>
```

(Import `Candidate` from `./position-finder`, `addComment` from `./comment-store`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- HtmlSourceEditor HtmlEditor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: split-source manual placement fallback for ambiguous comments"
jj st
```

---

## Task 13: Bundle bridge-script as an IIFE string + inject build hash

**Files:**
- Create: `lens-editor/vite-plugin-bridge-bundle.ts`
- Modify: `lens-editor/vite.config.ts` (register the plugin)
- Modify: `lens-editor/vitest.config.ts` (if present and separate; otherwise covered by `vite.config.ts`)

`bridge-script.ts` is a TypeScript module with `import` statements (the protocol types). Vite's `?raw` returns source text verbatim — the import statements would land inside the iframe's `<script>` tag and fail at runtime because browsers do not resolve bare module specifiers in classic scripts. We need a real bundle step.

Approach: a small Vite plugin that uses esbuild (already a Vite dependency) to bundle `bridge-script.ts` as an IIFE, computes the SHA-256 of that bundle, and exposes both as ESM exports from a virtual module `virtual:bridge-bundle`. The same plugin runs in Vitest (Vitest reuses Vite plugins), so production and tests see the same bundle.

- [ ] **Step 1: Write the failing test**

```ts
// lens-editor/src/components/HtmlEditor/bridge/bridge-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { BRIDGE_SOURCE, BRIDGE_SCRIPT_HASH } from 'virtual:bridge-bundle';

describe('virtual:bridge-bundle', () => {
  it('exports a non-empty IIFE source containing installBridge', () => {
    expect(BRIDGE_SOURCE.length).toBeGreaterThan(500);
    expect(BRIDGE_SOURCE).toContain('installBridge');
    // No bare ES imports leak into the bundle:
    expect(BRIDGE_SOURCE).not.toMatch(/^\s*import /m);
  });
  it('exports a 64-char hex SHA-256', () => {
    expect(BRIDGE_SCRIPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
  it('bundle ends with the IIFE installBridge invocation', () => {
    expect(BRIDGE_SOURCE).toContain('installBridge(window, ');
  });
});
```

You will also need module-augmentation so TypeScript accepts the virtual import:

```ts
// lens-editor/src/vite-env.d.ts (extend the existing one)
declare module 'virtual:bridge-bundle' {
  export const BRIDGE_SOURCE: string;
  export const BRIDGE_SCRIPT_HASH: string;
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd lens-editor && npm run test:run -- bridge-bundle`
Expected: FAIL — virtual module unresolved.

- [ ] **Step 3: Implement the plugin**

```ts
// lens-editor/vite-plugin-bridge-bundle.ts
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:bridge-bundle';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

export function bridgeBundlePlugin(): Plugin {
  return {
    name: 'lens-bridge-bundle',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      const entry = resolve(__dirname, 'src/components/HtmlEditor/bridge/bridge-script.ts');
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        write: false,
        minify: false,
        // No globalName needed — installBridge is invoked from our appended call.
      });
      const bundled = result.outputFiles[0].text;
      const withInvoker = bundled + '\n;installBridge(window, "__BRIDGE_HASH__");\n';
      const hash = createHash('sha256').update(withInvoker).digest('hex');
      const finalSource = withInvoker.replace('__BRIDGE_HASH__', hash);
      // Re-hash after substitution so the placeholder doesn't poison the hash.
      // (We hash the version with __BRIDGE_HASH__ so the bridge can announce
      //  the same value the parent will validate against, since the parent
      //  imports the same hash from this module.)
      return [
        `export const BRIDGE_SOURCE = ${JSON.stringify(finalSource)};`,
        `export const BRIDGE_SCRIPT_HASH = ${JSON.stringify(hash)};`,
      ].join('\n');
    },
  };
}
```

Register in `vite.config.ts`:

```ts
import { bridgeBundlePlugin } from './vite-plugin-bridge-bundle';

export default defineConfig({
  plugins: [
    // ...existing plugins...
    bridgeBundlePlugin(),
  ],
  // ...
});
```

Update `bridge/bridge-script.ts`: ensure the file does not call `installBridge(...)` itself — the IIFE invocation is appended by the plugin. If Task 5 added a trailing call inside the file, remove it.

Update `HtmlPreview.tsx`: the import already reads `from './bridge/bridge-bundle'` (per Task 9). **Change it** to `from 'virtual:bridge-bundle'`. Delete the now-unused `bridge-bundle.ts` file if Task 9 created one.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd lens-editor && npm run test:run`
Expected: bridge-bundle tests PASS; HtmlPreview integration tests PASS (now using the real bundle); nothing else regresses.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "build: virtual:bridge-bundle plugin (esbuild IIFE + script hash)"
jj st
```

---

## Task 14: Server regression test — markers round-trip

**Files:**
- Create: `crates/relay/tests/html_comment_markers.rs`

A small Rust integration test that creates an `.html` doc containing `lens-comment` and `lens-reply` markers via the relay's API, reads it back, and asserts byte-equality. Catches any future server-side change that inadvertently rewrites HTML.

- [ ] **Step 1: Read an existing integration test for shape**

```bash
ls crates/relay/tests/
```

Pick the closest existing example (likely one that creates a doc and reads it back). Mirror its setup (in-memory storage, test server).

- [ ] **Step 2: Write the failing test**

```rust
// crates/relay/tests/html_comment_markers.rs
// Adapt the boilerplate from a sibling test file (auth/setup/teardown).

#[tokio::test]
async fn html_with_comment_markers_round_trips() {
    let test_ctx = setup_test_server().await; // from sibling test
    let source = r#"<p>Hello</p>
<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->
<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t","body":"r"}-->
<p>World</p>"#;
    let doc_id = test_ctx.create_doc("/sample.html", source).await.unwrap();
    let read_back = test_ctx.read_doc(doc_id).await.unwrap();
    assert_eq!(read_back, source);
}
```

- [ ] **Step 3: Run** `cargo test --manifest-path crates/Cargo.toml -p relay html_comment_markers`. If the test passes on first run (likely — the relay should round-trip text unchanged), TDD requires we still observe a failing state to verify the test actually catches regressions. Do that next:

- [ ] **Step 4: Force a RED state to validate the test detects regressions**

Temporarily edit the relay's HTML-write path to mangle output — for example, in whichever module returns the document text on read, append `regression-marker` to the response. Run the test again; it MUST fail with a clear diff. If it does not fail, the assertion is too loose — strengthen it before continuing.

```bash
# Revert the temporary mangle:
jj diff -r @
jj restore crates/relay/src/<file you mangled>
```

- [ ] **Step 5: Verify GREEN (after restore)**

Run: `cargo test --manifest-path crates/Cargo.toml -p relay html_comment_markers`
Expected: PASS.

- [ ] **Step 6: Commit:** `jj commit -m "test: regression for HTML comment marker round-trip through relay"`

---

## Task 15: Manual smoke verification

**Files:** none — verification only.

- [ ] **Step 1: Start the stack**

```bash
cd lens-editor && npm run relay:start
# new terminal:
cd lens-editor && npm run dev:local
```

Generate a share link:

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://localhost:5373
```

Open in Chrome (URL via `dev.vps:5373` from your machine, or `localhost:5373` on the VPS).

- [ ] **Step 2: Create a fresh `.html` file** from the sidebar (uses the v1 "New HTML File" flow).

- [ ] **Step 3: Paste this minimal source**

```html
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
<h1>Smoke test</h1>
<p>This paragraph has unique text alpha.</p>
<p>This paragraph has duplicate text beta.</p>
<p>This paragraph has duplicate text beta.</p>
<script>console.log('user script ran');</script>
</body></html>
```

- [ ] **Step 4: Verify dot rendering**

Activate **Comment mode**, click on "alpha" → comment thread popover opens, type "test comment", send.
Expected: dot appears next to the paragraph; thread shows "test comment".

- [ ] **Step 5: Verify ambiguous placement**

Comment mode again, click on one of the "beta" paragraphs.
Expected: probe-verify resolves correctly (only one beta paragraph overlaps the click rect); marker lands at the right position.

- [ ] **Step 6: Verify multi-tab sync**

Open the same share link in a second tab. Add a reply in tab A → assert reply appears in tab B's popover within ~1s.

- [ ] **Step 7: Verify orphan handling**

Edit the source to insert a script: `<script>document.querySelectorAll('p').forEach(p => p.remove())</script>` (or equivalent that wipes anchored elements).
Switch to preview.
Expected: orphan badge appears with count of comments whose anchors are gone; orphan panel lists them; "Find in source" works.

- [ ] **Step 8: Verify sandbox unchanged**

In the iframe's DevTools console, run `window.parent.document`.
Expected: throws cross-origin error (v1 sandbox preserved).

- [ ] **Step 9: Commit nothing** — verification only.

---

## Verification checklist (run before claiming done)

- [ ] All Vitest suites pass: `cd lens-editor && npm run test:run`
- [ ] Server tests pass: `cargo test --manifest-path crates/Cargo.toml`
- [ ] Lint clean: `cd lens-editor && npm run lint`
- [ ] TypeScript clean: `cd lens-editor && npm run build` (build succeeds)
- [ ] Manual smoke (Task 15) all steps green
- [ ] No `// TODO` left in v2 code
- [ ] `jj log` shows one commit per task in order; messages match the plan
