import { describe, expect, it } from 'vitest';
import {
  TransformError, applyEdits, hunkEdits, lineDiff, mergeIntoConcept, resumeItems, transformFor, compareItems, linkField, minimalEdit, planMigration, transformDomain, transformLearningOutcome,
  transformPlaceholder, transformTemplate, transformTopic, verifyMigrated, findTextReferences,
  type Journal, type Snapshot, type VaultEntry,
} from './topics-to-concepts';

const DOMAIN_BOILERPLATE = `%%
This file is intentionally empty. It exists only to be linked to as a skill-tree domain. The list of backlinks will show you the LOs that are currently part of this domain.
%%
`;
const TOPIC_BOILERPLATE = `%%
Skill-tree topic. Learning outcomes link here via \`topic:\` in their frontmatter; the backlinks list shows which ones.
%%
`;

describe('transformDomain', () => {
  it('adds skill-tree and order to empty frontmatter and drops the boilerplate', () => {
    const r = transformDomain(`---\n---\n${DOMAIN_BOILERPLATE}`, 10);
    expect(r.content).toBe('---\nskill-tree: domain\norder: 10\n---\n');
  });

  it('keeps start-stage and other fields, drops domain-number, keeps a real body', () => {
    const r = transformDomain('---\ndomain-number: 7\nstart-stage: intermediate\ndescription: x\n---\nReal text.\n', 7);
    expect(r.content).toBe('---\nskill-tree: domain\norder: 7\nstart-stage: intermediate\ndescription: x\n---\nReal text.\n');
  });

  it('is idempotent', () => {
    const once = transformDomain(`---\nstart-stage: beginner\n---\n${DOMAIN_BOILERPLATE}`, 3).content;
    expect(transformDomain(once, 3).content).toBe(once);
  });

  it('refuses a conflicting order', () => {
    expect(() => transformDomain('---\norder: 4\n---\n', 5)).toThrow(TransformError);
  });

  it('drops the Compute Verification style boilerplate', () => {
    const body = '%%\nThis file holds the metadata for the "Compute Verification" skill-tree domain. Topics in this folder are the domain\'s topics; learning outcomes link to a topic via `topic:` in their frontmatter.\n%%\n';
    expect(transformDomain(`---\n---\n${body}`, 16).content).toBe('---\nskill-tree: domain\norder: 16\n---\n');
  });

  it('preserves CRLF line endings', () => {
    const r = transformDomain('---\r\nstart-stage: beginner\r\n---\r\nBody\r\n', 2);
    expect(r.content).toBe('---\r\nskill-tree: domain\r\norder: 2\r\nstart-stage: beginner\r\n---\r\nBody\r\n');
  });
});

describe('transformTopic', () => {
  it('adds skill-tree and parent after id, keeps order, drops the boilerplate', () => {
    const r = transformTopic(`---\nid: abc\norder: 4\n---\n${TOPIC_BOILERPLATE}`, 'Governance and Policy');
    expect(r.content).toBe('---\nid: abc\nskill-tree: topic\nparent-concepts:\n  - "[[Governance and Policy]]"\norder: 4\n---\n');
    expect(transformTopic(r.content, 'Governance and Policy').content).toBe(r.content);
  });

  it('keeps a body that is not the boilerplate', () => {
    const r = transformTopic('---\nid: abc\n---\nA real description.\n', 'Alignment');
    expect(r.content.endsWith('---\nA real description.\n')).toBe(true);
  });

  it('refuses a different existing parent', () => {
    expect(() => transformTopic('---\nid: a\nparent-concepts: "[[Other]]"\n---\n', 'Alignment')).toThrow(TransformError);
  });
});

