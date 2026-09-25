/**
 * Everything the HTML editor needs to show and change a page's comment
 * threads: the threads from `comments_v0`, their placements reported by the
 * preview, document-order numbering, card views, and the write-backs that
 * keep anchors healthy (refreshing drifted anchors, recording what editors
 * saw for agents, migrating legacy inline comments).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { LENS_EDITOR_ORIGIN } from '../../../lib/relay-api';
import type { MessageView, ThreadAnchorInfo, ThreadView } from '../../Comments/types';
import { describeAnchorTarget, type AnchorState, type HtmlAnchor } from '../anchoring/types';
import { similarity } from '../anchoring/fuzzy';
import type { ThreadMark, ThreadPlacement, ThreadsResolvedPayload } from '../bridge/protocol';
import {
  addMessage,
  commentsMap,
  createThread,
  deleteMessage,
  editMessage,
  localAuthorId,
  readThreads,
  recordSeen,
  setThreadAnchor,
  setThreadStatus,
  type HtmlThread,
} from './thread-store';
import { hasLegacyComments, parseLegacyComments, stripLegacyMarkers } from './legacy';

const ORIGIN = LENS_EDITOR_ORIGIN;
const SEP = '\u0000';
/** A thread's anchor is refreshed after edits at most this often per client. */
const REFRESH_INTERVAL_MS = 3 * 60_000;
const MIGRATION_RETRY_MS = 15_000;

/** A refreshed anchor must describe the same kind of target and, for text,
 *  resemble the quote it replaces (a guard against forged placements). */
function plausibleRefresh(current: HtmlAnchor, next: HtmlAnchor): boolean {
  if (current.kind === 'element') return next.kind === 'element' && next.tag === current.tag;
  if (next.kind !== 'text') return false;
  return similarity(current.quote.slice(0, 400), next.quote.slice(0, 400)) >= 0.6;
}

export function useHtmlThreads(doc: Y.Doc): HtmlThread[] {
  const [threads, setThreads] = useState(() => readThreads(doc));
  useEffect(() => {
    const map = commentsMap(doc);
    const update = () => setThreads(readThreads(doc));
    update();
    map.observeDeep(update);
    return () => map.unobserveDeep(update);
  }, [doc]);
  return threads;
}

export interface Placements {
  byId: Map<string, ThreadPlacement>;
  draft: ThreadPlacement | null;
  baselineScrollY: number;
  layoutVersion: number;
  settled: boolean;
  /** Whether any report arrived from the current page yet. */
  received: boolean;
}

const EMPTY_PLACEMENTS: Placements = {
  byId: new Map(),
  draft: null,
  baselineScrollY: 0,
  layoutVersion: 0,
  settled: false,
  received: false,
};

interface Options {
  ytext: Y.Text;
  currentUser: string;
  canWrite: boolean;
  showResolved: boolean;
  /** Asks the preview where legacy inline comments render. */
  describeLegacy: (ids: string[]) => void;
}

function toIso(ts: number): string {
  return new Date(ts || 0).toISOString();
}

