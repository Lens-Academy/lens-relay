#!/usr/bin/env node
/**
 * Restore the /Chris/ folder and its 6 files to the Lens folder's filemeta.
 *
 * These files were destroyed by the Obsidian moveFolder crash loop on 2026-02-23.
 * Content Y.Docs still exist in R2 — this script only re-creates the filemeta
 * entries (filemeta_v0 + legacy docs) pointing to the original UUIDs.
 *
 * UUIDs recovered from the Feb 12 production R2 backup.
 *
 * Usage:
 *   node scripts/restore-chris-files.mjs <folder-uuid> [--commit]
 *
 * Environment:
 *   RELAY_PORT  - relay server port (default: auto-detect from workspace)
 *   RELAY_ID    - relay server ID (default: local test ID)
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
  console.error('Usage: node scripts/restore-chris-files.mjs <folder-uuid> [--commit]');
  console.error('');
  console.error('Without --commit, runs in dry-run mode (shows what would be created).');
  process.exit(1);
}

// Original UUIDs from Feb 12 production R2 backup
const CHRIS_FOLDER_UUID = '6c968d63-7529-4f50-b568-bfba1246320d';
const FILES = [
  { path: "/Chris/Chris's log.md",                      uuid: '59f4ab6b-2524-41ef-8b15-5abf246ad126' },
  { path: '/Chris/LLM prompts.md',                      uuid: '6706fe00-209a-4aee-a529-48ccf7213a86' },
  { path: '/Chris/meeting notes - week 3 materials.md',  uuid: '04c727c9-6a4a-4613-b5cd-30cfd78cce4f' },
  { path: '/Chris/project management.md',               uuid: 'dbe5643a-3533-43eb-831a-46b6bcd45f8f' },
  { path: '/Chris/Week 2 meeting export.md',            uuid: '19463993-74c3-43e7-857f-aed99c547dc9' },
  { path: '/Chris/Week 3 meeting import.md',            uuid: '1e964e27-86aa-465f-9fee-b321c537af32' },
];

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

async function restore() {
  const compoundId = `${RELAY_ID}-${folderId}`;
  console.log(`Relay: ${RELAY_URL}`);
  console.log(`Folder: ${folderId} (${compoundId})`);
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('');

  console.log('Entries to restore (original UUIDs from Feb 12 backup):');
  console.log(`  /Chris (folder) → ${CHRIS_FOLDER_UUID}`);
  for (const f of FILES) {
    console.log(`  ${f.path} → ${f.uuid}`);
  }
  console.log('');

  if (!commit) {
    console.log('DRY RUN — no changes made. Pass --commit to restore these entries.');
    process.exit(0);
  }

  // Connect to the folder document
  console.log('Connecting to folder document...');
  const { doc: folderDoc, provider: folderProvider } = await connectDoc(compoundId);

  const filemeta = folderDoc.getMap('filemeta_v0');
  const legacyDocs = folderDoc.getMap('docs');

  // Check for existing entries
  console.log('Checking for existing entries...');
  let conflicts = false;
  if (filemeta.has('/Chris')) {
    console.log('  CONFLICT: /Chris already exists in filemeta_v0');
    conflicts = true;
  }
  for (const f of FILES) {
    if (filemeta.has(f.path)) {
      console.log(`  CONFLICT: ${f.path} already exists in filemeta_v0`);
      conflicts = true;
    }
    if (legacyDocs.has(f.path)) {
      console.log(`  CONFLICT: ${f.path} already exists in docs`);
      conflicts = true;
    }
  }
  if (conflicts) {
    console.log('');
    console.log('Aborting — conflicts found. Remove existing entries first.');
    folderProvider.destroy();
    folderDoc.destroy();
    process.exit(1);
  }
  console.log('  No conflicts.');

  console.log('Writing filemeta entries...');
  folderDoc.transact(() => {
    // Create /Chris folder entry as plain object (NOT Y.Map!)
    // Obsidian stores filemeta values as plain JS objects, not nested Y.Maps.
    // Using Y.Map would break the editor which accesses meta.id directly.
    filemeta.set('/Chris', { id: CHRIS_FOLDER_UUID, type: 'folder', version: 0 });
    console.log(`  filemeta_v0: /Chris → { type: "folder", id: "${CHRIS_FOLDER_UUID}" }`);

    // Create file entries in both maps
    for (const f of FILES) {
      filemeta.set(f.path, { id: f.uuid, type: 'markdown', version: 0 });
      legacyDocs.set(f.path, f.uuid);
      console.log(`  filemeta_v0 + docs: ${f.path} → ${f.uuid}`);
    }
  }, 'restore-script');

  // Wait for sync
  console.log('');
  console.log('Waiting for sync...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Verify
  console.log('');
  console.log('Verifying...');
  let ok = true;
  if (!filemeta.has('/Chris')) {
    console.log('  MISSING: /Chris folder entry');
    ok = false;
  } else {
    console.log('  OK: /Chris folder entry');
  }
  for (const f of FILES) {
    if (!filemeta.has(f.path)) {
      console.log(`  MISSING: ${f.path} in filemeta_v0`);
      ok = false;
    } else {
      console.log(`  OK: ${f.path} in filemeta_v0`);
    }
    if (!legacyDocs.has(f.path)) {
      console.log(`  MISSING: ${f.path} in docs`);
      ok = false;
    } else {
      console.log(`  OK: ${f.path} in docs`);
    }
  }

  if (ok) {
    console.log('');
    console.log('All entries restored successfully.');
  } else {
    console.log('');
    console.log('WARNING: Some entries are missing.');
  }

  folderProvider.destroy();
  folderDoc.destroy();
}

try {
  await restore();
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('Done.');
process.exit(0);
