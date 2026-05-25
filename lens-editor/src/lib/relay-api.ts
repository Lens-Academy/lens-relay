import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import type { FileMetadata } from '../hooks/useFolderMetadata';
import { getClientToken } from './auth';
import { RELAY_ID } from './constants';

// Transaction origin identifier - Obsidian uses this pattern to identify
// the source of Y.js changes and avoid processing its own updates
export const LENS_EDITOR_ORIGIN = 'lens-editor';

/**
 * Get share token for relay proxy auth.
 * Uses the same token stored by auth-share.ts in localStorage.
 */
function getShareToken(): string | null {
  return localStorage.getItem('lens-share-token');
}

/** Build headers that include the share token for proxy auth. */
export function relayHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getShareToken();
  if (token) {
    headers['X-Share-Token'] = token;
  }
  return headers;
}

// Debug logging helper — gated to dev builds only
function debug(operation: string, ...args: unknown[]) {
  if (import.meta.env.DEV) {
    console.log(`[relay-api] ${operation}:`, ...args);
  }
}

function cloneFileMetadata(meta: FileMetadata | any): FileMetadata {
  if (typeof meta?.toJSON === 'function') {
    return meta.toJSON() as FileMetadata;
  }
  return { ...meta };
}

/** UUID v4 generator that works in insecure contexts (plain HTTP). */
export function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (available in all contexts)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Create a document on the Relay server.
 * Routes through the Vite middleware which adds the server token server-side.
 * This must be called BEFORE adding to filemeta, otherwise the document
 * won't be accessible (auth endpoint returns 404 for non-existent docs).
 */
