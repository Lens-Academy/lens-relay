import { describe, expect, it } from 'vitest';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import {
  collectRows,
  groupLensRows,
  CONCEPT_ROW_RULES,
  lensArticleTargets,
  matchRule,
  newConceptText,
  parseConceptFile,
  planRowInsertion,
  rowPreview,
  rowsAbout,
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

## Considered

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
Not a row: outside the Considered section.
`;

const CONCEPT_PATH = '/Lens Edu/Concepts/Low-stakes control.md';

describe('parseConceptFile', () => {
  it('finds the level-3 link headings under ## Considered', () => {
    const { section, rows } = parseConceptFile(CONCEPT);
    expect(section).not.toBeNull();
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

  it('records the heading line', () => {
    const [first] = parseConceptFile(CONCEPT).rows;
    expect(CONCEPT.split('\n')[first.line - 1]).toBe('### [[../articles/ai-control-redwood]]');
    expect(CONCEPT.slice(first.headingFrom, first.headingTo)).toBe('### [[../articles/ai-control-redwood]]');
  });

  it('ignores headings that are not a single link, and headings in code', () => {
    const text = '## Considered\n\n### About [[x]]\nno\n\n```\n### [[y]]\n```\n### [[z#Part]]\nyes\n';
    expect(parseConceptFile(text).rows.map((r) => r.target)).toEqual(['z']);
  });

  it('matches the Considered heading case-sensitively', () => {
    expect(parseConceptFile('## considered\n\n### [[x]]\n').section).toBeNull();
  });

  it('takes only a heading that is exactly one link, outside lists and quotes', () => {
    const text = '## Considered\n\n### [[a]] (draft)\n\n- ### [[b]]\n> ### [[c]]\n### [[d|D]]\n';
    expect(parseConceptFile(text).rows.map((r) => r.target)).toEqual(['d']);
  });

  it('has no rows without a Considered section', () => {
    expect(parseConceptFile('# C\n\n### [[x]]\n')).toEqual({ section: null, rows: [] });
  });

  it('gives an empty row an empty body', () => {
    const text = '## Considered\n\n### [[x]]\n\n### [[y]]';
    const [x, y] = parseConceptFile(text).rows;
    expect(x.bodyFrom).toBe(x.bodyTo);
    expect(text.slice(x.headingFrom, x.headingTo)).toBe('### [[x]]');
    expect(y.bodyFrom).toBe(text.length);
  });
});

