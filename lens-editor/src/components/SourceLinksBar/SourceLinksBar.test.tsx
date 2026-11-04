import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EditorView } from '@codemirror/view';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { readLinkOffers, readSeenLinkOffers, dismissLinkOffers } from '../../lib/link-offers';
import { FakeSourceServer } from './fake-source-server.test-helper';
import { DONE_CLEARS_MS, POLL_MS, SCAN_DEBOUNCE_MS } from './source-links-session';
import { SourceLinksBar } from './SourceLinksBar';
import type { SourceLinkMenuTarget } from './sourceLinkMenu';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

const yjs = vi.hoisted(() => ({ doc: undefined as unknown, awareness: undefined as unknown, isMobile: false }));

vi.mock('../../lib/ydoc-provider', () => ({
  useYDoc: () => yjs.doc,
  useYjsProvider: () => ({ awareness: yjs.awareness }),
}));
vi.mock('../../contexts/MobileContext', () => ({ useMobile: () => ({ isMobile: yjs.isMobile }) }));
vi.mock('../../lib/relay-api', () => ({
  relayHeaders: (extra?: Record<string, string>) => ({ ...extra, 'X-Share-Token': 'token' }),
}));

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const C = 'https://example.com/c';
const REGION = { name: 'Sources on this page' };

let server: FakeSourceServer;

function docWith(text = ''): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  return doc;
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function links(count: number): string {
  return Array.from({ length: count }, (_, i) => `https://example.com/${i}`).join('\n\n');
}

const menuTarget: RefObject<SourceLinkMenuTarget | null> = { current: null };

/** The library copy of A, as the folder metadata has it. */
const METADATA = {
  '/Lens Edu/articles/a.md': { id: 'a0000000-0000-4000-8000-00000000000a', type: 'markdown', version: 0 },
} as unknown as FolderMetadata;

/** Where the editor's caret is on screen, for the bar to keep off it. */
const editor = { caret: null as { top: number; bottom: number } | null };

/** The editor's scroller: a real element, so the bar can follow its scrolling. */
const scroller = document.createElement('div');
scroller.getBoundingClientRect = () => ({ bottom: 600 }) as DOMRect;

/** Something standing in for the editor above the bar. */
const editorView = {
  focus: () => document.querySelector<HTMLElement>('[data-testid=page]')?.focus(),
  hasFocus: true,
  // Past the end of every page here: a caret on a bare URL holds it back
  // A document never in step with the Y.Text, so swaps here go to the server;
  // localSwap.test.ts has the real editor
  state: { selection: { main: { head: 1_000_000 } }, doc: { length: -1 } },
  scrollDOM: scroller,
  coordsAtPos: () => editor.caret,
  requestMeasure({ read, write }: { read: (view: EditorView) => number; write: (value: number) => void }) {
    write(read(this as unknown as EditorView));
  },
} as unknown as EditorView;

function Page({ docId }: { docId: string }) {
  return (
    <>
      <textarea data-testid="page" />
      <SourceLinksBar
        docId={docId}
        path="/Lens/Notes/page.md"
        canImport
        metadata={METADATA}
        editorView={editorView}
        menuTargetRef={menuTarget}
      />
    </>
  );
}

async function mount(doc: Y.Doc, docId = 'relay-doc-1') {
  yjs.doc = doc;
  const view = render(
    <DisplayNameProvider>
      <Page docId={docId} />
    </DisplayNameProvider>,
  );
  await pass(0);
  return view;
}

const region = () => screen.getByRole('region', REGION);
const queryRegion = () => screen.queryByRole('region', REGION);
const bar = () => within(region());
const buttons = () => bar().getAllByRole('button').map((button) => button.textContent);
const page = () => screen.getByTestId('page');

function click(name: string) {
  fireEvent.click(bar().getByRole('button', { name }));
}

async function clickAndWait(name: string) {
  click(name);
  await pass(0);
}

