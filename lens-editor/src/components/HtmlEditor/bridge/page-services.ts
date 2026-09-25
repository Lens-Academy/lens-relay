import type { PageProblem, StorageOp } from './protocol';

/**
 * Page-facing services the bridge provides inside the preview iframe:
 *
 * - problem reporting: uncaught errors, rejected promises, resources and
 *   module imports that failed to load, anything the page CSP blocked, and a
 *   page wider than its frame, so the editor can show them instead of the
 *   page failing silently;
 * - links (external, or root-relative editor paths) open in a new tab instead
 *   of navigating the preview away, in-page #anchors scroll, and form
 *   submissions stay in the page;
 * - alert/confirm/prompt/print, which the sandbox refuses, report a problem;
 * - `data-theme="light"` on <html> (the editor's theme) unless the page set one,
 *   so pages using Claude's theme-token pattern match the editor;
 * - a Storage shim: the sandboxed frame has an opaque origin, where touching
 *   `localStorage` throws. The shim is seeded from `window.__lensStorageSeed`
 *   and reports every change to the parent, which keeps the viewer's copy.
 */

/** Problems kept per page; beyond that the list ends with "…and N more". */
const MAX_PROBLEMS = 19;
const SHIM_KEY = '__lensStorageShim';

export interface PageServices {
  /** Call once the parent is listening (nonce known): flushes buffered reports. */
  connect(): void;
  cleanup(): void;
}

export interface PageServicesHooks {
  onProblems(problems: PageProblem[]): void;
  onStorage(ops: StorageOp[]): void;
}

type ServiceWindow = Window & typeof globalThis & {
  __lensStorageSeed?: unknown;
  __lensLineOffset?: unknown;
  [SHIM_KEY]?: StorageShim;
};

/** Browser notices that are not the page's fault. */
const IGNORED_ERRORS = [
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/,
];

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

function readSeed(win: ServiceWindow): Record<string, string> {
  const seed = win.__lensStorageSeed;
  const out: Record<string, string> = {};
  if (typeof seed !== 'object' || seed === null) return out;
  for (const [key, value] of Object.entries(seed)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * In-memory Storage whose changes go to `onChange`. Exposed through a Proxy
 * so named-property access (`localStorage.todos = …`, `Object.keys(localStorage)`)
 * reads and writes items, as it does on a real Storage.
 */
class StorageShim {
  items: Map<string, string>;
  onChange: (op: StorageOp) => void;
  readonly proxy: Storage;

  constructor(seed: Record<string, string>, onChange: (op: StorageOp) => void, proto: object | null) {
    this.items = new Map(Object.entries(seed));
    this.onChange = onChange;
    const items = this.items;
    const methods: Record<string, unknown> = {
      key: (index: number) => Array.from(items.keys())[index] ?? null,
      getItem: (key: string) => items.get(String(key)) ?? null,
      setItem: (key: string, value: string) => this.set(String(key), String(value)),
      removeItem: (key: string) => this.remove(String(key)),
      clear: () => this.clear(),
    };
    const target = Object.create(proto) as Storage;
    const set = (key: string, value: string) => this.set(key, value);
    const remove = (key: string) => this.remove(key);
    this.proxy = new Proxy(target, {
      get(_t, prop) {
        if (prop === 'length') return items.size;
        if (typeof prop === 'string' && prop in methods) return methods[prop];
        if (typeof prop === 'string' && items.has(prop)) return items.get(prop);
        return Reflect.get(target, prop);
      },
      set(_t, prop, value) {
        if (typeof prop !== 'string' || prop in methods || prop === 'length') return false;
        set(prop, String(value));
        return true;
      },
      has(_t, prop) {
        return (typeof prop === 'string' && items.has(prop)) || Reflect.has(target, prop);
      },
      deleteProperty(_t, prop) {
        if (typeof prop === 'string') remove(prop);
        return true;
      },
      ownKeys() {
        return Array.from(items.keys());
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop !== 'string' || !items.has(prop)) return undefined;
        return { value: items.get(prop), writable: true, enumerable: true, configurable: true };
      },
    });
  }

  set(key: string, value: string): void {
    if (this.items.get(key) === value) return;
    this.items.set(key, value);
    this.onChange({ op: 'set', key, value });
  }

  remove(key: string): void {
    if (this.items.delete(key)) this.onChange({ op: 'remove', key });
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.onChange({ op: 'clear' });
  }
}

function storageUnavailable(win: Window, name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    return !win[name];
  } catch {
    return true;
  }
}

