import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ySectionSync } from '../components/SectionEditor/y-section-sync';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import type { RowEntry } from './concept-rows';
import {
  bodyLineFix,
  collectRows,
  findLiveRow,
  insertRowUnlessPresent,
  isLensPath,
  lensesUsing,
  rowLinkProblem,
  groupLensRows,
  CONCEPT_ROW_RULES,
  lensSourceTargets,
  matchRule,
  newConceptText,
  parseConceptFile,
  planRowInsertion,
  rowPreview,
  rowsAbout,
  sourceKind,
} from './concept-rows';

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });

const metadata: FolderMetadata = {
  '/Lens Edu/Concepts/Low-stakes control.md': md('c1'),
  '/Lens Edu/Concepts/High-stakes control.md': md('c2'),
  '/Lens Edu/articles/ai-control-redwood.md': md('a1'),
  '/Lens Edu/articles/lw-post-on-monitoring.md': md('a2'),
  '/Lens Edu/Lenses/Low-stakes control intro.md': md('l1'),
};

const CONCEPT = `---
topic:
  - "[[../Domains and Topics/7 AI Control/Control protocols]]"
# not a heading: inside frontmatter
---
# Low-stakes control

Control where no single bad action is catastrophic. Contrast [[../articles/lw-post-on-monitoring]].

## Relationships

### [[../articles/ai-control-redwood]]
Best intro we have. §2 is the explanation; §4 drifts into high-stakes.

#### A sub-heading stays in the row
More notes.

### [[../articles/lw-post-on-monitoring|the LW post]]
Uses the term once in passing.

### [[../Lenses/Low-stakes control intro]]
Uses §1–3 of the Redwood article.

## See also
### [[../articles/ai-control-redwood]]
Not a row: outside the Relationships section.
`;

const CONCEPT_PATH = '/Lens Edu/Concepts/Low-stakes control.md';

describe('parseConceptFile', () => {
  it('finds the level-3 link headings under ## Relationships', () => {
    const { sections, rows } = parseConceptFile(CONCEPT);
    expect(sections).toHaveLength(1);
    expect(rows.map((r) => r.target)).toEqual([
      '../articles/ai-control-redwood',
      '../articles/lw-post-on-monitoring',
      '../Lenses/Low-stakes control intro',
    ]);
  });

  it('runs a row until the next heading of level 3 or less, keeping deeper headings', () => {
    const [first, , last] = parseConceptFile(CONCEPT).rows;
    expect(CONCEPT.slice(first.bodyFrom, first.bodyTo)).toBe(
      'Best intro we have. §2 is the explanation; §4 drifts into high-stakes.\n\n'
      + '#### A sub-heading stays in the row\nMore notes.',
    );
    // The last row ends where the next level-2 heading starts
    expect(CONCEPT.slice(last.bodyFrom, last.bodyTo)).toBe('Uses §1–3 of the Redwood article.');
    expect(CONCEPT.slice(last.to).startsWith('## See also')).toBe(true);
  });

  it('ignores headings that are not a single link, and headings in code', () => {
    const text = '## Relationships\n\n### About [[x]]\nno\n\n```\n### [[y]]\n```\n### [[z#Part]]\nyes\n';
    expect(parseConceptFile(text).rows.map((r) => r.target)).toEqual(['z']);
  });

  it('takes a heading with a closing sequence of #s as a row', () => {
    const text = '## Relationships ##\n\n### [[a]] ###\n\n### [[b|B]]   #\n\n### [[c]]#\n';
    // `[[c]]#` has no space before the #: not a closing sequence, so not a row
    expect(parseConceptFile(text).rows.map((r) => r.target)).toEqual(['a', 'b']);
  });

  it('matches the Relationships heading case-sensitively', () => {
    expect(parseConceptFile('## relationships\n\n### [[x]]\n').sections).toEqual([]);
  });

  it('takes only a heading that is exactly one link, outside lists and quotes', () => {
    const text = '## Relationships\n\n### [[a]] (draft)\n\n- ### [[b]]\n> ### [[c]]\n### [[d|D]]\n';
    expect(parseConceptFile(text).rows.map((r) => r.target)).toEqual(['d']);
  });

  it('has no rows without a Relationships section', () => {
    expect(parseConceptFile('# C\n\n### [[x]]\n')).toEqual({ sections: [], rows: [] });
  });

  it('gives an empty row an empty body', () => {
    const text = '## Relationships\n\n### [[x]]\n\n### [[y]]';
    const [x, y] = parseConceptFile(text).rows;
    expect(x.bodyFrom).toBe(x.bodyTo);
    expect(text.slice(0, x.headingTo).endsWith('### [[x]]')).toBe(true);
    expect(y.bodyFrom).toBe(text.length);
  });
});