const user = () => userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  vi.useFakeTimers();
  // Testing Library drives fake timers through this global, whatever set them
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  localStorage.clear();
  editor.caret = null;
  server = new FakeSourceServer();
  server.install();
  yjs.isMobile = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('every state in the table', () => {
  it('Offer, all new', async () => {
    await mount(docWith(`${A} and ${B} and ${C}`));
    expect(bar().getByText("3 sources on this page aren't in the library yet.")).toBeInTheDocument();
    expect(buttons()).toEqual(['Import and link', 'Choose', 'Dismiss', '×']);
  });

  it('Offer, one', async () => {
    await mount(docWith(`See ${A}`));
    expect(bar().getByText("example.com/a isn't in the library yet.")).toBeInTheDocument();
    expect(buttons()).toEqual(['Import and link', 'Dismiss', '×']);
  });

  it('Offer, all in library', async () => {
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    server.set(B, { state: 'library', path: 'Lens/articles/b.md' });
    await mount(docWith(`${A} and ${B}`));
    expect(bar().getByText('2 sources on this page are already in the library.')).toBeInTheDocument();
    expect(buttons()).toEqual(['Use library copies', 'Choose', 'Dismiss', '×']);
  });

  it('Offer, mixed', async () => {
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await mount(docWith(`${A} ${B} ${C} https://example.com/d`));
    expect(bar().getByText('4 sources on this page: 1 is in the library, 3 can be imported.')).toBeInTheDocument();
    expect(buttons()).toEqual(['Import and link', 'Choose', 'Dismiss', '×']);
  });

  it('Offer, more than 10 new', async () => {
    await mount(docWith(links(34)));
    expect(bar().getByText("34 sources on this page aren't in the library yet.")).toBeInTheDocument();
    expect(buttons()).toEqual(['Choose', 'Dismiss', '×']);
    expect(bar().getByRole('button', { name: 'Choose' }).className).toContain('bg-blue-600');
  });

  it('a stub is one more that can be imported', async () => {
    server.set(A, { state: 'stub', path: 'Lens/articles/a.md' });
    await mount(docWith(`See ${A}`));
    expect(bar().getByText("example.com/a isn't in the library yet.")).toBeInTheDocument();
  });

  it('Working', async () => {
    await mount(docWith(`${A} and ${B}`));
    await clickAndWait('Import and link');
    expect(bar().getByText('Importing 2 sources, about 8 min. You can keep working or close this page.')).toBeInTheDocument();
    expect(buttons()).toEqual(['Details', 'Stop', '×']);
  });

  it('Done, clearing after 8 seconds', async () => {
    const doc = docWith(`${A} and ${B}`);
    await mount(doc);
    await clickAndWait('Import and link');
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    server.set(B, { state: 'library', path: 'Lens/articles/b.md' });
    act(() => {
      const text = doc.getText('contents');
      text.delete(0, text.length);
      text.insert(0, '[[a]] and [[b]]');
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(bar().getByText('2 sources imported and linked.')).toBeInTheDocument();
    expect(buttons()).toEqual(['×']);

    await pass(DONE_CLEARS_MS - 1);
    expect(queryRegion()).toBeInTheDocument();
    await pass(1);
    expect(queryRegion()).not.toBeInTheDocument();
  });

  it('Failed', async () => {
    server.set(A, { state: 'failed', job_id: 'j1', error: 'Timed out' });
    await mount(docWith(`See ${A}`));
    expect(bar().getByText("1 source couldn't be imported.")).toBeInTheDocument();
    expect(buttons()).toEqual(['Retry', 'Details', 'Dismiss', '×']);
  });

  it('shows no bar on a page with nothing to say', async () => {
    await mount(docWith('Just writing.'));
    expect(queryRegion()).not.toBeInTheDocument();
  });
});

describe('the actions', () => {
  it('Import and link sends everything on offer', async () => {
    await mount(docWith(`${A} and ${B}`));
    await clickAndWait('Import and link');
    expect(server.imports[0].urls).toEqual([A, B]);
  });

  it('Use library copies links what is in the library', async () => {
    server.importRows.set(A, { status: 'linked' });
    server.importRows.set(B, { status: 'linked' });
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    server.set(B, { state: 'library', path: 'Lens/articles/b.md' });
    await mount(docWith(`${A} and ${B}`));
    click('Use library copies');
    expect(bar().getByText('Linking 2 sources.')).toBeInTheDocument();
    await pass(0);
    expect(bar().getByText('2 sources linked.')).toBeInTheDocument();
  });

  it('Dismiss writes the listed URLs for everyone and sends nothing', async () => {
    const doc = docWith(`${A} and ${B}`);
    await mount(doc);
    click('Dismiss');
    expect(queryRegion()).not.toBeInTheDocument();
    expect([...readLinkOffers(doc).keys()]).toEqual([A, B]);
    expect(server.imports).toEqual([]);
  });

  it('a dismissal from someone else clears the bar here', async () => {
    const doc = docWith(`See ${A}`);
    await mount(doc);
    act(() => dismissLinkOffers(doc, [A], 'Sam'));
    expect(queryRegion()).not.toBeInTheDocument();
  });

  it('a dismissal survives remounting', async () => {
    const doc = docWith(`See ${A}`);
    await mount(doc);
    click('Dismiss');
    cleanup();

    await mount(doc);
    expect(queryRegion()).not.toBeInTheDocument();
  });

  it('dismissing a failure writes it for everyone', async () => {
    server.set(A, { state: 'failed', job_id: 'j1' });
    const doc = docWith(`See ${A}`);
    await mount(doc);
    click('Dismiss');
    expect(queryRegion()).not.toBeInTheDocument();
    expect(readLinkOffers(doc).has(A)).toBe(true);
  });

  it('Stop cancels, and does not offer it again straight away', async () => {
    await mount(docWith(`See ${A}`));
    await clickAndWait('Import and link');
    await clickAndWait('Stop');
    expect(server.cancels).toEqual([[`job:${A}`]]);
    expect(queryRegion()).not.toBeInTheDocument();
    expect([...readSeenLinkOffers('relay-doc-1')]).toEqual([A]);
  });

  it('Retry goes back to work', async () => {
    server.set(A, { state: 'failed', job_id: 'j1' });
    await mount(docWith(`See ${A}`));
    server.set(A, { state: 'queued', job_id: 'j1-again', eta_minutes: 5 });
    await clickAndWait('Retry');
    expect(server.retries).toEqual(['j1']);
    expect(bar().getByText(/^Importing 1 source, about \d+ min\./)).toBeInTheDocument();
    await pass(POLL_MS);
    expect(bar().getByText('Importing 1 source, about 5 min. You can keep working or close this page.')).toBeInTheDocument();
  });

  it('reopening a page shows a running import', async () => {
    server.set(A, { state: 'importing', job_id: 'j1', eta_minutes: 6 });
    await mount(docWith(`See ${A}`));
    expect(bar().getByText('Importing 1 source, about 6 min. You can keep working or close this page.')).toBeInTheDocument();
    expect(buttons()).toEqual(['Details', 'Stop', '×']);
  });

  it('the right-click shows Working and takes the dismissal back', async () => {
    const doc = docWith(`See ${A}`);
    dismissLinkOffers(doc, [A], 'Sam');
    await mount(doc);
    expect(queryRegion()).not.toBeInTheDocument();

    act(() => menuTarget.current?.importSource(A));
    expect(bar().getByText(/^Importing 1 source/)).toBeInTheDocument();
    await pass(0);
    expect(readLinkOffers(doc).has(A)).toBe(false);
    expect(server.imports[0].urls).toEqual([A]);
  });
});

describe('Choose', () => {
  async function openChoose(text: string) {
    const doc = docWith(text);
    await mount(doc);
    click('Choose');
    return doc;
  }

  it('opens in place, as a list and not a dialog, and toggles', async () => {
    await openChoose(`${A} and ${B}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const toggle = bar().getByRole('button', { name: 'Choose' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(bar().getAllByRole('listitem')).toHaveLength(2);
    expect(bar().getByRole('list').className).toContain('max-h-[40vh]');
    expect(bar().getByRole('list').className).toContain('overflow-y-auto');
    click('Choose');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
  });

  it('has a tick box, label, tag and open link on each row, all ticked to start', async () => {
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', title: 'The A Paper' });
    server.set(B, { kind: 'video' });
    await openChoose(`${A} and ${B} and ${C}`);
    const [first, second, third] = bar().getAllByRole('listitem');

    expect(within(first).getByRole('checkbox', { name: /The A Paper/ })).toBeChecked();
    expect(within(first).getByText('In library')).toBeInTheDocument();
    expect(within(second).getByRole('checkbox', { name: /example.com\/b/ })).toBeChecked();
    expect(within(second).getByText('Video')).toBeInTheDocument();
    expect(within(third).getByRole('checkbox', { name: /example.com\/c/ })).toBeChecked();
    expect(within(third).queryByText(/In library|Video/)).not.toBeInTheDocument();

    const open = within(third).getByRole('link', { name: 'Open example.com/c' });
    expect(open).toHaveAttribute('href', C);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('gives the live count and estimate', async () => {
    await openChoose(`${A} and ${B} and ${C}`);
    expect(bar().getByRole('button', { name: 'Import and link 3' })).toBeInTheDocument();
    expect(bar().getByText('about 8 min')).toBeInTheDocument(); // 4 min × ceil(3 / 2)

    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/c/ }));
    expect(bar().getByRole('button', { name: 'Import and link 2' })).toBeInTheDocument();
    expect(bar().getByText('about 4 min')).toBeInTheDocument();
  });

  it('adds what is queued ahead', async () => {
    server.queue = { workers: 1, avg_job_minutes: 10, queued: 7, processing: 1 };
    await openChoose(`${A} and ${B}`);
    expect(bar().getByText('about 1 h 30 min')).toBeInTheDocument();
  });

  it('needs no estimate for sources in the library, and says so if only those are ticked', async () => {
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await openChoose(`${A} and ${B}`);
    expect(bar().getByRole('button', { name: 'Import and link 2' })).toBeInTheDocument();
    expect(bar().getByText('about 4 min')).toBeInTheDocument();

    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/b/ }));
    expect(bar().getByRole('button', { name: 'Use 1 library copy' })).toBeInTheDocument();
    expect(bar().queryByText(/^about/)).not.toBeInTheDocument();
  });

  it('cannot accept nothing', async () => {
    await openChoose(`${A} and ${B}`);
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/b/ }));
    expect(bar().getByRole('button', { name: 'Import and link 0' })).toBeDisabled();
  });

  it('sends what is ticked, sets the rest aside for this person alone, and closes', async () => {
    const doc = await openChoose(`${A} and ${B} and ${C}`);
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/b/ }));
    await clickAndWait('Import and link 2');
    expect(server.imports[0].urls).toEqual([A, C]);
    expect(readLinkOffers(doc).size).toBe(0);
    expect([...readSeenLinkOffers('relay-doc-1')]).toEqual([B]);
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    expect(bar().getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('starts a long list unticked, so 34 imports are never one click away', async () => {
    await openChoose(links(34));
    expect(bar().getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked)).toHaveLength(0);
    expect(bar().getByRole('button', { name: 'Import and link 0' })).toBeDisabled();
    click('Tick all');
    expect(bar().getByRole('button', { name: 'Import and link 34' })).toBeInTheDocument();
    click('Untick all');
    expect(bar().getByRole('button', { name: 'Import and link 0' })).toBeDisabled();
  });

  it('starts exactly 10 ticked, and 11 unticked', async () => {
    await openChoose(links(10));
    expect(bar().getByRole('button', { name: 'Import and link 10' })).toBeInTheDocument();
    cleanup();
    await openChoose(links(11));
    expect(bar().getByRole('button', { name: 'Import and link 0' })).toBeInTheDocument();
  });

  it('keeps ticks through closing and opening again', async () => {
    await openChoose(`${A} and ${B}`);
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));
    click('Choose');
    click('Choose');
    expect(bar().getByRole('checkbox', { name: /example.com\/a/ })).not.toBeChecked();
    expect(bar().getByRole('checkbox', { name: /example.com\/b/ })).toBeChecked();
  });

  it('has no bulk button on a short list', async () => {
    await openChoose(`${A} and ${B}`);
    expect(bar().queryByRole('button', { name: 'Untick all' })).not.toBeInTheDocument();
  });

  it('keeps ticks through an edit, leaves a new link unticked, and drops a deleted one', async () => {
    const doc = await openChoose(`${A} and ${B} and ${C}`);
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));

    act(() => {
      const text = doc.getText('contents');
      text.delete(0, text.length);
      text.insert(0, `${A} and ${C} and https://example.com/d`);
    });
    await pass(SCAN_DEBOUNCE_MS);

    expect(bar().getByRole('checkbox', { name: /example.com\/a/ })).not.toBeChecked();
    expect(bar().queryByRole('checkbox', { name: /example.com\/b/ })).not.toBeInTheDocument();
    expect(bar().getByRole('checkbox', { name: /example.com\/c/ })).toBeChecked();
    expect(bar().getByRole('checkbox', { name: /example.com\/d/ })).not.toBeChecked();
  });

  it('cancels a label\'s handing the keyboard to its tick box', async () => {
    // Cancelling is what keeps the keyboard in the page. happy-dom's label forwards
    // the click regardless, so the toggle itself is proven in a real browser.
    await openChoose(`${A} and ${B}`);
    page().focus();
    const [row] = bar().getAllByRole('listitem');
    expect(fireEvent.click(within(row).getByText('example.com/a'))).toBe(false);
    expect(page()).toHaveFocus();
  });

  it('still toggles from the keyboard, on the box itself', async () => {
    const events = user();
    await openChoose(`${A} and ${B}`);
    const [box] = bar().getAllByRole('checkbox');
    box.focus();
    await events.keyboard(' ');
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
  });

  it('does not reopen when its rows come back', async () => {
    const doc = await openChoose(`${A} and ${B}`);
    const setText = (text: string) =>
      act(() => {
        const contents = doc.getText('contents');
        contents.delete(0, contents.length);
        contents.insert(0, text);
      });
    setText(A);
    await pass(SCAN_DEBOUNCE_MS);
    expect(bar().queryByRole('list')).not.toBeInTheDocument();

    setText(`${A} and ${B}`);
    await pass(SCAN_DEBOUNCE_MS);
    expect(buttons()).toContain('Choose');
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    expect(bar().getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes when only one link is left, which needs no list', async () => {
    const doc = await openChoose(`${A} and ${B}`);
    act(() => {
      const text = doc.getText('contents');
      text.delete(0, text.length);
      text.insert(0, A);
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    expect(buttons()).toEqual(['Import and link', 'Dismiss', '×']);
  });

  it('Dismiss turns down everything listed, ticked or not', async () => {
    const doc = await openChoose(`${A} and ${B}`);
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));
    click('Dismiss');
    expect([...readLinkOffers(doc).keys()]).toEqual([A, B]);
  });
});

describe('Details', () => {
  it('shows each row\'s state, with no tick boxes', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    server.set(B, { state: 'queued', job_id: 'j2' });
    server.set(C, { state: 'failed', job_id: 'j3', error: 'The page could not be read' });
    await mount(docWith(`${A} and ${B} and ${C}`));
    click('Details');

    const [first, second, third] = bar().getAllByRole('listitem');
    expect(within(first).getByText('Importing')).toBeInTheDocument();
    expect(within(second).getByText('Queued')).toBeInTheDocument();
    expect(within(third).getByText('Failed')).toBeInTheDocument();
    expect(within(third).getByText('The page could not be read')).toBeInTheDocument();
    expect(bar().queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Open example.com/a' })).toHaveAttribute('href', A);
  });

  it('stays open as Working turns to Failed', async () => {
    await mount(docWith(`See ${A}`));
    await clickAndWait('Import and link');
    click('Details');
    server.set(A, { state: 'failed', job_id: `job:${A}`, error: 'Timed out' });
    await pass(POLL_MS);
    expect(bar().getByText('Timed out')).toBeInTheDocument();
    expect(buttons()).toEqual(['Retry', 'Details', 'Dismiss', '×']);
  });
});

describe('the keyboard stays with the page', () => {
  it('keeps focus when the bar appears, changes and leaves', async () => {
    const doc = docWith('');
    await mount(doc);
    page().focus();

    act(() => doc.getText('contents').insert(0, A));
    await pass(SCAN_DEBOUNCE_MS);
    expect(queryRegion()).toBeInTheDocument();
    expect(page()).toHaveFocus();

    act(() => menuTarget.current?.importSource(A));
    await pass(0);
    expect(page()).toHaveFocus();

    server.set(A, { state: 'failed', job_id: `job:${A}` });
    await pass(POLL_MS);
    expect(bar().getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page()).toHaveFocus();

    act(() => dismissLinkOffers(doc, [A], 'Sam'));
    expect(page()).toHaveFocus();
  });

  it('keeps focus through a mouse click on any control', async () => {
    const events = user();
    await mount(docWith(`${A} and ${B}`));
    page().focus();

    await events.click(bar().getByRole('button', { name: 'Choose' }));
    expect(page()).toHaveFocus();
    await events.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));
    expect(page()).toHaveFocus();
    expect(bar().getByRole('checkbox', { name: /example.com\/a/ })).not.toBeChecked();
    await events.click(bar().getByRole('button', { name: 'Import and link 1' }));
    expect(page()).toHaveFocus();
  });

  it('holds on to the mouse-down everywhere on the bar', async () => {
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    const prevented = (element: Element) => !fireEvent.mouseDown(element);
    expect(prevented(bar().getByRole('button', { name: 'Dismiss' }))).toBe(true);
    expect(prevented(bar().getAllByRole('checkbox')[0])).toBe(true);
    expect(prevented(bar().getAllByRole('link')[0])).toBe(true);
    expect(prevented(bar().getByRole('list'))).toBe(true);
    expect(prevented(bar().getAllByRole('listitem')[0])).toBe(true);
    expect(prevented(bar().getByText(/2 sources on this page/))).toBe(true);
  });

  it('keeps focus through a click on the sentence', async () => {
    const events = user();
    await mount(docWith(`${A} and ${B}`));
    page().focus();
    await events.click(bar().getByText(/2 sources on this page/));
    expect(page()).toHaveFocus();
  });

  it('reaches everything by Tab, in order', async () => {
    const events = user();
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    page().focus();
    const order: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      await events.tab();
      const active = document.activeElement as HTMLElement;
      order.push(active.getAttribute('aria-label') || active.textContent || active.tagName);
    }
    expect(order).toEqual([
      'Import and link',
      'Choose',
      'Dismiss',
      'Hide',
      'INPUT',
      'Open example.com/a',
      'INPUT',
      'Open example.com/b',
      'Import and link 2',
    ]);
  });

  it('gives the keyboard back after a keyboard user accepts', async () => {
    const events = user();
    await mount(docWith(`See ${A}`));
    bar().getByRole('button', { name: 'Import and link' }).focus();
    await events.keyboard('{Enter}');
    await pass(0);
    expect(server.imports).toHaveLength(1);
    expect(page()).toHaveFocus();
  });

  it('gives the keyboard back after a keyboard user dismisses', async () => {
    const events = user();
    await mount(docWith(`See ${A}`));
    bar().getByRole('button', { name: 'Dismiss' }).focus();
    await events.keyboard('{Enter}');
    expect(queryRegion()).not.toBeInTheDocument();
    expect(page()).toHaveFocus();
  });

  it('gives the keyboard back if the bar leaves with focus on it', async () => {
    const doc = docWith(`See ${A}`);
    await mount(doc);
    bar().getByRole('button', { name: 'Dismiss' }).focus();
    act(() => dismissLinkOffers(doc, [A], 'Sam'));
    expect(queryRegion()).not.toBeInTheDocument();
    expect(page()).toHaveFocus();
  });
});

