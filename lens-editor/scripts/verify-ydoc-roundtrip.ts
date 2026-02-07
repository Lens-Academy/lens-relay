/**
 * Verify Y.Doc round-trip: Real server data → JSON → reconstructed Y.Doc
 *
 * Usage: npx tsx scripts/verify-ydoc-roundtrip.ts
 */

import * as Y from 'yjs';

// From auth.ts - the server token for relay access
const SERVER_TOKEN = '2D3RhEOhAQSgWEGkAWxyZWxheS1zZXJ2ZXIDeB1odHRwczovL3JlbGF5LmxlbnNhY2FkZW15Lm9yZwYaaWdOJToAATlIZnNlcnZlckhUsS3xaA3zBw';
const RELAY_URL = 'https://relay.lensacademy.org';

// The shared folder ID from your relay setup
const FOLDER_DOC_ID = 'cb696037-0f72-4e93-8717-4e433129d789-fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';

interface FileMetadata {
  id: string;
  type: 'markdown' | 'folder' | 'image' | 'canvas' | 'file' | 'pdf';
  hash?: string;
}

async function getAuthToken(docId: string): Promise<{ url: string; token: string }> {
  const response = await fetch(`${RELAY_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ authorization: 'full' }),
  });

  if (!response.ok) {
    throw new Error(`Auth failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchYDocAsUpdate(docId: string): Promise<Uint8Array> {
  // First get auth token
  const auth = await getAuthToken(docId);

  // Use baseUrl (HTTP) not url (WebSocket)
  const fetchUrl = `${auth.baseUrl}/as-update`;
  console.log('   Fetching from:', fetchUrl);

  // Then fetch the document as update
  const response = await fetch(fetchUrl, {
    headers: {
      'Authorization': `Bearer ${auth.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function extractMetadataAsJSON(doc: Y.Doc): Record<string, FileMetadata> {
  const filemeta = doc.getMap<FileMetadata>('filemeta_v0');
  const result: Record<string, FileMetadata> = {};

  filemeta.forEach((value, key) => {
    result[key] = { ...value };
  });

  return result;
}

function reconstructFromJSON(metadata: Record<string, FileMetadata>): Y.Doc {
  const doc = new Y.Doc();
  const filemeta = doc.getMap<FileMetadata>('filemeta_v0');

  for (const [path, meta] of Object.entries(metadata)) {
    filemeta.set(path, meta);
  }

  return doc;
}

function compareYDocs(doc1: Y.Doc, doc2: Y.Doc): { identical: boolean; differences: string[] } {
  const differences: string[] = [];

  const map1 = doc1.getMap<FileMetadata>('filemeta_v0');
  const map2 = doc2.getMap<FileMetadata>('filemeta_v0');

  // Check sizes
  if (map1.size !== map2.size) {
    differences.push(`Size mismatch: ${map1.size} vs ${map2.size}`);
  }

  // Check each entry
  map1.forEach((value1, key) => {
    const value2 = map2.get(key);
    if (!value2) {
      differences.push(`Missing key in reconstructed: ${key}`);
    } else {
      if (value1.id !== value2.id) {
        differences.push(`ID mismatch for ${key}: ${value1.id} vs ${value2.id}`);
      }
      if (value1.type !== value2.type) {
        differences.push(`Type mismatch for ${key}: ${value1.type} vs ${value2.type}`);
      }
      if (value1.hash !== value2.hash) {
        differences.push(`Hash mismatch for ${key}: ${value1.hash} vs ${value2.hash}`);
      }
    }
  });

  // Check for extra keys in reconstructed
  map2.forEach((_, key) => {
    if (!map1.has(key)) {
      differences.push(`Extra key in reconstructed: ${key}`);
    }
  });

  return { identical: differences.length === 0, differences };
}

async function main() {
  console.log('=== Y.Doc Round-Trip Verification ===\n');

  // Step 1: Fetch real Y.Doc from relay
  console.log('1. Fetching real Y.Doc from relay...');
  const update = await fetchYDocAsUpdate(FOLDER_DOC_ID);
  console.log(`   Downloaded ${update.length} bytes\n`);

  // Step 2: Load into Y.Doc
  console.log('2. Loading into Y.Doc...');
  const realDoc = new Y.Doc();
  Y.applyUpdate(realDoc, update);

  // Show document structure
  console.log('   Document structure:');
  for (const [key, value] of realDoc.share) {
    console.log(`   - ${key}: ${value.constructor.name}`);
  }
  console.log();

  // Step 3: Extract as JSON
  console.log('3. Extracting filemeta_v0 as JSON...');
  const metadata = extractMetadataAsJSON(realDoc);
  const entryCount = Object.keys(metadata).length;
  console.log(`   Found ${entryCount} entries\n`);

  // Show sample entries
  console.log('   Sample entries:');
  const sampleKeys = Object.keys(metadata).slice(0, 5);
  for (const key of sampleKeys) {
    console.log(`   - "${key}": ${JSON.stringify(metadata[key])}`);
  }
  if (entryCount > 5) {
    console.log(`   ... and ${entryCount - 5} more`);
  }
  console.log();

  // Step 4: Reconstruct from JSON
  console.log('4. Reconstructing Y.Doc from JSON...');
  const reconstructed = reconstructFromJSON(metadata);
  console.log('   Done\n');

  // Step 5: Compare
  console.log('5. Comparing documents...');
  const { identical, differences } = compareYDocs(realDoc, reconstructed);

  if (identical) {
    console.log('   ✓ Content is IDENTICAL\n');
  } else {
    console.log('   ✗ Differences found:');
    for (const diff of differences) {
      console.log(`     - ${diff}`);
    }
    console.log();
  }

  // Step 6: Compare binary sizes (informational)
  console.log('6. Binary comparison (informational):');
  const realUpdate = Y.encodeStateAsUpdate(realDoc);
  const reconstructedUpdate = Y.encodeStateAsUpdate(reconstructed);
  console.log(`   Real doc update size: ${realUpdate.length} bytes`);
  console.log(`   Reconstructed update size: ${reconstructedUpdate.length} bytes`);
  console.log(`   Note: Binary won't match exactly (different client IDs, timestamps)\n`);

  // Step 7: Save JSON fixture for reference
  const fixtureFile = 'scripts/sample-folder-metadata.json';
  const fs = await import('fs/promises');
  await fs.writeFile(fixtureFile, JSON.stringify(metadata, null, 2));
  console.log(`7. Saved JSON fixture to ${fixtureFile}\n`);

  console.log('=== Verification Complete ===');
}

main().catch(console.error);
