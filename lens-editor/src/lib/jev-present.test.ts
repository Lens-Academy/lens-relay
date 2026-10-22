import { describe, expect, it } from 'vitest';
import { around, chunks, keepOnly, LEVELS, paragraphOf, parseDoc, render, stateFor, within } from './jev-present';

// Lauren's example, 2026-10-21 (her `heading_N` level is now `section_N`, 2026-10-22).
const LAUREN = `this is line 0 in implicit header 0,
line 1 in same para, same sentence.
another line in same para, second sentence.

here's a second para, third sentence.

# section 1

here's section 1 para 2 sentence 3.`;

describe('a file as nested, globally numbered keys', () => {
  const d = parseDoc(LAUREN);
  it('matches the example, every numbering global, and implicit wrappers add no layer', () => {
    expect(render(d, 'line', LEVELS)).toEqual({
      section_0: {
        paragraph_0: {
          sentence_0: { line_0: 'this is line 0 in implicit header 0,', line_1: 'line 1 in same para, same sentence.' },
          sentence_1: { line_2: 'another line in same para, second sentence.' },
        },
        paragraph_1: { sentence_2: { line_4: "here's a second para, third sentence." } },
      },
      section_1: {
        title: 'section 1',
        paragraph_2: { sentence_3: { line_8: "here's section 1 para 2 sentence 3." } },
      },
    });
  });
  it('keeps keys in ascending order, the title first (jev reads key order)', () => {
    const j = render(d, 'line', LEVELS) as Record<string, Record<string, unknown>>;
    expect(Object.keys(j)).toEqual(['section_0', 'section_1']);
    expect(Object.keys(j.section_1)).toEqual(['title', 'paragraph_2']);
  });
  it('adds a layer only for the levels nested; the question level holds the text', () => {
    expect(render(d, 'paragraph', [])).toEqual({
      paragraph_0: 'this is line 0 in implicit header 0, line 1 in same para, same sentence. another line in same para, second sentence.',
      paragraph_1: "here's a second para, third sentence.",
      paragraph_2: "here's section 1 para 2 sentence 3.",
    });
    expect((render(d, 'sentence', ['section']) as Record<string, unknown>).section_0).toEqual({
      sentence_0: 'this is line 0 in implicit header 0, line 1 in same para, same sentence.',
      sentence_1: 'another line in same para, second sentence.',
      sentence_2: "here's a second para, third sentence.",
    });
  });
  it('splits two sentences on one line, and gives the line to both', () => {
    expect(render(parseDoc('One. Two!\n'), 'line', LEVELS)).toEqual({ paragraph_0: { sentence_0: { line_0: 'One.' }, sentence_1: { line_0: 'Two!' } } });
  });
  it('skips frontmatter but keeps file line numbers', () => {
    expect(render(parseDoc('---\nid: x\n---\nHello there.\n'), 'line', [])).toEqual({ line_3: 'Hello there.' });
  });
  it('drops %% comments, even across lines, and field names', () => {
    const t = parseDoc('content:: Shown. %%hidden%% Also shown.\n%% a\nstill hidden %% After.\n');
    expect(within(t, 'paragraph').map((x) => x.text)).toEqual(['Shown. Also shown.', 'After.']); // an all-comment line ends a paragraph
  });
});

describe('the levels of a course file', () => {
  const MODULE = `# Submodule: Basics

## Lens: First
#### Text
content:: One here.

#### End

## Lens:
source:: [[../Lenses/x]]

# Submodule: More
#### Text
content:: Two here.
`;
  const d = parseDoc(MODULE);
  it('reads submodules, lenses and sections (segments), dropping ones with no text', () => {
    expect(within(d, 'submodule').map((x) => x.title)).toEqual(['Basics', 'More']);
    expect(within(d, 'lens').map((x) => [x.idx, x.title, x.implicit])).toEqual([[0, 'First', false], [1, undefined, false], [2, undefined, true]]);
    expect(within(d, 'section').map((x) => x.title)).toEqual(['Text', undefined, 'Text']);
  });
  it('nests a module by its own structure', () => {
    expect(render(d, 'paragraph', ['submodule', 'lens'])).toEqual({
      submodule_0: { title: 'Basics', lens_0: { title: 'First', paragraph_0: 'One here.' }, lens_1: { paragraph_1: '[[../Lenses/x]]' } },
      submodule_1: { title: 'More', paragraph_2: 'Two here.' },
    });
  });
  it("shows a unit asked about as itself as its own markdown", () => {
    const sec = within(d, 'section')[0];
    expect(stateFor(sec, 'section', [], MODULE)).toEqual({ section: '#### Text\ncontent:: One here.' });
    expect(stateFor(d, 'document', [], MODULE)).toEqual({ document: MODULE });
    expect(stateFor(within(d, 'paragraph')[0], 'paragraph', [], MODULE)).toEqual({ paragraph: 'One here.' });
  });
  it('describes the parsed form it shows', () => {
    const st = stateFor(d, 'paragraph', ['lens'], MODULE);
    expect(Object.keys(st)).toEqual(['__format_description', 'document']);
    expect(st.__format_description).toMatch(/^A document of a course file, parsed into nested lenss?, paragraphs\./);
  });
});

describe('finding a corpus row in a file that may have changed', () => {
  it('finds by the words, nearest the old line when repeated, else by the line', () => {
    const d = parseDoc('New line added.\n\nIntro here.\n\nThe METR result.\n\nThe METR result.\n');
    expect(paragraphOf(d, 3, 'The METR result.')?.idx).toBe(2);
    expect(paragraphOf(d, 7, 'The METR result.')?.idx).toBe(3);
    expect(paragraphOf(d, 2, 'Gone now.')).toBeUndefined();
    expect(paragraphOf(d, 3)?.text).toBe('Intro here.');
  });
  it('finds the unit around another', () => {
    const d = parseDoc(LAUREN);
    expect(around(within(d, 'sentence')[3], 'section').title).toBe('section 1');
  });
});

describe('chunking a context too big for jev', () => {
  const big = Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? `# Part ${i / 4}\n\n` : '') + `Paragraph ${i} says something long enough to count. `.repeat(3)).join('\n\n');
  const d = parseDoc(big);
  it('cuts whole paragraphs into runs under the limit, keeping global keys', () => {
    const runs = chunks(d, 'sentence', LEVELS, 600);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.flat().map((p) => p.idx)).toEqual([...Array(12).keys()]);
    for (const run of runs) {
      const j = JSON.stringify(render(d, 'sentence', LEVELS, keepOnly(run)));
      expect(run.length === 1 || j.length <= 600).toBe(true);
      expect(j).toContain(`paragraph_${run[0].idx}`);
    }
  });
  it('has no runs for a file with no text', () => {
    expect(chunks(parseDoc('---\nid: x\n---\n%% only a comment %%\n'), 'sentence', LEVELS, 600)).toEqual([]);
  });
  it('is one run when it fits', () => {
    expect(chunks(d, 'sentence', LEVELS, 1e9)).toHaveLength(1);
  });
  it('cuts at sections when sections are the question', () => {
    expect(chunks(d, 'section', [], 700).every((run) => run.every((x) => x.level === 'section'))).toBe(true);
  });
});