describe('Esc', () => {
  async function openChoose() {
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
  }

  it('collapses the list and lands on its button, from inside the list', async () => {
    const events = user();
    await openChoose();
    bar().getAllByRole('checkbox')[0].focus();
    await events.keyboard('{Escape}');
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    expect(bar().getByRole('button', { name: 'Choose' })).toHaveFocus();
  });

  it('collapses the list from the page, and leaves the keyboard there', async () => {
    const events = user();
    await openChoose();
    page().focus();
    await events.keyboard('{Escape}');
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    expect(page()).toHaveFocus();
  });

  it('leaves the list alone when the editor used the key', async () => {
    await openChoose();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      page().dispatchEvent(event);
    });
    expect(bar().getByRole('list')).toBeInTheDocument();
  });

  it('collapses Details too', async () => {
    const events = user();
    server.set(A, { state: 'importing', job_id: 'j1' });
    await mount(docWith(`See ${A}`));
    click('Details');
    expect(bar().getByRole('list')).toBeInTheDocument();
    await events.keyboard('{Escape}');
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
  });

  it('goes back to the page from a collapsed bar', async () => {
    const events = user();
    await mount(docWith(`See ${A}`));
    bar().getByRole('button', { name: 'Dismiss' }).focus();
    await events.keyboard('{Escape}');
    expect(page()).toHaveFocus();
  });
});

