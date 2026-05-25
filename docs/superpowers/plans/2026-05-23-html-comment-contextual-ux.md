# HTML Comment Contextual UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HTML preview comments start from right-click or selected text, reuse the markdown comment composer, avoid empty root comments, and preserve preview scroll after adding a comment.

**Architecture:** The iframe bridge captures contextual placement intent and reports a fingerprint, preview coordinates, and iframe scroll. `HtmlPreview` resolves iframe placements and opens a deferred composer before mutating `Y.Text`. `HtmlEditor` keeps manual source fallback for ambiguous placements, but source clicks open the same composer instead of writing an empty marker.

**Tech Stack:** React 19, TypeScript, CodeMirror 6, Yjs, Vitest/happy-dom, Vite, existing HTML bridge `postMessage` protocol.

---

## File Map

| File | Responsibility |
| --- | --- |
| `lens-editor/src/components/HtmlEditor/bridge/protocol.ts` | Add typed bridge messages for contextual placement and scroll restoration. |
| `lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts` | Validate new protocol envelope shapes. |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts` | Capture right-click and selected-text comment intents inside the sandboxed iframe; restore scroll on request. |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.test.ts` | DOM-pure tests for contextmenu, selection, and scroll handling. |
| `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts` | End-to-end bridge message wiring tests. |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx` | Resolve iframe placement requests, show deferred `NewCommentCard`, submit/cancel without empty markers, restore scroll. |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx` | Preview tests for right-click placement, submit, cancel, and scroll restoration. |
| `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx` | Include click coordinates when manual source fallback chooses a position. |
| `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx` | Verify manual source click reports position and coordinates. |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx` | Manual ambiguous placement opens `NewCommentCard` and writes on submit only. |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx` | Integration tests for toolbar fallback and manual fallback no-empty-marker behavior. |

---

## Task 1: Bridge Protocol For Contextual Placement And Scroll Restore

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/protocol.ts`
- Modify: `lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add tests that compile against the desired message types:

```ts
// lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts
it('accepts contextual placement request envelopes', () => {
  const msg: BridgeToParent = {
    type: 'placement-requested',
    payload: {
      trigger: 'contextmenu',
      fingerprint: {
        before: '',
        after: 'Hello',
        tag: 'p',
        ancestorPath: [{ tag: 'p', index: 0 }],
        clickRect: { x: 10, y: 20, w: 100, h: 18 },
      },
      point: { x: 10, y: 20 },
      scroll: { x: 0, y: 140 },
    },
  };
  const env: Envelope<BridgeToParent> = { nonce: 'n', message: msg };
  expect(validateEnvelope(env, 'n')).toEqual(msg);
});

it('accepts restore-scroll parent messages', () => {
  const msg: ParentToBridge = {
    type: 'restore-scroll',
    payload: { x: 0, y: 140 },
  };
  const env: Envelope<ParentToBridge> = { nonce: 'n', message: msg };
  expect(validateEnvelope(env, 'n')).toEqual(msg);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/protocol.test.ts
```

Expected: TypeScript/Vitest fails because `placement-requested` and `restore-scroll` are not yet valid in the protocol types.

- [ ] **Step 3: Add protocol types**

Update `protocol.ts` with explicit shared shapes:

```ts
export interface ViewportPoint {
  x: number;
  y: number;
}

export interface PreviewScroll {
  x: number;
  y: number;
}

export type PlacementTrigger = 'contextmenu' | 'selection' | 'toolbar';

export interface PlacementRequest {
  trigger: PlacementTrigger;
  fingerprint: Fingerprint;
  point: ViewportPoint;
  scroll: PreviewScroll;
}
```

Extend the unions:

