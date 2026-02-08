#!/usr/bin/env node
/**
 * Extract filemeta_v0, legacy docs, and backlinks_v0 Y.Maps from local relay.
 * Outputs markdown to stdout.
 */

import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';

const RELAY_URL = 'http://localhost:8090';
const RELAY_ID = 'a0000000-0000-4000-8000-000000000000';

const FOLDERS = [
  { name: 'Relay Folder 1', id: 'b0000001-0000-4000-8000-000000000001' },
  { name: 'Relay Folder 2', id: 'b0000002-0000-4000-8000-000000000002' },
];

async function getClientToken(docId) {
  const response = await fetch(`${RELAY_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: 'full' }),
  });
  if (!response.ok) throw new Error(`Auth failed for ${docId}: ${response.status}`);
  return response.json();
}

async function connectAndRead(docId, readFn) {
  const doc = new Y.Doc();
  const provider = new YSweetProvider(() => getClientToken(docId), docId, doc, {
    connect: true,
    showDebuggerLink: false,
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timeout')), 10000);
    provider.on('synced', () => { clearTimeout(timeout); resolve(); });
    provider.on('connection-error', (err) => { clearTimeout(timeout); reject(err); });
  });

  const result = readFn(doc);
  provider.destroy();
  doc.destroy();
  return result;
}

function yMapToObject(ymap) {
  const obj = {};
  ymap.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

async function main() {
  const lines = [];
  lines.push('# Y.Doc Map Dumps (Local Relay)');
  lines.push('');
  lines.push(`Extracted: ${new Date().toISOString()}`);
  lines.push(`Relay URL: ${RELAY_URL}`);
  lines.push(`Relay ID: ${RELAY_ID}`);
  lines.push('');

  for (const folder of FOLDERS) {
    const folderDocId = `${RELAY_ID}-${folder.id}`;
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${folder.name}`);
    lines.push('');
    lines.push(`Folder doc ID: \`${folderDocId}\``);
    lines.push('');

    const maps = await connectAndRead(folderDocId, (doc) => {
      const filemeta = doc.getMap('filemeta_v0');
      const legacyDocs = doc.getMap('docs');
      const backlinks = doc.getMap('backlinks_v0');

      return {
        filemeta: yMapToObject(filemeta),
        legacyDocs: yMapToObject(legacyDocs),
        backlinks: yMapToObject(backlinks),
      };
    });

    lines.push('### filemeta_v0');
    lines.push('');
    lines.push('Maps path -> metadata for every file/folder in this shared folder.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(maps.filemeta, null, 2));
    lines.push('```');
    lines.push('');

    lines.push('### docs (legacy)');
    lines.push('');
    lines.push('Maps path -> UUID. Required for Obsidian compatibility.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(maps.legacyDocs, null, 2));
    lines.push('```');
    lines.push('');

    lines.push('### backlinks_v0');
    lines.push('');
    lines.push('Maps target_uuid -> array of source_uuids that link to it.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(maps.backlinks, null, 2));
    lines.push('```');
    lines.push('');
  }

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('Dump failed:', err);
  process.exit(1);
});
