/**
 * Integration tests for document CRUD operations and backlinks.
 *
 * These tests verify that documents can be created on the relay server
 * and then accessed. Run against a local relay-server instance by default.
 *
 * Run integration tests with local relay-server:
 *   # Terminal 1: Start local relay-server
 *   npm run relay:start
 *
 *   # Terminal 2: Run tests
 *   npm run test:integration
 *
 * Run against production Relay (not recommended):
 *   RELAY_URL=https://relay.lensacademy.org RELAY_TOKEN=<token> npm run test:integration
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';

// Auto-detect workspace number from directory name for default port
const projectDir = path.basename(path.resolve(import.meta.dirname, '../..'));
const parentDir = path.basename(path.resolve(import.meta.dirname, '../../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/) || parentDir.match(/^ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;

// Server configuration - defaults to local relay-server
const SERVER_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;
const SERVER_TOKEN = process.env.RELAY_TOKEN || '';  // Local relay-server doesn't need auth

// Deterministic test UUIDs (v4 format, 36 chars each)
const TEST_RELAY_UUID = 'f0000000-0000-4000-8000-000000000000';

/**
 * Call the Y-Sweet server's /doc/new endpoint to create a document.
 */
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

/**
 * Get a client token for an existing document.
 * Returns 404 if the document doesn't exist on the server.
 */
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
 * Connect to a doc via YSweetProvider, run a function, then disconnect.
 * Returns the Y.Doc (caller must destroy).
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

  // Wait for sync
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

  // Wait for changes to propagate
  await new Promise(resolve => setTimeout(resolve, 300));

  return { doc, provider };
}

/**
 * Connect and run, then clean up immediately.
 */
async function connectRunAndDisconnect(
  docId: string,
  fn: (doc: Y.Doc) => void | Promise<void>,
): Promise<void> {
  const { doc, provider } = await connectAndRun(docId, fn);
  provider.destroy();
  doc.destroy();
}

