#!/usr/bin/env node
/**
 * Delete the broken /Chris/ entries from filemeta_v0 and docs.
 * Run this before restore-chris-files.mjs to clear bad Y.Map-based entries.
 *
 * Usage:
 *   node scripts/delete-chris-entries.mjs <folder-uuid> [--commit]
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

const CHRIS_PATHS = [
  '/Chris',
  "/Chris/Chris's log.md",
  '/Chris/LLM prompts.md',
  '/Chris/meeting notes - week 3 materials.md',
  '/Chris/project management.md',
  '/Chris/Week 2 meeting export.md',
  '/Chris/Week 3 meeting import.md',
];

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const folderId = args.find(a => !a.startsWith('--'));

if (!folderId) {
  console.error('Usage: node scripts/delete-chris-entries.mjs <folder-uuid> [--commit]');
  process.exit(1);
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

function connectDoc(docId) {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const provider = new YSweetProvider(
      () => getClientToken(docId),
      docId,
      doc,
      { connect: true, showDebuggerLink: false },
    );
    const timeout = setTimeout(() => reject(new Error(`Sync timeout for ${docId}`)), 15000);
    provider.on('synced', () => { clearTimeout(timeout); resolve({ doc, provider }); });
    provider.on('connection-error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function cleanup() {
  const compoundId = `${RELAY_ID}-${folderId}`;
  console.log(`Relay: ${RELAY_URL}`);
  console.log(`Folder: ${folderId} (${compoundId})`);
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('');

  console.log('Connecting to folder document...');
  const { doc: folderDoc, provider: folderProvider } = await connectDoc(compoundId);

  const filemeta = folderDoc.getMap('filemeta_v0');
  const legacyDocs = folderDoc.getMap('docs');

  console.log(`filemeta_v0 has ${filemeta.size} entries`);
  console.log(`docs has ${legacyDocs.size} entries`);
  console.log('');

  // Find what exists
  console.log('Chris entries found:');
  let found = 0;
  for (const p of CHRIS_PATHS) {
    const inFilemeta = filemeta.has(p);
    const inDocs = legacyDocs.has(p);
    if (inFilemeta || inDocs) {
      const value = filemeta.get(p);
      const isYMap = value instanceof Y.Map;
      console.log(`  ${p}: filemeta=${inFilemeta}${isYMap ? ' (Y.Map!)' : ''} docs=${inDocs}`);
      found++;
    }
  }

  if (found === 0) {
    console.log('  None found — nothing to delete.');
    folderProvider.destroy();
    folderDoc.destroy();
    process.exit(0);
  }

  console.log('');

  if (!commit) {
    console.log('DRY RUN — no changes made. Pass --commit to delete these entries.');
    folderProvider.destroy();
    folderDoc.destroy();
    process.exit(0);
  }

  console.log('Deleting entries...');
  folderDoc.transact(() => {
    for (const p of CHRIS_PATHS) {
      if (filemeta.has(p)) {
        filemeta.delete(p);
        console.log(`  Deleted from filemeta_v0: ${p}`);
      }
      if (legacyDocs.has(p)) {
        legacyDocs.delete(p);
        console.log(`  Deleted from docs: ${p}`);
      }
    }
  }, 'cleanup-script');

  console.log('');
  console.log('Waiting for sync...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log(`filemeta_v0 now has ${filemeta.size} entries`);
  console.log(`docs now has ${legacyDocs.size} entries`);

  folderProvider.destroy();
  folderDoc.destroy();
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
