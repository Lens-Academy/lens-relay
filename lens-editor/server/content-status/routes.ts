import { Hono } from 'hono';
import { requireEduShareToken } from '../edit-share-auth.ts';
import { bytesToText, fetchBytesWithTimeout, type FetchBytesResult } from '../fetch-timeout.ts';

/**
 * GET /api/content-status?path=&blob=&drafts= for the editor's content status
 * panel (src/components/ContentStatus). The editor server asks the platform's
 * GET /api/content/file-status with the shared validation key, so the
 * browser never calls the platform: it has neither the key nor the cause
 * cards' author names unless it holds a share token for the Lens Edu folder.
 *
 * Behind CONTENT_STATUS_ENABLED: when it is not "true", every request gets
 * 404 with code "disabled", and the panel hides itself for the session.
 */

export interface ContentStatusConfig {
  enabled: boolean;
  platformUrl?: string;
  secret?: string;
  /** Budget for one panel request, retries included. */
  timeoutMs?: number;
  /** First retry delay; later retries wait proportionally longer. */
  retryDelayMs?: number;
}

export function loadContentStatusConfig(env: NodeJS.ProcessEnv = process.env): ContentStatusConfig {
  return {
    enabled: env.CONTENT_STATUS_ENABLED === 'true',
    platformUrl: env.LENS_PLATFORM_URL?.trim() || undefined,
    secret: env.ADHOC_VALIDATION_SECRET?.trim() || undefined,
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 3;
// Gateway errors mean the edge could not reach the platform (a deploy, a
// restart); they are worth a retry. Other answers are the platform's own,
// its 503 included: that comes with Retry-After, which the panel waits for.
const GATEWAY_ERROR_STATUSES = new Set([502, 504]);
const BLOB_ID = /^[0-9a-f]{40}$/;

export function createContentStatusRoutes(config: ContentStatusConfig = loadContentStatusConfig()): Hono {
  const app = new Hono();

  if (!config.enabled) {
    app.all('*', c => c.json({ error: 'Content status is disabled', code: 'disabled' }, 404));
    return app;
  }

  // Every open panel asks every 5 to 30 s, so a platform problem is logged
  // when it starts, changes or ends, not on every request.
  let problem: string | null = null;
  const report = (next: string | null) => {
    if (next === problem) return;
    if (next) console.warn(`Content status: ${next}`);
    else console.info('Content status: the platform answers again');
    problem = next;
  };

  // Every role may read the status; the folder must be Lens Edu, because the
  // platform builds only that folder.
  app.use('*', requireEduShareToken({ minRole: 'view' }));

  app.get('/', async c => {
    const path = c.req.query('path') ?? '';
    const blob = c.req.query('blob') ?? '';
    const drafts = c.req.query('drafts') === '1' ? '1' : '0';
    if (!isContentPath(path)) {
      return c.json({ error: 'path must be a file path inside the Lens Edu folder, like Lenses/X.md' }, 400);
    }
    if (!BLOB_ID.test(blob)) {
      return c.json({ error: 'blob must be a 40-character Git blob id' }, 400);
    }
    if (!config.platformUrl || !config.secret) {
      return c.json(
        { error: 'Content status is enabled but not configured (LENS_PLATFORM_URL and ADHOC_VALIDATION_SECRET are required)', code: 'not_configured' },
        503,
      );
    }

    const query = new URLSearchParams({ path, blob, drafts });
    const url = `${config.platformUrl.replace(/\/$/, '')}/api/content/file-status?${query}`;
    let answer: FetchBytesResult;
    try {
      answer = await fetchWithRetries(url, { 'X-Validation-Key': config.secret }, config);
    } catch (error) {
      // fetch's own message is "fetch failed"; the reason is in its cause.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      report(`the platform did not answer (${error instanceof Error ? error.message : String(error)}${cause})`);
      return c.json({ error: 'The platform did not answer', code: 'unavailable' }, 504);
    }

    const body = bytesToText(answer.bytes);
    if (answer.status === 404) {
      report(null);
      return c.json({ error: 'The platform has no status for this file yet', code: 'not_found' }, 404);
    }
    if (answer.status !== 200) {
      report(`the platform answered ${answer.status}: ${body.slice(0, 200)}`);
      if (answer.status !== 503) {
        return c.json({ error: `The platform answered ${answer.status}`, code: 'unavailable' }, 502);
      }
      // The platform's own "not now" (a cold build, content not loaded yet),
      // passed on with the time it asks for.
      const retryAfter = answer.headers.get('Retry-After');
      if (retryAfter) c.header('Retry-After', retryAfter);
      const detail = detailOf(body);
      return c.json({ error: `The platform is not ready${detail ? `: ${detail}` : ''}`, code: 'unavailable' }, 503);
    }
    try {
      const status = JSON.parse(body);
      report(null);
      return c.json(status);
    } catch {
      report('the platform answered with malformed JSON');
      return c.json({ error: 'The platform answered with malformed JSON', code: 'unavailable' }, 502);
    }
  });

  app.all('*', c => c.json({ error: 'Content status route not found' }, 404));
  return app;
}

/** A repository path like `Lenses/X.md`: relative, no `.`/`..` or empty parts. */
function isContentPath(path: string): boolean {
  return path.length > 0
    && path.length <= 1024
    && !path.includes('\\')
    && !path.includes('\0')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** The platform's own words: FastAPI answers an error as `{"detail": ...}`. */
function detailOf(body: string): string | undefined {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
    return typeof detail === 'string' ? detail : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET within one budget, asked again after a gateway error or a network
 * failure, MAX_ATTEMPTS times at most. Each attempt holds its own timer for
 * the whole request, the body included (fetch-timeout.ts says why).
 */
async function fetchWithRetries(
  url: string,
  headers: Record<string, string>,
  config: ContentStatusConfig,
): Promise<FetchBytesResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await fetchBytesWithTimeout(url, { headers, timeoutMs: deadline - Date.now() });
      if (!GATEWAY_ERROR_STATUSES.has(answer.status) || attempt >= MAX_ATTEMPTS) return answer;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
    }
    const wait = retryDelayMs * attempt;
    if (Date.now() + wait >= deadline) throw new Error(`No answer from the platform within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}