export function useHtmlComments({ ytext, currentUser, canWrite, showResolved, describeLegacy }: Options) {
  const doc = ytext.doc!;
  const threads = useHtmlThreads(doc);
  const [placements, setPlacements] = useState<Placements>(EMPTY_PLACEMENTS);
  const authorId = useMemo(() => localAuthorId(), []);

  const onThreadsResolved = useCallback((payload: ThreadsResolvedPayload) => {
    setPlacements({
      byId: new Map(payload.placements.map(p => [p.id, p])),
      draft: payload.draft,
      baselineScrollY: payload.baselineScrollY,
      layoutVersion: payload.layoutVersion,
      settled: payload.settled,
      received: true,
    });
  }, []);

  const visible = useMemo(
    () => threads.filter(t => t.status === 'open' || showResolved),
    [threads, showResolved],
  );

  // Document order: by where each target is on the page now; threads that
  // are not on the page go last, oldest first.
  const ordered = useMemo(() => {
    const offset = (t: HtmlThread) => placements.byId.get(t.id)?.textOffset ?? Number.POSITIVE_INFINITY;
    return [...visible].sort((a, b) => (offset(a) - offset(b)) || (a.createdAt - b.createdAt));
  }, [visible, placements]);

  const orderKey = ordered.map(t => t.id).join(',');
  const marksKey = JSON.stringify(ordered.map(t => [t.id, t.anchor, t.status]));
  const marks = useMemo<ThreadMark[]>(() => ordered.flatMap(t => (
    t.anchor ? [{ id: t.id, anchor: t.anchor, order: threads.findIndex(x => x.id === t.id) + 1, resolved: t.status === 'resolved' }] : []
  )),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content so the preview is not re-sent identical lists
  [orderKey, marksKey]);

  const anchorInfo = useCallback((t: HtmlThread): ThreadAnchorInfo => {
    // The latest known text: a refreshed anchor follows edits to the passage.
    const target = t.anchor ? describeAnchorTarget(t.anchor) : (t.originalQuote ?? 'Unknown spot (migrated comment)');
    if (!t.anchor) return { target, state: 'orphaned' };
    const p = placements.byId.get(t.id);
    const section = t.anchor.section;
    if (!p || (p.state === 'orphaned' && !placements.settled)) return { target, state: 'locating', ...(section ? { section } : {}) };
    return {
      target,
      state: p.state,
      ...(p.currentQuote && p.state === 'guessed' ? { currentText: p.currentQuote } : {}),
      ...(section ? { section } : {}),
    };
  }, [placements]);

  // Numbers follow creation order, so they never change under people's
  // feet ("see comment 5") as others comment, resolve or edit the page.
  const numbers = useMemo(() => new Map(threads.map((t, i) => [t.id, i + 1])), [threads]);

  const views = useMemo<ThreadView[]>(() => ordered.map(t => {
    const messages: MessageView[] = t.messages.map(m => ({
      id: `${t.id}${SEP}${m.id}`,
      author: m.author,
      body: m.body,
      timestamp: toIso(m.ts),
      canModify: canWrite && (m.authorId ? m.authorId === authorId : m.author === currentUser),
    }));
    const anchor = anchorInfo(t);
    return {
      key: t.id,
      root: messages[0],
      replies: messages.slice(1),
      order: numbers.get(t.id) ?? 0,
      orphan: anchor.state === 'orphaned' || anchor.state === 'locating',
      anchor,
      ...(t.status === 'resolved'
        ? { resolved: { by: t.resolvedBy ?? 'someone', at: toIso(t.resolvedAt ?? 0) } }
        : {}),
    };
  }), [ordered, anchorInfo, authorId, canWrite, currentUser, numbers]);

  // ---- write-backs (editors only, once the page has settled) ----------
  // Placements come from the page, which can forge them and can render
  // differently for each viewer, so write-backs are rate-limited: `seen` is
  // written when this client's own observation changes (never in reply to
  // another client's write), and a thread's anchor is refreshed at most every
  // few minutes, only to text resembling what it quoted.
  const threadsRef = useRef(threads);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  const seenWrittenRef = useRef(new Map<string, AnchorState>());
  const refreshedAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!canWrite || !placements.settled) return;
    const writeSeen = (id: string, state: AnchorState) => {
      if (seenWrittenRef.current.get(id) === state) return;
      seenWrittenRef.current.set(id, state);
      recordSeen(doc, ORIGIN, id, state);
    };
    for (const t of threadsRef.current) {
      if (t.status !== 'open') continue;
      if (!t.anchor) {
        writeSeen(t.id, 'orphaned');
        continue;
      }
      const p = placements.byId.get(t.id);
      if (!p) continue;
      if (p.refreshed && p.state === 'anchored') {
        const last = refreshedAtRef.current.get(t.id) ?? 0;
        if (Date.now() - last >= REFRESH_INTERVAL_MS && plausibleRefresh(t.anchor, p.refreshed)) {
          refreshedAtRef.current.set(t.id, Date.now());
          setThreadAnchor(doc, ORIGIN, t.id, p.refreshed);
        }
        continue;
      }
      // Hidden depends on this viewer's UI state (tabs, collapsed sections);
      // it says nothing about the page.
      if (p.state !== 'hidden') writeSeen(t.id, p.state);
    }
  }, [canWrite, doc, placements]);

  // ---- migration of legacy inline comments ----------------------------
  const [hasLegacy, setHasLegacy] = useState(() => hasLegacyComments(ytext.toString()));
  useEffect(() => {
    const update = () => setHasLegacy(hasLegacyComments(ytext.toString()));
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ytext]);
  const migrationAskedAtRef = useRef(0);
  useEffect(() => {
    if (!canWrite || !hasLegacy || !placements.settled) return;
    // Ask again if a replaced frame never answered.
    if (Date.now() - migrationAskedAtRef.current < MIGRATION_RETRY_MS) return;
    migrationAskedAtRef.current = Date.now();
    describeLegacy(parseLegacyComments(ytext.toString()).map(t => t.id));
  }, [canWrite, hasLegacy, placements, describeLegacy, ytext]);

  const onLegacyDescribed = useCallback((anchors: Record<string, HtmlAnchor | null>) => {
    if (!canWrite) return;
    const current = parseLegacyComments(ytext.toString());
    const existing = commentsMap(doc);
    doc.transact(() => {
      for (const t of current) {
        if (existing.has(t.id)) continue;
        const ts = Date.parse(t.ts) || Date.now();
        createThread(doc, ORIGIN, { id: t.id, anchor: anchors[t.id] ?? null, author: t.author, body: t.body, ts });
        for (const r of t.replies) {
          addMessage(doc, ORIGIN, t.id, { author: r.author, body: r.body, ts: Date.parse(r.ts) || ts + 1 });
        }
      }
      stripLegacyMarkers(ytext, ORIGIN);
    }, ORIGIN);
  }, [canWrite, doc, ytext]);

  // ---- actions ----------------------------------------------------------
  const split = (message: MessageView) => {
    const i = message.id.indexOf(SEP);
    return { threadId: message.id.slice(0, i), messageId: message.id.slice(i + 1) };
  };

  const callbacks = useMemo(() => ({
    onReply(thread: ThreadView, body: string) {
      addMessage(doc, ORIGIN, thread.key, { author: currentUser, authorId, body });
    },
    onEdit(message: MessageView, body: string) {
      const { threadId, messageId } = split(message);
      editMessage(doc, ORIGIN, threadId, messageId, body);
    },
    onDelete(message: MessageView) {
      const { threadId, messageId } = split(message);
      deleteMessage(doc, ORIGIN, threadId, messageId);
    },
  }), [authorId, currentUser, doc]);

  const create = useCallback((anchor: HtmlAnchor, body: string) => (
    createThread(doc, ORIGIN, { anchor, author: currentUser, authorId, body })
  ), [authorId, currentUser, doc]);

  const setStatus = useCallback((id: string, status: 'open' | 'resolved') => {
    setThreadStatus(doc, ORIGIN, id, status, currentUser);
  }, [currentUser, doc]);

  const reanchor = useCallback((id: string, anchor: HtmlAnchor) => {
    setThreadAnchor(doc, ORIGIN, id, anchor);
  }, [doc]);

  const counts = useMemo(() => {
    let open = 0;
    let resolved = 0;
    let orphaned = 0;
    let guessed = 0;
    for (const t of threads) {
      if (t.status === 'resolved') { resolved++; continue; }
      open++;
      const state = anchorInfo(t).state;
      if (state === 'orphaned') orphaned++;
      if (state === 'guessed') guessed++;
    }
    return { open, resolved, orphaned, guessed };
  }, [threads, anchorInfo]);

  return {
    threads,
    views,
    marks,
    placements,
    counts,
    callbacks,
    create,
    setStatus,
    reanchor,
    onThreadsResolved,
    onLegacyDescribed,
    migrating: hasLegacy,
  };
}
