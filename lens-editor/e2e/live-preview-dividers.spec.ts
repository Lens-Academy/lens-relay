import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// While the cursor is elsewhere, live preview hides the characters of a
// divider (---) and of the ===/--- line under a setext heading. As a hidden
// mark, every one of them had the same x, so a click on the row, or ArrowDown
// onto it, put the cursor between them, and typing or Enter there broke the
// divider or the heading. They are now one widget, which CodeMirror measures as
// a whole (HiddenSyntaxWidget in src/components/Editor/extensions/livePreview.ts).

type FixtureWindow = Window & { view: EditorView };

const LINES = 25; // e2e/fixtures/live-preview-dividers.ts
const everyLine = Array.from({ length: LINES }, (_, i) => i + 1);

// The rows of hidden characters, and the column where the dashes start (after
// indentation or a quote marker)
const ROWS = [
  { line: 3, from: 0 }, // ---
  { line: 5, from: 0 }, // ***
  { line: 7, from: 0 }, // - - -
  { line: 9, from: 0 }, // ----------
  { line: 11, from: 3 }, // indented ---
  { line: 13, from: 2 }, // > ---
  { line: 16, from: 0 }, // ------- under "Updates"
  { line: 20, from: 0 }, // ======= under "Weekly team meeting"
  { line: 23, from: 2 }, // --- under a list item's text
];

let errors: string[] = [];

type Cursor = { line: number; column: number; atLineEnd: boolean };

/** The cursor's line and column */
function cursor(page: Page): Promise<Cursor> {
  return page.evaluate(() => {
    const { view } = window as unknown as FixtureWindow;
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from, atLineEnd: head === line.to };
  });
}

/** Whether the cursor is before or after the hidden characters of its row */
function outsideHidden(at: Cursor): boolean {
  const row = ROWS.find((r) => r.line === at.line);
  return !row || at.column <= row.from || at.atLineEnd;
}

/** The lines that have hidden syntax right now */
function linesWithHiddenSyntax(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const { view } = window as unknown as FixtureWindow;
    return [...view.contentDOM.querySelectorAll(':scope > .cm-line')]
      .filter((el) => el.querySelector('.cm-hidden-syntax'))
      .map((el) => view.state.doc.lineAt(view.posAtDOM(el)).number);
  });
}

/**
 * Press `key` `presses` times. Returns the cursor's line after each press, and
 * where it stopped inside characters that were hidden before the press (a
 * heading may show its ===/--- line while the cursor is on its text).
 */
async function pressAndCheck(page: Page, key: string, presses: number) {
  const lines: number[] = [];
  const inside: Cursor[] = [];
  for (let i = 0; i < presses; i++) {
    const hidden = new Set(await linesWithHiddenSyntax(page));
    await page.keyboard.press(key);
    const at = await cursor(page);
    lines.push(at.line);
    if (hidden.has(at.line) && !outsideHidden(at)) inside.push(at);
  }
  return { lines, inside };
}

/** Put the cursor on line `n`, `column` characters in (at most its end) */
async function placeCursor(page: Page, n: number, column: number): Promise<void> {
  await page.evaluate(({ n, column }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: Math.min(line.from + column, line.to) } });
    view.focus();
  }, { n, column });
}

/** The box of line `n`'s row */
async function rowBox(page: Page, n: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('.cm-content > .cm-line').nth(n - 1).boundingBox())!;
}

function docText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as FixtureWindow).view.state.doc.toString());
}

test.describe('Live preview: the rows of a divider and of a setext heading underline', () => {
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // CodeMirror logs an exception in a key binding instead of throwing it
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/live-preview-dividers.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await expect(page.locator('.cm-hr-line')).toHaveCount(6);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  for (const { line: n, from } of ROWS) {
    test(`a click on row ${n} puts the cursor before or after its hidden characters`, async ({ page }) => {
      // Left of where the text starts: no further in than where they start
      await placeCursor(page, 1, 0);
      let box = await rowBox(page, n);
      await page.mouse.click(box.x + 2, box.y + box.height / 2);
      const left = await cursor(page);
      expect(left.line, 'click at the left edge').toBe(n);
      expect(left.column, 'click at the left edge').toBeLessThanOrEqual(from);

      // Further right: the end of the line
      await placeCursor(page, 1, 0);
      box = await rowBox(page, n);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await cursor(page), 'click in the middle').toMatchObject({ line: n, atLineEnd: true });
    });
  }

  for (const n of [3, 16]) {
    test(`Enter after a click on row ${n} adds a line below it`, async ({ page }) => {
      const before = await docText(page);
      await placeCursor(page, 1, 0);
      const box = await rowBox(page, n);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press('Enter');
      const lines = before.split('\n');
      lines.splice(n, 0, '');
      expect(await docText(page)).toBe(lines.join('\n'));
    });
  }

  test('ArrowDown from the first line visits every line, never stopping inside hidden characters', async ({ page }) => {
    for (const column of [0, 5]) {
      await placeCursor(page, 1, column);
      const { lines, inside } = await pressAndCheck(page, 'ArrowDown', LINES - 1);
      expect(lines).toEqual(everyLine.slice(1));
      expect(inside, `from column ${column}`).toEqual([]);
    }
  });

  test('ArrowUp from the last line never stops inside hidden characters', async ({ page }) => {
    // CodeMirror's own ArrowUp jumps over lines that start with hidden syntax,
    // these rows included. Where it stops on one, it is before or after the
    // hidden characters.
    for (const column of [0, 5]) {
      await placeCursor(page, LINES, column);
      const { inside } = await pressAndCheck(page, 'ArrowUp', LINES - 1);
      expect(inside, `from column ${column}`).toEqual([]);
    }
  });
});
