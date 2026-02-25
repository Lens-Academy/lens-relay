#!/usr/bin/env node
/**
 * Dump filemeta from a raw data.ysweet file (offline, no relay server needed).
 * Handles both CBOR (new) and bincode (old) y-sweet storage formats.
 *
 * Usage: node scripts/dump-filemeta-file.mjs <path-to-data.ysweet> [<path2> ...]
 */

import fs from 'fs';
import * as Y from 'yjs';
import cbor from 'cbor';

/**
 * Decode a data.ysweet file into Y.Doc updates.
 * Format: CBOR { version, created_at, modified_at, metadata, data: Map<bytes, bytes> }
 * The "data" field is a key-value store where values are Y.Doc update chunks.
 */
function loadYDoc(filePath) {
  const raw = fs.readFileSync(filePath);
  const doc = new Y.Doc();

  try {
    // Try CBOR format first
    const yData = cbor.decodeFirstSync(raw);

    if (yData && typeof yData === 'object' && yData.data) {
      console.log(`  Format: CBOR v${yData.version}, created: ${new Date(Number(yData.created_at)).toISOString()}`);

      // yData.data is a Map<Buffer, Buffer> — the values are Y.Doc update chunks
      const dataMap = yData.data;

      if (dataMap instanceof Map) {
        for (const [, value] of dataMap) {
          Y.applyUpdate(doc, new Uint8Array(value));
        }
      } else if (typeof dataMap === 'object') {
        for (const key of Object.keys(dataMap)) {
          Y.applyUpdate(doc, new Uint8Array(dataMap[key]));
        }
      }
    } else {
      throw new Error('Not CBOR YSweetData format');
    }
  } catch (cborErr) {
    // Fallback: try as raw Y.Doc update
    console.log(`  Format: raw Y.Doc update (CBOR decode failed: ${cborErr.message})`);
    Y.applyUpdate(doc, new Uint8Array(raw));
  }

  return doc;
}

function dumpDoc(filePath) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`File: ${filePath}`);
  console.log('='.repeat(80));

  const doc = loadYDoc(filePath);

  // folder_config
  const folderConfig = doc.getMap('folder_config');
  console.log(`\nfolder_config:`);
  for (const [key, value] of folderConfig.entries()) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }

  // filemeta_v0
  const filemeta = doc.getMap('filemeta_v0');
  const filemetaEntries = Array.from(filemeta.entries());
  console.log(`\nfilemeta_v0 (${filemetaEntries.length} entries):`);

  filemetaEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const pathIssues = [];
  for (const [path, meta] of filemetaEntries) {
    const flags = [];
    if (path.startsWith('//')) flags.push('DOUBLE-SLASH');
    if (!path.startsWith('/')) flags.push('NO-LEADING-SLASH');
    if (path.slice(1).includes('//')) flags.push('INTERNAL-DOUBLE-SLASH');
    if (path.endsWith('/')) flags.push('TRAILING-SLASH');
    if (path !== path.trim()) flags.push('WHITESPACE');

    const flagStr = flags.length > 0 ? `  ⚠️  [${flags.join(', ')}]` : '';
    if (flags.length > 0) pathIssues.push({ path, flags });

    let metaObj;
    if (meta instanceof Y.Map) {
      metaObj = {};
      for (const [k, v] of meta.entries()) metaObj[k] = v;
    } else {
      metaObj = meta;
    }

    console.log(`  ${JSON.stringify(path)} → ${JSON.stringify(metaObj)}${flagStr}`);
  }

  // legacy docs
  const legacyDocs = doc.getMap('docs');
  const legacyEntries = Array.from(legacyDocs.entries());
  console.log(`\ndocs (legacy) (${legacyEntries.length} entries):`);

  legacyEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const legacyIssues = [];
  for (const [path, id] of legacyEntries) {
    const flags = [];
    if (path.startsWith('//')) flags.push('DOUBLE-SLASH');
    if (!path.startsWith('/')) flags.push('NO-LEADING-SLASH');
    if (path.slice(1).includes('//')) flags.push('INTERNAL-DOUBLE-SLASH');
    if (path.endsWith('/')) flags.push('TRAILING-SLASH');
    if (path !== path.trim()) flags.push('WHITESPACE');

    const flagStr = flags.length > 0 ? `  ⚠️  [${flags.join(', ')}]` : '';
    if (flags.length > 0) legacyIssues.push({ path, flags });

    console.log(`  ${JSON.stringify(path)} → ${JSON.stringify(id)}${flagStr}`);
  }

  // Check for filemeta ↔ legacy docs mismatches
  const filemetaPaths = new Set(filemetaEntries.filter(([_, m]) => {
    const type = m instanceof Y.Map ? m.get('type') : m?.type;
    return type !== 'folder';
  }).map(([p]) => p));
  const legacyPaths = new Set(legacyEntries.map(([p]) => p));

  const inFilemetaOnly = [...filemetaPaths].filter(p => !legacyPaths.has(p));
  const inLegacyOnly = [...legacyPaths].filter(p => !filemetaPaths.has(p));

  if (inFilemetaOnly.length > 0) {
    console.log(`\n⚠️  In filemeta_v0 but NOT in docs (${inFilemetaOnly.length}):`);
    for (const p of inFilemetaOnly) console.log(`  ${JSON.stringify(p)}`);
  }
  if (inLegacyOnly.length > 0) {
    console.log(`\n⚠️  In docs but NOT in filemeta_v0 (${inLegacyOnly.length}):`);
    for (const p of inLegacyOnly) console.log(`  ${JSON.stringify(p)}`);
  }

  // Summary
  const allIssues = [...pathIssues, ...legacyIssues];
  if (allIssues.length > 0) {
    console.log(`\n⚠️  PATH ISSUES FOUND (${allIssues.length}):`);
    for (const { path, flags } of allIssues) {
      console.log(`  ${JSON.stringify(path)} — ${flags.join(', ')}`);
    }
  } else {
    console.log(`\n✓ No path issues found.`);
  }

  if (inFilemetaOnly.length === 0 && inLegacyOnly.length === 0) {
    console.log('✓ filemeta_v0 and docs maps are in sync.');
  }

  doc.destroy();
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/dump-filemeta-file.mjs <path-to-data.ysweet> [...]');
  process.exit(1);
}

for (const f of files) {
  try {
    dumpDoc(f);
  } catch (err) {
    console.error(`\nFailed to dump ${f}: ${err.message}`);
  }
}

console.log('\nDone.');
