import {
  validateEnvelope,
  type Envelope,
  type BridgeToParent,
  type ParentToBridge,
  type PreviewScrollState,
  type PreviewUiState,
  type ThreadMark,
} from './protocol';
import { installPageServices } from './page-services';
import { installCommentLayer } from './comment-layer';
import { readAnchor } from '../anchoring/types';

// Bumped whenever comment placements are re-measured; scroll-state messages
// echo it so the parent can drop ones measured against an older layout.
let layoutVersion = 0;

const BRIDGE_STATE_KEY = '__lensBridgeInstallState';

interface BridgeInstallState {
  cleanup: () => void;
}

type BridgeWindow = Window & typeof globalThis & {
  [BRIDGE_STATE_KEY]?: BridgeInstallState;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyObjectPayload(payload: unknown): payload is Record<string, never> {
  return isObject(payload) && Object.keys(payload).length === 0;
}

function captureUiState(doc: Document): PreviewUiState {
  const details = Array.from(doc.querySelectorAll('details')) as HTMLDetailsElement[];
  return {
    details: details
      .map((node, index) => ({ path: [index], open: node.open }))
      .filter(item => item.open),
  };
}

function isPreviewUiState(value: unknown): value is PreviewUiState {
  if (!isObject(value) || !Array.isArray(value.details)) return false;
  return value.details.every((item) => {
    if (!isObject(item) || !Array.isArray(item.path) || typeof item.open !== 'boolean') return false;
    return item.path.every(Number.isInteger);
  });
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

function readThreadMarks(payload: unknown): ThreadMark[] | null {
  if (!isObject(payload) || !Array.isArray(payload.threads)) return null;
  const out: ThreadMark[] = [];
  for (const t of payload.threads) {
    if (!isObject(t) || typeof t.id !== 'string' || typeof t.order !== 'number') continue;
    const anchor = readAnchor(t.anchor);
    if (!anchor) continue;
    out.push({ id: t.id, anchor, order: t.order, resolved: t.resolved === true });
  }
  return out;
}

export function installBridge(win: Window & typeof globalThis): () => void {
  const bridgeWin = win as BridgeWindow;
  bridgeWin[BRIDGE_STATE_KEY]?.cleanup();

  const parent = win.parent;
  let nonce: string | null = null;
  const doc = win.document;

  function postToParent(message: BridgeToParent): void {
    const env: Envelope<BridgeToParent> = { nonce: nonce ?? '', message };
    (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(env, '*');
  }

  const pageServices = installPageServices(win, {
    onProblems: problems => postToParent({ type: 'page-problems', payload: { problems } }),
    onStorage: ops => postToParent({ type: 'storage-ops', payload: { ops } }),
  });

  const comments = installCommentLayer(win, {
    post: message => { if (nonce !== null) postToParent(message); },
    layoutVersion: () => layoutVersion,
    bumpLayoutVersion: () => { layoutVersion++; },
  });

  postToParent({ type: 'ready', payload: {} });

  let scrollFrame: number | null = null;
  let restoreFrame: number | null = null;
  function readScrollState(): PreviewScrollState {
    const root = doc.documentElement;
    const body = doc.body;
    const scrollHeight = Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
    const scrollWidth = Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
    const viewportWidth = win.visualViewport?.width ?? win.innerWidth;
    const clientWidth = Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : root?.clientWidth ?? 0;
    const viewportHeight = win.visualViewport?.height ?? win.innerHeight;
    const clientHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : root?.clientHeight ?? 0;
    return {
      x: win.scrollX,
      y: win.scrollY,
      scrollWidth,
      clientWidth,
      scrollHeight,
      clientHeight,
      layoutVersion,
    };
  }
  const postScrollState = (): void => {
    postToParent({ type: 'scroll-state', payload: readScrollState() });
  };
  const scheduleScrollState = (): void => {
    if (scrollFrame !== null) return;
    scrollFrame = win.requestAnimationFrame(() => {
      scrollFrame = null;
      postScrollState();
    });
  };
  function restoreAfterStableLayout(readTarget: () => { x: number; y: number }): void {
    if (restoreFrame !== null) {
      win.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    }
    let attempts = 0;
    let lastMaxY = -1;
    let stableFrames = 0;
    const step = (): void => {
      restoreFrame = null;
      attempts += 1;
      const state = readScrollState();
      const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
      if (!doc.body) {
        restoreFrame = win.requestAnimationFrame(step);
        return;
      }
      if (maxY === lastMaxY) stableFrames += 1;
      else stableFrames = 0;
      lastMaxY = maxY;
      if (stableFrames < 2 && attempts < 20) {
        restoreFrame = win.requestAnimationFrame(step);
        return;
      }
      const target = readTarget();
      win.scrollTo(target.x, target.y);
      postScrollState();
    };
    restoreFrame = win.requestAnimationFrame(step);
  }
  function restoreScrollRatio(xRatio: number, yRatio: number): void {
    restoreAfterStableLayout(() => {
      const state = readScrollState();
      const maxX = Math.max(0, state.scrollWidth - state.clientWidth);
      const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
      return {
        x: xRatio <= 0 ? 0 : xRatio * maxX,
        y: Math.max(0, Math.min(maxY, yRatio * maxY)),
      };
    });
  }

  const messageListener = (event: MessageEvent): void => {
    if (event.source !== parent) return;
    const data = event.data as Envelope<ParentToBridge>;
    if (nonce === null) {
      if (!data || typeof data !== 'object') return;
      const msg = data.message;
      if (!msg || msg.type !== 'init') return;
      if (typeof data.nonce !== 'string' || data.nonce.length === 0) return;
      nonce = data.nonce;
      pageServices.connect();
      comments.start();
      return;
    }

    const msg = validateEnvelope<ParentToBridge>(data, nonce);
    if (!msg) return;
    switch (msg.type) {
      case 'set-threads': {
        const threads = readThreadMarks(msg.payload);
        if (threads) comments.setThreads(threads);
        break;
      }
      case 'set-draft': {
        if (!isObject(msg.payload)) return;
        comments.setDraft(msg.payload.anchor === null ? null : readAnchor(msg.payload.anchor));
        break;
      }
      case 'set-focused-thread': {
        if (!isObject(msg.payload)) return;
        const id = msg.payload.id;
        if (id !== null && typeof id !== 'string') return;
        comments.setFocused(id, msg.payload.reveal === true);
        break;
      }
      case 'set-comment-mode':
        if (!isObject(msg.payload)) return;
        comments.setCommentMode(msg.payload.on === true);
        break;
      case 'capture-selection':
        comments.captureSelection();
        break;
      case 'describe-legacy': {
        if (!isObject(msg.payload) || !Array.isArray(msg.payload.ids)) return;
        comments.describeLegacy(msg.payload.ids.filter((id): id is string => typeof id === 'string').slice(0, 500));
        break;
      }
      case 'describe-current': {
        if (!isObject(msg.payload) || typeof msg.payload.id !== 'string') return;
        comments.describeCurrent(msg.payload.id);
        break;
      }
      case 'restore-scroll': {
        if (!isObject(msg.payload)) return;
        const x = msg.payload.x;
        const y = msg.payload.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        restoreAfterStableLayout(() => ({ x: x as number, y: y as number }));
        break;
      }
      case 'restore-scroll-ratio': {
        if (!isObject(msg.payload)) return;
        const xRatio = msg.payload.xRatio;
        const yRatio = msg.payload.yRatio;
        if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return;
        restoreScrollRatio(
          Math.max(0, Math.min(1, xRatio as number)),
          Math.max(0, Math.min(1, yRatio as number)),
        );
        break;
      }
      case 'capture-ui-state':
        if (!isEmptyObjectPayload(msg.payload)) return;
        postToParent({ type: 'ui-state', payload: captureUiState(doc) });
        break;
      case 'restore-ui-state':
        if (!isPreviewUiState(msg.payload)) return;
        restoreUiState(doc, msg.payload);
        break;
      case 'init':
        break;
    }
  };
  win.addEventListener('message', messageListener);
  win.addEventListener('scroll', scheduleScrollState);

  const cleanup = (): void => {
    win.removeEventListener('message', messageListener);
    win.removeEventListener('scroll', scheduleScrollState);
    if (scrollFrame !== null) {
      win.cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    if (restoreFrame !== null) {
      win.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    }
    comments.cleanup();
    pageServices.cleanup();
    if (bridgeWin[BRIDGE_STATE_KEY]?.cleanup === cleanup) {
      delete bridgeWin[BRIDGE_STATE_KEY];
    }
  };
  bridgeWin[BRIDGE_STATE_KEY] = { cleanup };
  return cleanup;
}
