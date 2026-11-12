import { describe, expect, it } from 'vitest';
import {
  IDEA_MOVED_ERROR,
  PENDING_QUESTIONS_ERROR,
  PENDING_QUESTION_ERROR,
  PENDING_REQUIREMENTS_ERROR,
  QUESTION_MOVED_ERROR,
  applyChanges,
  buildIdeaGraph,
  deletePlan,
  deletePlanChanges,
  dependentEdits,
  dependentLinkChanges,
  dependentsDiff,
  ideaAsEdit,
  ideaEditChanges,
  ideaEditProblem,
  ideaNameProblem,
  mapColumns,
  mergePicks,
  neededForCircle,
  newQuestionProblem,
  parseIdea,
  pickChoices,
  profileNameProblem,
  questionAsNew,
  questionChanges,
  questionDeleteChanges,
  questionEditChanges,
  removeLinkChanges,
  removeLinksChanges,
  renameLinkChanges,
  renderIdeaFile,
  renderQuestion,
  requirementChanges,
  requirementCircle,
  sortIdeas,
  togglePick,
  type IdeaEdit,
  type IdeaFile,
  type NewQuestion,
} from './idea-map';

const INSTRUMENTAL = `---
id: 066b5be7-626c-46bf-bdb1-d81f1544c098
priority: high
courses:
  - "[[../courses/in-development/Context Accelerator]]"
---
Explain why agents with very different final goals would pursue the same sub-goals.

## Requires

## Helpful first
- [[Orthogonality thesis]]

## Why it matters
It is the reason an AI does not need to hate us to be dangerous.

## Learn
- Start with [[../Lenses/AFSRA - Instrumental Convergence|Rob Miles's video on instrumental convergence]] (11 minutes).
- [[../Lenses/IABIED - Instrumental Sub-Goal Convergence]]

## Questions
#### Question: Open
id:: 44390f4c-7e48-445e-b564-1c9f205e2685
content:: Would you expect it to resist being switched off? Why?
assessment-instructions:: Score out of 100.

#### Question: Choice
id:: d655611e-d45f-4e7b-ba13-d7207a178f35
content:: Which of these would you NOT expect?
options::
- Getting more computing power
- [x] Making humans happy
shuffle:: true
`;

const POWER = `---
id: 1c37baa4-6a91-4fe3-9e26-16b739cb1962
priority: high
courses:
  - "[[../courses/in-development/Context Accelerator]]"
---
Explain why an AI pursuing almost any goal would tend to seek power.

## Requires
- [[Instrumental convergence]]

## Helpful first

## Why it matters
A mistake in that goal gets harder to fix the longer the AI runs.

## Learn
- [[../Lenses/When should we worry about AI power-seeking]]

## Questions
#### Question: Open
id:: 74d8bbf1-d845-4834-8b5c-7a6759161af8
content:: Why would it try to gain control?
`;

/** Frontmatter with nothing to warn about. */
const FM = '---\nid: 00000000-0000-4000-8000-000000000000\npriority: medium\n---\n';

/** A small idea file: `requires` and `helpful` are names. */
function idea(requires: string[] = [], helpful: string[] = [], id = ''): string {
  return [
    '---',
    `id: ${id || '00000000-0000-4000-8000-000000000000'}`,
    'priority: medium',
    '---',
    'Explain something.',
    '',
    '## Requires',
    ...requires.map((r) => `- [[${r}]]`),
    '',
    '## Helpful first',
    ...helpful.map((r) => `- [[${r}]]`),
    '',
    '## Learn',
    '- [[../Lenses/A lens]]',
    '',
    '## Questions',
    '#### Question: Open',
    'id:: 11111111-1111-4111-8111-111111111111',
    'content:: A question.',
    '',
  ].join('\n');
}