describe('rowsAbout', () => {
  it('matches by the resolved document, through relative paths and aliases', () => {
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'a2', metadata)).toHaveLength(1);
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'l1', metadata)).toHaveLength(1);
  });

  it('does not count a link outside a row heading', () => {
    // a1 is linked twice, but only once inside ## Relationships
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'a1', metadata)).toHaveLength(1);
  });

  it('returns every row about the target when there are several', () => {
    const text = '## Relationships\n\n### [[../articles/ai-control-redwood]]\none\n\n### [[../articles/AI-Control-Redwood.md]]\ntwo\n';
    expect(rowsAbout(text, CONCEPT_PATH, 'a1', metadata).map((r) => text.slice(r.bodyFrom, r.bodyTo)))
      .toEqual(['one', 'two']);
  });

  it('does not match a link that resolves elsewhere or nowhere', () => {
    const text = '## Relationships\n\n### [[ai-control-redwood]]\n\n### [[../articles/missing]]\n';
    expect(rowsAbout(text, CONCEPT_PATH, 'a1', metadata)).toEqual([]);
  });
});

describe('collectRows', () => {
  const rule = CONCEPT_ROW_RULES[0];
  const pathOf = (id: string) => Object.entries(metadata).find(([, m]) => m.id === id)?.[0] ?? null;

  it('splits backlinking concept files into rows and plain mentions', () => {
    const texts = new Map([
      ['c1', CONCEPT],
      ['c2', '# High-stakes control\n\nSee [[../articles/ai-control-redwood]].\n'],
    ]);
    const out = collectRows('a1', ['c2', 'c1', 'l1'], texts, metadata, rule, pathOf);
    expect(out.rows.map((r) => [r.conceptName, r.body.split('\n')[0]])).toEqual([
      ['Low-stakes control', 'Best intro we have. §2 is the explanation; §4 drifts into high-stakes.'],
    ]);
    expect(out.mentions.map((m) => m.conceptName)).toEqual(['High-stakes control']);
    expect(out.pending).toBe(0);
  });

  it('skips files outside the rule folder and counts unread ones as pending', () => {
    const out = collectRows('a1', ['l1', 'c1'], new Map(), metadata, rule, pathOf);
    expect(out).toEqual({ rows: [], mentions: [], pending: 1 });
  });
});

describe('matchRule', () => {
  it('matches articles, video transcripts and lenses in Lens Edu only', () => {
    expect(matchRule('/Lens Edu/articles/x.md')?.openedLabel).toBe('This article');
    expect(matchRule('/Lens Edu/video_transcripts/x.md')?.openedLabel).toBe('This video');
    expect(matchRule('/Lens Edu/Lenses/x.md')?.sourceContext).toBe(true);
    expect(matchRule('/Lens Edu/Lenses/x.md')?.title).toBe('Concept relationships');
    expect(matchRule('/Lens Edu/Concepts/x.md')).toBeNull();
    expect(matchRule('/Lens/articles/x.md')).toBeNull();
    expect(matchRule('/Lens Edu/articles/x.html')).toBeNull();
    expect(matchRule(undefined)).toBeNull();
  });
});