describe('rowsAbout', () => {
  it('matches by the resolved document, through relative paths and aliases', () => {
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'a2', metadata)).toHaveLength(1);
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'l1', metadata)).toHaveLength(1);
  });

  it('does not count a link outside a row heading', () => {
    // a1 is linked twice, but only once inside ## Considered
    expect(rowsAbout(CONCEPT, CONCEPT_PATH, 'a1', metadata)).toHaveLength(1);
  });

  it('returns every row about the target when there are several', () => {
    const text = '## Considered\n\n### [[../articles/ai-control-redwood]]\none\n\n### [[../articles/AI-Control-Redwood.md]]\ntwo\n';
    expect(rowsAbout(text, CONCEPT_PATH, 'a1', metadata).map((r) => text.slice(r.bodyFrom, r.bodyTo)))
      .toEqual(['one', 'two']);
  });

  it('does not match a link that resolves elsewhere or nowhere', () => {
    const text = '## Considered\n\n### [[ai-control-redwood]]\n\n### [[../articles/missing]]\n';
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
  it('matches articles and lenses in Lens Edu only', () => {
    expect(matchRule('/Lens Edu/articles/x.md')?.openedIn).toBe('articles');
    expect(matchRule('/Lens Edu/Lenses/x.md')?.articleContext).toBe(true);
    expect(matchRule('/Lens Edu/Concepts/x.md')).toBeNull();
    expect(matchRule('/Lens/articles/x.md')).toBeNull();
    expect(matchRule('/Lens Edu/articles/x.html')).toBeNull();
    expect(matchRule(undefined)).toBeNull();
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

  it('appends a row with an empty line at the end of the Considered section', () => {
    const text = '# C\n\n## Considered\n\n### [[a]]\nNotes.\n\n## See also\nx\n';
    const p = planRowInsertion(text, '../articles/b');
    const out = apply(text, p);
    expect(out).toBe('# C\n\n## Considered\n\n### [[a]]\nNotes.\n\n### [[../articles/b]]\n\n\n## See also\nx\n');
    expect(p.bodyFrom).toBe(p.bodyTo);
    expect(parseConceptFile(out).rows.map((r) => r.target)).toEqual(['a', '../articles/b']);
  });

  it('adds the Considered section when missing', () => {
    const text = '# C\n\nDescription.';
    const out = apply(text, planRowInsertion(text, 'x'));
    expect(out).toBe('# C\n\nDescription.\n\n## Considered\n\n### [[x]]\n\n');
  });

  it('places a prefilled body where bodyFrom/bodyTo say', () => {
    const text = '## Considered\n';
    const p = planRowInsertion(text, 'x', 'Draft text');
    const out = apply(text, p);
    expect(out.slice(p.bodyFrom, p.bodyTo)).toBe('Draft text');
    const [row] = parseConceptFile(out).rows;
    expect(out.slice(row.bodyFrom, row.bodyTo)).toBe('Draft text');
  });
});

describe('newConceptText', () => {
  it('starts with the title, the Considered section and the row', () => {
    const text = newConceptText('Corrigibility', '../articles/x');
    expect(text).toBe('# Corrigibility\n\n## Considered\n\n### [[../articles/x]]\n\n');
    expect(parseConceptFile(text).rows).toHaveLength(1);
  });
});

describe('lensArticleTargets', () => {
  it('reads source:: of each Article section', () => {
    const lens = `---
title: Demo
---

#### Article
source:: [[../articles/one|One]]
from:: "Start"

#### Text
content::
source:: [[../articles/not-an-article]]

#### Article
source:: [[../articles/two]]

#### Article
source:: [[../articles/one]]
`;
    expect(lensArticleTargets(lens)).toEqual(['../articles/one', '../articles/two']);
  });
});

describe('groupLensRows', () => {
  const entry = (conceptId: string, index = 0, body = conceptId) => ({
    conceptId,
    conceptPath: `/Lens Edu/Concepts/${conceptId}.md`,
    conceptName: conceptId,
    row: parseConceptFile('## Considered\n\n### [[x]]\n').rows[0],
    index,
    body,
  });

  it('puts a concept with lens and article rows once, its article rows under the lens row', () => {
    const own = [entry('Feedback'), entry('Low-stakes')];
    const articles = [
      { articleId: 'a1', articleName: 'One', rows: [entry('Corrigibility'), entry('Feedback', 0, 'article note')] },
      { articleId: 'a2', articleName: 'Two', rows: [entry('Feedback', 0, 'second article')] },
    ];
    const { lens, articleOnly } = groupLensRows(own, articles);
    expect(lens.map((g) => [g.entry.conceptId, g.articleRows.map((a) => [a.articleName, a.rows.map((r) => r.body)])]))
      .toEqual([
        ['Feedback', [['One', ['article note']], ['Two', ['second article']]]],
        ['Low-stakes', []],
      ]);
    expect(articleOnly.map((a) => [a.articleName, a.rows.map((r) => r.conceptId)])).toEqual([['One', ['Corrigibility']]]);
  });

  it('attaches the article rows to the first of several lens rows only', () => {
    const { lens } = groupLensRows(
      [entry('C', 0), entry('C', 1)],
      [{ articleId: 'a', articleName: 'A', rows: [entry('C')] }],
    );
    expect(lens.map((g) => g.articleRows.length)).toEqual([1, 0]);
  });

  it('keeps every article row apart when the lens has none', () => {
    const articles = [{ articleId: 'a', articleName: 'A', rows: [entry('B'), entry('A')] }];
    expect(groupLensRows([], articles)).toEqual({ lens: [], articleOnly: articles });
  });
});
