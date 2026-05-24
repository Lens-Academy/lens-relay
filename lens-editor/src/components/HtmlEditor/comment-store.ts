import type * as Y from 'yjs';

export interface CommentMarker {
  kind: 'comment';
  id: string;
  author: string;
  ts: string;
  body: string;
}

export interface ReplyMarker {
  kind: 'reply';
  id: string;
  parent: string;
  author: string;
  ts: string;
  body: string;
}

export interface CommentCluster {
  comment: CommentMarker;
  replies: ReplyMarker[];
  /** Inclusive start index in source of the parent comment anchor, or marker when no anchor exists. */
  sourceStart: number;
  /** Exclusive end index in source of the last marker in the cluster (parent or last reply). */
  sourceEnd: number;
}

function encodePayload<T extends Record<string, unknown>>(payload: T): string {
  return JSON.stringify(payload).replace(/-->/g, '\\u002d\\u002d>');
}

export function serializeComment(m: CommentMarker): string {
  const { id, author, ts, body } = m;
  return `<!--lens-comment ${encodePayload({ id, author, ts, body })}-->`;
}

export function serializeCommentAnchor(id: string): string {
  return `[[@comment:${id}]]`;
}

export function serializeReply(m: ReplyMarker): string {
  const { id, parent, author, ts, body } = m;
  return `<!--lens-reply ${encodePayload({ id, parent, author, ts, body })}-->`;
}

export interface FoundMarker {
  kind: 'comment' | 'reply';
  payloadStart: number;
  payloadEnd: number;
  markerEnd: number;
  start: number;
}

