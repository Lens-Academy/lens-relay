// How often the workbench's document parser lands on the platform splitter's paragraph:
// for each corpus row, the parsed paragraph at its line, and whether its words match.
import { readFileSync } from 'node:fs';
import { parseDoc, unitOf } from '../src/lib/jev-present';
const dir = process.env.HOME + '/.cache/jev-workbench/';
const rows = JSON.parse(readFileSync(dir + 'corpus.json', 'utf8')).rows as { path: string; line: number; text: string }[];
const files = JSON.parse(readFileSync(dir + 'files.json', 'utf8')).files as Record<string, string>;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const docs = new Map<string, ReturnType<typeof parseDoc>>();
let found = 0, same = 0, contains = 0;
const misses: string[] = [];
for (const r of rows) {
  if (!docs.has(r.path)) docs.set(r.path, parseDoc(files[r.path] ?? ''));
  const u = unitOf(docs.get(r.path)!, 'paragraph', r.line);
  if (!u) { misses.push(`${r.path}:${r.line}`); continue; }
  found++;
  const a = norm(u.text), b = norm(r.text);
  if (a === b) same++; else if (a.includes(b.slice(0, 40))) contains++;
}
console.log({ rows: rows.length, found, same, contains, missing: misses.length, sampleMisses: misses.slice(0, 5) });
