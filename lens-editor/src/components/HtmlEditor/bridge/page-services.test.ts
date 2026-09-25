import { describe, it, expect, vi, afterEach } from 'vitest';
import { installPageServices } from './page-services';
import type { PageProblem, StorageOp } from './protocol';

type TestWindow = Window & typeof globalThis & { __lensStorageSeed?: unknown; __lensStorageShim?: unknown };

function makeWindow(seed?: Record<string, string>): TestWindow {
  const win = window as TestWindow;
  // Mimic the sandboxed frame's opaque origin, where storage access throws.
  Object.defineProperty(win, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('denied', 'SecurityError'); },
  });
  win.__lensStorageSeed = seed;
  return win;
}

const realLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

afterEach(() => {
  vi.useRealTimers();
  if (realLocalStorage) Object.defineProperty(window, 'localStorage', realLocalStorage);
  else delete (window as { localStorage?: Storage }).localStorage;
  const win = window as TestWindow;
  delete win.__lensStorageSeed;
  delete win.__lensStorageShim;
  document.body.innerHTML = '';
});

function hooks() {
  return {
    onProblems: vi.fn<(p: PageProblem[]) => void>(),
    onStorage: vi.fn<(ops: StorageOp[]) => void>(),
  };
}

describe('installPageServices problems', () => {
  it('buffers problems until connected, then reports them deduplicated', () => {
    vi.useFakeTimers();
    const h = hooks();
    const services = installPageServices(window, h);
    (window as TestWindow & { __lensLineOffset?: number }).__lensLineOffset = 900;
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'about:srcdoc', lineno: 903 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'about:srcdoc', lineno: 903 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: '', lineno: 0 }));
    expect(h.onProblems).not.toHaveBeenCalled();

    services.connect();
    expect(h.onProblems).toHaveBeenLastCalledWith([
      { kind: 'error', message: 'boom', source: 'line 3', count: 2 },
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('crossorigin="anonymous"') }),
    ]);
    delete (window as TestWindow & { __lensLineOffset?: number }).__lensLineOffset;
    services.cleanup();
  });

  it('ignores the harmless ResizeObserver loop notice', () => {
    const h = hooks();
    const services = installPageServices(window, h);
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    services.connect();
    expect(h.onProblems).not.toHaveBeenCalled();
    services.cleanup();
  });

  it('reports a CSP-blocked resource once, as blocked', () => {
    const h = hooks();
    const services = installPageServices(window, h);
    const img = document.createElement('img');
    img.setAttribute('src', 'https://example.com/x.png');
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), {
      blockedURI: 'https://example.com/x.png',
      effectiveDirective: 'img-src',
    }));
    img.dispatchEvent(new Event('error'));
    services.connect();
    expect(h.onProblems).toHaveBeenLastCalledWith([
      { kind: 'blocked', message: 'Blocked by the page rules (img-src)', source: 'https://example.com/x.png', count: 1 },
    ]);
    services.cleanup();
  });

  it('reports resources and inline module imports that fail to load', () => {
    const h = hooks();
    const services = installPageServices(window, h);
    const img = document.createElement('img');
    img.setAttribute('src', 'https://example.com/missing.png');
    const mod = document.createElement('script');
    mod.type = 'module';
    document.body.append(img, mod);
    img.dispatchEvent(new Event('error'));
    mod.dispatchEvent(new Event('error'));
    services.connect();
    expect(h.onProblems).toHaveBeenLastCalledWith([
      { kind: 'load-failed', message: 'Could not load <img>', source: 'https://example.com/missing.png', count: 1 },
      { kind: 'load-failed', message: 'A module script could not load one of its imports; check the import URLs and versions', count: 1 },
    ]);
    services.cleanup();
  });
});