export function findNextMarker(source: string, from: number): FoundMarker | null {
  let scan = from;
  while (scan < source.length) {
    const start = source.indexOf('<!--lens-', scan);
    if (start === -1) return null;
    const after = start + '<!--lens-'.length;
    let kind: 'comment' | 'reply' | null = null;
    let payloadStart = -1;
    if (source.startsWith('comment ', after)) {
      kind = 'comment';
      payloadStart = after + 'comment '.length;
    } else if (source.startsWith('reply ', after)) {
      kind = 'reply';
      payloadStart = after + 'reply '.length;
    } else {
      scan = after;
      continue;
    }
    if (source[payloadStart] !== '{') { scan = after; continue; }
    let depth = 0;
    let inString = false;
    let escape = false;
    let i = payloadStart;
    for (; i < source.length; i++) {
      const c = source[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (inString) {
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) { scan = after; continue; }
    const payloadEnd = i;
    if (!source.startsWith('-->', payloadEnd)) { scan = after; continue; }
    return { kind, payloadStart, payloadEnd, markerEnd: payloadEnd + 3, start };
  }
  return null;
}

export function parsePayload(raw: string): Record<string, string> | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function parseComments(source: string): CommentCluster[] {
  const clusters: CommentCluster[] = [];
  let current: CommentCluster | null = null;
  let from = 0;
  while (true) {
    const found = findNextMarker(source, from);
    if (!found) break;
    from = found.markerEnd;
    const payload = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
    if (!payload) continue;
    if (found.kind === 'comment') {
      if (!payload.id || !payload.author || !payload.ts || payload.body === undefined) continue;
      const anchor = serializeCommentAnchor(payload.id);
      const anchorStart = source.slice(Math.max(0, found.start - anchor.length), found.start) === anchor
        ? found.start - anchor.length
        : found.start;
      const cluster: CommentCluster = {
        comment: { kind: 'comment', id: payload.id, author: payload.author, ts: payload.ts, body: payload.body },
        replies: [],
        sourceStart: anchorStart,
        sourceEnd: found.markerEnd,
      };
      clusters.push(cluster);
      current = cluster;
    } else {
      if (!payload.id || !payload.parent || !payload.author || !payload.ts || payload.body === undefined) continue;
      if (!current || payload.parent !== current.comment.id) continue;
      if (source.slice(current.sourceEnd, found.start).trim() !== '') continue;
      current.replies.push({ kind: 'reply', id: payload.id, parent: payload.parent, author: payload.author, ts: payload.ts, body: payload.body });
      current.sourceEnd = found.markerEnd;
    }
  }
  return clusters;
}

export interface AddCommentInput {
  id: string;
  author: string;
  ts: string;
  body: string;
  position: number;
}

export function addComment(ytext: Y.Text, origin: unknown, input: AddCommentInput): void {
  const marker = serializeCommentAnchor(input.id) + serializeComment({
    kind: 'comment',
    id: input.id,
    author: input.author,
    ts: input.ts,
    body: input.body,
  });
  ytext.doc!.transact(() => {
    ytext.insert(input.position, marker);
  }, origin);
}

export interface AddReplyInput {
  id: string;
  parent: string;
  author: string;
  ts: string;
  body: string;
}

export function addReply(ytext: Y.Text, origin: unknown, input: AddReplyInput): void {
  const source = ytext.toString();
  const clusters = parseComments(source);
  const cluster = clusters.find(c => c.comment.id === input.parent);
  if (!cluster) throw new Error(`addReply: no parent comment with id ${input.parent}`);
  const insertAt = cluster.sourceEnd;
  const marker = serializeReply({
    kind: 'reply',
    id: input.id,
    parent: input.parent,
    author: input.author,
    ts: input.ts,
    body: input.body,
  });
  ytext.doc!.transact(() => {
    ytext.insert(insertAt, marker);
  }, origin);
}

interface MessageLocation {
  start: number;
  end: number;
  kind: 'comment' | 'reply';
  current: CommentMarker | ReplyMarker;
}

function payloadMatchesComment(payload: Record<string, string> | null, comment: CommentMarker): boolean {
  return payload?.id === comment.id &&
    payload.author === comment.author &&
    payload.ts === comment.ts &&
    payload.body === comment.body;
}

function payloadMatchesReply(payload: Record<string, string> | null, reply: ReplyMarker): boolean {
  return payload?.id === reply.id &&
    payload.parent === reply.parent &&
    payload.author === reply.author &&
    payload.ts === reply.ts &&
    payload.body === reply.body;
}

function findValidReplyInCluster(source: string, cluster: CommentCluster, reply: ReplyMarker): MessageLocation | null {
  let from = cluster.sourceStart;
  while (from < cluster.sourceEnd) {
    const found = findNextMarker(source, from);
    if (!found || found.start >= cluster.sourceEnd) return null;
    from = found.markerEnd;
    if (found.markerEnd > cluster.sourceEnd || found.kind !== 'reply') continue;
    const payload = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
    if (!payloadMatchesReply(payload, reply)) continue;
    return {
      start: found.start,
      end: found.markerEnd,
      kind: 'reply',
      current: reply,
    };
  }
  return null;
}

function findMessage(source: string, id: string): MessageLocation | null {
  const clusters = parseComments(source);
  for (const cluster of clusters) {
    if (cluster.comment.id === id) {
      const found = findNextMarker(source, cluster.sourceStart);
      if (!found || found.start >= cluster.sourceEnd || found.kind !== 'comment') return null;
      const payload = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
      if (!payloadMatchesComment(payload, cluster.comment)) return null;
      return {
        start: found.start,
        end: found.markerEnd,
        kind: 'comment',
        current: cluster.comment,
      };
    }
    const reply = cluster.replies.find(r => r.id === id);
    if (!reply) continue;
    return findValidReplyInCluster(source, cluster, reply);
  }
  return null;
}

function findDeleteTarget(source: string, id: string): { start: number; end: number } | null {
  const clusters = parseComments(source);
  for (const cluster of clusters) {
    if (cluster.comment.id === id) {
      return { start: cluster.sourceStart, end: cluster.sourceEnd };
    }
    const reply = cluster.replies.find(r => r.id === id);
    if (!reply) continue;
    const loc = findValidReplyInCluster(source, cluster, reply);
    if (!loc) throw new Error(`deleteMessage: reply ${id} bounds not found`);
    return { start: loc.start, end: loc.end };
  }
  return null;
}

export interface EditMessageInput {
  id: string;
  newBody: string;
}

export function editMessage(ytext: Y.Text, origin: unknown, input: EditMessageInput): void {
  const source = ytext.toString();
  const loc = findMessage(source, input.id);
  if (!loc) throw new Error(`editMessage: no message with id ${input.id}`);
  const replacement = loc.kind === 'comment'
    ? serializeComment({ ...(loc.current as CommentMarker), body: input.newBody })
    : serializeReply({ ...(loc.current as ReplyMarker), body: input.newBody });
  ytext.doc!.transact(() => {
    ytext.delete(loc.start, loc.end - loc.start);
    ytext.insert(loc.start, replacement);
  }, origin);
}

export function deleteMessage(ytext: Y.Text, origin: unknown, id: string): void {
  const source = ytext.toString();
  const target = findDeleteTarget(source, id);
  if (!target) throw new Error(`deleteMessage: no message with id ${id}`);
  ytext.doc!.transact(() => {
    ytext.delete(target.start, target.end - target.start);
  }, origin);
}