describe('what screen readers get', () => {
  it('is a labelled region', async () => {
    await mount(docWith(`See ${A}`));
    expect(region().tagName).toBe('SECTION');
  });

  it('announces changes politely, from a live region that was there first', async () => {
    const doc = docWith('');
    await mount(doc);
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();

    act(() => doc.getText('contents').insert(0, A));
    await pass(SCAN_DEBOUNCE_MS);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent("example.com/a isn't in the library yet.");

    await clickAndWait('Import and link');
    expect(live).toHaveTextContent('Importing 1 source. You can keep working or close this page.');
  });

  it('does not repeat itself as the estimate moves', async () => {
    await mount(docWith(`See ${A}`));
    await clickAndWait('Import and link');
    const live = screen.getByRole('status');
    const said = vi.fn();
    new MutationObserver(said).observe(live, { childList: true, characterData: true, subtree: true });

    server.set(A, { state: 'importing', job_id: `job:${A}`, eta_minutes: 2 });
    await pass(POLL_MS);
    expect(bar().getByText(/about 2 min/)).toBeInTheDocument();
    expect(said).not.toHaveBeenCalled();
  });
});

describe('the look', () => {
  it('uses theme-following classes and no amber', async () => {
    server.set(A, { kind: 'video' });
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    expect(region().outerHTML).not.toMatch(/amber|#[0-9a-f]{3,6}/i);
    expect(region().innerHTML).toContain('bg-blue-50');
  });

  it('sits in the 760px column', async () => {
    await mount(docWith(`See ${A}`));
    expect(region().className).toContain('max-w-[760px]');
  });

  it('gives touch screens tall buttons, whatever the layout', async () => {
    await mount(docWith(`${A} and ${B}`));
    for (const button of bar().getAllByRole('button')) {
      expect(button.className).toContain('pointer-coarse:min-h-10');
    }
  });

  it('lets the buttons fill a phone\'s width, at thumb height', async () => {
    yjs.isMobile = true;
    await mount(docWith(`${A} and ${B}`));
    for (const button of bar().getAllByRole('button')) {
      expect(button.className).toContain('min-h-10');
      if (button.textContent !== '×') expect(button.className).toContain('flex-1');
    }
    expect(bar().getByRole('button', { name: 'Hide' }).className).toContain('min-w-10');
    expect(bar().getByRole('button', { name: 'Choose' }).parentElement?.className).toContain('basis-full');
  });
});

describe('floating over the page', () => {
  const card = () => region().firstElementChild as HTMLElement;

  it('is opaque, with a shadow', async () => {
    await mount(docWith(`See ${A}`));
    expect(card().className).toContain('bg-blue-50');
    expect(card().className).toContain('shadow-');
  });

  it('only takes clicks on the card, not the column around it', async () => {
    await mount(docWith(`See ${A}`));
    expect(region().className).toContain('pointer-events-none');
    expect(card().className).toContain('pointer-events-auto');
  });

  it('stays at the top when the caret is clear of it', async () => {
    editor.caret = { top: 300, bottom: 320 };
    await mount(docWith(`See ${A}`));
    expect(card().style.transform).toBe('');
  });

  it('steps down past a caret it would cover', async () => {
    editor.caret = { top: 0, bottom: 20 };
    await mount(docWith(`See ${A}`));
    expect(card().style.transform).toBe('translateY(18px)');
  });

  it('steps back when the caret moves away', async () => {
    editor.caret = { top: 0, bottom: 20 };
    await mount(docWith(`See ${A}`));
    expect(card().style.transform).not.toBe('');
    editor.caret = { top: 300, bottom: 320 };
    act(() => menuTarget.current?.editorChanged?.(editorView));
    expect(card().style.transform).toBe('');
  });

  it('ignores the caret of an editor without the keyboard', async () => {
    editor.caret = { top: 0, bottom: 20 };
    (editorView as { hasFocus: boolean }).hasFocus = false;
    await mount(docWith(`See ${A}`));
    expect(card().style.transform).toBe('');
    (editorView as { hasFocus: boolean }).hasFocus = true;
  });
});

describe('Hide', () => {
  it('hides the bar for now, for this person, and Dismiss stays the answer for everyone', async () => {
    const doc = docWith(`${A} and ${B}`);
    await mount(doc);
    const hide = bar().getByRole('button', { name: 'Hide' });
    expect(hide).toHaveAttribute('title', 'Hide for now');
    fireEvent.click(hide);
    expect(queryRegion()).not.toBeInTheDocument();
    expect(readLinkOffers(doc).size).toBe(0);
    expect([...readSeenLinkOffers('relay-doc-1')]).toEqual([A, B]);
  });

  it('is there while an import runs, and when it is done', async () => {
    await mount(docWith(`See ${A}`));
    await clickAndWait('Import and link');
    expect(bar().getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    click('Hide');
    expect(queryRegion()).not.toBeInTheDocument();
  });

  it('gives the keyboard back when used from the keyboard', async () => {
    const events = user();
    await mount(docWith(`See ${A}`));
    bar().getByRole('button', { name: 'Hide' }).focus();
    await events.keyboard('{Enter}');
    expect(page()).toHaveFocus();
  });
});

describe('Open', () => {
  it('opens the library copy, in the editor, for a row in the library', async () => {
    server.set(A, { state: 'library', path: 'Lens Edu/articles/a.md', title: 'The A Paper' });
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    const copy = bar().getByRole('link', { name: 'Open the library copy of The A Paper' });
    expect(copy.getAttribute('href')).toMatch(/^\/a0000000\/Lens-Edu\/articles\/a\.md/);
    expect(copy).toHaveAttribute('target', '_blank');
    expect(bar().getByRole('link', { name: 'Open example.com/b' })).toHaveAttribute('href', B);
  });

  it('falls back to the source when the copy is not in the metadata', async () => {
    server.set(B, { state: 'library', path: 'Lens Edu/articles/b.md', title: 'B' });
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    expect(bar().getByRole('link', { name: 'Open B' })).toHaveAttribute('href', B);
  });
});

describe('the editor scrolling under the bar', () => {
  const card = () => region().firstElementChild as HTMLElement;

  it('asks the editor to keep the caret below it', async () => {
    await mount(docWith(`See ${A}`));
    // happy-dom lays nothing out: the card is 0 high, so the margin is the gaps
    expect(menuTarget.current?.scrollMargin?.()).toBe(14);
  });

  it('asks nothing once it has gone', async () => {
    const doc = docWith(`See ${A}`);
    await mount(doc);
    act(() => dismissLinkOffers(doc, [A], 'Sam'));
    expect(menuTarget.current?.scrollMargin?.()).toBe(0);
  });

  it('places itself again when the page scrolls', async () => {
    editor.caret = { top: 300, bottom: 320 };
    await mount(docWith(`See ${A}`));
    expect(card().style.transform).toBe('');
    editor.caret = { top: 0, bottom: 20 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(card().style.transform).not.toBe('');
  });

  it('stays where it opened while the list is open, even over the caret', async () => {
    editor.caret = { top: 300, bottom: 320 };
    await mount(docWith(`${A} and ${B}`));
    click('Choose');
    editor.caret = { top: 0, bottom: 20 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      menuTarget.current?.editorChanged?.(editorView);
    });
    expect(card().style.transform).toBe('');
    click('Choose');
    expect(card().style.transform).not.toBe('');
  });
});

describe('a new document', () => {
  it('leaves an open list and unticked rows behind', async () => {
    const view = await mount(docWith(`${A} and ${B}`));
    click('Choose');
    fireEvent.click(bar().getByRole('checkbox', { name: /example.com\/a/ }));

    yjs.doc = docWith(`${A} and ${B}`);
    view.rerender(
      <DisplayNameProvider>
        <Page docId="relay-doc-2" />
      </DisplayNameProvider>,
    );
    await pass(0);
    expect(bar().queryByRole('list')).not.toBeInTheDocument();
    click('Choose');
    expect(bar().getByRole('checkbox', { name: /example.com\/a/ })).toBeChecked();
  });
});
