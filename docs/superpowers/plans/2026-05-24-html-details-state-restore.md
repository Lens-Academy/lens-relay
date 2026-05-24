# HTML Details State Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve expanded/collapsed `<details>` state across HTML preview iframe reloads.

**Architecture:** Keep the current iframe `srcdoc` replacement architecture. Before replacing the active iframe, ask its bridge to report a small UI-state snapshot containing structural paths for open `<details>` elements; after the replacement iframe is ready, send that snapshot back so the bridge reapplies `open` to matching `<details>` nodes. This first version is intentionally path-only and only supports `<details>`.

**Tech Stack:** React, TypeScript, iframe postMessage bridge, Vitest + Testing Library.

---

### Task 1: Add Bridge Protocol For Details UI State

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/protocol.ts`

- [ ] **Step 1: Add the protocol types**

Add these exported interfaces near the scroll state interfaces:

```ts
export interface DetailsStateItem {
  path: number[];
  open: boolean;
}

export interface PreviewUiState {
  details: DetailsStateItem[];
}
```

Extend `ParentToBridge`:

```ts
| { type: 'capture-ui-state'; payload: Record<string, never> }
| { type: 'restore-ui-state'; payload: PreviewUiState }
```

Extend `BridgeToParent`:

```ts
| { type: 'ui-state'; payload: PreviewUiState }
```

- [ ] **Step 2: Run protocol tests**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/protocol.test.ts
```

Expected: tests pass.

---

### Task 2: Implement Details Capture And Restore In The Bridge

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Test: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts`

- [ ] **Step 1: Write failing bridge tests**

Add one test that initializes the bridge on HTML with two `<details>`, opens the second one, dispatches `capture-ui-state`, and expects a `ui-state` message:

```ts
it('captures details open state by structural path', () => {
  document.body.innerHTML = '<details><summary>A</summary></details><details open><summary>B</summary></details>';
  postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(
    ((env: Envelope<BridgeToParent>) => { sent.push(env); }) as typeof window.parent.postMessage,
  );
  const cleanup = installBridge(window as Window & typeof globalThis);
  cleanups.push(cleanup);

  dispatchToBridge({ type: 'init', payload: { comments: [] } });
  dispatchToBridge({ type: 'capture-ui-state', payload: {} });

  const state = sent.find(e => e.message.type === 'ui-state');
  expect(state?.message).toMatchObject({
    type: 'ui-state',
    payload: { details: [{ path: [1], open: true }] },
  });
});
```

Add one test that restores an open state onto matching structural path:

```ts
it('restores details open state by structural path', () => {
  document.body.innerHTML = '<details><summary>A</summary></details><details><summary>B</summary></details>';
  postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(
    ((env: Envelope<BridgeToParent>) => { sent.push(env); }) as typeof window.parent.postMessage,
  );
  const cleanup = installBridge(window as Window & typeof globalThis);
  cleanups.push(cleanup);

  dispatchToBridge({ type: 'init', payload: { comments: [] } });
  dispatchToBridge({ type: 'restore-ui-state', payload: { details: [{ path: [1], open: true }] } });

  const details = Array.from(document.querySelectorAll('details')) as HTMLDetailsElement[];
  expect(details[0].open).toBe(false);
  expect(details[1].open).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts -t "details open state"
```

Expected: FAIL because the bridge does not yet handle `capture-ui-state` or `restore-ui-state`.

- [ ] **Step 3: Implement path-only details helpers**

In `bridge-script.ts`, add helpers near the other DOM helpers:

```ts
function captureUiState(doc: Document): PreviewUiState {
  const details = Array.from(doc.querySelectorAll('details')) as HTMLDetailsElement[];
  return {
    details: details
      .map((node, index) => ({ path: [index], open: node.open }))
      .filter(item => item.open),
  };
}

function restoreUiState(doc: Document, state: PreviewUiState): void {
  const details = Array.from(doc.querySelectorAll('details')) as HTMLDetailsElement[];
  for (const item of state.details) {
    const index = item.path[0];
    if (!Number.isInteger(index)) continue;
    const node = details[index];
    if (!node) continue;
    node.open = item.open;
  }
}
```

Import/use `PreviewUiState` from `protocol.ts`.

- [ ] **Step 4: Wire message handling**

In the bridge message switch:

```ts
case 'capture-ui-state':
  if (!isEmptyObjectPayload(msg.payload)) return;
  postToParent({ type: 'ui-state', payload: captureUiState(doc) });
  break;
case 'restore-ui-state':
  if (!isObject(msg.payload) || !Array.isArray(msg.payload.details)) return;
  restoreUiState(doc, msg.payload as PreviewUiState);
  break;
```

- [ ] **Step 5: Run bridge tests**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts
```

Expected: all tests pass.

---

### Task 3: Capture State Before Replacing The Active Iframe

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Test: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`

- [ ] **Step 1: Write failing preview test**

Add a test that renders first HTML, simulates the active frame reporting open details state, edits the source, promotes the replacement frame, and expects the parent to send `restore-ui-state` to the replacement:

```ts
it('restores details UI state to replacement iframe after source changes', async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<details><summary>A</summary></details><details><summary>B</summary></details>');

  const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
  const activeFrame = container.querySelector('iframe[data-preview-frame-state="active"]') as HTMLIFrameElement;

  const activeSpy = vi.spyOn(activeFrame.contentWindow!, 'postMessage').mockImplementation(() => {});

  await act(async () => {
    ytext.insert(ytext.length, 'x');
    vi.advanceTimersByTime(0);
  });

  expect(activeSpy).toHaveBeenCalledWith(expect.objectContaining({
    message: { type: 'capture-ui-state', payload: {} },
  }), '*');

  dispatchFromBridge(activeFrame, {
    nonce: '__test_nonce__',
    message: { type: 'ui-state', payload: { details: [{ path: [1], open: true }] } },
  });

  const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
  const replacementSpy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(() => {});

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '', message: { type: 'ready', payload: {} } },
      source: replacementFrame.contentWindow,
    }));
  });

  expect(replacementSpy).toHaveBeenCalledWith(expect.objectContaining({
    message: { type: 'restore-ui-state', payload: { details: [{ path: [1], open: true }] } },
  }), '*');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx -t "restores details UI state"
