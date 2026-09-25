/**
 * HTML-page comment threads, stored out of band in the content doc:
 *
 *   doc.getMap('comments_v0'): thread id → Y.Map {
 *     anchor:    HtmlAnchor (plain JSON, see anchoring/types.ts)
 *     status:    'open' | 'resolved'
 *     createdAt: epoch ms          createdBy: display name
 *     resolvedAt?, resolvedBy?     set while resolved
 *     seen?:     { state, at }     last anchor state an editor saw, for agents
 *     originalQuote?: string       the quote as first commented, once the
 *                                  anchor has been refreshed after edits
 *     messages:  Y.Map<message id, { id, author, authorId?, ts, body, editedAt? }>
 *   }
 *
 * Messages are keyed by id inside a nested map, so concurrent replies, edits
 * and resolves never conflict. The relay reads and writes the same shape
 * (crates/relay/src/mcp/tools/html_comments.rs).
 */
import * as Y from 'yjs';
import { readAnchor, type AnchorState, type HtmlAnchor } from '../anchoring/types';

export const COMMENTS_MAP = 'comments_v0';
const MAX_BODY_CHARS = 10_000;

export interface ThreadMessage {
  id: string;
  author: string;
  /** Per-browser id of the author (`ai:<actor>` for agents); edit/delete
   *  rights follow it, not the display name. */
  authorId?: string;
  ts: number;
  body: string;
  editedAt?: number;
}

export interface HtmlThread {
  id: string;
  anchor: HtmlAnchor | null;
  status: 'open' | 'resolved';
  createdAt: number;
  createdBy: string;
  resolvedAt?: number;
  resolvedBy?: string;
  seen?: { state: AnchorState; at: number };
  originalQuote?: string;
  messages: ThreadMessage[];
}

export function commentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(COMMENTS_MAP);
}

function readMessage(value: unknown): ThreadMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.body !== 'string') return null;
  return {
    id: m.id,
    author: typeof m.author === 'string' ? m.author : 'Unknown',
    ...(typeof m.authorId === 'string' ? { authorId: m.authorId } : {}),
    ts: typeof m.ts === 'number' ? m.ts : 0,
    body: m.body,
    ...(typeof m.editedAt === 'number' ? { editedAt: m.editedAt } : {}),
  };
}

function readSeen(value: unknown): HtmlThread['seen'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const states: AnchorState[] = ['anchored', 'guessed', 'hidden', 'orphaned'];
  if (!states.includes(v.state as AnchorState) || typeof v.at !== 'number') return undefined;
  return { state: v.state as AnchorState, at: v.at };
}

