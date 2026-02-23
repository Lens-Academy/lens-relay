#!/usr/bin/env node
/**
 * Clean up corrupted filemeta entries from a folder document.
 *
 * Connects to a running relay server via WebSocket, finds entries with
 * double/triple-slash paths, and removes them from both filemeta_v0 and
 * legacy docs Y.Maps.
 *
 * Usage:
 *   node scripts/cleanup-filemeta.mjs <folder-uuid> [--dry-run]
 *
 * Environment:
 *   RELAY_PORT  - relay server port (default: auto-detect from workspace)
 *   RELAY_ID    - relay server ID (default: local test ID)
 *
 * Always runs in dry-run mode unless --commit is passed.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parentDir = path.basename(path.resolve(__dirname, '../..'));
const workspaceMatch = parentDir.match(/^ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const portOffset = (wsNum - 1) * 100;
const RELAY_PORT = process.env.RELAY_PORT || (8090 + portOffset);
const RELAY_URL = process.env.RELAY_URL || `http://localhost:${RELAY_PORT}`;
const RELAY_ID = process.env.RELAY_ID || 'a0000000-0000-4000-8000-000000000000';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const folderId = args.find(a => !a.startsWith('--'));

if (!folderId) {
  console.error('Usage: node scripts/cleanup-filemeta.mjs <folder-uuid> [--commit]');
  console.error('');
  console.error('Without --commit, runs in dry-run mode (shows what would be removed).');
  process.exit(1);
}

function isCorruptedPath(p) {
  if (p === '/' || p === '//') return true;
  if (p.startsWith('//')) return true;
  return false;
}

async function getClientToken(docId) {
  const response = await fetch(`${RELAY_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: 'full' }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get token for ${docId}: ${response.status}`);
  }
  return response.json();
}

async function cleanup() {
  const compoundId = `${RELAY_ID}-${folderId}`;
  console.log(`Connecting to relay at ${RELAY_URL}`);
  console.log(`Folder: ${folderId}`);
  console.log(`Compound ID: ${compoundId}`);
  console.log(`Mode: ${commit ? 'COMMIT (will modify data)' : 'DRY RUN (read-only)'}`);
  console.log('');

  const doc = new Y.Doc();
  const authEndpoint = () => getClientToken(compoundId);

  const provider = new YSweetProvider(authEndpoint, compoundId, doc, {
    connect: true,
    showDebuggerLink: false,
  });

  // Wait for sync
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timeout (10s)')), 10000);
    provider.on('synced', () => { clearTimeout(timeout); resolve(); });
    provider.on('connection-error', (err) => { clearTimeout(timeout); reject(err); });
  });

  const filemeta = doc.getMap('filemeta_v0');
  const legacyDocs = doc.getMap('docs');

  // Find corrupted entries
  const filemetaCorrupted = [];
  for (const [p] of filemeta.entries()) {
    if (isCorruptedPath(p)) {
      filemetaCorrupted.push(p);
    }
  }

  const legacyCorrupted = [];
  for (const [p] of legacyDocs.entries()) {
    if (isCorruptedPath(p)) {
      legacyCorrupted.push(p);
    }
  }

  if (filemetaCorrupted.length === 0 && legacyCorrupted.length === 0) {
    console.log('No corrupted entries found. Nothing to clean up.');
    provider.destroy();
    doc.destroy();
    process.exit(0);
  }

  console.log(`Found ${filemetaCorrupted.length} corrupted entries in filemeta_v0:`);
  for (const p of filemetaCorrupted) {
    const meta = filemeta.get(p);
    let metaObj;
    if (meta instanceof Y.Map) {
      metaObj = {};
      for (const [k, v] of meta.entries()) metaObj[k] = v;
    } else {
      metaObj = meta;
    }
    console.log(`  ${JSON.stringify(p)} → ${JSON.stringify(metaObj)}`);
  }

  console.log(`Found ${legacyCorrupted.length} corrupted entries in docs (legacy):`);
  for (const p of legacyCorrupted) {
    console.log(`  ${JSON.stringify(p)} → ${JSON.stringify(legacyDocs.get(p))}`);
  }

  if (!commit) {
    console.log('');
    console.log('DRY RUN — no changes made. Pass --commit to remove these entries.');
    provider.destroy();
    doc.destroy();
    process.exit(0);
  }

  // Remove corrupted entries
  console.log('');
  console.log('Removing corrupted entries...');

  doc.transact(() => {
    for (const p of filemetaCorrupted) {
      filemeta.delete(p);
      console.log(`  Deleted from filemeta_v0: ${JSON.stringify(p)}`);
    }
    for (const p of legacyCorrupted) {
      legacyDocs.delete(p);
      console.log(`  Deleted from docs: ${JSON.stringify(p)}`);
    }
  }, 'cleanup-script');

  // Wait for sync to propagate the changes
  console.log('');
  console.log('Waiting for changes to sync...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Verify
  console.log('');
  console.log('Verifying...');
  let remainingIssues = 0;
  for (const [p] of filemeta.entries()) {
    if (isCorruptedPath(p)) {
      console.log(`  STILL PRESENT in filemeta_v0: ${JSON.stringify(p)}`);
      remainingIssues++;
    }
  }
  for (const [p] of legacyDocs.entries()) {
    if (isCorruptedPath(p)) {
      console.log(`  STILL PRESENT in docs: ${JSON.stringify(p)}`);
      remainingIssues++;
    }
  }

  if (remainingIssues === 0) {
    console.log('  All corrupted entries removed successfully.');
  } else {
    console.log(`  WARNING: ${remainingIssues} corrupted entries remain.`);
  }

  provider.destroy();
  doc.destroy();
}

try {
  await cleanup();
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('Done.');
process.exit(0);
