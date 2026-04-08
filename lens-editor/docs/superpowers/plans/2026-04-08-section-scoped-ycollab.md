# Section-Scoped yCollab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the decoration-based section editor with a forked yCollab ViewPlugin that syncs only a slice of Y.Text, so CM contains only section text natively.

**Architecture:** `y-section-sync.ts` is a CM6 ViewPlugin that bridges a range `[sectionFrom, sectionTo]` of a Y.Text to a CM instance containing only that range's text. CM → Y.Text offsets positions by `sectionFrom`. Y.Text → CM filters the delta to the section range and offsets by `-sectionFrom`. Section offsets are tracked mutably and updated synchronously in the Y.Text observer.

**Tech Stack:** TypeScript, CodeMirror 6, Yjs, y-codemirror.next (forked ViewPlugin pattern), React, vitest

**Spec:** `docs/superpowers/specs/2026-04-08-section-scoped-ycollab-design.md`

**TDD approach:** Every task writes a failing test first, verifies it fails, writes minimal code to pass, verifies it passes, then commits. Tests use real Y.Doc + real CM EditorView — no mocks. Anti-patterns to avoid: don't test mock behavior, don't add test-only methods to production code, mock only at the slow/external boundary (nothing needs mocking here — Y.Doc and CM are fast in-memory).

---

## File Structure

| File | Purpose |
|------|---------|
| `src/components/SectionEditor/y-section-sync.ts` | Forked yCollab ViewPlugin — bidirectional section-scoped sync |
| `src/components/SectionEditor/y-section-sync.test.ts` | Integration tests for sync (real Y.Doc + real CM) |
| `src/components/SectionEditor/parseSections.ts` | Section parser (reused from prototype, no changes) |
| `src/components/SectionEditor/parseSections.test.ts` | Parser tests (reused from prototype, no changes) |
| `src/components/SectionEditor/SectionEditor.tsx` | React component (rewritten — fresh CM per section, no decorations) |
| `src/components/SectionEditor/index.ts` | Barrel export |
| `src/App.tsx` | Route addition for `/section-editor/:docUuid` |

---

### Task 1: Scaffold files and copy parseSections from prototype

**Files:**
- Restore from prototype (`xruysovz`): `src/components/SectionEditor/parseSections.ts`, `src/components/SectionEditor/parseSections.test.ts`
- Create: `src/components/SectionEditor/index.ts`

- [ ] **Step 1: Restore parseSections files from prototype branch**

```bash
cd /home/penguin/code/lens-relay/ws3
jj restore --from xruysovz -- lens-editor/src/components/SectionEditor/parseSections.ts lens-editor/src/components/SectionEditor/parseSections.test.ts
```

If `jj restore` doesn't work across diverged branches, manually copy:
```bash
mkdir -p lens-editor/src/components/SectionEditor
jj cat -r xruysovz src/components/SectionEditor/parseSections.ts > lens-editor/src/components/SectionEditor/parseSections.ts
jj cat -r xruysovz src/components/SectionEditor/parseSections.test.ts > lens-editor/src/components/SectionEditor/parseSections.test.ts
```

- [ ] **Step 2: Create barrel export**

Create `src/components/SectionEditor/index.ts`:

```ts
export { SectionEditor } from './SectionEditor';
```

- [ ] **Step 3: Run parseSections tests to verify**

Run: `npx vitest run src/components/SectionEditor/parseSections.test.ts`
Expected: 9 tests pass

- [ ] **Step 4: Commit**

```bash
jj describe -m "scaffold: add parseSections and barrel export for section editor"
```

---

### Task 2: y-section-sync — CM → Y.Text sync (TDD)

**Files:**
- Create: `src/components/SectionEditor/y-section-sync.ts`
- Create: `src/components/SectionEditor/y-section-sync.test.ts`

- [ ] **Step 1: Write failing test — CM insert appears in Y.Text at correct offset**

