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

/** What broke, which change did it, what changed, who, and how sure. */
export interface CauseCard {
  id: string;
  created_at: string;
  commit: string;
  previous_commit?: string;
  error: { file: string; line?: number; severity: string; message: string };
  what_broke: string;
  lost_content?: Array<{ page: string; title: string; section?: string }>;
  changes?: Array<{ file: string; summary: string; hunk?: string }>;
  authors?: { names: string[]; unknown: boolean; files_in_sync?: number; editors_in_sync?: number };
  certainty: 'this_change' | 'one_of_these' | 'unknown';
}

export type PublishedState = 'published' | 'pending' | 'behind' | 'missing';

export interface FileStatus {
  path: string;
  /** False when the platform does not build this path (not course content). */
  content: boolean;
  processed?: { commit: string; commit_time: string; processed_at: string };
  published?: { state: PublishedState; blob?: string };
  issues?: ContentIssue[];
  cause_cards?: { caused_here: CauseCard[]; broken_by: CauseCard[] };
  used_by?: Array<{ page: string; title: string; reads: 'text' | 'facts' }>;
  /** Only when asked for and the file has pending suggestions: the check of
   * the committed text with every suggestion accepted. */
  drafts?: { pending: number; issues: ContentIssue[]; new_elsewhere: ContentIssue[] };
}

export type ContentStatusResult =
  /** The editor server has the panel switched off: hide it for the session. */
  | { kind: 'disabled' }
  /** The platform has nothing for this file yet (no build yet). */
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; status: FileStatus };

let disabledForSession = false;

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
  const body = await response.json().catch(() => undefined) as
    | (FileStatus & { error?: string; code?: string })
    | undefined;
  // The switch is off (404 "disabled"), or the server predates the route and
  // answers with the app's HTML shell (200, not JSON).
  if ((response.ok && body === undefined) || (response.status === 404 && body?.code === 'disabled')) {
    disabledForSession = true;
    return { kind: 'disabled' };
  }
  if (response.status === 404) return { kind: 'not_found' };
  if (!response.ok || body === undefined) {
    return { kind: 'error', message: body?.error ?? `HTTP ${response.status}` };
  }
  if (typeof body.path !== 'string' || typeof body.content !== 'boolean') {
    return { kind: 'error', message: 'The platform answered in an unknown format' };
  }
  return { kind: 'ok', status: body };
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