describe('transformPlaceholder', () => {
  const ph = (topic: string, extraTags = '') => `---
id: 'cc95318b'
learning-outcome: "Explain the thing"
${topic}
stage: intermediate
tags:
  - skill-tree-placeholder${extraTags}
---
`;

  it('turns a single topic link into a one-item parent list and drops LO fields and the tag', () => {
    const r = transformPlaceholder(ph('topic: "[[../Domains and Topics/5 Interpretability/Monitoring model behaviour]]"'));
    expect(r.content).toBe(`---
id: 'cc95318b'
parent-concepts:
  - "[[../Domains and Topics/5 Interpretability/Monitoring model behaviour]]"
---
`);
    expect(r.notes.some((n) => n.startsWith('dropped learning-outcome'))).toBe(true);
  });

  it('keeps a multi-topic list in order (first stays primary)', () => {
    const r = transformPlaceholder(ph('topic:\n  - "[[../A/First]]"\n  - "[[../B/Second]]"'));
    expect(r.content).toContain('parent-concepts:\n  - "[[../A/First]]"\n  - "[[../B/Second]]"\n');
    expect(linkField(r.content, 'parent-concepts')).toEqual(['"[[../A/First]]"', '"[[../B/Second]]"']);
  });

  it('topic: none gives no parent', () => {
    const r = transformPlaceholder(ph('topic: none'));
    expect(r.content).toBe("---\nid: 'cc95318b'\n---\n");
  });

  it('keeps other tags', () => {
    const r = transformPlaceholder(ph('topic: "[[../X/Y]]"', '\n  - keep-me'));
    expect(r.content).toContain('tags:\n  - keep-me\n');
    expect(r.content).not.toContain('skill-tree-placeholder');
  });

  it('handles an inline tag list', () => {
    const r = transformPlaceholder("---\nid: a\ntopic: none\ntags: [skill-tree-placeholder, other]\n---\n");
    expect(r.content).toBe('---\nid: a\ntags: ["other"]\n---\n');
  });

  it('is idempotent', () => {
    const once = transformPlaceholder(ph('topic: "[[../X/Y]]"')).content;
    expect(transformPlaceholder(once).content).toBe(once);
  });

  it('refuses CriticMarkup in the frontmatter', () => {
    expect(() => transformPlaceholder(ph('topic: "[[../X/{--Y--}{++Z++}]]"'))).toThrow(/CriticMarkup/);
  });
});

describe('transformLearningOutcome', () => {
  it('renames topic: to concept: and keeps the link', () => {
    const r = transformLearningOutcome('---\nid: x\ntopic: "[[../Concepts/Agency]]"\nstage: intermediate\n---\n## Test:\n');
    expect(r.content).toBe('---\nid: x\nconcept: "[[../Concepts/Agency]]"\nstage: intermediate\n---\n## Test:\n');
  });

  it('removes topic: none', () => {
    expect(transformLearningOutcome('---\nid: x\ntopic: none\n---\n').content).toBe('---\nid: x\n---\n');
  });

  it('renames a block list key only', () => {
    expect(transformLearningOutcome('---\ntopic:\n  - "[[a]]"\n  - "[[b]]"\n---\n').content)
      .toBe('---\nconcept:\n  - "[[a]]"\n  - "[[b]]"\n---\n');
  });

  it('leaves a file without topic: alone, refuses topic: + concept:', () => {
    expect(transformLearningOutcome('---\nid: x\n---\n').content).toBe('---\nid: x\n---\n');
    expect(() => transformLearningOutcome('---\ntopic: "[[a]]"\nconcept: "[[b]]"\n---\n')).toThrow(TransformError);
  });
});

describe('transformTemplate', () => {
  it('rewrites the frontmatter example and backticked mentions', () => {
    const r = transformTemplate('topic: "[[../Domains/<N> <Domain>/<Topic>]]"\nAdd `topic:`, `stage:`.\n');
    expect(r.content).toBe('concept: "[[../Concepts/<Concept>]]"\nAdd `concept:`, `stage:`.\n');
    expect(transformTemplate(r.content).content).toBe(r.content);
  });
});

