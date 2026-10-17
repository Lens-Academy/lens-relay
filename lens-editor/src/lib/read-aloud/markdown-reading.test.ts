import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { Autolink, TaskList } from '@lezer/markdown';
import { WikilinkExtension } from '../../components/Editor/extensions/wikilinkParser';
import { buildMarkdownReading, docRangeOf, unitAtPos, unitForLine } from './markdown-reading';

function reading(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [WikilinkExtension, TaskList, Autolink] })],
  });
  return { doc, r: buildMarkdownReading(state) };
}

const texts = (doc: string) => reading(doc).r.units.map(u => u.text);

describe('buildMarkdownReading', () => {
  it('reads headings and paragraphs as shown, sentence by sentence', () => {
    expect(texts('# Why it is hard\n\nModels learn from **data**. They are *hard* to inspect.\n')).toEqual([
      'Why it is hard',
      'Models learn from data.',
      'They are hard to inspect.',
    ]);
  });

  it('skips frontmatter, fields, code blocks, images and URLs', () => {
    const doc = [
      '---', 'title: X', '---',
      'id:: 1234',
      'See [the paper](https://example.com/x "Title") and ![chart](a.png) now.',
      '```python', 'reward = 1', '```',
      'Done.',
    ].join('\n');
    expect(texts(doc)).toEqual(['See the paper and now.', 'Done.']);
  });

  it('reads list items and quotes without their marks, each as its own unit', () => {
    expect(texts('- First item\n- Second item\n\n> A quote that\n> spans lines.\n')).toEqual([
      'First item',
      'Second item',
      'A quote that spans lines.',
    ]);
  });

  it('reads wikilink aliases, or the target without its heading', () => {
    expect(texts('See [[Welcome|the welcome page]] and [[Guide#Setup]].')).toEqual([
      'See the welcome page and Guide.',
    ]);
  });

  it('reads pending additions and the new side of substitutions, not deletions or comments', () => {
    const doc = 'Keep {++{"author":"AI"}@@this ++}{--gone --}text{>>a note<<} {~~old~>new~~} here.';
    expect(texts(doc)).toEqual(['Keep this text new here.']);
  });

  it('keeps abbreviations inside one sentence', () => {
    expect(texts('Dr. Smith said so, e.g. today. Then he left.')).toEqual([
      'Dr. Smith said so, e.g. today.',
      'Then he left.',
    ]);
  });

  it('pauses before the first sentence of each block only', () => {
    const { r } = reading('One. Two.\n\nThree.');
    expect(r.units.map(u => u.pauseBefore)).toEqual([0.3, 0, 0.3]);
  });

  it('maps units and words back to document positions', () => {
    const { doc, r } = reading('# Title\n\nSee [the paper](https://x.org) now.');
    const range = r.docRanges[1];
    expect(doc.slice(range.from, range.to)).toBe('See [the paper](https://x.org) now.');
    const word = docRangeOf(r, 1, { start: 8, end: 13 });
    expect(word && doc.slice(word.from, word.to)).toBe('paper');
    expect(unitAtPos(r, doc.indexOf('paper'))).toBe(1);
    expect(unitAtPos(r, 3)).toBe(0);
    expect(unitAtPos(r, doc.indexOf('\n'))).toBe(null);
    expect(unitForLine(r, 0, 7)).toBe(0);
    expect(unitForLine(r, 8, 8)).toBe(null);
  });
});
