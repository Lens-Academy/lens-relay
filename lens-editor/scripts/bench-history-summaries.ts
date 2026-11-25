// One-off: time the /log summaries for a file (Assay, #220). Usage: npx tsx scripts/bench-history-summaries.ts <repoDir> <path>
import { createHistory, groupSessions } from '../server/history/history.ts';
import { summarize } from '../shared/history-diff.ts';
const [repoDir, path] = process.argv.slice(2);
const h = createHistory({ repoDir, ref: 'refs/history/staging' });
const sessions = groupSessions(await h.log(path));
const shas = [...new Set(sessions.flatMap(s => (s.base ? [s.head, s.base] : [s.head])))];
const texts = new Map(shas.map((s, i) => [s, i]));
const got = await h.showMany(shas.map(sha => ({ sha, path })));
let total = 0, worst = 0;
for (const s of sessions) {
  const t0 = performance.now();
  const head = got[texts.get(s.head)!];
  if (head !== null) summarize(s.base ? got[texts.get(s.base)!] : null, head);
  const dt = performance.now() - t0; total += dt; worst = Math.max(worst, dt);
}
console.log(`${sessions.length} sessions, ${(got[0] ?? '').length} chars: total ${total.toFixed(0)} ms, worst ${worst.toFixed(0)} ms`);