```ts
export type ParentToBridge =
  | { type: 'init'; payload: { comments: CommentSummary[] } }
  | { type: 'find-probe'; payload: { token: string } }
  | { type: 'highlight-comment'; payload: { id: string } }
  | { type: 'set-comments'; payload: { comments: CommentSummary[] } }
  | { type: 'enable-click-to-place'; payload: Record<string, never> }
  | { type: 'disable-click-to-place'; payload: Record<string, never> }
  | { type: 'restore-scroll'; payload: PreviewScroll };

export type BridgeToParent =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'dot-clicked'; payload: { id: string } }
  | { type: 'click-captured'; payload: { fingerprint: Fingerprint } }
  | { type: 'placement-requested'; payload: PlacementRequest }
  | { type: 'probe-found'; payload: { token: string; rect: { x: number; y: number; w: number; h: number } | null } }
  | { type: 'comments-rendered'; payload: { found: string[]; orphaned: string[] } };
```

- [ ] **Step 4: Run protocol tests to verify GREEN**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/protocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: add HTML placement bridge protocol"
```

---

## Task 2: Iframe Bridge Captures Right-Click, Selection, And Restore Scroll

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.test.ts`
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts`

- [ ] **Step 1: Write failing DOM-pure tests**

Add tests to `bridge-script.test.ts`:

```ts
it('captures right-click placement requests with point and scroll', () => {
  setupBody('<p id="target">Hello world</p>');
  window.scrollTo(0, 120);
  const target = document.getElementById('target')!;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    left: 5, top: 10, right: 105, bottom: 30, width: 100, height: 20,
    x: 5, y: 10, toJSON() {},
  } as DOMRect);

  const fp = captureFingerprintAt(target, 15, 20, 0);
  expect(fp.after).toContain('Hello');

  const cleanup = installBridge(window);
  const posted: unknown[] = [];
  vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
    posted.push(msg);
  });

  window.dispatchEvent(new MessageEvent('message', {
    source: window.parent,
    data: { nonce: 'N', message: { type: 'init', payload: { comments: [] } } },
  }));
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 15,
    clientY: 20,
  }));

  expect(posted).toContainEqual({
    nonce: 'N',
    message: {
      type: 'placement-requested',
      payload: expect.objectContaining({
        trigger: 'contextmenu',
        point: { x: 15, y: 20 },
        scroll: { x: 0, y: 120 },
      }),
    },
  });
  cleanup();
});

it('restores scroll when parent sends restore-scroll', () => {
  setupBody('<p>scroll me</p>');
  const cleanup = installBridge(window);
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

  window.dispatchEvent(new MessageEvent('message', {
    source: window.parent,
    data: { nonce: 'N', message: { type: 'init', payload: { comments: [] } } },
  }));
  window.dispatchEvent(new MessageEvent('message', {
    source: window.parent,
    data: { nonce: 'N', message: { type: 'restore-scroll', payload: { x: 3, y: 140 } } },
  }));

  expect(scrollTo).toHaveBeenCalledWith(3, 140);
  cleanup();
});
```

Add this wiring test to `bridge-script.wiring.test.ts`:

```ts
it('posts placement-requested when rendered text is selected', async () => {
  vi.useFakeTimers();
  arm();
  dispatchToBridge({ type: 'init', payload: { comments: [] } });
  document.body.innerHTML = '<p id="target">selectable text</p>';
  const target = document.getElementById('target')!;
  stubRenderedRect(target);
  sent = [];

  const rangeRect = {
    left: 20,
    top: 30,
    right: 120,
    bottom: 48,
    x: 20,
    y: 30,
    width: 100,
    height: 18,
    toJSON: () => ({}),
  } as DOMRect;
  const range = document.createRange();
  range.selectNodeContents(target);
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue(rangeRect);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 30, clientY: 35 }));
  await vi.runAllTimersAsync();

  const placement = sent.find(e => e.message.type === 'placement-requested');
  expect(placement?.message).toMatchObject({
    type: 'placement-requested',
    payload: {
      trigger: 'selection',
      point: { x: 70, y: 39 },
    },
  });
});
```

- [ ] **Step 2: Run bridge tests to verify RED**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.test.ts src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts
```