/** Install (once per window) the Storage shims; returns the localStorage shim, if any. */
function installStorage(win: ServiceWindow): StorageShim | null {
  const existing = win[SHIM_KEY];
  if (existing) return existing;
  if (!storageUnavailable(win, 'localStorage')) return null;
  const proto = win.Storage?.prototype ?? Object.prototype;
  const local = new StorageShim(readSeed(win), () => {}, proto);
  try {
    Object.defineProperty(win, 'localStorage', { value: local.proxy, configurable: true });
  } catch {
    return null;
  }
  win[SHIM_KEY] = local;
  if (storageUnavailable(win, 'sessionStorage')) {
    try {
      const session = new StorageShim({}, () => {}, proto);
      Object.defineProperty(win, 'sessionStorage', { value: session.proxy, configurable: true });
    } catch {
      // Leave the throwing accessor in place; the page reports the error.
    }
  }
  return local;
}

function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

export function installPageServices(win: Window & typeof globalThis, hooks: PageServicesHooks): PageServices {
  const doc = win.document;
  const problems: PageProblem[] = [];
  // A resource refused by the CSP also fires a load error; report it once, as blocked.
  const blockedUrls = new Set<string>();
  let dropped = 0;
  let connected = false;
  let problemsTimer: ReturnType<typeof setTimeout> | null = null;
  let overflowTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingOps: StorageOp[] = [];
  let opsQueued = false;

  function absoluteUrl(url: string): string {
    try {
      return new URL(url, doc.baseURI).href;
    } catch {
      return url;
    }
  }

  function flushProblems(): void {
    problemsTimer = null;
    if (!connected) return;
    const list = problems.map(problem => ({ ...problem }));
    if (dropped > 0) {
      list.push({ kind: 'error', message: `…and ${dropped} more problem${dropped === 1 ? '' : 's'} not listed`, count: 1 });
    }
    hooks.onProblems(list);
  }

  function scheduleProblems(): void {
    if (connected && problemsTimer === null) problemsTimer = setTimeout(flushProblems, 100);
  }

  function addProblem(problem: Omit<PageProblem, 'count'>): void {
    const existing = problems.find(p => (
      p.kind === problem.kind && p.message === problem.message && p.source === problem.source
    ));
    if (existing) existing.count += 1;
    else if (problems.length < MAX_PROBLEMS) problems.push({ ...problem, count: 1 });
    else dropped += 1;
    scheduleProblems();
  }

  // Storage changes go out in order, batched per task, and are flushed
  // before the frame goes away, so a quick reload never drops the last write.
  function flushOps(): void {
    opsQueued = false;
    if (!connected || pendingOps.length === 0) return;
    hooks.onStorage(pendingOps.splice(0));
  }

  function queueOp(op: StorageOp): void {
    pendingOps.push(op);
    if (connected && !opsQueued) {
      opsQueued = true;
      queueMicrotask(flushOps);
    }
  }

  const storage = installStorage(win as ServiceWindow);
  if (storage) storage.onChange = queueOp;

  const root = doc.documentElement;
  if (root && !root.hasAttribute('data-theme')) root.setAttribute('data-theme', 'light');

  const unavailable = (name: string, fallback: unknown) => () => {
    addProblem({
      kind: 'error',
      message: `${name}() does nothing in the preview; build the message or confirmation into the page`,
    });
    return fallback;
  };
  try {
    win.alert = unavailable('alert', undefined) as typeof win.alert;
    win.confirm = unavailable('confirm', false) as typeof win.confirm;
    win.prompt = unavailable('prompt', null) as typeof win.prompt;
    win.print = unavailable('print', undefined) as typeof win.print;
  } catch {
    // Read-only in some environments; the sandbox still refuses the dialogs.
  }

  const errorListener = (event: Event): void => {
    if (event instanceof win.ErrorEvent) {
      let message = event.message || describeReason(event.error);
      if (IGNORED_ERRORS.some(re => re.test(message.replace(/^Uncaught\s+/, '')))) return;
      if (/Failed to resolve module specifier/.test(message)) {
        const ownMap = doc.querySelector('script[type="importmap"]:not([data-lens-runtime])');
        message += ownMap
          ? ' The page has its own import map, which replaces the editor\'s: add this name to it.'
          : ' It is not in the editor\'s import map: import it by full, pinned URL.';
      }
      if (/^(Uncaught )?Script error\.?$/.test(message)) {
        message = 'A script loaded from a CDN threw an error, and the browser hides its details. '
          + 'Add crossorigin="anonymous" to that <script> tag to see the message';
      }
      const inPage = event.filename.startsWith('about:srcdoc');
      const offset = Number((win as ServiceWindow).__lensLineOffset) || 0;
      const line = inPage && event.lineno > offset ? event.lineno - offset : event.lineno;
      const file = inPage ? 'line' : event.filename;
      const where = event.filename
        ? (line > 0 ? (inPage ? `line ${line}` : `${file}:${line}`) : inPage ? undefined : file)
        : undefined;
      addProblem({ kind: 'error', message, source: where });
      return;
    }
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const url = target.getAttribute('src') ?? target.getAttribute('href');
    if (!url) {
      if (target instanceof win.HTMLScriptElement && target.type === 'module') {
        addProblem({
          kind: 'load-failed',
          message: 'A module script could not load one of its imports; check the import URLs and versions',
        });
      }
      return;
    }
    if (blockedUrls.has(absoluteUrl(url))) return;
    addProblem({ kind: 'load-failed', message: `Could not load <${target.tagName.toLowerCase()}>`, source: url });
  };
  const rejectionListener = (event: PromiseRejectionEvent): void => {
    addProblem({ kind: 'error', message: `Unhandled promise rejection: ${describeReason(event.reason)}` });
  };
  const cspListener = (event: SecurityPolicyViolationEvent): void => {
    const directive = event.effectiveDirective.replace(/-(elem|attr)$/, '');
    if (event.blockedURI) {
      const blocked = absoluteUrl(event.blockedURI);
      blockedUrls.add(blocked);
      const duplicate = problems.findIndex(p => (
        p.kind === 'load-failed' && p.source !== undefined && absoluteUrl(p.source) === blocked
      ));
      if (duplicate >= 0) problems.splice(duplicate, 1);
    }
    addProblem({
      kind: 'blocked',
      message: `Blocked by the page rules (${directive})`,
      source: event.blockedURI || undefined,
    });
  };
  // Bubble phase: page handlers run first, and a page that handles its own
  // navigation (preventDefault, or an explicit target) is left alone.
  const linkListener = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof win.HTMLAnchorElement) || anchor.target) return;
    // Resolve against the frame's base, which is the editor page's URL, so a
    // root-relative editor path (/<id>/Folder/Doc.md) opens that document.
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      // "#x" resolves against the editor's URL, not about:srcdoc, so the
      // default action would navigate the frame to the editor. Scroll instead.
      event.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const dest = id ? doc.getElementById(id) ?? doc.getElementsByName(id)[0] : doc.documentElement;
      dest?.scrollIntoView({ block: 'start' });
      return;
    }
    if (!/^(https?:|mailto:|tel:)/i.test(anchor.href)) return;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  };
  // A real submission would navigate the preview away (to the editor's own
  // URL); keep forms as page UI, like a Claude artifact.
  const submitListener = (event: SubmitEvent): void => {
    const form = event.target;
    if (form instanceof win.HTMLFormElement && form.target === '_blank') return;
    event.preventDefault();
  };

  // The page is wider than its frame: the body scrolls sideways. A state, not
  // an event: it is reported while true and withdrawn once fixed.
  function checkOverflow(): void {
    overflowTimer = null;
    const root = doc.documentElement;
    const body = doc.body;
    if (!root || !body) return;
    const viewport = win.innerWidth;
    const width = Math.max(root.scrollWidth, body.scrollWidth);
    const index = problems.findIndex(p => p.kind === 'overflow');
    if (width <= viewport + 1) {
      if (index >= 0) {
        problems.splice(index, 1);
        scheduleProblems();
      }
      return;
    }
    const culprits: string[] = [];
    const all = body.getElementsByTagName('*');
    for (let i = 0; i < all.length && i < 3000 && culprits.length < 3; i++) {
      const el = all[i];
      const rect = el.getBoundingClientRect();
      if (rect.right <= viewport + 1 || rect.width === 0) continue;
      const parent = el.parentElement;
      if (parent && parent !== body && parent.getBoundingClientRect().right > viewport + 1) continue;
      culprits.push(describeElement(el));
    }
    const message = `The page is ${Math.round(width)}px wide in a ${Math.round(viewport)}px view, so it scrolls sideways`;
    const source = culprits.length > 0 ? `widest: ${culprits.join(', ')}` : undefined;
    if (index >= 0) {
      if (problems[index].message === message && problems[index].source === source) return;
      problems[index] = { kind: 'overflow', message, source, count: 1 };
    } else {
      // Always listed, even when the list is full: it is the phone check.
      problems.push({ kind: 'overflow', message, source, count: 1 });
    }
    scheduleProblems();
  }

  function scheduleOverflow(delay = 300): void {
    if (overflowTimer !== null) clearTimeout(overflowTimer);
    overflowTimer = setTimeout(checkOverflow, delay);
  }

  const loadListener = (): void => {
    scheduleOverflow(50);
    // Late layout (fonts, charts that animate in) settles after load.
    setTimeout(() => scheduleOverflow(0), 1500);
  };
  const resizeListener = (): void => scheduleOverflow();
  const pagehideListener = (): void => flushOps();

  win.addEventListener('error', errorListener, true);
  win.addEventListener('unhandledrejection', rejectionListener);
  doc.addEventListener('securitypolicyviolation', cspListener);
  win.addEventListener('click', linkListener);
  win.addEventListener('submit', submitListener);
  win.addEventListener('load', loadListener);
  win.addEventListener('resize', resizeListener);
  win.addEventListener('pagehide', pagehideListener);

  return {
    connect() {
      if (connected) return;
      connected = true;
      if (problems.length > 0) flushProblems();
      flushOps();
      if (doc.readyState === 'complete') scheduleOverflow(50);
    },
    cleanup() {
      connected = false;
      if (storage && storage.onChange === queueOp) storage.onChange = () => {};
      win.removeEventListener('error', errorListener, true);
      win.removeEventListener('unhandledrejection', rejectionListener);
      doc.removeEventListener('securitypolicyviolation', cspListener);
      win.removeEventListener('click', linkListener);
      win.removeEventListener('submit', submitListener);
      win.removeEventListener('load', loadListener);
      win.removeEventListener('resize', resizeListener);
      win.removeEventListener('pagehide', pagehideListener);
      if (problemsTimer !== null) clearTimeout(problemsTimer);
      if (overflowTimer !== null) clearTimeout(overflowTimer);
    },
  };
}
