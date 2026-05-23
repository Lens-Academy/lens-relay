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
  /** Inclusive start index in source of the parent comment marker. */
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
      const cluster: CommentCluster = {
        comment: { kind: 'comment', id: payload.id, author: payload.author, ts: payload.ts, body: payload.body },
        replies: [],
        sourceStart: found.start,
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
