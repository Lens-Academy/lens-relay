/**
 * A made-up set of idea files for the concept map (/concept-map), to see how
 * it looks at the size the Context Accelerator is planned to have: about 150
 * ideas and 250 requirement links. Every name ends in "(fake NNN)". The same
 * set every time (a seeded generator), in the format of
 * `Lens Edu/Context Accelerator LOs/` (src/lib/idea-map.ts).
 *
 * For local relays only: scripts/seed-fake-ideas.ts.
 */

const ADJECTIVES = [
  'Wobbly', 'Purple', 'Sleepy', 'Invisible', 'Left-handed', 'Bouncing', 'Reluctant', 'Upside-down', 'Fuzzy',
  'Overcooked', 'Whispering', 'Square', 'Lukewarm', 'Borrowed', 'Sideways', 'Imaginary', 'Squeaky', 'Folded',
];
const NOUNS = [
  'teapot', 'walrus', 'umbrella', 'pancake', 'lighthouse', 'sock', 'cactus', 'trombone', 'penguin', 'doorknob',
  'marmalade', 'accordion', 'turnip', 'hammock', 'kazoo', 'pretzel', 'wheelbarrow', 'yo-yo', 'giraffe', 'biscuit',
];
const KINDS = [
  'principle', 'paradox', 'theorem', 'effect', 'problem', 'hypothesis', 'argument', 'trap', 'rule', 'thesis',
  'dilemma', 'law', 'in everyday practice', 'and why it fails', 'under pressure', 'for beginners',
];

/** mulberry32: a small seeded random number generator. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeIdeaOptions {
  /** How many ideas (default 150). */
  count?: number;
  /** Add three ideas' worth of circular requirements (default no). */
  cycle?: boolean;
}

export function fakeIdeas({ count = 150, cycle = false }: FakeIdeaOptions = {}): Array<{ name: string; text: string }> {
  const rand = random(87);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

  const names = Array.from({ length: count }, (_, i) =>
    `${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(KINDS)} (fake ${String(i + 1).padStart(3, '0')})`);

  // Layers that widen and then narrow, as a course does: a few foundations,
  // a broad middle, a few capstones.
  const layers = Math.max(3, Math.min(10, Math.round(count / 15)));
  const weights = Array.from({ length: layers }, (_, i) => 1 + Math.sin((Math.PI * (i + 0.5)) / layers));
  const total = weights.reduce((a, b) => a + b, 0);
  const layerOf: number[] = [];
  weights.forEach((w, layer) => {
    const size = layer === layers - 1 ? count - layerOf.length : Math.round((count * w) / total);
    for (let i = 0; i < size && layerOf.length < count; i++) layerOf.push(layer);
  });
  const inLayer = (layer: number) => layerOf.flatMap((l, i) => (l === layer ? [i] : []));

  const requires: number[][] = names.map(() => []);
  const helpful: number[][] = names.map(() => []);
  const unwritten: string[][] = names.map(() => []);
  names.forEach((_, i) => {
    const layer = layerOf[i];
    if (layer === 0) return;
    const wanted = rand() < 0.45 ? 1 : rand() < 0.75 ? 2 : 3;
    while (requires[i].length < wanted) {
      // Mostly the layer before, sometimes further back
      const back = rand() < 0.8 ? 1 : rand() < 0.7 ? 2 : 3;
      const from = inLayer(Math.max(0, layer - back));
      const target = pick(from);
      if (!requires[i].includes(target)) requires[i].push(target);
      if (from.length <= requires[i].length) break;
    }
    if (rand() < 0.2) {
      const target = pick(inLayer(Math.max(0, layer - 1 - Math.floor(rand() * 2))));
      if (!requires[i].includes(target)) helpful[i].push(target);
    }
  });
  // A few requirements nobody has written yet
  const gaps = ['Unwritten gizmo basics (fake)', 'Unwritten sprocket theory (fake)', 'Unwritten doohickey ethics (fake)'];
  if (count >= 30) {
    gaps.forEach((gap, g) => {
      unwritten[Math.floor(count / 3) + g * 17].push(gap);
      unwritten[Math.floor(count / 2) + g * 11].push(gap);
    });
  }
  if (cycle && count >= 3) {
    const [a, b, c] = [count - 3, count - 2, count - 1];
    requires[a].push(c);
    if (!requires[b].includes(a)) requires[b].push(a);
    if (!requires[c].includes(b)) requires[c].push(b);
  }

  return names.map((name, i) => {
    const priority = rand() < 0.3 ? 'high' : rand() < 0.65 ? 'medium' : 'low';
    // Every so often something is still missing, as in a real folder
    const noOutcome = i % 37 === 36;
    const noLens = i % 11 === 10;
    const questions = i % 9 === 8 ? 0 : 1 + Math.floor(rand() * 4);
    const subject = name.replace(/ \(fake \d+\)$/, '').toLowerCase();
    return {
      name,
      text: [
        '---',
        `id: ${uuid()}`,
        `priority: ${priority}`,
        'courses:',
        '  - "[[../courses/in-development/Context Accelerator]]"',
        '---',
        ...(noOutcome ? [] : [`Explain the ${subject} and say when it applies. (Made-up text for testing the concept map.)`]),
        '',
        '## Requires',
        ...requires[i].map((r) => `- [[${names[r]}]]`),
        ...unwritten[i].map((r) => `- [[${r}]]`),
        '',
        '## Helpful first',
        ...helpful[i].map((r) => `- [[${names[r]}]]`),
        '',
        '## Why it matters',
        `Without the ${subject}, the ideas that build on it make no sense. (Made up.)`,
        '',
        '## Lenses',
        ...(noLens ? [] : ['- Start with [[../Lenses/Demo Lens|the demo lens]] (5 minutes).']),
        '',
        '## Tests',
        ...Array.from({ length: questions }, (_, q) => [
          '#### Question: Open',
          `id:: ${uuid()}`,
          `content:: Made-up question ${q + 1} about the ${subject}: what would you expect, and why?`,
          'assessment-instructions:: Score out of 100. 100: any answer, this is test data.',
          '',
        ]).flat(),
      ].join('\n'),
    };
  });
}