describe('minimalEdit and lineDiff', () => {
  it('finds the smallest single replace', () => {
    expect(minimalEdit('abcXdef', 'abcYYdef')).toEqual({ index: 3, deleteCount: 1, insert: 'YY' });
    expect(minimalEdit('same', 'same')).toBeNull();
    const a = '---\ntopic: x\n---\n', b = '---\nconcept: x\n---\n';
    const e = minimalEdit(a, b)!;
    expect(a.slice(0, e.index) + e.insert + a.slice(e.index + e.deleteCount)).toBe(b);
  });

  it('shows changed lines', () => {
    expect(lineDiff('p', 'a\nb\nc', 'a\nB\nc')).toContain('-b\n+B');
  });
});

describe('findTextReferences', () => {
  it('ignores wikilinks but reports plain mentions', () => {
    expect(findTextReferences('/x.md', 'see [[Domains and Topics/3 Alignment/X]]\n')).toEqual([]);
    expect(findTextReferences('/x.md', 'the `topic:` field\n')).toHaveLength(1);
    expect(findTextReferences('/Learning Outcomes/a.md', 'the `topic:` field\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planMigration
// ---------------------------------------------------------------------------

function snapshot(files: Record<string, string>): Snapshot {
  const entries: VaultEntry[] = [];
  const folders = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 2; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    entries.push({ path: p, id: `id-${p}`, type: p.endsWith('.md') ? 'markdown' : 'file' });
  }
  for (const f of folders) entries.push({ path: f, id: `id-${f}`, type: 'folder' });
  return { entries, contents: new Map(Object.entries(files)) };
}

const base = (): Record<string, string> => ({
  '/Domains and Topics/3 Alignment/_domain_metadata.md': `---\n---\n${DOMAIN_BOILERPLATE}`,
  '/Domains and Topics/3 Alignment/Scalable oversight.md': `---\nid: t1\norder: 1\n---\n${TOPIC_BOILERPLATE}`,
  '/Domains and Topics/3 Alignment/Inner and outer alignment.md': `---\nid: t2\norder: 2\n---\n${TOPIC_BOILERPLATE}`,
  '/Domains and Topics/7 AI Control/_domain_metadata.md': '---\nstart-stage: intermediate\n---\n',
  '/Domains and Topics/7 AI Control/The control agenda.md': '---\nid: t3\norder: 1\n---\n',
  '/Learning Outcomes/Debate.md': '---\nid: p1\nlearning-outcome: "x"\ntopic: "[[../Domains and Topics/3 Alignment/Scalable oversight]]"\nstage: advanced\ntags:\n  - skill-tree-placeholder\n---\n',
  '/Learning Outcomes/Both.md': '---\nid: p2\nlearning-outcome:\ntopic:\n  - "[[../Domains and Topics/7 AI Control/The control agenda]]"\n  - "[[../Domains and Topics/3 Alignment/Inner and outer alignment]]"\nstage: intermediate\ntags:\n  - skill-tree-placeholder\n---\n',
  '/Learning Outcomes/Nowhere.md': '---\nid: p3\ntopic: none\ntags:\n  - skill-tree-placeholder\n---\n',
  '/Learning Outcomes/Real one.md': '---\nid: r1\nlearning-outcome: Do it\ntopic: "[[../Domains and Topics/7 AI Control/The control agenda]]"\nstage: beginner\n---\n## Test:\n',
  '/Learning Outcomes/Real none.md': '---\nid: r2\ntopic: none\n---\n## Test:\n',
  '/Learning Outcomes/Facilitator.md': '---\nid: r3\n---\n## Test:\n',
  '/Learning Outcomes/Tagged real.md': '---\nid: r4\ntopic: "[[../Domains and Topics/3 Alignment/Scalable oversight]]"\ntags:\n  - skill-tree-placeholder\n---\n## Test:\n',
  '/modules/m.md': 'Links [[../Learning Outcomes/Debate]]\n',
});

describe('planMigration', () => {
  it('plans domains with their topics, then placeholders, then learning outcomes', () => {
    const plan = planMigration(snapshot(base()));
    expect(plan.problems).toEqual([]);
    expect(plan.counts).toMatchObject({
      domains: 2, topics: 3, placeholders: 3, multiParentPlaceholders: 1, noParentPlaceholders: 1,
      los: 3, losNone: 1, loNoTopic: 1, taggedButReal: 1,
    });
    const stage = (k: string) => (k === 'domain' || k === 'topic' ? 0 : ['placeholder', 'lo'].indexOf(k) + 1);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => stage(a) - stage(b)));
    const both = plan.items.find((i) => i.path === '/Learning Outcomes/Both.md')!;
    expect(both.target).toBe('/Concepts/Both.md');
    expect(both.parents).toEqual(['/Concepts/The control agenda.md', '/Concepts/Inner and outer alignment.md']);
    const topic = plan.items.find((i) => i.path.endsWith('/The control agenda.md'))!;
    expect(topic.target).toBe('/Concepts/The control agenda.md');
    expect(topic.after).toContain('parent-concepts:\n  - "[[AI Control]]"');
    expect(plan.items.find((i) => i.path.endsWith('7 AI Control/_domain_metadata.md'))!.target).toBe('/Concepts/AI Control.md');
  });

  it('stops on a name collision between a placeholder and a topic', () => {
    const files = base();
    files['/Learning Outcomes/Scalable oversight.md'] = '---\nid: p9\ntopic: "[[../Domains and Topics/3 Alignment/Scalable oversight]]"\ntags:\n  - skill-tree-placeholder\n---\n';
    const plan = planMigration(snapshot(files));
    expect(plan.problems.some((p) => /name collision/.test(p.reason))).toBe(true);
  });

  it('can trash a placeholder that is redundant with its same-named parent topic', () => {
    const files = base();
    files['/Learning Outcomes/Scalable oversight.md'] = '---\nid: p9\ntopic: "[[../Domains and Topics/3 Alignment/Scalable oversight]]"\ntags:\n  - skill-tree-placeholder\n---\n';
    const plan = planMigration(snapshot(files), { dropRedundantPlaceholders: true });
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((i) => i.path === '/Learning Outcomes/Scalable oversight.md')!.kind).toBe('drop-placeholder');
  });

  it('does not trash a same-named placeholder with a body or a different parent', () => {
    const files = base();
    files['/Learning Outcomes/Scalable oversight.md'] = '---\nid: p9\ntopic: "[[../Domains and Topics/7 AI Control/The control agenda]]"\ntags:\n  - skill-tree-placeholder\n---\n';
    expect(planMigration(snapshot(files), { dropRedundantPlaceholders: true }).problems.some((p) => /collision/.test(p.reason))).toBe(true);
  });

  it('stops on a collision with an existing Concepts file and on two domains with one name', () => {
    const files = base();
    files['/Concepts/Inner and outer alignment.md'] = '# existing\n';
    files['/Domains and Topics/9 Alignment/_domain_metadata.md'] = '---\n---\n';
    const reasons = planMigration(snapshot(files)).problems.map((p) => p.reason).join('\n');
    expect(reasons).toMatch(/Inner and outer alignment.md already exists/);
    expect(reasons).toMatch(/2 files would move to the same name/);
  });

  it('stops on a placeholder whose topic link does not resolve', () => {
    const files = base();
    files['/Learning Outcomes/Debate.md'] = files['/Learning Outcomes/Debate.md'].replace('Scalable oversight', 'Missing topic');
    expect(planMigration(snapshot(files)).problems).toEqual([
      expect.objectContaining({ path: '/Learning Outcomes/Debate.md', reason: expect.stringMatching(/does not resolve/) }),
    ]);
  });

  it('stops on unexpected files and a domain folder without metadata', () => {
    const files = base();
    files['/Domains and Topics/loose.md'] = 'x';
    files['/Domains and Topics/Unnumbered/x.md'] = '---\n---\n';
    files['/Domains and Topics/12 Capacity Building/Field-building.md'] = '---\nid: z\n---\n';
    const reasons = planMigration(snapshot(files)).problems.map((p) => p.reason).join('\n');
    expect(reasons).toMatch(/expected Domains and Topics/);
    expect(reasons).toMatch(/is not "<N> <Domain>"/);
    expect(reasons).toMatch(/no _domain_metadata/);
  });

  it('treats a rewritten-but-not-moved placeholder as pending (re-run after a partial apply)', () => {
    const files = base();
    files['/Learning Outcomes/Debate.md'] = transformPlaceholder(files['/Learning Outcomes/Debate.md']).content;
    const plan = planMigration(snapshot(files));
    const it = plan.items.find((i) => i.path === '/Learning Outcomes/Debate.md')!;
    expect(it.kind).toBe('placeholder');
    expect(it.before).toBe(it.after);
    expect(it.target).toBe('/Concepts/Debate.md');
  });
});

describe('merge into an existing concept', () => {
  it('mergeIntoConcept adds frontmatter with id and parents, idempotently', () => {
    const r = mergeIntoConcept('# Debate\n\nText.\n', 'p1', ['Scalable oversight']);
    expect(r.content).toBe('---\nid: p1\nparent-concepts:\n  - "[[Scalable oversight]]"\n---\n# Debate\n\nText.\n');
    expect(mergeIntoConcept(r.content, 'p1', ['Scalable oversight']).content).toBe(r.content);
    expect(() => mergeIntoConcept(r.content, 'p1', ['Other'])).toThrow(TransformError);
  });

  it('plans a merge when the option is on, and a collision otherwise', () => {
    const files = base();
    files['/Concepts/Debate.md'] = '# Debate\n\n## Relationships\n';
    expect(planMigration(snapshot(files)).problems.some((p) => /already exists/.test(p.reason))).toBe(true);
    const plan = planMigration(snapshot(files), { mergeIntoExistingConcepts: true });
    expect(plan.problems).toEqual([]);
    const it = plan.items.find((i) => i.path === '/Learning Outcomes/Debate.md')!;
    expect(it.kind).toBe('merge-placeholder');
    expect(it.merge).toMatchObject({ conceptPath: '/Concepts/Debate.md', id: 'p1', parentNames: ['Scalable oversight'] });
    expect(it.after).toContain('parent-concepts:\n  - "[[Scalable oversight]]"');
  });
});

describe('verifyMigrated', () => {
  it('passes on a migrated tree and flags leftovers', () => {
    const ok = snapshot({
      '/Concepts/Alignment.md': '---\nskill-tree: domain\norder: 3\n---\n',
      '/Concepts/Scalable oversight.md': '---\nid: t1\nskill-tree: topic\nparent-concepts:\n  - "[[Alignment]]"\n---\n',
      '/Concepts/Debate.md': '---\nid: p1\nparent-concepts:\n  - "[[Scalable oversight]]"\n---\n',
      '/Learning Outcomes/Real.md': '---\nconcept: "[[../Concepts/Scalable oversight]]"\n---\n## Test:\n',
    });
    expect(verifyMigrated(ok).problems).toEqual([]);
    expect(verifyMigrated(ok).stats).toMatchObject({ concepts: 3, domains: 1, topics: 1, parentLinks: 2, loConceptLinks: 1 });
    const bad = snapshot({
      '/Concepts/Debate.md': '---\nparent-concepts:\n  - "[[Nope]]"\n---\n',
      '/Learning Outcomes/Real.md': '---\ntopic: "[[x]]"\n---\n',
      '/Domains and Topics/3 A/x.md': '',
    });
    expect(verifyMigrated(bad).problems).toHaveLength(3);
  });
});

describe('review fixes', () => {
  it('flow lists are parsed as YAML: commas inside quoted or wikilinked items are kept', () => {
    const r = transformPlaceholder('---\nid: a\ntopic: ["[[../X/Labs, incentives, and race dynamics]]", "[[../Y/B]]"]\ntags: [skill-tree-placeholder]\n---\n');
    expect(r.content).toBe('---\nid: a\nparent-concepts:\n  - "[[../X/Labs, incentives, and race dynamics]]"\n  - "[[../Y/B]]"\n---\n');
  });

  it('hunkEdits makes one edit per changed hunk, back to front, touching only what differs', () => {
    const a = '---\nid: x\nlearning-outcome: "x"\ntopic: "[[a]]"\nkeep: me\nstage: s\ntags:\n  - skill-tree-placeholder\n---\nBody line\n';
    const b = transformPlaceholder(a).content;
    const edits = hunkEdits(a, b);
    expect(applyEdits(a, edits)).toBe(b);
    expect(edits.length).toBeGreaterThan(1);
    for (let i = 1; i < edits.length; i++) expect(edits[i].index).toBeLessThan(edits[i - 1].index);
    // the key rename touches only the key, not the link after it
    const ren = hunkEdits('---\ntopic: "[[a]]"\n---\n', '---\nconcept: "[[a]]"\n---\n');
    expect(ren).toHaveLength(1);
    expect(ren[0].insert + ren[0].deleteCount).not.toContain('[[a]]');
    expect(applyEdits('x\ny', hunkEdits('x\ny', 'x\nz\n'))).toBe('x\nz\n');
    expect(hunkEdits('same', 'same')).toEqual([]);
  });

  it('runs domain by domain: each domain file is followed by its own topics', () => {
    const plan = planMigration(snapshot(base()));
    const order = plan.items.filter((i) => i.kind === 'domain' || i.kind === 'topic').map((i) => `${i.kind}:${i.domainNumber}`);
    expect(order).toEqual(['domain:3', 'topic:3', 'topic:3', 'domain:7', 'topic:7']);
    expect([...plan.items].sort(compareItems)).toEqual(plan.items);
  });

  it('resumes when a domain moved but its topics did not (no _domain_metadata.md left in the folder)', () => {
    const files = base();
    const meta = files['/Domains and Topics/7 AI Control/_domain_metadata.md'];
    delete files['/Domains and Topics/7 AI Control/_domain_metadata.md'];
    files['/Concepts/AI Control.md'] = transformDomain(meta, 7).content;
    const plan = planMigration(snapshot(files));
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((i) => i.path.endsWith('/The control agenda.md'))!.params).toEqual({ domainName: 'AI Control' });
    // ...but not when the moved file is not that domain
    files['/Concepts/AI Control.md'] = '---\nskill-tree: domain\norder: 8\n---\n';
    expect(planMigration(snapshot(files)).problems.map((p) => p.reason).join()).toMatch(/no _domain_metadata/);
  });

  it('relay mode: reports links missing from the backlink index, and inbound links to a trashed placeholder', () => {
    const files = base();
    files['/Learning Outcomes/Scalable oversight.md'] = '---\nid: p9\ntopic: "[[../Domains and Topics/3 Alignment/Scalable oversight]]"\ntags:\n  - skill-tree-placeholder\n---\n';
    files['/notes/n.md'] = '[[../Learning Outcomes/Scalable oversight]]';
    const snap = snapshot(files);
    snap.backlinks = new Map([
      ['id-/Domains and Topics/3 Alignment/Scalable oversight.md', ['id-/Learning Outcomes/Tagged real.md']],
      ['id-/Learning Outcomes/Scalable oversight.md', ['id-/notes/n.md']],
    ]);
    const reasons = planMigration(snap, { dropRedundantPlaceholders: true }).problems.map((p) => `${p.path}: ${p.reason}`);
    expect(reasons.some((r) => r.startsWith('/Learning Outcomes/Debate.md') && /backlink index/.test(r))).toBe(true);
    expect(reasons.some((r) => r.startsWith('/Learning Outcomes/Real one.md') && /backlink index/.test(r))).toBe(true);
    expect(reasons.some((r) => r.startsWith('/Learning Outcomes/Tagged real.md'))).toBe(false);
    expect(reasons.some((r) => /would be trashed, but 1 file\(s\) link to it: notes\/n.md/.test(r))).toBe(true);
  });

  it('journal: finishes a topic: none placeholder whose edit landed but whose move did not', () => {
    const files = base();
    const before = files['/Learning Outcomes/Nowhere.md'];
    files['/Learning Outcomes/Nowhere.md'] = transformPlaceholder(before).content; // now "an LO without topic:"
    const snap = snapshot(files);
    const plan = planMigration(snap);
    expect(plan.items.some((i) => i.path === '/Learning Outcomes/Nowhere.md')).toBe(false);
    const journal: Journal = { relayUrl: 'r', folderId: 'f', entries: {
      'id-/Learning Outcomes/Nowhere.md': { kind: 'placeholder', uuid: 'id-/Learning Outcomes/Nowhere.md', source: '/Learning Outcomes/Nowhere.md', target: '/Concepts/Nowhere.md', state: 'started', at: '' },
    } };
    const r = resumeItems(journal, snap, plan);
    expect(r.problems).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'placeholder', path: '/Learning Outcomes/Nowhere.md', target: '/Concepts/Nowhere.md' });
    expect(r.items[0].after).toBe(r.items[0].before);
    // verify flags it while it is still in Learning Outcomes/
    expect(verifyMigrated(snap, new Set(['id-/Learning Outcomes/Nowhere.md'])).problems.some((p) => /per the journal/.test(p.reason))).toBe(true);
  });

  it('journal: finishes a merge whose trash went through but whose concept edit did not', () => {
    const files = base();
    files['/Concepts/Debate.md'] = '# Debate\n';
    delete files['/Learning Outcomes/Debate.md'];
    const snap = snapshot(files);
    const merge = { conceptPath: '/Concepts/Debate.md', conceptId: 'id-/Concepts/Debate.md', id: 'p1', parentNames: ['Scalable oversight'] };
    const journal: Journal = { relayUrl: 'r', folderId: 'f', entries: {
      u1: { kind: 'merge-placeholder', uuid: 'u1', source: '/Learning Outcomes/Debate.md', merge, state: 'started', at: '' },
    } };
    const r = resumeItems(journal, snap, planMigration(snap));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'merge-placeholder', alreadyTrashed: true });
    expect(r.items[0].after).toContain('parent-concepts:\n  - "[[Scalable oversight]]"');
    expect(transformFor(r.items[0], r.items[0].after)).toBe(r.items[0].after);
  });

  it('a redundant placeholder is still trashed (not merged) after its namesake topic already moved', () => {
    const files = base();
    delete files['/Domains and Topics/3 Alignment/Scalable oversight.md'];
    files['/Concepts/Scalable oversight.md'] = '---\nid: t1\nskill-tree: topic\nparent-concepts:\n  - "[[Alignment]]"\n---\n';
    for (const k of Object.keys(files)) files[k] = files[k].replace('../Domains and Topics/3 Alignment/Scalable oversight', '../Concepts/Scalable oversight');
    files['/Learning Outcomes/Scalable oversight.md'] = '---\nid: p9\ntopic: "[[../Concepts/Scalable oversight]]"\ntags:\n  - skill-tree-placeholder\n---\n';
    const plan = planMigration(snapshot(files), { dropRedundantPlaceholders: true, mergeIntoExistingConcepts: true });
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((i) => i.path === '/Learning Outcomes/Scalable oversight.md')!.kind).toBe('drop-placeholder');
  });

  it('verify accepts only parent-concepts:', () => {
    const snap = snapshot({ '/Concepts/A.md': '---\nparent:\n  - "[[B]]"\n---\n', '/Concepts/B.md': '' });
    expect(verifyMigrated(snap).problems.map((p) => p.reason)).toEqual(['concept file uses parent:; the field is parent-concepts:']);
  });
});
