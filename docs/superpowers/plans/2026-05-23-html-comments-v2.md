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
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts` | The injected script. Exports pure functions (`renderDots`, `captureFingerprint`, `findProbe`, `installHandlers`) so they're directly unit-testable against happy-dom. A small wrapper IIFE at the bottom is what actually gets injected into srcdoc. | New |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.test.ts` | DOM-level tests for `renderDots`, `captureFingerprint`, `findProbe` against happy-dom (no mocked DOM). | New |
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
| `lens-editor/src/lib/identity.ts` (or wherever user identity lives — verify in step 0) | Source of "current user email" passed into comment-store mutations. | Read only — no change expected |
| `crates/relay/tests/html_comment_markers.rs` | Server regression: `.html` doc containing `lens-comment` / `lens-reply` markers round-trips through the relay unchanged. | New |

---

## Task 0: Pre-flight verification

**Files:** read-only.

- [ ] **Step 1: Verify v1 file layout matches plan assumptions**

Run:
```bash
ls lens-editor/src/components/HtmlEditor/
```
Expected: `HtmlEditor.tsx`, `HtmlPreview.tsx`, `HtmlSourceEditor.tsx`, `index.ts`, plus existing test files.

If any are missing, stop and reconcile with the v1 implementation before continuing.

- [ ] **Step 2: Locate "current user" identity source**

Run:
```bash
grep -rn "currentUser\|userEmail\|useIdentity\|auth\.user" lens-editor/src/ | head -20
```

Identify the hook/util that exposes the current user's email (or username). The comment-store mutations need this as an `author` parameter. **Record the import path** — it's referenced in Tasks 2, 10, 12.

- [ ] **Step 3: Confirm Yjs origin constant**

Run:
```bash
grep -rn "LENS_EDITOR_ORIGIN\|editorOrigin" lens-editor/src/ | head -10
```

Atomic mutations in Task 2 use this origin to mark transactions as Lens-editor-originated (so the watchdog and other observers can filter). **Record the import path.**

- [ ] **Step 4: Commit nothing — this task is verification only**

---

## Task 1: Comment store — parse & serialize (pure)

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/comment-store.ts`
- Test: `lens-editor/src/components/HtmlEditor/comment-store.test.ts`

The comment store has two layers: pure parse/serialize over plain strings (this task) and Y.Text mutation helpers (Task 2). This task is the foundation; everything else uses it.

- [ ] **Step 1: Write the failing test**

`comment-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseComments,
  serializeComment,
  serializeReply,
  escapeCommentBody,
  unescapeCommentBody,
  type CommentMarker,
  type ReplyMarker,
} from './comment-store';

describe('escape/unescape', () => {
  it('rewrites --> to --&gt; on escape and reverses on unescape', () => {
    expect(escapeCommentBody('see -->')).toBe('see --&gt;');
    expect(unescapeCommentBody('see --&gt;')).toBe('see -->');
    expect(unescapeCommentBody(escapeCommentBody('plain text'))).toBe('plain text');
  });
});

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

  it('escapes --> inside the body', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'has --> in it',
    };
    expect(serializeComment(marker)).toContain('has --&gt; in it');
    expect(serializeComment(marker).endsWith('-->')).toBe(true);
  });
});

