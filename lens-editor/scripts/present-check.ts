// How the workbench's document parser finds the platform splitter's paragraphs: for each corpus
// row, the parsed paragraph its words (else its line) lead to in the current file, and whether
// the words agree. Files from a lens-edu-staging checkout: JEV_FILES_DIR (default the scratch clone).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDoc, unitOf } from '../src/lib/jev-present';
const rows = JSON.parse(readFileSync(process.env.HOME + '/.cache/jev-workbench/corpus.json', 'utf8')).rows as { path: string; line: number; text: string }[];
const dir = process.env.JEV_FILES_DIR ?? process.env.HOME + '/sandbox/scratch/lens-edu-staging';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const docs = new Map<string, ReturnType<typeof parseDoc> | null>();
const n = { rows: rows.length, noFile: 0, notFound: 0, same: 0, contains: 0, other: 0 };
for (const r of rows) {
  const f = join(dir, r.path.replace(/^Lens Edu\//, ''));
  if (!docs.has(r.path)) docs.set(r.path, existsSync(f) ? parseDoc(readFileSync(f, 'utf8')) : null);
  const d = docs.get(r.path);
  if (!d) { n.noFile++; continue; }
  const u = unitOf(d, 'paragraph', r.line, r.text);
  if (!u) { n.notFound++; continue; }
  const a = norm(u.text), b = norm(r.text);
  if (a === b) n.same++; else if (a.includes(b.slice(0, 40))) n.contains++; else n.other++;
}
console.log(n);
