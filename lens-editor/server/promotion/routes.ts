import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { verifyShareToken } from '../share-token.ts';
import { PromotionError, type PromotionPrResponse } from './types.ts';

const PROMOTION_ERROR_STATUS_CODES = [
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
  415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451, 500,
  501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
] as const satisfies readonly ContentfulStatusCode[];

type PromotionErrorStatusCode = (typeof PROMOTION_ERROR_STATUS_CODES)[number];

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';

export interface PromotionRouteService {
  getChanges(): Promise<unknown>;
  getStatus(path: string): Promise<unknown>;
  getDiff(path: string): Promise<unknown>;
  createPromotionPr(input: { paths: string[]; title?: string }): Promise<PromotionPrResponse>;
}

export function createPromotionRoutes(service: PromotionRouteService): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof PromotionError) {
      const status = toPromotionErrorStatusCode(error.status);
      if (status >= 500) {
        console.error('Promotion request failed', error);
        return c.json({ error: 'Promotion request failed', code: error.code }, status);
      }
      return c.json({ error: error.message, code: error.code }, status);
    }

    console.error('Promotion request failed', error);
    return c.json({ error: 'Promotion request failed' }, 500);
  });

  app.use('*', async (c, next) => {
    const token = extractPromotionToken(c.req.header('X-Share-Token'), c.req.header('Authorization'));
    if (!token) {
      return c.json({ error: 'Promotion authentication required' }, 401);
    }

    const payload = verifyShareToken(token);
    if (!payload) {
      return c.json({ error: 'Promotion authentication required' }, 401);
    }
    if (payload.purpose !== 'share' || payload.role !== 'edit') {
      return c.json({ error: 'Promotion requires an edit share token' }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }

    await next();
  });

  app.get('/changes', async c => c.json(await service.getChanges()));

  app.get('/status', async c => {
    const path = c.req.query('path');
    if (!path) throw new PromotionError(400, 'path query parameter is required', 'missing_path');
    return c.json(await service.getStatus(path));
  });

  app.get('/diff', async c => {
    const path = c.req.query('path');
    if (!path) throw new PromotionError(400, 'path query parameter is required', 'missing_path');
    return c.json(await service.getDiff(path));
  });

  app.post('/pr', async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new PromotionError(400, 'Request body must be valid JSON', 'invalid_json');
    }

    if (!isRecord(body) || !Array.isArray(body.paths)) {
      throw new PromotionError(400, 'paths array is required', 'invalid_paths');
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      throw new PromotionError(400, 'title must be a string', 'invalid_title');
    }

    return c.json(await service.createPromotionPr({
      paths: body.paths,
      ...(body.title !== undefined ? { title: body.title } : {}),
    }));
  });

  app.all('*', c => c.json({ error: 'Promotion route not found' }, 404));
  app.notFound(c => c.json({ error: 'Promotion route not found' }, 404));

  return app;
}

function toPromotionErrorStatusCode(status: number): PromotionErrorStatusCode {
  return PROMOTION_ERROR_STATUS_CODES.includes(status as PromotionErrorStatusCode)
    ? status as PromotionErrorStatusCode
    : 500;
}

function extractPromotionToken(shareTokenHeader: string | undefined, authorizationHeader: string | undefined): string | null {
  if (shareTokenHeader?.trim()) return shareTokenHeader.trim();

  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
