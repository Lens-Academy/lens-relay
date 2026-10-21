import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// Live preview hides a suggestion's delimiters and metadata in font-size: 0
// text, and CodeMirror draws the cursor by the character on the side it is
// associated with. A cursor beside hidden syntax must be drawn by the text on
// its other side, as tall as that text and at its edge, or it can't be seen
// (faceShownSide in src/components/Editor/extensions/criticmarkup-cursor.ts).

type FixtureWindow = Window & {
  view: EditorView;
  setSuggestionMode: (on: boolean) => void;
};

// e2e/fixtures/criticmarkup-cursor.ts
const LAST_LINE = 13;

let pageErrors: string[] = [];

/** Put the cursor at column `col` of line `n` (negative: from its end) */
async function place(page: Page, n: number, col: number): Promise<void> {
  await page.evaluate(({ n, col }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: col < 0 ? line.to + col + 1 : line.from + col } });
    view.focus();
  }, { n, col });
}

type Drawn = {
  line: number;
  col: number;
  /** The drawn cursor */
  cursor: { top: number; height: number; x: number };
  /** The character beside the cursor on `side`: where the cursor should be drawn */
  char: { top: number; height: number; x: number };
};

/** The cursor, and the box of the character on `side` of it (-1 before, 1 after) */
function drawn(page: Page, side: -1 | 1): Promise<Drawn> {
  return page.evaluate(async (side) => {
    const { view } = window as unknown as FixtureWindow;
    // The cursor is drawn when CodeMirror next measures
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    const cursor = document.querySelector('.cm-cursor-primary')!.getBoundingClientRect();
    const char = view.coordsForChar(side < 0 ? head - 1 : head)!;
    return {
      line: line.number,
      col: head - line.from,
      cursor: { top: cursor.top, height: cursor.height, x: (cursor.left + cursor.right) / 2 },
      char: { top: char.top, height: char.bottom - char.top, x: side < 0 ? char.right : char.left },
    };
  }, side);
}

/** The cursor is at `n`:`col`, drawn as tall as the character on `side` of it, at its edge */
async function expectDrawnBy(page: Page, n: number, col: number, side: -1 | 1, label = ''): Promise<void> {
  const at = await drawn(page, side);
  expect({ line: at.line, col: at.col }, `${label} position`).toEqual({ line: n, col });
  expect(at.cursor.height, `${label} cursor height`).toBeCloseTo(at.char.height, 0);
  expect(at.cursor.top, `${label} cursor top`).toBeCloseTo(at.char.top, 0);
  expect(at.cursor.x, `${label} cursor x`).toBeCloseTo(at.char.x, 0);
}

function lineText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).text, n);
}

/** Adds `text` as a line at the end of the document; returns its number */
function addLine(page: Page, text: string): Promise<number> {
  return page.evaluate((text) => {
    const { view } = window as unknown as FixtureWindow;
    view.dispatch({ changes: { from: view.state.doc.length, insert: `\n${text}` } });
    return view.state.doc.lines;
  }, text);
}

