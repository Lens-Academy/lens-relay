import { relayHeaders } from './relay-api';

/**
 * Client of the editor server's GET /api/content-status, which forwards to
 * the platform's GET /api/content/file-status (server/content-status/routes.ts).
 * Types follow the platform contract; issues name their file `file`, as the
 * processor's ContentError does.
 */

export interface ContentIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning';
  category?: 'production' | 'wip';
  code?: string;
  message: string;
  suggestion?: string;
}

/**
 * What broke, which change did it, what changed, who, and how sure. The
 * platform writes the last two as sentences, so that the panel says what the
 * platform's own pages say.
 */
export interface CauseCard {
  id: string;
  created_at: string;
  commit: string;
  previous_commit?: string;
  error: { file: string; line?: number; severity: string; message: string };
  what_broke: string;
  lost_content?: Array<{ page: string; title: string; section?: string }>;
  changes?: Array<{ file: string; summary: string; hunk?: string }>;
  /** Who made the changes, e.g. "Changed by Luc." */
  who_text?: string;
  /** "Caused by this change.", "Caused by one of these changes." or "The cause is not known." */
  certainty_text?: string;
}

export type PublishedState = 'published' | 'pending' | 'behind' | 'missing';
const PUBLISHED_STATES: ReadonlySet<unknown> = new Set<PublishedState>(['published', 'pending', 'behind', 'missing']);

/** A file's status as the panel shows it: the lists are always there. */
export interface FileStatus {
  path: string;
  /** False when the platform does not build this path (not course content). */
  content: boolean;
  processed?: { commit: string; commit_time: string; processed_at: string };
  published?: { state: PublishedState; blob?: string };
  issues: ContentIssue[];
  cause_cards: { caused_here: CauseCard[]; broken_by: CauseCard[] };
  used_by: Array<{ page: string; title: string; reads: 'text' | 'facts' }>;
  /** Only when asked for and the file has pending suggestions: the check of
   * the committed text with every suggestion accepted. */
  drafts?: { pending: number; issues: ContentIssue[]; new_elsewhere: ContentIssue[] };
}

export type ContentStatusResult =
  /** The editor server has the panel switched off: hide it for the session. */
  | { kind: 'disabled' }
  /** The platform has nothing for this file yet (no build yet). */
  | { kind: 'not_found' }
  /** `retryAfterMs`: how long a busy platform asked to be left alone. */
  | { kind: 'error'; message: string; retryAfterMs?: number }
  | { kind: 'ok'; status: FileStatus };

let disabledForSession = false;

/** Never throws: whatever goes wrong is an error result, and the panel asks again. */
export async function fetchContentStatus(
  path: string,
  blob: string,
  drafts: boolean,
  signal?: AbortSignal,
): Promise<ContentStatusResult> {
  if (disabledForSession) return { kind: 'disabled' };
  const query = new URLSearchParams({ path, blob, drafts: drafts ? '1' : '0' });
  let response: Response;
  try {
    response = await fetch(`/api/content-status?${query}`, { headers: relayHeaders(), signal });
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const fields = isRecord(body) ? body : {};
  // The switch is off (404 "disabled"), or the server predates the route and
  // answers with the app's HTML shell (200, not JSON).
  if ((response.ok && body === undefined) || (response.status === 404 && fields.code === 'disabled')) {
    disabledForSession = true;
    return { kind: 'disabled' };
  }
  if (response.status === 404) return { kind: 'not_found' };
  if (!response.ok) {
    const retryAfterMs = untilRetry(response.headers.get('Retry-After'));
    return {
      kind: 'error',
      message: typeof fields.error === 'string' ? fields.error : `HTTP ${response.status}`,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }
  const status = fileStatus(body);
  return status
    ? { kind: 'ok', status }
    : { kind: 'error', message: 'The platform answered in an unknown format' };
}

/**
 * The answer as the panel shows it, or null when it is not a file status.
 * A list the panel shows is always a list of objects, and a part it cannot
 * read is left out, so that a partial answer cannot break the editor.
 */
function fileStatus(body: unknown): FileStatus | null {
  if (!isRecord(body) || typeof body.path !== 'string' || typeof body.content !== 'boolean') return null;
  const { processed, published, cause_cards: cards, drafts } = body;
  return {
    path: body.path,
    content: body.content,
    processed: isRecord(processed) && typeof processed.commit === 'string' && typeof processed.processed_at === 'string'
      ? processed as FileStatus['processed']
      : undefined,
    published: isRecord(published) && PUBLISHED_STATES.has(published.state)
      ? published as FileStatus['published']
      : undefined,
    issues: records(body.issues),
    cause_cards: {
      caused_here: records(isRecord(cards) ? cards.caused_here : undefined),
      broken_by: records(isRecord(cards) ? cards.broken_by : undefined),
    },
    used_by: records(body.used_by),
    drafts: isRecord(drafts)
      ? {
        pending: typeof drafts.pending === 'number' ? drafts.pending : 0,
        issues: records(drafts.issues),
        new_elsewhere: records(drafts.new_elsewhere),
      }
      : undefined,
  };
}

/** A Retry-After value in ms from now: seconds, or an HTTP date (RFC 9110). */
function untilRetry(value: string | null): number {
  const text = value?.trim() ?? '';
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  return Number.isFinite(ms) ? ms : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The objects in `value` when it is a list, else none. */
function records<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter(isRecord) as T[] : [];
}

/**
 * Git's blob id of `text` (SHA-1 of "blob <byte length>\0" + its UTF-8
 * bytes): the id the file gets when relay-git-sync commits this text, so the
 * platform can tell whether its processed commit has it. Null outside a
 * secure context, where the browser has no crypto.subtle.
 */
export async function gitBlobId(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const encoder = new TextEncoder();
  const body = encoder.encode(text);
  const header = encoder.encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = new Uint8Array(await subtle.digest('SHA-1', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
