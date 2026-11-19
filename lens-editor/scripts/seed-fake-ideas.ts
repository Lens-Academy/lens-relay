/**
 * Put a made-up set of ideas into a LOCAL relay, to try the concept map
 * (/concept-map) at scale: about 150 ideas and 250 requirement links, every
 * name ending in "(fake NNN)" (scripts/lib/fake-ideas.ts). They go into a
 * folder of their own next to the real one, never into it:
 * `Lens Edu/Context Accelerator LOs (fake 150)/`, which the map shows at
 * /concept-map?folder=Context%20Accelerator%20LOs%20(fake%20150).
 *
 * Not part of the default seed (npm run relay:setup). Run it again and the
 * same files are written again (POST /doc/upsert).
 *
 * Usage (from lens-editor/):
 *   npx tsx scripts/seed-fake-ideas.ts [--relay-url http://localhost:8090]
 *     [--count 150] [--cycle] [--folder "Context Accelerator LOs (fake 150)"]
 *
 * Refuses any relay that is not on localhost, and the real ideas folder.
 */
import { fakeIdeas } from './lib/fake-ideas';
import { IDEAS_FOLDER } from '../src/lib/idea-map';

let relayUrl = 'http://localhost:8090';
let count = 150;
let cycle = false;
let folder = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = argv[i + 1];
  if (a === '--relay-url') { relayUrl = v.replace(/\/+$/, ''); i++; }
  else if (a === '--count') { count = parseInt(v, 10); i++; }
  else if (a === '--folder') { folder = v.replace(/^\/+|\/+$/g, ''); i++; }
  else if (a === '--cycle') cycle = true;
  else throw new Error(`Unknown argument: ${a}`);
}
folder ||= `${IDEAS_FOLDER} (fake ${count}${cycle ? ', cycle' : ''})`;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(relayUrl)) throw new Error('refusing a non-local relay');
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('--count must be 1 to 1000');
if (folder.toLowerCase() === IDEAS_FOLDER.toLowerCase()) throw new Error('refusing the real ideas folder');

const files = fakeIdeas({ count, cycle });

async function upsert(file: { name: string; text: string }) {
  const path = `/${folder}/${file.name}.md`;
  // A busy relay answers 404 now and then; the same call goes through a moment later
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${relayUrl}/doc/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'Lens Edu', path, content: file.text }),
    });
    if (res.ok) return;
    if (attempt === 5) throw new Error(`upsert ${path} failed: ${res.status} ${await res.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

// The first file alone, so the folder exists before the others arrive;
// then a few at a time: the relay indexes links as files arrive
const [first, ...queue] = files;
await upsert(first);
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) await upsert(file);
}));
console.log(`Seeded ${files.length} made-up ideas into Lens Edu/${folder} at ${relayUrl}`);
console.log(`Open /concept-map?folder=${encodeURIComponent(folder)}`);
