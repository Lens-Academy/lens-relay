import { describe, expect, it } from 'vitest';
import { parseDoc, docJson, unitOf, presentState, templateQuestion, FORMAT_DESCRIPTION } from './jev-present';

// Lauren's example, 2026-10-21.
const LAUREN = `this is line 0 in implicit header 0,
line 1 in same para, same sentence.
another line in same para, second sentence.

here's a second para, third sentence.

# section 1

here's section 1 para 2 sentence 3.`;

describe('parseDoc and docJson: a document as nested, globally numbered keys', () => {
  it('matches the example, with every numbering global', () => {
    expect(docJson(parseDoc(LAUREN))).toEqual({
      heading_0: {
        paragraph_0: {
          sentence_0: { line_0: 'this is line 0 in implicit header 0,', line_1: 'line 1 in same para, same sentence.' },
          sentence_1: { line_2: 'another line in same para, second sentence.' },
        },
        paragraph_1: { sentence_2: { line_4: "here's a second para, third sentence." } },
      },
      heading_1: {
        heading: 'section 1',
        paragraph_2: { sentence_3: { line_8: "here's section 1 para 2 sentence 3." } },
      },
    });
  });
  it('keeps keys in ascending order (jev reads key order)', () => {
    const j = docJson(parseDoc(LAUREN));
    expect(Object.keys(j)).toEqual(['heading_0', 'heading_1']);
    expect(Object.keys(j.heading_1)).toEqual(['heading', 'paragraph_2']);
  });
  it('collapses the levels left out: the deepest level kept holds the text', () => {
    expect(docJson(parseDoc(LAUREN), ['paragraph'])).toEqual({
      paragraph_0: 'this is line 0 in implicit header 0, line 1 in same para, same sentence. another line in same para, second sentence.',
      paragraph_1: "here's a second para, third sentence.",
      paragraph_2: "here's section 1 para 2 sentence 3.",
    });
    expect(docJson(parseDoc(LAUREN), ['heading', 'sentence']).heading_0).toEqual({
      sentence_0: 'this is line 0 in implicit header 0, line 1 in same para, same sentence.',
      sentence_1: 'another line in same para, second sentence.',
      sentence_2: "here's a second para, third sentence.",
    });
  });
  it('splits two sentences on one line, and gives the line to both', () => {
    const d = parseDoc('One. Two!\n');
    expect(docJson(d)).toEqual({ heading_0: { paragraph_0: { sentence_0: { line_0: 'One.' }, sentence_1: { line_0: 'Two!' } } } });
  });
  it('skips frontmatter but keeps file line numbers', () => {
    const d = parseDoc('---\nid: x\n---\nHello there.\n');
    expect(docJson(d, ['line'])).toEqual({ line_3: 'Hello there.' });
  });
});

describe('units and presentations', () => {
  const d = parseDoc(LAUREN);
  it('finds the paragraph a corpus row starts on (1-based file line)', () => {
    expect(unitOf(d, 'paragraph', 5)).toEqual({ kind: 'paragraph', key: 'paragraph_1', text: "here's a second para, third sentence." });
  });
  it('templates the question onto the unit key', () => {
    expect(templateQuestion('Does `paragraph` use a term?', 'paragraph_1')).toBe('Does `paragraph_1` use a term?');
    expect(templateQuestion('Does `paragraph` use a term?', 'paragraph')).toBe('Does `paragraph` use a term?');
  });
  it('builds each kind of state', () => {
    const u = unitOf(d, 'paragraph', 5)!;
    expect(presentState('isolated', d, LAUREN, u)).toEqual({ paragraph: u.text });
    expect(presentState('raw', d, LAUREN, u)).toEqual({ document: LAUREN, paragraph: u.text });
    const parsed = presentState('parsed', d, LAUREN, u);
    expect(Object.keys(parsed)).toEqual(['__format_description', 'document']);
    expect(parsed.__format_description).toBe(FORMAT_DESCRIPTION);
  });
});

describe('what a learner never sees', () => {
  it('drops %% comments, even across lines, and field names, keeping line numbers', () => {
    const d = parseDoc('content::\n%% note\nstill note %%Seen here.\nalso %%x%% seen.\n');
    expect(docJson(d, ['line'])).toEqual({ line_2: 'Seen here.', line_3: 'also  seen.' });
  });
});
