/**
 * Smoke test: can the frontend reach the local relay-server and auth
 * against every document it expects to find?
 *
 * This catches the most common local-dev failure mode: IDs changed in
 * code but the relay-server still has old data (or no data at all).
 *
 * Run:
 *   npm run test:integration:smoke
 *
 * Prerequisites:
 *   1. npm run relay:start
 *   2. npm run relay:setup
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';

// ── Port auto-detection (same logic as App.tsx / vite.config.ts) ──────────
const projectDir = path.basename(path.resolve(import.meta.dirname, '../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;
const SERVER_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;

// ── IDs that must match App.tsx + setup-local-relay.mjs ───────────────────
const RELAY_ID = 'a0000000-0000-4000-8000-000000000000';

const FOLDER_IDS = [
  'b0000001-0000-4000-8000-000000000001',
  'b0000002-0000-4000-8000-000000000002',
];

const DOC_IDS = [
  'c0000001-0000-4000-8000-000000000001', // Welcome.md
  'c0000002-0000-4000-8000-000000000002', // Getting Started.md
  'c0000003-0000-4000-8000-000000000003', // Notes/Ideas.md
  'c0000004-0000-4000-8000-000000000004', // Course Notes.md
  'c0000005-0000-4000-8000-000000000005', // Syllabus.md
  'c0000006-0000-4000-8000-000000000006', // Resources/Links.md
];

// All compound doc IDs the frontend will try to auth against
const ALL_COMPOUND_IDS = [
  ...FOLDER_IDS.map(id => `${RELAY_ID}-${id}`),
  ...DOC_IDS.map(id => `${RELAY_ID}-${id}`),
];

// ── Helpers ───────────────────────────────────────────────────────────────

async function serverIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}/`);
    return r.ok || r.status === 404; // Y-Sweet returns 404 on /
  } catch {
    return false;
  }
}

async function authDoc(compoundId: string): Promise<{ ok: boolean; status: number }> {
  const r = await fetch(`${SERVER_URL}/doc/${compoundId}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: 'full' }),
  });
  return { ok: r.ok, status: r.status };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Smoke: frontend ↔ relay-server', () => {
  beforeAll(async () => {
    const up = await serverIsUp();
    if (!up) {
      throw new Error(
        `Relay server not reachable at ${SERVER_URL}.\n` +
        `  1. npm run relay:start\n` +
        `  2. npm run relay:setup\n`
      );
    }
  });

  it('relay server is reachable', async () => {
    expect(await serverIsUp()).toBe(true);
  });

  for (const folderId of FOLDER_IDS) {
    const compoundId = `${RELAY_ID}-${folderId}`;
    it(`folder doc ${folderId} exists`, async () => {
      const { ok, status } = await authDoc(compoundId);
      expect(ok, `Auth for folder doc ${compoundId} returned ${status}. Run: npm run relay:setup`).toBe(true);
    });
  }

  for (const docId of DOC_IDS) {
    const compoundId = `${RELAY_ID}-${docId}`;
    it(`content doc ${docId} exists`, async () => {
      const { ok, status } = await authDoc(compoundId);
      expect(ok, `Auth for content doc ${compoundId} returned ${status}. Run: npm run relay:setup`).toBe(true);
    });
  }
});