Expected: FAIL because no contextmenu, selection, or restore-scroll handling exists.

- [ ] **Step 3: Implement right-click capture**

In `installBridge`, add a `contextmenu` listener that:

```ts
const contextMenuListener = (event: MouseEvent): void => {
  const target = event.target;
  if (!(target instanceof win.Element)) return;
  const ownedOverlayRoot = getOwnedOverlayRoot(doc);
  if (ownedOverlayRoot?.contains(target)) return;
  event.preventDefault();
  const fingerprint = captureFingerprintAt(target, event.clientX, event.clientY, 0);
  postToParent({
    type: 'placement-requested',
    payload: {
      trigger: 'contextmenu',
      fingerprint,
      point: { x: event.clientX, y: event.clientY },
      scroll: { x: win.scrollX, y: win.scrollY },
    },
  });
};
win.addEventListener('contextmenu', contextMenuListener, true);
```

Remove this listener in `cleanup`.

- [ ] **Step 4: Implement selection capture**

Add a `mouseup` listener that waits one microtask, checks `win.getSelection()`, and sends a placement request when selected text is non-empty:

```ts
function elementFromSelection(selection: Selection): Element | null {
  const node = selection.anchorNode;
  if (!node) return null;
  return node.nodeType === win.Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
}

const selectionListener = (): void => {
  win.setTimeout(() => {
    const selection = win.getSelection();
    if (!selection || selection.toString().trim() === '' || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const target = elementFromSelection(selection);
    if (!target) return;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const fingerprint = captureFingerprintAt(target, x, y, 0);
    postToParent({
      type: 'placement-requested',
      payload: {
        trigger: 'selection',
        fingerprint,
        point: { x, y },
        scroll: { x: win.scrollX, y: win.scrollY },
      },
    });
  }, 0);
};
win.addEventListener('mouseup', selectionListener);
```

Remove this listener in `cleanup`.

- [ ] **Step 5: Implement scroll restore message**

In the parent-message switch:

```ts
case 'restore-scroll': {
  if (!isObject(msg.payload)) return;
  const x = msg.payload.x;
  const y = msg.payload.y;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  win.scrollTo(x, y);
  break;
}
```

- [ ] **Step 6: Run bridge tests to verify GREEN**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.test.ts src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: capture contextual HTML comment intents"
```

---

## Task 3: HtmlPreview Defers Root Comment Creation Until Composer Submit

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`

- [ ] **Step 1: Write failing tests for contextual composer**

Add tests to `HtmlPreview.test.tsx`:

```tsx
it('right-click placement opens composer without mutating source', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>Hello world</p>');

  render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

  await act(async () => {
    dispatchFromBridge(iframe, {
      nonce: '__test_nonce__',
      message: {
        type: 'placement-requested',
        payload: {
          trigger: 'contextmenu',
          fingerprint: {
            before: '',
            after: 'Hello world',
            tag: 'p',
            ancestorPath: [{ tag: 'p', index: 0 }],
            clickRect: { x: 20, y: 30, w: 120, h: 20 },
          },
          point: { x: 20, y: 30 },
          scroll: { x: 0, y: 100 },
        },
      },
    });
    await Promise.resolve();
  });

  expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
  expect(ytext.toString()).not.toContain('lens-comment');
});

it('submitting contextual composer writes root comment body once', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>Hello world</p>');

  render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

  await act(async () => {
    dispatchFromBridge(iframe, {
      nonce: '__test_nonce__',
      message: {
        type: 'placement-requested',
        payload: {
          trigger: 'contextmenu',
          fingerprint: {
            before: '',
            after: 'Hello world',
            tag: 'p',
            ancestorPath: [{ tag: 'p', index: 0 }],
            clickRect: { x: 20, y: 30, w: 120, h: 20 },
          },
          point: { x: 20, y: 30 },
          scroll: { x: 0, y: 100 },
        },
      },
    });
  });

  fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
    target: { value: 'real comment' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

  const clusters = parseComments(ytext.toString());
  expect(clusters).toHaveLength(1);
  expect(clusters[0].comment.body).toBe('real comment');
  expect(clusters[0].replies).toEqual([]);
});

it('cancelling contextual composer writes no marker', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>Hello world</p>');

  render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

  await act(async () => {
    dispatchFromBridge(iframe, {
      nonce: '__test_nonce__',
      message: {
        type: 'placement-requested',
        payload: {
          trigger: 'contextmenu',
          fingerprint: {
            before: '',
            after: 'Hello world',
            tag: 'p',
            ancestorPath: [{ tag: 'p', index: 0 }],
            clickRect: { x: 20, y: 30, w: 120, h: 20 },
          },
          point: { x: 20, y: 30 },
          scroll: { x: 0, y: 100 },
        },
      },
    });
  });

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(ytext.toString()).not.toContain('lens-comment');
});
```