describe('sourceKind', () => {
  it('tells articles and videos apart, and leaves other sources out', () => {
    expect(sourceKind('/Lens Edu/articles/x.md', 'Lens Edu')).toBe('Article');
    expect(sourceKind('/Lens Edu/video_transcripts/x.md', 'Lens Edu')).toBe('Video');
    expect(sourceKind('/Lens Edu/widgets/x.html', 'Lens Edu')).toBeNull();
    expect(sourceKind('/Lens/articles/x.md', 'Lens Edu')).toBeNull();
  });
});

describe('rowPreview', () => {
  it('shows the first non-empty line, cut to the limit', () => {
    expect(rowPreview('\n  First line.\nSecond')).toBe('First line.');
    expect(rowPreview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(rowPreview('')).toBe('');
  });
});

describe('planRowInsertion', () => {
  const apply = (text: string, p: ReturnType<typeof planRowInsertion>) =>
    text.slice(0, p.at) + p.insert + text.slice(p.at);

  it('appends a row with an empty line at the end of the Relationships section', () => {
    const text = '# C\n\n## Relationships\n\n### [[a]]\nNotes.\n\n## See also\nx\n';
    const p = planRowInsertion(text, '../articles/b');
    const out = apply(text, p);
    expect(out).toBe('# C\n\n## Relationships\n\n### [[a]]\nNotes.\n\n### [[../articles/b]]\n\n\n## See also\nx\n');
    expect(p.bodyFrom).toBe(p.bodyTo);
    expect(parseConceptFile(out).rows.map((r) => r.target)).toEqual(['a', '../articles/b']);
  });

  it('adds the Relationships section when missing', () => {
    const text = '# C\n\nDescription.';
    const out = apply(text, planRowInsertion(text, 'x'));
    expect(out).toBe('# C\n\nDescription.\n\n## Relationships\n\n### [[x]]\n\n');
  });

  it('places a prefilled body where bodyFrom/bodyTo say', () => {
    const text = '## Relationships\n';
    const p = planRowInsertion(text, 'x', 'Draft text');
    const out = apply(text, p);
    expect(out.slice(p.bodyFrom, p.bodyTo)).toBe('Draft text');
    const [row] = parseConceptFile(out).rows;
    expect(out.slice(row.bodyFrom, row.bodyTo)).toBe('Draft text');
  });
});

describe('newConceptText', () => {
  it('starts with frontmatter holding the id, then the title, the Relationships section and the row', () => {
    const id = '0b6f3c2e-5d4a-4f1e-9c8b-7a6d5e4f3a2b';
    const text = newConceptText('Corrigibility', id, '../articles/x');
    expect(text).toBe(`---\nid: ${id}\n---\n# Corrigibility\n\n## Relationships\n\n### [[../articles/x]]\n\n`);
    expect(parseConceptFile(text).rows).toHaveLength(1);
  });
});

describe('lensSourceTargets', () => {
  it('reads every source:: of the lens, once each, but not from text sections', () => {
    const lens = `---
title: Demo
---

#### Article
source:: [[../articles/one|One]]
from:: "Start"

#### Text
content::
source:: [[../articles/not-a-source]]

#### Video
source:: [[../video_transcripts/talk]]

#### Article
source:: [[../articles/one]]

#### Widget
source:: [[../widgets/quiz]]
`;
    expect(lensSourceTargets(lens)).toEqual(['../articles/one', '../video_transcripts/talk', '../widgets/quiz']);
  });
});

describe('groupLensRows', () => {
  const entry = (conceptId: string, index = 0, body = conceptId) => ({
    conceptId,
    conceptPath: `/Lens Edu/Concepts/${conceptId}.md`,
    conceptName: conceptId,
    row: parseConceptFile('## Relationships\n\n### [[x]]\n').rows[0],
    index,
    body,
  });

  const src = (sourceId: string, rows: RowEntry[], kind = 'Article') => ({ sourceId, sourceName: sourceId, kind, rows });

  it('puts a concept with lens and source rows once, its source rows under the lens row', () => {
    const own = [entry('Feedback'), entry('Low-stakes')];
    const sources = [
      src('One', [entry('Corrigibility'), entry('Feedback', 0, 'article note')]),
      src('Talk', [entry('Feedback', 0, 'video note')], 'Video'),
    ];
    const { lens, sourceOnly } = groupLensRows(own, sources);
    expect(lens.map((g) => [g.entry.conceptId, g.sourceRows.map((s) => [s.sourceName, s.kind, s.rows.map((r) => r.body)])]))
      .toEqual([
        ['Feedback', [['One', 'Article', ['article note']], ['Talk', 'Video', ['video note']]]],
        ['Low-stakes', []],
      ]);
    expect(sourceOnly.map((c) => [c.conceptName, c.sourceRows.map((s) => s.sourceName)])).toEqual([['Corrigibility', ['One']]]);
  });

  it('attaches the source rows to the first of several lens rows only', () => {
    const { lens } = groupLensRows([entry('C', 0), entry('C', 1)], [src('A', [entry('C')])]);
    expect(lens.map((g) => g.sourceRows.length)).toEqual([1, 0]);
  });

  it('shows a concept with rows about several sources once, one block per source, by concept name', () => {
    const { lens, sourceOnly } = groupLensRows([], [
      src('Pan', [entry('Acausal', 0, 'pan note'), entry('Trading')]),
      src('Greenblatt', [entry('Acausal', 0, 'greenblatt note')]),
    ]);
    expect(lens).toEqual([]);
    expect(sourceOnly.map((c) => [c.conceptId, c.sourceRows.map((s) => [s.sourceName, s.rows[0].body])])).toEqual([
      ['Acausal', [['Pan', 'pan note'], ['Greenblatt', 'greenblatt note']]],
      ['Trading', [['Pan', 'Trading']]],
    ]);
  });
});

const targets = (text: string) => parseConceptFile(text).rows.map((r) => r.target);

describe('canonical concept-row rules v1', () => {
  it('#1: every ## Relationships section counts; exact text, closing hashes allowed', () => {
    // canonical concept-row rules v1 #1
    const text = '## Relationships\n### [[a]]\n## Notes\n### [[x]]\n## Relationships ##\n### [[b]]\n## *Relationships*\n### [[y]]\n';
    expect(targets(text)).toEqual(['a', 'b']);
    expect(parseConceptFile(text).sections).toHaveLength(2);
  });

  it('#2: a section ends at the next heading of level 1 or 2', () => {
    // canonical concept-row rules v1 #2
    expect(targets('## Relationships\n#### deep\n### [[a]]\n# Top\n### [[b]]\n')).toEqual(['a']);
  });

  it('#3: a row is a level-3 heading (indent ≤ 3) that is exactly one wikilink; not an embed or an empty page', () => {
    // canonical concept-row rules v1 #3
    const text = '## Relationships\n   ### [[a|A]] ###\n    ### [[indented-code]]\n### ![[embed]]\n### [[#heading]]\n### [[b#Part]]\n### [[c]] notes\n';
    expect(targets(text)).toEqual(['a', 'b']);
  });

  it('#4: a row body runs to the next heading of level ≤ 3', () => {
    // canonical concept-row rules v1 #4
    const text = '## Relationships\n### [[a]]\nOne\n#### Sub\nTwo\n### [[b]]\nThree\n';
    const [a] = parseConceptFile(text).rows;
    expect(text.slice(a.bodyFrom, a.bodyTo)).toBe('One\n#### Sub\nTwo');
  });

  it('#5: no headings in fences (CommonMark closing), %% comments, lists, quotes or frontmatter', () => {
    // canonical concept-row rules v1 #5
    const text = [
      '---', 'title: x', '### [[fm]]', '---  ',
      '## Relationships',
      '````', '### [[f1]]', '```', '### [[f2]]', '```` x', '### [[f3]]', '````', // only a bare, long-enough fence closes
      '    ```', '### [[after-indented-fence]]',
      '%% a comment', '### [[c1]]', '%%',
      'Inline %%### [[c2]]%% text',
      '- item', '  ### [[in-list]]',
      '> ### [[quoted]]',
      '~~~ js', '### [[t1]]', '~~~',
      '### [[real]]',
    ].join('\n');
    expect(targets(text)).toEqual(['after-indented-fence', 'real']);
  });

  it('#6: the editor parses the raw text, pending CriticMarkup included', () => {
    // canonical concept-row rules v1 #6: a heading only inside a pending suggestion is an accepted divergence
    const text = '## Relationships\n{--\n### [[deleted-but-pending]]\n--}\n';
    expect(targets(text)).toEqual(['deleted-but-pending']);
  });

  it('#7: rows match by resolved document, case-insensitively, with the root fallback', () => {
    // canonical concept-row rules v1 #7
    const text = '## Relationships\n### [[../ARTICLES/Ai-Control-Redwood]]\n### [[Lens Edu/articles/lw-post-on-monitoring]]\n';
    expect(rowsAbout(text, CONCEPT_PATH, 'a1', metadata)).toHaveLength(1);
    expect(rowsAbout(text, CONCEPT_PATH, 'a2', metadata)).toHaveLength(1);
  });

  it('#8: lens sources: every source:: (several per section, before any heading, CRLF), not in Text sections', () => {
    // canonical concept-row rules v1 #8
    const lens = [
      'source:: [[../articles/before-heading]]',
      '#### Article',
      'source:: [[../articles/one.md|One]]',
      'source:: [[../video_transcripts/talk]] and [[../articles/second-link-ignored]]',
      '#### Text',
      'content::',
      'source:: [[../articles/prose]]',
      '#### Widget',
      'source:: [[../widgets/quiz]]',
    ].join('\r\n');
    expect(lensSourceTargets(lens)).toEqual(['../articles/before-heading', '../articles/one.md', '../video_transcripts/talk', '../widgets/quiz']);
    expect(sourceKind('/Lens Edu/widgets/quiz.html', 'Lens Edu')).toBeNull();
  });

  it('#9: rows sort case-insensitively by concept name', () => {
    // canonical concept-row rules v1 #9
    const md2: FolderMetadata = {
      '/Lens Edu/Concepts/beta.md': md('cb'),
      '/Lens Edu/Concepts/Alpha.md': md('ca'),
      '/Lens Edu/articles/x.md': md('ax'),
    };
    const row = '## Relationships\n### [[../articles/x]]\n';
    const out = collectRows('ax', ['cb', 'ca'], new Map([['cb', row], ['ca', row]]), md2, CONCEPT_ROW_RULES[0],
      (id) => Object.entries(md2).find(([, m]) => m.id === id)?.[0] ?? null);
    expect(out.rows.map((r) => r.conceptName)).toEqual(['Alpha', 'beta']);
  });

  it('#10: an article shows the rows of the lenses whose source:: resolves to it', () => {
    // canonical concept-row rules v1 #10
    const md3: FolderMetadata = {
      '/Lens Edu/articles/x.md': md('ax'),
      '/Lens Edu/articles/other.md': md('ao'),
      '/Lens Edu/Lenses/Uses X.md': md('lu'),
      '/Lens Edu/Lenses/A first.md': md('la'),
      '/Lens Edu/Lenses/Text only.md': md('lt'),
      '/Lens Edu/Lenses/Mentions.md': md('lm'),
      '/Lens Edu/Concepts/C.md': md('cc'),
    };
    const texts = new Map([
      ['lu', '#### Article\nsource:: [[../articles/X|Shown]]\n'],
      ['la', 'source:: [[Lens Edu/articles/x]]\n'],
      ['lt', '#### Text\ncontent::\nsource:: [[../articles/x]]\n'],
      ['lm', 'See [[../articles/x]].\n#### Article\nsource:: [[../articles/other]]\n'],
      ['cc', 'source:: [[../articles/x]]\n'],
    ]);
    const pathOf = (id: string) => Object.entries(md3).find(([, m]) => m.id === id)?.[0] ?? null;
    const out = lensesUsing('ax', ['lu', 'lt', 'lm', 'cc', 'la'], texts, md3, 'Lens Edu', pathOf);
    expect(out.lenses.map((l) => l.path)).toEqual(['/Lens Edu/Lenses/A first.md', '/Lens Edu/Lenses/Uses X.md']);
    expect(out.pending).toBe(0);
    expect(matchRule('/Lens Edu/articles/x.md')?.lensContext).toBe(true);
    expect(matchRule('/Lens Edu/video_transcripts/x.md')?.lensContext).toBe(true);
    expect(matchRule('/Lens Edu/Lenses/x.md')?.lensContext).toBeFalsy();
  });
});

describe('lensesUsing', () => {
  it('counts lenses not read yet as pending and leaves other files out', () => {
    const pathOf = (id: string) => Object.entries(metadata).find(([, m]) => m.id === id)?.[0] ?? null;
    expect(lensesUsing('a1', ['l1', 'c1'], new Map(), metadata, 'Lens Edu', pathOf)).toEqual({ lenses: [], pending: 1 });
  });

  it('tells lenses by folder', () => {
    expect(isLensPath('/Lens Edu/Lenses/x.md', 'Lens Edu')).toBe(true);
    expect(isLensPath('/Lens Edu/articles/x.md', 'Lens Edu')).toBe(false);
    expect(isLensPath('/Lens/Lenses/x.md', 'Lens Edu')).toBe(false);
  });
});

describe('planRowInsertion with several Relationships sections', () => {
  it('appends to the first', () => {
    const text = '## Relationships\n### [[a]]\n\n## Notes\n\n## Relationships\n### [[b]]\n';
    const p = planRowInsertion(text, 'c');
    const out = text.slice(0, p.at) + p.insert + text.slice(p.at);
    expect(out.indexOf('### [[c]]')).toBeLessThan(out.indexOf('## Notes'));
    expect(targets(out)).toEqual(['a', 'c', 'b']);
  });
});

describe('editing an empty row next to a heading (bodyLineFix + ySectionSync)', () => {
  /** Open the row about `target` the way the panel does, in an editor bound to its text. */
  function openRow(text: string, target: string) {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, text);
    const row = parseConceptFile(text).rows.find((r) => r.target === target)!;
    const lineBreak = bodyLineFix(row, text.length);
    const view = new EditorView({
      state: EditorState.create({
        doc: text.slice(row.bodyFrom, row.bodyTo),
        extensions: [ySectionSync(ytext, row.bodyFrom, row.bodyTo, { lineBreakOnFirstEdit: lineBreak ?? undefined, endExclusive: true })],
      }),
    });
    const type = (typed: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: typed } });
    return { ytext, view, type };
  }

  it('keeps the next row heading intact', () => {
    const { ytext, type } = openRow('## Relationships\n### [[a]]\n### [[b]]\n', 'a');
    type('TYPED');
    expect(ytext.toString()).toBe('## Relationships\n### [[a]]\nTYPED\n### [[b]]\n');
    expect(targets(ytext.toString())).toEqual(['a', 'b']);
  });

  it('keeps a following section heading intact', () => {
    const { ytext, type } = openRow('## Relationships\n### [[a]]\n## Other\n', 'a');
    type('TYPED');
    type(' more');
    expect(ytext.toString()).toBe('## Relationships\n### [[a]]\nTYPED more\n## Other\n');
  });

  it('gives a heading at the end of the file a line of its own', () => {
    const { ytext, type } = openRow('## Relationships\n### [[a]]', 'a');
    type('TYPED');
    expect(ytext.toString()).toBe('## Relationships\n### [[a]]\nTYPED');
  });

  it('writes nothing when the row is only opened', () => {
    const text = '## Relationships\n### [[a]]\n### [[b]]\n';
    const { ytext, view } = openRow(text, 'a');
    view.destroy();
    expect(ytext.toString()).toBe(text);
  });

  it('leaves a row that already has a line alone', () => {
    const text = '## Relationships\n### [[a]]\n\n### [[b]]\n';
    expect(bodyLineFix(parseConceptFile(text).rows[0], text.length)).toBeNull();
    const atEnd = '## Relationships\n### [[a]]\n';
    expect(bodyLineFix(parseConceptFile(atEnd).rows[0], atEnd.length)).toBeNull();
  });

  it('shows text that someone else adds to the end of the open row\'s last line', () => {
    const { ytext, view } = openRow('## Relationships\n### [[a]]\nHello', 'a');
    ytext.insert(ytext.length, ' world'); // another client, synced in
    expect(view.state.doc.toString()).toBe('Hello world');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
    expect(ytext.toString()).toBe('## Relationships\n### [[a]]\nHello world!');
  });

  it('keeps a row appended at the end of the file by someone else out of the open row', () => {
    const { ytext, view } = openRow('## Relationships\n### [[a]]\nnotes', 'a');
    const plan = planRowInsertion(ytext.toString(), 'b');
    ytext.insert(plan.at, plan.insert); // another client's add, synced in
    expect(view.state.doc.toString()).toBe('notes');
    expect(ytext.toString()).toBe('## Relationships\n### [[a]]\nnotes\n\n### [[b]]\n\n');
    expect(targets(ytext.toString())).toEqual(['a', 'b']);
  });
});