Create `src/components/SectionEditor/y-section-sync.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { ySectionSync } from './y-section-sync';

const FULL_DOC = '# Intro\nHello world.\n\n## Details\nSome details here.\n\n## Conclusion\nThe end.\n';

function setup(sectionFrom: number, sectionTo: number) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('contents');
  ytext.insert(0, FULL_DOC);

  const sectionText = ytext.toString().slice(sectionFrom, sectionTo);
  const view = new EditorView({
    state: EditorState.create({
      doc: sectionText,
      extensions: [ySectionSync(ytext, sectionFrom, sectionTo)],
    }),
    parent: document.body,
  });

  return { ydoc, ytext, view };
}

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

describe('y-section-sync: CM → Y.Text', () => {
  it('insert in CM appears in Y.Text at sectionFrom + offset', () => {
    // Section "## Details\nSome details here.\n\n" starts at index 22
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    // Insert "NEW " after "## Details\n" — offset 11 within section
    const insertOffset = '## Details\n'.length;
    v.dispatch({
      changes: { from: insertOffset, to: insertOffset, insert: 'NEW ' },
    });

    const fullDoc = ytext.toString();
    expect(fullDoc).toContain('## Details\nNEW Some details here.');
    // Other sections untouched
    expect(fullDoc).toContain('# Intro\nHello world.');
    expect(fullDoc).toContain('## Conclusion\nThe end.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: FAIL — `ySectionSync` doesn't exist yet

- [ ] **Step 3: Write minimal implementation — ySectionSync with CM → Y.Text**

Create `src/components/SectionEditor/y-section-sync.ts`:

```ts
import * as Y from 'yjs';
import { Facet, Annotation, type Extension, type StateCommand } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate, type KeyBinding } from '@codemirror/view';

export class YSectionSyncConfig {
  undoManager: Y.UndoManager | null = null;

  constructor(
    public ytext: Y.Text,
    public sectionFrom: number,
    public sectionTo: number,
  ) {}
}

export const ySectionSyncFacet = Facet.define<YSectionSyncConfig, YSectionSyncConfig>({
  combine: (inputs) => inputs[inputs.length - 1],
});

export const ySectionSyncAnnotation = Annotation.define<YSectionSyncConfig>();

class YSectionSyncPlugin {
  private conf: YSectionSyncConfig;
  private observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;

  constructor(private view: EditorView) {
    this.conf = view.state.facet(ySectionSyncFacet);

    this.observer = (_event, _tr) => {
      // Y.Text → CM: implemented in Task 3
    };
    this.conf.ytext.observe(this.observer);
  }

  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    // Skip if this change came from Y.Text → CM sync
    if (update.transactions.some(tr => tr.annotation(ySectionSyncAnnotation) === this.conf)) return;

    const ytext = this.conf.ytext;
    ytext.doc!.transact(() => {
      let adj = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
        const insertText = insert.sliceString(0, insert.length, '\n');
        if (fromA !== toA) {
          ytext.delete(this.conf.sectionFrom + fromA + adj, toA - fromA);
        }
        if (insertText.length > 0) {
          ytext.insert(this.conf.sectionFrom + fromA + adj, insertText);
        }
        adj += insertText.length - (toA - fromA);
      });
      this.conf.sectionTo += adj;
    }, this.conf);
  }

  destroy() {
    this.conf.ytext.unobserve(this.observer);
  }
}

/** Custom undo/redo commands that read from ySectionSyncFacet instead of ySyncFacet */
const sectionUndo: StateCommand = ({ state }) => {
  const conf = state.facet(ySectionSyncFacet);
  return conf.undoManager?.undo() != null || true;
};

const sectionRedo: StateCommand = ({ state }) => {
  const conf = state.facet(ySectionSyncFacet);
  return conf.undoManager?.redo() != null || true;
};

export const ySectionUndoManagerKeymap: KeyBinding[] = [
  { key: 'Mod-z', run: sectionUndo, preventDefault: true },
  { key: 'Mod-y', mac: 'Mod-Shift-z', run: sectionRedo, preventDefault: true },
  { key: 'Mod-Shift-z', run: sectionRedo, preventDefault: true },
];

