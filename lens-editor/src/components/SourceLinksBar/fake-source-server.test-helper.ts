import { vi } from 'vitest';
import type {
  ImportResultRow,
  LinkBackRequest,
  SourceLinkStatus,
} from '../../../shared/source-links-contract';

export interface ImportCall {
  urls: string[];
  importMode: string;
  linkBack: LinkBackRequest;
}

/**
 * The import API as far as the bar sees it, for a mocked `fetch`. `links` holds
 * what a check says of a URL; any other URL is `new`, unless in `notSources`.
 */
export class FakeSourceServer {
  ready = true;
  queue = { workers: 2, avg_job_minutes: 4, queued: 0, processing: 0 };
  links = new Map<string, Partial<SourceLinkStatus>>();
  notSources = new Set<string>();
  /** Answers every check with this status (403, 500), or `failing` with a network error. */
  checkStatus = 200;
  failing = false;
  /** An import row to answer with, by URL; default: queued with a job. */
  importRows = new Map<string, Partial<ImportResultRow>>();
  importStatus = 200;
  importError: string | undefined;
  /** Job ids a cancel can't stop. */
  uncancellable = new Set<string>();
  /** Job ids with another page's link-back: a cancel only lets go of this page. */
  shared = new Set<string>();
  retryStatus = 200;
  /** Holds back the answers to checks, as they stood when asked, until `release()`. */
  hold = false;
  private held: Array<() => void> = [];

  checks: string[][] = [];
  checkPaths: Array<string | undefined> = [];
  imports: ImportCall[] = [];
  cancels: string[][] = [];
  cancelPaths: Array<string | undefined> = [];
  retries: string[] = [];
  headers: Array<Record<string, string>> = [];

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    this.headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/api/add-article/links/check') {
      this.checkPaths.push(body.path);
      return this.check(body.urls);
    }
    if (path === '/api/add-article') return this.import(body);
    if (path === '/api/add-article/cancel') {
      this.cancelPaths.push(body.path);
      return this.cancel(body.ids);
    }
    const retry = /^\/api\/add-article\/(.+)\/retry$/.exec(path);
    if (retry) return this.retry(retry[1]);
    throw new Error(`Unexpected request: ${path}`);
  });

  install() {
    vi.stubGlobal('fetch', this.fetch);
  }

  /** The requests made so far, of any kind. */
  get requests(): number {
    return this.fetch.mock.calls.length;
  }

  release() {
    this.hold = false;
    const held = this.held;
    this.held = [];
    held.forEach((run) => run());
  }

  /** Says of a URL from now on. */
  set(url: string, status: Partial<SourceLinkStatus>) {
    this.links.set(url, status);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private async check(urls: string[]): Promise<Response> {
    this.checks.push(urls);
    const links = urls
      .filter((url) => !this.notSources.has(url))
      .map((url) => ({ url, key: url, kind: 'article', state: 'new', ...this.links.get(url) }));
    const answer = { ready: this.ready, links, queue: this.queue };
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.failing) throw new TypeError('Failed to fetch');
    if (this.checkStatus !== 200) return this.json({ error: 'Refused' }, this.checkStatus);
    return this.json(answer);
  }

  private import(call: ImportCall): Response {
    this.imports.push(call);
    if (this.failing) throw new TypeError('Failed to fetch');
    if (this.importStatus !== 200) return this.json({ error: this.importError }, this.importStatus);
    const results = call.urls.map((url) => {
      const row = { url, status: 'queued', id: `job:${url}`, eta_minutes: 8, ...this.importRows.get(url) };
      if (row.status === 'queued' || row.status === 'already_queued') {
        this.set(url, { state: 'queued', job_id: row.id, eta_minutes: row.eta_minutes });
      }
      return row;
    });
    return this.json({ results, queue: { ...this.queue, message: 'Extra fields the bar has no use for' } });
  }

  private cancel(ids: string[]): Response {
    this.cancels.push(ids);
    const results = ids.map((id) => (this.shared.has(id)
      ? { id, cancelled: false, detached: true }
      : { id, cancelled: !this.uncancellable.has(id) }));
    for (const [url, link] of this.links) {
      if (link.job_id && !this.uncancellable.has(link.job_id) && ids.includes(link.job_id)) this.links.delete(url);
    }
    return this.json({ results });
  }

  private retry(id: string): Response {
    this.retries.push(decodeURIComponent(id));
    if (this.retryStatus === 409) return this.json({ error: 'URL is already queued', id: 'running-job' }, 409);
    if (this.retryStatus !== 200) return this.json({ error: 'Refused' }, this.retryStatus);
    return this.json({ id: `${decodeURIComponent(id)}-again`, status: 'queued' });
  }
}