describe('findLiveRow', () => {
  const live = '## Relationships\n### [[x]]\nfirst\n### [[x]]\nsecond\n';
  const rows = parseConceptFile(live).rows;
  const entry = (index: number, body: string) => ({ index, body });

  it('takes the only live row, whatever the stale index', () => {
    expect(findLiveRow([rows[1]], live, entry(0, 'old'))).toBe(rows[1]);
  });

  it('tells several rows about the same file apart by their text first', () => {
    expect(findLiveRow(rows, live, entry(0, 'second'))).toBe(rows[1]);
    expect(findLiveRow(rows, live, entry(1, 'changed since'))).toBe(rows[1]);
    expect(findLiveRow([], live, entry(0, 'x'))).toBeNull();
  });

  it('takes the row at the same position when its text is unchanged: identical or empty rows', () => {
    const same = '## Relationships\n### [[x]]\nsame\n### [[x]]\nsame\n';
    const sameRows = parseConceptFile(same).rows;
    expect(findLiveRow(sameRows, same, entry(1, 'same'))).toBe(sameRows[1]);
    expect(findLiveRow(sameRows, same, entry(0, 'same'))).toBe(sameRows[0]);
    const empty = '## Relationships\n### [[x]]\n\n### [[x]]\n\n';
    const emptyRows = parseConceptFile(empty).rows;
    expect(findLiveRow(emptyRows, empty, entry(1, ''))).toBe(emptyRows[1]);
  });
});

