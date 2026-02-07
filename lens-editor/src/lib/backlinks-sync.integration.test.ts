/**
 * Integration tests for backlinks SYNC behavior.
 *
 * These tests verify that backlinks_v0 updates propagate to connected clients
 * via WebSocket — the seam between server-side indexing and client-side display.
 *
 * Test A (in relay-api.integration.test.ts): "Is the data there when I look?"
 * Test B1 (here): "Does the data arrive while I'm already watching?"
 * Test B2 (here): "Does the data survive a fresh connection?"
 *
 * Prerequisites:
 *   npm run relay:start   # Terminal 1
 *   npm run relay:setup   # Terminal 2 (one-time)
 *
 * Run:
 *   npx vitest run src/lib/backlinks-sync.integration.test.ts
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';

// ---------------------------------------------------------------------------
// Server configuration (duplicated from relay-api.integration.test.ts to
// avoid coupling test files)
// ---------------------------------------------------------------------------

const projectDir = path.basename(path.resolve(import.meta.dirname, '../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;

const SERVER_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;
const SERVER_TOKEN = process.env.RELAY_TOKEN || '';

const TEST_RELAY_UUID = 'f0000000-0000-4000-8000-000000000000';

// ---------------------------------------------------------------------------
// Test UUIDs — prefix 'e' to avoid collision with relay-api tests ('d')
// ---------------------------------------------------------------------------

const RUN_ID = Date.now().toString(16).padStart(8, '0').slice(-8);

// --- Basic sync tests (prefix 'e') ---
const FOLDER_UUID = `e${RUN_ID.slice(0, 7)}-0000-4000-8000-000000000001`;
const DOC_A_UUID = `e${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000a`;
const DOC_B_UUID = `e${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000b`;

const FOLDER_DOC_ID = `${TEST_RELAY_UUID}-${FOLDER_UUID}`;
const DOC_A_ID = `${TEST_RELAY_UUID}-${DOC_A_UUID}`;
const DOC_B_ID = `${TEST_RELAY_UUID}-${DOC_B_UUID}`;

// --- Subdirectory tests (prefix 'c') ---
const SUB_FOLDER_UUID = `c${RUN_ID.slice(0, 7)}-0000-4000-8000-000000000001`;
const SUB_DOC_A_UUID = `c${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000a`;
const SUB_DOC_B_UUID = `c${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000b`;

const SUB_FOLDER_DOC_ID = `${TEST_RELAY_UUID}-${SUB_FOLDER_UUID}`;
const SUB_DOC_A_ID = `${TEST_RELAY_UUID}-${SUB_DOC_A_UUID}`;
const SUB_DOC_B_ID = `${TEST_RELAY_UUID}-${SUB_DOC_B_UUID}`;

// --- Cross-folder tests (prefix 'f') ---
const CF_FOLDER1_UUID = `f${RUN_ID.slice(0, 7)}-0000-4000-8000-000000000001`;
const CF_FOLDER2_UUID = `f${RUN_ID.slice(0, 7)}-0000-4000-8000-000000000002`;
const CF_DOC_A_UUID = `f${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000a`;
const CF_DOC_B_UUID = `f${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000b`;

const CF_FOLDER1_DOC_ID = `${TEST_RELAY_UUID}-${CF_FOLDER1_UUID}`;
const CF_FOLDER2_DOC_ID = `${TEST_RELAY_UUID}-${CF_FOLDER2_UUID}`;
const CF_DOC_A_ID = `${TEST_RELAY_UUID}-${CF_DOC_A_UUID}`;
const CF_DOC_B_ID = `${TEST_RELAY_UUID}-${CF_DOC_B_UUID}`;

// ---------------------------------------------------------------------------
// Helpers (duplicated — small, ~60 lines)
// ---------------------------------------------------------------------------

async function createDocumentOnServer(docId: string): Promise<{ docId: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (SERVER_TOKEN) {
    headers['Authorization'] = `Bearer ${SERVER_TOKEN}`;
  }

  const response = await fetch(`${SERVER_URL}/doc/new`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ docId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create document: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getClientTokenForExistingDoc(docId: string): Promise<{ url: string; docId: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (SERVER_TOKEN) {
    headers['Authorization'] = `Bearer ${SERVER_TOKEN}`;
  }

  const response = await fetch(`${SERVER_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ authorization: 'full' }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get client token: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Connect to a doc via YSweetProvider, wait for sync, run a function.
 * Returns the doc + provider (caller cleans up).
 */
