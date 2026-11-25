import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { remoteReplaceCaret } from './remoteReplaceCaret';

const URL_A = 'https://example.com/a';
const WIKI = '[[articles/a|Title]]';

let views: EditorView[] = [];

afterEach(() => {
  views.forEach((view) => view.destroy());
  views = [];
});

/** The real binding, as the main editor has it, with someone else's Y.Doc beside it. */
function editorOn(text: string) {
  const mine = new Y.Doc();
  const ytext = mine.getText('contents');
  ytext.insert(0, text);
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        yCollab(ytext, null, { undoManager: false }),
        remoteReplaceCaret(ytext),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  /** What the relay does: another client's edit, delete then insert, arriving as one update. */
  const fromElsewhere = (edit: (text: Y.Text) => void) => {
    theirs.transact(() => edit(theirs.getText('contents')));
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs));
  };
  return { view, ytext, fromElsewhere };
}

function swap(contents: Y.Text, from: number, to: number, insert: string) {
  contents.delete(from, to - from);
  contents.insert(from, insert);
}

/** Puts the caret at `offset`, has the edit land, and types there. */
function typedAfter(text: string, offset: number, edit: (contents: Y.Text) => void): string {
  const { view, fromElsewhere } = editorOn(text);
  view.dispatch({ selection: { anchor: offset } });
  fromElsewhere(edit);
  const { head } = view.state.selection.main;
  view.dispatch({ changes: { from: head, insert: 'XX' }, selection: { anchor: head + 2 } });
  return view.state.doc.toString();
}

describe('remoteReplaceCaret: a bare URL replaced by someone else', () => {
  const TEXT = `Read ${URL_A} then more`;
  const from = TEXT.indexOf(URL_A);
  const to = from + URL_A.length;
  const replace = (contents: Y.Text) => swap(contents, from, to, WIKI);

  it('caret at its end stays after it', () => {
    expect(typedAfter(TEXT, to, replace)).toBe(`Read ${WIKI}XX then more`);
  });

  it('caret inside it goes after it', () => {
    expect(typedAfter(TEXT, from + 7, replace)).toBe(`Read ${WIKI}XX then more`);
  });

  it('caret at its start stays before it', () => {
    expect(typedAfter(TEXT, from, replace)).toBe(`Read XX${WIKI} then more`);
  });

  it('caret at the end of the text, right after it', () => {
    const end = `Read ${URL_A}`;
    expect(typedAfter(end, end.length, (c) => swap(c, 5, end.length, WIKI))).toBe(`Read ${WIKI}XX`);
  });

  it('caret well away is unaffected', () => {
    expect(typedAfter(TEXT, 2, replace)).toBe(`ReXXad ${WIKI} then more`);
    expect(typedAfter(TEXT, TEXT.length, replace)).toBe(`Read ${WIKI} then moreXX`);
  });
});

describe('remoteReplaceCaret: an inline link swapped around its label', () => {
  const TEXT = `Read [lbl](${URL_A}) then more`;
  const open = TEXT.indexOf('[');
  const labelEnd = TEXT.indexOf(']');
  const close = TEXT.indexOf(')') + 1;
  /** As the relay does it: only the markup, so the label keeps its author. */
  const swapAround = (contents: Y.Text) => {
    swap(contents, labelEnd, close, ']]');
    swap(contents, open, open + 1, '[[articles/a|');
  };

  it('caret after the ) stays after the link', () => {
    expect(typedAfter(TEXT, close, swapAround)).toBe('Read [[articles/a|lbl]]XX then more');
  });

  it('caret in its URL goes after the link', () => {
    expect(typedAfter(TEXT, TEXT.indexOf('https') + 5, swapAround)).toBe('Read [[articles/a|lbl]]XX then more');
  });

  it('caret in the label stays in the label', () => {
    expect(typedAfter(TEXT, TEXT.indexOf('lbl') + 1, swapAround)).toBe('Read [[articles/a|lXXbl]] then more');
  });

  it('caret at the end of the label stays in the label', () => {
    expect(typedAfter(TEXT, labelEnd, swapAround)).toBe('Read [[articles/a|lblXX]] then more');
  });

  it('caret before the [ stays before the link', () => {
    expect(typedAfter(TEXT, open, swapAround)).toBe('Read XX[[articles/a|lbl]] then more');
  });
});

describe('remoteReplaceCaret leaves alone', () => {
  const TEXT = `Read ${URL_A} then more`;
  const to = TEXT.indexOf(URL_A) + URL_A.length;

  it('a local change with no user event', () => {
    const { view } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: 9 } });
    view.dispatch({ changes: { from: 5, to, insert: WIKI } });
    expect(view.state.selection.main.head).toBe(5); // where mapping leaves it
  });

  it('a local change that keeps the length', () => {
    const { view } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: 9 } });
    view.dispatch({ changes: { from: 5, to, insert: 'x'.repeat(URL_A.length) } });
    expect(view.state.selection.main.head).toBe(5);
  });

  it('a local change that says where the selection goes', () => {
    const { view } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: to } });
    view.dispatch({ changes: { from: 5, to, insert: WIKI }, selection: { anchor: 2 } });
    expect(view.state.selection.main.head).toBe(2);
  });

  it('typing over a selection', () => {
    const { view } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: 5, head: to } });
    view.dispatch(view.state.replaceSelection('word'));
    expect(view.state.selection.main.head).toBe(9);
  });

  it('a selection, which isn\'t a caret', () => {
    const { view, fromElsewhere } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: 0, head: to } });
    fromElsewhere((contents) => swap(contents, 5, to, WIKI));
    expect(view.state.selection.main.empty).toBe(false);
  });

  it('someone else\'s insertion, which replaces nothing', () => {
    const { view, fromElsewhere } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: 2 } });
    fromElsewhere((contents) => contents.insert(2, 'more'));
    expect(view.state.selection.main.head).toBe(2);
  });

  it('someone else\'s deletion, which leaves nothing to be after', () => {
    const { view, fromElsewhere } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: to } });
    fromElsewhere((contents) => contents.delete(5, to - 5));
    expect(view.state.selection.main.head).toBe(5);
  });
});