export async function createDocumentOnServer(docId: string): Promise<void> {
  const response = await fetch('/api/relay/doc/new', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ docId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create document on server: ${response.status} ${response.statusText}`);
  }
}

async function waitForDocumentAccess(docId: string): Promise<void> {
  const token = getShareToken();
  if (!token) return;

  const delays = [50, 100, 200, 400, 800, 1200];
  let lastError = '';

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const response = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, docId }),
    });

    if (response.ok) return;

    lastError = await response.text().catch(() => '');
    const isPendingFolderIndex = response.status === 403 && lastError.includes('document not found');
    if (!isPendingFolderIndex || attempt === delays.length) {
      throw new Error(`New document is not accessible: ${response.status} ${lastError}`);
    }

    await new Promise(resolve => setTimeout(resolve, delays[attempt]));
  }
}

/**
 * Initialize a content document with an underscore character.
 * This triggers Obsidian to create the file immediately rather than waiting
 * for manual "Relay Sync". Using _ to make it visible/explicit.
 */
async function initializeContentDocument(fullDocId: string): Promise<void> {
  debug('initializeContentDocument', 'connecting to content doc...', { fullDocId });

  const doc = new Y.Doc();
  const authEndpoint = () => getClientToken(fullDocId);

  const provider = new YSweetProvider(authEndpoint, fullDocId, doc, {
    connect: true,
  });

  try {
    // Wait for sync to complete
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for content doc sync'));
      }, 10000);

      provider.on('synced', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    debug('initializeContentDocument', 'synced, adding initial content...');

    // Add an underscore to the contents Y.Text
    // This triggers Obsidian to create the actual file
    // Using _ instead of space to make it visible/explicit
    const contents = doc.getText('contents');
    doc.transact(() => {
      // Only add if empty to avoid overwriting existing content
      if (contents.length === 0) {
        contents.insert(0, '_');
        debug('initializeContentDocument', 'added initial underscore');
      } else {
        debug('initializeContentDocument', 'content already exists, skipping');
      }
    }, LENS_EDITOR_ORIGIN);

    // Wait a moment for the change to propagate
    await new Promise(resolve => setTimeout(resolve, 500));

    debug('initializeContentDocument', 'done');
  } finally {
    // Clean up the connection
    provider.destroy();
  }
}

/**
 * Write file metadata for a document path.
 *
 * The legacy docs map is markdown-only for Obsidian compatibility; non-markdown
 * file types should exist only in filemeta_v0.
 */
export function writeFileMeta(
  folderDoc: Y.Doc,
  path: string,
  id: string,
  type: 'markdown' | 'canvas' | 'file',
  version: number = 0,
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const meta: FileMetadata = { id, type, version };
  folderDoc.transact(() => {
    filemeta.set(path, meta);
    if (type === 'markdown') {
      legacyDocs.set(path, id);
    } else {
      legacyDocs.delete(path);
    }
  }, LENS_EDITOR_ORIGIN);
}

/**
 * Create a new document in the folder's filemeta_v0 Y.Map.
 *
 * This function:
 * 1. Generates a new UUID for the document
 * 2. Creates the document on the Relay server (POST /doc/new)
 * 3. Adds the path -> UUID mapping to filemeta_v0
 *
 * Returns the generated document UUID.
 */
export async function createDocument(
  folderDoc: Y.Doc,
  path: string,
  type: 'markdown' | 'canvas' | 'file' = 'markdown'
): Promise<string> {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const id = generateUUID();
  const fullDocId = `${RELAY_ID}-${id}`;

  debug('createDocument', { path, type, id, fullDocId });

  // Step 1: Create document on server first
  debug('createDocument', 'calling server /doc/new...');
  await createDocumentOnServer(fullDocId);
  debug('createDocument', 'server doc created');

  // Step 2: Add to filemeta (this syncs via Y.js)
  // Use transact() with origin like Obsidian does - this allows other clients
  // to identify the source of the change
  debug('createDocument', 'adding to filemeta Y.Map...', { path, id, type, version: 0 });

  // Check if entry already exists or is being deleted
  const existing = filemeta.get(path);
  if (existing) {
    debug('createDocument', 'WARNING: entry already exists!', existing);
  }

  writeFileMeta(folderDoc, path, id, type);

  // Verify the entries were added
  const verifyFilemeta = filemeta.get(path);
  const verifyLegacy = legacyDocs.get(path);
  debug('createDocument', 'verification after set:', {
    path,
    filemetaExists: !!verifyFilemeta,
    legacyDocsExists: !!verifyLegacy,
    legacyDocsValue: verifyLegacy,
  });

  debug('createDocument', 'filemeta updated, current entries:',
    Array.from(filemeta.entries()).map(([p, m]) => ({ path: p, id: m.id })));

  // The relay's folder lookup is updated asynchronously from folder metadata.
  // Wait until share-token auth can see the new filemeta entry before opening
  // the content doc or navigating to it, otherwise the app may render
  // "Wrong Folder" for a freshly-created document.
  await waitForDocumentAccess(fullDocId);

  // Step 3: Initialize markdown content document to trigger Obsidian sync.
  // Non-markdown files must start empty.
  if (type === 'markdown') {
    try {
      await initializeContentDocument(fullDocId);
    } catch (err) {
      // Don't fail the whole operation if content init fails
      // The document is still created and will sync when edited
      debug('createDocument', 'WARNING: failed to initialize content', err);
    }
  }

  return id;
}

/**
 * Rename a document by moving its metadata from oldPath to newPath.
 * Uses atomic transaction to ensure delete+set happen together.
 */
export function renameDocument(
  folderDoc: Y.Doc,
  oldPath: string,
  newPath: string
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const meta = filemeta.get(oldPath);
  const legacyId = legacyDocs.get(oldPath);

  debug('renameDocument', { oldPath, newPath, meta, legacyId });

  if (meta) {
    const clonedMeta = cloneFileMetadata(meta);
    // Wrap in transaction for atomicity - Obsidian does the same
    // Both delete and set happen in a single Y.js update
    // Must update both filemeta_v0 AND legacy docs map
    folderDoc.transact(() => {
      filemeta.delete(oldPath);
      filemeta.set(newPath, clonedMeta);
      if (legacyId) {
        legacyDocs.delete(oldPath);
        legacyDocs.set(newPath, legacyId);
      }
    }, LENS_EDITOR_ORIGIN);

    debug('renameDocument', 'rename complete, current entries:',
      Array.from(filemeta.entries()).map(([p, m]) => ({ path: p, id: m.id })));
  } else {
    debug('renameDocument', 'WARNING: no metadata found for oldPath, rename skipped');
  }
}

/**
 * Rename a folder and all metadata entries below it.
 * Folders are metadata-only entries, so this stays local to the folder Y.Doc.
 */
export function renameFolder(
  folderDoc: Y.Doc,
  oldPath: string,
  newPath: string
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;

  const filemetaMoves = Array.from(filemeta.entries())
    .filter(([path]) => path === oldPath || path.startsWith(oldPrefix))
    .map(([path, meta]) => ({
      oldPath: path,
      newPath: path === oldPath ? newPath : `${newPrefix}${path.slice(oldPrefix.length)}`,
      meta: cloneFileMetadata(meta),
    }));

  if (filemetaMoves.length === 0) {
    debug('renameFolder', 'WARNING: no metadata found for oldPath, rename skipped', { oldPath, newPath });
    return;
  }

  const legacyMoves = Array.from(legacyDocs.entries())
    .filter(([path]) => path === oldPath || path.startsWith(oldPrefix))
    .map(([path, id]) => ({
      oldPath: path,
      newPath: path === oldPath ? newPath : `${newPrefix}${path.slice(oldPrefix.length)}`,
      id,
    }));

  folderDoc.transact(() => {
    for (const move of filemetaMoves) {
      filemeta.delete(move.oldPath);
    }
    for (const move of legacyMoves) {
      legacyDocs.delete(move.oldPath);
    }
    for (const move of filemetaMoves) {
      filemeta.set(move.newPath, move.meta);
    }
    for (const move of legacyMoves) {
      legacyDocs.set(move.newPath, move.id);
    }
  }, LENS_EDITOR_ORIGIN);

  debug('renameFolder', 'rename complete', { oldPath, newPath, movedEntries: filemetaMoves.length });
}

/**
 * Delete a document from the folder's filemeta_v0 Y.Map.
 * Also removes from legacy docs map if present.
 */
export function deleteDocument(
  folderDoc: Y.Doc,
  path: string
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const existingMeta = filemeta.get(path);
  const existingLegacy = legacyDocs.get(path);

  debug('deleteDocument', { path, existingMeta, existingLegacy });

  if (existingMeta || existingLegacy) {
    folderDoc.transact(() => {
      if (existingMeta) filemeta.delete(path);
      if (existingLegacy) legacyDocs.delete(path);
    }, LENS_EDITOR_ORIGIN);

    debug('deleteDocument', 'delete complete, remaining entries:',
      Array.from(filemeta.entries()).map(([p, m]) => ({ path: p, id: m.id })));
  } else {
    debug('deleteDocument', 'WARNING: no metadata found for path, delete skipped');
  }
}

/**
 * Create a folder entry in the folder doc's metadata.
 * Also creates any missing ancestor folder entries.
 * No server call needed — folders are purely metadata.
 */
export function createFolder(
  folderDoc: Y.Doc,
  path: string
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');

  folderDoc.transact(() => {
    // Create ancestor folders for nested paths (e.g., /A/B/C needs /A and /A/B)
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const ancestor = '/' + parts.slice(0, i).join('/');
      if (!filemeta.has(ancestor)) {
        const id = generateUUID();
        filemeta.set(ancestor, { id, type: 'folder', version: 0 });
        legacyDocs.set(ancestor, id);
      }
    }

    // Create the folder itself (if it doesn't already exist)
    if (!filemeta.has(path)) {
      const id = generateUUID();
      filemeta.set(path, { id, type: 'folder', version: 0 });
      legacyDocs.set(path, id);
    }
  }, LENS_EDITOR_ORIGIN);
}

// --- Search API ---

export interface SearchResult {
  doc_id: string;   // UUID (no RELAY_ID prefix)
  title: string;
  folder: string;
  path?: string;    // Display path, e.g. "Lens / Physics" (client-enriched)
  snippet: string;  // HTML with <mark> tags
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total_hits: number;
  query: string;
}

// --- Move API ---

export interface MoveDocumentResponse {
  old_path: string;
  new_path: string;
  old_folder: string;
  new_folder: string;
  links_rewritten: number;
}

/**
 * Move a document to a new path, optionally to a different folder.
 * Calls the server's POST /doc/move endpoint which handles:
 * - Metadata update in filemeta_v0
 * - Backlink rewriting in other documents
 * - Search index update
 */
export async function moveDocument(
  uuid: string,
  newPath: string,
  targetFolder?: string
): Promise<MoveDocumentResponse> {
  const body: Record<string, string> = { uuid, new_path: newPath };
  if (targetFolder) {
    body.target_folder = targetFolder;
  }

  const response = await fetch('/api/relay/doc/move', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Move failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Move a document or rename a folder by user-facing path.
 */
export async function movePath(
  path: string,
  newPath: string,
  targetFolder?: string
): Promise<MoveDocumentResponse> {
  const body: Record<string, string> = { path, new_path: newPath };
  if (targetFolder) {
    body.target_folder = targetFolder;
  }

  const response = await fetch('/api/relay/move', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Move failed: ${response.status}`);
  }

  return response.json();
}