let nextId = 0;
function files(spec: Record<string, string>): IdeaFile[] {
  return Object.entries(spec).map(([name, text]) => ({ name, docId: `doc-${name}`, text }));
}
/** Files from name → required names, each with its own id. */
function ideas(spec: Record<string, string[]>): IdeaFile[] {
  return files(Object.fromEntries(Object.entries(spec).map(([name, requires]) => {
    const id = `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
    return [name, idea(requires, [], id)];
  })));
}

describe('parseIdea', () => {
  it('reads the frontmatter, the outcome and every section', () => {
    const parsed = parseIdea(INSTRUMENTAL);
    expect(parsed.id).toBe('066b5be7-626c-46bf-bdb1-d81f1544c098');
    expect(parsed.priority).toBe('high');
    expect(parsed.courses).toEqual(['../courses/in-development/Context Accelerator']);
    expect(parsed.outcome).toBe('Explain why agents with very different final goals would pursue the same sub-goals.');
    expect(parsed.requires).toEqual([]);
    expect(parsed.helpful).toEqual(['Orthogonality thesis']);
    expect(parsed.why).toBe('It is the reason an AI does not need to hate us to be dangerous.');
    expect(parsed.questions).toBe(2);
    expect(parsed.bareQuestions).toBe(0);
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps the Learn lines as written, with each link and its shown words', () => {
    const parsed = parseIdea(INSTRUMENTAL);
    expect(parsed.learn).toEqual([
      [
        { text: 'Start with ' },
        { link: '../Lenses/AFSRA - Instrumental Convergence', label: "Rob Miles's video on instrumental convergence" },
        { text: ' (11 minutes).' },
      ],
      [{ link: '../Lenses/IABIED - Instrumental Sub-Goal Convergence', label: 'IABIED - Instrumental Sub-Goal Convergence' }],
    ]);
    expect(parsed.lenses).toEqual([
      '../Lenses/AFSRA - Instrumental Convergence',
      '../Lenses/IABIED - Instrumental Sub-Goal Convergence',
    ]);
  });

  it('reads requirements with aliases, anchors and several links on a line', () => {
    const parsed = parseIdea('Outcome.\n\n## Requires\n- [[A|the first]] and [[B#part]]\n* [[A]]\n\n## Helpful first\n[[C.md]]\n');
    expect(parsed.requires).toEqual(['A', 'B']);
    expect(parsed.helpful).toEqual(['C']);
  });

  it('matches section headings in any case and ignores unknown ones with a warning', () => {
    const parsed = parseIdea(FM + 'Outcome.\n\n## REQUIRES\n- [[A]]\n\n## Notes\n- [[B]]\n\n## why it matters\nBecause.\n');
    expect(parsed.requires).toEqual(['A']);
    expect(parsed.why).toBe('Because.');
    expect(parsed.warnings).toEqual(['Unknown section "Notes"']);
  });

  it('takes a missing or unknown priority as medium, with a warning', () => {
    expect(parseIdea('---\nid: 066b5be7-626c-46bf-bdb1-d81f1544c098\n---\nOutcome.\n')).toMatchObject({
      priority: 'medium',
      warnings: ['No priority: taken as medium'],
    });
    expect(parseIdea('---\npriority: urgent\n---\nOutcome.\n')).toMatchObject({
      priority: 'medium',
      warnings: ['Unknown priority "urgent": taken as medium'],
    });
    expect(parseIdea('---\npriority: High\n---\nOutcome.\n').priority).toBe('high');
  });

  it('has no id when the frontmatter has none or it is not a UUID', () => {
    expect(parseIdea('Outcome.\n').id).toBeNull();
    expect(parseIdea('---\nid: <new uuid>\npriority: low\n---\nOutcome.\n').id).toBeNull();
  });

  it('reads course links written without quotes', () => {
    expect(parseIdea('---\ncourses:\n  - [[../courses/A course]]\n  - "[[../courses/B|shown]]"\n---\nOutcome.\n').courses)
      .toEqual(['../courses/A course', '../courses/B']);
  });

  it('strips %% comments before reading the body', () => {
    const parsed = parseIdea('Outcome. %%a note%%\n\n## Requires\n- [[A]]\n\n%%\n## Requires\n- [[Hidden]]\n%%\n');
    expect(parsed.outcome).toBe('Outcome.');
    expect(parsed.requires).toEqual(['A']);
  });

  it('reads the text learners get: pending suggestions are not in it', () => {
    const text = 'Outcome{++ suggested++}.\n\n## Requires\n- [[A]]\n{++- [[Suggested]]\n++}{--- [[Kept]]\n--}';
    const parsed = parseIdea(text);
    expect(parsed.outcome).toBe('Outcome.');
    expect(parsed.requires).toEqual(['A', 'Kept']);
  });

  it('counts typed questions and reports bare and unknown ones', () => {
    const parsed = parseIdea(FM + 'Outcome.\n\n## Questions\n#### Question: Open\nid:: a\n\n#### Question\nid:: b\n\n#### Question: Essay\nid:: c\n\n#### Text\ncontent:: x\n');
    expect(parsed.questions).toBe(3);
    expect(parsed.bareQuestions).toBe(1);
    expect(parsed.warnings).toEqual(['Unknown question type "Essay"']);
  });

  it('reads a file with Windows line endings', () => {
    const parsed = parseIdea('---\r\npriority: low\r\n---\r\nOutcome.\r\n\r\n## Requires\r\n- [[A]]\r\n');
    expect(parsed).toMatchObject({ priority: 'low', outcome: 'Outcome.', requires: ['A'] });
  });

  it('reads an empty file without failing', () => {
    expect(parseIdea('')).toMatchObject({ id: null, outcome: '', requires: [], questions: 0 });
  });
});

describe('buildIdeaGraph', () => {
  const graph = buildIdeaGraph(files({ 'Instrumental convergence': INSTRUMENTAL, 'Power-seeking': POWER }));

  it('has a node per file and a placeholder per target with no file', () => {
    expect(graph.nodes.map((n) => [n.name, n.written])).toEqual([
      ['Instrumental convergence', true],
      ['Orthogonality thesis', false],
      ['Power-seeking', true],
    ]);
    expect(graph.byKey.get('orthogonality thesis')).toMatchObject({ docId: null, idea: null, helpfulFor: ['instrumental convergence'] });
  });

  it('computes "needed for" from the Requires of the others', () => {
    expect(graph.byKey.get('instrumental convergence')!.neededFor).toEqual(['power-seeking']);
    expect(graph.byKey.get('power-seeking')!.requires).toEqual(['instrumental convergence']);
    expect(graph.byKey.get('power-seeking')!.neededFor).toEqual([]);
  });

  it('resolves names whatever their case, and keeps the file name', () => {
    const g = buildIdeaGraph(ideas({ Alpha: [], Beta: ['ALPHA'] }));
    expect(g.nodes.map((n) => n.name)).toEqual(['Alpha', 'Beta']);
    expect(g.byKey.get('beta')!.requires).toEqual(['alpha']);
  });

  it('skips files whose name starts with _', () => {
    const g = buildIdeaGraph(files({ _Template: idea(['Name of an idea']), Alpha: idea() }));
    expect(g.nodes.map((n) => n.name)).toEqual(['Alpha']);
  });

  it('puts ideas in steps: one more than the latest requirement', () => {
    const g = buildIdeaGraph(ideas({ A: [], B: ['A'], C: ['A', 'B'], D: [], E: ['Missing'] }));
    expect(g.steps.map((step) => step.map((n) => n.name))).toEqual([
      ['A', 'D', 'Missing'],
      ['B', 'E'],
      ['C'],
    ]);
    expect(g.byKey.get('c')!.step).toBe(3);
  });

  it('does not let "helpful first" move an idea to a later step', () => {
    const g = buildIdeaGraph(files({ A: idea(), B: idea([], ['A']) }));
    expect(g.byKey.get('b')!.step).toBe(1);
  });

  it('keeps a link named under both headings as a requirement only', () => {
    const g = buildIdeaGraph(files({ A: idea(), B: idea(['A'], ['A']) }));
    expect(g.byKey.get('b')).toMatchObject({ requires: ['a'], helpful: [] });
  });

  it('marks the ideas in a cycle, gives them one step, and carries on', () => {
    const g = buildIdeaGraph(ideas({ A: [], B: ['A', 'D'], C: ['B'], D: ['C'], E: ['D'], F: ['F'] }));
    expect(g.nodes.filter((n) => n.inCycle).map((n) => n.name).sort()).toEqual(['B', 'C', 'D', 'F']);
    expect(g.cycles.map((c) => [...c].sort())).toEqual([['b', 'c', 'd'], ['f']]);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => g.byKey.get(k)!.step)).toEqual([1, 2, 2, 2, 3, 1]);
    expect(g.byKey.get('c')!.problems.map((p) => p.kind)).toContain('cycle');
    expect(g.byKey.get('e')!.problems.map((p) => p.kind)).not.toContain('cycle');
  });

  it('lists what is still missing in an idea', () => {
    const g = buildIdeaGraph(files({
      Bare: '---\npriority: urgent\n---\n\n## Requires\n- [[Nowhere]]\n\n## Questions\n#### Question\nid:: a\n',
      Fine: idea(),
    }));
    expect(g.byKey.get('fine')!.problems).toEqual([]);
    expect(g.byKey.get('bare')!.problems.map((p) => p.kind)).toEqual([
      'no-id', 'no-outcome', 'no-lens', 'not-written', 'bare-question', 'warning',
    ]);
    expect(g.byKey.get('bare')!.problems.find((p) => p.kind === 'not-written')!.text).toBe('Requirement not written yet: Nowhere');
  });

  it('reports no questions, and an id used twice', () => {
    const g = buildIdeaGraph(files({
      A: idea([], [], '11111111-2222-4333-8444-555555555555'),
      B: idea([], [], '11111111-2222-4333-8444-555555555555').replace(/#### Question[\s\S]*$/, ''),
    }));
    expect(g.byKey.get('a')!.problems.map((p) => p.kind)).toEqual(['duplicate-id']);
    expect(g.byKey.get('b')!.problems.map((p) => p.kind)).toEqual(['duplicate-id', 'no-questions']);
    expect(g.byKey.get('a')!.problems[0].text).toBe('Same id as B');
  });

  it('reports a Learn link to a lens that does not exist, when it can tell', () => {
    const g = buildIdeaGraph(files({ A: idea() }), { lensExists: () => false });
    expect(g.byKey.get('a')!.problems).toEqual([
      { kind: 'lens-missing', text: 'Lens not found: A lens', error: true },
    ]);
  });

  it('has nothing to say about a placeholder but that it is not written', () => {
    const g = buildIdeaGraph(ideas({ A: ['Missing'] }));
    expect(g.byKey.get('missing')!.problems).toEqual([{ kind: 'placeholder', text: 'Not written yet', error: false }]);
  });

  it('keeps a file it could not read as an idea, and says so', () => {
    const g = buildIdeaGraph([{ name: 'A', docId: 'doc-a', text: null }, ...ideas({ B: ['A'] })]);
    expect(g.byKey.get('a')).toMatchObject({ written: true, idea: null, docId: 'doc-a', neededFor: ['b'] });
    expect(g.byKey.get('a')!.problems).toEqual([{ kind: 'unread', text: 'Could not read this file', error: true }]);
    expect(g.byKey.get('b')!.problems).toEqual([]);
  });

  it('stays quick with 150 ideas and 250 links', () => {
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 150; i++) {
      spec[`Idea ${i}`] = i === 0 ? [] : [`Idea ${Math.floor(i / 2)}`, ...(i % 3 === 0 && i > 3 ? [`Idea ${i - 3}`] : [])];
    }
    const started = performance.now();
    const g = buildIdeaGraph(ideas(spec));
    expect(performance.now() - started).toBeLessThan(500);
    expect(g.nodes).toHaveLength(150);
    expect(g.cycles).toEqual([]);
  });
});

describe('renderIdeaFile', () => {
  it('writes a new file in the folder\'s format', () => {
    const text = renderIdeaFile({
      id: '9f1c2a8e-0b1d-4c3e-8f5a-6b7c8d9e0f1a',
      priority: 'low',
      outcome: '  Explain why the sky is blue.  ',
      why: 'Otherwise the sky stays a mystery.',
      requires: ['Light', 'Air'],
      helpful: ['Colour'],
    });
    expect(text).toBe(`---
id: 9f1c2a8e-0b1d-4c3e-8f5a-6b7c8d9e0f1a
priority: low
courses:
  - "[[../courses/in-development/Context Accelerator]]"
---
Explain why the sky is blue.

## Requires
- [[Light]]
- [[Air]]

## Helpful first
- [[Colour]]

## Why it matters
Otherwise the sky stays a mystery.

## Learn

## Questions
`);
  });

  it('leaves the headings of empty sections, as the real files do', () => {
    const text = renderIdeaFile({ id: 'x', priority: 'medium', outcome: 'Do it.', why: '', requires: [], helpful: [] });
    expect(text.split('---\n')[2]).toBe('Do it.\n\n## Requires\n\n## Helpful first\n\n## Why it matters\n\n## Learn\n\n## Questions\n');
  });

  it('keeps typed text from becoming a heading or a second paragraph', () => {
    const text = renderIdeaFile({ id: 'x', priority: 'high', outcome: 'One.\n## Two', why: 'A.\n\nB.', requires: [], helpful: [] });
    expect(text).toContain('\nOne. ## Two\n');
    expect(text).toContain('## Why it matters\nA. B.\n');
  });

  it('is read back as written', () => {
    const input = { id: '9f1c2a8e-0b1d-4c3e-8f5a-6b7c8d9e0f1a', priority: 'high' as const, outcome: 'Do it.', why: 'It matters.', requires: ['A'], helpful: ['B'] };
    expect(parseIdea(renderIdeaFile(input))).toMatchObject({ ...input, questions: 0, learn: [], warnings: [] });
  });
});

describe('ideaNameProblem', () => {
  const existing = ['Power-seeking', '_Template'];

  it('accepts a new plain name', () => {
    expect(ideaNameProblem('Orthogonality thesis', existing)).toBeNull();
    expect(ideaNameProblem("Goodhart's law (strong form)", existing)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(ideaNameProblem('   ', existing)).toBe('Give the concept a name.');
  });

  it('refuses a name that exists, whatever its case', () => {
    expect(ideaNameProblem('power-Seeking', existing)).toBe('A file with this name already exists.');
    expect(ideaNameProblem(' Power-seeking ', existing)).toBe('A file with this name already exists.');
  });

  it('refuses characters a file name or a link cannot have', () => {
    for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '[', ']', '#', '^']) {
      expect(ideaNameProblem(`A${ch}B`, existing), ch).toBe(`A name cannot contain ${ch}`);
    }
  });

  it('refuses names the map would skip or the folder cannot hold', () => {
    expect(ideaNameProblem('_Draft', existing)).toBe('A name cannot start with _ or a dot.');
    expect(ideaNameProblem('.hidden', existing)).toBe('A name cannot start with _ or a dot.');
    expect(ideaNameProblem('Idea.md', existing)).toBe('Leave out ".md": the name becomes the file name.');
    expect(ideaNameProblem('x'.repeat(121), existing)).toBe('This name is too long.');
  });
});

describe('togglePick', () => {
  it('adds and removes a requirement', () => {
    const one = togglePick({ requires: [], helpful: [] }, 'A', 'requires');
    expect(one).toEqual({ requires: ['A'], helpful: [] });
    expect(togglePick(one, 'A', 'requires')).toEqual({ requires: [], helpful: [] });
  });

  it('moves an idea between "requires" and "helpful first"', () => {
    const picks = togglePick({ requires: ['A', 'B'], helpful: [] }, 'a', 'helpful');
    expect(picks).toEqual({ requires: ['B'], helpful: ['a'] });
    expect(togglePick(picks, 'A', 'requires')).toEqual({ requires: ['B', 'A'], helpful: [] });
  });

  it('keeps an idea in one of the four lists of the form', () => {
    const links = { requires: ['A'], helpful: ['B'], neededFor: ['C'], helpfulFor: [] as string[] };
    expect(togglePick(links, 'a', 'neededFor')).toEqual({ requires: [], helpful: ['B'], neededFor: ['C', 'a'], helpfulFor: [] });
    expect(togglePick(links, 'C', 'helpfulFor')).toEqual({ requires: ['A'], helpful: ['B'], neededFor: [], helpfulFor: ['C'] });
    expect(togglePick(links, 'C', 'neededFor')).toEqual({ requires: ['A'], helpful: ['B'], neededFor: [], helpfulFor: [] });
  });
});

describe('pickChoices', () => {
  // "Old idea" has no file: Power-seeking names it
  const g = buildIdeaGraph(ideas({ 'Power-seeking': ['Instrumental convergence', 'Old idea'], 'Instrumental convergence': [], 'Seeking power early': [], Corrigibility: [] }));
  const none = { requires: [], helpful: [] };
  const rows = (typed: string, picks = none, own: string[] = []) =>
    pickChoices(typed, g.nodes, picks, own).options.map((o) => (o.kind === 'new' ? `+${o.name}` : o.name));

  it('offers the ideas whose name holds the typed text, whatever its case, best match first', () => {
    // start of the name, start of a word, anywhere
    expect(rows('seek')).toEqual(['Seeking power early', 'Power-seeking', '+seek']);
    expect(rows('  POWER ')).toEqual(['Power-seeking', 'Seeking power early', '+POWER']);
    expect(rows('gib')).toEqual(['Corrigibility', '+gib']);
  });

  it('ends with the typed name as a new idea when no idea has exactly that name', () => {
    expect(pickChoices(' Mesa optimisation ', g.nodes, none, [])).toEqual({ options: [{ kind: 'new', name: 'Mesa optimisation' }], problem: null });
    expect(rows('corrigibility')).toEqual(['Corrigibility']);
    // An idea without a file is an idea of the map: it is offered as it is
    expect(pickChoices('old idea', g.nodes, none, []).options).toEqual([{ kind: 'idea', key: 'old idea', name: 'Old idea', written: false }]);
  });

  it('never offers the idea itself, as a match or as a new idea', () => {
    expect(rows('power', none, ['Power-seeking'])).toEqual(['Seeking power early', '+power']);
    expect(pickChoices('power-seeking', g.nodes, none, ['Power-seeking'])).toEqual({ options: [], problem: 'A concept cannot be its own requirement.' });
    // The name typed into "Add concept", which no file has yet
    expect(pickChoices('brand new', g.nodes, none, ['Old name', ' Brand new '])).toEqual({ options: [], problem: 'A concept cannot be its own requirement.' });
  });

  it('leaves out what is in one of the two lists, and says so for its exact name', () => {
    const picks = { requires: ['Corrigibility', 'Not there yet'], helpful: ['Power-seeking'] };
    expect(rows('', picks)).toEqual(['Instrumental convergence', 'Old idea', 'Seeking power early']);
    expect(pickChoices('corrigibility', g.nodes, picks, [])).toEqual({ options: [], problem: 'This concept is under Requires already.' });
    expect(pickChoices('not there yet', g.nodes, picks, [])).toEqual({ options: [], problem: 'This concept is under Requires already.' });
    expect(pickChoices('Power-seeking', g.nodes, picks, []).problem).toBe('This concept is under Helpful first already.');
  });

  it('checks a new name like a file name, and adds nothing when it fails', () => {
    expect(pickChoices('Goals/values', g.nodes, none, [])).toEqual({ options: [], problem: 'A name cannot contain /' });
    expect(pickChoices('_hidden', g.nodes, none, []).problem).toBe('A name cannot start with _ or a dot.');
    expect(pickChoices('Mesa.md', g.nodes, none, []).problem).toBe('Leave out ".md": the name becomes the file name.');
    // Matches are still offered next to the problem
    expect(pickChoices('power[', g.nodes, none, [])).toEqual({ options: [], problem: 'A name cannot contain [' });
  });

  it('offers every idea that can still be picked when nothing is typed, up to the limit', () => {
    expect(rows('')).toEqual(['Corrigibility', 'Instrumental convergence', 'Old idea', 'Power-seeking', 'Seeking power early']);
    expect(pickChoices('', g.nodes, none, ['Corrigibility', ''], 2).options.map((o) => o.name)).toEqual(['Instrumental convergence', 'Old idea']);
    expect(pickChoices('   ', g.nodes, none, []).problem).toBeNull();
  });
});

describe('mergePicks', () => {
  it('makes the changes asked for in the file as it is now', () => {
    // Someone added C to the file while the form was open
    const live = { requires: ['A', 'C'], helpful: ['H'] };
    const before = { requires: ['A'], helpful: ['H'] };
    expect(mergePicks(live, before, { requires: ['A', 'B'], helpful: [] }))
      .toEqual({ requires: ['A', 'C', 'B'], helpful: [] });
  });

  it('moves an idea between the lists, never leaving it in both', () => {
    const before = { requires: ['A'], helpful: ['H'] };
    expect(mergePicks(before, before, { requires: ['h'], helpful: ['A'] })).toEqual({ requires: ['h'], helpful: ['A'] });
    // Added as helpful here, as a requirement by someone else: the requirement stays
    expect(mergePicks({ requires: ['A', 'X'], helpful: ['H'] }, before, { requires: ['A'], helpful: ['H', 'X'] }))
      .toEqual({ requires: ['A', 'X'], helpful: ['H'] });
  });

  it('changes nothing when nothing was changed in the form', () => {
    const live = { requires: ['A', 'C'], helpful: [] };
    const before = { requires: ['A'], helpful: ['H'] };
    expect(mergePicks(live, before, before)).toEqual(live);
  });
});

describe('pickChoices for "Needed for" and "Helpful for"', () => {
  // "Old idea" has no file: Power-seeking names it
  const g = buildIdeaGraph(ideas({ 'Power-seeking': ['Instrumental convergence', 'Old idea'], 'Instrumental convergence': [], 'Old ideas, new': [], Corrigibility: [] }));
  const none = { requires: [], helpful: [], neededFor: [], helpfulFor: [] };
  const choices = (typed: string, picks = none, own: string[] = []) => pickChoices(typed, g.nodes, picks, own, 50, true);
  const WRITE = 'Write that concept first, or add this one to its Requires later.';

  it('offers written ideas only, and never a new one', () => {
    expect(choices('').options.map((o) => o.name)).toEqual(['Corrigibility', 'Instrumental convergence', 'Old ideas, new', 'Power-seeking']);
    expect(choices('seek')).toEqual({ options: [{ kind: 'idea', key: 'power-seeking', name: 'Power-seeking', written: true }], problem: null });
    expect(choices('Mesa optimisation')).toEqual({ options: [], problem: `No written concept has this name. ${WRITE}` });
  });

  it('says why an idea that is not written yet cannot be picked, also while others match', () => {
    expect(choices('old idea')).toEqual({
      options: [{ kind: 'idea', key: 'old ideas, new', name: 'Old ideas, new', written: true }],
      problem: `"Old idea" is not written yet. ${WRITE}`,
    });
    // On the way to a longer name: what matches says enough
    expect(choices('old').problem).toBeNull();
  });

  it('leaves out the idea itself and what is in one of the four lists', () => {
    const picks = { requires: ['Corrigibility'], helpful: [], neededFor: ['Power-seeking'], helpfulFor: ['Old ideas, new'] };
    expect(choices('', picks, ['Instrumental convergence']).options).toEqual([]);
    expect(choices('instrumental convergence', none, ['Instrumental convergence']).problem).toBe('A concept cannot be needed for itself.');
    expect(choices('corrigibility', picks).problem).toBe('This concept is under Requires already.');
    expect(choices('power-seeking', picks).problem).toBe('This concept is under Needed for already.');
    expect(choices('old ideas, new', picks).problem).toBe('This concept is under Helpful for already.');
    // And the same from a requirements box
    expect(pickChoices('power-seeking', g.nodes, picks, []).problem).toBe('This concept is under Needed for already.');
    expect(pickChoices('', g.nodes, picks, []).options.map((o) => o.name)).toEqual(['Instrumental convergence', 'Old idea']);
  });
});

describe('requirementCircle', () => {
  const g = buildIdeaGraph(ideas({ A: [], B: ['A'], C: ['B'], D: ['Missing'] }));

  it('finds the way back when a requirement already needs the idea', () => {
    expect(requirementCircle(g, 'A', ['C'])).toEqual(['A', 'C', 'B', 'A']);
    expect(requirementCircle(g, 'a', ['D', 'b'])).toEqual(['A', 'B', 'A']);
    expect(requirementCircle(g, 'Missing', ['D'])).toEqual(['Missing', 'D', 'Missing']);
  });

  it('says an idea cannot require itself', () => {
    expect(requirementCircle(g, 'B', ['b'])).toEqual(['B', 'B']);
  });

  it('finds none otherwise, or for a name the map does not have', () => {
    expect(requirementCircle(g, 'C', ['A', 'B'])).toBeNull();
    expect(requirementCircle(g, 'D', ['C'])).toBeNull();
    expect(requirementCircle(g, 'Brand new', ['C'])).toBeNull();
    expect(requirementCircle(g, 'A', [])).toBeNull();
  });

  it('does not count the link of an idea that is being taken out of "Needed for"', () => {
    expect(requirementCircle(g, 'A', ['B'], ['b'])).toBeNull();
    // C still needs A through B
    expect(requirementCircle(g, 'A', ['C'], ['C'])).toEqual(['A', 'C', 'B', 'A']);
    expect(requirementCircle(g, 'A', ['C'], ['B'])).toBeNull();
  });
});

describe('neededForCircle', () => {
  // A <- B <- C; D requires the unwritten "Missing"
  const g = buildIdeaGraph(ideas({ A: [], B: ['A'], C: ['B'], D: ['Missing'] }));

  it('finds the circle when an idea would be needed for one of its own requirements', () => {
    // C requires B (as the file says), and B would require C
    expect(neededForCircle(g, 'C', ['B'], ['b'])).toEqual(['C', 'B', 'C']);
    // … or for what one of them requires, however far down
    expect(neededForCircle(g, 'c', ['B'], ['D', 'A'])).toEqual(['C', 'B', 'A', 'C']);
  });

  it('goes by the requirements the form holds, not by the file, and works for an idea with no file yet', () => {
    expect(neededForCircle(g, 'C', [], ['A'])).toBeNull();
    expect(neededForCircle(g, 'Brand new', ['C'], ['A'])).toEqual(['Brand new', 'C', 'B', 'A', 'Brand new']);
    expect(neededForCircle(g, ' Brand new ', ['D'], ['C'])).toBeNull();
  });

  it('finds none otherwise', () => {
    expect(neededForCircle(g, 'A', [], ['B', 'C'])).toBeNull();
    expect(neededForCircle(g, 'B', ['A'], ['C', 'D'])).toBeNull();
    expect(neededForCircle(g, 'B', ['A'], [])).toBeNull();
    // Itself is another problem, not a circle through others
    expect(neededForCircle(g, 'B', ['A'], ['B'])).toBeNull();
  });
});

describe('requirementChanges', () => {
  const rewrite = (text: string, requires: string[], helpful: string[]) => {
    const result = requirementChanges(text, requires, helpful);
    if ('error' in result) throw new Error(result.error);
    return applyChanges(text, result.changes);
  };

  it('changes nothing when the lists already say it', () => {
    expect(requirementChanges(POWER, ['Instrumental convergence'], [])).toEqual({ changes: [] });
    expect(requirementChanges(POWER, ['instrumental Convergence'], [])).toEqual({ changes: [] });
  });

  it('adds a requirement as a line under the heading of an empty section', () => {
    expect(rewrite(INSTRUMENTAL, ['Goals'], ['Orthogonality thesis']))
      .toBe(INSTRUMENTAL.replace('## Requires\n\n', '## Requires\n- [[Goals]]\n\n'));
  });

  it('adds after the last line of a section that has some', () => {
    expect(rewrite(POWER, ['Instrumental convergence', 'Goals'], ['Agency']))
      .toBe(POWER
        .replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n- [[Goals]]\n')
        .replace('## Helpful first\n\n', '## Helpful first\n- [[Agency]]\n\n'));
  });

  it('removes the line of a requirement that is dropped, and only that', () => {
    expect(rewrite(POWER, [], [])).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
    const two = POWER.replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n- [[Goals|aims]]\n');
    expect(rewrite(two, ['Goals'], [])).toBe(two.replace('- [[Instrumental convergence]]\n', ''));
  });

  it('makes changes of single lines, so the rest of the file is never rewritten', () => {
    const result = requirementChanges(POWER, ['Goals'], ['Agency']);
    if ('error' in result) throw new Error(result.error);
    const start = POWER.indexOf('- [[Instrumental convergence]]');
    const helpfulAt = POWER.indexOf('## Helpful first\n') + '## Helpful first\n'.length;
    expect(result.changes).toEqual([
      { from: start, to: start + '- [[Instrumental convergence]]\n'.length, insert: '- [[Goals]]\n' },
      { from: helpfulAt, to: helpfulAt, insert: '- [[Agency]]\n' },
    ]);
  });

  it('takes a dropped link out of a line that says more', () => {
    const text = 'Outcome.\n\n## Requires\n- [[A]] and then [[B]], see notes\n- some words\n\n## Learn\n';
    expect(rewrite(text, ['A'], [])).toBe('Outcome.\n\n## Requires\n- [[A]] and then , see notes\n- some words\n\n## Learn\n');
  });

  it('moves an idea from "requires" to "helpful first"', () => {
    expect(rewrite(POWER, [], ['Instrumental convergence']))
      .toBe(POWER.replace('- [[Instrumental convergence]]\n\n## Helpful first\n', '\n## Helpful first\n- [[Instrumental convergence]]\n'));
  });

  it('adds a missing heading, before the sections that follow it', () => {
    const text = '---\nid: x\n---\nOutcome.\n\n## Why it matters\nBecause.\n\n## Learn\n';
    expect(rewrite(text, ['A'], [])).toBe('---\nid: x\n---\nOutcome.\n\n## Requires\n- [[A]]\n\n## Why it matters\nBecause.\n\n## Learn\n');
    expect(rewrite(text, ['A'], ['B']))
      .toBe('---\nid: x\n---\nOutcome.\n\n## Requires\n- [[A]]\n\n## Helpful first\n- [[B]]\n\n## Why it matters\nBecause.\n\n## Learn\n');
    expect(rewrite(text, [], [])).toBe(text);
  });

  it('adds "Helpful first" after an existing "Requires"', () => {
    const text = 'Outcome.\n\n## Requires\n- [[A]]\n\n## Learn\n';
    expect(rewrite(text, ['A'], ['B'])).toBe('Outcome.\n\n## Requires\n- [[A]]\n\n## Helpful first\n- [[B]]\n\n## Learn\n');
  });

  it('adds the headings at the end of a file that has no sections', () => {
    expect(rewrite('Outcome.', ['A'], [])).toBe('Outcome.\n\n## Requires\n- [[A]]\n');
    expect(rewrite('Outcome.\n', ['A'], ['B'])).toBe('Outcome.\n\n## Requires\n- [[A]]\n\n## Helpful first\n- [[B]]\n');
  });

  it('adds to a section that ends the file without a line break', () => {
    expect(rewrite('Outcome.\n\n## Requires', ['A'], [])).toBe('Outcome.\n\n## Requires\n- [[A]]\n');
    expect(rewrite('Outcome.\n\n## Requires\n- [[A]]', ['A', 'B'], [])).toBe('Outcome.\n\n## Requires\n- [[A]]\n- [[B]]\n');
  });

  it('does not mistake a heading in the frontmatter or in a comment for a section', () => {
    const text = '---\nnote: |\n  ## Requires\n---\nOutcome.\n\n%%\n## Requires\n- [[Hidden]]\n%%\n\n## Learn\n';
    expect(rewrite(text, ['A'], [])).toBe('---\nnote: |\n  ## Requires\n---\nOutcome.\n\n%%\n## Requires\n- [[Hidden]]\n%%\n\n## Requires\n- [[A]]\n\n## Learn\n');
  });

  it('refuses while a requirements section holds a pending suggestion', () => {
    const text = 'Outcome.\n\n## Requires\n- [[A]]\n{++- [[B]]\n++}\n## Learn\n';
    expect(requirementChanges(text, ['A', 'C'], [])).toEqual({
      error: 'The requirements of this file have pending suggestions. Open the file and accept or reject them first.',
    });
    // A suggestion elsewhere in the file is no obstacle
    const elsewhere = 'Outcome{++ more++}.\n\n## Requires\n- [[A]]\n\n## Learn\n';
    expect(rewrite(elsewhere, [], [])).toBe('Outcome{++ more++}.\n\n## Requires\n\n## Learn\n');
  });

  it('gives a file the parser reads back as asked', () => {
    const text = rewrite(INSTRUMENTAL, ['Goals', 'Agency'], ['Rationality']);
    expect(parseIdea(text)).toMatchObject({ requires: ['Goals', 'Agency'], helpful: ['Rationality'] });
    expect(parseIdea(text).questions).toBe(2);
  });
});

describe('sortIdeas', () => {
  const g = buildIdeaGraph(files({
    Beta: idea(['Alpha']).replace('priority: medium', 'priority: low'),
    Alpha: idea().replace('priority: medium', 'priority: high'),
    Gamma: idea(['Alpha', 'Beta']),
  }));
  const names = (column: Parameters<typeof sortIdeas>[1], descending = false) =>
    sortIdeas(g.nodes, column, descending).map((n) => n.name);

  it('sorts by name', () => {
    expect(names('name')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(names('name', true)).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  it('sorts by priority: high first', () => {
    expect(names('priority')).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it('sorts by counts, ties by name', () => {
    expect(names('requires', true)).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(names('neededFor', true)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(names('questions')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(names('step')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('does not change the list it is given', () => {
    const before = g.nodes.map((n) => n.name);
    sortIdeas(g.nodes, 'name', true);
    expect(g.nodes.map((n) => n.name)).toEqual(before);
  });
});

describe('mapColumns', () => {
  it('puts what comes first on the left: a chain is one idea per column', () => {
    const graph = buildIdeaGraph(ideas({ C: ['B'], B: ['A'], A: [] }));
    expect(mapColumns(graph)).toEqual([['a'], ['b'], ['c']]);
  });

  it('counts "helpful first" too, so every arrow points to the right', () => {
    const graph = buildIdeaGraph(files({ 'Instrumental convergence': INSTRUMENTAL, 'Power-seeking': POWER }));
    expect(mapColumns(graph)).toEqual([['orthogonality thesis'], ['instrumental convergence'], ['power-seeking']]);
  });

  it('keeps the ideas of a circle in one column and holds every idea once', () => {
    const graph = buildIdeaGraph(ideas({ A: [], B: ['A', 'D'], C: ['B'], D: ['C'], E: ['D'], Self: ['Self'] }));
    expect(mapColumns(graph)).toEqual([['a', 'self'], ['b', 'c', 'd'], ['e']]);
  });

  it('orders a column by where its neighbours are, so fewer lines cross', () => {
    const graph = buildIdeaGraph(ideas({ A1: [], A2: [], B1: ['A2'], B2: ['A1'] }));
    expect(mapColumns(graph)).toEqual([['a1', 'a2'], ['b2', 'b1']]);
  });

  it('is empty for no ideas', () => {
    expect(mapColumns(buildIdeaGraph([]))).toEqual([]);
  });
});

describe('the questions of an idea', () => {
  it('lists each question with its type and its values as written', () => {
    const idea = parseIdea([
      '---', 'id: 11111111-1111-4111-8111-111111111111', 'priority: high', '---', 'Outcome.', '',
      '## Questions',
      '#### Question: Open',
      'id:: 22222222-2222-4222-8222-222222222222',
      'content:: Why would it seek power?',
      'It has a second line.',
      'assessment-instructions:: Score out of 100.',
      '',
      '#### Question: Choice',
      'id:: 33333333-3333-4333-8333-333333333333',
      'content:: Which one is right?',
      'options::',
      '- [x] This',
      '- [ ] That',
      '- The other',
      'shuffle:: true',
      'explanation:: Because.',
      '',
      '#### Question',
      'content:: {++Suggested, not there yet++}Old style',
      'feedback-instructions::',
      'Be kind.',
      '',
      '- And short.',
      '',
      '#### Text',
      'content:: Not a question.',
    ].join('\n'));
    expect(idea.questionList).toEqual([
      {
        type: 'Open', id: '22222222-2222-4222-8222-222222222222', content: 'Why would it seek power?\nIt has a second line.',
        assessment: 'Score out of 100.', feedback: null, options: null, explanation: null, other: [],
      },
      {
        type: 'Choice', id: '33333333-3333-4333-8333-333333333333', content: 'Which one is right?',
        assessment: null, feedback: null,
        options: [{ text: 'This', correct: true }, { text: 'That', correct: false }, { text: 'The other', correct: false }],
        explanation: 'Because.',
        other: [{ name: 'shuffle', value: 'true' }],
      },
      { type: '', id: null, content: 'Old style', assessment: null, feedback: 'Be kind.\n\n- And short.', options: null, explanation: null, other: [] },
    ]);
    expect(idea.questions).toBe(3);
  });

  it('lists every further field of a question in order, as written', () => {
    const [question] = parseIdea('Outcome.\n\n## Questions\n#### Question: Open\nmax-words:: 80\nid:: 5\ncontent:: Why?\nforce-feedback:: below 60\nexample-answer::\nLine one.\nLine two.\nmy-own:: x\n').questionList;
    expect(question.other).toEqual([
      { name: 'max-words', value: '80' },
      { name: 'force-feedback', value: 'below 60' },
      { name: 'example-answer', value: 'Line one.\nLine two.' },
      { name: 'my-own', value: 'x' },
    ]);
  });

  it('has no options for a list it cannot read as options', () => {
    const options = (lines: string) => parseIdea(`Outcome.\n\n## Questions\n#### Question: Choice\ncontent:: Which?\noptions::\n${lines}\n`).questionList[0].options;
    expect(options('- [x] A\n- B')).toEqual([{ text: 'A', correct: true }, { text: 'B', correct: false }]);
    expect(options('- [X] A\n\n-  B  ')).toEqual([{ text: 'A', correct: true }, { text: 'B', correct: false }]);
    expect(options('- A\nnot a list line')).toBeNull();
    expect(options('- A\n- freeform:: Other')).toBeNull();
  });

  it('is an empty list for a file without questions', () => {
    expect(parseIdea('Outcome.\n\n## Questions\n').questionList).toEqual([]);
    expect(parseIdea('Outcome.\n').questionList).toEqual([]);
  });
});

describe('newQuestionProblem', () => {
  const open: NewQuestion = { type: 'Open', content: 'Why?' };
  const choice: NewQuestion = {
    type: 'Choice',
    content: 'Which?',
    options: [{ text: 'This', correct: true }, { text: 'That', correct: false }],
  };

  it('accepts a question with only its text, and one with every field', () => {
    expect(newQuestionProblem(open)).toBeNull();
    expect(newQuestionProblem({ ...open, assessment: 'Score out of 100.', feedback: 'Be kind.\nAnd short.' })).toBeNull();
    expect(newQuestionProblem(choice)).toBeNull();
    expect(newQuestionProblem({ ...choice, explanation: 'Because: this.' })).toBeNull();
  });

  it('needs the question itself', () => {
    expect(newQuestionProblem({ ...open, content: '  \n ' })).toBe('Write the question.');
    expect(newQuestionProblem({ ...choice, content: '' })).toBe('Write the question.');
  });

  it('refuses a value with a line that starts a heading or a field', () => {
    expect(newQuestionProblem({ ...open, content: 'Why?\n## Requires' })).toMatch(/^The question cannot/);
    expect(newQuestionProblem({ ...open, content: '#### Question: Open' })).toMatch(/^The question cannot/);
    expect(newQuestionProblem({ ...open, assessment: 'Good.\n  id:: 5' })).toMatch(/^The grading text cannot/);
    expect(newQuestionProblem({ ...open, feedback: 'content:: other' })).toMatch(/^The tutor text cannot/);
    expect(newQuestionProblem({ ...choice, explanation: 'feedback-instructions:: x' })).toMatch(/^The explanation cannot/);
    expect(newQuestionProblem({ ...choice, options: [{ text: '# one', correct: true }, { text: 'two', correct: false }] })).toMatch(/^An option cannot/);
    // Inside a line they are plain text
    expect(newQuestionProblem({ ...open, content: 'Is C# a language, and what does a:: b mean?' })).toBeNull();
  });

  it('needs 2 to 6 filled options with at least one right answer', () => {
    const options = (count: number) => Array.from({ length: count }, (_, i) => ({ text: `Option ${i + 1}`, correct: i === 0 }));
    expect(newQuestionProblem({ ...choice, options: options(1) })).toBe('A choice question needs at least 2 options.');
    expect(newQuestionProblem({ ...choice, options: options(6) })).toBeNull();
    expect(newQuestionProblem({ ...choice, options: options(7) })).toBe('A choice question has at most 6 options.');
    expect(newQuestionProblem({ ...choice, options: [{ text: 'This', correct: true }, { text: '  ', correct: false }] }))
      .toBe('Fill in every option, or remove the empty ones.');
    expect(newQuestionProblem({ ...choice, options: [{ text: 'This', correct: false }, { text: 'That', correct: false }] }))
      .toBe('Tick at least one right answer.');
  });
});

describe('renderQuestion', () => {
  const id = '44444444-4444-4444-8444-444444444444';

  it('writes an open question, leaving out the fields that are empty', () => {
    expect(renderQuestion({ id, type: 'Open', content: ' Why would it seek power? ', assessment: '  ', feedback: '' }))
      .toBe(`#### Question: Open\nid:: ${id}\ncontent:: Why would it seek power?\n`);
  });

  it('writes the grading and the tutor text of an open question, line breaks kept', () => {
    expect(renderQuestion({
      id, type: 'Open', content: 'Why?', assessment: 'Score out of 100.\r\n- 60: names power.  \n\n- 40: says why.\n', feedback: ' Point to the lens. ',
    })).toBe([
      '#### Question: Open',
      `id:: ${id}`,
      'content:: Why?',
      'assessment-instructions::',
      'Score out of 100.',
      '- 60: names power.',
      '',
      '- 40: says why.',
      'feedback-instructions:: Point to the lens.',
      '',
    ].join('\n'));
  });

  it('writes a choice question with its right answers ticked and the others plain (the platform refuses "- [ ]"), shuffled', () => {
    expect(renderQuestion({
      id,
      type: 'Choice',
      content: 'Which are sub-goals of most goals?',
      options: [{ text: 'More resources', correct: true }, { text: ' Fewer\noptions ', correct: false }, { text: 'Staying switched on', correct: true }],
      explanation: 'Both help with nearly any goal.',
    })).toBe([
      '#### Question: Choice',
      `id:: ${id}`,
      'content:: Which are sub-goals of most goals?',
      'options::',
      '- [x] More resources',
      '- Fewer options',
      '- [x] Staying switched on',
      'shuffle:: true',
      // Several right answers: the platform refuses them without this
      'multi:: true',
      'explanation:: Both help with nearly any goal.',
      '',
    ].join('\n'));
  });

  it('writes the further fields it is given, and no shuffle of its own then', () => {
    const options = [{ text: 'A', correct: true }, { text: 'B', correct: false }];
    expect(renderQuestion({ id, type: 'Choice', content: 'Which?', options, other: [{ name: 'max-select', value: ' 1 ' }, { name: 'optional', value: '' }] }))
      .toBe(`#### Question: Choice\nid:: ${id}\ncontent:: Which?\noptions::\n- [x] A\n- B\nmax-select:: 1\n`);
    expect(renderQuestion({ id, type: 'Open', content: 'Why?', feedback: 'Be kind.', other: [{ name: 'max-words', value: '80' }, { name: 'example-answer', value: 'One.\nTwo.' }] }))
      .toBe(`#### Question: Open\nid:: ${id}\ncontent:: Why?\nmax-words:: 80\nexample-answer::\nOne.\nTwo.\nfeedback-instructions:: Be kind.\n`);
  });

  it('sets multi to true for several right answers, whatever it was given', () => {
    const options = [{ text: 'A', correct: true }, { text: 'B', correct: true }];
    expect(renderQuestion({ id, type: 'Choice', content: 'Which?', options, other: [{ name: 'multi', value: 'false' }] }))
      .toBe(`#### Question: Choice\nid:: ${id}\ncontent:: Which?\noptions::\n- [x] A\n- [x] B\nmulti:: true\n`);
  });

  it('leaves out an empty explanation', () => {
    const text = renderQuestion({ id, type: 'Choice', content: 'Which?', options: [{ text: 'A', correct: true }, { text: 'B', correct: false }] });
    expect(text.endsWith('- B\nshuffle:: true\n')).toBe(true);
  });

  it('is read back as the question it was', () => {
    const choice: NewQuestion = { type: 'Choice', content: 'Which?\nPick all.', options: [{ text: 'A', correct: true }, { text: 'B', correct: false }], explanation: '"Quoted"' };
    const open: NewQuestion = { type: 'Open', content: 'Why?', assessment: '- 60: a\n- 40: b', feedback: 'Be kind.' };
    const list = parseIdea(`Outcome.\n\n## Questions\n${renderQuestion({ ...choice, id })}\n${renderQuestion({ ...open, id })}`).questionList;
    expect(list.map((q) => q.id)).toEqual([id, id]);
    expect(list.map(questionAsNew)).toEqual([{ ...choice, other: [{ name: 'shuffle', value: 'true' }] }, { ...open, other: [] }]);
  });
});

describe('questionChanges', () => {
  const SEGMENT = '#### Question: Open\nid:: 55555555-5555-4555-8555-555555555555\ncontent:: New?\n';
  const FIRST = '#### Question: Open\nid:: 22222222-2222-4222-8222-222222222222\ncontent:: First?\n';
  const HEAD = '---\nid: 11111111-1111-4111-8111-111111111111\npriority: high\n---\nOutcome.\n\n## Requires\n- [[Other]]\n\n';
  const add = (text: string) => {
    const result = questionChanges(text, SEGMENT);
    if ('error' in result) throw new Error(result.error);
    return applyChanges(text, result.changes);
  };

  it('puts the question after the last one, a blank line between them', () => {
    expect(add(`${HEAD}## Questions\n${FIRST}`)).toBe(`${HEAD}## Questions\n${FIRST}\n${SEGMENT}`);
    // Blank lines at the end of the file stay where they are
    expect(add(`${HEAD}## Questions\n${FIRST}\n\n`)).toBe(`${HEAD}## Questions\n${FIRST}\n${SEGMENT}\n\n`);
    // A last line without a line break gets one
    expect(add(`${HEAD}## Questions\n${FIRST}`.slice(0, -1))).toBe(`${HEAD}## Questions\n${FIRST}\n${SEGMENT}`);
  });

  it('puts the first question straight under the heading', () => {
    expect(add(`${HEAD}## Questions\n`)).toBe(`${HEAD}## Questions\n${SEGMENT}`);
    expect(add(`${HEAD}## Questions`)).toBe(`${HEAD}## Questions\n${SEGMENT}`);
    expect(add(`${HEAD}## questions\n\n`)).toBe(`${HEAD}## questions\n${SEGMENT}\n`);
  });

  it('ends the section there when another section follows', () => {
    expect(add(`${HEAD}## Questions\n${FIRST}\n## Learn\n- [[../Lenses/A lens]]\n`))
      .toBe(`${HEAD}## Questions\n${FIRST}\n${SEGMENT}\n## Learn\n- [[../Lenses/A lens]]\n`);
    expect(add(`${HEAD}## Questions\n${FIRST}## Learn\n`)).toBe(`${HEAD}## Questions\n${FIRST}\n${SEGMENT}\n## Learn\n`);
    expect(add(`${HEAD}## Questions\n## Learn\n`)).toBe(`${HEAD}## Questions\n${SEGMENT}\n## Learn\n`);
  });

  it('adds the heading at the end of a file that has none', () => {
    expect(add(HEAD)).toBe(`${HEAD}## Questions\n${SEGMENT}`);
    expect(add(HEAD.trimEnd())).toBe(`${HEAD}## Questions\n${SEGMENT}`);
    expect(add(`${HEAD.trimEnd()}\n`)).toBe(`${HEAD}## Questions\n${SEGMENT}`);
    expect(add('')).toBe(`## Questions\n${SEGMENT}`);
  });

  it('does not take a heading inside a comment or the frontmatter for the section', () => {
    const text = `${HEAD}%%\n## Questions\n%%\n`;
    expect(add(text)).toBe(`${text}\n## Questions\n${SEGMENT}`);
  });

  it('makes one insertion and touches nothing else', () => {
    const text = `${HEAD}## Questions\n${FIRST}\n## Learn\n`;
    const result = questionChanges(text, SEGMENT);
    expect(result).toEqual({ changes: [{ from: text.indexOf('\n## Learn'), to: text.indexOf('\n## Learn'), insert: `\n${SEGMENT}` }] });
  });

  it('refuses while the questions hold a pending suggestion', () => {
    expect(questionChanges(`${HEAD}## Questions\n${FIRST}{++\n#### Question: Open\ncontent:: Suggested?\n++}`, SEGMENT))
      .toEqual({ error: PENDING_QUESTIONS_ERROR });
    expect(questionChanges(`${HEAD}## Questions\n${FIRST.replace('First', '{~~First~>Second~~}')}`, SEGMENT))
      .toEqual({ error: PENDING_QUESTIONS_ERROR });
  });

  it('is not held up by a suggestion elsewhere in the file, or by a comment', () => {
    const text = `${HEAD.replace('Outcome.', 'Outcome{++ of it++}.')}## Questions\n${FIRST}{>>a remark<<}\n`;
    expect(add(text)).toBe(`${text}\n${SEGMENT}`);
  });

  it('gives a file whose questions read back in order', () => {
    const idea = parseIdea(add(`${HEAD}## Questions\n${FIRST}`));
    expect(idea.questionList.map((q) => [q.type, q.content])).toEqual([['Open', 'First?'], ['Open', 'New?']]);
    expect(idea.requires).toEqual(['Other']);
  });
});

describe('questionAsNew', () => {
  const question = (text: string) => parseIdea(`Outcome.\n\n## Questions\n${text}`).questionList[0];

  it('gives the form an open question with its values as written', () => {
    expect(questionAsNew(question('#### Question: open\nid:: 5\ncontent:: Why?\nassessment-instructions::\n- 60: a\n- 40: b\n')))
      .toEqual({ type: 'Open', content: 'Why?', assessment: '- 60: a\n- 40: b', feedback: '', other: [] });
  });

  it('holds every field but the id: those without a box of their own as further fields', () => {
    expect(questionAsNew(question('#### Question: Open\nid:: 5\nmax-words:: 80\ncontent:: Why?\nexplanation:: Odd here.\nforce-feedback:: first\n')))
      .toMatchObject({ other: [{ name: 'explanation', value: 'Odd here.' }, { name: 'max-words', value: '80' }, { name: 'force-feedback', value: 'first' }] });
    expect(questionAsNew(question('#### Question: Choice\ncontent:: Which?\noptions::\n- [x] A\n- B\nfeedback-instructions:: Be kind.\nmulti:: true\n')))
      .toMatchObject({ explanation: '', other: [{ name: 'feedback-instructions', value: 'Be kind.' }, { name: 'multi', value: 'true' }] });
  });

  it('gives the form a choice question with its options', () => {
    expect(questionAsNew(question('#### Question: Choice\ncontent:: Which?\noptions::\n- [x] A\n- B\n- [ ] C\nshuffle:: true\n')))
      .toEqual({ type: 'Choice', content: 'Which?', options: [{ text: 'A', correct: true }, { text: 'B', correct: false }, { text: 'C', correct: false }], explanation: '', other: [{ name: 'shuffle', value: 'true' }] });
  });

  it('is null for a type the form cannot edit, and for options it cannot read', () => {
    expect(questionAsNew(question('#### Question: Ranking\ncontent:: Order these.\nitems::\n- A\n- B\n'))).toBeNull();
    expect(questionAsNew(question('#### Question: FillBlank\ncontent:: The ___.\n'))).toBeNull();
    expect(questionAsNew(question('#### Question\ncontent:: Old style.\n'))).toBeNull();
    expect(questionAsNew(question('#### Question: Choice\ncontent:: Which?\n'))).toBeNull();
    expect(questionAsNew(question('#### Question: Choice\ncontent:: Which?\noptions::\n- A\n'))).toBeNull();
    expect(questionAsNew(question('#### Question: Choice\ncontent:: Which?\noptions::\n- A\nB\n'))).toBeNull();
  });
});

describe('questionEditChanges', () => {
  const HEAD = '---\nid: 11111111-1111-4111-8111-111111111111\npriority: high\n---\nOutcome.\n\n## Requires\n- [[Other]]\n\n## Questions\n';
  const OPEN = [
    '#### Question: Open',
    'id:: 22222222-2222-4222-8222-222222222222',
    'content:: Why would it seek power?',
    'max-chars:: 600',
    'assessment-instructions::',
    'Score out of 100.',
    '- 60: more resources make the goal easier to reach.',
    '- 40: power is a means, not a wish.',
    'force-feedback:: true',
    '',
  ].join('\n');
  const CHOICE = [
    '#### Question: Choice',
    'id:: 33333333-3333-4333-8333-333333333333',
    'content:: Which would you not expect?',
    'options::',
    '- More computing power',
    '- [x] Making humans happy',
    '- [ ] Staying switched on',
    'shuffle:: true',
    'max-select:: 1',
    'explanation:: Only some goals need happy humans.',
    '',
  ].join('\n');
  const RANKING = '#### Question: Ranking\nid:: 44444444-4444-4444-8444-444444444444\ncontent:: Order these.\nitems::\n- A\n- B\n';
  const FILE = `${HEAD}${OPEN}\n${RANKING}\n${CHOICE}`;

  /** The question at `index` as the form gets it, changed by `change`, saved into `text`. */
  const edit = <T extends NewQuestion>(text: string, index: number, change: (q: T) => NewQuestion, opened = text) => {
    const before = parseIdea(opened).questionList[index];
    return questionEditChanges(text, index, before, change(questionAsNew(before) as T));
  };
  const saved = <T extends NewQuestion>(text: string, index: number, change: (q: T) => NewQuestion) => {
    const result = edit(text, index, change);
    if ('error' in result) throw new Error(result.error);
    return applyChanges(text, result.changes);
  };
  type Open = Extract<NewQuestion, { type: 'Open' }>;
  type Choice = Extract<NewQuestion, { type: 'Choice' }>;

  it('changes nothing when the form is saved as it was opened', () => {
    expect(edit(FILE, 0, (q) => q)).toEqual({ changes: [] });
    expect(edit(FILE, 2, (q) => q)).toEqual({ changes: [] });
    // Line endings and spaces the textarea added are not a change
    expect(edit<Open>(FILE, 0, (q) => ({ ...q, assessment: `${q.assessment!.replace(/\n/g, '\r\n')}\n`, content: ` ${q.content} ` }))).toEqual({ changes: [] });
  });

  it('rewrites one line of a multi-line rubric and nothing else', () => {
    const out = saved<Open>(FILE, 0, (q) => ({ ...q, assessment: q.assessment!.replace('- 40: power is a means, not a wish.', '- 30: power is a means.\n- 10: gives an example.') }));
    expect(out).toBe(FILE.replace('- 40: power is a means, not a wish.', '- 30: power is a means.\n- 10: gives an example.'));
  });

  it('rewrites the question text only', () => {
    const result = edit<Open>(FILE, 0, (q) => ({ ...q, content: 'Why would it gain power?' }));
    const from = FILE.indexOf('content:: Why would it seek power?');
    expect(result).toEqual({ changes: [{ from, to: from + 'content:: Why would it seek power?'.length, insert: 'content:: Why would it gain power?' }] });
  });

  it('writes a value of several lines under its field name, a value of one line beside it', () => {
    expect(saved<Open>(FILE, 0, (q) => ({ ...q, content: 'Why would it seek power?\n\nAnswer in two sentences.' })))
      .toBe(FILE.replace('content:: Why would it seek power?', 'content::\nWhy would it seek power?\n\nAnswer in two sentences.'));
    expect(saved<Open>(FILE, 0, (q) => ({ ...q, assessment: 'Score out of 100.' })))
      .toBe(FILE.replace(/assessment-instructions::\n(.*\n){3}/, 'assessment-instructions:: Score out of 100.\n'));
  });

  it('removes a field that was emptied', () => {
    expect(saved<Open>(FILE, 0, (q) => ({ ...q, assessment: ' \n' })))
      .toBe(FILE.replace(/assessment-instructions::\n(.*\n){3}/, ''));
    expect(saved<Choice>(FILE, 2, (q) => ({ ...q, explanation: '' })))
      .toBe(FILE.replace('explanation:: Only some goals need happy humans.\n', ''));
  });

  it('adds a field that was missing after the last of the fields the form holds', () => {
    expect(saved<Open>(FILE, 0, (q) => ({ ...q, feedback: 'Point to the lens.' })))
      .toBe(FILE.replace('- 40: power is a means, not a wish.\n', '- 40: power is a means, not a wish.\nfeedback-instructions:: Point to the lens.\n'));
    // With only the question text there: after it
    const bare = `${HEAD}#### Question: Open\nid:: 5\ncontent:: Why?\n\n${RANKING}`;
    expect(saved<Open>(bare, 0, (q) => ({ ...q, assessment: '- 60: a\n- 40: b', feedback: 'Be kind.' })))
      .toBe(bare.replace('content:: Why?\n', 'content:: Why?\nassessment-instructions::\n- 60: a\n- 40: b\nfeedback-instructions:: Be kind.\n'));
  });

  it('puts a new field where the last one was when that one is emptied in the same save', () => {
    expect(saved<Open>(FILE, 0, (q) => ({ ...q, assessment: '', feedback: 'Point to the lens.' })))
      .toBe(FILE.replace(/assessment-instructions::\n(.*\n){3}/, 'feedback-instructions:: Point to the lens.\n'));
  });

  it('leaves the options byte for byte when they were not changed, plain and ticked forms alike', () => {
    const out = saved<Choice>(FILE, 2, (q) => ({ ...q, content: 'Which one?', options: q.options.map((o) => ({ ...o })) }));
    expect(out).toBe(FILE.replace('content:: Which would you not expect?', 'content:: Which one?'));
  });

  it('rewrites the whole list when an option was changed: right answers ticked, the others plain', () => {
    const lines = '- More computing power\n- [x] Making humans happy\n- [ ] Staying switched on\n';
    expect(saved<Choice>(FILE, 2, (q) => ({ ...q, options: [...q.options, { text: 'Keeping its goal', correct: false }] })))
      .toBe(FILE.replace(lines, '- More computing power\n- [x] Making humans happy\n- Staying switched on\n- Keeping its goal\n'));
    expect(saved<Choice>(FILE, 2, (q) => ({ ...q, options: q.options.map((o, i) => ({ ...o, correct: i === 0 })) })))
      .toBe(FILE.replace(lines, '- [x] More computing power\n- Making humans happy\n- Staying switched on\n'));
  });

  it('never touches the id, the heading, the other fields or the other questions', () => {
    const out = saved<Choice>(FILE, 2, (q) => ({
      ...q, content: 'New?', options: [{ text: 'A', correct: true }, { text: 'B', correct: false }], explanation: 'New.',
    }));
    expect(out).toBe(`${HEAD}${OPEN}\n${RANKING}\n${[
      '#### Question: Choice',
      'id:: 33333333-3333-4333-8333-333333333333',
      'content:: New?',
      'options::',
      '- [x] A',
      '- B',
      'shuffle:: true',
      'max-select:: 1',
      'explanation:: New.',
      '',
    ].join('\n')}`);
  });

  it('works on the last segment of a file that ends without a line break', () => {
    const text = FILE.slice(0, -1);
    expect(saved<Choice>(text, 2, (q) => ({ ...q, explanation: 'Shorter.' }))).toBe(text.replace('Only some goals need happy humans.', 'Shorter.'));
    expect(saved<Choice>(text, 2, (q) => ({ ...q, explanation: '' }))).toBe(text.replace('\nexplanation:: Only some goals need happy humans.', '\n'));
    const open = `${HEAD}#### Question: Open\ncontent:: Why?`;
    expect(saved<Open>(open, 0, (q) => ({ ...q, feedback: 'Be kind.' }))).toBe(`${open}\nfeedback-instructions:: Be kind.`);
    expect(saved<Open>(open, 0, (q) => ({ ...q, content: 'Why so?' }))).toBe(`${HEAD}#### Question: Open\ncontent:: Why so?`);
  });

  it('keeps blank lines and a comment after the question where they are', () => {
    const text = `${HEAD}#### Question: Open\ncontent:: Why?\n\n\n%%\nHow this file works\nname:: not a field\n%%\n`;
    expect(saved<Open>(text, 0, (q) => ({ ...q, content: 'Why so?', assessment: 'Score it.' })))
      .toBe(text.replace('content:: Why?\n', 'content:: Why so?\nassessment-instructions:: Score it.\n'));
  });

  it('refuses when the question at that place is no longer the one the form was opened with', () => {
    // Someone changed it meanwhile
    expect(edit<Open>(FILE.replace('Why would it seek power?', 'Why power?'), 0, (q) => ({ ...q, feedback: 'Be kind.' }), FILE))
      .toEqual({ error: QUESTION_MOVED_ERROR });
    // Someone put a question before it
    expect(edit<Open>(FILE.replace(OPEN, `${RANKING}\n${OPEN}`), 0, (q) => ({ ...q, feedback: 'Be kind.' }), FILE))
      .toEqual({ error: QUESTION_MOVED_ERROR });
    // Someone removed it
    expect(edit<Choice>(`${HEAD}${OPEN}`, 2, (q) => ({ ...q, content: 'New?' }), FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    expect(edit<Choice>(HEAD.replace('## Questions\n', ''), 2, (q) => ({ ...q, content: 'New?' }), FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    // Even a save that changes nothing says so
    expect(edit(FILE.replace('Which would you not expect?', 'Which?'), 2, (q) => q, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    // A change to another question is no reason
    expect(edit(FILE.replace('max-chars:: 600\n', ''), 2, (q) => q, FILE)).toEqual({ changes: [] });
  });

  it('refuses while the question holds a pending suggestion or a comment', () => {
    const suggested = FILE.replace('Why would it seek power?', 'Why would it {~~seek~>gain~~} power?');
    expect(edit<Open>(suggested, 0, (q) => ({ ...q, feedback: 'Be kind.' }))).toEqual({ error: PENDING_QUESTION_ERROR });
    const remarked = FILE.replace('max-chars:: 600', 'max-chars:: 600{>>too short?<<}');
    expect(edit<Open>(remarked, 0, (q) => ({ ...q, feedback: 'Be kind.' }))).toEqual({ error: PENDING_QUESTION_ERROR });
    const noted = FILE.replace('Why would it seek power?', 'Why would it seek power? %%reword%%');
    expect(edit<Open>(noted, 0, (q) => ({ ...q, feedback: 'Be kind.' }))).toEqual({ error: PENDING_QUESTION_ERROR });
  });

  it('is not held up by a suggestion in another question or elsewhere in the file', () => {
    const text = FILE.replace('Outcome.', 'Outcome{++ of it++}.').replace('Why would it seek power?', 'Why would it {~~seek~>gain~~} power?');
    expect(saved<Choice>(text, 2, (q) => ({ ...q, content: 'Which one?' }))).toBe(text.replace('Which would you not expect?', 'Which one?'));
  });

  it('says the questions have pending suggestions when one of them hides which question is meant', () => {
    // A suggested new question before it: not in the list the form was opened from
    const text = FILE.replace(OPEN, `{++#### Question: Open\ncontent:: Suggested?\n\n++}${OPEN}`);
    expect(parseIdea(text).questionList).toHaveLength(3);
    expect(edit<Choice>(text, 2, (q) => ({ ...q, content: 'Which one?' }))).toEqual({ error: PENDING_QUESTIONS_ERROR });
  });

  it('refuses a changed value that is empty or would break the segment, and says which', () => {
    expect(edit<Open>(FILE, 0, (q) => ({ ...q, content: ' ' }))).toEqual({ error: 'Write the question.' });
    expect(edit<Open>(FILE, 0, (q) => ({ ...q, assessment: `${q.assessment}\n#### Question: Open` }))).toMatchObject({ error: expect.stringMatching(/^The grading text cannot/) });
    expect(edit<Open>(FILE, 0, (q) => ({ ...q, feedback: 'Good.\nid:: 5' }))).toMatchObject({ error: expect.stringMatching(/^The tutor text cannot/) });
    expect(edit<Choice>(FILE, 2, (q) => ({ ...q, explanation: '# Why' }))).toMatchObject({ error: expect.stringMatching(/^The explanation cannot/) });
    expect(edit<Choice>(FILE, 2, (q) => ({ ...q, options: q.options.map((o) => ({ ...o, correct: false })) }))).toEqual({ error: 'Tick at least one right answer.' });
    expect(edit<Choice>(FILE, 2, (q) => ({ ...q, options: q.options.slice(0, 1) }))).toEqual({ error: 'A choice question needs at least 2 options.' });
    expect(edit<Choice>(FILE, 2, (q) => ({ ...q, options: [...q.options, { text: ' ', correct: false }] }))).toEqual({ error: 'Fill in every option, or remove the empty ones.' });
  });

  it('does not hold an unchanged value to the rules for new text', () => {
    // An old value with a "#tag" line, and options without a right answer: left as they are
    const text = `${HEAD}#### Question: Choice\ncontent:: Which?\n#tag\noptions::\n- A\n- B\n`;
    expect(saved<Choice>(text, 0, (q) => ({ ...q, explanation: 'Either.' }))).toBe(`${text}explanation:: Either.\n`);
  });

  it('refuses a question of a type the form cannot edit, and one whose type was changed', () => {
    const ranking = parseIdea(FILE).questionList[1];
    expect(questionEditChanges(FILE, 1, ranking, { type: 'Open', content: 'Order these.' })).toMatchObject({ error: expect.stringMatching(/edited in the file/) });
    const open = parseIdea(FILE).questionList[0];
    expect(questionEditChanges(FILE, 0, open, { type: 'Choice', content: 'Which?', options: [] })).toMatchObject({ error: expect.stringMatching(/edited in the file/) });
  });

  it('refuses a question that has one of its fields twice', () => {
    const text = `${HEAD}#### Question: Open\ncontent:: Why?\ncontent:: Why so?\n`;
    expect(edit<Open>(text, 0, (q) => ({ ...q, content: 'New?' }))).toMatchObject({ error: expect.stringMatching(/"content::" twice/) });
  });

  describe('the further fields', () => {
    const other = (q: NewQuestion, change: Record<string, string | null>): NewQuestion => {
      const fields = (q.other ?? []).filter(({ name }) => change[name] !== null).map((field) => (change[field.name] === undefined ? field : { ...field, value: change[field.name]! }));
      const added = Object.entries(change).filter(([name, value]) => value !== null && !fields.some((field) => field.name === name)).map(([name, value]) => ({ name, value: value! }));
      return { ...q, other: [...fields, ...added] };
    };

    it('changes one in its place', () => {
      expect(saved(FILE, 0, (q) => other(q, { 'max-chars': '900' }))).toBe(FILE.replace('max-chars:: 600', 'max-chars:: 900'));
      expect(saved(FILE, 2, (q) => other(q, { 'max-select': '2', shuffle: 'false' }))).toBe(FILE.replace('shuffle:: true\nmax-select:: 1', 'shuffle:: false\nmax-select:: 2'));
    });

    it('removes one that was taken out of the form, or emptied', () => {
      expect(saved(FILE, 0, (q) => other(q, { 'force-feedback': null }))).toBe(FILE.replace('force-feedback:: true\n', ''));
      expect(saved(FILE, 0, (q) => other(q, { 'max-chars': '  ' }))).toBe(FILE.replace('max-chars:: 600\n', ''));
    });

    it('adds a new one after the last field of the question', () => {
      expect(saved(FILE, 0, (q) => other(q, { 'max-words': '80', 'example-answer': 'One.\nTwo.' })))
        .toBe(FILE.replace('force-feedback:: true\n', 'force-feedback:: true\nmax-words:: 80\nexample-answer::\nOne.\nTwo.\n'));
      expect(saved(FILE, 2, (q) => other(q, { optional: 'true' }))).toBe(`${FILE.trimEnd()}\noptional:: true\n`);
    });

    it('puts new fields of both kinds each in their place', () => {
      expect(saved<Open>(FILE, 0, (q) => ({ ...other(q, { 'max-words': '80' }), feedback: 'Be kind.' } as NewQuestion))).toBe(FILE.replace(
        'force-feedback:: true\n',
        'force-feedback:: true\nmax-words:: 80\n',
      ).replace('- 40: power is a means, not a wish.\n', '- 40: power is a means, not a wish.\nfeedback-instructions:: Be kind.\n'));
      // The last field is one of the form's own boxes: the box first, then the rest
      const text = `${HEAD}#### Question: Open\ncontent:: Why?\n`;
      expect(saved<Open>(text, 0, (q) => ({ ...other(q, { optional: 'true' }), assessment: 'Score it.' } as NewQuestion)))
        .toBe(`${text}assessment-instructions:: Score it.\noptional:: true\n`);
    });

    it('edits the grading and the tutor text of a choice question as further fields', () => {
      const text = `${HEAD}#### Question: Choice\ncontent:: Which?\noptions::\n- [x] A\n- B\nfeedback-instructions:: Be kind.\n`;
      expect(saved(text, 0, (q) => other(q, { 'feedback-instructions': 'Be kind.\nAnd short.' })))
        .toBe(text.replace('feedback-instructions:: Be kind.', 'feedback-instructions::\nBe kind.\nAnd short.'));
    });

    it('adds multi when the options are changed to several right answers', () => {
      const out = saved<Choice>(FILE, 2, (q) => ({ ...q, options: q.options.map((option) => ({ ...option, correct: true })) }));
      expect(out).toBe(FILE.replace('- More computing power\n- [x] Making humans happy\n- [ ] Staying switched on', '- [x] More computing power\n- [x] Making humans happy\n- [x] Staying switched on')
        .replace('explanation:: Only some goals need happy humans.\n', 'explanation:: Only some goals need happy humans.\nmulti:: true\n'));
      // Options left as they are: nothing is added
      const several = FILE.replace('- More computing power', '- [x] More computing power');
      expect(edit(several, 2, (q) => q)).toEqual({ changes: [] });
    });

    it('refuses a name that cannot be a field, is there twice or has its own box, and a value that breaks the segment', () => {
      expect(edit(FILE, 0, (q) => other(q, { 'two words': 'x' }))).toEqual({ error: expect.stringMatching(/cannot be the name of a setting/) });
      expect(edit(FILE, 0, (q) => other(q, { '': 'x' }))).toEqual({ error: 'Give the new setting a name.' });
      expect(edit(FILE, 0, (q) => other(q, { id: 'x' }))).toEqual({ error: 'This question has "id::" already. Edit it in the file.' });
      expect(edit(FILE, 0, (q) => other(q, { 'feedback-instructions': 'x' }))).toEqual({ error: '"feedback-instructions" has its own box in this form.' });
      expect(edit(FILE, 0, (q) => ({ ...q, other: [...(q.other ?? []), { name: 'max-chars', value: '5' }] }))).toEqual({ error: 'The setting "max-chars" is there twice.' });
      expect(edit(FILE, 0, (q) => other(q, { 'max-chars': '5\nid:: 9' }))).toEqual({ error: expect.stringMatching(/^The setting "max-chars" cannot/) });
      // An open question that has options: the form does not hold them
      const odd = `${HEAD}#### Question: Open\ncontent:: Why?\noptions::\n- A\n`;
      expect(edit(odd, 0, (q) => other(q, { options: '- B' }))).toEqual({ error: 'This question has "options::" already. Edit it in the file.' });
    });

    it('refuses when a further field was changed in the file meanwhile', () => {
      expect(edit(FILE.replace('max-chars:: 600', 'max-chars:: 700'), 0, (q) => q, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
      expect(edit(FILE.replace('shuffle:: true\n', ''), 2, (q) => q, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    });
  });

  it('gives a file that reads back as the form was saved', () => {
    const out = saved<Open>(FILE, 0, (q) => ({ ...q, content: 'A?\nB?', assessment: '- 50: a\n- 50: b', feedback: '"Quoted"' }));
    const idea = parseIdea(out);
    expect(questionAsNew(idea.questionList[0])).toEqual({
      type: 'Open', content: 'A?\nB?', assessment: '- 50: a\n- 50: b', feedback: '"Quoted"',
      other: [{ name: 'max-chars', value: '600' }, { name: 'force-feedback', value: 'true' }],
    });
    expect(idea.questionList.slice(1)).toEqual(parseIdea(FILE).questionList.slice(1));
    expect(idea.requires).toEqual(['Other']);
  });
});

describe('questionDeleteChanges', () => {
  const HEAD = '---\nid: 11111111-1111-4111-8111-111111111111\n---\nOutcome.\n\n## Questions\n';
  const A = '#### Question: Open\nid:: a\ncontent:: First?\n';
  const B = '#### Question: Ranking\nid:: b\ncontent:: Order.\nitems::\n- A\n- B\n';
  const C = '#### Question: Choice\nid:: c\ncontent:: Which?\noptions::\n- [x] A\n- B\n';
  const FILE = `${HEAD}${A}\n${B}\n${C}`;
  const remove = (text: string, index: number, opened = text) => {
    const result = questionDeleteChanges(text, index, parseIdea(opened).questionList[index]);
    return 'error' in result ? result : applyChanges(text, result.changes);
  };

  it('takes a question out with the blank line after it', () => {
    expect(remove(FILE, 0)).toBe(`${HEAD}${B}\n${C}`);
    expect(remove(FILE, 1)).toBe(`${HEAD}${A}\n${C}`);
  });

  it('takes the last question out with the blank line before it', () => {
    expect(remove(FILE, 2)).toBe(`${HEAD}${A}\n${B}`);
    expect(remove(FILE.trimEnd(), 2)).toBe(`${HEAD}${A}\n${B}`);
    expect(remove(`${HEAD}${A}`, 0)).toBe(HEAD);
  });

  it('keeps the blank line before the section that follows', () => {
    expect(remove(`${FILE}\n## Notes\nText.\n`, 2)).toBe(`${HEAD}${A}\n${B}\n## Notes\nText.\n`);
    expect(remove(`${HEAD}${A}\n## Notes\n`, 0)).toBe(`${HEAD}\n## Notes\n`);
  });

  it('keeps a comment after the question', () => {
    expect(remove(`${HEAD}${A}\n%% note %%\n\n${C}`, 0)).toBe(`${HEAD}%% note %%\n\n${C}`);
    expect(remove(`${FILE}\n%% the end %%\n`, 2)).toBe(`${HEAD}${A}\n${B}\n%% the end %%\n`);
  });

  it('makes one deletion', () => {
    expect(questionDeleteChanges(FILE, 0, parseIdea(FILE).questionList[0])).toEqual({ changes: [{ from: HEAD.length, to: HEAD.length + A.length + 1, insert: '' }] });
  });

  it('refuses when the question at that place is no longer the one shown', () => {
    expect(remove(`${HEAD}${B}\n${C}`, 0, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    expect(remove(FILE.replace('First?', 'Second?'), 0, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
    expect(remove(HEAD, 0, FILE)).toEqual({ error: QUESTION_MOVED_ERROR });
  });

  it('refuses while the question holds a pending suggestion or a comment', () => {
    const text = FILE.replace('First?', 'First{++ly++}?');
    expect(remove(text, 0)).toEqual({ error: PENDING_QUESTION_ERROR });
    expect(remove(text, 1)).toBe(`${HEAD}${A.replace('First?', 'First{++ly++}?')}\n${C}`);
  });
});

describe('ideaAsEdit', () => {
  it('holds every part of the file the form shows', () => {
    expect(ideaAsEdit('Instrumental convergence', parseIdea(INSTRUMENTAL))).toEqual({
      name: 'Instrumental convergence',
      priority: 'high',
      courses: ['../courses/in-development/Context Accelerator'],
      outcome: 'Explain why agents with very different final goals would pursue the same sub-goals.',
      why: parseIdea(INSTRUMENTAL).why,
      learn: parseIdea(INSTRUMENTAL).learnText,
      requires: [],
      helpful: ['Orthogonality thesis'],
      neededFor: [],
      helpfulFor: [],
    });
    expect(parseIdea(INSTRUMENTAL).learnText).toMatch(/^- Start with \[\[/);
  });

  it('takes what the idea is needed and helpful for from the map: no file of its own says it', () => {
    expect(ideaAsEdit('X', parseIdea('O.\n'), { neededFor: ['B', 'C'], helpfulFor: ['D'] })).toMatchObject({ requires: [], neededFor: ['B', 'C'], helpfulFor: ['D'] });
  });

  it('keeps an idea named under both headings as a requirement only', () => {
    expect(ideaAsEdit('X', parseIdea('O.\n\n## Requires\n- [[A]]\n\n## Helpful first\n- [[a]]\n- [[B]]\n'))).toMatchObject({ requires: ['A'], helpful: ['B'] });
  });
});

describe('ideaEditProblem', () => {
  it('accepts text of several lines and paragraphs', () => {
    expect(ideaEditProblem({ outcome: 'One.\n\nTwo.', why: 'A.\n### Small heading\nB.', learn: '- [[x]]: y\n- z', courses: ['../courses/A', '[[B]]'] })).toBeNull();
    expect(ideaEditProblem({})).toBeNull();
  });

  it('refuses a line that starts a new part of the file, and a course link that breaks its line', () => {
    expect(ideaEditProblem({ outcome: 'One.\n## Requires' })).toMatch(/^The outcome cannot/);
    expect(ideaEditProblem({ why: '# Top' })).toMatch(/^Why it matters cannot/);
    expect(ideaEditProblem({ learn: '- a\n##b' })).toMatch(/^Learn cannot/);
    expect(ideaEditProblem({ courses: ['A "quoted" course'] })).toBe('A course link cannot contain " [ ] or |.');
    expect(ideaEditProblem({ courses: ['A|B'] })).toBe('A course link cannot contain " [ ] or |.');
  });
});

describe('ideaEditChanges', () => {
  const FILE = [
    '---',
    'id: 11111111-1111-4111-8111-111111111111',
    'priority: high',
    'courses:',
    '  - "[[../courses/in-development/Context Accelerator]]"',
    'tags: [a, b]',
    '---',
    'Explain why it seeks power.',
    '',
    '## Requires',
    '- [[Goals]]',
    '',
    '## Helpful first',
    '',
    '## Why it matters',
    'It changes what we expect.',
    'On two lines.',
    '',
    '## Learn',
    '- [[../Lenses/Power|Power]]: read this first',
    '',
    '## Notes',
    'Kept as it is.',
    '',
    '## Questions',
    '#### Question: Open',
    'id:: 22222222-2222-4222-8222-222222222222',
    'content:: Why?',
    '',
  ].join('\n');
  const opened = (text: string) => ideaAsEdit('Power', parseIdea(text));
  const edit = (text: string, change: Partial<IdeaEdit>, from = text) => ideaEditChanges(text, opened(from), { ...opened(from), ...change });
  const saved = (text: string, change: Partial<IdeaEdit>) => {
    const result = edit(text, change);
    if ('error' in result) throw new Error(result.error);
    return applyChanges(text, result.changes);
  };

  it('changes nothing when the form is saved as it was opened', () => {
    expect(edit(FILE, {})).toEqual({ changes: [] });
    expect(edit(FILE.replace(/\n/g, '\r\n'), {})).toEqual({ changes: [] });
    expect(edit(FILE, { name: 'Another name', outcome: ' Explain why it seeks power. \n' })).toEqual({ changes: [] });
  });

  it('changes the priority line only', () => {
    expect(edit(FILE, { priority: 'low' })).toEqual({ changes: [{ from: FILE.indexOf('priority'), to: FILE.indexOf('priority') + 'priority: high'.length, insert: 'priority: low' }] });
  });

  it('adds a priority that was missing after the id, or at the top', () => {
    expect(saved(FILE.replace('priority: high\n', ''), { priority: 'low' })).toBe(FILE.replace('priority: high', 'priority: low'));
    expect(saved('---\ntags: [a]\n---\nOutcome.\n', { priority: 'high' })).toBe('---\npriority: high\ntags: [a]\n---\nOutcome.\n');
    expect(saved('Outcome.\n', { priority: 'high' })).toBe('---\npriority: high\n---\nOutcome.\n');
  });

  it('rewrites the course list only, whatever way it was written', () => {
    expect(saved(FILE, { courses: ['../courses/A', ' [[../courses/B]] ', ''] }))
      .toBe(FILE.replace('  - "[[../courses/in-development/Context Accelerator]]"', '  - "[[../courses/A]]"\n  - "[[../courses/B]]"'));
    const unquoted = FILE.replace('courses:\n  - "[[../courses/in-development/Context Accelerator]]"', 'courses: [[../courses/Old]]');
    expect(saved(unquoted, { courses: ['../courses/A'] })).toBe(FILE.replace('in-development/Context Accelerator', 'A'));
    const flush = FILE.replace('  - "[[', '- "[[');
    expect(saved(flush, { courses: ['../courses/A'] })).toBe(FILE.replace('in-development/Context Accelerator', 'A'));
  });

  it('takes the courses key out when the list is emptied, and adds it at the end of the frontmatter when it was missing', () => {
    const without = FILE.replace('courses:\n  - "[[../courses/in-development/Context Accelerator]]"\n', '');
    expect(saved(FILE, { courses: [] })).toBe(without);
    expect(saved(without, { courses: ['../courses/A'] })).toBe(without.replace('tags: [a, b]\n', 'tags: [a, b]\ncourses:\n  - "[[../courses/A]]"\n'));
    expect(saved('Outcome.\n', { priority: 'low', courses: ['../courses/A'] })).toBe('---\npriority: low\ncourses:\n  - "[[../courses/A]]"\n---\nOutcome.\n');
  });

  it('rewrites the outcome paragraph only, line breaks kept', () => {
    expect(saved(FILE, { outcome: 'Explain it.\n\nIn two paragraphs.  ' })).toBe(FILE.replace('Explain why it seeks power.', 'Explain it.\n\nIn two paragraphs.'));
  });

  it('adds an outcome that was missing, and removes one that was emptied', () => {
    const without = FILE.replace('Explain why it seeks power.\n', '');
    expect(saved(FILE, { outcome: ' ' })).toBe(without);
    expect(saved(without, { outcome: 'Back.' })).toBe(FILE.replace('Explain why it seeks power.', 'Back.'));
    expect(saved('---\nid: x\n---\n## Requires\n', { outcome: 'New.' })).toBe('---\nid: x\n---\nNew.\n\n## Requires\n');
    expect(saved('---\nid: x\n---', { outcome: 'New.' })).toBe('---\nid: x\n---\nNew.\n');
    expect(saved('', { outcome: 'New.' })).toBe('New.\n');
  });

  it('rewrites the text of a section only', () => {
    expect(saved(FILE, { why: 'Now one line.' })).toBe(FILE.replace('It changes what we expect.\nOn two lines.', 'Now one line.'));
    expect(saved(FILE, { learn: '- [[../Lenses/Power|Power]]: read this first\n- [[../Lenses/More]]' }))
      .toBe(FILE.replace('read this first', 'read this first\n- [[../Lenses/More]]'));
  });

  it('keeps the heading of a section that was emptied, and fills an empty one under its heading', () => {
    const empty = FILE.replace('It changes what we expect.\nOn two lines.\n', '');
    expect(saved(FILE, { why: '' })).toBe(empty);
    expect(empty).toContain('## Why it matters\n\n## Learn');
    expect(saved(empty, { why: 'Back.\nAgain.' })).toBe(FILE.replace('It changes what we expect.\nOn two lines.', 'Back.\nAgain.'));
    // No blank line under the heading: one is kept before the next heading
    expect(saved('O.\n\n## Learn\n## Questions\n', { learn: '- x' })).toBe('O.\n\n## Learn\n- x\n\n## Questions\n');
    expect(saved('O.\n\n## Learn', { learn: '- x' })).toBe('O.\n\n## Learn\n- x\n');
  });

  it('adds a missing section in the order of the format', () => {
    const text = 'O.\n\n## Requires\n- [[Goals]]\n\n## Questions\n';
    expect(saved(text, { why: 'W.' })).toBe('O.\n\n## Requires\n- [[Goals]]\n\n## Why it matters\nW.\n\n## Questions\n');
    expect(saved(text, { why: 'W.', learn: '- l', helpful: ['Other'] }))
      .toBe('O.\n\n## Requires\n- [[Goals]]\n\n## Helpful first\n- [[Other]]\n\n## Why it matters\nW.\n\n## Learn\n- l\n\n## Questions\n');
    expect(saved('O.\n', { why: 'W.', learn: '- l', requires: ['A'] })).toBe('O.\n\n## Requires\n- [[A]]\n\n## Why it matters\nW.\n\n## Learn\n- l\n');
    expect(saved('O.', { learn: '- l' })).toBe('O.\n\n## Learn\n- l\n');
  });

  it('changes the requirements as "Edit requirements" does', () => {
    expect(saved(FILE, { requires: ['Goals', 'Agents'], helpful: ['Other'] }))
      .toBe(FILE.replace('- [[Goals]]\n', '- [[Goals]]\n- [[Agents]]\n').replace('## Helpful first\n', '## Helpful first\n- [[Other]]\n'));
    expect(saved(FILE, { requires: [] })).toBe(FILE.replace('- [[Goals]]\n', ''));
  });

  it('makes every change of one save together, and leaves the rest byte for byte', () => {
    const out = saved(FILE, { priority: 'medium', outcome: 'New outcome.', why: 'New why.', learn: '', requires: ['Agents'], courses: ['../courses/A'] });
    expect(out).toBe(FILE
      .replace('priority: high', 'priority: medium')
      .replace('in-development/Context Accelerator', 'A')
      .replace('Explain why it seeks power.', 'New outcome.')
      .replace('- [[Goals]]', '- [[Agents]]')
      .replace('It changes what we expect.\nOn two lines.', 'New why.')
      .replace('- [[../Lenses/Power|Power]]: read this first\n', ''));
    for (const kept of ['id: 11111111-1111-4111-8111-111111111111', 'tags: [a, b]', '## Notes\nKept as it is.\n', '#### Question: Open\nid:: 22222222-2222-4222-8222-222222222222\ncontent:: Why?\n']) {
      expect(out).toContain(kept);
    }
  });

  it('keeps comments and blank lines around a text where they are', () => {
    const text = FILE.replace('## Why it matters\n', '## Why it matters\n%% for the writer %%\n\n').replace('On two lines.\n', 'On two lines.\n\n\n%% end %%\n');
    expect(saved(text, { why: 'New.' })).toBe(text.replace('It changes what we expect.\nOn two lines.', 'New.'));
  });

  it('refuses when the file no longer says what the form was opened with', () => {
    for (const [from, to] of [['priority: high', 'priority: low'], ['seeks power', 'wants power'], ['- [[Goals]]', '- [[Aims]]'], ['On two lines', 'On 2 lines'], ['read this first', 'read this'], ['Context Accelerator', 'Other']]) {
      expect(edit(FILE.replace(from, to), { why: 'New.' }, FILE)).toEqual({ error: IDEA_MOVED_ERROR });
    }
    // Even with nothing to save
    expect(edit(FILE.replace('seeks power', 'wants power'), {}, FILE)).toEqual({ error: IDEA_MOVED_ERROR });
  });

  it('is not held up by a change to a question, to an unknown section or to an unknown frontmatter key', () => {
    const live = FILE.replace('content:: Why?', 'content:: Why not?').replace('Kept as it is.', 'Changed.').replace('tags: [a, b]', 'tags: [c]');
    const result = edit(live, { why: 'New.' }, FILE);
    expect('changes' in result && applyChanges(live, result.changes)).toBe(live.replace('It changes what we expect.\nOn two lines.', 'New.'));
  });

  it('refuses while a part it would change holds a pending suggestion or a comment', () => {
    const suggested = FILE.replace('On two lines.', 'On two{++ short++} lines.');
    expect(edit(suggested, { why: 'New.' })).toEqual({ error: expect.stringMatching(/^"Why it matters" of this file has a pending suggestion or a comment/) });
    const remarked = FILE.replace('seeks power', 'seeks %%why?%% power');
    expect(edit(remarked, { outcome: 'New.' })).toEqual({ error: expect.stringMatching(/^The outcome of this file has a pending/) });
    expect(edit(FILE.replace('- [[Goals]]', '- [[Goals]]\n{++- [[Aims]]++}'), { requires: [] })).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
    // Another part can still be changed
    expect(saved(suggested, { outcome: 'New.' })).toBe(suggested.replace('Explain why it seeks power.', 'New.'));
  });

  it('refuses text that would start a new part of the file, in a changed part only', () => {
    expect(edit(FILE, { why: 'One.\n## Two' })).toEqual({ error: expect.stringMatching(/^Why it matters cannot/) });
    expect(edit(FILE, { courses: ['a"b'] })).toEqual({ error: 'A course link cannot contain " [ ] or |.' });
    const odd = FILE.replace('Explain why it seeks power.', '# Explain why it seeks power.');
    expect(saved(odd, { why: 'New.' })).toBe(odd.replace('It changes what we expect.\nOn two lines.', 'New.'));
  });

  it('refuses when the file would not read back as the form says', () => {
    expect(edit(FILE, { why: 'A {++suggestion++} typed in.' })).toEqual({ error: expect.stringMatching(/cannot change safely/) });
    const twice = `${FILE}\n## Learn\n- a second list\n`;
    expect(edit(twice, { learn: '- only this' })).toEqual({ error: expect.stringMatching(/cannot change safely/) });
  });

  it('gives a file that reads back as the form was saved', () => {
    const after: IdeaEdit = { name: 'Power', priority: 'low', courses: ['../courses/A', '../courses/B'], outcome: 'O.\nP.', why: 'W.', learn: '- [[../Lenses/L]]: l', requires: ['A', 'B'], helpful: ['C'], neededFor: [], helpfulFor: [] };
    for (const text of [FILE, '', 'Outcome.\n', '---\nid: x\n---\n\n## Questions\n#### Question: Open\ncontent:: Q?\n']) {
      const result = ideaEditChanges(text, opened(text), after);
      if ('error' in result) throw new Error(result.error);
      const idea = parseIdea(applyChanges(text, result.changes));
      expect(ideaAsEdit('Power', idea)).toEqual(after);
      expect(idea.questions).toBe(parseIdea(text).questions);
    }
  });
});

describe('renameLinkChanges', () => {
  const FILE = 'Outcome about [[Old name]].\n\n## Requires\n- [[Old name]]\n- [[Other]]\n\n## Helpful first\n- [[old NAME|shown words]] and [[folder/Old name.md#Part]]\n\n## Learn\n- [[Old name]]\n';
  const renamed = (text: string) => {
    const result = renameLinkChanges(text, 'Old name', ' New name ');
    return 'error' in result ? result : applyChanges(text, result.changes);
  };

  it('gives the links under Requires and Helpful first the new name, and nothing else', () => {
    expect(renamed(FILE)).toBe('Outcome about [[Old name]].\n\n## Requires\n- [[New name]]\n- [[Other]]\n\n## Helpful first\n- [[New name|shown words]] and [[folder/New name.md#Part]]\n\n## Learn\n- [[Old name]]\n');
  });

  it('changes only the name inside each link', () => {
    expect(renameLinkChanges('O.\n\n## Requires\n- [[Old name]]\n', 'old name', 'New')).toEqual({ changes: [{ from: 20, to: 28, insert: 'New' }] });
  });

  it('has no changes for a file that does not link to it', () => {
    expect(renameLinkChanges(FILE, 'Something else', 'New')).toEqual({ changes: [] });
    expect(renameLinkChanges('## Requires\n%% - [[Old name]] %%\n', 'Old name', 'New')).toEqual({ changes: [] });
  });

  it('refuses while such a link is inside a pending suggestion', () => {
    expect(renamed('## Requires\n{++- [[Old name]]++}\n')).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
    // A suggestion elsewhere in the section does not matter
    expect(renamed('## Requires\n- [[Old name]]\n{++- [[Other]]++}\n')).toBe('## Requires\n- [[New name]]\n{++- [[Other]]++}\n');
  });

  it('gives a file the map reads with the new name', () => {
    expect(parseIdea(renamed(FILE) as string)).toMatchObject({ requires: ['New name', 'Other'], helpful: ['New name'] });
  });
});

describe('removeLinkChanges', () => {
  const FILE = 'Outcome about [[Gone]].\n\n## Requires\n- [[Gone]]\n- [[Other]]\n\n## Helpful first\n- [[Kept]] and [[gone|shown]]\n\n## Learn\n- [[Gone]]\n';
  const removed = (text: string, name = 'Gone') => {
    const result = removeLinkChanges(text, name);
    return 'error' in result ? result : applyChanges(text, result.changes);
  };

  it('takes its line out, or just the link on a line that says more', () => {
    expect(removed(FILE)).toBe('Outcome about [[Gone]].\n\n## Requires\n- [[Other]]\n\n## Helpful first\n- [[Kept]] and \n\n## Learn\n- [[Gone]]\n');
  });

  it('has no changes for a file that does not link to it', () => {
    expect(removeLinkChanges(FILE, 'Something else')).toEqual({ changes: [] });
    // Not even when its sections hold a suggestion
    expect(removeLinkChanges('## Requires\n{++- [[Other]]++}\n', 'Gone')).toEqual({ changes: [] });
  });

  it('refuses while the section holds a pending suggestion', () => {
    expect(removed('## Requires\n- [[Gone]]\n{++- [[Other]]++}\n')).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
  });

  it('gives a file the map reads without it', () => {
    expect(parseIdea(removed(FILE) as string)).toMatchObject({ requires: ['Other'], helpful: ['Kept'] });
  });
});

describe('removeLinksChanges', () => {
  const FILE = '## Requires\n- [[A]]\n- [[B]]\n- [[C]]\n\n## Helpful first\n- [[D]] and [[a|shown]]\n- [[B]]\n';

  it('takes several ideas out of one file in one set of changes', () => {
    const result = removeLinksChanges(FILE, ['a', 'B', 'Not there']);
    if ('error' in result) throw new Error(result.error);
    expect(applyChanges(FILE, result.changes)).toBe('## Requires\n- [[C]]\n\n## Helpful first\n- [[D]] and \n');
  });

  it('has no changes when none is linked, and refuses beside a pending suggestion', () => {
    expect(removeLinksChanges(FILE, ['X', 'Y'])).toEqual({ changes: [] });
    expect(removeLinksChanges(FILE, [])).toEqual({ changes: [] });
    expect(removeLinksChanges('## Requires\n- [[A]]\n{++- [[B]]++}\n', ['Z', 'A'])).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
  });
});

describe('dependentsDiff', () => {
  const none = { neededFor: [], helpfulFor: [] };

  it('lists what was added, by the list its file must name the idea under', () => {
    expect(dependentsDiff(none, { neededFor: ['B', 'C'], helpfulFor: ['D'] })).toEqual([
      { name: 'D', list: 'helpful' },
      { name: 'B', list: 'requires' },
      { name: 'C', list: 'requires' },
    ]);
  });

  it('lists what was taken out, and what moved from one list to the other', () => {
    expect(dependentsDiff({ neededFor: ['B', 'C'], helpfulFor: ['D', 'E'] }, { neededFor: ['c', 'D'], helpfulFor: [] })).toEqual([
      { name: 'D', list: 'requires' },
      { name: 'E', list: null },
      { name: 'B', list: null },
    ]);
  });

  it('leaves out what did not change, however it is spelled', () => {
    expect(dependentsDiff({ neededFor: ['B'], helpfulFor: ['C'] }, { neededFor: [' b '], helpfulFor: ['C'] })).toEqual([]);
    expect(dependentsDiff(none, none)).toEqual([]);
    // Under both: it counts as "Needed for"
    expect(dependentsDiff({ neededFor: ['B'], helpfulFor: [] }, { neededFor: ['B'], helpfulFor: ['B'] })).toEqual([]);
  });
});

describe('dependentLinkChanges', () => {
  const FILE = '---\nid: 1\n---\nExplain.\n\n## Requires\n- [[Other]]\n\n## Helpful first\n- [[Kept]]\n\n## Why it matters\nBecause.\n';
  const changed = (text: string, ...rest: [string, 'requires' | 'helpful' | null, string[]?]) => {
    const result = dependentLinkChanges(text, ...rest);
    return 'error' in result ? result : applyChanges(text, result.changes);
  };

  it('adds the idea as a line under Requires or under Helpful first', () => {
    expect(changed(FILE, 'New one', 'requires')).toBe(FILE.replace('- [[Other]]\n', '- [[Other]]\n- [[New one]]\n'));
    expect(changed(FILE, ' New one ', 'helpful')).toBe(FILE.replace('- [[Kept]]\n', '- [[Kept]]\n- [[New one]]\n'));
  });

  it('adds the heading to a file that has none', () => {
    expect(changed('---\nid: 1\n---\nExplain.\n\n## Why it matters\nBecause.\n', 'New one', 'requires'))
      .toBe('---\nid: 1\n---\nExplain.\n\n## Requires\n- [[New one]]\n\n## Why it matters\nBecause.\n');
    expect(changed('Explain.\n', 'New one', 'helpful')).toBe('Explain.\n\n## Helpful first\n- [[New one]]\n');
  });

  it('takes the idea out, of both lists', () => {
    const both = FILE.replace('- [[Other]]\n', '- [[Other]]\n- [[Gone]]\n').replace('- [[Kept]]\n', '- [[Kept]]\n- [[gone|shown]]\n');
    expect(changed(both, 'Gone', null)).toBe(FILE);
    expect(dependentLinkChanges(FILE, 'Gone', null)).toEqual({ changes: [] });
  });

  it('moves the idea from one list to the other', () => {
    expect(changed(FILE, 'Other', 'helpful')).toBe(FILE.replace('- [[Other]]\n', '').replace('- [[Kept]]\n', '- [[Kept]]\n- [[Other]]\n'));
    expect(changed(FILE, 'kept', 'requires')).toBe(FILE.replace('- [[Kept]]\n', '').replace('- [[Other]]\n', '- [[Other]]\n- [[kept]]\n'));
  });

  it('has no changes for a file that says so already, however the link is written', () => {
    expect(dependentLinkChanges(FILE, 'other', 'requires')).toEqual({ changes: [] });
    expect(dependentLinkChanges(FILE.replace('[[Kept]]', '[[kept|shown]]'), 'Kept', 'helpful')).toEqual({ changes: [] });
  });

  it('writes the name of today in place of a link under a former name', () => {
    expect(changed(FILE, 'Another', 'requires', ['Other'])).toBe(FILE.replace('[[Other]]', '[[Another]]'));
    expect(changed(FILE, 'Another', null, ['Other'])).toBe(FILE.replace('- [[Other]]\n', ''));
    expect(changed(FILE, 'Another', 'helpful', ['Other'])).toBe(FILE.replace('- [[Other]]\n', '').replace('- [[Kept]]\n', '- [[Kept]]\n- [[Another]]\n'));
  });

  it('refuses beside a pending suggestion in the section it changes', () => {
    const pending = '## Requires\n- [[Other]]{++ (soon)++}\n\n## Helpful first\n- [[Kept]]\n';
    expect(dependentLinkChanges(pending, 'New one', 'requires')).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
    expect(dependentLinkChanges(pending, 'Other', null)).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
    expect(changed(pending, 'New one', 'helpful')).toBe(`${pending}- [[New one]]\n`);
    // A suggested link is not there yet, and cannot be written beside
    const suggested = '## Requires\n{++- [[Other]]++}\n\n## Helpful first\n- [[Kept]]\n';
    expect(dependentLinkChanges(suggested, 'New one', 'helpful')).toEqual({ error: PENDING_REQUIREMENTS_ERROR });
  });
});

describe('dependentEdits', () => {
  // A <- B <- C; D requires the unwritten "Draft" and finds A helpful
  const texts: Record<string, string> = {
    A: 'Explain.\n',
    B: 'Explain.\n\n## Requires\n- [[A]]\n',
    C: 'Explain.\n\n## Requires\n- [[B]]\n',
    D: 'Explain.\n\n## Requires\n- [[Draft]]\n\n## Helpful first\n- [[A]]\n',
  };
  const graph = buildIdeaGraph(files(texts));
  const textOf = (node: { name: string }) => texts[node.name];
  const none = { neededFor: [], helpfulFor: [] };
  const edits = (...args: Parameters<typeof dependentEdits>) => {
    const result = dependentEdits(...args);
    return 'error' in result ? result : result.edits.map((edit) => [edit.node.name, edit.list]);
  };

  it('lists the files to change for a new idea', () => {
    expect(edits(graph, { name: 'New', requires: ['A'] }, none, { neededFor: ['c'], helpfulFor: ['D'] }, textOf)).toEqual([['D', 'helpful'], ['C', 'requires']]);
    expect(edits(graph, { name: 'New', requires: [] }, none, none, textOf)).toEqual([]);
  });

  it('lists what an edit adds, takes out and moves', () => {
    // A is needed for B and helpful for D: B goes, D moves up, C is new
    expect(edits(graph, { name: 'A', requires: [] }, { neededFor: ['B'], helpfulFor: ['D'] }, { neededFor: ['D'], helpfulFor: ['C'] }, textOf))
      .toEqual([['C', 'helpful'], ['D', 'requires'], ['B', null]]);
    expect(edits(graph, { name: 'A', requires: [] }, { neededFor: ['B'], helpfulFor: ['D'] }, { neededFor: ['B'], helpfulFor: ['D'] }, textOf)).toEqual([]);
  });

  it('refuses an idea under both lists, the idea itself, and one that has no file', () => {
    expect(edits(graph, { name: 'New', requires: [] }, none, { neededFor: ['B'], helpfulFor: ['b'] }, textOf))
      .toEqual({ error: '"b" is under both Needed for and Helpful for. Take it out of one.' });
    expect(edits(graph, { name: 'A', requires: [] }, none, { neededFor: [], helpfulFor: [' a '] }, textOf)).toEqual({ error: 'A concept cannot be needed for itself.' });
    expect(edits(graph, { name: 'New', requires: [] }, none, { neededFor: ['draft'], helpfulFor: [] }, textOf))
      .toEqual({ error: '"Draft" is not written yet, so it has no file to put the link in. Write that concept first, or add this one to its Requires later.' });
    expect(edits(graph, { name: 'New', requires: [] }, none, { neededFor: [], helpfulFor: ['Nowhere'] }, textOf))
      .toEqual({ error: '"Nowhere" is not written yet, so it has no file to put the link in. Write that concept first, or add this one to its Requires later.' });
    // Taken out of one that is gone meanwhile: nothing to do
    expect(edits(graph, { name: 'A', requires: [] }, { neededFor: ['Nowhere'], helpfulFor: [] }, none, textOf)).toEqual([]);
  });

  it('refuses a circle of requirements a new "Needed for" makes, not one under "Helpful for"', () => {
    expect(edits(graph, { name: 'C', requires: ['B'] }, none, { neededFor: ['A'], helpfulFor: [] }, textOf))
      .toEqual({ error: 'This makes a circle of requirements: C → B → A → C' });
    expect(edits(graph, { name: 'C', requires: ['B'] }, none, { neededFor: [], helpfulFor: ['A'] }, textOf)).toEqual([['A', 'helpful']]);
    // What was there when the form opened is not checked again
    expect(edits(graph, { name: 'C', requires: ['B'] }, { neededFor: ['A'], helpfulFor: [] }, { neededFor: ['A', 'D'], helpfulFor: [] }, textOf)).toEqual([['D', 'requires']]);
  });

  it('names the file that cannot be changed safely, and leaves a file with no text at hand for later', () => {
    const pending = { ...texts, C: 'Explain.\n\n## Requires\n{++- [[B]]++}\n' };
    expect(edits(graph, { name: 'New', requires: [] }, none, { neededFor: ['D', 'C'], helpfulFor: [] }, (node) => pending[node.name]))
      .toEqual({ error: `In "C": ${PENDING_REQUIREMENTS_ERROR}` });
    expect(edits(graph, { name: 'New', requires: [] }, none, { neededFor: ['D', 'C'], helpfulFor: [] }, () => undefined)).toEqual([['D', 'requires'], ['C', 'requires']]);
  });
});

describe('deletePlan', () => {
  const QUESTION = '#### Question: Open\nid:: 11111111-1111-4111-8111-111111111111\ncontent:: Why?\n';
  // Base <- Middle <- Top; Side requires Base and the unwritten "Draft"; Top finds "Draft" helpful; Middle requires the unwritten "Only Middle"
  const graph = buildIdeaGraph(files({
    Base: `Explain.\n\n## Questions\n${QUESTION}${QUESTION}`,
    Middle: `Explain.\n\n## Requires\n- [[Base]]\n- [[Only Middle]]\n\n## Questions\n${QUESTION}`,
    Top: 'Explain.\n\n## Requires\n- [[Middle]]\n- [[Base]]\n\n## Helpful first\n- [[Draft]]\n',
    Side: 'Explain.\n\n## Requires\n- [[Base]]\n- [[Draft]]\n',
  }));
  const names = (nodes: Array<{ name: string }>) => nodes.map((node) => node.name);
  const losing = (keys: string[]) => deletePlan(graph, keys).losing.map(({ node, names: lost }) => [node.name, lost]);

  it('lists the files that go, their questions, and the links the other files lose', () => {
    const plan = deletePlan(graph, ['base']);
    expect(names(plan.files)).toEqual(['Base']);
    expect(plan.unwritten).toEqual([]);
    expect(plan.questions).toBe(2);
    expect(losing(['base'])).toEqual([['Middle', ['Base']], ['Side', ['Base']], ['Top', ['Base']]]);
    expect(plan.orphaned).toEqual([]);
  });

  it('leaves a link between two deleted ideas alone: the file that holds it goes', () => {
    const plan = deletePlan(graph, ['Base', ' MIDDLE ', 'no such idea']);
    expect(names(plan.files)).toEqual(['Base', 'Middle']);
    expect(plan.questions).toBe(3);
    // Top loses both in one go; Middle itself is not edited
    expect(losing(['base', 'middle'])).toEqual([['Side', ['Base']], ['Top', ['Middle', 'Base']]]);
    // "Only Middle" was named by Middle alone: it leaves the map with it
    expect(names(plan.orphaned)).toEqual(['Only Middle']);
  });

  it('only takes the links out for an idea that is not written yet', () => {
    const plan = deletePlan(graph, ['draft']);
    expect(plan.files).toEqual([]);
    expect(names(plan.unwritten)).toEqual(['Draft']);
    expect(plan.questions).toBe(0);
    expect(losing(['draft'])).toEqual([['Side', ['Draft']], ['Top', ['Draft']]]);
    // With every file that names it deleted too, nothing is left to change
    expect(losing(['draft', 'side', 'top'])).toEqual([]);
    expect(deletePlan(graph, ['side', 'top']).orphaned.map((node) => node.name)).toEqual(['Draft']);
  });

  it('has nothing for keys the map does not have', () => {
    expect(deletePlan(graph, ['gone'])).toEqual({ files: [], unwritten: [], losing: [], questions: 0, orphaned: [] });
  });

  describe('deletePlanChanges', () => {
    const textOf = (texts: Record<string, string | null>) => (node: { name: string }) => texts[node.name];

    it('works out the changes of every file that stays, from its text', () => {
      const plan = deletePlan(graph, ['base', 'draft']);
      const top = 'Explain.\n\n## Requires\n- [[Middle]]\n- [[Base]]\n\n## Helpful first\n- [[Draft]]\n';
      const result = deletePlanChanges(plan, textOf({ Top: top, Middle: 'Explain.\n\n## Requires\n- [[Base]]\n- [[Only Middle]]\n', Side: null }));
      if ('error' in result) throw new Error(result.error);
      // Side has no text at hand: left out here, checked when it is written
      expect(result.edits.map((edit) => edit.node.name)).toEqual(['Middle', 'Top']);
      expect(applyChanges(top, result.edits[1].changes)).toBe('Explain.\n\n## Requires\n- [[Middle]]\n\n## Helpful first\n');
    });

    it('names the file that cannot be changed safely', () => {
      const plan = deletePlan(graph, ['base']);
      expect(deletePlanChanges(plan, textOf({ Middle: '## Requires\n- [[Base]]\n', Side: '## Requires\n- [[Base]]\n{++- [[New]]++}\n', Top: '' })))
        .toEqual({ error: `In "Side": ${PENDING_REQUIREMENTS_ERROR}` });
    });
  });
});

describe('profileNameProblem', () => {
  it('accepts a name of 1 to 60 characters that no other profile has', () => {
    expect(profileNameProblem('Draft 2', ['Main'])).toBeNull();
    expect(profileNameProblem('  x  ', [])).toBeNull();
    expect(profileNameProblem('a'.repeat(60), [])).toBeNull();
    expect(profileNameProblem("Elias's ideas (v2) #1", [])).toBeNull();
  });

  it('says what is wrong with a name', () => {
    expect(profileNameProblem('   ', [])).toBe('Give the profile a name.');
    expect(profileNameProblem('a'.repeat(61), [])).toBe('A name can be 60 characters at most.');
    for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(profileNameProblem(`a${bad}b`, [])).toBe(`A name cannot contain ${bad}`);
    }
    expect(profileNameProblem('a\tb', [])).toBe('A name cannot contain control characters.');
    expect(profileNameProblem('a\u007fb', [])).toBe('A name cannot contain control characters.');
    expect(profileNameProblem('.hidden', [])).toBe('A name cannot start with _ or a dot.');
    expect(profileNameProblem('_trash', [])).toBe('A name cannot start with _ or a dot.');
    expect(profileNameProblem(' MAIN ', ['Draft', 'Main'])).toBe('A profile with this name already exists.');
  });
});
