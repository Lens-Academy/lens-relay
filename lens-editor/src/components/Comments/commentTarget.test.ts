import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { Table } from '@lezer/markdown';
import { WikilinkExtension } from '../Editor/extensions/wikilinkParser';
import { criticMarkupField } from '../Editor/extensions/criticmarkup';
import { frontmatterField } from '../Editor/extensions/frontmatter';
import { commentTarget } from './commentTarget';

/** commentTarget for `doc` with `selected` (its first occurrence) selected */
function target(doc: string, selected: string, from = doc.indexOf(selected)) {
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: from + selected.length },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [WikilinkExtension, Table] }),
      criticMarkupField,
      frontmatterField,
    ],
  });
  ensureSyntaxTree(state, state.doc.length);
  const t = commentTarget(state);
  return t.from === t.to ? `point ${t.to}` : doc.slice(t.from, t.to);
}

describe('commentTarget', () => {
  it('is the cursor when nothing is selected', () => {
    const state = EditorState.create({ doc: 'Hello world', selection: { anchor: 5 } });
    expect(commentTarget(state)).toEqual({ from: 5, to: 5 });
  });

  it('is the selected text, without white space at its ends', () => {
    expect(target('We plan to ship it.', 'plan to ')).toBe('plan to');
    expect(target('We plan to ship it.', ' ship it.')).toBe('ship it.');
  });

  it('leaves out heading, list and quote markers', () => {
    expect(target('# Key results\n', '# Key results')).toBe('Key results');
    expect(target('- [ ] Ship the dashboard\n', '- [ ] Ship the dashboard')).toBe('Ship the dashboard');
    expect(target('> A quote\n', '> A quote')).toBe('A quote');
  });

  it('may cover a whole link or code span, but not cut through one', () => {
    expect(target('Read [the source](https://x.org) now', '[the source](https://x.org)')).toBe('[the source](https://x.org)');
    expect(target('Read [the source](https://x.org) now', 'source](https')).toMatch(/^point/);
    expect(target('Run `npm run dev` to try', '`npm run dev`')).toBe('`npm run dev`');
    expect(target('Run `npm run dev` to try', 'run dev` to')).toMatch(/^point/);
  });

  it('is a point for several lines, code blocks, tables, frontmatter and other markup', () => {
    expect(target('One line\nTwo lines', 'line\nTwo')).toMatch(/^point/);
    expect(target('```\nconst a = 1;\n```', 'const a')).toMatch(/^point/);
    expect(target('| A | B |\n| - | - |\n| one | two |', 'one')).toMatch(/^point/);
    expect(target('---\ntitle: Notes\n---\n\nBody', 'Notes')).toMatch(/^point/);
    expect(target('Keep {++this++} text', 'Keep {++this')).toMatch(/^point/);
  });

  it('is the cursor end of the selection when it falls back to a point', () => {
    // Selected backwards: the head is the start
    const state = EditorState.create({
      doc: 'One line\nTwo lines',
      selection: { anchor: 12, head: 4 },
    });
    expect(commentTarget(state)).toEqual({ from: 4, to: 4 });
  });
});