async function connectAndRun(
  docId: string,
  fn: (doc: Y.Doc, provider: YSweetProvider) => void | Promise<void>,
): Promise<{ doc: Y.Doc; provider: YSweetProvider }> {
  const doc = new Y.Doc();
  const authEndpoint = () => getClientTokenForExistingDoc(docId);
  const provider = new YSweetProvider(authEndpoint, docId, doc, {
    connect: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Sync timeout for ${docId}`)), 10000);
    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });
    provider.on('connection-error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  await fn(doc, provider);

  // Brief pause for changes to propagate
  await new Promise(resolve => setTimeout(resolve, 300));

  return { doc, provider };
}

/**
 * Connect, run, then clean up immediately.
 */
async function connectRunAndDisconnect(
  docId: string,
  fn: (doc: Y.Doc) => void | Promise<void>,
): Promise<void> {
  const { doc, provider } = await connectAndRun(docId, fn);
  provider.destroy();
  doc.destroy();
}

// ---------------------------------------------------------------------------
// New helpers
// ---------------------------------------------------------------------------

interface ConnectionController {
  doc: Y.Doc;
  provider: YSweetProvider;
  disconnect: () => void;
}

/**
 * Open a persistent connection. Caller disconnects via controller.disconnect().
 */
async function holdConnection(docId: string): Promise<ConnectionController> {
  const doc = new Y.Doc();
  const authEndpoint = () => getClientTokenForExistingDoc(docId);
  const provider = new YSweetProvider(authEndpoint, docId, doc, {
    connect: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Sync timeout for ${docId}`)), 10000);
    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });
    provider.on('connection-error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return {
    doc,
    provider,
    disconnect() {
      provider.destroy();
      doc.destroy();
    },
  };
}

/**
 * Poll until `check` returns true, or throw after timeout.
 */