describe('remoteReplaceCaret and y-sync', () => {
  const TEXT = `Read ${URL_A} then more`;
  const to = TEXT.indexOf(URL_A) + URL_A.length;

  it('does not echo the change back into the Y.Text', () => {
    const { view, ytext, fromElsewhere } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: to } });
    fromElsewhere((contents) => swap(contents, 5, to, WIKI));
    expect(ytext.toString()).toBe(`Read ${WIKI} then more`);
    expect(view.state.doc.toString()).toBe(`Read ${WIKI} then more`);
  });

  it('moves each caret of several', () => {
    const { view, fromElsewhere } = editorOn(TEXT);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(to)], 1),
    });
    fromElsewhere((contents) => swap(contents, 5, to, WIKI));
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([0, 5 + WIKI.length]);
    expect(view.state.selection.mainIndex).toBe(1);
  });

  it('handles a swap of the same length, which only the text can tell apart', () => {
    const same = `[[${'x'.repeat(URL_A.length - 4)}]]`;
    const { view, fromElsewhere } = editorOn(TEXT);
    view.dispatch({ selection: { anchor: to } });
    fromElsewhere((contents) => swap(contents, 5, to, same));
    expect(view.state.selection.main.head).toBe(to);
  });
});

describe('remoteReplaceCaret leaves ordinary co-editing to CodeMirror', () => {
  const TEXT = 'Ana is writing here.\n\nBen rewrites this whole sentence.\n';
  const from = TEXT.indexOf('Ben rewrites');
  const to = TEXT.indexOf('sentence.') + 'sentence.'.length;

  it('someone retyping a sentence the caret is in', () => {
    // Before the fix: "T<ANA>otally new words."
    const typed = typedAfter(TEXT, TEXT.indexOf('whole'), (c) => swap(c, from, to, 'Totally new words.'));
    expect(typed).toContain('XXTotally new words.');
  });

  it('someone replacing the word the caret is at the end of', () => {
    const end = TEXT.indexOf('rewrites') + 'rewrites'.length;
    const typed = typedAfter(TEXT, end, (c) => swap(c, end - 'rewrites'.length, end, 'redoes'));
    expect(typed).toContain('Ben XXredoes this');
  });

  it('a replacement that removes a URL but puts no wikilink in', () => {
    const LINE = `Read ${URL_A} then`;
    const end = 5 + URL_A.length;
    expect(typedAfter(LINE, end, (c) => swap(c, 5, end, 'plain words'))).toBe('Read XXplain words then');
  });

  it('a wikilink typed over text that was no link', () => {
    const LINE = 'Read the paper then';
    const end = LINE.indexOf(' then');
    expect(typedAfter(LINE, end, (c) => swap(c, 5, end, '[[paper]]'))).toBe('Read XX[[paper]] then');
  });
});

describe('remoteReplaceCaret and a link swapped as a suggestion', () => {
  const META = '{"author":"Ben","timestamp":1}@@';
  const TEXT = `Read [lbl](${URL_A}) today.`;
  const start = TEXT.indexOf('[');
  const end = TEXT.indexOf(')') + 1;
  const AFTER = `--}{++${META}[[articles/a|lbl]]++}`;
  /** As the relay writes it: one transaction, the closer at the end, the opener at the start. */
  const suggest = (contents: Y.Text) => {
    contents.insert(end, AFTER);
    contents.insert(start, `{--${META}`);
  };
  const wrapped = `Read {--${META}[lbl](${URL_A})${AFTER}`;

  it.each([
    ['right after the )', end],
    ['in the URL', TEXT.indexOf('example')],
    ['in the label', TEXT.indexOf('lbl') + 1],
    ['right after the [', start + 1],
  ])('moves a caret %s past the whole suggestion', (_where, at) => {
    expect(typedAfter(TEXT, at, suggest)).toBe(`${wrapped}XX today.`);
  });

  it('leaves a caret in front of the link in front of it', () => {
    expect(typedAfter(TEXT, start, suggest)).toBe(`Read XX{--${META}[lbl](${URL_A})${AFTER} today.`);
  });

  it('leaves a caret elsewhere where it was', () => {
    expect(typedAfter(TEXT, TEXT.indexOf('today') + 2, suggest)).toBe(`${wrapped} toXXday.`);
  });

  it('does not take any insertion of markup for one', () => {
    const plain = (contents: Y.Text) => contents.insert(end, '{++an aside++}');
    expect(typedAfter(TEXT, end, plain)).toBe(`Read [lbl](${URL_A})XX{++an aside++} today.`);
  });
});
