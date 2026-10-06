import { Hono } from 'hono';
import { shareTokenFromHeaders, verifyShareToken } from '../share-token.ts';
import { EDU_FOLDER_NAME, tokenAllowsFolderName } from '../edit-share-auth.ts';

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
  fetchImpl?: typeof fetch;
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
// restart); they are worth a retry. Other answers are the platform's own.
const GATEWAY_ERROR_STATUSES = new Set([502, 503, 504]);
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

  app.use('*', async (c, next) => {
    const token = shareTokenFromHeaders(c.req.header('X-Share-Token'), c.req.header('Authorization'));
    const payload = token ? verifyShareToken(token) : null;
    if (!payload) {
      return c.json({ error: 'Content status authentication required' }, 401);
    }
    // Every role may read the status; the folder must be Lens Edu, because
    // the platform builds only that folder.
    if (payload.purpose !== 'share' || !tokenAllowsFolderName(payload, EDU_FOLDER_NAME)) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }
    await next();
  });

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
    let answer: { status: number; body: string };
    try {
      answer = await fetchWithRetries(url, { headers: { 'X-Validation-Key': config.secret } }, config);
    } catch (error) {
      // fetch's own message is "fetch failed"; the reason is in its cause.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      report(`the platform did not answer (${error instanceof Error ? error.message : String(error)}${cause})`);
      return c.json({ error: 'The platform did not answer', code: 'unavailable' }, 504);
    }

    if (answer.status === 404) {
      report(null);
      return c.json({ error: 'The platform has no status for this file yet', code: 'not_found' }, 404);
    }
    if (answer.status !== 200) {
      report(`the platform answered ${answer.status}: ${answer.body.slice(0, 200)}`);
      return c.json({ error: `The platform answered ${answer.status}`, code: 'unavailable' }, 502);
    }
    try {
      const status = JSON.parse(answer.body);
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

/**
 * GET with up to two retries on network errors and gateway errors, all within
 * one deadline. The controller and its timer are held for the whole call and
 * the body is read before the timer is cleared (see fetch-timeout.ts: a bare
 * AbortSignal.timeout once let a request hang for hours).
 */
async function fetchWithRetries(
  url: string,
  init: RequestInit,
  config: ContentStatusConfig,
): Promise<{ status: number; body: string }> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`No answer from the platform within ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        const body = await response.text();
        if (!GATEWAY_ERROR_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS) {
          return { status: response.status, body };
        }
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (attempt >= MAX_ATTEMPTS) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const wait = setTimeout(resolve, retryDelayMs * attempt);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(wait);
          reject(controller.signal.reason);
        }, { once: true });
      });
    }
  } finally {
    clearTimeout(timer);
  }
}
