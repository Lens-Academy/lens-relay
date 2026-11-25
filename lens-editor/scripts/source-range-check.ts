// How often a corpus row's source paragraph is found: npx tsx scripts/source-range-check.ts <staging clone>
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paragraphRange } from '../src/lib/source-range';

const repo = process.argv[2];
const { rows } = JSON.parse(readFileSync(join(homedir(), '.cache/jev-workbench/corpus.json'), 'utf8'));
let ok = 0, atLine = 0, miss = 0, nofile = 0;
const misses: string[] = [];
for (const r of rows.filter((_: unknown, i: number) => i % 10 === 0)) {
  const f = join(repo, r.path.replace(/^Lens Edu\//, ''));
  if (!existsSync(f)) { nofile++; continue; }
  const text = readFileSync(f, 'utf8');
  const got = paragraphRange(text, r.line, r.text);
  if (!got) { miss++; if (misses.length < 6) misses.push(`${r.path}:${r.line} | ${r.text.slice(0, 70)}`); continue; }
  ok++;
  const lineStart = text.split('\n').slice(0, r.line - 1).join('\n').length + (r.line > 1 ? 1 : 0);
  if (got.from === lineStart) atLine++;
}
console.log({ ok, atLine, miss, nofile });
console.log(misses.join('\n'));