describe('installPageServices page environment', () => {
  it('reports dialog calls, returning what a refused dialog returns', () => {
    const h = hooks();
    const services = installPageServices(window, h);
    services.connect();
    vi.useFakeTimers();
    expect(window.confirm('Delete?')).toBe(false);
    expect(window.prompt('Name?')).toBeNull();
    vi.advanceTimersByTime(150);
    expect(h.onProblems).toHaveBeenLastCalledWith([
      { kind: 'error', message: 'confirm() does nothing in the preview; build the message or confirmation into the page', count: 1 },
      { kind: 'error', message: 'prompt() does nothing in the preview; build the message or confirmation into the page', count: 1 },
    ]);
    services.cleanup();
  });

  it("stamps the editor's light theme unless the page chose one", () => {
    document.documentElement.removeAttribute('data-theme');
    const a = installPageServices(window, hooks());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    a.cleanup();
    document.documentElement.setAttribute('data-theme', 'dark');
    const b = installPageServices(window, hooks());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    b.cleanup();
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('installPageServices storage shim', () => {
  it('replaces throwing localStorage with a seeded shim that reports each change in order', async () => {
    const win = makeWindow({ theme: 'dark' });
    const h = hooks();
    const services = installPageServices(win, h);
    expect(win.localStorage.getItem('theme')).toBe('dark');
    win.localStorage.setItem('count', '2');
    expect(win.localStorage.length).toBe(2);

    services.connect();
    expect(h.onStorage).toHaveBeenLastCalledWith([{ op: 'set', key: 'count', value: '2' }]);
    win.localStorage.removeItem('theme');
    win.localStorage.setItem('count', '3');
    await Promise.resolve();
    expect(h.onStorage).toHaveBeenLastCalledWith([
      { op: 'remove', key: 'theme' },
      { op: 'set', key: 'count', value: '3' },
    ]);
    services.cleanup();
  });

  it('supports named-property access and enumeration like a real Storage', async () => {
    const win = makeWindow({ a: '1' });
    const h = hooks();
    const services = installPageServices(win, h);
    services.connect();
    const store = win.localStorage as unknown as Record<string, string>;
    store.todos = '[1]';
    expect(win.localStorage.getItem('todos')).toBe('[1]');
    expect(store.a).toBe('1');
    expect(Object.keys(win.localStorage)).toEqual(['a', 'todos']);
    expect(JSON.stringify(win.localStorage)).toBe('{"a":"1","todos":"[1]"}');
    expect('todos' in win.localStorage).toBe(true);
    delete store.a;
    expect(win.localStorage.getItem('a')).toBeNull();
    expect(win.localStorage instanceof Storage).toBe(true);
    await Promise.resolve();
    expect(h.onStorage).toHaveBeenLastCalledWith([
      { op: 'set', key: 'todos', value: '[1]' },
      { op: 'remove', key: 'a' },
    ]);
    services.cleanup();
  });

  it('keeps the shim across a bridge reinstall and reports only to the live install', async () => {
    const win = makeWindow();
    const first = hooks();
    const a = installPageServices(win, first);
    a.connect();
    a.cleanup();
    const second = hooks();
    const b = installPageServices(win, second);
    b.connect();
    win.localStorage.setItem('k', 'v');
    await Promise.resolve();
    expect(first.onStorage).not.toHaveBeenCalled();
    expect(second.onStorage).toHaveBeenLastCalledWith([{ op: 'set', key: 'k', value: 'v' }]);
    b.cleanup();
  });

  it('flushes pending changes when the page is hidden', () => {
    const win = makeWindow();
    const h = hooks();
    const services = installPageServices(win, h);
    services.connect();
    win.localStorage.setItem('last', 'write');
    window.dispatchEvent(new Event('pagehide'));
    expect(h.onStorage).toHaveBeenLastCalledWith([{ op: 'set', key: 'last', value: 'write' }]);
    services.cleanup();
  });
});

describe('installPageServices navigation', () => {
  it('opens external links and editor paths in a new tab but leaves in-page anchors alone', () => {
    const services = installPageServices(window, hooks());
    document.body.innerHTML = '<a id="ext" href="https://example.com">x</a><a id="frag" href="#s">y</a>'
      + '<a id="doc" href="/45b3721f/Lens/Plan.md">z</a>';
    const ext = document.getElementById('ext') as HTMLAnchorElement;
    const frag = document.getElementById('frag') as HTMLAnchorElement;
    ext.addEventListener('click', e => e.preventDefault(), { once: true });
    ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // A page that prevented default keeps control of its own link.
    expect(ext.target).toBe('');
    ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(ext.target).toBe('_blank');
    expect(ext.rel).toBe('noopener noreferrer');
    frag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(frag.target).toBe('');
    const docLink = document.getElementById('doc') as HTMLAnchorElement;
    docLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(docLink.target).toBe('_blank');
    services.cleanup();
  });

  it('scrolls to in-page anchors instead of letting the frame navigate', () => {
    const services = installPageServices(window, hooks());
    document.body.innerHTML = '<a id="jump" href="#notes">go</a><h2 id="notes">Notes</h2>';
    const heading = document.getElementById('notes')!;
    const scrolled = vi.fn();
    heading.scrollIntoView = scrolled;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('jump')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(scrolled).toHaveBeenCalledOnce();
    services.cleanup();
  });

  it('keeps form submissions inside the page', () => {
    const services = installPageServices(window, hooks());
    document.body.innerHTML = '<form id="f"><button>Go</button></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    let seen = false;
    form.addEventListener('submit', () => { seen = true; });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(seen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    services.cleanup();
  });
});
