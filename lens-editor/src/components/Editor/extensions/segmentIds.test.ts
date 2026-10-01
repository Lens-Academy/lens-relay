import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { segmentIdEnter } from './segmentIds';
import { blockHasId, isSurveyPath, needsSegmentId } from '../../../../shared/segment-ids';

const LENS = '/Lens Edu/Lenses/Some Lens.md';
const UUID = '11111111-2222-4333-8444-555555555555';

let view: EditorView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

/** Press Enter with the cursor at `|` in `doc`; returns [handled, text, cursor]. */
function enter(doc: string, path: string | null = LENS): [boolean, string, number] {
  const pos = doc.indexOf('|');
  const text = doc.replace('|', '');
  view = new EditorView({
    state: EditorState.create({ doc: text, selection: { anchor: pos }, extensions: [markdown()] }),
    parent: document.body,
  });
  ensureSyntaxTree(view.state, view.state.doc.length);
  const handled = segmentIdEnter(() => path, () => UUID)(view);
  return [handled, view.state.doc.toString(), view.state.selection.main.head];
}

describe('segmentIdEnter', () => {
  it.each([
    '#### Question',
    '#### Question: Open',
    '#### question: rating',
    '#### Roleplay',
    '#### Roleplay: Talking to a skeptic',
    '#### Interview: Final check',
    '## Question',
  ])('inserts an id after "%s"', (header) => {
    const [handled, text, cursor] = enter(`# Lens\n${header}|`);
    expect(handled).toBe(true);
    expect(text).toBe(`# Lens\n${header}\nid:: ${UUID}\n`);
    expect(cursor).toBe(text.length);
  });

  it('keeps the following segment below the new lines', () => {
    const [, text] = enter('#### Question|\n#### Text\ncontent:: hi');
    expect(text).toBe(`#### Question\nid:: ${UUID}\n\n#### Text\ncontent:: hi`);
  });

  it('leaves a segment that already has an id', () => {
    expect(enter('#### Question|\ncontent:: Why?\nid:: abc')[0]).toBe(false);
    expect(enter('#### Roleplay|\n  id:: abc')[0]).toBe(false);
  });

  it('adds an id when only a later segment has one', () => {
    expect(enter('#### Question|\ncontent:: Why?\n#### Question\nid:: abc')[0]).toBe(true);
  });

  it.each([
    ['other segment types', '#### Text|', LENS],
    ['a Question heading with other words', '#### Questions for later|', LENS],
    ['a cursor before the end of the header', '#### Ques|tion', LENS],
    ['H1 headers', '# Question|', LENS],
    ['a header inside a code block', '```md\n#### Question|\n```', LENS],
    ['documents outside Lens Edu', '#### Question|', '/Lens/Notes/Q.md'],
    ['an unknown path', '#### Question|', null],
    ['a bare Question in a survey (key:: segment)', '#### Question|', '/Lens Edu/surveys/Intro.md'],
  ])('does nothing for %s', (_, doc, path) => {
    expect(enter(doc, path)[0]).toBe(false);
  });

  it('adds an id to a typed Question in a survey', () => {
    expect(enter('#### Question: Choice|', '/Lens Edu/surveys/Intro.md')[0]).toBe(true);
  });
});

describe('shared segment-id helpers', () => {
  it('needsSegmentId follows the platform header pattern', () => {
    expect(needsSegmentId('#### Question  ', false)).toBe(true);
    expect(needsSegmentId('###### Interview:', false)).toBe(true);
    expect(needsSegmentId('#### Chat', false)).toBe(false);
    expect(needsSegmentId('#### Question', true)).toBe(false);
  });

  it('blockHasId stops at the next heading', () => {
    expect(blockHasId(['content:: x', 'id:: 1'])).toBe(true);
    expect(blockHasId(['content:: x', '#### Text', 'id:: 1'])).toBe(false);
  });

  it('isSurveyPath looks at folders, not the file name', () => {
    expect(isSurveyPath('/Lens Edu/surveys/a.md')).toBe(true);
    expect(isSurveyPath('/Lens Edu/Lenses/surveys.md')).toBe(false);
  });
});