describe('rowLinkProblem', () => {
  it('refuses links that cannot be a wikilink', () => {
    expect(rowLinkProblem('../articles/C# basics')).toMatch(/#, \|, \[ or \]/);
    expect(rowLinkProblem('../articles/a|b')).not.toBeNull();
    expect(rowLinkProblem('../articles/[draft] x')).not.toBeNull();
    expect(rowLinkProblem('../articles/fine-name')).toBeNull();
  });
});

describe('insertRowUnlessPresent', () => {
  const live = (text: string) => ({ value: text, toString() { return this.value; }, insert(i: number, c: string) { this.value = this.value.slice(0, i) + c + this.value.slice(i); } });

  it('opens the row already in the live text instead of writing a second one', () => {
    const text = live('## Relationships\n### [[../articles/ai-control-redwood]]\nnotes\n');
    expect(insertRowUnlessPresent(text, CONCEPT_PATH, 'a1', '../articles/ai-control-redwood', '', metadata))
      .toEqual({ index: 0 });
    expect(text.value).toBe('## Relationships\n### [[../articles/ai-control-redwood]]\nnotes\n');
  });

  it('inserts when there is none, and says which row it is', () => {
    const text = live('## Relationships\n### [[../articles/lw-post-on-monitoring]]\n');
    expect(insertRowUnlessPresent(text, CONCEPT_PATH, 'a1', '../articles/ai-control-redwood', 'draft', metadata))
      .toEqual({ index: 0 });
    expect(rowsAbout(text.value, CONCEPT_PATH, 'a1', metadata)).toHaveLength(1);
  });
});
