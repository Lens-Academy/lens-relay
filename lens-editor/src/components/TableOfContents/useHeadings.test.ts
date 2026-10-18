import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { forceParsing } from '@codemirror/language';
import { extractHeadings, normalizeHeadingLevels } from './useHeadings';
import type { Heading } from './useHeadings';
import { frontmatterField } from '../Editor/extensions/frontmatter';

/** Helper: build minimal Heading[] from raw levels */
function headingsFromLevels(levels: number[]): Heading[] {
  return levels.map((level, i) => ({
    level,
    text: `Heading ${i}`,
    from: i * 100,
    to: i * 100 + 50,
  }));
}

const fixtures = [
  {
    name: 'already normalized (H1, H2, H3)',
    input: [1, 2, 3, 2, 1],
    expected: [1, 2, 3, 2, 1],
  },
  {
    name: 'starts at H3 — promotes to level 1',
    input: [3, 4, 4, 3, 2, 4, 3, 4],
    expected: [1, 2, 2, 1, 1, 2, 2, 3],
  },
  {
    name: 'single heading',
    input: [4],
    expected: [1],
  },
  {
    name: 'all same level',
    input: [2, 2, 2],
    expected: [1, 1, 1],
  },
  {
    name: 'gap in levels (H2 then H5) — child is still level 2',
    input: [2, 5, 5, 2],
    expected: [1, 2, 2, 1],
  },
  {
    name: 'descending levels (H4, H3, H2, H1)',
    input: [4, 3, 2, 1],
    expected: [1, 1, 1, 1],
  },
  {
    name: 'deep nesting from high start',
    input: [3, 4, 5, 6, 3],
    expected: [1, 2, 3, 4, 1],
  },
  {
    name: 'empty array',
    input: [],
    expected: [],
  },
];

describe('normalizeHeadingLevels', () => {
  for (const { name, input, expected } of fixtures) {
    it(name, () => {
      const headings = headingsFromLevels(input);
      const result = normalizeHeadingLevels(headings);
      expect(result.map((h) => h.displayLevel)).toEqual(expected);
    });
  }
});

/** Helper: the headings extractHeadings finds in `doc`, with their line numbers */
function headingsIn(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown(), frontmatterField] }),
  });
  try {
    // A new state is parsed for at most 20ms; finish it, as the editor does in the background
    forceParsing(view, doc.length, 5000);
    return extractHeadings(view.state).map(({ level, text, from }) => ({
      level,
      text,
      line: view.state.doc.lineAt(from).number,
    }));
  } finally {
    view.destroy();
  }
}

describe('extractHeadings', () => {
  it('lists setext headings (text over === or ---) with # headings, in order', () => {
    const doc = 'Title\n=====\n\n## Agenda\n\nUpdates\n---\n\nWe agreed on the budget\nand the hiring plan\n---\n';
    expect(headingsIn(doc)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Agenda', line: 4 },
      { level: 2, text: 'Updates', line: 6 },
      { level: 2, text: 'We agreed on the budget and the hiring plan', line: 9 },
    ]);
  });

  it('needs at least -- under a line of text for an H2, as the editor does', () => {
    // `- ` is how a list typed under `Attendees:` starts
    expect(headingsIn('Attendees:\n- \n\nTitle\n=\n\nSection\n--\n')).toEqual([
      { level: 1, text: 'Title', line: 4 },
      { level: 2, text: 'Section', line: 7 },
    ]);
  });

  it('skips frontmatter, which Lezer reads as headings', () => {
    // `title: Notes` over the closing --- is a setext heading to Lezer,
    // and the YAML comment a # heading
    const doc = '---\n# a YAML comment\ntitle: Notes\n---\n\nSection\n---\n';
    expect(headingsIn(doc)).toEqual([{ level: 2, text: 'Section', line: 6 }]);
  });
});
