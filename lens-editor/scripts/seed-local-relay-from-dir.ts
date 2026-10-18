/**
 * Copy a directory of Markdown files into a LOCAL relay's folder (POST /doc/upsert),
 * keeping relative paths. Used to build fixtures for content migrations such as
 * scripts/migrate-topics-to-concepts.ts from a copy of real files.
 *
 * Usage (from lens-editor/):
 *   npx tsx scripts/seed-local-relay-from-dir.ts --from-dir <dir> \
 *     [--relay-url http://localhost:8090] [--folder "Lens Edu"]
 *
 * Refuses any relay that is not on localhost.
 */
import fs from 'fs';
import path from 'path';

let fromDir = '';
let relayUrl = 'http://localhost:8090';
let folder = 'Lens Edu';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = argv[i + 1];
  if (a === '--from-dir') { fromDir = v; i++; }
  else if (a === '--relay-url') { relayUrl = v.replace(/\/+$/, ''); i++; }
  else if (a === '--folder') { folder = v; i++; }
  else throw new Error(`Unknown argument: ${a}`);
}
if (!fromDir) throw new Error('--from-dir is required');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(relayUrl)) throw new Error('refusing a non-local relay');

const files: string[] = [];
const walk = (dir: string) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) walk(abs);
    else if (d.isFile() && d.name.endsWith('.md')) files.push(abs);
  }
};
walk(fromDir);
files.sort();

let n = 0;
for (const abs of files) {
  const rel = '/' + path.relative(fromDir, abs).split(path.sep).join('/');
  const res = await fetch(`${relayUrl}/doc/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, path: rel, content: fs.readFileSync(abs, 'utf8') }),
  });
  if (!res.ok) throw new Error(`upsert ${rel} failed: ${res.status} ${await res.text()}`);
  n++;
}
console.log(`Seeded ${n} files into ${folder} at ${relayUrl}`);