describe('Relay Document CRUD', () => {
  describe('Document Creation', () => {
    it('can create a document on the server via /doc/new', async () => {
      const docId = `${TEST_RELAY_UUID}-${crypto.randomUUID()}`;

      const result = await createDocumentOnServer(docId);

      expect(result.docId).toBe(docId);
    });

    it('can get a client token for a document created via /doc/new', async () => {
      const docId = `${TEST_RELAY_UUID}-${crypto.randomUUID()}`;

      // First create the document
      await createDocumentOnServer(docId);

      // Now we should be able to get a client token
      const token = await getClientTokenForExistingDoc(docId);

      expect(token.docId).toBe(docId);
      // Local Y-Sweet uses ws://, production uses wss://
      expect(token.url).toMatch(/^wss?:\/\//);
    });

    it('returns 404 for non-existent document', async () => {
      const nonExistentDocId = `${TEST_RELAY_UUID}-${crypto.randomUUID()}`;

      await expect(getClientTokenForExistingDoc(nonExistentDocId)).rejects.toThrow('404');
    });
  });

  describe('Document Creation Flow', () => {
    /**
     * This test demonstrates the correct order of operations:
     * 1. Create document on server via /doc/new
     * 2. Add to local filemeta (Y.Map)
     * 3. Get client token - works because doc exists on server
     */
    it('requires /doc/new before document can be accessed', async () => {
      const docId = `${TEST_RELAY_UUID}-${crypto.randomUUID()}`;

      // Without /doc/new, getting a client token fails
      await expect(getClientTokenForExistingDoc(docId)).rejects.toThrow('404');

      // After /doc/new, it works
      await createDocumentOnServer(docId);
      const token = await getClientTokenForExistingDoc(docId);
      expect(token.docId).toBe(docId);
    });

    it('can create multiple documents', async () => {
      const docIds = [
        `${TEST_RELAY_UUID}-${crypto.randomUUID()}`,
        `${TEST_RELAY_UUID}-${crypto.randomUUID()}`,
        `${TEST_RELAY_UUID}-${crypto.randomUUID()}`,
      ];

      // Create all documents
      await Promise.all(docIds.map(id => createDocumentOnServer(id)));

      // Verify all are accessible
      const tokens = await Promise.all(docIds.map(id => getClientTokenForExistingDoc(id)));

      tokens.forEach((token, i) => {
        expect(token.docId).toBe(docIds[i]);
      });
    });
  });
});

describe('Backlinks via Link Indexer', () => {
  // Use unique UUIDs per test run to avoid interference
  const RUN_ID = Date.now().toString(16).padStart(8, '0').slice(-8);
  const FOLDER_UUID = `d${RUN_ID.slice(0, 7)}-0000-4000-8000-000000000001`;
  const DOC_A_UUID = `d${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000a`;
  const DOC_B_UUID = `d${RUN_ID.slice(0, 7)}-0000-4000-8000-00000000000b`;

  // Compound doc IDs (73 chars: relay_uuid-doc_uuid)
  const FOLDER_DOC_ID = `${TEST_RELAY_UUID}-${FOLDER_UUID}`;
  const DOC_A_ID = `${TEST_RELAY_UUID}-${DOC_A_UUID}`;
  const DOC_B_ID = `${TEST_RELAY_UUID}-${DOC_B_UUID}`;

  // Track connections for cleanup
  const connections: Array<{ doc: Y.Doc; provider: YSweetProvider }> = [];

  afterAll(() => {
    for (const conn of connections) {
      conn.provider.destroy();
      conn.doc.destroy();
    }
  });

  it('populates backlinks_v0 when a doc contains wikilinks', async () => {
    // 1. Create all docs on the server
    await Promise.all([
      createDocumentOnServer(FOLDER_DOC_ID),
      createDocumentOnServer(DOC_A_ID),
      createDocumentOnServer(DOC_B_ID),
    ]);

    // 2. Populate filemeta_v0 on the folder doc (maps paths to UUIDs)
    await connectRunAndDisconnect(FOLDER_DOC_ID, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      doc.transact(() => {
        filemeta.set('/ApiAlpha.md', { id: DOC_A_UUID, type: 'markdown', version: 0 });
        filemeta.set('/ApiBeta.md', { id: DOC_B_UUID, type: 'markdown', version: 0 });
        legacyDocs.set('/ApiAlpha.md', DOC_A_UUID);
        legacyDocs.set('/ApiBeta.md', DOC_B_UUID);
      });
    });

    // 3. Write content with a wikilink: ApiAlpha links to ApiBeta
    await connectRunAndDisconnect(DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      text.insert(0, '# ApiAlpha\n\nSee [[ApiBeta]] for more.');
    });

    // 4. Connect to folder doc and wait for backlinks_v0 to be populated
    //    The server link indexer has a 2-second debounce, so we poll.
    const folderConn = await connectAndRun(FOLDER_DOC_ID, async (doc) => {
      const backlinks = doc.getMap('backlinks_v0');

      // Poll for backlinks to appear (link indexer debounce is 2s)
      const maxWait = 15000;
      const pollInterval = 500;
      let waited = 0;

      while (waited < maxWait) {
        const backlinkEntry = backlinks.get(DOC_B_UUID);
        if (backlinkEntry) {
          // backlinks_v0 stores: target_uuid -> string[] of source_uuids
          const sources = backlinkEntry as unknown as string[];
          expect(sources).toContain(DOC_A_UUID);
          return; // Success!
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }

      // If we get here, backlinks never appeared
      const allKeys = Array.from(backlinks.keys());
      throw new Error(
        `backlinks_v0 not populated after ${maxWait}ms. ` +
        `Keys found: [${allKeys.join(', ')}]. ` +
        `Expected key: ${DOC_B_UUID}`
      );
    });
    connections.push(folderConn);
  }, 30000); // 30s timeout for this test

  it('updates backlinks when wikilinks change', async () => {
    // This test depends on the previous test having set up the folder + docs.
    // ApiAlpha currently links to ApiBeta. Update ApiAlpha to link to nothing.

    // Re-write ApiAlpha content without wikilinks
    await connectRunAndDisconnect(DOC_A_ID, (doc) => {
      const text = doc.getText('contents');
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, '# ApiAlpha\n\nNo links here.');
      });
    });

    // Wait for link indexer to process the removal
    const folderConn = await connectAndRun(FOLDER_DOC_ID, async (doc) => {
      const backlinks = doc.getMap('backlinks_v0');

      const maxWait = 15000;
      const pollInterval = 500;
      let waited = 0;

      while (waited < maxWait) {
        const backlinkEntry = backlinks.get(DOC_B_UUID);
        // Entry should be removed or not contain DOC_A_UUID
        if (!backlinkEntry) {
          return; // Success - entry fully removed
        }
        const sources = backlinkEntry as unknown as string[];
        if (!sources.includes(DOC_A_UUID)) {
          return; // Success - source removed from array
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }

      throw new Error(
        `backlinks_v0 still contains ${DOC_A_UUID} -> ${DOC_B_UUID} after ${maxWait}ms`
      );
    });
    connections.push(folderConn);
  }, 30000);
});