test.describe('Live preview: a cursor beside hidden CriticMarkup is drawn by the text', () => {
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // CodeMirror catches what a key binding throws and only logs it
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/criticmarkup-cursor.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LAST_LINE);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('ArrowRight over an opening delimiter, with or without metadata', async ({ page }) => {
    // Line 8: "Plain text {++inserted++} in the middle."
    await place(page, 8, 11);
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 8, 14, 1);
    // Line 3: metadata before "An added line with metadata"
    await place(page, 3, 0);
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 3, (await lineText(page, 3)).indexOf('An added'), 1);
    // Line 9: a deletion+addition pair, from the end of "old words" to "new words"
    const pair = await lineText(page, 9);
    await place(page, 9, pair.indexOf('--}'));
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 9, pair.indexOf('new words'), 1);
  });

  test('ArrowRight over a closing delimiter', async ({ page }) => {
    await place(page, 8, 22);
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 8, 25, 1);
  });

  test('ArrowLeft over a closing delimiter', async ({ page }) => {
    await place(page, 8, 25);
    await page.keyboard.press('ArrowLeft');
    await expectDrawnBy(page, 8, 22, -1);
    const pair = await lineText(page, 9);
    await place(page, 9, pair.indexOf('new words'));
    await page.keyboard.press('ArrowLeft');
    await expectDrawnBy(page, 9, pair.indexOf('--}'), -1);
  });

  test('ArrowLeft over an opening delimiter', async ({ page }) => {
    await place(page, 8, 14);
    await page.keyboard.press('ArrowLeft');
    await expectDrawnBy(page, 8, 11, -1);
  });

  test('a word at a time over delimiters', async ({ page }) => {
    // "text " | {++ | inserted | ++} | " in"
    await place(page, 8, 6);
    await page.keyboard.press('Control+ArrowRight');
    await page.keyboard.press('Control+ArrowRight');
    await expectDrawnBy(page, 8, 14, 1, 'over {++');
    await page.keyboard.press('Control+ArrowRight');
    await page.keyboard.press('Control+ArrowRight');
    await expectDrawnBy(page, 8, 25, 1, 'over ++}');
    await page.keyboard.press('Control+ArrowLeft');
    await expectDrawnBy(page, 8, 22, -1, 'back over ++}');
  });

  test('ArrowRight and ArrowLeft over a comment badge', async ({ page }) => {
    // Line 6: "{==Highlighted text==}{>>…<<} opens this line."
    const text = await lineText(page, 6);
    const highlightEnd = text.indexOf('==}');
    const afterBadge = text.indexOf('<<}') + 3;
    await place(page, 6, highlightEnd);
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 6, afterBadge, 1, 'after the badge');
    await page.keyboard.press('ArrowLeft');
    await expectDrawnBy(page, 6, highlightEnd, -1, 'before it');
  });

  test('ArrowRight past the end of a comment written over two lines', async ({ page }) => {
    // Lines 11-12: "A comment over two lines{>>…its first line" / "and its second<<} then text."
    const first = await lineText(page, 11);
    await place(page, 11, first.indexOf('{>>'));
    await page.keyboard.press('ArrowRight');
    await expectDrawnBy(page, 12, (await lineText(page, 12)).indexOf('<<}') + 3, 1);
  });

  test('Home to the end of the indentation before a suggestion', async ({ page }) => {
    const n = await addLine(page, '  {++Indented++} suggestion');
    await place(page, n, -1);
    await page.keyboard.press('Home');
    await expectDrawnBy(page, n, 2, -1);
  });

  test('typing at the end of a suggestion\'s text, and before a suggestion', async ({ page }) => {
    await place(page, 8, 22);
    await page.keyboard.type('X');
    expect(await lineText(page, 8)).toBe('Plain text {++insertedX++} in the middle.');
    await expectDrawnBy(page, 8, 23, -1, 'end of its text');
    await place(page, 8, 11);
    await page.keyboard.type('Y');
    expect(await lineText(page, 8)).toBe('Plain text Y{++insertedX++} in the middle.');
    await expectDrawnBy(page, 8, 12, -1, 'before it');
  });

  test('Backspace and Delete beside a suggestion', async ({ page }) => {
    // The first character of its text, the last, and the characters around it
    await place(page, 8, 15);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 8)).toBe('Plain text {++nserted++} in the middle.');
    await expectDrawnBy(page, 8, 14, 1, 'Backspace at its start');
    await place(page, 8, 20);
    await page.keyboard.press('Delete');
    expect(await lineText(page, 8)).toBe('Plain text {++nserte++} in the middle.');
    await expectDrawnBy(page, 8, 20, -1, 'Delete at its end');
    await place(page, 8, 24);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 8)).toBe('Plain text {++nserte++}in the middle.');
    await expectDrawnBy(page, 8, 23, 1, 'Backspace after it');
    await place(page, 8, 10);
    await page.keyboard.press('Delete');
    expect(await lineText(page, 8)).toBe('Plain text{++nserte++}in the middle.');
    await expectDrawnBy(page, 8, 10, -1, 'Delete before it');
  });

  test('in suggestion mode, typing at the end of your own addition', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSuggestionMode(true));
    await place(page, LAST_LINE, -1);
    await page.keyboard.type(' More');
    const text = await lineText(page, LAST_LINE);
    expect(text).toMatch(/^Last line\.\{\+\+\{"author":"Mark",.*\}@@ More\+\+\}$/);
    await expectDrawnBy(page, LAST_LINE, text.length - 3, -1);
  });

  test('ArrowUp after stepping into a suggestion goes up a line', async ({ page }) => {
    // Measured from a cursor drawn with no height, it stayed on the line
    await place(page, 8, 11);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    expect((await drawn(page, 1)).line).toBe(7);
  });

  test('a cursor before a suggestion that starts a wrapped row stays on that row', async ({ page }) => {
    // Facing the text before it would draw it at the end of the row above,
    // and Home, End and the arrow keys would go on from there. With no text
    // beside it on its own row to be drawn by, it keeps its side.
    const n = await addLine(page, 'Some words before {++an addition++}');
    await addLine(page, 'The next line.');
    const opening = (await lineText(page, n)).indexOf('{++');
    // Narrow the editor so that the row breaks between "before " and the addition
    await page.evaluate(({ n, opening }) => {
      const { view } = window as unknown as FixtureWindow;
      const line = view.state.doc.line(n);
      const start = view.coordsAtPos(line.from, 1)!.left;
      // The space before the addition, and its first word, "an"
      const space = view.coordsForChar(line.from + opening - 1)!.right;
      const word = view.coordsForChar(line.from + opening + '{++a'.length)!.right;
      const lineDOM = view.contentDOM.querySelectorAll('.cm-line')[n - 1] as HTMLElement;
      const style = getComputedStyle(lineDOM);
      const room = lineDOM.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const width = view.contentDOM.getBoundingClientRect().width;
      view.contentDOM.style.maxWidth = `${width - room + ((space + word) / 2 - start)}px`;
    }, { n, opening });
    /** The row of the line's first character, and the addition's */
    const rows = () => page.evaluate(({ n, opening }) => {
      const { view } = window as unknown as FixtureWindow;
      const line = view.state.doc.line(n);
      const first = view.coordsForChar(line.from)!;
      const addition = view.coordsForChar(line.from + opening + 3)!;
      return { first: { top: first.top, bottom: first.bottom }, addition: { top: addition.top, bottom: addition.bottom } };
    }, { n, opening });
    await expect.poll(async () => {
      const { first, addition } = await rows();
      return addition.top > first.bottom;
    }).toBe(true);

    // ArrowLeft from the start of "an addition" steps over the hidden {++
    await place(page, n, opening + 3);
    await page.keyboard.press('ArrowLeft');
    const at = await drawn(page, 1);
    const { first, addition } = await rows();
    expect(at.col).toBe(opening);
    expect(at.cursor.top, 'drawn on the addition\'s row').toBeGreaterThan(first.bottom);
    expect(at.cursor.top, 'drawn on the addition\'s row').toBeLessThanOrEqual(addition.bottom);
    // The addition's row is the line's last: ArrowDown goes on to the next line
    await page.keyboard.press('ArrowDown');
    expect((await drawn(page, 1)).line).toBe(n + 1);
  });
});