- [ ] **Step 2: Run preview tests to verify RED**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx
```

Expected: FAIL because `placement-requested` is ignored and no composer appears.

- [ ] **Step 3: Import markdown composer UI**

In `HtmlPreview.tsx`, import:

```ts
import { NewCommentCard } from '../CommentMargin/NewCommentCard';
```

Add state:

```ts
interface PendingPreviewComment {
  position: number;
  point: { x: number; y: number };
  scroll: { x: number; y: number };
}

const [pendingComment, setPendingComment] = useState<PendingPreviewComment | null>(null);
const pendingRestoreScrollRef = useRef<{ x: number; y: number } | null>(null);
```

- [ ] **Step 4: Resolve placement without mutating**

Replace direct `placeAndOpen(position)` use in contextual placement with:

```ts
function openComposer(position: number, point: { x: number; y: number }, scroll: { x: number; y: number }) {
  setPendingComment({ position, point, scroll });
  onPlaceComplete?.('');
}
```

For `placement-requested`, validate payload shape, call `scoreCandidates`, then:

```ts
if (candidates.length === 1) {
  openComposer(candidates[0].position, payload.point, payload.scroll);
  return;
}

void verifyByProbe(source, candidates, payload.fingerprint, activeProbeRunner).then(result => {
  if (!isStillCurrent()) return;
  if (result.kind === 'placed') {
    openComposer(result.position, payload.point, payload.scroll);
  } else {
    onManualPlacement?.(result.candidates);
  }
});
```

Keep existing toolbar `click-captured` support, but route successful placements to `openComposer` with point and scroll defaults:

```ts
const fallbackPoint = { x: payload.fingerprint.clickRect.x, y: payload.fingerprint.clickRect.y };
const fallbackScroll = { x: 0, y: 0 };
```

- [ ] **Step 5: Submit and cancel composer**

Render inside the `relative` wrapper:

```tsx
{pendingComment && (
  <NewCommentCard
    onSubmit={(body) => {
      const id = makeCommentId();
      pendingRestoreScrollRef.current = pendingComment.scroll;
      addComment(ytext, origin, {
        id,
        author: currentUser,
        ts: new Date().toISOString(),
        body,
        position: pendingComment.position,
      });
      setPendingComment(null);
      setOpenThreadId(id);
    }}
    onCancel={() => setPendingComment(null)}
    style={{
      position: 'absolute',
      left: Math.max(8, pendingComment.point.x),
      top: Math.max(8, pendingComment.point.y),
      width: 320,
      zIndex: 20,
    }}
  />
)}
```

- [ ] **Step 6: Restore scroll after refresh**

After bridge ready/init or after `srcDoc` updates, post:

```ts
const scroll = pendingRestoreScrollRef.current;
if (scroll) {
  postToBridge(iframe, nonce, { type: 'restore-scroll', payload: scroll });
  pendingRestoreScrollRef.current = null;
}
```

Prefer doing this in the ready-message branch after `init`, because the iframe is ready to receive parent messages then.

- [ ] **Step 7: Run preview tests to verify GREEN**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat: defer HTML preview comment creation"
```