export function readThread(id: string, thread: Y.Map<unknown>): HtmlThread | null {
  if (!(thread instanceof Y.Map)) return null;
  const messagesMap = thread.get('messages');
  const messages = messagesMap instanceof Y.Map
    ? Array.from(messagesMap.values()).map(readMessage).filter((m): m is ThreadMessage => m !== null)
    : [];
  if (messages.length === 0) return null;
  messages.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const str = (key: string) => {
    const v = thread.get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const num = (key: string) => {
    const v = thread.get(key);
    return typeof v === 'number' ? v : undefined;
  };
  const seen = readSeen(thread.get('seen'));
  const originalQuote = str('originalQuote');
  return {
    id,
    anchor: readAnchor(thread.get('anchor')),
    status: str('status') === 'resolved' ? 'resolved' : 'open',
    createdAt: num('createdAt') ?? messages[0].ts,
    createdBy: str('createdBy') ?? messages[0].author,
    ...(num('resolvedAt') !== undefined ? { resolvedAt: num('resolvedAt') } : {}),
    ...(str('resolvedBy') !== undefined ? { resolvedBy: str('resolvedBy') } : {}),
    ...(seen ? { seen } : {}),
    ...(originalQuote ? { originalQuote } : {}),
    messages,
  };
}

export function readThreads(doc: Y.Doc): HtmlThread[] {
  const out: HtmlThread[] = [];
  commentsMap(doc).forEach((value, id) => {
    const thread = readThread(id, value);
    if (thread) out.push(thread);
  });
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

export function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function messageValue(message: ThreadMessage): Record<string, unknown> {
  return {
    id: message.id,
    author: message.author,
    ...(message.authorId ? { authorId: message.authorId } : {}),
    ts: message.ts,
    body: message.body.slice(0, MAX_BODY_CHARS),
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
  };
}

export interface NewThread {
  id?: string;
  /** Null for a thread whose target is unknown (a migrated comment that no
   *  longer rendered anywhere): it shows as orphaned until re-attached. */
  anchor: HtmlAnchor | null;
  author: string;
  authorId?: string;
  body: string;
  ts?: number;
}

export function createThread(doc: Y.Doc, origin: unknown, input: NewThread): string {
  const id = input.id ?? makeId();
  const ts = input.ts ?? Date.now();
  doc.transact(() => {
    const thread = new Y.Map<unknown>();
    const messages = new Y.Map<unknown>();
    const messageId = makeId();
    messages.set(messageId, messageValue({
      id: messageId, author: input.author, authorId: input.authorId, ts, body: input.body,
    }));
    if (input.anchor) thread.set('anchor', input.anchor);
    thread.set('status', 'open');
    thread.set('createdAt', ts);
    thread.set('createdBy', input.author);
    thread.set('messages', messages);
    commentsMap(doc).set(id, thread);
  }, origin);
  return id;
}

function threadMap(doc: Y.Doc, threadId: string): Y.Map<unknown> | null {
  const thread = commentsMap(doc).get(threadId);
  return thread instanceof Y.Map ? thread : null;
}

function messagesOf(doc: Y.Doc, threadId: string): Y.Map<unknown> | null {
  const messages = threadMap(doc, threadId)?.get('messages');
  return messages instanceof Y.Map ? messages : null;
}

export function addMessage(
  doc: Y.Doc,
  origin: unknown,
  threadId: string,
  input: { author: string; authorId?: string; body: string; ts?: number },
): string | null {
  const messages = messagesOf(doc, threadId);
  if (!messages) return null;
  const id = makeId();
  doc.transact(() => {
    messages.set(id, messageValue({ id, author: input.author, authorId: input.authorId, ts: input.ts ?? Date.now(), body: input.body }));
    // A reply reopens a resolved thread, as in most review tools.
    const thread = threadMap(doc, threadId);
    if (thread?.get('status') === 'resolved') {
      thread.set('status', 'open');
      thread.delete('resolvedAt');
      thread.delete('resolvedBy');
    }
  }, origin);
  return id;
}

export function editMessage(doc: Y.Doc, origin: unknown, threadId: string, messageId: string, body: string): void {
  const messages = messagesOf(doc, threadId);
  const current = messages ? readMessage(messages.get(messageId)) : null;
  if (!messages || !current) return;
  doc.transact(() => {
    messages.set(messageId, messageValue({ ...current, body, editedAt: Date.now() }));
  }, origin);
}

/** Delete one message; deleting a thread's first message deletes the thread. */
export function deleteMessage(doc: Y.Doc, origin: unknown, threadId: string, messageId: string): void {
  const thread = readThread(threadId, commentsMap(doc).get(threadId) as Y.Map<unknown>);
  if (!thread) return;
  doc.transact(() => {
    if (thread.messages[0]?.id === messageId) commentsMap(doc).delete(threadId);
    else messagesOf(doc, threadId)?.delete(messageId);
  }, origin);
}

export function setThreadStatus(doc: Y.Doc, origin: unknown, threadId: string, status: 'open' | 'resolved', by: string): void {
  const thread = threadMap(doc, threadId);
  if (!thread) return;
  doc.transact(() => {
    thread.set('status', status);
    if (status === 'resolved') {
      thread.set('resolvedAt', Date.now());
      thread.set('resolvedBy', by);
    } else {
      thread.delete('resolvedAt');
      thread.delete('resolvedBy');
    }
  }, origin);
}

/** Point a thread at a new anchor (re-attached, confirmed, or refreshed after
 *  the page changed), remembering what was originally commented on. */
export function setThreadAnchor(doc: Y.Doc, origin: unknown, threadId: string, anchor: HtmlAnchor): void {
  const thread = threadMap(doc, threadId);
  if (!thread) return;
  const previous = readAnchor(thread.get('anchor'));
  doc.transact(() => {
    if (previous?.kind === 'text' && !thread.get('originalQuote')
      && !(anchor.kind === 'text' && anchor.quote === previous.quote)) {
      thread.set('originalQuote', previous.quote);
    }
    thread.set('anchor', anchor);
    thread.delete('seen');
  }, origin);
}

export function recordSeen(doc: Y.Doc, origin: unknown, threadId: string, state: AnchorState): void {
  const thread = threadMap(doc, threadId);
  if (!thread) return;
  const seen = readSeen(thread.get('seen'));
  if (seen?.state === state) return;
  doc.transact(() => thread.set('seen', { state, at: Date.now() }), origin);
}

const AUTHOR_ID_KEY = 'lens-comment-author-id';
let memoryAuthorId: string | null = null;

/** This browser's comment-author id: who may edit or delete a message. */
export function localAuthorId(): string {
  try {
    const existing = localStorage.getItem(AUTHOR_ID_KEY);
    if (existing) return existing;
    const id = makeId();
    localStorage.setItem(AUTHOR_ID_KEY, id);
    return id;
  } catch {
    memoryAuthorId ??= makeId();
    return memoryAuthorId;
  }
}
