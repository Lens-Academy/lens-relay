/**
 * Integration tests for Editor loading state.
 *
 * These tests verify that the loading overlay is only hidden when document
 * content has actually synced from the server, not just when the WebSocket
 * connects.
 *
 * Run integration tests:
 *   # Terminal 1: Start local relay-server
 *   npm run relay:start
 *
 *   # Terminal 2: Run tests
 *   npm run test:integration:editor
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import { Editor } from './Editor';
import { YDocProvider } from '@y-sweet/react';
import path from 'path';

// Auto-detect workspace number from directory name for default port
const projectDir = path.basename(path.resolve(import.meta.dirname, '../../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;

const RELAY_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;

/**
 * Create a document on the Y-Sweet server.
 */
async function createDocOnServer(docId: string): Promise<void> {
  const response = await fetch(`${RELAY_URL}/doc/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId }),
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`Failed to create doc: ${response.status}`);
  }
}

/**
 * Get auth token for a document.
 */
async function getClientToken(docId: string): Promise<{ url: string; docId: string; token?: string }> {
  const response = await fetch(`${RELAY_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: 'full' }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get token: ${response.status}`);
  }

  return response.json();
}

/**
 * Create a document and populate it with content.
 */
async function setupDocumentWithContent(docId: string, content: string): Promise<void> {
  // Create doc on server
  await createDocOnServer(docId);

  // Connect and add content
  const doc = new Y.Doc();
  const provider = new YSweetProvider(() => getClientToken(docId), docId, doc, {
    connect: true,
  });

  // Wait for sync
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timeout')), 10000);
    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });
    provider.on('connection-error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Add content
  const ytext = doc.getText('contents');
  ytext.insert(0, content);

  // Wait for sync to propagate
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Cleanup
  provider.destroy();
  doc.destroy();
}

/**
 * Check if Y-Sweet server is running.
 */
async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${RELAY_URL}/`);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

describe('Editor Loading State Integration', () => {
  beforeAll(async () => {
    const serverUp = await checkServer();
    if (!serverUp) {
      throw new Error(
        `Local relay-server not running! Start with: npm run relay:start`
      );
    }
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Verifies that content is available when the editor reports synced.
   *
   * BUG FIXED: The Editor component had wikilinkContext in its useEffect
   * dependencies, causing the editor to be recreated when folder metadata
   * loaded. The second EditorView's yCollab binding never received the
   * Y.Text content because it had already synced to the first (destroyed) view.
   *
   * FIX: Removed wikilinkContext from dependencies and update it via a
   * separate effect using updateWikilinkContext().
   */
  it('content is available when editor syncs', async () => {
    const docId = `test-loading-${Date.now()}`;
    const testContent = '# Test Document\n\nThis content should be visible.';

    // Setup: Create document with content on server
    await setupDocumentWithContent(docId, testContent);

    // Track when synced state changes and what the content was at that moment
    let contentWhenSyncedBecameTrue: string | null = null;
    let syncedObserved = false;

    // Render Editor with a wrapper that tracks sync state
    const { container } = render(
      <YDocProvider docId={docId} authEndpoint={() => getClientToken(docId)}>
        <SyncStateTracker
          onSyncedChange={(synced, content) => {
            if (synced && !syncedObserved) {
              syncedObserved = true;
              contentWhenSyncedBecameTrue = content;
            }
          }}
        />
        <Editor />
      </YDocProvider>
    );

    // Wait for the editor to show content
    await waitFor(
      () => {
        const editorContent = container.querySelector('.cm-content');
        expect(editorContent?.textContent).toContain('Test Document');
      },
      { timeout: 10000 }
    );

    // THE ACTUAL TEST: When synced became true, content should NOT have been empty
    // If this fails, it means the loading overlay was hidden before content arrived
    expect(contentWhenSyncedBecameTrue).not.toBe('');
    expect(contentWhenSyncedBecameTrue).toContain('Test Document');
  });

  /**
   * Simpler test: verify loading overlay is visible initially.
   */
  it('shows loading overlay initially before sync completes', async () => {
    const docId = `test-initial-${Date.now()}`;
    const testContent = '# Initial Test\n\nContent here.';

    await setupDocumentWithContent(docId, testContent);

    const { container } = render(
      <YDocProvider docId={docId} authEndpoint={() => getClientToken(docId)}>
        <Editor />
      </YDocProvider>
    );

    // Loading overlay should be visible immediately after render
    // (before any sync has occurred)
    const loadingOverlay = container.querySelector('[class*="Loading"]');
    // Check for the loading text as a fallback
    const loadingText = container.textContent?.includes('Loading document');

    expect(loadingOverlay !== null || loadingText).toBe(true);
  });
});

/**
 * Helper component that tracks sync state and Y.Text content together.
 * This lets us observe what the content was when synced became true.
 */
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { useEffect, useRef } from 'react';

interface SyncStateTrackerProps {
  onSyncedChange: (synced: boolean, content: string) => void;
}

function SyncStateTracker({ onSyncedChange }: SyncStateTrackerProps) {
  const ydoc = useYDoc();
  const provider = useYjsProvider();
  const reportedRef = useRef(false);

  useEffect(() => {
    const ytext = ydoc.getText('contents');

    const checkAndReport = () => {
      const isSynced = (provider as any).synced;
      if (isSynced && !reportedRef.current) {
        reportedRef.current = true;
        onSyncedChange(true, ytext.toString());
      }
    };

    // Check immediately in case already synced
    checkAndReport();

    // Listen for synced event
    const handleSynced = () => {
      checkAndReport();
    };

    provider.on('synced', handleSynced);

    return () => {
      provider.off('synced', handleSynced);
    };
  }, [ydoc, provider, onSyncedChange]);

  return null;
}