describe('parseComments', () => {
  it('returns empty for source with no markers', () => {
    expect(parseComments('<p>hello</p>')).toEqual([]);
  });

  it('parses a single top-level comment', () => {
    const src = 'before <!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--> after';
    const result = parseComments(src);
    expect(result).toEqual([
      {
        comment: { kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'x' },
        replies: [],
        sourceStart: 7,
        sourceEnd: 73,
      },
    ]);
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

  it('round-trips: parse then serialize produces byte-equal source for comment markers', () => {
    const src = 'X<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"y"}-->Y';
    const parsed = parseComments(src);
    const reSerialized = serializeComment(parsed[0].comment);
    expect(src.slice(parsed[0].sourceStart, parsed[0].sourceEnd)).toBe(reSerialized);
  });

  it('unescapes --&gt; back to --> on parse', () => {
    const src = '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"has --&gt; in it"}-->';
    expect(parseComments(src)[0].comment.body).toBe('has --> in it');
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

export function escapeCommentBody(s: string): string {
  return s.replace(/-->/g, '--&gt;');
}

export function unescapeCommentBody(s: string): string {
  return s.replace(/--&gt;/g, '-->');
}

function serializePayload<T extends Record<string, unknown>>(payload: T): string {
  const escaped = { ...payload } as Record<string, unknown>;
  for (const [k, v] of Object.entries(escaped)) {
    if (typeof v === 'string') escaped[k] = escapeCommentBody(v);
  }
  return JSON.stringify(escaped);
}

export function serializeComment(m: CommentMarker): string {
  const { id, author, ts, body } = m;
  return `<!--lens-comment ${serializePayload({ id, author, ts, body })}-->`;
}

export function serializeReply(m: ReplyMarker): string {
  const { id, parent, author, ts, body } = m;
  return `<!--lens-reply ${serializePayload({ id, parent, author, ts, body })}-->`;
}

const MARKER_RE = /<!--lens-(comment|reply) (\{[\s\S]*?\})-->/g;

function parsePayload(raw: string): Record<string, string> | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') return null;
      out[k] = unescapeCommentBody(v);
    }
    return out;
  } catch {
    return null;
  }
}

export function parseComments(source: string): CommentCluster[] {
  const clusters: CommentCluster[] = [];
  const byId = new Map<string, CommentCluster>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(source)) !== null) {
    const [whole, kind, payloadRaw] = m;
    const payload = parsePayload(payloadRaw);
    if (!payload) continue;
    const start = m.index;
    const end = start + whole.length;
    if (kind === 'comment') {
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
        sourceStart: start,
        sourceEnd: end,
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
      parent.sourceEnd = end;
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
  const clusters = parseComments(source);
  for (const cluster of clusters) {
    if (cluster.comment.id === id) {
      // Parent ends where serializeComment ends — recompute from source.
      const start = cluster.sourceStart;
      const end = start + serializeComment(cluster.comment).length;
      return { start, end, kind: 'comment', current: cluster.comment };
    }
    let cursor = cluster.sourceStart + serializeComment(cluster.comment).length;
    for (const r of cluster.replies) {
      const rText = serializeReply(r);
      if (r.id === id) return { start: cursor, end: cursor + rText.length, kind: 'reply', current: r };
      cursor += rText.length;
    }
  }
  return null;
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
  const clusters = parseComments(source);
  ytext.doc!.transact(() => {
    for (const cluster of clusters) {
      if (cluster.comment.id === id) {
        // Cascade: delete from parent start through last reply end.
        ytext.delete(cluster.sourceStart, cluster.sourceEnd - cluster.sourceStart);
        return;
      }
      const parentEnd = cluster.sourceStart + serializeComment(cluster.comment).length;
      let cursor = parentEnd;
      for (const r of cluster.replies) {
        const rText = serializeReply(r);
        if (r.id === id) {
          ytext.delete(cursor, rText.length);
          return;
        }
        cursor += rText.length;
      }
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

const OVERLAY_ROOT_ID = 'lens-comment-overlay-root';

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

The wiring is tested by directly invoking the exported `installBridge(window)` function in happy-dom, then sending real `MessageEvent`s and asserting outgoing postMessage calls via a real-but-captured handler on `window.parent` (no library mocks — we hook `window.parent.postMessage` to a real spy function).

- [ ] **Step 1: Write the failing test**

`bridge-script.wiring.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installBridge } from './bridge-script';
import type { Envelope, BridgeToParent, ParentToBridge } from './protocol';

const SCRIPT_HASH = 'test-hash';

function setup() {
  document.body.innerHTML =
    '<p>before</p>' +
    '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
    '<p id="t">after</p>';
  const sent: Array<Envelope<BridgeToParent>> = [];
  // Replace the bridge's view of the parent with a stand-in we control.
  // (happy-dom defaults window.parent === window.)
  const fakeParent = {
    postMessage: (env: Envelope<BridgeToParent>) => sent.push(env),
  };
  installBridge(window as Window & typeof globalThis, fakeParent as unknown as Window, SCRIPT_HASH);
  return { sent };
}

describe('installBridge', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('posts "ready" with scriptHash immediately on install', () => {
    const { sent } = setup();
    expect(sent[0].message.type).toBe('ready');
    expect((sent[0].message as Extract<BridgeToParent, { type: 'ready' }>).payload.scriptHash).toBe(SCRIPT_HASH);
  });

  it('after receiving init, renders dots and posts comments-rendered', () => {
    const { sent } = setup();
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
    const { sent } = setup();
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
    const { sent } = setup();
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
    const { sent } = setup();
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
    const { sent } = setup();
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

export function installBridge(win: Window & typeof globalThis, parent: Window, scriptHash: string): void {
  let nonce: string | null = null;
  let clickToPlaceArmed = false;
  const doc = win.document;

  function postToParent(message: BridgeToParent): void {
    if (!nonce) {
      // ready is the only pre-init message; emitted without nonce envelope.
      (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(
        { nonce: '', message },
        '*',
      );
      return;
    }
    const env: Envelope<BridgeToParent> = { nonce, message };
    (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(env, '*');
  }

  function rebuildDots(comments: Array<{ id: string; body: string; replies: number }>): void {
    const result = renderDots(doc, comments);
    postToParent({ type: 'comments-rendered', payload: result });
    // Wire dot click handlers.
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

  // emit ready immediately
  postToParent({ type: 'ready', payload: { scriptHash } });

  let lastComments: Array<{ id: string; body: string; replies: number }> = [];

  win.addEventListener('message', (event: MessageEvent) => {
    // Only accept from our designated parent.
    if (event.source !== parent && event.source !== null) return;
    const data = event.data as Envelope<ParentToBridge>;
    if (nonce === null) {
      // Before init we only accept init messages (nonce assigned here).
      if (!data || typeof data !== 'object') return;
      const msg = data.message;
      if (!msg || msg.type !== 'init') return;
      if (typeof data.nonce !== 'string') return;
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

  // Re-render dots when DOM mutates outside our overlay (debounced).
  let pending = false;
  const observer = new win.MutationObserver(() => {
    if (pending) return;
    pending = true;
    win.setTimeout(() => {
      pending = false;
      rebuildDots(lastComments);
    }, 100);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
}

const OVERLAY_ROOT_ID_INTERNAL = 'lens-comment-overlay-root';
// (Internal export to keep the constant in one place across functions above.)
export { OVERLAY_ROOT_ID_INTERNAL as OVERLAY_ROOT_ID };
```

(Note: `OVERLAY_ROOT_ID` in `renderDots` should already match this constant. If your Task 4 implementation used a local `const OVERLAY_ROOT_ID`, refactor here to export it once and import from both places. Either way: a single source of truth.)

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

  it('ranks higher when ancestor path matches better', () => {
    const src = '<main><p>click here</p></main><aside><p>click here</p></aside>';
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'p',
      ancestorPath: [{ tag: 'main', index: 0 }, { tag: 'p', index: 0 }],
    }));
    expect(result[0].score).toBeGreaterThan(result[1].score);
    expect(src.slice(0, result[0].position)).toContain('<main>');
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

function ancestorBonus(source: string, position: number, fp: Fingerprint): number {
  if (fp.ancestorPath.length === 0) return 0;
  // Heuristic: count how many of fp.ancestorPath tags appear as open tags before `position`.
  const before = source.slice(0, position);
  let bonus = 0;
  for (const a of fp.ancestorPath) {
    const re = new RegExp(`<${a.tag}\\b`, 'gi');
    const matches = before.match(re);
    if (matches && matches.length > 0) bonus += 5;
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

The test simulates the bridge by directly dispatching `MessageEvent` on `window` (the parent in test = parent in production). No iframe mocking — happy-dom renders the iframe; we just don't depend on its script execution.

- [ ] **Step 1: Write the failing test (extend existing file)**

Append to `HtmlPreview.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';
import type { Envelope, BridgeToParent } from './bridge/protocol';

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
    // Simulate bridge ready → parent should respond with init (which is internal; we just send dot-clicked next).
    dispatchFromBridge(iframe, { nonce: '__test__', message: { type: 'ready', payload: { scriptHash: 'test' } } });
    // (In production the parent's nonce match enforces validation; the test bypasses via the source check.)
    await act(async () => {
      dispatchFromBridge(iframe, { nonce: '__test__', message: { type: 'dot-clicked', payload: { id: 'c1' } } });
    });
    expect(screen.getByText('question')).toBeInTheDocument();
  });

  it('calls onOrphanedChange with reported orphan ids', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    const orphans: string[][] = [];
    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} onOrphanedChange={ids => orphans.push(ids)} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, { nonce: '__test__', message: { type: 'comments-rendered', payload: { found: [], orphaned: ['c1'] } } });
    });
    expect(orphans.at(-1)).toEqual(['c1']);
  });

  it('preserves v1 behavior: srcdoc updates after debounce', async () => {
    // Existing v1 test — leave intact.
    // (Adjust assertions if v1 tests changed shape; this is a regression guard, not a new spec.)
  });
});
```

(The third test is a placeholder: copy whatever existing v1 srcdoc-update assertion the file currently has so this task does not regress it.)

Also: the test bypasses real nonce validation by using a sentinel `__test__` and matching it on the parent side (next step). The production HtmlPreview accepts a `nonceForTests` prop that, if set, overrides nonce generation. This is the **one acceptable use of a test-injected prop**: it's a single-line escape hatch for the nonce boundary which we otherwise can't observe from the test, and it does not change runtime behavior in production (default uses `makeNonce`). Per testing-anti-patterns: the alternative (intercepting `crypto.getRandomValues`) is worse.

If you'd rather avoid the prop, an equivalent: factor nonce generation behind a default function parameter `nonceGen: () => string = makeNonce` and pass `() => '__test__'` from tests. Same trade-off; pick whichever reads cleaner.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: FAIL — props missing, popover not rendered.

- [ ] **Step 3: Rewrite `HtmlPreview.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { CommentThread } from './CommentThread';
import { parseComments } from './comment-store';
import { makeNonce, validateEnvelope, type Envelope, type BridgeToParent, type CommentSummary, type ParentToBridge } from './bridge/protocol';

const BRIDGE_SCRIPT_HASH = '__BRIDGE_SCRIPT_HASH__'; // injected at build time; placeholder during dev

// At build time, bundle bridge-script.ts as a string and inline as BRIDGE_SOURCE.
// For now (Task 9), use a dev placeholder; Task 13 wires the real bundling.
const BRIDGE_SOURCE = ''; // populated by build tooling in Task 13

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser: string;
  origin: unknown;
  debounceMs?: number;
  onOrphanedChange?: (orphanedIds: string[]) => void;
  nonceForTests?: string; // see Task 9 note
}

export function HtmlPreview({ ytext, currentUser, origin, debounceMs = 300, onOrphanedChange, nonceForTests }: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string>(nonceForTests ?? makeNonce());

  // Subscribe to Y.Text
  useEffect(() => {
    const sync = () => setContent(ytext.toString());
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  // Debounce srcdoc
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  // Compute injected srcdoc.
  const srcDoc = injectBridge(debounced, nonceRef.current);

  // Bridge message handling.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const msg = validateEnvelope<BridgeToParent>(event.data, nonceRef.current);
      if (!msg) {
        // Allow unvalidated `ready` (no nonce yet); respond with init.
        const data = event.data as Envelope<BridgeToParent>;
        if (data?.message?.type === 'ready') {
          sendToBridge({ type: 'init', payload: { comments: summarize(ytext), scriptHash: BRIDGE_SCRIPT_HASH } });
        }
        return;
      }
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
          // Task 10
          break;
        case 'probe-found':
          // Task 10
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

  // When comments change in source, notify bridge.
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

function injectBridge(source: string, _nonce: string): string {
  const tag = `<script>${BRIDGE_SOURCE}</script>`;
  // Insert as first child of <head> if present, else prepend.
  const headOpen = source.match(/<head\b[^>]*>/i);
  if (headOpen) {
    const idx = headOpen.index! + headOpen[0].length;
    return source.slice(0, idx) + tag + source.slice(idx);
  }
  return tag + '\n' + source;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npm run test:run -- HtmlPreview`
Expected: PASS — bridge-integration tests green; existing v1 srcdoc-debounce test still green.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "feat: HtmlPreview bridge integration (popover, orphan callback)"
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
- On `click-captured` → run `scoreCandidates` + `verifyByProbe` → on `placed`, call `addComment`, open thread; on `manual`, surface a callback for split-source UI (Task placeholder — Task 11 wires the actual UI).

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
      isCommentMode={true} onPlaceComplete={onPlace} nonceForTests="__test__"
    />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test__',
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

  it('falls back to manual placement callback when no candidate verifies', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onManual = vi.fn();
    render(<HtmlPreview
      ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0}
      isCommentMode={true} onManualPlacement={onManual} nonceForTests="__test__"
    />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: { before: 'click ', after: 'here', tag: 'p', ancestorPath: [], clickRect: { x: 9999, y: 9999, w: 1, h: 1 } },
          },
        },
      });
      // Simulate probe-found responses missing the click point.
      dispatchFromBridge(iframe, {
        nonce: '__test__',
        message: { type: 'probe-found', payload: { token: 'any', rect: { x: 0, y: 0, w: 1, h: 1 } } },
      });
    });
    expect(onManual).toHaveBeenCalled();
    expect(parseComments(ytext.toString())).toEqual([]);
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
  nonceForTests?: string;
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

Build a `ProbeRunner` backed by a hidden iframe:

```tsx
function useHiddenProbeRunner(nonce: string): ProbeRunner {
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
  const { ...rest } = setupHtmlEditorTest(ytext); // existing helper or inline render
  const btn = screen.getByRole('button', { name: /comment mode/i });
  expect(btn).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(btn);
  expect(btn).toHaveAttribute('aria-pressed', 'true');
});

it('orphan badge displays the count from HtmlPreview', async () => {
  // Render in preview mode, simulate orphan callback firing
  // (Use the existing render helper; simulate by dispatching a message event with comments-rendered.)
  // Then assert that the chrome shows a badge with the orphan count.
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

Extend `HtmlEditor.tsx` to render a comment-mode toggle, manage state, and show the orphan panel:

```tsx
const [commentMode, setCommentMode] = useState(false);
const [orphanedIds, setOrphanedIds] = useState<string[]>([]);
// ... existing toolbar with mode toggle ...
<button
  type="button"
  aria-pressed={commentMode}
  aria-label="Comment mode"
  onClick={() => setCommentMode(m => !m)}
  className={commentMode ? 'rounded bg-amber-500 px-3 py-1.5 text-sm text-white' : 'rounded px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100'}
>💬 Comment</button>
{orphanedIds.length > 0 && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">{orphanedIds.length} orphan</span>}
// ... pass to HtmlPreview ...
<HtmlPreview ytext={ytext} currentUser={currentUser} origin={LENS_EDITOR_ORIGIN} isCommentMode={commentMode}
  onOrphanedChange={setOrphanedIds} onPlaceComplete={() => setCommentMode(false)} />
// ... layout: in split mode, render OrphanedCommentsPanel on right ...
```

(Use the `currentUser` and `LENS_EDITOR_ORIGIN` import paths from Task 0.)

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
it('on manual placement, switches to split mode and places marker at clicked source position', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>click here</p><p>click here</p>');
  render(<HtmlEditor ytext={ytext} awareness={new Awareness(doc)} currentUser="me@x" />);
  // Activate comment mode, then simulate the preview's onManualPlacement callback
  // by invoking the same flow the bridge would trigger:
  //   1. comment-mode toggle ON
  //   2. dispatch click-captured with ambiguous fingerprint
  //   3. dispatch probe-found responses that miss
  //   4. assert: split mode active, source pane shows highlights
  //   5. simulate source-pane click on the second 'click here'
  //   6. assert: addComment called at position 20
  // (Implementation details depend on existing test harness; mirror Task 9/10 helpers.)
  // The assertion that matters:
  // expect(parseComments(ytext.toString())[0].sourceStart).toBe(/* position of clicked candidate */);
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

## Task 13: Bundle bridge-script as a string + inject build hash

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Modify: `lens-editor/vite.config.ts` (or equivalent build config)
- Create: `lens-editor/src/components/HtmlEditor/bridge/bridge-bundle.ts` (generated import)

Until now `BRIDGE_SOURCE` and `BRIDGE_SCRIPT_HASH` have been placeholders. This task makes them real.

Approach:
- Use Vite's `?raw` query suffix to import the compiled bridge script as a string.
- Use a tiny build-time helper to compute SHA-256 of that string and export both.

- [ ] **Step 1: Write the failing test** — a smoke assertion that `BRIDGE_SOURCE` is non-empty and contains `installBridge`.

```ts
// bridge/bridge-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { BRIDGE_SOURCE, BRIDGE_SCRIPT_HASH } from './bridge-bundle';

describe('bridge bundle', () => {
  it('exports a non-empty source string', () => {
    expect(BRIDGE_SOURCE.length).toBeGreaterThan(500);
    expect(BRIDGE_SOURCE).toContain('installBridge');
  });
  it('exports a 64-char hex script hash', () => {
    expect(BRIDGE_SCRIPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Verify FAIL.**

- [ ] **Step 3: Implement `bridge-bundle.ts`**

Strategy: the raw bridge source uses the literal token `__BRIDGE_HASH__` wherever it needs its own hash. `bridge-bundle.ts` computes the hash of the raw source, then exports a finalized string with the token replaced. The hash is computed eagerly with top-level await (Vite supports this in ESM modules).

```ts
// bridge/bridge-bundle.ts
import rawSource from './bridge-script.ts?raw';

async function sha256Hex(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// IIFE wrapper: invoke installBridge automatically when injected.
const withIIFE = rawSource + '\n;installBridge(window, window.parent, "__BRIDGE_HASH__");\n';

export const BRIDGE_SCRIPT_HASH: string = await sha256Hex(withIIFE);
export const BRIDGE_SOURCE: string = withIIFE.replace('__BRIDGE_HASH__', BRIDGE_SCRIPT_HASH);
```

In `bridge-script.ts`, the IIFE call uses the placeholder token `"__BRIDGE_HASH__"` which is replaced at module load time (not at Vite build time — runtime replace is simpler than configuring a Vite plugin).

In `HtmlPreview.tsx`, replace placeholder constants with the real imports:

```ts
import { BRIDGE_SOURCE, BRIDGE_SCRIPT_HASH } from './bridge/bridge-bundle';
```

Remove the old `const BRIDGE_SCRIPT_HASH = '__BRIDGE_SCRIPT_HASH__'` and `const BRIDGE_SOURCE = ''` placeholders.

If top-level await causes problems (e.g., older Vite target), fall back to exporting a `getBridgeBundle(): Promise<{ source, hash }>` and awaiting it once at the top of `HtmlPreview` via a ref, but the eager form is preferred.

- [ ] **Step 4: Verify PASS** (and re-run all HtmlPreview tests to confirm nothing regressed).

- [ ] **Step 5: Commit:** `jj commit -m "build: bundle bridge-script as inlined source + script hash"`

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

- [ ] **Step 3: Run** `cargo test --manifest-path crates/Cargo.toml -p relay html_comment_markers -- --nocapture`. Expected: FAIL initially only if the helper APIs don't exist yet; if relay round-trips strings unchanged (which it should), the test should PASS on first run. If it FAILS for a real reason (server alters HTML), debug — that's the regression we want to catch.

- [ ] **Step 4: Verify PASS.**

- [ ] **Step 5: Commit:** `jj commit -m "test: regression for HTML comment marker round-trip through relay"`

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