```

Expected: FAIL because no UI state capture/restore messages are sent.

- [ ] **Step 3: Store pending UI state in HtmlPreview**

Import `PreviewUiState`. Add refs:

```ts
const lastUiStateRef = useRef<PreviewUiState | null>(null);
const pendingUiStateRestoreRef = useRef<PreviewUiState | null>(null);
```

When creating a replacement iframe in the `debounced` effect, before `setFrames`, ask the active frame to capture UI state:

```ts
const activeIframe = frameRefs.current.get(activeFrameIdRef.current);
postToBridge(activeIframe ?? null, nonce, { type: 'capture-ui-state', payload: {} });
```

When receiving `ui-state` from the active frame, store it:

```ts
lastUiStateRef.current = message.payload;
pendingUiStateRestoreRef.current = message.payload;
```

- [ ] **Step 4: Restore UI state on replacement init**

Inside `initializeFrame(frame)`, after sending `init` and before/near scroll restore, send:

```ts
const uiState = pendingUiStateRestoreRef.current ?? lastUiStateRef.current;
if (uiState) {
  postToFrame(frame.id, { type: 'restore-ui-state', payload: uiState });
}
```

Clear `pendingUiStateRestoreRef.current` when the frame is activated, similar to pending scroll restore.

- [ ] **Step 5: Run preview test**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor/HtmlPreview.test.tsx -t "restores details UI state"
```

Expected: PASS.

---

### Task 4: Verify End To End

**Files:**
- Verify only.

- [ ] **Step 1: Run HtmlEditor tests**

Run:

```bash
cd lens-editor && npm run test:run -- src/components/HtmlEditor
```

Expected: all tests pass.

- [ ] **Step 2: Run build**

Run:

```bash
cd lens-editor && npm run build
```

Expected: build exits 0. Existing large chunk warnings are acceptable.

- [ ] **Step 3: Manual DevTools check**

Open:

```text
https://dev.vps:5373/84e4c86a/Relay-Folder-1/chat-session-test.html
```

Manual steps:
1. Expand the second `<details>` section.
2. Add one character in the source or add a marker/comment inside that expanded section.
3. Confirm the preview refreshes with that same second `<details>` still expanded.

- [ ] **Step 4: Check jj status**

Run:

```bash
jj st
```

Expected: only the intended files are modified.