export function ySectionSync(
  ytext: Y.Text,
  sectionFrom: number,
  sectionTo: number,
  opts?: { undoManager?: Y.UndoManager },
): Extension[] {
  const config = new YSectionSyncConfig(ytext, sectionFrom, sectionTo);
  if (opts?.undoManager) {
    config.undoManager = opts.undoManager;
    opts.undoManager.addTrackedOrigin(config);
  }
  return [
    ySectionSyncFacet.of(config),
    ViewPlugin.fromClass(YSectionSyncPlugin),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test — CM delete removes from Y.Text at correct offset**

Add to the `CM → Y.Text` describe block:

```ts
  it('delete in CM removes from Y.Text at correct offset', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    // Delete "Some " (5 chars starting at offset 11 within section)
    const deleteFrom = '## Details\n'.length;
    const deleteTo = deleteFrom + 'Some '.length;
    v.dispatch({
      changes: { from: deleteFrom, to: deleteTo, insert: '' },
    });

    const fullDoc = ytext.toString();
    expect(fullDoc).toContain('## Details\ndetails here.');
    expect(fullDoc).toContain('# Intro\nHello world.');
  });
```

- [ ] **Step 6: Run to verify it fails (or passes if already covered)**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: Should PASS (implementation already handles deletes). If it fails, fix implementation.

- [ ] **Step 7: Write failing test — origin tracking prevents feedback loop**

Add:

```ts
  it('CM edit does not trigger feedback loop', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    const docBefore = v.state.doc.toString();
    v.dispatch({
      changes: { from: 0, to: 0, insert: 'X' },
    });

    // CM should have "X" prepended, doc length +1
    expect(v.state.doc.toString()).toBe('X' + docBefore);
    expect(v.state.doc.length).toBe(docBefore.length + 1);
    // Y.Text should also have it
    expect(ytext.toString()).toContain('X## Details');
  });
```

- [ ] **Step 8: Run to verify**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: PASS (origin annotation prevents the Y.Text observer from dispatching back)

- [ ] **Step 9: Commit**

```bash
jj describe -m "feat(section-sync): CM → Y.Text sync with offset translation and origin tracking"
jj new
```

---

### Task 3: y-section-sync — Y.Text → CM sync (TDD)

**Files:**
- Modify: `src/components/SectionEditor/y-section-sync.ts` (fill in observer)
- Modify: `src/components/SectionEditor/y-section-sync.test.ts` (add tests)

- [ ] **Step 1: Write failing test — external insert within section appears in CM**

Add a new describe block:

```ts
describe('y-section-sync: Y.Text → CM', () => {
  it('external insert within section appears in CM at correct offset', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    // External insert at absolute position sectionFrom + 11 ("## Details\n" + "REMOTE ")
    const insertPos = sectionFrom + '## Details\n'.length;
    ytext.insert(insertPos, 'REMOTE ');

    expect(v.state.doc.toString()).toContain('REMOTE Some details here.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: FAIL — observer is a no-op stub

- [ ] **Step 3: Implement Y.Text → CM observer**

Replace the observer in the constructor:

```ts
    this.observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === this.conf) return; // skip own changes

      const changes: { from: number; to: number; insert: string }[] = [];
      let pos = 0; // absolute position in full Y.Text

      // pos tracks position in the OLD document (before this event).
      // Yjs delta semantics: retain advances pos (old doc has those chars),
      // delete advances pos (old doc has those chars, being removed),
      // insert does NOT advance pos (old doc doesn't have the new text).
      for (const d of event.delta) {
        if (d.retain != null) {
          pos += d.retain;
        } else if (d.insert != null) {
          const text = typeof d.insert === 'string' ? d.insert : '';
          const len = text.length;

          if (pos < this.conf.sectionFrom) {
            // Insert before section — shift offsets, don't touch CM
            this.conf.sectionFrom += len;
            this.conf.sectionTo += len;
          } else if (pos > this.conf.sectionTo) {
            // Insert after section — ignore
          } else if (pos === this.conf.sectionFrom || pos === this.conf.sectionTo) {
            // Insert at exact boundary — treat as outside section (shift offsets)
            // The boundary char is usually a heading marker or newline separator
            this.conf.sectionFrom += (pos === this.conf.sectionFrom) ? len : 0;
            this.conf.sectionTo += len;
          } else {
            // Insert within section — dispatch to CM
            changes.push({ from: pos - this.conf.sectionFrom, to: pos - this.conf.sectionFrom, insert: text });
            this.conf.sectionTo += len;
          }
          // pos does NOT advance for inserts (old doc doesn't have this text)
        } else if (d.delete != null) {
          const delLen = d.delete;
          const delFrom = pos;
          const delTo = pos + delLen;

          if (delTo <= this.conf.sectionFrom) {
            // Delete entirely before section — shift offsets
            this.conf.sectionFrom -= delLen;
            this.conf.sectionTo -= delLen;
          } else if (delFrom >= this.conf.sectionTo) {
            // Delete entirely after section — ignore
          } else {
            // Delete overlaps section — clip to section bounds
            const clipFrom = Math.max(delFrom, this.conf.sectionFrom);
            const clipTo = Math.min(delTo, this.conf.sectionTo);
            const cmFrom = clipFrom - this.conf.sectionFrom;
            const cmTo = clipTo - this.conf.sectionFrom;
            changes.push({ from: cmFrom, to: cmTo, insert: '' });

            // Adjust section bounds
            const beforeSection = Math.max(0, this.conf.sectionFrom - delFrom);
            this.conf.sectionFrom -= beforeSection;
            this.conf.sectionTo -= (clipTo - clipFrom) + beforeSection;
          }
          pos += delLen; // delete advances pos (old doc had these chars)
        }
      }

      if (changes.length > 0) {
        this.view.dispatch({
          changes,
          annotations: [ySectionSyncAnnotation.of(this.conf)],
        });
      }
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Write failing test — external insert before section shifts offsets, CM unchanged**

Add:

```ts
  it('external insert before section shifts offsets, CM unchanged', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    const cmBefore = v.state.doc.toString();

    // Insert 10 chars at position 0 (before section)
    ytext.insert(0, 'PREPENDED ');

    // CM content unchanged
    expect(v.state.doc.toString()).toBe(cmBefore);
    // But the section in Y.Text is still correct
    expect(ytext.toString().slice(sectionFrom + 10, sectionTo + 10)).toBe(cmBefore);
  });
```

- [ ] **Step 6: Run to verify**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: PASS

- [ ] **Step 7: Write failing test — external insert after section, CM unchanged**

```ts
  it('external insert after section does not affect CM', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    const cmBefore = v.state.doc.toString();
    ytext.insert(ytext.toString().length, '\n## Appendix\nExtra stuff.');

    expect(v.state.doc.toString()).toBe(cmBefore);
  });
```

- [ ] **Step 8: Run to verify**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing test — external delete spanning section start boundary**

```ts
  it('external delete spanning section start boundary clips correctly', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    // Delete from 5 chars before section start into 5 chars of section content
    ytext.delete(sectionFrom - 5, 10);

    // CM should have lost its first 5 chars
    const cmText = v.state.doc.toString();
    expect(cmText.startsWith('## Details')).toBe(false);
    expect(cmText).toContain('details here.');
    // Content before section should have lost 5 chars too
    expect(ytext.toString()).toContain('# Intro');
  });
```

- [ ] **Step 10: Run to verify**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: PASS (or fail if boundary logic needs adjustment — fix and re-run)

- [ ] **Step 11: Write failing test — offset consistency after multiple interleaved edits**

```ts
  it('offsets stay consistent after interleaved local and remote edits', () => {
    const sectionFrom = FULL_DOC.indexOf('## Details');
    const sectionTo = FULL_DOC.indexOf('## Conclusion');
    const { ytext, view: v } = setup(sectionFrom, sectionTo);
    view = v;

    // Local edit: insert in CM
    v.dispatch({ changes: { from: 0, to: 0, insert: 'A' } });
    // Remote edit: insert before section
    ytext.insert(0, 'BBB');
    // Local edit: insert at end of CM doc
    const cmLen = v.state.doc.length;
    v.dispatch({ changes: { from: cmLen, to: cmLen, insert: 'C' } });
    // Remote edit: insert within section
    const conf = v.state.facet(ySectionSyncFacet);
    ytext.insert(conf.sectionFrom + 1, 'D');

    // Verify full Y.Text is coherent
    const fullDoc = ytext.toString();
    expect(fullDoc).toContain('BBB');
    expect(fullDoc).toContain('# Intro');
    expect(fullDoc).toContain('The end.');

    // Verify CM contains the section content including all edits
    const cmText = v.state.doc.toString();
    expect(cmText).toContain('A');
    expect(cmText).toContain('D');
    expect(cmText).toContain('C');

    // Verify the section slice in Y.Text matches CM
    expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo)).toBe(cmText);
  });
```

- [ ] **Step 12: Run full test suite**

Run: `npx vitest run src/components/SectionEditor/y-section-sync.test.ts`
Expected: All tests PASS

- [ ] **Step 13: Commit**

```bash
jj describe -m "feat(section-sync): Y.Text → CM sync with delta filtering and offset tracking"
jj new
```

---

### Task 4: SectionEditor React component

**Files:**
- Create: `src/components/SectionEditor/SectionEditor.tsx`

- [ ] **Step 1: Write the SectionEditor component**

Create `src/components/SectionEditor/SectionEditor.tsx`:

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { parseSections, type Section } from './parseSections';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';

interface SectionEditorProps {
  onOpenInEditor?: () => void;
}

function SectionCard({ section, onClick }: { section: Section; onClick: () => void }) {
  const colors: Record<string, string> = {
    frontmatter: 'bg-gray-50 border-gray-200',
    video: 'bg-purple-50 border-purple-200',
    text: 'bg-blue-50 border-blue-200',
    chat: 'bg-green-50 border-green-200',
    'lens-ref': 'bg-indigo-50 border-indigo-200',
    'test-ref': 'bg-amber-50 border-amber-200',
    'lo-ref': 'bg-rose-50 border-rose-200',
  };
  const lines = section.content.split('\n');
  const body = (section.type === 'frontmatter' ? lines.slice(1, -2) : lines.slice(1))
    .join('\n').trim();

  return (
    <div
      className={`rounded-lg border ${colors[section.type] || 'bg-white border-gray-200'} cursor-pointer hover:ring-1 hover:ring-blue-300 transition-all`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit">
        <span className="font-medium text-sm text-gray-700">{section.label}</span>
        <span className="text-xs text-gray-400 ml-auto">click to edit</span>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 whitespace-pre-wrap max-h-40 overflow-hidden">
        {body ? (body.length > 300 ? body.slice(0, 300) + '...' : body) : <em className="text-gray-400">Empty</em>}
      </div>
    </div>
  );
}

export function SectionEditor({ onOpenInEditor }: SectionEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ydoc = useYDoc();
  const provider = useYjsProvider();

  const [synced, setSynced] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Sync detection
  useEffect(() => {
    if ((provider as any).synced) { setSynced(true); return; }
    const onSync = () => setSynced(true);
    provider.on('synced', onSync);
    const ytext = ydoc.getText('contents');
    const poll = setInterval(() => {
      if (ytext.length > 0) { setSynced(true); clearInterval(poll); }
    }, 200);
    return () => { provider.off('synced', onSync); clearInterval(poll); };
  }, [provider, ydoc]);

  // Observe Y.Text to keep section list in sync
  useEffect(() => {
    if (!synced) return;
    const ytext = ydoc.getText('contents');
    const update = () => setSections(parseSections(ytext.toString()));
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ydoc, synced]);

  // Create/destroy CM when activeIndex changes
  useEffect(() => {
    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    if (activeIndex === null || !mountRef.current) return;

    const ytext = ydoc.getText('contents');
    const currentSections = parseSections(ytext.toString());
    const section = currentSections[activeIndex];
    if (!section) return;

    const sectionText = ytext.toString().slice(section.from, section.to);
    const undoManager = new Y.UndoManager(ytext, { captureTimeout: 500 });

    const view = new EditorView({
      state: EditorState.create({
        doc: sectionText,
        extensions: [
          indentUnit.of('\t'),
          EditorState.tabSize.of(4),
          drawSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...ySectionUndoManagerKeymap]),
          markdown({ base: markdownLanguage, addKeymap: false }),
          ySectionSync(ytext, section.from, section.to, { undoManager }),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '14px', outline: 'none' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': {
              fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            },
            '.cm-content': { padding: '12px 16px' },
            '.cm-gutters': { display: 'none' },
          }),
        ],
      }),
      parent: mountRef.current,
    });

    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeIndex, ydoc]);

  const deactivate = useCallback(() => setActiveIndex(null), []);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      {!synced ? (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          Connecting to document...
        </div>
      ) : (<>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800">Section Editor</h2>
          {onOpenInEditor && (
            <button onClick={onOpenInEditor}
              className="text-xs px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded">
              Open in full editor
            </button>
          )}
        </div>

        <div className="space-y-3">
          {sections.map((section, i) => (
            <div key={i}>
              {activeIndex === i ? (
                <div className="rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                    <span className="font-medium text-sm text-blue-700">{section.label}</span>
                    <button onClick={deactivate}
                      className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                      Done
                    </button>
                  </div>
                  <div ref={mountRef} style={{ minHeight: '60px' }} />
                </div>
              ) : (
                <SectionCard section={section} onClick={() => setActiveIndex(i)} />
              )}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}
```

Note: Task 2's `ySectionSync` already has the `opts` parameter and `ySectionUndoManagerKeymap` export. No changes needed to `y-section-sync.ts` in this task.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to SectionEditor

- [ ] **Step 3: Commit**

```bash
jj describe -m "feat(section-editor): SectionEditor component with fresh CM per section"
jj new
```

---

### Task 5: App.tsx route + integration test

**Files:**
- Modify: `src/App.tsx` (add import + route + SectionEditorView wrapper)

- [ ] **Step 1: Add import**

At `src/App.tsx:20` (after AddVideoPage import), add:

```ts
import { SectionEditor } from './components/SectionEditor';
```

- [ ] **Step 2: Add SectionEditorView wrapper function**

Before the `DocumentView` function (around line 150), add:

```tsx
/**
 * Section editor view — reads docUuid from URL, wraps SectionEditor with RelayProvider.
 */
function SectionEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  const shortCompoundId = docUuid ? `${RELAY_ID}-${docUuid}` : '';
  const activeDocId = useResolvedDocId(shortCompoundId, metadata);

  if (!docUuid) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide a document UUID: /section-editor/:docUuid</p>
      </main>
    );
  }

  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving document...</div>
      </main>
    );
  }

  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <SectionEditor onOpenInEditor={() => navigate(`/${docUuid}`)} />
    </RelayProvider>
  );
}
```

- [ ] **Step 3: Add route**

After the `/review` route (around line 404), add:

```tsx
<Route path="/section-editor/:docUuid" element={<SectionEditorView />} />
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile

- [ ] **Step 5: Run all section editor tests**

Run: `npx vitest run src/components/SectionEditor/`
Expected: All parseSections tests (9) + all y-section-sync tests pass

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat(section-editor): add route and SectionEditorView wrapper in App.tsx"
jj new
```

---

### Task 6: Manual browser smoke test

**Files:** None (testing only)

- [ ] **Step 1: Start servers**

```bash
cd /home/penguin/code/lens-relay/ws3
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8290 > /tmp/ws3-relay.log 2>&1 &
cd lens-editor && npm run dev:local > /tmp/ws3-vite.log 2>&1 &
```

- [ ] **Step 2: Populate test data and generate share link**

```bash
cd lens-editor && npm run relay:setup
npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://dev.vps:5373
```

- [ ] **Step 3: Open section editor in browser**

Navigate to the share link, then go to `/section-editor/c0000008`. Verify:
- Sections render as cards
- Clicking a section opens a CM editor with only that section's text
- Typing works
- Ctrl+A Delete works (deletes only section content)
- Clicking "Done" closes the editor
- Switching sections works
- Other sections' card previews remain correct

- [ ] **Step 4: Commit final state**

```bash
jj describe -m "feat(section-editor): section-scoped yCollab sync — complete prototype"
```