// --- Search API ---

export async function searchDocuments(
  query: string,
  limit: number = 20,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/relay/search?${params}`, { signal, headers: relayHeaders() });
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Set up debug observer on filemeta Y.Map to log all changes.
 * Call this once after connecting to the folder doc.
 */
export function setupFilemetaDebugObserver(folderDoc: Y.Doc): () => void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');

  const observer = (event: Y.YMapEvent<FileMetadata>) => {
    const origin = event.transaction.origin;
    const isLocal = origin === LENS_EDITOR_ORIGIN;
    const originName = origin?.constructor?.name ?? String(origin) ?? 'unknown';

    debug('filemeta Y.Map changed', {
      origin: originName,
      isLocalChange: isLocal,
      keysChanged: Array.from(event.keysChanged),
      totalEntries: filemeta.size,
    });

    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add') {
        debug('  ADD', key, filemeta.get(key));
      } else if (change.action === 'update') {
        debug('  UPDATE', key, { oldValue: change.oldValue, newValue: filemeta.get(key) });
      } else if (change.action === 'delete') {
        // Log extra context for deletes - this is what we're debugging
        debug('  DELETE', key, {
          oldValue: change.oldValue,
          deletedById: (change.oldValue as FileMetadata)?.id,
          remainingEntries: filemeta.size,
        });
        console.warn(`[relay-api] ⚠️ EXTERNAL DELETE of ${key} - check Obsidian console for "Deleting doc" message`);
      }
    });
  };

  filemeta.observe(observer);
  debug('setupFilemetaDebugObserver', 'observer registered, current entries:', filemeta.size);

  // Return cleanup function
  return () => {
    filemeta.unobserve(observer);
    debug('setupFilemetaDebugObserver', 'observer removed');
  };
}