async function waitForCondition(
  check: () => boolean,
  timeoutMs = 15000,
  pollMs = 500,
  errorMsg?: string,
): Promise<void> {
  let waited = 0;
  while (waited < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
    waited += pollMs;
  }
  throw new Error(errorMsg ?? `Condition not met after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Backlinks Sync', () => {
  const openConnections: ConnectionController[] = [];

  afterAll(() => {
    for (const conn of openConnections) {
      conn.disconnect();
    }
  });

  /**
   * Shared setup: create folder doc + 2 content docs, populate filemeta_v0.
   * Called once before the first test that needs it.
   */
  let docsCreated = false;

  async function ensureDocsCreated(): Promise<void> {
    if (docsCreated) return;

    // 1. Create all docs on the server
    await Promise.all([
      createDocumentOnServer(FOLDER_DOC_ID),
      createDocumentOnServer(DOC_A_ID),
      createDocumentOnServer(DOC_B_ID),
    ]);

    // 2. Populate filemeta_v0 on the folder doc
    await connectRunAndDisconnect(FOLDER_DOC_ID, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      doc.transact(() => {
        filemeta.set('/SyncAlpha.md', { id: DOC_A_UUID, type: 'markdown', version: 0 });
        filemeta.set('/SyncBeta.md', { id: DOC_B_UUID, type: 'markdown', version: 0 });
        legacyDocs.set('/SyncAlpha.md', DOC_A_UUID);
        legacyDocs.set('/SyncBeta.md', DOC_B_UUID);
      });
    });

    docsCreated = true;
  }

  // -------------------------------------------------------------------------
  // B1a: Live sync — link added
  // -------------------------------------------------------------------------

  it('B1a: receives backlink update on already-connected folder doc when link is added', async () => {
    await ensureDocsCreated();

    // 1. Hold folder doc connection open BEFORE writing any content
    const folderConn = await holdConnection(FOLDER_DOC_ID);
    openConnections.push(folderConn);

    const backlinks = folderConn.doc.getMap('backlinks_v0');

    // 2. Verify backlinks_v0 is empty for DOC_B initially
    const initialEntry = backlinks.get(DOC_B_UUID);
    expect(
      !initialEntry || (Array.isArray(initialEntry) && (initialEntry as string[]).length === 0),
    ).toBe(true);

    // 3. Write wikilink [[SyncBeta]] to DOC_A content (separate connection)
    await connectRunAndDisconnect(DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      text.insert(0, '# SyncAlpha\n\nSee [[SyncBeta]] for details.');
    });

    // 4. Poll folder doc's backlinks_v0 until DOC_B entry contains DOC_A
    //    Server debounce is 2s, plus sync latency. 20s timeout gives margin.
    await waitForCondition(
      () => {
        const entry = backlinks.get(DOC_B_UUID);
        if (!entry) return false;
        const sources = entry as unknown as string[];
        return Array.isArray(sources) && sources.includes(DOC_A_UUID);
      },
      20000,
      500,
      `backlinks_v0 for ${DOC_B_UUID} never received ${DOC_A_UUID} after 20s. ` +
        `Keys present: [${Array.from(backlinks.keys()).join(', ')}]`,
    );

    // 5. Assert — if we reach here, live sync worked
    const finalEntry = backlinks.get(DOC_B_UUID) as unknown as string[];
    expect(finalEntry).toContain(DOC_A_UUID);
  }, 30000);

  // -------------------------------------------------------------------------
  // B1b: Live sync — link removed
  // -------------------------------------------------------------------------

  it('B1b: receives backlink removal on already-connected folder doc when link is removed', async () => {
    // Depends on B1a having run: DOC_A links to DOC_B, folder doc exists.

    // 1. Hold folder doc connection open
    const folderConn = await holdConnection(FOLDER_DOC_ID);
    openConnections.push(folderConn);

    const backlinks = folderConn.doc.getMap('backlinks_v0');

    // 2. Verify DOC_B's backlinks currently contain DOC_A (from B1a)
    //    If B1a didn't populate them, wait briefly for initial sync.
    await waitForCondition(
      () => {
        const entry = backlinks.get(DOC_B_UUID);
        if (!entry) return false;
        const sources = entry as unknown as string[];
        return Array.isArray(sources) && sources.includes(DOC_A_UUID);
      },
      10000,
      500,
      `Precondition failed: backlinks_v0 for ${DOC_B_UUID} does not contain ${DOC_A_UUID}. ` +
        `Cannot test removal. Keys: [${Array.from(backlinks.keys()).join(', ')}]`,
    );

    // 3. Rewrite DOC_A content WITHOUT wikilink
    await connectRunAndDisconnect(DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, '# SyncAlpha\n\nNo links here anymore.');
      });
    });

    // 4. Poll until DOC_B's backlinks no longer contain DOC_A
    await waitForCondition(
      () => {
        const entry = backlinks.get(DOC_B_UUID);
        if (!entry) return true; // Entry fully removed — success
        const sources = entry as unknown as string[];
        return !Array.isArray(sources) || !sources.includes(DOC_A_UUID);
      },
      20000,
      500,
      `backlinks_v0 for ${DOC_B_UUID} still contains ${DOC_A_UUID} after 20s`,
    );

    // 5. Assert removal
    const finalEntry = backlinks.get(DOC_B_UUID);
    if (finalEntry) {
      const sources = finalEntry as unknown as string[];
      expect(sources).not.toContain(DOC_A_UUID);
    }
    // If finalEntry is undefined/null, the whole entry was removed — also correct
  }, 30000);

  // -------------------------------------------------------------------------
  // B2: Fresh connection receives existing backlinks
  // -------------------------------------------------------------------------

  it('B2: fresh connection receives backlinks that were indexed before connecting', async () => {
    await ensureDocsCreated();

    // 1. Write wikilink to DOC_A (in case B1b cleared it)
    await connectRunAndDisconnect(DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, '# SyncAlpha\n\nLink to [[SyncBeta]] again.');
      });
    });

    // 2. Wait for indexing to complete via a temporary connection
    {
      const tempConn = await holdConnection(FOLDER_DOC_ID);
      try {
        const backlinks = tempConn.doc.getMap('backlinks_v0');
        await waitForCondition(
          () => {
            const entry = backlinks.get(DOC_B_UUID);
            if (!entry) return false;
            const sources = entry as unknown as string[];
            return Array.isArray(sources) && sources.includes(DOC_A_UUID);
          },
          20000,
          500,
          `Indexing did not complete: backlinks_v0 for ${DOC_B_UUID} missing ${DOC_A_UUID}`,
        );
      } finally {
        tempConn.disconnect();
      }
    }

    // 3. Brief pause to ensure all connections are fully closed
    await new Promise(resolve => setTimeout(resolve, 500));

    // 4. Open a FRESH connection — simulates app open / page refresh
    const freshConn = await holdConnection(FOLDER_DOC_ID);
    openConnections.push(freshConn);

    // 5. Immediately read backlinks_v0 (should arrive with initial sync)
    const backlinks = freshConn.doc.getMap('backlinks_v0');

    // Give a small window for the initial sync payload to fully apply
    await waitForCondition(
      () => {
        const entry = backlinks.get(DOC_B_UUID);
        if (!entry) return false;
        const sources = entry as unknown as string[];
        return Array.isArray(sources) && sources.includes(DOC_A_UUID);
      },
      5000,
      200,
      `Fresh connection did not receive backlinks_v0 for ${DOC_B_UUID}. ` +
        `Keys present: [${Array.from(backlinks.keys()).join(', ')}]. ` +
        `This means initial Y.Doc sync does not include server-written backlinks.`,
    );

    const entry = backlinks.get(DOC_B_UUID) as unknown as string[];
    expect(entry).toContain(DOC_A_UUID);
  }, 40000);
});

// ---------------------------------------------------------------------------
// Subdirectory Backlinks
// ---------------------------------------------------------------------------

describe('Subdirectory Backlinks', () => {
  const openConnections: ConnectionController[] = [];

  afterAll(() => {
    for (const conn of openConnections) {
      conn.disconnect();
    }
  });

  it('resolves [[SubAlpha]] to /Notes/SubAlpha.md in subdirectory', async () => {
    // Uses unique filenames (SubAlpha, SubBeta) to avoid collisions with
    // other test groups' filemeta entries (DocA, DocB, etc.)
    // 1. Create folder doc + 2 content docs
    await Promise.all([
      createDocumentOnServer(SUB_FOLDER_DOC_ID),
      createDocumentOnServer(SUB_DOC_A_ID),
      createDocumentOnServer(SUB_DOC_B_ID),
    ]);

    // 2. Populate filemeta with subdirectory paths (unique names)
    await connectRunAndDisconnect(SUB_FOLDER_DOC_ID, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      doc.transact(() => {
        filemeta.set('/Notes/SubAlpha.md', { id: SUB_DOC_A_UUID, type: 'markdown', version: 0 });
        filemeta.set('/Notes/SubBeta.md', { id: SUB_DOC_B_UUID, type: 'markdown', version: 0 });
        legacyDocs.set('/Notes/SubAlpha.md', SUB_DOC_A_UUID);
        legacyDocs.set('/Notes/SubBeta.md', SUB_DOC_B_UUID);
      });
    });

    // 3. Hold folder doc connection
    const folderConn = await holdConnection(SUB_FOLDER_DOC_ID);
    openConnections.push(folderConn);
    const backlinks = folderConn.doc.getMap('backlinks_v0');

    // 4. Write [[SubBeta]] to SubAlpha content
    await connectRunAndDisconnect(SUB_DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      text.insert(0, '# SubAlpha\n\nSee [[SubBeta]] for details.');
    });

    // 5. Poll for backlink
    await waitForCondition(
      () => {
        const entry = backlinks.get(SUB_DOC_B_UUID);
        if (!entry) return false;
        const sources = entry as unknown as string[];
        return Array.isArray(sources) && sources.includes(SUB_DOC_A_UUID);
      },
      20000,
      500,
      `Subdirectory backlink: backlinks_v0 for ${SUB_DOC_B_UUID} never received ${SUB_DOC_A_UUID}. ` +
        `Keys: [${Array.from(backlinks.keys()).join(', ')}]`,
    );

    const entry = backlinks.get(SUB_DOC_B_UUID) as unknown as string[];
    expect(entry).toContain(SUB_DOC_A_UUID);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Cross-folder Backlinks
// ---------------------------------------------------------------------------

describe('Cross-folder Backlinks', () => {
  const openConnections: ConnectionController[] = [];

  afterAll(() => {
    for (const conn of openConnections) {
      conn.disconnect();
    }
  });

  it('resolves [[CrossTarget]] across folders — backlink appears in target folder', async () => {
    // Uses unique filenames (CrossSource, CrossTarget) to avoid collisions
    // with other test groups' filemeta entries
    // 1. Create 2 folder docs + 2 content docs
    await Promise.all([
      createDocumentOnServer(CF_FOLDER1_DOC_ID),
      createDocumentOnServer(CF_FOLDER2_DOC_ID),
      createDocumentOnServer(CF_DOC_A_ID),
      createDocumentOnServer(CF_DOC_B_ID),
    ]);

    // 2. Populate filemeta: CrossSource in folder1, CrossTarget in folder2
    await connectRunAndDisconnect(CF_FOLDER1_DOC_ID, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      doc.transact(() => {
        filemeta.set('/CrossSource.md', { id: CF_DOC_A_UUID, type: 'markdown', version: 0 });
        legacyDocs.set('/CrossSource.md', CF_DOC_A_UUID);
      });
    });

    await connectRunAndDisconnect(CF_FOLDER2_DOC_ID, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      doc.transact(() => {
        filemeta.set('/CrossTarget.md', { id: CF_DOC_B_UUID, type: 'markdown', version: 0 });
        legacyDocs.set('/CrossTarget.md', CF_DOC_B_UUID);
      });
    });

    // 3. Hold connection to folder2 (the target's folder)
    const folder2Conn = await holdConnection(CF_FOLDER2_DOC_ID);
    openConnections.push(folder2Conn);
    const backlinks = folder2Conn.doc.getMap('backlinks_v0');

    // 4. Write [[CrossTarget]] to CrossSource content (in folder1)
    await connectRunAndDisconnect(CF_DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      text.insert(0, '# CrossSource\n\nSee [[CrossTarget]] for the course plan.');
    });

    // 5. Poll folder2's backlinks_v0 for CrossTarget UUID
    await waitForCondition(
      () => {
        const entry = backlinks.get(CF_DOC_B_UUID);
        if (!entry) return false;
        const sources = entry as unknown as string[];
        return Array.isArray(sources) && sources.includes(CF_DOC_A_UUID);
      },
      20000,
      500,
      `Cross-folder backlink: backlinks_v0 for ${CF_DOC_B_UUID} in folder2 never received ${CF_DOC_A_UUID}. ` +
        `Keys: [${Array.from(backlinks.keys()).join(', ')}]`,
    );

    const entry = backlinks.get(CF_DOC_B_UUID) as unknown as string[];
    expect(entry).toContain(CF_DOC_A_UUID);
  }, 30000);
});