---

## Task 4: Manual Source Fallback Uses The Same Deferred Composer

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`

- [ ] **Step 1: Write failing source coordinate test**

In `HtmlSourceEditor.test.tsx`, update the callback expectation with coordinates:

```tsx
it('calls onClickAtPosition with doc offset and viewport coordinates when armed', () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>abc</p>');
  const awareness = new Awareness(doc);
  const onClick = vi.fn();
  const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

  try {
    const { container } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} onClickAtPosition={onClick} />,
    );
    const editor = container.querySelector('.cm-content') as HTMLElement;

    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));

    expect(onClick).toHaveBeenCalledWith(3, { x: 100, y: 50 });
  } finally {
    posAtCoords.mockRestore();
  }
});
```

- [ ] **Step 2: Write failing HtmlEditor manual fallback test**

In `HtmlEditor.test.tsx`, add:

```tsx
it('manual source placement opens composer and writes root body only on submit', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>click here</p><p>click here</p>');
  const awareness = new Awareness(doc);
  const runner: ProbeRunner = {
    async run() { return null; },
    dispose() {},
  };

  render(<HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={runner} />);
  fireEvent.click(screen.getByRole('button', { name: /comment mode/i }));

  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 10, y: 10, w: 20, h: 20 },
            },
          },
        },
      },
    }));
    await Promise.resolve();
  });

  expect(screen.getByText('Source')).toHaveAttribute('aria-pressed', 'true');
  expect(ytext.toString()).not.toContain('lens-comment');

  const highlighted = document.querySelector('.cm-lens-candidate') as HTMLElement;
  highlighted.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 80 }));

  expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
  expect(ytext.toString()).not.toContain('lens-comment');

  fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
    target: { value: 'manual body' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

  const clusters = parseComments(ytext.toString());
  expect(clusters).toHaveLength(1);
  expect(clusters[0].comment.body).toBe('manual body');
  expect(clusters[0].replies).toEqual([]);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlSourceEditor.test.tsx src/components/HtmlEditor/HtmlEditor.test.tsx
```

Expected: FAIL because source clicks still pass only position and write an empty marker immediately.

- [ ] **Step 4: Pass click coordinates from source editor**

Change prop type:

```ts
onClickAtPosition?: (position: number, point: { x: number; y: number }) => void;
```

Change handler:

```ts
if (pos !== null) handler(pos, { x: event.clientX, y: event.clientY });
```

- [ ] **Step 5: Add manual composer state in HtmlEditor**

Import:

```ts
import { NewCommentCard } from '../CommentMargin/NewCommentCard';
```

Add state:

```ts
const [manualComposer, setManualComposer] = useState<{
  position: number;
  point: { x: number; y: number };
} | null>(null);
```

Clear it where pending candidates are cleared:

```ts
setManualComposer(null);
```

- [ ] **Step 6: Open composer on manual source click**

Replace direct `addComment` in `onClickAtPosition` with:

```ts
onClickAtPosition={(position, point) => {
  if (!activePendingCandidates) return;
  setManualComposer({ position, point });
  pendingSourceRef.current = null;
  setPendingCandidates(null);
}}
```

Render within the source pane wrapper:

```tsx
{manualComposer && (
  <NewCommentCard
    onSubmit={(body) => {
      addComment(ytext, LENS_EDITOR_ORIGIN, {
        id: makeCommentId(),
        author: currentUser,
        ts: new Date().toISOString(),
        body,
        position: manualComposer.position,
      });
      setManualComposer(null);
      setCommentMode(false);
    }}
    onCancel={() => {
      setManualComposer(null);
      setCommentMode(false);
    }}
    style={{
      position: 'absolute',
      top: Math.max(8, manualComposer.point.y),
      left: Math.max(8, manualComposer.point.x),
      width: 320,
      zIndex: 20,
    }}
  />
)}
```

Set the source pane wrapper to `className="relative min-w-0 flex-1"` so absolute positioning is scoped.

- [ ] **Step 7: Run tests to verify GREEN**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlSourceEditor.test.tsx src/components/HtmlEditor/HtmlEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat: defer manual HTML comment placement"
```

---

## Task 5: Toolbar Fallback Stops Creating Empty Root Comments

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`

- [ ] **Step 1: Write failing toolbar tests**

In `HtmlPreview.test.tsx`, adjust the click-to-place test so it expects composer first:

```tsx
it('toolbar click-to-place opens composer before writing marker', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>click here</p>');

  render(
    <HtmlPreview
      ytext={ytext}
      currentUser="me@x"
      origin={Symbol()}
      debounceMs={0}
      isCommentMode
    />
  );
  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

  await act(async () => {
    dispatchFromBridge(iframe, {
      nonce: '__test_nonce__',
      message: {
        type: 'click-captured',
        payload: {
          fingerprint: {
            before: 'click ',
            after: 'here',
            tag: 'p',
            ancestorPath: [],
            clickRect: { x: 20, y: 30, w: 100, h: 20 },
          },
        },
      },
    });
  });

  expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
  expect(ytext.toString()).not.toContain('lens-comment');
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx src/components/HtmlEditor/HtmlEditor.test.tsx
```

Expected: FAIL if any toolbar path still writes immediately or any old test expects empty root comments.

- [ ] **Step 3: Update toolbar click path**

Ensure `click-captured` uses the same `openComposer` path as `placement-requested`. It should not call `addComment` until `NewCommentCard.onSubmit`.

For the toolbar path, keep `onPlaceComplete` firing only after submit:

```ts
onPlaceComplete?.(id);
```

Remove any earlier call that turns off comment mode before the composer is submitted.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx src/components/HtmlEditor/HtmlEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "fix: prevent empty HTML root comments"
```

---

## Task 6: Focused Regression Pass And Manual Smoke

**Files:**
- No source file changes expected unless verification finds a bug.

- [ ] **Step 1: Run focused Vitest suites**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor src/components/CommentMargin src/components/CommentsPanel/AddCommentForm.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```bash
cd lens-editor && npm run build
```

Expected: PASS. Existing Vite large-chunk warnings are acceptable.

- [ ] **Step 3: Run targeted lint**

Run:

```bash
cd lens-editor && npx eslint src/components/HtmlEditor src/components/CommentMargin src/components/CommentsPanel/AddCommentForm.tsx
```

Expected: PASS.

- [ ] **Step 4: Manual smoke**

Start or reuse the ws3 stack:

```bash
./scripts/list-servers
cd lens-editor && npm run dev:local -- --host 0.0.0.0
```

Generate a share link:

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url https://localhost:5373
```

Open the `https://dev.vps:5373/?t=...` URL in Chrome.

Smoke steps:

1. Create a fresh `.html` file.
2. Paste:

```html
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
<h1>Contextual comment smoke</h1>
<p>This paragraph has unique text alpha.</p>
<p>This paragraph has duplicate text beta.</p>
<p>This paragraph has duplicate text beta.</p>
</body></html>
```

3. Right-click the alpha paragraph. Expected: add-comment composer appears; source does not contain `lens-comment` yet.
4. Type `right click comment`, submit. Expected: one `lens-comment` marker exists with body `right click comment`; no empty root comment; dot appears.
5. Select text in one beta paragraph. Expected: add-comment composer appears.
6. Cancel. Expected: no new marker appears.
7. Use toolbar `Comment`, click the other beta paragraph. Expected: composer appears; source does not change until submit.
8. Submit `toolbar comment`. Expected: one new root marker with body `toolbar comment`.
9. Scroll the preview, add another right-click comment. Expected: after submit, preview remains near the same scroll position.

- [ ] **Step 5: Final status**

Run:

```bash
jj st
```

Expected: working copy clean.

If smoke required any fixes, commit them with a targeted message. If no fixes were required, commit nothing.
