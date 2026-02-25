#!/usr/bin/env node
/**
 * Dump filemeta_v0 and legacy docs Y.Map contents for a folder document.
 * Usage: node scripts/dump-filemeta.mjs [folder-doc-id]
 *
 * Defaults to local relay test folders. Pass a doc ID to inspect a specific folder.
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

// Relay server ID
const RELAY_ID = process.env.RELAY_ID || 'a0000000-0000-4000-8000-000000000000';

// Default: local test folder IDs
const DEFAULT_FOLDERS = [
  'b0000001-0000-4000-8000-000000000001',
  'b0000002-0000-4000-8000-000000000002',
];

const folderIds = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : DEFAULT_FOLDERS;

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

async function dumpFolder(folderId) {
  const compoundId = `${RELAY_ID}-${folderId}`;
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Folder: ${folderId}`);
  console.log(`Compound ID: ${compoundId}`);
  console.log('='.repeat(80));

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

  // Dump folder_config
  const folderConfig = doc.getMap('folder_config');
  console.log(`\nfolder_config:`);
  for (const [key, value] of folderConfig.entries()) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }

  // Dump filemeta_v0
  const filemeta = doc.getMap('filemeta_v0');
  const filemetaEntries = Array.from(filemeta.entries());
  console.log(`\nfilemeta_v0 (${filemetaEntries.length} entries):`);

  // Sort by path for readability
  filemetaEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const pathIssues = [];
  for (const [path, meta] of filemetaEntries) {
    const flags = [];
    if (path.startsWith('//')) flags.push('DOUBLE-SLASH');
    if (!path.startsWith('/')) flags.push('NO-LEADING-SLASH');
    if (path.includes('//')) flags.push('CONTAINS-DOUBLE-SLASH');

    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    if (flags.length > 0) pathIssues.push({ path, flags });

    console.log(`  ${JSON.stringify(path)} → ${JSON.stringify(meta)}${flagStr}`);
  }

  // Dump legacy docs
  const legacyDocs = doc.getMap('docs');
  const legacyEntries = Array.from(legacyDocs.entries());
  console.log(`\ndocs (legacy) (${legacyEntries.length} entries):`);

  legacyEntries.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [path, id] of legacyEntries) {
    const flags = [];
    if (path.startsWith('//')) flags.push('DOUBLE-SLASH');
    if (!path.startsWith('/')) flags.push('NO-LEADING-SLASH');
    if (path.includes('//')) flags.push('CONTAINS-DOUBLE-SLASH');

    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    console.log(`  ${JSON.stringify(path)} → ${JSON.stringify(id)}${flagStr}`);
  }

  // Summary
  if (pathIssues.length > 0) {
    console.log(`\n⚠️  PATH ISSUES FOUND (${pathIssues.length}):`);
    for (const { path, flags } of pathIssues) {
      console.log(`  ${JSON.stringify(path)} — ${flags.join(', ')}`);
    }
  } else {
    console.log(`\n✓ No path issues found.`);
  }

  provider.destroy();
  doc.destroy();
}

// Main
console.log(`Connecting to relay at ${RELAY_URL}`);
console.log(`Relay ID: ${RELAY_ID}`);

for (const folderId of folderIds) {
  try {
    await dumpFolder(folderId);
  } catch (err) {
    console.error(`\nFailed to dump folder ${folderId}: ${err.message}`);
  }
}

console.log('\nDone.');
process.exit(0);
