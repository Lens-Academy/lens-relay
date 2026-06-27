/**
 * Regression: in a production-shaped render (no StrictMode), CommentsLayer
 * must attach its scroll listener to the editor's scrollDOM. The previous
 * implementation populated scrollContainerRef inside a useEffect, which runs
 * after children's mount effects — so CommentsLayer's listener-attach effect
 * read `null` and bailed. Dev's StrictMode double-invoke hid the bug; prod
 * builds skip the second invocation so the listener never attached and the
 * comments sidebar stopped reflowing on scroll.
 *
 * This test renders WITHOUT StrictMode (matching prod) and asserts that a
 * scroll listener is attached to the live CodeMirror scrollDOM after mount.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { useMemo, useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView } from '@codemirror/view';
import { AuthProvider } from '../../contexts/AuthContext';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { NavigationContext } from '../../contexts/NavigationContext';

const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);

vi.mock('@y-sweet/react', () => {
  const provider = {
    awareness,
    synced: true,
    on: (event: string, cb: () => void) => {
      if (event === 'synced') queueMicrotask(cb);
    },
    off: () => {},
  };
  return { useYDoc: () => ydoc, useYjsProvider: () => provider };
});

vi.mock('../DiscussionPanel', () => ({ ConnectedDiscussionPanel: () => null }));
vi.mock('../DiscussionPanel/useHasDiscussion', () => ({ useHasDiscussion: () => false }));
vi.mock('../Editor/extensions/harper', () => ({ harperLinter: [], updateHarperFolder: () => {} }));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function NavigationStub({ children }: { children: ReactNode }) {
  const justCreatedRef = useRef(false);
  const value = useMemo(
    () => ({
      metadata: {},
      folderDocs: new Map<string, Y.Doc>(),
      folderNames: [] as string[],
      errors: new Map<string, Error>(),
      onNavigate: () => {},
      justCreatedRef,
    }),
    [],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

describe('EditorArea — scroll listener attaches without StrictMode', () => {
  afterEach(() => {
    cleanup();
    const ytext = ydoc.getText('contents');
    ytext.delete(0, ytext.length);
  });

  it("attaches CommentsLayer's scroll listener to the editor's scrollDOM on first mount", async () => {
    // Record every addEventListener call so we can later verify a 'scroll'
    // listener landed on the same DOM node CodeMirror uses as its scrollDOM.
    const calls: Array<{ target: EventTarget; type: string }> = [];
    // Patch both EventTarget and HTMLElement prototypes; happy-dom's class
    // chain may shadow EventTarget.prototype on HTMLElement subclasses.
    const targets: Array<{ proto: object; orig: typeof EventTarget.prototype.addEventListener }> = [];
    for (const proto of [EventTarget.prototype, HTMLElement.prototype]) {
      const orig = (proto as { addEventListener: typeof EventTarget.prototype.addEventListener }).addEventListener;
      (proto as { addEventListener: typeof EventTarget.prototype.addEventListener }).addEventListener = function (
        this: EventTarget,
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        opts?: AddEventListenerOptions | boolean,
      ) {
        calls.push({ target: this, type });
        return orig.call(this, type, handler, opts);
      };
      targets.push({ proto, orig });
    }

    try {
      const { EditorArea } = await import('./EditorArea');
      // NOTE: no <StrictMode>. Matches the production runtime.
      render(
        <MemoryRouter>
          <AuthProvider role="edit" folderUuid={null} isAllFolders>
            <DisplayNameProvider>
              <NavigationStub>
                <EditorArea currentDocId="test-doc" />
              </NavigationStub>
            </DisplayNameProvider>
          </AuthProvider>
        </MemoryRouter>,
      );

      const editorEl = await waitFor(() => {
        const el = document.querySelector('.cm-editor') as HTMLElement | null;
        if (!el) throw new Error('CodeMirror editor not mounted yet');
        return el;
      });
      const view = EditorView.findFromDOM(editorEl);
      if (!view) throw new Error('EditorView.findFromDOM returned null');

      const scrollDOM = view.scrollDOM;
      // Wait for the listener to be observed (CommentsLayer's effect runs on
      // commit after the editor mounts).
      await waitFor(() => {
        const found = calls.some((c) => c.target === scrollDOM && c.type === 'scroll');
        if (!found) {
          const allScroll = calls.filter((c) => c.type === 'scroll').map((c) => {
            const t = c.target as HTMLElement;
            return t.className || t.tagName || String(c.target);
          });
          const layerKids = document.querySelectorAll('[id="comment-margin"] *').length;
          const commentCards = document.querySelectorAll('[data-comment-thread]').length;
          throw new Error(
            `no scroll listener. all 'scroll' targets: ${JSON.stringify(allScroll)}. comment-margin descendants: ${layerKids}. comment cards: ${commentCards}. scrollDOM cls: ${(scrollDOM as HTMLElement).className}`,
          );
        }
      });

      // At least one of the listeners on the scrollDOM is from CommentsLayer
      // (CodeMirror attaches its own, but CommentsLayer should add a second).
      const scrollListenerCount = calls.filter(
        (c) => c.target === scrollDOM && c.type === 'scroll',
      ).length;
      expect(scrollListenerCount).toBeGreaterThanOrEqual(2);
    } finally {
      for (const { proto, orig } of targets) {
        (proto as { addEventListener: typeof EventTarget.prototype.addEventListener }).addEventListener = orig;
      }
    }
  });
});
